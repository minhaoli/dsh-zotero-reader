#!/usr/bin/env node
/**
 * 跳转历史 / 返回跳转前的位置。
 *
 * 需求原话：「记录位置序列，然后点击可以回到跳转前的位置，多次跳转可以依次
 * 记录的。然后每跳回一次删除对应的位置记录」。
 *
 * 拆开是五条不变量，任何一条错了用户都会立刻感觉到「这按钮没用」：
 *   ① 栈有上限 —— 不封顶就是一个只增不减的数组，读一下午攒几百条；
 *   ② 跳转时压栈、恢复时弹栈 —— 且压的必须是**跳转前**的位置；
 *   ③ 恢复路径不压栈 —— 否则点返回把自己压回去，栈永远见不了底；
 *   ④ 栈空时按钮 disabled；
 *   ⑤ 切文献清空 —— 跨文献的页码毫无意义。
 *
 * 结构检查为主（与 check-session-isolation 同一套哲学）：这些都是
 * 「结构错了行为必错」的东西，而真实交互要开浏览器点 PDF 链接才看得见。
 * 判据保守，只报确定的。
 *
 * 一个反复踩过的坑，这里同样要绕开：**位置/存在性断言一律先剥离注释**。
 * 本项目解释性注释极多，而这些注释里恰好会写着下面要找的那些词
 * （比如说明里就写着 `scrollRef.current` 为什么不能用）——
 * 直接对原文正则匹配，会把「注释里提到」误判成「代码里用了」。
 */
import fs from 'node:fs'

const file = process.argv[2] ?? 'client.js'
const src = fs.readFileSync(file, 'utf8')

/**
 * 去掉注释，保留换行（行号仍然对得上，便于人肉定位）。
 *
 * 只做行注释 + 块注释的粗剥：字符串里的 `//` 会被一并切掉，
 * 但那只会让断言**更保守**（少匹配到东西 → 报 FAIL 而不是假通过），
 * 对本文件这些结构性断言来说是可接受的方向。
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      const k = line.indexOf('//')
      return k >= 0 ? line.slice(0, k) : line
    })
    .join('\n')

const code = stripComments(src)

let failed = 0
function check(name, ok, hint) {
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL ${name}`)
  if (hint) console.log(`       → ${hint}`)
}

/** 取某个函数体：从 signature 起，到括号配平为止。拿不到返回 ''。 */
function bodyOf(signature) {
  const at = code.indexOf(signature)
  if (at < 0) return ''
  let i = code.indexOf('{', at)
  if (i < 0) return ''
  let depth = 0
  for (; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return code.slice(at, i + 1)
    }
  }
  return ''
}

console.log('=== 目标文件 ===')
console.log(' ', file)
console.log('')

/* ---- A. 栈本身：存在、有上限 -------------------------------------------- */
console.log('=== A. 历史栈存在且有上限 ===')
check(
  '存在跳转历史栈 hopStackRef（数组）',
  /const\s+hopStackRef\s*=\s*useRef\(\s*\[\s*\]\s*\)/.test(code),
  '需要一个是栈（后进先出）而不是单个「上一位置」变量 —— 需求要「多次跳转依次记录」',
)
check(
  '存在上限常量 HOP_LIMIT',
  /const\s+HOP_LIMIT\s*=\s*\d+/.test(code),
  '不封顶就是只增不减的数组，没有回收点',
)
const pushBody = bodyOf('const pushHop = useCallback(')
check('压栈函数 pushHop 已定义', pushBody.length > 200, `实际长度 ${pushBody.length}`)
check(
  '超出上限时丢最旧的一条（splice 在 push 之后）',
  /stack\.push\(/.test(pushBody) &&
    /stack\.length\s*>\s*HOP_LIMIT/.test(pushBody) &&
    /stack\.splice\(\s*0\s*,/.test(pushBody),
  '丢最旧而不是丢最新：留最近的才对回溯有用，和浏览器前进后退一致',
)
check(
  '每次压栈都同步镜像层数给界面（setHopDepth）',
  /setHopDepth\(stack\.length\)/.test(pushBody),
  '栈在 ref 里，不镜像长度按钮不会重渲染，压栈后仍是灰的',
)

/* ---- B. 压栈时机：只在跳转时 -------------------------------------------- */
console.log('\n=== B. 跳转时压栈 ===')
check(
  'record 内容是 { pageNo, offset }',
  /measurePosByGeometry\(/.test(pushBody) || /pushHop[\s\S]{0,600}pageNo[\s\S]{0,200}offset/.test(code),
  '历史要按「页 + 页内比例」记，只记页号会把视图吸到页首，视觉参照点丢了',
)
check(
  '位置用几何量测（measurePosByGeometry），不是量 scrollRef',
  /function\s+measurePosByGeometry\s*\(\s*hostEl\s*,\s*pageNo\s*\)/.test(code),
  '需要 scrollPageIntoView 的反函数，两处同源才能「记住哪就从哪儿回去」',
)

const measureBody = bodyOf('function measurePosByGeometry(')
check('measurePosByGeometry 已定位', measureBody.length > 200, `实际长度 ${measureBody.length}`)
check(
  '反算时用了 findScrollParent（不是写死某个节点）',
  /findScrollParent\(pageEl\)/.test(measureBody),
  '真正吃滚动的是哪一层只能按几何判定，写死会量到一个不滚的节点',
)
check(
  '页内比例夹到 0..0.98',
  /Math\.min\(\s*0\.98\s*,/.test(measureBody) && /Math\.max\(\s*0\s*,/.test(measureBody),
  '上界要和 scrollPageIntoView 内部的 0.98 对齐，否则量出 0.99 传回去被夹成 0.98，位置会漂',
)
/**
 * 反解 `scrollPageIntoView` 的算式时，那个 8px 贴顶余量的**符号**必须对。
 *
 * 落点是 `pageTop - 8 + pageH * offset`，反解得 `offset = (scrollerTop - pageTop + 8) / pageH`。
 * 写成 `- 8` 会让每次压栈量出的比例恒定偏小约 8/pageH，
 * 而且压栈→返回是往返，偏差直接叠加到落点上 —— 单次几乎看不出来，
 * 退几步之后会明显「差那么一小截」。这类符号错误不会报错，只会手感不对。
 */
check(
  '反解时把 8px 贴顶余量补回（+8，不是 -8）',
  /\+\s*8\s*[\r\n\s]*\)\s*\/\s*pageH|-\s*pageEl\.getBoundingClientRect\(\)\.top\s*\+\s*8/.test(measureBody),
  'scrollPageIntoView 的落点是 pageTop - 8 + pageH*offset，反解必须 +8；写成 -8 会恒偏小 8/pageH',
)
check(
  '没有把贴顶余量写成 -8',
  !/-\s*pageEl\.getBoundingClientRect\(\)\.top\s*-\s*8/.test(measureBody),
  '符号写反不会报错，只会让每次返回都「差那么一小截」',
)

/**
 * 三个跳转入口必须都压栈。
 *
 * 逐个点名，而不是「全文件搜 pushHop 出现次数」：后者在注释里提一句就能骗过。
 * gotoPage 是总阀（页码输入、上/下页、大纲、批注列表、会话页码点击都走它），
 * 另外两处是 PDF 内部链接的两个分支。
 */
const gotoBody = bodyOf('const gotoPage = useCallback(')
check('gotoPage 已定位', gotoBody.length > 200, `实际长度 ${gotoBody.length}`)
check(
  'gotoPage 在跳转前压栈',
  /pushHop\(\)/.test(gotoBody),
  '页码输入、上/下页、大纲、批注列表、会话页码点击全都收敛到 gotoPage，在这里挂一次全覆盖',
)
check(
  'gotoPage 只对「真的会移动」的跳转压栈（先与当前页比较）',
  /target\s*!==\s*fromPage[\s\S]{0,80}pushHop|if\s*\(\s*target\s*!==\s*fromPage\s*\)\s*pushHop/.test(gotoBody),
  '点到已经在的页不该占一格历史，否则「点了没动」也会让返回按钮亮起来',
)
check(
  'PDF 内链接 #page=N 分支压栈',
  /#page=\(\\d\+\)[\s\S]{0,400}pushHop\(\)/.test(code),
  '文内 #page=N 跳转会直接写 currentPageNumber，不经过 gotoPage，需要单独挂',
)
check(
  '具名目标（jumpToNamedDest）分支压栈',
  /const\s+jumpToNamedDest\s*=[\s\S]{0,3000}?pushHop\(\)/.test(code),
  'LaTeX 的 #eq1 / #cite.xxx 走 jumpToNamedDest，另一条独立路径，需要单独挂',
)

/**
 * 压栈必须在改写 currentPageNumber **之前**。
 *
 * 这是最容易写反的一处：写到后面，量到的就是目标的页顶，
 * 历史里存的全是「刚跳到的地方」，点返回等于原地不动。
 */
check(
  '压栈早于 currentPageNumber 改写（具名目标分支）',
  (() => {
    const at = code.indexOf('const jumpToNamedDest')
    if (at < 0) return false
    const seg = code.slice(at, at + 4000)
    const push = seg.indexOf('pushHop()')
    const setPage = seg.indexOf('viewer.currentPageNumber = pageNo')
    return push > 0 && setPage > 0 && push < setPage
  })(),
  '位置取在改写之后 = 记下的是目标位置，返回就是原地不动',
)

/* ---- C. 弹栈：消费式 + 循环保护 ---------------------------------------- */
console.log('\n=== C. 恢复时弹栈，且不回流压栈 ===')
const popBody = bodyOf('const popHop = useCallback(')
check('弹栈函数 popHop 已定义', popBody.length > 200, `实际长度 ${popBody.length}`)
check(
  '消费式：弹出一条并删掉',
  /stack\.pop\(\)/.test(popBody),
  '需求明确「每跳回一次删除对应的位置记录」',
)
check(
  '弹栈后同步镜像层数（栈空才能变 disabled）',
  /setHopDepth\(stack\.length\)/.test(popBody),
  '不退镜像层数，退到底了按钮还是亮的，点了没反应',
)
check(
  '恢复走 scrollPageIntoView(host, page, offset)',
  /scrollPageIntoView\(hostRef\.current,\s*pageNo,\s*pos\.offset\)/.test(popBody),
  '和压栈同一套几何，才是「怎么记的怎么回去」',
)

/**
 * 循环保护：恢复期间不压栈。
 *
 * 判据是**结构**：压栈的唯一出口上有一个 flag 守卫，且恢复路径把它置位。
 * 这样再多接入几个跳转入口也自动受保护 —— 比「让恢复绕开某个函数」可靠。
 */
check(
  '有恢复中标记 hopRestoringRef',
  /const\s+hopRestoringRef\s*=\s*useRef\(\s*false\s*\)/.test(code),
  '恢复本身也要滚页、写页码，外观和一次跳转一样',
)
check(
  '压栈出口处判了恢复标记（命中即放弃压栈）',
  /if\s*\(\s*hopRestoringRef\.current\s*\)\s*return/.test(pushBody),
  '不拦的话点一次返回就把「返回前的位置」重新压进去，栈永远见不了底',
)
check(
  '恢复期间置位标记',
  /hopRestoringRef\.current\s*=\s*true/.test(popBody),
  '只在压栈侧判、不在恢复侧置位，等于没保护',
)
check(
  '标记在 finally 里复位（中途抛错也不卡住）',
  /\}\s*finally\s*\{[\s\S]{0,200}hopRestoringRef\.current\s*=\s*false/.test(popBody),
  '卡在 true 会让之后所有跳转都不再记历史，而且完全静默',
)

/* ---- D. 按钮：栈空 disabled -------------------------------------------- */
console.log('\n=== D. 返回按钮 ===')
check(
  '工具条里有返回按钮',
  /onClick:\s*\(\)\s*=>\s*\{\s*popHop\(\)\s*\}/.test(code),
  '需求要的是「一个按钮，点了回到跳转前的位置」',
)
check(
  '按钮 disabled 由栈深度驱动',
  /disabled:\s*hopDepth\s*===\s*0/.test(code),
  '栈空时应当禁用（或点了无效果），灰掉是唯一可靠的可见信号',
)
check(
  '存在 hopDepth 这个 state',
  /const\s+\[\s*hopDepth\s*,\s*setHopDepth\s*\]\s*=\s*useState\(\s*0\s*\)/.test(code),
  '栈在 ref 里不会触发重渲染，按钮状态必须来自 state',
)
check(
  '按钮文案走 i18n（t）',
  /t\('backToPrevDepth'/.test(code) && /t\('backToPrev'\)/.test(code),
  '本项目所有按钮文本都走 t()，硬编码中文会同时废掉英文界面',
)
check(
  '中英两套词条都有 backToPrev 系列',
  ['backToPrev', 'backToPrevDepth'].every(
    (k) => (code.match(new RegExp(`^\\s*${k}:`, 'gm')) || []).length === 2,
  ),
  '词典有两处（中文版、英文版），只加一处另一边会显示成 key 本身',
)

/* ---- E. 切文献清空 ------------------------------------------------------ */
console.log('\n=== E. 切文献清空历史 ===')
check(
  '存在按 itemKey 清空历史的 effect',
  /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,300}hopStackRef\.current\s*=\s*\[\][\s\S]{0,200}\}\s*,\s*\[\s*itemKey\s*\]\s*\)/.test(code),
  '跨文献的历史位置没有意义：第 12 页在 A 篇是正文，在 B 篇可能是附录',
)

/* ---- F. 不用 scrollRef.current ---------------------------------------- */
console.log('\n=== F. 用 findScrollParent，不用 scrollRef.current ===')
/**
 * 这条是给未来的自己看的：本项目踩过一次 —— scrollRef 挂在 `.zr-page` 上，
 * 那个节点并不吃滚动，写它的 scrollTop 不产生任何效果，表现为「页码对了、
 * 视图没动」。源码里专门留着注释解释这件事，所以**必须在剥离注释后**判断，
 * 否则那条解释本身就会被当成违规。
 */
check(
  '压栈侧不含 scrollRef.current',
  !/scrollRef\.current/.test(pushBody),
  'scrollRef 挂在 .zr-page 上，它不是真正滚动的节点',
)
check(
  '弹栈/量测侧不含 scrollRef.current',
  !/scrollRef\.current/.test(popBody) && !/scrollRef\.current/.test(measureBody),
  '同一条坑：量 scrollRef.current 的 scrollTop 恒为 0',
)
check(
  '量测确实用了 findScrollParent',
  /findScrollParent\(/.test(measureBody),
  '真正吃滚动的是哪一层只能按几何判定',
)

/* ---- G. 诊断 ----------------------------------------------------------- */
console.log('\n=== G. 诊断日志 ===')
check('压栈有 history:push 日志', /event:\s*'history:push'/.test(pushBody))
check('弹栈有 history:pop 日志', /event:\s*'history:pop'/.test(popBody))
check(
  '日志带 page / offset / depth',
  /page:\s*pos\.pageNo/.test(pushBody) &&
    /offset:\s*Number\(pos\.offset\.toFixed\(4\)\)/.test(pushBody) &&
    /depth:\s*stack\.length/.test(pushBody) &&
    /page:\s*pageNo/.test(popBody) &&
    /depth:\s*stack\.length/.test(popBody),
  '下次现场要能只看日志就判断「压错位置」还是「没弹」',
)
check(
  '弹栈日志带 scrolled（恢复是否真的滚到位）',
  /scrolled[\s\S]{0,40}\}|\bscrolled\b/.test(popBody) && /scrolled,/.test(popBody),
  '「页码对了视图没动」在本项目里出现过，必须能从日志看出来',
)

/* ---- 汇总 -------------------------------------------------------------- */
console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败：跳转历史/返回功能不完整。`)
  process.exit(1)
}
console.log('✓ 全部通过：跳转时压栈、返回时消费式弹栈、栈空禁用、切文献清空、恢复不回流。')
