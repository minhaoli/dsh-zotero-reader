/**
 * 在 Node 里真正「渲染」一遍 Reader / PaperView，抓渲染期异常。
 *
 * 思路：
 *   1. 伪造 window.__ModuleLoader__ 捕获 client.js 的 factory
 *   2. 用最小 React stub（h 返回描述对象，hook 返回固定值）
 *   3. 用假 ctx 跑 apply()，从 slots.register 拿到注册的组件
 *   4. 用会让 mode='read' 的 tabKey 调这个组件 → 它返回 h(PaperView, props)
 *   5. 再把 PaperView 也调一遍 —— 任何 throw 都会在这里现形
 *
 * 这一步能把「黑屏」从「浏览器里看不见」变成「有堆栈的异常」。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

/* ------------------------------------------------- 假 DOM / window */

const styleEls = []
globalThis.window = {
  __ModuleLoader__: { load(mod) { globalThis.__captured = mod } },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', protocol: 'http:' },
  innerWidth: 1440,
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  getSelection: () => ({ toString: () => '', anchorNode: null, rangeCount: 0 }),
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  addEventListener() {}, removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement() {
    const el = {
      style: {}, dataset: {}, classList: { add() {}, remove() {} },
      setAttribute() {}, getAttribute: () => null, appendChild() {}, append() {},
      addEventListener() {}, remove() {}, removeChild() {},
      textContent: '', innerHTML: '', className: '',
      querySelectorAll: () => [], querySelector: () => null,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      getContext: () => ({ scale() {}, drawImage() {}, fillRect() {}, save() {}, restore() {} }),
    }
    styleEls.push(el)
    return el
  },
  head: { appendChild() {} },
  body: { appendChild() {} },
}
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail } }
globalThis.Blob = class { constructor(parts) { this.parts = parts } }
globalThis.URL.createObjectURL = () => 'blob:fake'
globalThis.URL.revokeObjectURL = () => {}
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) })
globalThis.setTimeout = setTimeout
globalThis.clearTimeout = clearTimeout
globalThis.setInterval = setInterval
globalThis.clearInterval = clearInterval
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.IntersectionObserver = class {
  constructor() {}
  observe() {} unobserve() {} disconnect() {}
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

/* ------------------------------------------------- React stub */

const effectErrors = []
const ReactStub = {
  createElement: (type, props, ...children) => ({ __el: true, type, props: { ...(props ?? {}), children } }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  /**
   * 真的执行 effect 回调 —— 这是关键。
   * React 在 effect 抛异常时同样会卸载整棵子树，效果就是「界面全黑」，
   * 而空实现的 stub 会把这个线索吃掉。
   */
  useEffect: (fn) => {
    try {
      const cleanup = fn()
      if (typeof cleanup === 'function') { try { cleanup() } catch { /* ignore */ } }
    } catch (e) {
      effectErrors.push({ where: 'useEffect', message: e?.message ?? String(e), stack: e?.stack })
    }
  },
  useLayoutEffect: () => {},
  /**
   * 依赖数组必须真的被求值。
   *
   * 之前写成 `(fn) => fn`，等于把 deps 整个跳过。而「一打开条目就黑屏」的真凶
   * 正是 deps 里的 `props.ctx`（PaperView 的参数是解构的，props 根本不在作用域里）：
   * 依赖数组在渲染期求值，所以一挂载就抛 ReferenceError。
   * 桩跳过 deps，就永远看不见这类错误。`void deps` 会强制求值。
   */
  useCallback: (fn, deps) => { void deps; return fn },
  useMemo: (fn) => { try { return fn() } catch (e) { throw e } },
  useRef: (init) => ({ current: init }),
  useReducer: (_r, init) => [init, () => {}],
  useContext: () => ({}),
  createContext: (v) => ({ Provider: 'P', Consumer: 'C', _v: v }),
  memo: (c) => c,
  forwardRef: (c) => c,
  // 错误边界用的基类：真实 React 有，桩里补一个最小实现（渲染走 props.children）
  Component: class Component {
    constructor(props) { this.props = props ?? {}; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  },
}
const ReactDOMStub = { createPortal: (n) => n, flushSync: (fn) => fn() }

/* ------------------------------------------------- 加载 client.js */

await import('file:///' + clientPath.replace(/\\/g, '/'))
const mod = globalThis.__captured
if (!mod) { console.error('FAIL: __ModuleLoader__.load 未被调用'); process.exit(1) }
console.log('load() OK, id =', mod.id)

const plugin = mod.factory((name) => {
  if (name === 'react') return ReactStub
  if (name === 'react-dom') return ReactDOMStub
  throw new Error('unexpected require: ' + name)
})

/* ------------------------------------------------- 假 ctx + 捕获组件 */

let registeredComponent = null
const fakeCtx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (deps, cb) => cb({
    get: (name) => {
      if (name === 'sidebarRightTabs') return { register: () => () => {}, get: () => undefined, subscribe: () => () => {} }
      if (name === 'sidebarRight') return { openTab: () => true }
      if (name === 'sessions') return { scope: () => ({}) }
      if (name === 'conversation') return { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '' }) }, setDraft() {} }) } }
      return undefined
    },
  }),
  slots: {
    inject: (name, cb) => cb(),
    register: (spec, component) => {
      if (spec.name === 'sidebar.right.pane.tab' && spec.key === 'zotero-reader') registeredComponent = component
      return () => {}
    },
  },
  locale: { register: () => () => {}, bind: () => (k) => k },
  layout: { openRightbar() {}, closeRightbar() {} },
  uiWorkspace: {},
  get: (name) => {
    if (name === 'sessions') return { scope: () => ({}) }
    if (name === 'conversation') return { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '' }) }, setDraft() {} }) } }
    return undefined
  },
}

plugin.apply(fakeCtx)
if (!registeredComponent) { console.error('FAIL: 没抓到 sidebar.right.pane.tab 组件'); process.exit(1) }
console.log('抓到组件 OK')

/* ------------------------------------------------- 渲染 Reader（browse） */

const bound = (k) => k

function renderNode(node, depth = 0) {
  if (!node || !node.__el) return
  if (typeof node.type === 'function') {
    const name = node.type.name || '(anon)'
    process.stdout.write('  '.repeat(depth) + `→ 渲染组件 ${name}\n`)
    // 类组件（错误边界）要 new 出来再调 render，函数组件直接调用
    const isClass = node.type.prototype && typeof node.type.prototype.render === 'function'
    let out
    if (isClass) {
      const instance = new node.type(node.props)
      instance.props = node.props ?? {}
      instance.state = typeof node.type.getDerivedStateFromError === 'function'
        ? node.type.getDerivedStateFromError(null)
        : {}
      out = instance.render()
    } else {
      out = node.type(node.props)
    }
    renderNode(out, depth + 1)
  }
}

console.log('\n=== 1. 渲染 Reader（默认 browse）===')
try {
  const tree = registeredComponent({ tabKey: 'zotero-reader', bound, sessionId: 'test-session', ctx: fakeCtx })
  console.log('  返回类型:', tree?.type?.name ?? typeof tree?.type)
  renderNode(tree, 1)
  console.log('  OK')
} catch (e) {
  console.log('  THREW:', e.message)
  console.log(e.stack.split('\n').slice(0, 8).join('\n'))
}

/* ------------------------------------------------- 渲染 Reader（read → PaperView） */

console.log('\n=== 2. 渲染 Reader（tabKey 带文献 key → 进 PaperView）===')
effectErrors.length = 0
try {
  const tree = registeredComponent({ tabKey: 'zotero-reader:E3TYCEMB', bound, sessionId: 'test-session', ctx: fakeCtx })
  console.log('  返回类型:', tree?.type?.name ?? typeof tree?.type)
  // 根节点现在是错误边界（类组件），取它包着的 Reader 元素再直接调用
  const inner = tree?.props?.children?.[0] ?? tree
  const out = inner.type(inner.props)
  console.log('  渲染 PaperView 完成，返回类型:', out?.type ?? typeof out)
  console.log('  OK')
} catch (e) {
  console.log('  THREW:', e.message)
  console.log(e.stack.split('\n').slice(0, 10).join('\n'))
  process.exitCode = 1
}

console.log('\n=== effect 期异常（会让 React 卸载整棵子树 = 黑屏）===')
if (effectErrors.length === 0) {
  console.log('  无')
} else {
  process.exitCode = 1
  for (const err of effectErrors) {
    console.log('  THREW in', err.where, ':', err.message)
    if (err.stack) console.log(err.stack.split('\n').slice(1, 6).map((l) => '    ' + l.trim()).join('\n'))
  }
}
