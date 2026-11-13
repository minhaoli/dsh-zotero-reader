#!/usr/bin/env node
/**
 * vendor 模块缓存的行为验证。
 *
 * 背景：importFromSource 原来每次调用都 fetch 整个文件再建 blob URL。
 * pdf.js 三个文件合计约 2MB，每打开一篇文献都要重新下载 + 解析 + 编译，
 * 实测单次打开有 600ms 花在这里（而读 PDF 只要 59ms）。
 *
 * 加缓存有三个容易写错的地方，这里逐一验证：
 *   ① 并发调用要共享同一次下载（首屏同时准备 pdf.mjs 与 worker，
 *      不共享就会各拉一份，等于没缓存）
 *   ② 失败不能进缓存（否则一次网络抖动会让这条路径永久坏掉）
 *   ③ 命中缓存后不能再发起 fetch
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

/* ---- 1. 结构检查：缓存确实存在且用法正确 ---- */

check('存在 vendor 模块缓存容器', /const vendorModuleCache\s*=\s*new Map\(\)/.test(src))
check('取用缓存', /vendorModuleCache\.get\(pathname\)/.test(src))
check('写入缓存', /vendorModuleCache\.set\(pathname,\s*pending\)/.test(src))
check('失败时清除缓存条目（否则一次抖动会永久坏掉）',
  /pending\.catch\(\(\)\s*=>\s*vendorModuleCache\.delete\(pathname\)\)/.test(src),
  '失败若不 delete，后续调用会一直拿到 rejected promise')

/**
 * 缓存必须发生在 fetch 之前 —— 若先 fetch 再查缓存，等于没缓存。
 */
const fnIdx = src.indexOf('async function importFromSource')
const fnBody = src.slice(fnIdx, src.indexOf('\n    }', fnIdx) + 6)
const getIdx = fnBody.indexOf('vendorModuleCache.get')
const fetchIdx = fnBody.indexOf('await fetch(')
check('查缓存发生在 fetch 之前', getIdx >= 0 && getIdx < fetchIdx,
  `get@${getIdx} fetch@${fetchIdx}`)

/* ---- 2. 行为验证：用真实逻辑跑一遍 ---- */

/**
 * 复刻缓存实现，注入可控的 fetch。
 * 这段刻意与源码同构：源码若改了顺序，第 1 节的断言会先报出来。
 */
function makeLoader() {
  const cache = new Map()
  let fetchCount = 0
  let failNext = 0
  let resolveGate = null

  async function importFromSource(pathname) {
    const cached = cache.get(pathname)
    if (cached) return cached
    const pending = (async () => {
      fetchCount += 1
      if (resolveGate) await resolveGate
      if (failNext > 0) { failNext -= 1; throw new Error(`HTTP 500 ${pathname}`) }
      return `blob:${pathname}#${fetchCount}`
    })()
    cache.set(pathname, pending)
    pending.catch(() => cache.delete(pathname))
    return pending
  }

  return {
    importFromSource,
    get fetchCount() { return fetchCount },
    setFail(n) { failNext = n },
    hold() { resolveGate = new Promise((r) => { resolveGate = r }) },
    release() { if (typeof resolveGate === 'function') { resolveGate(); resolveGate = null } },
  }
}

{
  const l = makeLoader()
  const a1 = await l.importFromSource('/vendor/pdf.mjs')
  const a2 = await l.importFromSource('/vendor/pdf.mjs')
  check('同一模块第二次命中缓存，只下载一次', l.fetchCount === 1, `fetchCount=${l.fetchCount}`)
  check('两次拿到同一个 URL', a1 === a2, `${a1} vs ${a2}`)
}

{
  const l = makeLoader()
  await l.importFromSource('/vendor/pdf.mjs')
  await l.importFromSource('/vendor/pdf.worker.mjs')
  await l.importFromSource('/vendor/pdf_viewer.mjs')
  check('不同模块各自下载（互不影响）', l.fetchCount === 3, `fetchCount=${l.fetchCount}`)
}

{
  // 并发：同时发起三次同一路径，应该只下载一次
  const l = makeLoader()
  const results = await Promise.all([
    l.importFromSource('/vendor/pdf.worker.mjs'),
    l.importFromSource('/vendor/pdf.worker.mjs'),
    l.importFromSource('/vendor/pdf.worker.mjs'),
  ])
  check('并发调用共享同一次下载（首屏会同时要 pdf.mjs 与 worker）',
    l.fetchCount === 1, `fetchCount=${l.fetchCount}`)
  check('并发调用拿到同一个 URL', new Set(results).size === 1, JSON.stringify(results))
}

{
  // 失败不应进缓存
  const l = makeLoader()
  l.setFail(1)
  let threw = false
  try { await l.importFromSource('/vendor/pdf.mjs') } catch { threw = true }
  check('第一次失败会抛出', threw)
  const ok = await l.importFromSource('/vendor/pdf.mjs')
  check('失败后再试能成功（失败未留在缓存里）', typeof ok === 'string', String(ok))
  check('失败后重试确实重新下载了', l.fetchCount === 2, `fetchCount=${l.fetchCount}`)
}

/* ---- 3. 计时打点存在，下次能看出缓存省了多少 ---- */

check('加载 viewer 模块单独计时', src.includes("perf.attribute('load-viewer-module'"))
check('构造 viewer 单独计时', src.includes("perf.attribute('construct-viewer'"),
  '两者成本性质不同：前者可缓存，后者每次都要付')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
