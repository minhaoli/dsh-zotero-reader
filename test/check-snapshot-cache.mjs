#!/usr/bin/env node
/**
 * 快照缓存的行为验证。
 *
 * 背景：snapshotDatabase 原来每次调用都完整复制 zotero.sqlite（实测 16MB）
 * 加 -wal（16MB），共约 31MB。而它被调用得极其频繁，打开一篇 PDF 就要走一次。
 *
 * 加了「源库没变就复用快照」之后，有两个必须验证的点：
 *   ① 源库变了要重新复制 —— 否则会读到过时数据，这是数据正确性问题
 *   ② -wal 必须一起算进指纹 —— Zotero 写入时常只动 wal，主库文件本身不变
 *
 * 做法：造一个临时数据目录，真的读写文件，端到端跑 loadLibrary。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

/* ---------- 1. 静态检查：指纹逻辑必须在 ---------- */

const src = readFileSync(join(here, '..', 'host', 'zotero.js'), 'utf8')
const fnStart = src.indexOf('async function snapshotDatabase')
const fnEnd = src.indexOf('\nconst FIELD', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check('找得到 snapshotDatabase', fnStart > 0)
check('函数体已定位（负向断言的前提）', fnBody.length > 600)
check('指纹同时统计主库与 -wal', /src \+ '-wal'/.test(fnBody),
  '只算主库会漏掉 Zotero 只写 wal 的情况，进而读到过时数据')
check('指纹含修改时间（不只大小）', /mtimeMs/.test(fnBody),
  '只比大小会漏掉「大小相同但内容已改」')
check('签名对不上时重新复制', /saved\.sig === sig/.test(fnBody))
check('元数据在复制之后写（否则记下对不上实际内容的签名）',
  fnBody.indexOf('copyFile(src, dst)') < fnBody.indexOf('writeFile(meta'),
  '先写元数据再复制，中途源库被改就会留下错误签名')
check('元数据写失败不影响主流程', /写不进去就每次重复制/.test(fnBody))

/* ---------- 2. 端到端：真造库、真跑两遍 ---------- */

const dataDir = join(tmpdir(), `zr-snap-${Date.now()}`)
const cacheDir = join(dataDir, 'cache')
mkdirSync(dataDir, { recursive: true })
// 造一个占位 zotero.sqlite（不是真库，loadLibrary 会因查询失败而抛错，
// 但 snapshotDatabase 的复制行为在抛错之前就已发生，足以验证指纹机制）
writeFileSync(join(dataDir, 'zotero.sqlite'), 'v1')
writeFileSync(join(dataDir, 'zotero.sqlite-wal'), 'wal-v1')

const mod = await import(pathToFileURL(join(here, '..', 'host', 'zotero.js')).href)
const config = { zoteroDataDir: dataDir }

// 第一次：应生成快照与元数据
try { await mod.loadLibrary(config, cacheDir) } catch { /* 假库查询必然失败，符合预期 */ }
const snap = join(cacheDir, 'zotero.snapshot.sqlite')
const meta = snap + '.meta.json'
check('第一次调用生成了快照', existsSync(snap))
check('第一次调用写出了元数据', existsSync(meta))

if (existsSync(meta)) {
  const sig1 = JSON.parse(readFileSync(meta, 'utf8')).sig
  check('签名里带上了 wal', sig1.includes('-wal'), sig1)

  // 第二次：源库没变 → 快照不应被重写（mtime 不变）
  const before = statSync(snap).mtimeMs
  await new Promise((r) => setTimeout(r, 25))
  try { await mod.loadLibrary(config, cacheDir) } catch { /* 同上 */ }
  const after = statSync(snap).mtimeMs
  check('源库没变时复用快照，不重复复制', before === after,
    `mtime 变了说明又复制了一遍：${before} -> ${after}`)

  // 只改 wal（主库不动）→ 必须重新复制
  /**
   * 判据用**快照里的 wal 内容**，不用 mtime。
   *
   * mtime 精度受文件系统影响：copyFile 在同一秒内反复写同一路径时，
   * 有些实现不会推进 mtime，于是「确实重新复制了」却被判成没复制
   * ——这个断言之前就因此假失败过一次。内容比对没有这个问题。
   */
  await new Promise((r) => setTimeout(r, 25))
  writeFileSync(join(dataDir, 'zotero.sqlite-wal'), 'wal-v2-changed')
  const snapWal = snap + '-wal'
  const walInSnapBefore = existsSync(snapWal) ? readFileSync(snapWal, 'utf8') : ''
  const sigBefore = JSON.parse(readFileSync(meta, 'utf8')).sig
  try { await mod.loadLibrary(config, cacheDir) } catch { /* 同上 */ }
  const sigAfter = JSON.parse(readFileSync(meta, 'utf8')).sig
  const walInSnapAfter = existsSync(snapWal) ? readFileSync(snapWal, 'utf8') : ''
  check('只有 -wal 变化时签名必须变（否则读到过时数据）', sigBefore !== sigAfter,
    `签名未变：${sigAfter.split('|').map((s) => s.split(/[\\/]/).pop()).join(' | ')}`)
  check('只有 -wal 变化也必须重新复制（快照里的 wal 内容要更新）',
    walInSnapBefore !== walInSnapAfter,
    `快照里的 wal 仍是旧内容：${JSON.stringify(walInSnapAfter)}`)

  // 改主库 → 必须重新复制
  const beforeMain = statSync(snap).mtimeMs
  await new Promise((r) => setTimeout(r, 25))
  writeFileSync(join(dataDir, 'zotero.sqlite'), 'v2-larger-content')
  try { await mod.loadLibrary(config, cacheDir) } catch { /* 同上 */ }
  const afterMain = statSync(snap).mtimeMs
  check('主库变化必须重新复制', beforeMain !== afterMain)
}

/* ---------- 3. 探针归因：加载 pdf.js 不得混入 fetch-bytes ---------- */

const client = readFileSync(join(here, '..', 'client.js'), 'utf8')
check('pdf.js 模块加载有独立计时', client.includes("perf.attribute('load-pdfjs-module'"),
  '混在 fetch-bytes 里会得出「取文件要 16 秒」的错误结论')
const attrIdx = client.indexOf("perf.attribute('load-pdfjs-module'")
const fetchIdx = client.indexOf("perf.attribute('fetch-bytes'")
check('独立计时的结束点在 fetch-bytes 之前', attrIdx > 0 && fetchIdx > attrIdx)

// 清理
try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
