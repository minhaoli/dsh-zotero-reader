#!/usr/bin/env node
/**
 * pdf.js worker 选择的防回归。
 *
 * 背景：这个插件一直跑「主线程模式」（假 worker），因为当年实测真 worker
 * 「能创建但不回执」，getDocument 永久挂起、30 秒后超时、连错误都没有。
 * 现在改成带握手探测的自动选择：能跑真 worker 就用，不能就跑回主线程。
 *
 * 这一步风险最高的是**把「打不开 PDF」重新引回来**，所以断言的重点不是
 * 「真 worker 一定成功」，而是：
 *   ① 探测失败时必须真的回退（globalThis.pdfjsWorker 在回退分支里设置）
 *   ② 探测本身绝不抛错（否则整条 pdf.js 初始化会挂掉）
 *   ③ 有超时上限（否则探测自己就会变成「永久挂起」）
 *   ④ 设置 pdfjsWorker 的时机不能早于探测（早设就永远走不到真 worker）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

/**
 * 区块起点要放在 `wrapperCode` 之前 —— 它定义在 canWorkerReply 之上，
 * 从 canWorkerReply 起切会把 wrapper 那段排除在外，造成假失败（踩过一次）。
 */
const start = src.indexOf('const wrapperCode')
const end = src.indexOf("reportDiag({ event: 'pdfjs:worker-mode', mode: 'main-thread' })", start)
const block = start >= 0 && end > start ? src.slice(start, end + 120) : ''

check('找得到 worker 探测逻辑', src.indexOf('const canWorkerReply') > 0)
check('探测与回退区块已定位（负向断言的前提）', block.length > 800)

/* ---- 1. 探测本身必须安全 ---- */

check('探测有超时上限', /setTimeout\(\(\) => finish\(false,\s*'no-reply-\d+s'\)/.test(block),
  '没有超时，探测自己就会变成「永久挂起」——正是当年那个 bug 的形态')
check('构造 Worker 的异常被捕获', /construct:\$\{e\?\.message \?\? e\}/.test(block))
check('onerror 与 onmessageerror 都处理', /onmessageerror/.test(block) && /onerror/.test(block))
check('探测函数返回 {ok, reason} 且不抛错',
  /finish\(true, 'module-loaded'\)/.test(block) && /resolve\(\{ ok, reason \}\)/.test(block))

/**
 * 探针不能往 pdf.worker.mjs 里乱发消息等回音 —— 那个模块只认自己的协议，
 * 收到陌生消息不会回话，会把「可用」误判成「不可用」。必须用 wrapper
 * 让 worker 自己报告「模块 import 成功」。
 */
check('探针用 wrapper 让 worker 自报，而不是盲发消息',
  /wrapperCode/.test(block) && /zr: 'ok'/.test(block))

/* ---- 2. pdfjsWorker 的设置时机 ---- */

/**
 * 判据按「第一次给 globalThis.pdfjsWorker 赋值」的相对位置算，
 * 而不是匹配完整字面量。
 *
 * 原来断言的是 `globalThis.pdfjsWorker = { WorkerMessageHandler: Handler }`
 * 这个精确字符串，负向验证时插入 `{ WorkerMessageHandler: () => {} }`
 * 就绕过了它 —— 测试形同虚设（实测复现过）。
 */
const probeIdx = src.indexOf('await canWorkerReply()')
const fakeAssignIdx = src.indexOf('globalThis.pdfjsWorker =')

check('globalThis.pdfjsWorker 只在探测之后设置', probeIdx > 0 && fakeAssignIdx > probeIdx,
  '一旦提前设置，pdf.js 的 #initialize() 会直接走 #setupFakeWorker，真 worker 永远没机会')
check('设置 pdfjsWorker 的位置在回退分支内',
  fakeAssignIdx > probeIdx && src.slice(probeIdx, fakeAssignIdx).includes('} else {'),
  '它必须在 else 分支里，否则探测成功时也会被设上')

/* ---- 3. 成功分支用 workerSrc 而不是 workerPort ---- */

check('真 worker 分支用 workerSrc', /GlobalWorkerOptions\.workerSrc = absWorker/.test(block))
check('真 worker 分支把 workerPort 置空', /GlobalWorkerOptions\.workerPort = null/.test(block),
  'workerPort 要求传一个活着的 Worker 实例，而探测用的那个已经 terminate')

/* ---- 4. 两种模式都有日志，便于现场判断 ---- */

check('真 worker 模式有日志', /mode: 'dedicated-worker'/.test(block))
check('主线程回退有日志', /mode: 'main-thread'/.test(block))
check('探测结果单独记一条（含失败原因）',
  /event: 'pdfjs:worker-probe',\s*ok: probe\.ok,\s*reason: probe\.reason/.test(src),
  '只记成败不记原因，下次又只能靠猜')

/* ---- 5. 保留 worker 模块可用性检查 ---- */

check('回退分支仍校验 WorkerMessageHandler 存在',
  /没有 WorkerMessageHandler/.test(block),
  '模块里拿不到 Handler 时要报错，而不是拿 undefined 去跑')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
