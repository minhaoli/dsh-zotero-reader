#!/usr/bin/env node
/**
 * PDF 内链接：点击跳转 + 悬停预览。
 *
 * 两个原始症状：
 *   ① 点链接没反应
 *   ② 希望光标悬停时能看到对应地址
 *
 * 症状①的机制（看 PDFLinkService.addLinkAttributes）：
 *   pdf.js 把链接渲染成 <a href="https://..." target="">，
 *   target 取自 externalLinkTarget，我们没传、默认 NONE → 空 target。
 *   空 target = 当前窗口导航，而页面基址是 dsh-app://app/ ——
 *   Electron 会把跨 scheme 导航拦掉，于是点了毫无反应、连错误都没有。
 *
 *   内部链接（指向本文档某页）是 <a href="#page=N">，依赖 pdf.js 自己那条
 *   滚动画布容器的链路，而那条链在侧栏里本来就是断的。
 *   所以两类都得我们自己接。
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

/* ---------- 1. 点击处理存在且用 capture ---------- */

const clickIdx = src.indexOf('const onPdfLinkClick')
check('有点击处理器', clickIdx > 0)

/**
 * 区块边界按结构取，不按字符数。
 *
 * 原来写 `slice(clickIdx, clickIdx + 2200)`，后来在外部链接那段里补了
 * 宿主 setWindowOpenHandler 的规则说明（十几行注释），`window.open`
 * 就被挤出了窗口，两条断言随即假失败 —— 代码其实是对的。
 * 这个项目里固定窗口导致的假失败已经出现多次，统一改成取到下一个
 * 顶层 const 声明为止。
 */
const block = (() => {
  if (clickIdx <= 0) return ''
  const tail = src.slice(clickIdx)
  const nextDecl = tail.indexOf('\n            let linkTip', 10)
  return nextDecl > 0 ? tail.slice(0, nextDecl) : tail.slice(0, 6000)
})()
check('处理器区块已定位（负向断言的前提）', block.length > 600)
check('区块完整（含末尾的外部链接分支）',
  block.includes('window.open'),
  '切片不完整时下面的断言会集体误报')

const addIdx = src.indexOf("host.addEventListener('click', onPdfLinkClick")
check('监听在 host 上注册', addIdx > 0)
check('用 capture 阶段（先于 pdf.js 挂在 <a> 上的 handler）',
  /host\.addEventListener\('click', onPdfLinkClick, true\)/.test(src),
  'bubble 阶段才接管的话，pdf.js 的 onclick 已经先跑过（它会让当前窗口导航）')

/* ---------- 2. 外部链接：禁止当前窗口导航 ---------- */

/**
 * 位置类断言一律在**剥离注释后**的文本上做。
 *
 * 外部链接那段里有一段说明宿主 setWindowOpenHandler 规则的注释，
 * 其中含有 "https:" 等字样；直接对原文做距离/存在性判断会把注释
 * 当成代码。剥掉注释后 preventDefault 与 window.open 的距离才是真实的。
 */
const stripCommentsEarly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const k = line.indexOf('//')
      return k >= 0 ? line.slice(0, k) : line
    })
    .join('\n')

const blockCodeEarly = stripCommentsEarly(block)

check('外部链接会 preventDefault',
  (() => {
    const a = blockCodeEarly.indexOf('preventDefault()')
    const b = blockCodeEarly.indexOf('window.open')
    return a > 0 && b > a
  })(),
  '不拦的话 Electron 会尝试在 dsh-app:// 页面里导航到 https，结果是静默失败')

check('外部链接用 _blank 交给宿主转交系统浏览器',
  /window\.open\(href, '_blank'/.test(blockCodeEarly))

/**
 * 这条断言原来叫「新窗口带 noopener（不泄漏 window.opener）」，测的是
 * `window.open(href, '_blank', 'noopener,noreferrer')`。
 *
 * 那个写法本身就是 bug：按 HTML 规范，features 里带 noopener / noreferrer 时
 * window.open **必须返回 null**，于是 `blocked: !opened` 恒为真 ——
 * 日志看着像「宿主每次都拦」，实际一次都没拦，判据完全失效。
 *
 * 所以检查的实质要反过来：**不能**带这两个 feature，并且 blocked 必须来自真实返回值。
 * 安全性由宿主的 setWindowOpenHandler（一律 deny）保证，不靠这个参数。
 */
check('window.open 不带 noopener/noreferrer（否则返回值恒为 null，blocked 变假信号）',
  /window\.open\(href, '_blank'\)/.test(blockCodeEarly) &&
    !/window\.open\([^)]*'[^']*noopener/.test(blockCodeEarly),
  'noopener/noreferrer 会让 window.open 按规范返回 null，blocked: !opened 永远是 true')

check('blocked 取自真实返回值（window.open 结果为 null 才算被拦）',
  /const blocked = !opened/.test(blockCodeEarly) &&
    /reportDiag\(\{ event: 'link:open'[^}]*blocked \}\)/.test(blockCodeEarly) ||
    /blocked(?::\s*blocked|\s*\})/.test(blockCodeEarly),
  'blocked 若恒为真，日志就无法区分「宿主拦了」和「其实打开了」')

check('被宿主拒绝时给出可见反馈（不再静默）',
  /if \(blocked\)[\s\S]{0,800}?showLinkTip\(/.test(blockCodeEarly),
  'http/mailto/tel 必然被宿主 deny，静默拒绝的观感与「点了没反应」相同')

check('识别 http(s)/mailto/tel 等外层协议',
  /\(\?:\^\?\)|https\?|mailto|tel/.test(block) || /mailto\|tel/i.test(block))

/* ---------- 3. 内部链接：走自己的滚动 ---------- */

check('内部链接解析 #page=N', /#page=\(\\d\+\)/.test(block) || /#page=/.test(block))

check('内部跳转调用 scrollPageIntoView（不依赖 pdf.js 那条断掉的链）',
  /scrollPageIntoView\(host, n, 0\)/.test(block),
  'pdf.js 自己的滚动链在侧栏里是断的，本项目为此专门实现了 scrollPageIntoView')

/**
 * 具名目标（LaTeX 的 #eq1 / #cite.xxx）。
 *
 * 原来这一支是 `linkService.navigateTo(href.slice(1))` 包在空 catch 里 ——
 * 而这个版本的 pdf_viewer.mjs **没有 navigateTo 这个方法**（全文 0 处引用），
 * 于是每次点击都抛 TypeError 被吞掉：日志只有 link:click，画面纹丝不动。
 *
 * 断言因此分两条：必须自己解析 dest；且不得再出现 navigateTo。
 */
check('具名目标自己解析（getDestination + getPageIndex）',
  /jumpToNamedDest/.test(block) &&
    /getDestination\(/.test(src) &&
    /getPageIndex\(/.test(src),
  'navigateTo 在此版本不存在，只能自己解析 /Dests')

check('不再调用不存在的 linkService.navigateTo',
  !/linkService\.navigateTo/.test(stripCommentsEarly(src)),
  'navigateTo 在 pdf_viewer.mjs 中不存在，调用必抛 TypeError 并被空 catch 吞掉')

check('具名目标失败会留痕（不再空 catch）',
  /link:dest-fail/.test(src),
  '空 catch 让「点了没反应」在日志里完全隐形')

check('具名目标跳转后同步页码显示',
  /viewer\.currentPageNumber = pageNo/.test(src) &&
    /setVisiblePage\(pageNo\)/.test(src) &&
    /setJumpPage\(pageNo\)/.test(src),
  '只滚动不改页码会让工具条停留在旧页')

/* ---------- 4. 悬停预览 ---------- */

const overIdx = src.indexOf('const onPdfLinkOver')
check('有悬停处理器', overIdx > 0)
check('悬停显示完整 href',
  /const label = pageMatch[\s\S]{0,200}?: href/.test(src),
  '被省略的中段只有完整 URL 才看得见')
check('内部跳转显示成「第 N 页」而不是裸 #page=',
  /文档内跳转 · 第 \$\{pageMatch\[1\]\} 页/.test(src))
check('监听 mouseover / mouseout 并清理',
  /addEventListener\('mouseover', onPdfLinkOver\)/.test(src) &&
    /addEventListener\('mouseout', onPdfLinkOut\)/.test(src))

/**
 * 悬停处理器区块：切到下一个顶层声明为止（同点击区块的做法）。
 *
 * pdf.js 自己给链接挂了 `title = overlaidText`（链接覆盖的那段正文），
 * 浏览器据此弹原生提示框；不删掉就会和我们的地址框同时出现 ——
 * 用户看到的就是「悬停弹出两个框，一个是文档内跳转，一个是光标所在文字」。
 * 原生提示约 500ms 后才弹，在 mouseover 这一拍删除来得及。
 */
const overBlock = (() => {
  const tail = src.slice(overIdx)
  const next = tail.indexOf('\n            const onPdfLinkOut', 10)
  return next > 0 ? tail.slice(0, next) : tail.slice(0, 3000)
})()
check('悬停区块已定位（负向断言的前提）', overBlock.length > 200)
check('悬停时删掉 pdf.js 挂的 title（否则原生提示框重叠）',
  /removeAttribute\('title'\)/.test(overBlock),
  'annotation_layer 里 link.title = overlaidText，会出现第二个框显示原文文字')

check('提示用 position:fixed（宿主 overflow:hidden 会裁掉 absolute）',
  /\.zr-link-tip\{position:fixed/.test(src),
  '.zr-pdfviewer-host 是 overflow:hidden，absolute 贴边会被裁剪')

check('提示挂在 body 上（脱离被裁剪的容器）',
  /document\.body\.appendChild\(linkTip\)/.test(src))

check('提示有上下翻转（贴近视口顶部时放下方）',
  /if \(top < 8\) top = r\.bottom \+ 8/.test(src))

check('提示左右夹在视口内', /Math\.min\(r\.left, window\.innerWidth - tipW - 8\)/.test(src))

/**
 * 悬停必须是**延时 + 去重**的。
 *
 * 性能日志：`HTMLAnchorElement.patchedGBCR <- onPdfLinkOver` 18 次累计 4751ms，
 * 单次最高 447ms —— 每次 mouseover 都立刻 getBoundingClientRect 强制布局，
 * 而 mouseover 会从 <a> 的子元素反复冒泡上来，扫过一行字就是一串调用。
 *
 * 修法三条都要在：延时、同锚点去重、矩形只读一次。
 */
check('悬停延时触发（快速扫过不算矩形）',
  /HOVER_TIP_DELAY = 150/.test(src) &&
    /linkTipTimer = setTimeout\(/.test(src),
  '不延时的话每次 mouseover 都会强制布局')

check('mouseout 清掉延时', /clearTimeout\(linkTipTimer\)/.test(src))

check('同一条链接内部冒泡不重复计算',
  /anchor === linkTipAnchor/.test(src),
  'mouseover 从 <a> 的子元素冒泡上来，不去重就会反复重排延时')

check('getBoundingClientRect 只在一处读（不在 mousemove 里反复读）',
  (src.match(/getBoundingClientRect\(\)/g) || []).length >= 1 &&
    /showLinkTip[\s\S]{0,900}?anchor\.getBoundingClientRect\(\)/.test(src),
  '矩形应当读一次并缓存，不能每次移动都读')


/* ---------- 5. 监听必须清理（否则累积） ---------- */

check('有清理函数', /const disposeLinkHandlers = \(\) =>/.test(src))

check('cleanup 里调用清理',
  /disposeLinkHandlersRef\.current\?\.\(\)/.test(src),
  'host 会被下一次加载复用（只清子节点），监听不清就累积：切三篇后一次点击触发三遍')

check('清理时移除提示节点', /linkTip\?\.remove\(\)/.test(src))

/* ---------- 6. 不误伤其它点击 ---------- */

check('只在命中带 href 的 a 时接管',
  /closest\?\.\('a\[href\]'\)/.test(block),
  '不限定 a[href] 会把批注色块、工具条的点击也吃掉')

/**
 * 断言必须**先剥离注释**再判断。
 *
 * 处理器上方那段说明里就写着「其余协议（如 zotero://）交给全局拦截器」，
 * 直接对原文测会让这条断言永远失败 —— 注释里的字样不是代码。
 * （这个坑在本项目里反复出现过，凡是位置/存在性断言都先剥注释。）
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const k = line.indexOf('//')
      return k >= 0 ? line.slice(0, k) : line
    })
    .join('\n')

const blockCode = stripComments(block)

check('不处理 zotero:// （交给全局拦截器）',
  !/zotero:\/\//.test(blockCode),
  'zotero:// 由 installLinkInterceptor 处理，两处都接管会互相打架')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
