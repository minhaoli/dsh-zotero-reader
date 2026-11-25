/**
 * 翻译引擎：走宿主已配置模型，零配置。
 *
 * 现在只服务划词翻译 / 解释（`translateSelection`）：推理档位按
 * off → low → 模型默认 逐级回退，单次请求有总时长上限。
 *
 * 整篇文档翻译（`translateDocument`）及它的按页切分、公式占位符、并发工作池
 * 已随前端入口一并删除；磁盘上已有的 `dataDir/translate/` 缓存不再读写。
 */

const SYSTEM_PROMPT = [
  '你是学术论文翻译引擎。把用户给出的英文（或其它语言）论文原文翻译成流畅、准确的简体中文。',
  '规则：',
  '1. 只输出译文，不要任何前言、解释、标题或 Markdown 代码块包裹。',
  '2. 保留原文的段落与换行结构。',
  '3. 形如 ⟦M0⟧ ⟦M12⟧ 的占位符代表公式或数学符号，必须原样保留在原位置，不要翻译、不要展开、不要改动括号里的编号。',
  '4. 专业术语优先使用学界通用译法；首次出现可在括号内保留英文原词。',
  '5. 参考文献条目、作者名、期刊名、DOI、URL 保持原文不译。',
  '6. 原文若是图表标题、脚注，同样翻译。',
].join('\n')

/**
 * 翻译/解读的推理档位尝试序列，按「最省时 → 最宽容」排列。
 *
 *   off  —— 翻译是转写任务，不思考最省时间，首选
 *   low  —— off 并非所有模型都公布（不认时可能被拒，也可能静默回空串），退一档
 *   null —— 两档都不认，就不传这个参数，交给模型默认
 *
 * 为什么是序列而不是单个值：档位只是省时间的优化，不该成为整条链路的前提。
 * 模型/provider 仍跟随当前会话的默认选择（用户要求「其他的和当前模型一致」）。
 *
 * 现在这只是一个**默认值**：用户可以在插件设置里用 `translateEfforts` 覆盖它
 * （某些 provider 只认 high/medium，硬编码的序列会在前两档白跑两次超时）。
 */
export const DEFAULT_TRANSLATE_EFFORTS = ['off', 'low', null]

/**
 * 归一化调用方传进来的档位序列。
 *
 * `null` 是合法档位（= 不传该参数，用模型默认），所以不能用 truthy 过滤。
 * 传了空/非法就退回默认序列 —— 空序列会让回退链一次都不跑，直接报「失败」。
 */
export function normalizeEfforts(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_TRANSLATE_EFFORTS]
  const out = []
  for (const item of value) {
    if (item === null) { if (!out.includes(null)) out.push(null); continue }
    if (typeof item !== 'string') continue
    const effort = item.trim()
    if (!effort) continue
    if (!out.includes(effort)) out.push(effort)
  }
  return out.length > 0 ? out : [...DEFAULT_TRANSLATE_EFFORTS]
}

export function pickSelection(ctx, override) {
  const fallback = () => {
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      /**
       * 连 reasoningEffort 一起带出来。
       *
       * `currentSelection()` 返回的是完整的 ModelSelection（provider/model +
       * optional reasoning），这里原来只取 provider/model 就把推理等级丢了 ——
       * 表现为「插件里的翻译/解读跑的是模型默认档（high），而不是用户当前选的档」。
       * 用户明确要求「其他设置和当前模型一致」，所以必须透传。
       */
      if (sel && sel.provider && sel.model) {
        return {
          provider: sel.provider,
          model: sel.model,
          reasoningEffort: sel.reasoningEffort,
        }
      }
    } catch { /* 服务不在，交给下面报错 */ }
    return {}
  }
  if (override && override.provider && override.model) {
    return { provider: override.provider, model: override.model, reasoningEffort: override.reasoningEffort }
  }
  return fallback()
}

/**
 * 流式取文本，带总时长上限。
 *
 * 为什么不靠调用方传 signal：划词翻译没有取消入口，一旦上游不回，
 * `for await` 会一直挂着 —— 前端浮窗就是无限转圈。用户报「没有返回任何内容」
 * 时，转圈和空白在界面上几乎分不出来，所以宿主先给一个明确错误。
 * 60 秒比前端的 90 秒早，保证先由这里失败并带上原因。
 */
const SELECTION_TIMEOUT_MS = 60_000

async function streamText(ctx, params, timeoutMs = SELECTION_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, timeoutMs)
  let out = ''
  try {
    const stream = ctx.llm.stream({ ...params, signal: ctrl.signal })
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
  } finally {
    clearTimeout(timer)
  }
  return out.trim()
}

/** 划词翻译 / 解释。返回纯文本。 */
export async function translateSelection(ctx, text, options = {}) {
  const selection = pickSelection(ctx, options.override)
  if (!selection.provider || !selection.model) {
    throw new Error('没有可用的模型：宿主未配置默认模型，且插件设置里未指定划词模型。')
  }
  const mode = options.mode ?? 'translate'
  const system = mode === 'explain'
    ? [
      '你是学术论文阅读助手。用户选中了论文里的一段文字，请用简体中文解释它：这段话在说什么、其中关键概念和符号是什么含义、它在论文论证里起什么作用。',
      '规则：只说必要的话，200 字以内；数学符号原样保留，不要臆造原文没有的内容；不要复述整个段落再解释。',
    ].join('\n')
    : SYSTEM_PROMPT
  const prompt = mode === 'explain' ? text : text

  /**
   * 逐级回退：off → low → 模型默认档。
   *
   * 推理档位只是省时间的优化，但它依赖该模型公布过这个取值。不公布时请求
   * 可能被上层拒绝，也可能回一个空串 —— 后者在界面上就是「浮窗里什么都没有」。
   * 所以从最省时的一档开始试，抛错或返回空都退一档，最后一档不传参数。
   */
  const base = {
    provider: selection.provider,
    model: selection.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }
  const diag = options.onDiag
  /**
   * 档位序列可由调用方覆盖（设置里的 `translateEfforts`），不传就用默认。
   * 这样用户遇到「这个 provider 不认 off」时能自己改，而不用改代码。
   */
  const efforts = normalizeEfforts(options.efforts)
  let lastError = null
  for (const effort of efforts) {
    const label = effort ?? 'default'
    try {
      diag?.({ event: 'selection:attempt', effort: label, model: selection.model })
      const out = await streamText(ctx, effort ? { ...base, reasoningEffort: effort } : base)
      if (out) {
        diag?.({ event: 'selection:ok', effort: label, chars: out.length })
        return out
      }
      diag?.({ event: 'selection:empty', effort: label })
    } catch (error) {
      lastError = error
      diag?.({
        event: 'selection:attempt-error',
        effort: label,
        message: String(error?.message ?? error).slice(0, 200),
      })
    }
  }
  if (lastError) throw lastError
  return ''
}
