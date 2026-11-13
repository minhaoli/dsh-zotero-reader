/**
 * 性能探针数据汇总器。
 *
 * 把 client-log.jsonl 里的 perf:* 行整理成能直接下结论的表格：
 *   1. 每次打开 PDF 的画像（长任务 / 帧间隔 / 布局抖动 / 渲染页数）
 *   2. 逐页绘制时间线（判断是「只画可见页」还是「一口气全画」）
 *   3. 跳页 / 滚动的交互质量
 *
 * 用法：node test/analyze-perf.mjs [日志路径]
 */
import { readFileSync } from 'node:fs'

const LOG = process.argv[2] || 'C:\\Users\\30759\\.dsh-zotero-reader\\client-log.jsonl'

function readTail(path, bytes = 4 * 1024 * 1024) {
  // 只读尾部：日志可能很大，全量读会拖慢
  const buf = readFileSync(path)
  const slice = buf.length > bytes ? buf.subarray(buf.length - bytes) : buf
  return slice.toString('utf8')
}

const raw = readTail(LOG)
const rows = []
for (const line of raw.split('\n')) {
  if (!line.includes('"event"')) continue
  try {
    const o = JSON.parse(line)
    if (o.event && o.event.startsWith('perf:')) rows.push(o)
    else if (['pdf:start', 'pdf:ready', 'viewer:doc-set'].includes(o.event)) rows.push(o)
  } catch { /* 截断行跳过 */ }
}

if (!rows.length) {
  console.log('没有 perf:* 数据。需要刷新页面并打开一篇 PDF，探针才会开始采集。')
  process.exit(0)
}

const num = (v) => (typeof v === 'number' ? v : 0)
const pad = (s, n) => String(s).padEnd(n)

/* ---------- 0. 探针是否已加载 ---------- */
/**
 * 「没有 perf 数据」有两种完全不同的原因，处理方式也不同：
 *   ① 页面还是旧代码 —— 需要刷新
 *   ② 新代码已在，但没打开过 PDF —— 需要用户去打开一篇
 * 心跳能把这两者分开，省掉一轮「刷新了没？」的来回确认。
 */
const beats = rows.filter((r) => r.event === 'perf:probe-ready')
if (beats.length === 0) {
  console.log('\n!! 未找到 perf:probe-ready 心跳 —— 页面很可能还是旧 client.js，请刷新页面')
  console.log('   （若确认已刷新，则说明心跳没跑起来，检查 reader:mount 是否触发）')
} else {
  const b = beats[beats.length - 1]
  console.log(`\n探针已加载 version=${b.version}  心跳 ${beats.length} 次`)
  const caps = []
  if (b.raf) caps.push('rAF')
  if (b.longtaskObserver) caps.push('longtask')
  if (b.layoutProbe) caps.push('layout')
  console.log(`能力: ${caps.join(' / ') || '无'}`)
  if (!b.longtaskObserver) console.log('  !! 不支持 longtask —— 主线程阻塞只能靠帧间隔推断')
}

/* ---------- 1. 每次打开的画像 ---------- */
const summaries = rows.filter((r) => r.event === 'perf:summary')
console.log(`\n===== perf:summary 共 ${summaries.length} 条 =====\n`)

for (const s of summaries) {
  console.log(`── label=${s.label}${s.itemKey ? ` item=${s.itemKey}` : ''}`)
  console.log(`   时长 ${num(s.spanMs)}ms | 采样 ${num(s.frames)} 帧`)
  console.log(
    `   帧间隔  p50=${num(s.frameP50)}ms  p95=${num(s.frameP95)}ms  max=${num(s.frameMax)}ms`,
  )
  console.log(
    `   卡顿    jank>50ms=${num(s.jank)}  freeze>200ms=${num(s.freeze)}`,
  )
  console.log(
    `   长任务  ${num(s.longTasks)} 个 / 合计 ${num(s.longTaskMs)}ms / 最长 ${num(s.longTaskMax)}ms`,
  )
  if ('layoutReads' in s) {
    console.log(
      `   布局    reads=${num(s.layoutReads)}  forced=${num(s.layoutForced)}  合计 ${num(s.layoutMs)}ms  max=${num(s.layoutMax)}ms`,
    )
  }
  if ('paintedPages' in s) {
    console.log(
      `   渲染    paintedPages=${num(s.paintedPages)}  repaintPages=${num(s.repaintPages)}(+${num(s.repaintTimes)} 次)`,
    )
    if (Array.isArray(s.paintedList) && s.paintedList.length) {
      console.log(`           页序: ${s.paintedList.join(',')}`)
    }
  }
  if (Array.isArray(s.phases) && s.phases.length) {
    console.log('   阶段:')
    for (const p of s.phases) {
      const extra = p.blockedMs !== undefined ? `  (主线程被占 ${p.blockedMs}ms)` : ''
      console.log(`     ${pad(p.n, 24)} ${p.ms !== undefined ? `${p.ms}ms` : p.tag}${extra}`)
    }
  }
  console.log('')
}

/* ---------- 2. 逐页绘制时间线 ---------- */
const paints = rows.filter((r) => r.event === 'perf:paint')
if (paints.length) {
  console.log(`\n===== perf:paint 共 ${paints.length} 条 =====`)
  // 以第一页的 at 为原点
  const t0 = Math.min(...paints.map((p) => num(p.at)))
  console.log('  页  相对ms   可见   canvas数')
  for (const p of paints) {
    const visible = p.visibleAtPaint === true ? '是' : p.visibleAtPaint === false ? '否' : '-'
    console.log(
      `  ${pad(p.page, 4)}${pad(num(p.at) - t0, 9)}${pad(visible, 7)}${num(p.canvasCount)}`,
    )
  }
  const visTrue = paints.filter((p) => p.visibleAtPaint === true).length
  const visFalse = paints.filter((p) => p.visibleAtPaint === false).length
  const maxCanvas = Math.max(...paints.map((p) => num(p.canvasCount)))
  console.log(`\n  判定输入：视口内 ${visTrue} 页 / 视口外 ${visFalse} 页，canvas 峰值 ${maxCanvas}`)
  if (visFalse > visTrue) {
    console.log('  ⚠ 大量「视口外」页也被绘制 → 没有按需渲染')
  } else if (maxCanvas <= 6) {
    console.log('  ✓ 只画可见页（canvas 数稳定在个位数）→ 问题在单页渲染开销')
  }
} else {
  console.log('\n（没有 perf:paint：pagerendered 一次都没触发，或页面尚未刷新加载新代码）')
}

/* ---------- 3. 打开链路各段 ---------- */
const starts = rows.filter((r) => r.event === 'pdf:start')
const readies = rows.filter((r) => r.event === 'pdf:ready')
console.log(`\n===== 打开链路 =====`)
console.log(`  pdf:start=${starts.length}  pdf:ready=${readies.length}`)
const bytesIdx = rows.filter((r) => r.event === 'pdf:bytes')
if (bytesIdx.length) {
  const sz = bytesIdx.map((r) => num(r.bytes)).filter((v) => v > 0)
  if (sz.length) {
    console.log(`  PDF 大小 p50=${Math.round(sz.sort((a, b) => a - b)[Math.floor(sz.length / 2)] / 1024)}KB`)
  }
}
