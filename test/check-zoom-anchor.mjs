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
const captureCallBefore = src.lastIndexOf('captureZoomAnchor(', syncIdx)
check('同步 effect 里在写 currentScale 之前就取好了锚点（从 ref 读出）',
  src.lastIndexOf('const zoomAnchor = zoomAnchorRef.current', syncIdx) > 0
    && captureCallBefore > 0,
  '锚点必须在旧几何上捕获；写完之后再取，同一个屏幕点已指向别的文档位置')

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

check('+/− 按钮没有指针，用阅读区视口中心',
  /captureCenterZoomAnchor/.test(src)
    && /zoomAnchorRef\.current = captureCenterZoomAnchor\(\)/.test(src),
  '按钮没有 event 坐标；不锚定就会退回贴顶')

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
