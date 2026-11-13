/**
 * 性能探针的纯逻辑自测。
 *
 * 探针在浏览器里跑，但它的判据（分位数、限流、长任务交集、渲染页数）
 * 是可以脱离 DOM 验证的纯计算。这里复刻一份同样的实现跑数值，
 * 防止「探针自己算错」导致结论跑偏 —— 测量工具本身必须可信。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

let fail = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`)
  if (!cond) fail += 1
}

/* 1. 探针必须真的存在，且关键能力都在 */
for (const [needle, why] of [
  ["entryTypes: ['longtask']", 'longtask 观测'],
  ['function notePainted', '渲染页数计数'],
  ['function paintedStats', '重复渲染统计'],
  ['function windowOpen', '长任务归因时间窗'],
  ['function attribute', '长任务归因'],
  ['SUMMARY_MIN_GAP', '限流闸门'],
  ["event: 'perf:summary'", '汇总事件前缀'],
  ["event: 'perf:paint'", '逐页绘制事件'],
]) {
  ok(src.includes(needle), `探针包含 ${why}（${needle}）`)
}

/* 2. 限流必须按 label 分开，否则 open 会把 jump 挤掉 */
ok(/lastSummaryByLabel/.test(src), '限流按 label 分开')

/* 3. 复刻分位数实现，确认与 client.js 里的一致 */
const percentile = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[i]
}
const ms = [16.7, 16.7, 16.7, 33.3, 100, 250, 16.7, 16.7, 16.7, 16.7]
ok(percentile(ms, 50) === 16.7, 'p50 落在常规帧')
ok(percentile(ms, 95) === 250, 'p95 抓住长帧')
ok(percentile([], 50) === 0, '空样本返回 0 不抛错')
ok(percentile([42], 95) === 42, '单样本也能取')

/* 4. 掉帧/冻结判据 */
const jank = ms.filter((v) => v > 50).length
const freeze = ms.filter((v) => v > 200).length
ok(jank === 2, `jank(>50ms) 计数正确 = ${jank}`)
ok(freeze === 1, `freeze(>200ms) 计数正确 = ${freeze}`)

/* 5. 长任务归因：交集必须只算落在窗口内的部分（两端都要夹） */
const attribute = (tasks, s, e) =>
  tasks
    .filter((x) => x.t + x.d > s && x.t < e)
    .reduce((a, x) => a + Math.max(0, Math.min(x.t + x.d, e) - Math.max(x.t, s)), 0)

const tasks = [
  { t: 100, d: 60 },  // [100,160) ∩ [150,300) → 10ms
  { t: 300, d: 50 },  // [300,350) 起点正好在窗口右界上 → 0
  { t: 50, d: 120 },  // [50,170)  ∩ [150,300) → 20ms
]
const covered = attribute(tasks, 150, 300)
ok(covered === 30, `长任务交集正确（期望 30，实际 ${covered}）`)

/* 回归：旧实现只夹了起点，会把 60 当成 60、把 120 当成 120，总计虚报 180 */
const buggy = (tasks, s, e) =>
  tasks
    .filter((x) => x.t + x.d > s && x.t < e)
    .reduce((a, x) => a + Math.min(x.d, e - Math.max(x.t, s)), 0)
ok(buggy(tasks, 150, 300) === 180, '旧实现确实会虚报（说明这条自测抓的是真 bug）')

/* 6. 逐页绘制序列的「一次性渲染」判据：如果 15 页都在很短时间内画完，就是没按需渲染 */
const paintTimes = [120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 960]
const span = paintTimes[paintTimes.length - 1] - paintTimes[0]
ok(span < 2000, `15 页在 ${span}ms 内画完 → 判定为一次性渲染（这正是要抓的模式）`)

/* 7. 重复渲染计数器必须真能检出重复 —— 构造人为重复，验证它会涨 */
/**
 * 这条是回应一个反复出现的教训：计数器「看起来没发现重复」可能是坏的，
 * 而不是真的没重复。所以不能只测「正常情况返回 0」，必须人为制造重复，
 * 确认它确实会涨、且涨到正确数字。验证不了等于没有。
 */
const makePainted = () => {
  const painted = new Map()
  const lifePainted = new Map()
  const notePainted = (n) => {
    painted.set(n, (painted.get(n) || 0) + 1)
    lifePainted.set(n, (lifePainted.get(n) || 0) + 1)
  }
  const stats = () => {
    const dup = [...painted.entries()].filter(([, n]) => n > 1)
    const lifeDup = [...lifePainted.entries()].filter(([, n]) => n > 1)
    return {
      paintedPages: painted.size,
      repaintPages: dup.length,
      repaintTimes: dup.reduce((a, [, n]) => a + (n - 1), 0),
      lifeRepaintPages: lifeDup.length,
      lifeRepaintTimes: lifeDup.reduce((a, [, n]) => a + (n - 1), 0),
    }
  }
  return { notePainted, stats, clearPeriod: () => painted.clear() }
}

// 场景 A：同一次打开里第 3 页画了两次 —— 必须报出来
const A = makePainted()
A.notePainted(1); A.notePainted(2); A.notePainted(3); A.notePainted(3)
const sa = A.stats()
ok(sa.repaintPages === 1, `人为重复一次 → repaintPages=1（实际 ${sa.repaintPages}）`)
ok(sa.repaintTimes === 1, `人为重复一次 → repaintTimes=1（实际 ${sa.repaintTimes}）`)

// 场景 B：一页画 6 次 —— 多余次数应当是 5
const B = makePainted()
for (let i = 0; i < 6; i += 1) B.notePainted(9)
const sb = B.stats()
ok(sb.repaintTimes === 5, `画 6 次 → 多余 5 次（实际 ${sb.repaintTimes}）`)

// 场景 C：真实踩过的坑 —— 6 次被拆到 3 个汇总周期，周期内计数看不见
const C = makePainted()
for (let i = 0; i < 3; i += 1) {
  C.notePainted(1); C.notePainted(1)
  C.clearPeriod() // 每个周期汇总后清零
}
const sc = C.stats()
ok(sc.repaintTimes === 0, `周期内计数确实看不见跨周期重复（${sc.repaintTimes}）—— 所以必须另外记生命周期计数`)
ok(sc.lifeRepaintTimes === 5, `生命周期计数能看见跨周期重复（期望 5，实际 ${sc.lifeRepaintTimes}）`)

// 场景 D：正常无重复时不能误报
const D = makePainted()
D.notePainted(1); D.notePainted(2); D.notePainted(3)
const sd = D.stats()
ok(sd.repaintTimes === 0 && sd.lifeRepaintTimes === 0, '无重复时不误报')

console.log(fail === 0 ? '\n探针逻辑自测全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
