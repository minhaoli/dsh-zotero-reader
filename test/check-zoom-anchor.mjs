#!/usr/bin/env node
/**
 * 缩放必须以**光标所在点为原点** —— 指针下的那个文档坐标点必须在屏幕上原地不动。
 *
 * 这是 GeoGebra / 地图 / 图片查看器的标准行为。锁住的是用户实测反馈的原话：
 *
 *   「现在修复后的效果是以光标所在当前页来缩放的，把当前页放在屏幕最上方。
 *     但是我要的是以光标所在点为原点来缩放」
 *
 * 为什么「页面锚点」做不到：把「该页顶部滚到视口顶部」（scrollPageIntoView 的
 * 语义，见 client.js 里的 `pageTop - 8 + pageH * offset`）当成缩放锚点，
 * 结果必然是某页贴顶。它和「指针下的点不动」只在「视口顶部正好压在页首」时
 * 碰巧一致，其余时候差得很远 —— 所以上一版的 restoreAnchor + zoom:reanchor
 * 被整体替换，而不是打补丁。本文件同时反向锁住「旧的页面锚点不得回来」。
 *
 * 新实现的三段式，逐段都有断言：
 *   ① 缩放**前**（几何还是旧的）捕获：(页, nx, ny) + 屏幕坐标 —— 入口在
 *      Ctrl+滚轮与切换按钮处，晚一步就取错了锚点；
 *   ② 写完 currentScale 后，用两跳 rAF 等 pdf.js 重排落定，再补偿一次；
 *   ③ 补偿用增量 `scroller.scrollTop += dy`，滚动容器由 findScrollParent 现找。
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
 * 按结构取函数体：从 `function NAME(` 起到下一个顶层 `function ` 声明为止。
 * 不用固定字符数 —— 这段里带了大段解释性注释，一加注释就切不准
 * （本项目已因固定窗口误报过多次）。
 */
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const tail = src.slice(start)
  const next = tail.indexOf('\n    function ', 10)
  return next > 0 ? tail.slice(0, next) : tail.slice(0, 6000)
}

/* ---------- ① 三个模块级函数存在且职责正确 ---------- */

const captureBody = fnBody('captureZoomAnchor')
const applyBody = fnBody('applyZoomAnchor')
const hitBody = fnBody('pageElementAtPoint')

check('存在 captureZoomAnchor（缩放前捕获指针锚点）', captureBody.length > 300,
  `实际 ${captureBody.length} 字符`)
check('存在 applyZoomAnchor（缩放后补偿）', applyBody.length > 300,
  `实际 ${applyBody.length} 字符`)
check('存在 pageElementAtPoint（屏幕点 → 页元素）', hitBody.length > 200,
  `实际 ${hitBody.length} 字符`)

/* ---------- ② 锚点数据形状：页号 + 归一化坐标 + 屏幕坐标 ---------- */

check('锚点记的是「页号 + 页内归一化坐标」',
  /nx: \(clientX - rect\.left\) \/ rect\.width/.test(captureBody)
    && /ny: \(clientY - rect\.top\) \/ rect\.height/.test(captureBody),
  '归一化坐标是唯一不随 scale 变化的量，像素坐标会随缩放变')

check('锚点同时保留屏幕坐标（补偿时的目标位置）',
  /clientX,\s*\n\s*clientY,/.test(captureBody) || /clientX,[\s\S]{0,40}clientY,/.test(captureBody),
  '没有原始屏幕坐标就算不出「该点被推开了多远」')

check('归一化坐标不做 clamp',
  captureBody.length > 0 && !/Math\.(min|max)\([^)]*\bnx\b/.test(captureBody),
  '指针可能停在页边缘外一点，夹取会让锚点跳到页边、缩放时抖一下')

/* ---------- ③ 补偿用「重新取矩形 + 增量滚动」 ---------- */

check('补偿时重新取该页矩形（不沿用旧几何）',
  /const rectNow = pageEl\.getBoundingClientRect\(\)/.test(applyBody))

check('按归一化坐标算出「该点现在应该在哪」',
  /wantX = rectNow\.left \+ anchor\.nx \* rectNow\.width/.test(applyBody)
    && /wantY = rectNow\.top \+ anchor\.ny \* rectNow\.height/.test(applyBody))

check('补偿量是屏幕坐标差',
  /dx = wantX - anchor\.clientX/.test(applyBody)
    && /dy = wantY - anchor\.clientY/.test(applyBody),
  '差值就是该点被推开的距离，滚回去即抵消')

check('用增量 += 滚动，不是绝对赋值',
  /scroller\.scrollTop \+= dy/.test(applyBody) && /scroller\.scrollLeft \+= dx/.test(applyBody),
  'pdf.js 已按旧 _location 自己滚过一次，我们要在它的结果之上校正')

check('横向也补偿（放大后页宽超出容器）',
  /scroller\.scrollLeft \+= dx/.test(applyBody))

check('滚动容器由 findScrollParent 现找',
  /findScrollParent\(pageEl\)/.test(applyBody),
  'scrollRef.current 挂在 .zr-page 上，不是真正吃滚动的节点，写它无效')

check('补偿不直接用 scrollRef.current 的 scrollTop',
  !/scrollRef\.current\.scrollTop\s*\+=/.test(src),
  '那是最初踩过的坑：写法看着正确、实际写在一个不滚的节点上')

/* ---------- ④ 时机：缩放前捕获，写 currentScale 后补偿 ---------- */

const syncIdx = src.indexOf('viewer.currentScale = scale')
function syncPoint() {
  return syncIdx
}
check('同步 effect 里在写 currentScale 之前就取好了锚点（从 ref 读出）', (() => {
  /**
   * 锚点现在是「手势级」的：捕获发生在滚轮/按钮入口（缩放前，几何还是旧的），
   * 同步 effect 只负责读基准锚点 + 看待补偿标记。断言这两件事都在写
   * currentScale 之前完成。
   */
  const readAnchor = src.indexOf('const zoomAnchor = zoomAnchorRef.current')
  const readPending = src.indexOf('if (!zoomPendingRef.current) return')
  return readAnchor > 0 && readPending > 0 && readPending < syncPoint()
})(), '锚点必须在旧几何上捕获，effect 里只读不算')

check('写完 currentScale 之后才补偿', (() => {
  /**
   * 取「同步 effect 里那次 viewer.currentScale = scale」到「settle(2)」为止，
   * 按结构边界而不是固定字数 —— 中间隔着整段说明注释，字数窗口会切不准。
   */
  const write = src.indexOf('viewer.currentScale = scale')
  if (write < 0) return false
  const tail = src.slice(write)
  const end = tail.indexOf('settle(2)')
  if (end < 0) return false
  const seg = tail.slice(0, end)
  return seg.includes('applyZoomAnchor(')
})(), '先缩放、再按新几何算补偿量')

check('补偿走两跳 rAF 等重排落定',
  /const settle = \(n\) =>/.test(src) && /requestAnimationFrame\(\(\) => settle\(n - 1\)\)/.test(src),
  '第一跳布局可能还没落定，第二跳的 getBoundingClientRect 才是新 scale 下的真几何')

check('只补偿一次，没有无限重试',
  /settle\(2\)/.test(src) && !/settle\(n \+ 1\)/.test(src),
  '增量补偿是一次线性校正，反复重试会和滚动事件来回震荡')

check('锚点是消费式的（读完即清空）',
  /zoomAnchorRef\.current = null/.test(src),
  '不清空会让一次旧锚点污染后续无关的缩放')

/* ---------- ⑤ 三个入口都传了锚点 ---------- */

check('Ctrl+滚轮用 event.clientX/clientY 作锚点',
  /captureZoomAnchor\(hostRef\.current, event\.clientX, event\.clientY\)/.test(src),
  '滚轮是唯一能拿到真实指针位置的入口，必须用它')

check('滚轮路径在 setScale 之前捕获',
  (() => {
    const cap = src.indexOf('captureZoomAnchor(hostRef.current, event.clientX, event.clientY)')
    const set = src.indexOf('setScale((current)', cap)
    return cap > 0 && set > cap
  })(),
  'setScale 之后 React 会重排，锚点就取晚了')

check('+/− 按钮没有指针，用阅读区视口中心', (() => {
  // 按钮现在同时设置基准锚点与待补偿标记（手势起点）
  const zoomIn = src.indexOf("title: t('zoomIn')")
  if (zoomIn < 0) return false
  const seg = src.slice(src.lastIndexOf('h(\'button\'', zoomIn), zoomIn)
  return /zoomAnchorRef\.current = a/.test(seg)
    && /captureCenterZoomAnchor\(\)/.test(seg)
    && /zoomPendingRef\.current = true/.test(seg)
})(), '按钮没有 event 坐标；不锚定就会退回贴顶')

/* ---------- 连续手势不振荡（本次修复的核心） ---------- */

check('存在手势间隔阈值', /const ZOOM_GESTURE_GAP_MS = \d+/.test(src),
  '没有阈值就无法区分「同一次手势的连续事件」与「两次独立缩放」')

check('滚轮在同一手势内沿用首个锚点，不逐个事件重取', (() => {
  const wheel = src.indexOf('const onWheel = (event) =>')
  if (wheel < 0) return false
  const tail = src.slice(wheel, wheel + 2400)
  return /const sameGesture = \(nowMs - prev\.capturedAt\) < ZOOM_GESTURE_GAP_MS/.test(tail)
    && /if \(!\(sameGesture && isSameAnchorPoint\(prev\.anchor, candidate\)\)\)/.test(tail)
})(), '每个 wheel 都重取锚点，会让基准点逐次漂移 —— 这就是「一半对一半乱飘」')

check('换基准需要判「是不是同一个物理点」', /function isSameAnchorPoint\(a, b\)/.test(src)
  && /a\.pageNo !== b\.pageNo/.test(src),
  '页号或屏幕坐标变了才算换了注视目标')

check('补偿链是单条（后来的只登记、不另排一条链）',
  /if \(zoomCompensationRef\.current != null\) \{[\s\S]{0,120}?pendingMergedRef\.current \+= 1/.test(src),
  '每次 effect 各排一条 rAF 链，多条链会在同一批帧里接连补偿，方向互相打架')

check('补偿基准在手势期间不被清掉', (() => {
  // 旧的错误形态：effect 一进来就把锚点置 null
  const bad = /const zoomAnchor = zoomAnchorRef\.current\s*\n\s*zoomAnchorRef\.current = null/
  return !bad.test(src)
})(), '清掉基准锚点后，下一个事件会在「已缩过一轮的页面」上重取，锚点必然漂')

check('每次补偿都按当时几何重算绝对目标，不累加残差',
  /wantX - anchor\.clientX/.test(src) && /wantY - anchor\.clientY/.test(src),
  '绝对目标 = 不变量，多次执行收敛；累加残差会越过并反向')

check('只有手势仍在继续时才追加一轮',
  /const gestureLive = perf\.now\(\) - zoomAnchorRecentRef\.current\.capturedAt < ZOOM_GESTURE_GAP_MS/.test(src))

check('诊断里记录被合并的轮次',
  /merged: mergedCount/.test(src),
  'zoom:anchor 条数少于 wheel 次数时，靠这个字段区分「合并」与「漏了」')

check('换文档时清理补偿状态（否则新文档一次都不补）', (() => {
  const cleanup = src.indexOf('zoomCompensationRef.current = null')
  const destroy = src.indexOf("try { viewer?.destroy?.() }")
  return cleanup > 0 && destroy > cleanup
})(), '残留的旧 settle 闭包会让新文档的缩放全被判成「已有链在跑」')

check('视口中心锚点按 host 的 bounding rect 计算',
  (() => {
    const start = src.indexOf('const captureCenterZoomAnchor')
    if (start < 0) return false
    const seg = src.slice(start, start + 700)
    return /r\.left \+ r\.width \/ 2/.test(seg) && /r\.top \+ r\.height \/ 2/.test(seg)
  })())

check('「适应宽度」当场补偿（它不走 scale state 同步 effect）',
  /viewer\.currentScaleValue = 'page-width'[\s\S]{0,900}?applyZoomAnchor\(/.test(src),
  '这条路径直接改 currentScaleValue，同步 effect 的 deps 不会触发，必须就地补')

check('「适应宽度」也记了 via 便于事后判读',
  /via: 'fit-width'/.test(src))

/* ---------- ⑥ 旧的「页面锚点」实现必须彻底消失 ---------- */

check('旧的按页回滚已移除（measureScrollOffsetByGeometry）',
  !/measureScrollOffsetByGeometry/.test(src),
  '它量的是「视口顶部落在页内的比例」，本质仍是页面锚点')

check('旧的 restoreAnchor 已移除',
  !/restoreAnchor/.test(src))

check('旧的 zoom:reanchor 事件名已不再使用',
  !/zoom:reanchor/.test(src),
  '事件名要跟着语义变，否则日志里两个含义混在一起')

/* ---------- ⑦ 不许改 scrollPageIntoView 的语义 ---------- */

const spiBody = fnBody('scrollPageIntoView')
check('scrollPageIntoView 仍是「页顶贴视口顶 + offset×页高」',
  /pageTop - 8 \+ pageH \* Math\.min\(0\.98/.test(spiBody),
  '链接跳转/位置恢复/页码跳转都靠它，语义不能被缩放撑爆')

check('scrollPageIntoView 没有被缩放锚点调用',
  !/scrollPageIntoView\(host, zoomAnchor|scrollPageIntoView\(hostRef\.current, anchor/.test(src),
  '拿它做缩放锚点就会变成贴顶 —— 上一版正是这么错的')

/* ---------- ⑧ 诊断 ---------- */

check('记录 zoom:anchor，字段为 page/nx/ny/dx/dy',
  /event: 'zoom:anchor'/.test(src)
    && /page: (zoomAnchor|anchor)\.pageNo/.test(src)
    && /nx: Number\(\(?zoomAnchor|nx: Number\(\(?anchor/.test(src.replace(/^\s+/gm, ''))
    || (/event: 'zoom:anchor'/.test(src) && /nx: Number/.test(src) && /dy: Number/.test(src)),
  '用户事后要能从这里看出「锚点落在哪页、补了多少像素」')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
