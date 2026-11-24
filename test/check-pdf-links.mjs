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
  /\{ kind: 'link', text: href \}/.test(src),
  '被省略的中段只有完整 URL 才看得见')
check('内部跳转显示成「第 N 页」而不是裸 #page=',
  /文档内跳转 · 第 \$\{pageMatch\[1\]\} 页/.test(src))
/**
 * 具名目标的卡片要能补出**页码**。
 *
 * 原来副行只印目标名（cite.andrews1997），用户看不出会跳到哪一页。
 * 现在异步解析 dest 拿页号后补写第二行；断言它确实把页号算出来了，
 * 而不是只显示名字。
 */
check('具名目标预览以位图为主体（canvas 渲染，不再是纯文字）',
  /const renderDestBitmap = async/.test(src) &&
    /page\.render\(\{ canvasContext: ctx/.test(src) &&
    /canvas = await renderDestBitmap\(dest, pageNo\)/.test(src),
  'figure/公式在文本层里只剩碎片，必须把目标区域画出来')
check('取不到位图时退回文字预览（不是空窗）',
  /canvas \? null : await extractDestPreview/.test(src) &&
    /else if \(preview\)/.test(src),
  '渲染失败时至少要给点东西')
check('异步补内容前确认仍是当前链接',
  /linkTipAnchor !== anchor/.test(src),
  '鼠标已移开还回写会让卡片在错误位置闪出来')
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
  (() => {
    // 只看 showLinkTip 函数体：它在 showLinkTip 里读一次，别处不该再读
    const at = src.indexOf('const showLinkTip')
    if (at < 0) return false
    const body = src.slice(at, at + 2600)
    const end = body.indexOf('\n            const onPdfLinkClick')
    const fn = end > 0 ? body.slice(0, end) : body
    return /anchor\.getBoundingClientRect\(\)/.test(fn) &&
      (fn.match(/getBoundingClientRect\(\)/g) || []).length === 1
  })(),
  '矩形应当读一次并缓存，不能每次移动都读')

/* ---------- 4b. 纵向落点：dest 坐标必须被消费 ---------- */

/**
 * 这一段是「跳转了但落点不对」的回归护栏。
 *
 * 症状：页号对（日志 page:14 scrolled:true），但视图停在页首 ——
 * 因为 scrollPageIntoView 的 offset 硬编码传了 0，dest 里的 y 被丢掉。
 *
 * 三条都必须成立：按 dest[1].name 分支取 y、做左下原点→页顶的比例翻转、
 * 且 offset 真的喂给了 scrollPageIntoView。
 */
check('按 dest[1].name 分支取纵向坐标',
  /kind === 'XYZ'/.test(src) && /'FitH'/.test(src) && /'FitR'/.test(src),
  'dest 的 y 位置随 /XYZ、/FitH、/FitR 而不同，不能只认一个下标')

check('XYZ 取 dest[3] 作为 top（dest[2] 是 left，不是 top）',
  /y = dest\[3\]/.test(src),
  'XYZ 的参数序是 [page, /XYZ, left, top, zoom]，取错下标会横向错位')

check('做了 PDF 左下原点 → 页顶比例的方向翻转',
  /\(height - clamped\) \/ height/.test(src),
  'dest 的 y 原点在左下，offset 从页顶起算，不翻转就会跳到镜像位置')

check('页高取 viewport（PDF 点），不用 DOM 像素',
  /getViewport\(\{ scale: 1 \}\)/ .test(src) && !/clientHeight[\s\S]{0,80}offset/.test(src.slice(src.indexOf('const destVOffset'), src.indexOf('const destVOffset') + 2600)),
  'clientHeight 是 CSS 像素、随缩放变，会把落点算飞')

check('offset 真的传进 scrollPageIntoView（不再硬编码 0）',
  /scrollPageIntoView\(host, pageNo, offset \?\? 0\)/.test(src),
  '原来写死 0，dest 的 y 白算了')

check('诊断里带上 destKind / destY / offset',
  /destKind: dest\?\.\[1\]\?\.name/.test(src) && /offset: offset \?\? 0/.test(src),
  '落点不对下次要能从日志直接看出是解析失败还是换算错')

/* ---------- 4c. 预览卡片：多行，不拼 innerHTML ---------- */

check('预览是多行卡片（不再单行省略）',
  /white-space:normal/.test(src) && /overflow-wrap:anywhere/.test(src) &&
    !/\.zr-link-tip\{[^}]*white-space:nowrap/.test(src),
  '单行 ellipsis 会把长文献信息截断')

check('卡片限宽放到 min(560px,86vw)',
  /\.zr-link-tip\{position:fixed;z-index:2147483000;max-width:min\(560px,86vw\)/.test(src))

check('行内容用 createElement + textContent（不拼 innerHTML）',
  /const renderTipLines = \(tip, lines\) =>/.test(src) &&
    /div\.textContent = String\(row\.text\)/.test(src) &&
    !/linkTip\.innerHTML|tip\.innerHTML/.test(src),
  'PDF 里的链接文字是外部输入，innerHTML 会变成注入面')

check('卡片有主行 / 正文行 / 链接行 / 次要行四种样式',
  /zr-tip-title/.test(src) && /zr-tip-line/.test(src) &&
    /zr-tip-link/.test(src) && /zr-tip-dim/.test(src))

/* ---------- 4d. 预览内容：从 PDF 文本层提取 ---------- */

/**
 * 用户要的是「那段文字本身」，不是 DOI 卡片。
 * 这条路线的好处是对 #fig8 / #eq1 / #cite.xxx 一视同仁 ——
 * 不管有没有 DOI，目标处的文字都在 PDF 文本层里。
 */
check('从文本层提取目标内容（getTextContent）',
  /page\.getTextContent\(\)/.test(src) && /const extractDestPreview = async/.test(src),
  '预览正文只能从 PDF 文本层来，不依赖 Zotero 库')

check('文本层按页缓存（不在每次 hover 都解析）',
  /textLinesCache\s*=\s*new Map\(\)/.test(src) && /\.get\(pageNo\)/.test(src) &&
    /textLinesCache\.set\(pageNo/.test(src),
  'getTextContent 跨 worker、一页几百 item，不缓存会把悬停拖慢')

check('换文档时清空文本层缓存',
  /textLinesCache\.clear\(\)/.test(src),
  '缓存键只有 pageNo、不含文档身份，不清会把上一篇的文字当新文档预览')

check('目标文字长度受限并加省略号',
  /linkPreviewChars/.test(src) && /\.\.\.\$|…`/.test(src),
  '卡片不能把整段正文铺出来')

check('分栏处理（双栏论文不串栏）',
  /packed\.width/.test(src) && /const mid = .* \/ 2/.test(src),
  '双栏论文按纯 y 取最近行会把相邻栏的字取进来')

check('按横向邻近度打分（不只看 y）',
  /const score = dy \+ dx \* 0\.5/.test(src),
  '同一栏内也可能在 destX 左侧另起一段，纯 y 最近会跳到隔壁段')

check('提取失败返回 null 而不是抛错',
  /const extractDestPreview = async \(dest, pageNo\) => \{[\s\S]{0,200}?try \{/.test(src) &&
    /catch \{ return null \}/.test(src),
  '扫描页没有文本层，但预览不该因此报错')

/* ---------- 4e. 跳转后落点闪烁 ---------- */

check('跳转成功后给落点加闪烁指示',
  /const flashJumpTarget = \(pageNo, offset, previewText\) =>/.test(src) &&
    /flashJumpTarget\(pageNo, offset \?\? 0, flashText\)/.test(src),
  '侧栏里页与页长得差不多，光滚过去用户找不到该看哪句')

check('闪烁约 1 秒后淡出',
  /const jumpFlashMs = 1000/.test(src) && /data-fade/.test(src) &&
    /transition:opacity/.test(src),
  '要的是短暂指示，不是常驻高亮')

check('闪烁用独立的 .zr-jump-flash（不复用 .zr-hl）',
  /\.zr-jump-flash\{/.test(src) &&
    /box\.className = 'zr-jump-flash'/.test(src),
  '复用它的话标注层重绘会把闪烁块当成常驻高亮重新画出来')

check('闪烁块能对齐到文本层里的目标行',
  /pageEl\.querySelectorAll\('\.textLayer span/.test(src),
  '用文本层 span 的矩形比反推 scale/rotation 可靠')

check('闪烁块与定时器都有清理',
  /const clearJumpFlash = \(\) =>/.test(src) &&
    /clearJumpFlash\(\)/.test(src) &&
    /jumpFlashTimer\) \{ clearTimeout\(jumpFlashTimer\)/.test(src),
  '不清的话切文档后残留方块，定时器还会去改已移除的节点')

/* ---------- 4f. 安全：全程不拼 innerHTML ---------- */

check('链接相关的提示/闪烁都不用 innerHTML',
  (() => {
    // 只扫链接相关这几段，别把标注层原有的 layer.innerHTML 误判进来
    const parts = ['const renderTipLines', 'const flashJumpTarget', 'const extractDestPreview',
      'const pageTextLines', 'const showLinkTip', 'const renderPageBitmap',
      'const renderDestBitmap', 'const putTipBitmap', 'const destRegionPts']
    for (const p of parts) {
      const at = src.indexOf(p)
      if (at < 0) continue
      const seg = src.slice(at, at + 3000)
      if (/\.innerHTML\s*=/.test(seg)) return false
    }
    return true
  })(),
  'PDF 里的文字是外部输入，innerHTML 就是注入面')

/* ---------- 4g. 位图预览：只渲染目标页、按页缓存 ---------- */

/**
 * 用户明确要求「只加载对应图片、公式的页面，其它的不加载」。
 * 这条断言盯的就是这个约束：渲染入口接收 pageNo，且没有邻页预取。
 */
check('位图渲染接收 pageNo（只渲染目标那一页）',
  /const renderPageBitmap = async \(pdfDocument, pageNo\) =>/.test(src) &&
    /pdfDocument\.getPage\(pageNo\)/.test(src),
  '整篇预渲染会拖垮打开速度，用户明确只要目标页')

check('没有邻页预取 / 整篇渲染',
  !/getPage\(\s*pageNo\s*\+\s*1\s*\)/.test(src) &&
    !/getPage\(\s*pageNo\s*-\s*1\s*\)/.test(src),
  '预取邻页违背「其它的不加载」')

check('页位图按 (pageNo) 缓存，重复悬停不重渲染',
  /const pageBitmapCache = new Map\(\)/.test(src) &&
    /const cached = pageBitmapCache\.get\(pageNo\)/.test(src) &&
    /pageBitmapCache\.set\(pageNo, result\)/.test(src),
  '同一页的多个链接应复用同一张位图')

check('同页并发渲染去重（pdf.js 禁止同 canvas 双 render）',
  /const pageBitmapPending = new Map\(\)/.test(src) &&
    /const pending = pageBitmapPending\.get\(pageNo\)/.test(src),
  '鼠标扫过同页多个链接时，第二次会赶在第一次完成前进来，直接撞 render 会抛错')

check('换文档时清空页位图缓存',
  /pageBitmapCache\.clear\(\)/.test(src),
  'canvas 缓存很重（一张几 MB），且会串文档')

check('渲染比例考虑 devicePixelRatio 但夹到 2 以内',
  /devicePixelRatio/.test(src) && /Math\.min\(2, Math\.max\(1, window\.devicePixelRatio\)\)/.test(src),
  '不夹上限在高分屏上像素量爆炸')

check('位图纵向裁切做了左下原点翻转',
  /\(heightPt - region\.y - region\.h\) \* scale/.test(src),
  'PDF 原点在左下，canvas 从顶部量，不翻转会裁到页面的镜像位置')

/* ---------- 4h. 浮窗：可滚动 + 0.5s 延迟消失 ---------- */

check('浮窗位图区可滚动',
  /\.zr-link-tip \.zr-tip-shot\{display:block[^}]*overflow:auto/.test(src),
  '用户要求「可以自由滑动」')

check('浮窗接收鼠标事件（pointer-events:auto）',
  /\.zr-link-tip\{[^}]*pointer-events:auto/.test(src) &&
    !/\.zr-link-tip\{[^}]*pointer-events:none/.test(src),
  '浮窗要能滚动、要能触发 mouseenter，就必须接收事件')

check('0.5s 延迟消失（既不在链接也不在浮窗上才隐藏）',
  /const cancelHideTip = \(\) =>/.test(src) &&
    /const scheduleHideTip = \(\) =>/.test(src) &&
    /setTimeout\(\(\) => \{[\s\S]{0,120}?hideLinkTip\(\)[\s\S]{0,20}?\}, 500\)/.test(src),
  '立即隐藏的话鼠标够不到浮窗，没法滚动')

check('链接与浮窗共用同一套取消/重排',
  /linkTip\.addEventListener\('mouseenter', \(\) => \{ cancelHideTip\(\) \}\)/.test(src) &&
    /linkTip\.addEventListener\('mouseleave', \(\) => \{ scheduleHideTip\(\) \}\)/.test(src) &&
    /scheduleHideTip\(\)/.test(src.slice(src.indexOf('const onPdfLinkOut'), src.indexOf('const onPdfLinkOut') + 900)),
  '两处各自为政就会出现「移进浮窗就消失」')

check('mouseover 会取消挂起的消失',
  /cancelHideTip\(\)[\s\S]{0,80}?if \(anchor === linkTipAnchor\) return/.test(src),
  '回到链接上应当留住浮窗')

check('延迟消失定时器有清理',
  /if \(linkHideTimer\) clearTimeout\(linkHideTimer\)/.test(src) &&
    /linkHideTimer = 0/.test(src),
  '不清的话切文档后还会去操作已移除的节点')

check('位图槽位有加载占位（避免先塌后跳）',
  /data-loading/.test(src) && /zr-tip-shot\[data-loading="1"\]/.test(src))


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
