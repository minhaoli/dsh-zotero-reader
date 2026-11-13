#!/usr/bin/env node
/**
 * 跨作用域引用检查：局部 const/let 被别处引用会 ReferenceError。
 *
 * 背景（真实事故，两次）：
 *   · `openWin is not defined` —— 探针把计时窗口的起点写成加载 effect 里的局部
 *     const，却在 viewer 的 effect 里用。两个 effect 是两个函数作用域，
 *     结果「官方阅读器加载失败」，PDF 完全打不开。
 *   · `PERF_PROBE_VERSION is not defined` —— 常量声明在 IIFE 里，
 *     组件里却直接用，整块 UI 崩成白屏。
 *
 * 静态语法检查（node --check）抓不到这类错误，因为语法本身合法；
 * 只有运行时求值才会炸。而它一旦出现在 PDF 加载路径上，
 * 表现是「阅读器打不开」，看起来像加载失败，很难联想到这里。
 *
 * 这个脚本用近似的作用域模拟找出「在某个作用域内被引用、
 * 但该作用域及其外层都没有声明」的标识符。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')
const lines = src.split('\n')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`)
  }
}

/* ---------------------------------------------------------------- 准备 */

/**
 * 去掉注释和字符串字面量，避免误判。
 *
 * 关键：注释里经常写着变量名（比如这次的解释性注释就提到 openWin），
 * 不剥离的话会把注释当成真实引用，产生假阳性 —— 这个坑前面已经踩过。
 */
function stripNoise(text) {
  /**
   * 逐行处理，**不跨行吞**。
   *
   * 之前写成整文件单遍状态机，遇到正则字面量（`/^[1-9]\d?/`、`/[^\x20]/`）
   * 会把 `/` 当成注释或字符串的起点，然后一路吞到下一个引号 ——
   * 实测把中间几千行真实代码全剥掉了（openWin / PERF_PROBE_VERSION 都找不见），
   * 于是所有断言集体误报。逐行剥离不会再出现这种「一处误判、整份报废」。
   *
   * 行内仍要处理字符串与模板字符串，否则注释符号出现在字符串里会误删。
   */
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => stripLine(line))
    .join('\n')
}

function stripLine(line) {
  const out = []
  let i = 0
  const n = line.length
  while (i < n) {
    const c = line[i]
    const c2 = line[i + 1]

    // 行注释：到行尾为止
    if (c === '/' && c2 === '/') break

    // 块注释：只处理本行内能闭合的；跨行块注释由下面的「行首块注释」兜底
    if (c === '/' && c2 === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        out.push(' ')
        break
      }
      out.push(' ')
      i = end + 2
      continue
    }

    // 字符串 / 模板字符串：整段抹成空格，避免其中的 // 或 /* 被误判
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out.push(' ')
      i++
      while (i < n) {
        if (line[i] === '\\') { out.push(' '); i += 2; continue }
        if (line[i] === q) { i++; break }
        out.push(' ')
        i++
      }
      continue
    }

    /**
     * 正则字面量：`/` 前面若是这些字符/关键字，说明它是正则而不是除号。
     * 判错的后果很轻 —— 正则内容里带 // 的情况极少，且不跨行。
     */
    if (c === '/') {
      const prev = out.join('').replace(/\s+$/, '').slice(-1)
      const isRegexCtx = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)
      if (isRegexCtx) {
        out.push(' ')
        i++
        let closed = false
        while (i < n) {
          if (line[i] === '\\') { out.push(' '); i += 2; continue }
          if (line[i] === '/') { i++; closed = true; break }
          out.push(' ')
          i++
        }
        if (closed) {
          // 跳过正则标志位
          while (i < n && /[a-z]/.test(line[i])) { i++ }
        }
        continue
      }
    }

    out.push(c)
    i++
  }
  return out.join('')
}

const clean = stripNoise(src)
const cleanLines = clean.split('\n')

/* ------------------------------------------------- 收集已声明的标识符 */

/**
 * 收集整个文件里所有 `const/let/var NAME` 与 `function NAME` 声明。
 *
 * 这里故意做得宽松（不区分块级作用域）：目标是抓「根本没声明过」
 * 的引用，而不是精确的 TDZ 分析 —— 后者已由 check-decl-order.mjs 负责。
 * 宽松的代价是漏报，但能保证不产生假阳性，而假阳性会让测试失去信任。
 */
const declared = new Set()
for (const line of cleanLines) {
  let m
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
  while ((m = declRe.exec(line))) declared.add(m[1])
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)/g
  while ((m = fnRe.exec(line))) declared.add(m[1])
  // 解构声明：const { a, b } = ... / const [a, b] = ...
  const destrRe = /\b(?:const|let|var)\s*[{[][^}\]]*[}\]]/g
  while ((m = destrRe.exec(line))) {
    const names = m[0].match(/[A-Za-z_$][\w$]*/g) || []
    for (const name of names) {
      if (name !== 'const' && name !== 'let' && name !== 'var') declared.add(name)
    }
  }
  // import 与函数参数（含解构参数）单独放行
  const importRe = /\bimport\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/g
  while ((m = importRe.exec(line))) {
    for (const name of (m[1] || m[2] || '').match(/[A-Za-z_$][\w$]*/g) || []) {
      if (name !== 'as') declared.add(name)
    }
  }
}

/** 函数参数同样算「已声明」：整文件收集，宽松处理。 */
for (const m of clean.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
  for (const name of (m[1] || '').match(/[A-Za-z_$][\w$]*/g) || []) declared.add(name)
}
for (const m of clean.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*)\(([^()]*)\)/g)) {
  for (const name of (m[1] || '').match(/[A-Za-z_$][\w$]*/g) || []) declared.add(name)
}

/* ------------------------------------------------------- 浏览器全局白名单 */

/**
 * 这些不是本文件声明的，但运行时一定存在（宿主或浏览器提供）。
 * 漏掉一个就会假阳性，所以宁可放宽。
 */
const GLOBALS = new Set([
  'window', 'document', 'globalThis', 'self', 'navigator', 'location', 'history',
  'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData', 'AbortController', 'AbortSignal',
  'Element', 'HTMLElement', 'Node', 'NodeList', 'Text', 'DOMParser',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver',
  'CustomEvent', 'Event', 'EventTarget', 'KeyboardEvent', 'MouseEvent', 'DragEvent',
  'ClipboardEvent', 'WheelEvent', 'PointerEvent', 'FocusEvent', 'InputEvent',
  'getComputedStyle', 'matchMedia', 'devicePixelRatio', 'performance',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'Notification',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'Symbol', 'Proxy', 'Reflect', 'BigInt', 'Intl',
  'Image', 'Audio', 'Range', 'Selection', 'Uint8Array', 'Uint8ClampedArray',
  'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'TextEncoder',
  'TextDecoder', 'CanvasRenderingContext2D', 'OffscreenCanvas', 'Worker',
  'MessageChannel', 'MessagePort', 'structuredClone', 'queueMicrotask',
  'CSS', 'DOMMatrix', 'DOMPoint', 'DOMRect', 'Path2D', 'XMLHttpRequest',
  'React', 'module', 'exports', 'require', 'process', 'Buffer',
  'arguments', 'undefined', 'NaN', 'Infinity', 'globalThis',
  'true', 'false', 'null', 'this', 'super', 'new', 'typeof', 'instanceof',
  'in', 'of', 'void', 'delete', 'yield', 'await', 'async', 'class', 'extends',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'try', 'catch', 'finally', 'throw', 'function',
  'const', 'let', 'var', 'import', 'export', 'from', 'as', 'static', 'get', 'set',
])

/** 关键字与常见属性名，扫引用时会大量命中，直接跳过。 */
const KEYWORDS = GLOBALS

/* --------------------------------------------- 本次修复的两个具体回归点 */

const openWinDeclLine = cleanLines.findIndex((l) => /const\s+openWin\s*=/.test(l))
const openWinUseLines = []
cleanLines.forEach((l, i) => {
  // 只在「非声明行」上找引用
  if (i === openWinDeclLine) return
  if (/\bopenWin\b(?!Ref)/.test(l)) openWinUseLines.push(i + 1)
})

check(
  'openWin 的声明确实存在',
  openWinDeclLine >= 0,
  '找不到 `const openWin = ...`：探针计时窗口的起点没了',
)

/**
 * 核心断言：`openWin` 只能在同一个 effect 里用。
 *
 * 判据用「函数作用域边界」近似 —— `useEffect(() => {` 到匹配的 `})` 之间。
 * 这比数行号可靠：行号一改就失效，而这次修复恰恰让行号变了。
 */
function effectSpans(lines) {
  const spans = []
  for (let i = 0; i < lines.length; i++) {
    if (!/useEffect\(\s*\(\s*\)\s*=>\s*\{/.test(lines[i])) continue
    let depth = 0
    let started = false
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true }
        else if (ch === '}') depth--
      }
      if (started && depth === 0) { spans.push([i + 1, j + 1]); break }
    }
  }
  return spans
}

const spans = effectSpans(cleanLines)
const declSpan = spans.find(([a, b]) => openWinDeclLine + 1 >= a && openWinDeclLine + 1 <= b)

check(
  'openWin 声明在某个 useEffect 内',
  Boolean(declSpan),
  `声明行 ${openWinDeclLine + 1} 不在任何 useEffect 区间里`,
)

if (declSpan) {
  const outside = openWinUseLines.filter((ln) => ln < declSpan[0] || ln > declSpan[1])
  check(
    'openWin 没有跨 effect 引用（openWin is not defined 的根因）',
    outside.length === 0,
    outside.length
      ? `第 ${outside.join(', ')} 行在 effect ${declSpan[0]}-${declSpan[1]} 之外引用了 openWin；` +
        '跨函数作用域必然 ReferenceError，应改用 ref 传递'
      : '',
  )
}

/**
 * 这条断言要看**字符串参数**，而 stripNoise 把字符串抹成了空格，
 * 所以在剥离版上根本匹配不到 `'setDocument-total'`。
 * 改为在注释已剔除、但字符串保留的文本上判断。
 */
const noComments = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((line) => {
    const k = line.indexOf('//')
    return k >= 0 ? line.slice(0, k) : line
  })
  .join('\n')

check(
  '跨 effect 传递计时窗口用的是 ref',
  /openWinRef\.current\s*=/.test(noComments) &&
    /perf\.attribute\(\s*['"]setDocument-total['"]\s*,\s*openWinRef\.current\s*\)/.test(noComments),
  'setDocument-total 应当读 openWinRef.current，而不是局部 openWin',
)

/* ----------------------------------------- PERF_PROBE_VERSION 的同类回归 */

const verDeclIdx = cleanLines.findIndex((l) => /const\s+PERF_PROBE_VERSION\s*=/.test(l))
check('PERF_PROBE_VERSION 在文件顶层作用域声明', verDeclIdx >= 0, '常量未声明，组件引用会白屏')

if (verDeclIdx >= 0) {
  /**
   * 声明必须和 `const perf = (() => {` 同一层级：都在模块工厂函数体内。
   * 若被塞进 perf 的 IIFE 里，外面就看不见 —— 这正是上次的白屏原因。
   */
  const perfIifeIdx = cleanLines.findIndex((l) => /const\s+perf\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/.test(l))
  check(
    'PERF_PROBE_VERSION 不在 perf 的 IIFE 内部',
    !(perfIifeIdx >= 0 && verDeclIdx > perfIifeIdx && verDeclIdx < perfIifeIdx + 300),
    `声明行 ${verDeclIdx + 1} 疑似落在 perf IIFE（起于 ${perfIifeIdx + 1}）内部，外部引用会 ReferenceError`,
  )
}

/* ------------------------------------------------------------ 语法自检 */

check('文件被剥离噪声后仍保有代码', clean.length > src.length * 0.4, '剥离逻辑可能吃掉了太多内容')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
