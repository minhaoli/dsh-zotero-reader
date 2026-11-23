/**
 * 静态检查：hook 只能在组件函数体里调用。
 *
 * 为什么需要：`harness-render.mjs` 用的 React stub 让 hook 直接返回固定值，
 * 不校验调用位置；而真实 React 在组件外遇到 hook 会抛 #321
 * （invalid hook call），线上表现是「官方阅读器加载失败」。
 * 静态检查能在这个错误跑到用户眼前之前拦住它。
 *
 * 判定方式：对每个 hook 调用行，向上找最近一个「函数定义」行，
 * 判断它是 function 声明还是 const/let 赋值成箭头函数；
 * 再判断该函数是不是组件（首字母大写）或自定义 hook（use 开头）。
 * 都不是就报错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')
const lines = source.split(/\r?\n/)

const HOOKS = /\b(useState|useEffect|useRef|useCallback|useMemo|useLayoutEffect|useContext|useReducer)\s*\(/
/** 函数定义行的两种形态：`function name(` 与 `const name = (...) =>` / `async` 变体 */
const FN_DECL = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
const FN_ASSIGN = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/

/** 找出某行所属的最近外层函数名；找不到返回 null */
function enclosingFunctionName(index) {
  for (let i = index; i >= 0; i -= 1) {
    const line = lines[i]
    const decl = FN_DECL.exec(line)
    if (decl) return decl[1]
    const assign = FN_ASSIGN.exec(line)
    if (assign) return assign[1]
  }
  return null
}

/**
 * 组件/hook 宿主判定 —— 按**缩进 + 花括号**回溯真正的所属渲染单元。
 *
 * 为什么不能只取「最近一个组件函数定义」：组件体里常包一层
 * `;(async () => { ... })()` 装载 IIFE（本插件在 setDocument 链路里就有），
 * 往里再写几层 try/for。hook 出现在那里时，往上确实能找到 `Reader`，
 * 但它实际不在渲染期执行 —— 正是真实 React 抛 #321 的情形，
 * 而「最近的大写函数」这种判法会放行它。
 *
 * 做法：从 hook 行往上，取每个非空行的缩进；第一次遇到比当前缩进更浅、
 * 且形如函数/IIFE/箭头函数起始的行，就是 enclosure。
 *   · 是组件（大写开头）或自定义 hook（use 开头）→ 合法
 *   · 是 `(async () => {` 这类无名 IIFE，或小写命名函数 → 越界
 */
function indentationOf(text) {
  return text.length - text.trimStart().length
}

/** 可能是函数体起始的行（含无名 IIFE） */
const FN_START = [
  /^\s*(?:async\s+)?function\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/,
  /^\s*[;;(]?\s*(?:async\s*)?\(\)\s*=>\s*\{/, // ;(async () => {
  /^\s*[;;(]?\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/,
]

/**
 * 返回 hook 行所属的函数名；无名 IIFE 返回空字符串 ''；
 * 一路到顶都没有函数边界则返回 null。
 */
function enclosingHookHost(index) {
  const hookIndent = indentationOf(lines[index])
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (indentationOf(line) >= hookIndent) continue
    for (const re of FN_START) {
      const m = re.exec(line)
      if (m) return m[1] ?? ''
    }
  }
  return null
}

const problems = []
for (let i = 0; i < lines.length; i += 1) {
  if (!HOOKS.test(lines[i])) continue
  // 注释行里提到 hook 不算调用
  const trimmed = lines[i].trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
  const owner = enclosingHookHost(i)
  if (!owner) {
    problems.push({ line: i + 1, owner: null, text: trimmed.slice(0, 90) })
  }
}

console.log('=== hook 调用位置检查 ===')
if (problems.length === 0) {
  console.log('  ok   所有 hook 调用都在组件或自定义 hook 内')
  console.log('\n检查通过（1 项）')
  process.exit(0)
}
for (const p of problems) {
  console.log(`  FAIL 第 ${p.line} 行：hook 在「${p.owner ?? '<顶层>'}」里调用，不是组件`)
  console.log(`        ${p.text}`)
  console.log('        真实 React 会抛 #321 invalid hook call（表现为加载失败）')
}
console.log(`\n${problems.length} 项失败`)
process.exit(1)
