/**
 * 恢复阅读位置必须真的滚动，不能只改页码。
 *
 * 锁住的 bug：加载完成后 `applyResume` 只设 `viewer.currentPageNumber`，
 * 而 pdf.js 的 setter 在侧栏里滚不动（容器 overflow:hidden、scrollHeight
 * 等于 clientHeight，滚动链落在不滚的节点上）。结果：
 *
 *   页码显示 4，视图停在第 1 页。
 *
 * 更隐蔽的是旧判据只比较 `viewer.currentPageNumber === resumePage`，
 * 这种情况还会打出 ok:true，把问题藏起来（实测日志 want:4 got:4 ok:true，
 * 但用户看到的就是没跳）。
 *
 * 约束：
 *   · 存在统一的 scrollPageIntoView()，按几何找真正可滚的祖先；
 *   · gotoPage 与 applyResume 共用它，不能各写一份；
 *   · applyResume 的 ok 判据必须包含「视图是否真的滚到位」；
 *   · 不许再直接写 scrollRef.current.scrollTop（那不是滚动容器）。
 *
 * 跑法：node test/check-resume-scroll.mjs
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failed = 0
function check(label, ok) {
  if (ok) console.log(`OK   ${label}`)
  else { console.log(`FAIL ${label}`); failed += 1 }
}

/* ---------- 1. 统一滚动函数存在且按几何判定 ---------- */
check('存在 scrollPageIntoView()', /function scrollPageIntoView\(/.test(src))
/**
 * 断言一律锚在**函数体**上，不能从函数签名往前/往后按字数乱切 ——
 * 上方注释里同样出现 `scrollIntoView`、`scrollTop` 等字样，按字数窗口会把
 * 注释误当成实现（这里踩过：注释中的「先 scrollIntoView」让断言假通过/假失败）。
 */
const fnStart = src.indexOf('function scrollPageIntoView(')
/**
 * 边界按**结构**取，不按字符数。
 *
 * 原来写 `slice(fnStart, fnStart + 1400)`，后来函数里加了一段解释
 * target 夹取的注释，`scroller.scrollTop =` 就被挤出窗口，
 * 「先 scrollIntoView 再精调」这条断言随即假失败（代码其实是对的）。
 * 这类固定窗口的坑已经踩过多次，统一改成取到下一个函数声明为止。
 */
const fnBody = (() => {
  if (fnStart <= 0) return ''
  const tail = src.slice(fnStart)
  const next = tail.indexOf('\n    function ', 10)
  return next > 0 ? tail.slice(0, next) : tail.slice(0, 6000)
})()
check('函数体已定位（负向断言的前提）', fnBody.length > 300)
check('函数体边界完整（含末尾的 return 判据）',
  fnBody.includes('Math.abs(scroller.scrollTop - target)'),
  '切片不完整时下面的位置类断言会集体误报')
check('它用 findScrollParent 找真正的滚动祖先', /findScrollParent\(pageEl\)/.test(fnBody))
check('它先 scrollIntoView 再精调',
  (() => {
    const a = fnBody.indexOf('pageEl.scrollIntoView(')
    const b = fnBody.indexOf('scroller.scrollTop =')
    return a > 0 && b > 0 && a < b
  })())
check('它按视口矩形差值定位（不用 offsetTop 相减）',
  /getBoundingClientRect\(\)\.top - scroller\.getBoundingClientRect\(\)\.top/.test(fnBody))

/* ---------- 2. applyResume 必须走滚动 ---------- */
const resumeStart = src.indexOf('const applyResume = (attempt) =>')
check('找得到 applyResume', resumeStart > 0)
/**
 * 区块边界不能按固定字符数取。
 *
 * 这里原来写 `slice(start, start + 2400)`，而 applyResume 内的注释后来
 * 因为解释闪烁问题变长了，`scrolled,` 就被挤到窗口之外 ——
 * 断言随即假失败（代码其实是对的）。
 * 改成取到「下一个顶层 setTimeout 挂载点」为止，跟着结构走而不是跟着字数走。
 */
const resumeBlock = (() => {
  if (resumeStart <= 0) return ''
  const tail = src.slice(resumeStart)
  // applyResume 之后紧跟 `setTimeout(() => applyResume(0), 120)`，以此为终点
  const endMarker = tail.indexOf('setTimeout(() => applyResume(0)')
  return endMarker > 0 ? tail.slice(0, endMarker + 60) : tail.slice(0, 6000)
})()
check('applyResume 区块已定位（负向断言的前提）', resumeBlock.length > 500)
check('applyResume 调用了 scrollPageIntoView',
  resumeBlock.length > 500 && /scrollPageIntoView\(/.test(resumeBlock))
check('ok 判据包含滚动结果（不再只看 currentPageNumber）',
  resumeBlock.length > 500 && /const ok = .*scrolled/.test(resumeBlock))
check('日志里带 scrolled 字段，便于现场判断',
  resumeBlock.length > 500 && /scrolled,/.test(resumeBlock))

/* ---------- 3. 两条路径共用同一实现 ---------- */
const gotoStart = src.indexOf('const scrollToPage = () =>')
check('找得到 gotoPage 的 scrollToPage', gotoStart > 0)
const gotoLine = gotoStart > 0 ? src.slice(gotoStart, gotoStart + 120).split('\n')[0] : ''
check('gotoPage 复用 scrollPageIntoView，没有第二份内联实现',
  /=>\s*scrollPageIntoView\(/.test(gotoLine))
check('文件里只有一处 scrollIntoView 调用（说明没有重复实现）',
  (src.match(/\.scrollIntoView\(/g) ?? []).length === 1)

/* ---------- 4. 不再直接写非滚动容器的 scrollTop ---------- */
check('旧的 applyScrollOffset 已移除',
  !/function applyScrollOffset\(/.test(src))
check('不再对 scrollRef.current 直接写 scrollTop',
  !/scrollRef\.current\.scrollTop\s*=/.test(src))

/* ---------- 5. 既有能力不受影响 ---------- */
check('仍读取保存的阅读位置',
  /readSavedPos\(itemKey, pdf\.doc\.numPages\)/.test(src))
check('仍保留页内偏移（两页之间不跳回页首）',
  /const resumeOffset = savedPos\?\.offset \?\? 0/.test(src))
check('恢复失败仍会重试', /setTimeout\(\(\) => applyResume\(attempt \+ 1\), 120\)/.test(src))

console.log(failed === 0 ? '\n===== 全部通过 =====' : `\n===== ${failed} 项失败 =====`)
process.exit(failed === 0 ? 0 : 1)
