// 静态检查：渲染期求值的地方是否引用了「尚未声明」的变量。
//
// 为什么需要它：本项目已经三次踩到同一类崩溃 ——
//   ① PaperView 的 useCallback 依赖数组里写 props.ctx（props 不在作用域里）
//   ② 缩放 effect 的依赖数组里写 renderPage，而它声明在下面（TDZ）
//   ③ scaleRef.current = scale 写在 useRef 声明之前（TDZ）
// 三者都会在渲染期直接抛 ReferenceError，宿主槽位的错误边界吞掉后就是黑屏。
// 渲染冒烟测试抓不到它们，因为桩里 useCallback/useRef 会把依赖和赋值略过；
// 只有「按源码顺序」检查才可靠 —— 依赖数组和顶层赋值都是在渲染期求值的。
//
// 判据（保守，只报确定的）：
//   A. 依赖数组行（`]` 或 `], [` 结尾）里出现的标识符，如果它在本文件里由
//      const/let 声明、且声明位置在该行之后 → 报错。
//   B. 顶层 `NAME.current = ...` 赋值，若 NAME 的声明在它之后 → 报错。
// 局限：函数体内部的引用不算（那是运行时才求值，合法），所以宁可漏报不误报。

import fs from 'node:fs'

const file = process.argv[2] ?? 'client.js'
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

/** name → 首次声明所在行号（1-based） */
const declaredAt = new Map()
const declRe = /^\s*(?:const|let)\s+(\w+)\s*=/
/**
 * 解构声明：`const [scale, setScale] = useState(...)`、`const { a, b } = cfg`。
 *
 * 之前只收集 `const name =`，所以 `const [editColor, setEditColor] = useState()` 里的
 * editColor 完全不在表里 —— 于是「在声明前引用它」这种真实 bug 抓不到，
 * 亲历过一次（Cannot access 'editColor' before initialization）才补上。
 */
const destructureRe = /^\s*(?:const|let)\s+([[{])(.+?)[\]}]\s*=/
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  const m = declRe.exec(line)
  if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i + 1)

  const d = destructureRe.exec(line)
  if (d) {
    const inner = d[2]
    // 数组解构取每个位置，对象解构取每个键的本地名（`a: b` 取 b，`a = 1` 取 a）
    for (const part of inner.split(',')) {
      const raw = part.trim()
      if (!raw) continue
      let name = raw
      const aliasMatch = /^[\w$]+\s*:\s*([\w$]+)/.exec(raw)
      if (d[1] === '{' && aliasMatch) name = aliasMatch[1]
      else name = raw.replace(/[=:].*$/, '').trim()
      if (!/^[a-zA-Z_$][\w$]*$/.test(name)) continue
      if (!declaredAt.has(name)) declaredAt.set(name, i + 1)
    }
  }
}

// 这些是宿主/浏览器全局或函数参数，不参与本文件的声明顺序判定
const IGNORED = new Set([
  /**
   * 组件函数的**形参**也要列在这里：它们在 `function X({ a, b })` 的参数位声明，
   * 不经过 `const/let`，所以进不了 declaredAt 表。若某个形参名恰好在后文
   * 别处又以 `const` 形式出现过，静态检查就会把它误判成「用了后面才声明的变量」。
   *
   * 亲历：给 PaperView 加了 `active` 形参后，依赖数组 `[itemKey, reloadToken, active]`
   * 被报「active 声明在 4842 行」—— 那只是同一名字在别处的 const 而已，不是 TDZ bug。
   */
  'props', 'ctx', 'sessionId', 'itemKey', 't', 'bound', 'tab', 'setTab',
  'active', 'paneActive', 'bare', 'topError', 'onBack', 'onError', 'onClose',
  'document', 'window', 'globalThis', 'Math', 'Number', 'String', 'Object', 'Array',
  'JSON', 'Promise', 'Map', 'Set', 'React', 'require', 'console', 'fetch', 'URL',
  'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IntersectionObserver', 'Blob', 'Worker', 'Error', 'Boolean',
])

const problems = []

for (let i = 0; i < lines.length; i += 1) {
  const lineNo = i + 1
  const text = lines[i]

  // A. 依赖数组：形如 `}, [a, b, c])` 或 `], [a, b])`
  const depMatch = /\]\s*,?\s*\[([^\]]*)\]\s*\)?\s*$/.exec(text.trim())
  const depTail = /^\s*\}\s*,\s*\[([^\]]+)\]/.exec(text)
  const depSource = depTail ? depTail[1] : (depMatch ? depMatch[1] : null)
  if (depSource) {
    for (const raw of depSource.split(',')) {
      const name = raw.trim().split('.')[0].trim()
      if (!/^\w+$/.test(name) || IGNORED.has(name)) continue
      const at = declaredAt.get(name)
      if (at !== undefined && at > lineNo) {
        problems.push({ lineNo, name, kind: '依赖数组引用了后面才声明的变量', declaredAt: at })
      }
    }
  }

  // B. 顶层 `NAME.current = <表达式>`
  const assign = /^\s{4,}(\w+)\.current\s*=\s*(.+)$/.exec(text)
  if (assign && !IGNORED.has(assign[1])) {
    const at = declaredAt.get(assign[1])
    if (at !== undefined && at > lineNo) {
      problems.push({ lineNo, name: assign[1], kind: '.current 赋值早于它的声明', declaredAt: at })
    }
    /**
     * B2. 赋值**右侧**引用的变量也要查。
     *
     * 曾漏过一例：`editColorRef.current = editColor` 写在 `editColor` 的
     * useState 之前，运行时报「Cannot access 'editColor' before initialization」。
     * 旧规则只看等号左边，所以没抓到。右侧所有裸标识符都要比一遍声明位置。
     */
    const rhs = assign[2]
    for (const m of rhs.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)/g)) {
      const name = m[1]
      if (IGNORED.has(name)) continue
      // 关键字与字面量不是变量
      if (/^(true|false|null|undefined|new|function|return|typeof|void)$/.test(name)) continue
      const at = declaredAt.get(name)
      if (at !== undefined && at > lineNo) {
        problems.push({ lineNo, name, kind: '.current 赋值右侧引用了后面才声明的变量', declaredAt: at })
      }
    }
  }

  /**
   * C. 顶层裸赋值表达式（如 `foo.bar()` 或 `fn(x)` 直接写在组件体里）引用的变量，
   *    也不能早于其声明 —— 这类语句在渲染期求值，同样会触发 TDZ。
   *    只查「行首没有 const/let/var/function/return/if/for」且不是 JSX 的简单调用形式。
   */
  if (/^\s{6,}(?!const |let |var |function |return |if |for |while |switch |try |catch |\/\/ |\*|\/\*)[\w$]+\(/.test(text)) {
    for (const m of text.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)(?=\s*\()/g)) {
      const name = m[1]
      if (IGNORED.has(name)) continue
      if (/^(if|for|while|switch|catch|typeof|new|function|return|void)$/.test(name)) continue
      const at = declaredAt.get(name)
      if (at !== undefined && at > lineNo) {
        problems.push({ lineNo, name, kind: '渲染期调用了后面才声明的函数', declaredAt: at })
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`声明顺序检查通过（${file}，共 ${declaredAt.size} 个局部声明）`)
} else {
  for (const p of problems) {
    console.log(`${file}:${p.lineNo}  ${p.kind}：${p.name} 声明在 ${p.declaredAt} 行`)
  }
  console.log(`\n共 ${problems.length} 处问题`)
  process.exitCode = 1
}
