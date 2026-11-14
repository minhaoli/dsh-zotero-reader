/**
 * 翻译引擎：走宿主已配置模型，零配置。
 *
 * 三个设计决定：
 *
 * 1. **按页翻译，不按块**。页是用户能看见的单位，也是页码跳转的单位。页内再按
 *    段落序切分成若干不超过 chunkChars 的请求单元，但结果按页拼回去 —— 于是
 *    「第 12 页的中文」永远对应「原文第 12 页」，不会跨页漂移。
 *
 * 2. **翻译保留公式占位符**。PDF 文本层里的公式常常已经碎成 `α = 1 2 m v 2` 这种
 *    样子，模型会在翻译时顺手「修」成别的公式，比不修更坏。所以这里不猜公式，
 *    而是把数学符号密集的片段换成不可翻译的占位符 `⟦M7⟧`，翻完再换回原文。
 *    这样中文版里公式是原文的样子，读者能对照原文核对。
 *
 * 3. **并发受控**。一次翻一整篇论文是几十个请求，串行太慢、全并发会打爆上游限流。
 *    用固定大小的工作池，并把「已完成的页码」按顺序交回去，方便前端边翻边显示。
 */
import { EventEmitter } from 'node:events'

/**
 * 数学符号强度分级。
 *
 * 为什么要分级：PDF 文本层里的正文经常出现孤立的 `c`、`a`（英文冠词、变量引用），
 * 一律当公式遮起来会把中文版正文拆成 `⟦M3⟧` 一堆占位符，比不遮更坏。
 * 只遮「有真符号」或「成串的符号数字」的片段，误遮的代价远高于漏遮。
 */
const STRONG_MATH_RE = /[=≈≠≤≥<>∑∏∫∮√∞∂∇±×÷·⋅−⁄⁄⁄→←↔⇒⇔∈∉⊂⊃∪∩∀∃αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/

function mathStrength(token) {
  if (STRONG_MATH_RE.test(token)) return 3
  if (/^[A-Za-z]\d+$/.test(token)) return 2          // x2 / m2 —— 丢了上标的产物
  if (/^[\d.,()+\-*/^_]+$/.test(token) && /\d/.test(token)) return 2 // 1.5 / (2) / 1,024
  if (/^\d+$/.test(token)) return 1                   // 裸数字
  if (/^[A-Za-z]$/.test(token)) return 1               // 单字母
  return 0
}

/**
 * 从一段文本里找出「值得原样保留」的公式片段，替换成占位符。
 * 占位符两侧的空格留在占位符外面，避免译文把空格粘没。
 * @returns {{ masked: string, slots: string[] }}
 */
export function maskMath(text) {
  const slots = []
  const tokens = text.split(/(\s+)/)

  let buf = ''        // 当前候选片段（含内部空格）
  let bufStart = ''   // 片段前导空白
  let count = 0
  let best = 0

  const flush = () => {
    if (buf && (best >= 3 || (count >= 2 && best >= 2))) {
      // 结尾空白留在占位符外面，否则 `⟦M0⟧where` 这种粘连会诱导模型改标点
      const trimmed = buf.replace(/\s+$/, '')
      const tail = buf.slice(trimmed.length)
      const id = slots.length
      slots.push(trimmed)
      return `${bufStart}⟦M${id}⟧${tail}`
    }
    return bufStart + buf
  }

  let out = ''
  for (const token of tokens) {
    if (/^\s+$/.test(token) || token === '') {
      if (buf) buf += token
      else bufStart += token
      continue
    }
    const strength = mathStrength(token)
    if (strength > 0) {
      buf += token
      count += 1
      best = Math.max(best, strength)
      continue
    }
    out += flush()
    buf = ''
    bufStart = ''
    count = 0
    best = 0
    out += token
  }
  out += flush()
  return { masked: out, slots }
}

/** 把占位符换回原文。模型偶尔会改动 ⟦M7⟧ 的内部（空格、全角括号），所以放宽匹配。 */
export function unmaskMath(text, slots) {
  if (slots.length === 0) return text
  return text.replace(/[⟦\[［]\s*M\s*(\d+)\s*[⟧\]］]/gi, (whole, num) => {
    const slot = slots[Number(num)]
    return slot === undefined ? whole : slot
  })
}

/** 把一页文本切成不超过 limit 字符的请求单元，尽量在段落边界断开。 */
function splitForRequest(text, limit) {
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = -1
    for (const re of [/\n\s*\n/g, /[.。!?！？]\s/g, /\n/g]) {
      let m
      let last = -1
      while ((m = re.exec(window)) !== null) last = m.index + m[0].length
      if (last > limit * 0.5) { cut = last; break }
    }
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) parts.push(rest)
  return parts
}

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

/** 单次 LLM 调用，返回纯文本。 */
async function translateOnce(ctx, text, target, signal) {
  const selection = pickSelection(ctx, target)
  if (!selection.provider || !selection.model) {
    throw new Error('没有可用的模型：宿主未配置默认模型，且插件设置里未指定翻译模型。')
  }
  // 翻译的思考档位固定为 TRANSLATE_EFFORT（模型/provider 跟随当前会话默认）
  let out = ''
  const stream = ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: TRANSLATE_EFFORT,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    signal,
  })
  for await (const chunk of stream) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  return out.trim()
}

/**
 * 翻译/解读的思考程度：固定 low。
 *
 * 原来是 off —— 翻译是转写任务，思考只增加等待时间。但 off 并不是所有模型
 * 都公布的档位，不认时可能被拒、也可能静默回空串（界面上就是一片空白）。
 * 用户明确要求改成 low：仍是最轻的一档，又落在绝大多数模型公布的取值里。
 * 模型/provider 仍然跟随当前会话的默认选择（用户要求「其他的和当前模型一致」）。
 */
const TRANSLATE_EFFORT = 'low'

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
 * 固定并发的工作池：逐项执行，最多 concurrency 个在跑。
 * 任一失败不打断其它项，错误随该项结果一起返回。
 */
async function pool(items, concurrency, worker, onDone) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(concurrency, items.length))
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { error: error instanceof Error ? error.message : String(error) }
      }
      onDone?.(index, results[index])
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 翻译一份文档。
 *
 * @param {object} ctx    宿主上下文
 * @param {object} doc    { pages: string[] }
 * @param {object} options { target, chunkChars, concurrency, signal, onPage, override }
 * @returns {Promise<{ pages: string[], failed: {page:number,error:string}[] }>}
 */
export async function translateDocument(ctx, doc, options = {}) {
  const chunkChars = options.chunkChars ?? 2400
  const concurrency = options.concurrency ?? 4
  const pages = doc.pages ?? []

  // 每一页切成若干请求单元；页码 → 单元列表，保证结果能拼回原页
  const jobs = pages.map((text, index) => ({
    page: index + 1,
    parts: text && text.trim() ? splitForRequest(text, chunkChars) : [],
  }))

  const flat = []
  jobs.forEach((job, jobIndex) => {
    job.parts.forEach((part, partIndex) => {
      flat.push({ jobIndex, partIndex, page: job.page, text: part })
    })
  })

  const collected = jobs.map(() => [])
  const failed = []

  await pool(flat, concurrency, async (item) => {
    const { masked, slots } = maskMath(item.text)
    const translated = await translateOnce(ctx, masked, options.target ?? 'zh-CN', options.signal)
    const restored = unmaskMath(translated, slots)
    collected[item.jobIndex][item.partIndex] = restored
    return restored
  }, (index, result) => {
    const item = flat[index]
    if (result && result.error) failed.push({ page: item.page, error: result.error })
    // 一页的所有单元都齐了才回报，前端拿到的永远是完整的页
    const bucket = collected[item.jobIndex]
    const done = jobs[item.jobIndex].parts.every((_, i) => typeof bucket[i] === 'string' || bucket[i] === null)
    if (done && jobs[item.jobIndex].parts.length > 0) {
      const text = bucket.filter((x) => typeof x === 'string').join('\n')
      options.onPage?.(item.jobIndex, text)
    }
  })

  const outPages = collected.map((bucket, index) => {
    const parts = bucket.filter((x) => typeof x === 'string')
    if (parts.length === 0) return ''
    const expected = jobs[index].parts.length
    if (parts.length < expected) {
      // 有单元失败：标记出来，不要让前端以为这页翻完了
      failed.push({ page: index + 1, error: '部分段落翻译失败' })
    }
    return parts.join('\n')
  })

  return { pages: outPages, failed }
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
   * 两次尝试：先按设定档位，不行再退回模型默认档。
   *
   * 推理档位只是省时间的优化，但它依赖该模型公布过这个取值。不公布时请求
   * 可能被上层拒绝，也可能回一个空串 —— 后者在界面上就是「浮窗里什么都没有」。
   * 档位不该成为整条链路的前提，所以失败或空结果都退回默认档重来一次。
   */
  const base = {
    provider: selection.provider,
    model: selection.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }
  const diag = options.onDiag
  let lastError = null
  for (const attempt of [
    { label: TRANSLATE_EFFORT, params: { ...base, reasoningEffort: TRANSLATE_EFFORT } },
    { label: 'default', params: base },
  ]) {
    try {
      diag?.({ event: 'selection:attempt', effort: attempt.label, model: selection.model })
      const out = await streamText(ctx, attempt.params)
      if (out) {
        diag?.({ event: 'selection:ok', effort: attempt.label, chars: out.length })
        return out
      }
      diag?.({ event: 'selection:empty', effort: attempt.label })
    } catch (error) {
      lastError = error
      diag?.({
        event: 'selection:attempt-error',
        effort: attempt.label,
        message: String(error?.message ?? error).slice(0, 200),
      })
    }
  }
  if (lastError) throw lastError
  return ''
}

export class TranslateJob extends EventEmitter {}

export { splitForRequest }
