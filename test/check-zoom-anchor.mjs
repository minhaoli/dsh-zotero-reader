#!/usr/bin/env node
/**
 * 缩放必须停在用户当前看的位置，不能被「恢复上次阅读位置」拽回去。
 *
 * 锁住的 bug：点 +/−、Ctrl+滚轮、适应宽度之后，视图不是留在原地，而是被拉到
 * 上次打开这篇 PDF 时记下的那一页；那条记录若是第 1 页，看到的就是
 * 「所有页面重新缩放后从第一页重排」。
 *
 * 排查时最容易走错的一步，是先认定「pagesinit 每次 refresh 都会重发」。
 * 它不是 —— 这里把结论连同证据一起锁住，免得后来人再照着错前提改一遍：
 *   · pdf_viewer.mjs 里 "pagesinit" 只有两处命中：L3812（EventBus 分类数组）
 *     与 L8660（setDocument 的 firstPagePromise 链尾部，真正的派发点）；
 *   · PDFViewer.refresh(noUpdate) 只做 pageView.update() + this.update()，
 *     不派发 pagesinit；而 #setScaleUpdatePages 走的就是 refresh(true, {scale})。
 *
 * 真正会动的两条：
 *   ① pagesinit 的「恢复滚页」只允许在**一次文档装载**里执行一次，
 *      之后的装载由 applyResume 那条有判据的重试链负责，不归它管；
 *   ② 缩放同步 effect 在写回 currentScale 前记住锚点，写回后发现位置被挪走
 *      就自己滚回去 —— pdf.js 的保位依赖 `_location`，而它一旦算错不会报错。
 *
 * 跑法：node test/check-zoom-anchor.mjs
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
 * 结构边界取回调体：从 `eventBus.on(` 的 `'pagesinit'` 起，到 `{ once: true }`
 * 之后的收尾。不能用固定字符数 —— 这段里带着整段生命周期说明的注释，
 * 一加注释就切不准（本项目已因固定窗口误报过多次）。
 */
const regIdx = src.indexOf("'pagesinit'")
const onceIdx = src.indexOf('{ once: true }', regIdx)
const block = regIdx > 0 && onceIdx > regIdx
  ? src.slice(regIdx, onceIdx + '{ once: true }'.length)
  : ''

check('找得到 pagesinit 注册', regIdx > 0)
check('pagesinit 回调区块已定位（下面断言的前提）', block.length > 400,
  `实际 ${block.length} 字符`)

/* ---------- ① 只执行一次的守卫 ---------- */

check('有「本次文档已消费过恢复」的标记',
  /resumeByInitRef\.current/.test(block),
  '没有它就无法区分「这次装载」与「上一次装载残留的状态」')

check('守卫在滚页之前读取并置位',
  (() => {
    const read = block.indexOf('const already = resumeByInitRef.current')
    const set = block.indexOf('resumeByInitRef.current = true')
    const scroll = block.indexOf('scrollPageIntoView(host, resumePage, resumeOffset)')
    return read > 0 && set > read && scroll > set
  })(),
  '必须「先读、再置位、最后滚动」；顺序反了等于没有守卫')

check('已经执行过就跳过滚页（willScroll 为假时不滚）',
  /const willScroll = !already && resumePage > 1/.test(block)
    && /if \(!willScroll\) return/.test(block),
  '守卫要落在决策点上，不能只置位不判断')

check('滚页仍然只在第 1 页之后做',
  /resumePage > 1/.test(block),
  '第 1 页本来就在顶部，再滚一次没必要，还会和 pdf.js 抢位置')

/* ---------- ② 清理不能被一起跳过 ---------- */

check('清理（揭恢复遮罩）与滚页分开，独立执行',
  /host\?\.dataset\?\.restoring === '1'/.test(block) && /delete host\.dataset\.restoring/.test(block),
  '原先 resumePage<=1 时直接 return，把清理一起跳过了，遮罩会一直挂着')

check('清理位于「是否滚页」的决策之前',
  (() => {
    const cleanup = block.indexOf("delete host.dataset.restoring")
    const decide = block.indexOf('const willScroll')
    return cleanup > 0 && decide > cleanup
  })(),
  '清理必须无条件先跑，否则守卫一旦不滚页，遮罩就永远揭不开')

/* ---------- ③ 标记的生命周期与 setDocument 对齐 ---------- */

const resetIdx = src.indexOf('resumeByInitRef.current = false')
const setDocIdx = src.indexOf('viewer.setDocument(pdf.doc)')
const doneResetIdx = src.indexOf('resumeDoneRef.current = false')

check('标记在 setDocument 之前复位',
  resetIdx > 0 && setDocIdx > 0 && resetIdx < setDocIdx,
  'setDocument 内部就会派发 pagesinit，晚一步复位等于把上一轮状态带进来')

check('复位位置紧挨着 resumeDoneRef（生命周期一致）',
  resetIdx > doneResetIdx && doneResetIdx > 0,
  '两者都表示「本次文档」的状态，跟同一处走才不会漂移')

/* ---------- ④ 诊断记录：现场能看出是谁在滚页 ---------- */

const diagIdx = block.indexOf("event: 'pagesinit'")
check('pagesinit 里记录了 willScroll / already / resumePage / currentPage',
  diagIdx > 0
    && /willScroll,/.test(block) && /already,/.test(block)
    && /resumePage,/.test(block) && /currentPage:/.test(block),
  '这是现场判断「这一轮到底是谁在滚页」的唯一依据，字段要一次给全')

check('诊断记录被限制在每个文档一次（不刷屏）',
  (() => {
    // 它在 willScroll 计算之后、!willScroll 提前返回之前，所以每个文档最多一条
    const diag = block.indexOf("event: 'pagesinit'")
    const early = block.indexOf('if (!willScroll) return')
    return diag > 0 && early > diag
  })(),
  '放在提前返回之后就变成只有滚页时才记，放在重试链里就会每帧一条')

/* ---------- ⑤ 缩放锚点兜底 ---------- */

check('缩放汇聚点记录了「刚刚在缩放」的时刻',
  /zoomAtRef\.current = perf\.now\(\)/.test(src),
  'scalechanging 是全部缩放入口的唯一汇聚点，挂这里一处就覆盖按钮/滚轮/适应')

const syncIdx = src.indexOf('viewer.currentScale = scale')
check('写回 currentScale 之前先记下锚点',
  syncIdx > 0 && src.lastIndexOf('const anchorPage', syncIdx) > 0,
  '锚点必须在写之前取，写完再取就取的是已经被挪走的位置')

check('写回之后验证位置，被挪走才自己滚回去',
  /event: 'zoom:reanchor'/.test(src) && /scrollPageIntoView\(hostRef\.current, anchorPage, anchorOffset\)/.test(src),
  'pdf.js 的保位依赖 _location，算错时不报错，必须有几何兜底')

check('兜底复用现成的滚动实现，没有第二份内联实现',
  (src.match(/\.scrollIntoView\(/g) ?? []).length === 1,
  'scrollPageIntoView 是唯一的几何滚动实现，多处实现会导致行为不一致')

/* ---------- ⑥ 不把缩放重新变成「逐帧重建批注层」 ---------- */

const sigIdx = src.indexOf('const sig = [')
const sigBlock = sigIdx > 0 ? src.slice(sigIdx, src.indexOf("].join('#')", sigIdx)) : ''
check('签名用缩放比，不用会逐帧抖动的取整尺寸',
  sigBlock.length > 0 && /pageScale/.test(sigBlock)
    && !/Math\.round\(pw\)/.test(sigBlock) && !/Math\.round\(ph\)/.test(sigBlock),
  '尺寸进签名会让缩放过程中每一帧都判定失效，批注层被反复清空重建')

check('缩放刚发生时不抢下一帧补装饰',
  /perf\.now\(\) - zoomAtRef\.current < 240/.test(src),
  '缩放期间在 pdf.js 重排过程中改 DOM 是「缩放卡顿」的另一半来源')

/* ---------- ⑦ 既有能力不受影响 ---------- */

check('仍然在 setDocument 之前挂好 pagesinit（抢跑渲染目标页）',
  regIdx > 0 && setDocIdx > regIdx)
check('恢复遮罩与 pagerendered 揭幕逻辑仍在',
  /host\.dataset\.restoring = '1'/.test(src) && /resumeTargetRef\.current/.test(src))
check('applyResume 那条有判据的重试链没被删掉',
  /const applyResume = \(attempt\) =>/.test(src) && /const ok = pageOk && scrolled/.test(src))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
