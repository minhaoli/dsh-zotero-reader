#!/usr/bin/env node
/**
 * CCITT / JBIG2 / JPEG2000 图像解码依赖的 WASM 供给。
 *
 * 事故背景：2001 年那篇 Seeing Sets 有 3 张 /CCITTFaxDecode 图，阅读器里
 * 整块空白，而 Zotero 自己能显示。查下来是 pdf.js 6.5 把图像解码器搬进了
 * WASM，按 `wasmUrl + 文件名` 取；而 wasmUrl 默认 null，拼出来是
 * "nulljbig2.wasm"，404 —— 且失败是**静默的**，只有一条 warning，图不画。
 *
 * 所以这里必须同时守住三件事，缺一个就还是空白：
 *   ① vendor 路由白名单里要有这些 wasm 文件
 *   ② 文件在包里真的存在（路径拼对）
 *   ③ getDocument 要真的传 wasmUrl，且**末尾带斜杠**
 *      （pdf.js 是直接字符串拼接，漏斜杠会变成 ".../vendorjbig2.wasm"）
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

const idx = readFileSync(join(root, 'index.js'), 'utf8')
const client = readFileSync(join(root, 'client.js'), 'utf8')

/* ---------- 1. vendor 白名单 ---------- */

const WASM_FILES = [
  'jbig2.wasm',
  'jbig2_nowasm_fallback.js',
  'openjpeg.wasm',
  'openjpeg_nowasm_fallback.js',
  'qcms_bg.wasm',
]

for (const f of WASM_FILES) {
  check(`白名单包含 ${f}`, idx.includes(`'${f}'`),
    '没有它，路由会返回 404，pdf.js 静默跳过该图')
}

/**
 * jbig2.wasm 是 CCITT 的关键 —— CCITT 与 JBIG2 共用它
 * （见 pdf.worker.mjs 的 JBig2CCITTFaxImage._filename）。
 */
check('jbig2.wasm 标了 application/wasm',
  /'jbig2\.wasm':\s*\['wasm\/jbig2\.wasm',\s*'application\/wasm'\]/.test(idx),
  'MIME 不对时 WebAssembly.instantiate 可能被拒')

/* ---------- 2. 文件真的存在 ---------- */

let pkgDir = null
try {
  const requireHere = createRequire(join(root, 'noop.cjs'))
  pkgDir = dirname(requireHere.resolve('pdfjs-dist/package.json'))
} catch { /* 下面用 existsSync 的结果报错 */ }

check('能解析到 pdfjs-dist 包', Boolean(pkgDir))

if (pkgDir) {
  for (const f of WASM_FILES) {
    /**
     * 路径要与 VENDOR_FILES 里的第二项一致。这里直接从源码里抠出来比，
     * 免得手写路径与白名单漂移。
     */
    const m = new RegExp(`'${f.replace(/\./g, '\\.')}':\\s*\\['([^']+)'`)
    const rel = m.exec(idx)?.[1]
    check(`${f} 在白名单里指向的路径存在`, Boolean(rel) && existsSync(join(pkgDir, rel)),
      rel ? `期望 ${join(pkgDir, rel)}` : '白名单里没找到该条目的路径')
  }
}

/* ---------- 3. getDocument 传了 wasmUrl 且末尾有斜杠 ---------- */

const gdIdx = client.indexOf('pdfjs.getDocument({')
check('getDocument 存在', gdIdx > 0)

const gdSnippet = gdIdx > 0 ? client.slice(gdIdx, gdIdx + 400) : ''
check('getDocument 传了 wasmUrl', /wasmUrl/.test(gdSnippet),
  '不传的话 CCITT 图永远是空白')

/**
 * 末尾斜杠必须落在**拼接产物**上。源码里写的是
 * `new URL(`${API}/vendor/`, document.baseURI).href`，所以查 `${API}/vendor/`。
 */
check('wasm 基址末尾带斜杠（pdf.js 是直接字符串拼接）',
  /\$\{API\}\/vendor\/`/.test(client),
  '漏斜杠会拼成 ".../vendorjbig2.wasm"，404 且静默')

check('wasm 基址用绝对 URL（页面基址是 dsh-app:// 自定义 scheme）',
  /new URL\(\s*`\$\{API\}\/vendor\/`\s*,\s*document\.baseURI\s*\)\.href/.test(client),
  '相对路径在自定义 scheme 下容易被解析歪')

/* ---------- 4. 别把 useWasm 关掉 ---------- */

check('没有关掉 useWasm', !/useWasm\s*:\s*false/.test(client),
  '关掉 wasm 会强制走 JS 兜底，那条路也可能没配好')
check('没有关掉 useWorkerFetch', !/useWorkerFetch\s*:\s*false/.test(client))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
