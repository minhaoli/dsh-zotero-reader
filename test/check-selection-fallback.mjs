#!/usr/bin/env node
/**
 * 划词翻译的降级与超时。
 *
 * 锁的是「浮窗打开了但里面什么都没有」这个症状。它的成因不止一种，
 * 但这几种都不该让用户看到空白：
 *
 *   1. 推理档位（现为 low）是硬编码的优化。若当前模型没公布这个取值，
 *      请求可能被拒，也可能静默回空串 —— 后者在界面上就是一片空白。
 *   2. 上游不回包时，`for await` 会一直挂着，浮窗无限转圈。
 *
 * 所以：档位失败或空结果都要退回模型默认档重来一次；并且必须有总时长上限。
 * 这里用假 ctx 直接跑 translateSelection，断言的是行为，不是源码长相。
 *
 * 跑法：node test/check-selection-fallback.mjs
 */
import { translateSelection } from '../host/translate.js'

let failed = 0
function check(label, ok, detail) {
  if (ok) console.log(`OK   ${label}`)
  else { console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ''}`); failed += 1 }
}

const selection = { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }

/** 记录每次调用的参数，按次数决定返回什么。 */
function makeCtx(behave) {
  const calls = []
  return {
    calls,
    ctx: {
      agentDefaultModel: selection,
      llm: {
        stream(params) {
          calls.push(params)
          return (async function* () {
            const plan = behave(calls.length, params)
            if (plan === 'throw') throw new Error('unsupported reasoning effort')
            if (plan === 'empty') return
            yield { type: 'reasoning-delta', text: '思考内容不应计入译文' }
            yield { type: 'text-delta', text: '这是' }
            yield { type: 'text-delta', text: '译文。' }
          })()
        },
      },
    },
  }
}

/* ---------- 1. 第一次空结果 → 退回默认档重试 ---------- */
{
  const { ctx, calls } = makeCtx((n) => (n === 1 ? 'empty' : 'ok'))
  const diag = []
  const out = await translateSelection(ctx, 'Some English text.', { onDiag: (e) => diag.push(e) })

  check('空结果后会重试', calls.length === 2, `实际调用 ${calls.length} 次`)
  check('首次尝试带 reasoningEffort=low', calls[0]?.reasoningEffort === 'low',
    `实际 ${JSON.stringify(calls[0]?.reasoningEffort)}`)
  check('重试不再指定档位（交给模型默认）', calls[1] && !('reasoningEffort' in calls[1]))
  check('返回的是重试的文本', out === '这是译文。', `实际拿到 ${JSON.stringify(out)}`)
  check('只取 text-delta，不混入 reasoning',
    !out.includes('思考内容'), '推理增量不能当译文')
  check('诊断里能读出「第一次是空」', diag.some((d) => d.event === 'selection:empty'))
  check('诊断里能读出「哪一档成功」', diag.some((d) => d.event === 'selection:ok' && d.effort === 'default'))
}

/* ---------- 2. 第一次抛错 → 同样退回默认档 ---------- */
{
  const { ctx, calls } = makeCtx((n) => (n === 1 ? 'throw' : 'ok'))
  const diag = []
  const out = await translateSelection(ctx, 'Some English text.', { onDiag: (e) => diag.push(e) })

  check('档位被拒后也会重试', calls.length === 2)
  check('被拒后仍能拿到译文', out === '这是译文。')
  check('诊断里记下了拒绝原因', diag.some((d) => d.event === 'selection:attempt-error'))
}

/* ---------- 3. 两次都空 → 不抛错，返回空串（前端据此提示） ---------- */
{
  const { ctx, calls } = makeCtx(() => 'empty')
  const diag = []
  const out = await translateSelection(ctx, 'text', { onDiag: (e) => diag.push(e) })

  check('两次都空时返回空串而不是抛错', out === '')
  check('两次都空时确实试了两档', calls.length === 2)
  check('两条空结果都有诊断', diag.filter((d) => d.event === 'selection:empty').length === 2)
}

/* ---------- 4. 两次都失败 → 抛出最后一次错误 ---------- */
{
  const { ctx } = makeCtx(() => 'throw')
  let message = ''
  try { await translateSelection(ctx, 'text', {}) } catch (e) { message = String(e?.message ?? e) }
  check('两次都失败时抛出错误（前端会显示原因）', message.includes('unsupported reasoning effort'))
}

/* ---------- 5. 没有可用模型时给出可操作的话 ---------- */
{
  const ctx = { agentDefaultModel: { currentSelection: () => null }, llm: { stream() {} } }
  let message = ''
  try { await translateSelection(ctx, 'text', {}) } catch (e) { message = String(e?.message ?? e) }
  check('缺模型时报「没有可用的模型」', /没有可用的模型/.test(message), `实际：${message}`)
}

/* ---------- 6. 超时上限存在（源码断言，行为测试要等 60 秒不划算） ---------- */
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../host/translate.js', import.meta.url), 'utf8')
  check('划词请求有总时长上限', /SELECTION_TIMEOUT_MS\s*=\s*60_000/.test(src))
  check('超时通过 AbortController 生效', /ctrl\.abort\(\)/.test(src) && /signal: ctrl\.signal/.test(src))
}

console.log(failed === 0 ? '\n===== 全部通过 =====' : `\n===== ${failed} 项失败 =====`)
process.exit(failed === 0 ? 0 : 1)
