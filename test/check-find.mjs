/**
 * 「当前文档查找」（Ctrl+F / 工具条放大镜）的静态护栏。
 *
 * 这些断言不渲染 UI，只从 client.js 的源码里核对**结构**与**硬约束**：
 *   1. 工具条上确实有一个搜索按钮（用户明确要求「不能只有 Ctrl+F」），且带选中态与 a11y 属性；
 *   2. 查找条两行结构：输入框 / 计数 / 上一个 / 下一个 / 关闭 + 三个复选框；
 *   3. i18n 键在 zh 与 en 里成对（缺一个就会把键名当文案显示）；
 *   4. 键位：Ctrl+F、F3、Enter / Shift+Enter、Esc，且可见性判据走 getClientRects；
 *   5. 高亮走独立覆盖层，**匹配一变就重画所有已渲染页**（不能只靠 pagerendered），
 *      关掉「高亮所有」时只画当前命中；
 *   6. 大小写与整词：索引保留原始大小写、正则只编译一次、整词边界用 ASCII 词字符类；
 *   7. 文本来自 getTextContent、有缓存、换文档会清空并作废在飞的提取；
 *   8. **硬守卫**：不引入原生 Selection 写入 API（addRange / selectAllChildren /
 *      execCommand）。用户报过「首次打开整篇文字被全选」，而原生选区还会和划词翻译抢。
 *
 * 跑法：node test/check-find.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSrc = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}${detail ? '  — ' + detail : ''}`)
}

/* 只取「当前文档查找」这一段，避免别处的 .textLayer / textContent 干扰判断 */
const findStart = clientSrc.indexOf('/* ---------- 当前文档查找（Ctrl+F / 工具条放大镜） ---------- */')
const findEnd = clientSrc.indexOf('/* ---------- 滚动性能探针 ---------- */')
const findBlock = findStart >= 0 && findEnd > findStart ? clientSrc.slice(findStart, findEnd) : ''
check('能定位到查找实现块', findBlock.length > 2000, `len=${findBlock.length}`)

/* 断言「代码里没有某调用」时必须先剥注释：实现中恰恰用注释解释了为什么不这么做 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const findCode = stripComments(findBlock)

/* 子函数切片：按声明定位，避免整段里的同名 token 干扰 */
const sliceBetween = (src, from, to) => {
  const a = src.indexOf(from)
  if (a < 0) return ''
  const b = to ? src.indexOf(to, a + from.length) : -1
  return b > a ? src.slice(a, b) : src.slice(a)
}
const buildPageIndexSrc = sliceBetween(findBlock, 'const buildPageIndex = (content, vp) => {', 'const matchPage = (pageNo, rec, re) =>')
const matchPageSrc = sliceBetween(findBlock, 'const matchPage = (pageNo, rec, re) =>', 'const collectMatches = useCallback')
const paintFindPageSrc = sliceBetween(findBlock, 'const paintFindPage = useCallback', 'const paintFindAll = useCallback')
const paintFindAllSrc = sliceBetween(findBlock, 'const paintFindAll = useCallback', 'paintFindRef.current = paintFindPage')
const applySearchSrc = sliceBetween(findBlock, 'const applyFindSearch = useCallback', 'const goFind = useCallback')

const zhAt = clientSrc.indexOf('const zh = {')
const enAt = clientSrc.indexOf('const en = {')
const zhSrc = zhAt >= 0 ? clientSrc.slice(zhAt, enAt > zhAt ? enAt : zhAt + 20000) : ''
const enSrc = enAt >= 0 ? clientSrc.slice(enAt, enAt + 20000) : ''

/* ---------------- 1. 工具条按钮 ---------------- */
const btnAt = clientSrc.indexOf("'🔍'")
const searchBtn = btnAt >= 0 ? clientSrc.slice(Math.max(0, btnAt - 900), btnAt + 20) : ''
check('工具条有搜索按钮（🔍）', btnAt > 0)
check('按钮在批注按钮 ✎ 之后', btnAt > clientSrc.indexOf('✎${annotationCount'))
check('按钮有选中态 data-on', /'data-on': findOpen \? '1' : '0'/.test(searchBtn))
check('按钮有 aria-pressed', /'aria-pressed': findOpen \? 'true' : 'false'/.test(searchBtn))
check('按钮有 aria-label + title（i18n）', (searchBtn.match(/'aria-label': t\('findInDoc'\)/g) || []).length === 1
  && /title: t\('findInDoc'\)/.test(searchBtn))
check('按钮在文档就绪前禁用', /disabled: status !== 'ready'/.test(searchBtn))
check('按钮点击可开可关（共享同一状态）', /onClick: \(\) => \(findOpen \? closeFind\(\) : openFind\(\)\)/.test(searchBtn))

/* ---------------- 2. 查找条两行结构 ---------------- */
check('有查找条容器 .zr-findbar', /className: 'zr-findbar'/.test(clientSrc))
check('第一行有 .zr-find-row', /className: 'zr-find-row'/.test(clientSrc))
check('第二行有 .zr-find-checks', /className: 'zr-find-checks'/.test(clientSrc))
check('输入框绑定 findQuery / findInputRef', /ref: findInputRef,\s*\n\s*value: findQuery/.test(clientSrc))
check('输入框有 placeholder i18n', /placeholder: t\('findPlaceholder'\)/.test(clientSrc))
check('Ctrl+F 提示在 title 里，不挤 placeholder', /title: t\('findInDoc'\)/.test(clientSrc)
  && !/findPlaceholder: '[^']*Ctrl\+F/.test(zhSrc))
check('计数区是 .zr-find-count 且 aria-live',
  /className: 'zr-find-count'/.test(clientSrc) && /'aria-live': 'polite'/.test(clientSrc))
check('有上一个按钮（findPrev / ∧）', /title: t\('findPrev'\)/.test(clientSrc) && /goFind\(-1\)/.test(clientSrc))
check('有下一个按钮（findNext / ∨）', /title: t\('findNext'\)/.test(clientSrc) && /goFind\(1\)/.test(clientSrc))
check('有关闭按钮（findClose）', /title: t\('findClose'\)/.test(clientSrc) && /onClick: closeFind/.test(clientSrc))
check('无命中时上下按钮禁用', /disabled: findMatches\.length === 0/.test(clientSrc))

/* ---------------- 3. 三个开关：state + DOM + i18n ---------------- */
check('state: findHighlightAll 默认开', /const \[findHighlightAll, setFindHighlightAll\] = useState\(true\)/.test(clientSrc))
check('state: findCase 默认关', /const \[findCase, setFindCase\] = useState\(false\)/.test(clientSrc))
check('state: findWhole 默认关', /const \[findWhole, setFindWhole\] = useState\(false\)/.test(clientSrc))
check('三个开关是 checkbox 形态（不是按钮选中态）',
  /type: 'checkbox'/.test(clientSrc) && /className: 'zr-find-check'/.test(clientSrc))
check('每个复选框都接了 state 与 setter',
  /\[t\('findHighlightAll'\), findHighlightAll, setFindHighlightAll\]/.test(clientSrc)
  && /\[t\('findCase'\), findCase, setFindCase\]/.test(clientSrc)
  && /\[t\('findWholeWord'\), findWhole, setFindWhole\]/.test(clientSrc))
check('复选框有 aria-label', /'aria-label': text/.test(clientSrc))

const I18N_KEYS = ['findInDoc', 'findPlaceholder', 'findPrev', 'findNext',
  'findClose', 'findHighlightAll', 'findCase', 'findWholeWord',
  'findCount', 'findCountEmpty', 'findScanning']
for (const key of I18N_KEYS) {
  check(`zh 有 ${key}`, new RegExp(`\\n\\s*${key}: '`).test(zhSrc))
  check(`en 有 ${key}`, new RegExp(`\\n\\s*${key}: '`).test(enSrc))
}
check('zh 计数文案是「第 n 个 / 共 m 个」',
  /findCount: '第 \{\{current\}\} 个 \/ 共 \{\{total\}\} 个'/.test(zhSrc))
check('en 计数文案带 current/total', /findCount: '\{\{current\}\} of \{\{total\}\}'/.test(enSrc))
check('无命中文案明确写 0/0', /findCountEmpty: '0\/0/.test(zhSrc) && /findCountEmpty: '0\/0/.test(enSrc))
check('整词的中文文案是「整词」', /findWholeWord: '整词'/.test(zhSrc))
check('placeholder 是「在文件中查找」', /findPlaceholder: '在文件中查找'/.test(zhSrc))

/* ---------------- 4. 键位与可见性 ---------------- */
check('Ctrl/Cmd+F 打开', /event\.ctrlKey \|\| event\.metaKey/.test(findBlock)
  && /key\.toLowerCase\(\) === 'f'/.test(findBlock))
check('F3 下一个 / Shift+F3 上一个', /key === 'F3'/.test(findBlock)
  && /goFind\(event\.shiftKey \? -1 : 1\)/.test(findBlock))
check('输入框 Enter 与 Shift+Enter', /e\.key === 'Enter'/.test(clientSrc)
  && /goFind\(e\.shiftKey \? -1 : 1\)/.test(clientSrc))
check('Esc 关闭查找条', /key === 'Escape' && findOpenRef\.current/.test(findBlock))
check('Esc 让批注面板先关（避免一次按键关两层）',
  /if \(annotPanel \|\| annotMenu\) return/.test(findBlock))
check('可见性用 getClientRects，而不是 active',
  /host && host\.getClientRects\(\)\.length > 0/.test(findCode)
  && !/\bactive\b/.test(findCode))
check('键位监听挂在 document 捕获阶段',
  /document\.addEventListener\('keydown', onKeyDown, true\)/.test(findBlock))

/* ---------------- 5. 高亮：覆盖层 + 主动重画 + 全部/当前 ---------------- */
check('CSS 有 .zr-find-layer（压在页面内容之上）',
  /\.zr-find-layer\{position:absolute;inset:0;pointer-events:none;z-index:5\}/.test(clientSrc))
check('CSS 有 .zr-find-hit 与当前命中色', /\.zr-find-hit\[data-current="1"\]/.test(clientSrc))
check('命中块不用 mix-blend-mode（深色主题下会看不见）',
  /\.zr-find-hit\{[^}]*\}/.test(clientSrc) && !/\.zr-find-hit\{[^}]*mix-blend-mode/.test(clientSrc))
check('按矩形画 div（不是 Selection）', /document\.createElement\('div'\)/.test(paintFindPageSrc)
  && /className = 'zr-find-layer'/.test(paintFindPageSrc))
check('当前命中打 data-current', /box\.dataset\.current = '1'/.test(paintFindPageSrc))
check('pagerendered 补画（紧跟 decoratePage / paintSelect）',
  /paintSelectRef\.current\?\.\(annotSelectedRef\.current\)[\s\S]{0,200}paintFindRef\.current\?\.\(pageNo\)/.test(clientSrc))
check('缩放的尽早 return 分支里也要补画（否则重画后高亮永久消失）',
  /zoomAtRef\.current < 240\) \{[\s\S]{0,700}paintFindRef\.current\?\.\(pageNo\)/.test(clientSrc))
check('paintFindRef 有占位与赋值', /const paintFindRef = useRef\(null\)/.test(clientSrc)
  && /paintFindRef\.current = paintFindPage/.test(clientSrc))
check('关闭时清掉全部高亮层', /querySelectorAll\('\.zr-find-layer'\)/.test(findBlock))

check('有 paintFindAll：遍历所有已渲染页', /const paintFindAll = useCallback/.test(findBlock)
  && /querySelectorAll\('\.page\[data-page-number\]'\)/.test(paintFindAllSrc))
check('paintFindAll 逐页调用 paintFindPage', /paintFindPage\(n\)/.test(paintFindAllSrc))
check('匹配变化后主动重画（不再只靠 pagerendered）',
  /paintFindAll\(\)/.test(applySearchSrc))
check('重画会清掉不再有命中的页（先清后画）',
  /layer\.textContent = ''/.test(paintFindPageSrc))
check('关闭「高亮所有」时只画当前命中',
  /const showAll = findHighlightAllRef\.current !== false/.test(paintFindPageSrc)
  && /if \(!showAll && !isCurrent\) continue/.test(paintFindPageSrc))
check('比例 k 有多层兜底（canvas → currentScale → viewport → clientWidth）',
  /canvas\.clientWidth \/ baseW/.test(paintFindPageSrc)
  && /currentScale/.test(paintFindPageSrc)
  && /getPageView\?\.\(pageNo - 1\)\?\.viewport/.test(paintFindPageSrc)
  && /pageEl\.clientWidth/.test(paintFindPageSrc))
check('页索引里存了 baseW（不依赖 pageSizesRef 预取）', /baseW: Number\(vp\.width\) \|\| 0/.test(buildPageIndexSrc))

/* ---------------- 6. 大小写 / 整词 ---------------- */
check('buildPageIndex 不再 toLowerCase（反向断言，守住原始大小写）',
  !/toLowerCase/.test(stripComments(buildPageIndexSrc)))
check('整词边界用 ASCII 词字符类', /\(\?<!\[A-Za-z0-9_\]\)/.test(findCode)
  && /\(\?!\[A-Za-z0-9_\]\)/.test(findCode))
check('整词边界没用 \\p{L} / \\p{N}（中文必须退化为子串匹配）',
  !/\\p\{L\}/.test(findCode) && !/\\p\{N\}/.test(findCode))
check('正则带 i 标志但不区分时，区分时不带（由 caseSensitive 决定）',
  /new RegExp\(pattern, caseSensitive \? 'g' : 'gi'\)/.test(findCode))
check('查询词先空白折叠再转义', /normalizeFindQuery/.test(findCode)
  && /escapeFindRegExp/.test(findCode))
check('正则每轮搜索只编译一次', /const re = buildFindRegExp\(/.test(applySearchSrc)
  && !/new RegExp/.test(matchPageSrc))
check('matchPage 用 exec 拿 match.index（不是 indexOf）',
  /re\.exec\(rec\.norm\)/.test(matchPageSrc) && !/indexOf\(q/.test(matchPageSrc))
check('推进量用 match[0].length（零宽命中兜底）',
  /m\[0\]\.length === 0/.test(matchPageSrc))

/* ---------------- 7. 开关切换后的重算路径 ---------------- */
check('大小写/整词切换后立刻重算', /\}, \[findCase, findWhole, applyFindSearch\]\)/.test(findCode))
check('切换前先同步 ref（重算读 ref，不读 state）',
  /findCaseRef\.current = findCase[\s\S]{0,200}findWholeRef\.current = findWhole[\s\S]{0,200}applyFindSearch\(0\)/.test(findCode))
check('「高亮所有」只重绘不重算', /\}, \[findHighlightAll, paintFindAll\]\)/.test(findCode))

/* ---------------- 8. 文本来源与缓存 ---------------- */
check('用 getTextContent 逐页取文本', /page\.getTextContent\(\)/.test(findBlock))
check('不读已渲染的 .textLayer span', !/\.textLayer\b/.test(findCode))
check('有 textCacheRef 缓存', /const textCacheRef = useRef\(new Map\(\)\)/.test(clientSrc))
check('提取是分批并发 + 每批让出一帧',
  /FIND_CONCURRENCY = \d+/.test(findBlock) && /setTimeout\(resolve, 0\)/.test(findBlock))
check('换文档重置：清缓存 + 作废在飞提取',
  /findSeqRef\.current \+= 1/.test(findBlock) && /textCacheRef\.current\.clear\(\)/.test(findBlock))
check('重置 effect 依赖 itemKey 与 reloadToken',
  /\}, \[itemKey, reloadToken, clearFindMarks\]\)/.test(findBlock))
check('文本缓存也在装载 cleanup 里清', /pageElsRef\.current\.clear\(\)\s*\n\s*textCacheRef\.current\.clear\(\)/.test(clientSrc))
check('不污染跳转历史（不调 gotoPage / pushHop）',
  !/gotoPage\(/.test(findCode) && !/pushHop\(/.test(findCode))

/* ---------------- 9. 硬守卫：不得引入原生 Selection 写入 API ---------------- */
const banned = ['addRange', 'selectAllChildren', 'execCommand']
for (const api of banned) {
  const hits = (clientSrc.match(new RegExp(`\\b${api}\\b`, 'g')) || []).length
  check(`client.js 没有 ${api}（硬守卫）`, hits === 0, `hits=${hits}`)
}
check('查找实现里没有 getSelection / setBaseAndExtent',
  !/getSelection|setBaseAndExtent/.test(findCode))

const failed = results.filter((r) => !r.ok).length
console.log(`\n===== ${results.length - failed}/${results.length} 通过 =====`)
if (failed > 0) {
  console.log(failed + ' 项失败：' + results.filter((r) => !r.ok).map((r) => r.name).join(' / '))
}
process.exitCode = failed === 0 ? 0 : 1
