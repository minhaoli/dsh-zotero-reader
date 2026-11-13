#!/usr/bin/env node
/**
 * findItem 不得为了一个 pdfPath 去建整库索引。
 *
 * 背景：打开一篇 PDF 会经 /pdf → findItem → library()，而 library()
 * 要跑整库查询（588 条实测 210ms，且库越大越慢）。调用方多数只用到 pdfPath。
 * 改成单条精确查询后实测 24ms，约 9 倍。
 *
 * 这里验证三件事，缺一个都可能让「快」变成「错」：
 *   ① 单条查询与整库给出的 pdfPath 必须一致
 *   ② 用附件 key 也能查到（调用方有时传的是附件 key）
 *   ③ 查不到时要能回退，而不是直接报错给用户
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

/* ---------- 1. 结构：快路径存在且带回退 ---------- */

const src = readFileSync(join(root, 'index.js'), 'utf8')
const fnStart = src.indexOf('async function findItem')
/**
 * 切片取到「下一个顶层函数声明」为止，不用固定字符数
 * （注释变长就会把断言挤出窗口，这个坑踩过好几次）。
 */
const nextFn = src.indexOf('\n  async function', fnStart + 10)
const fnBody = fnStart >= 0 ? src.slice(fnStart, nextFn > fnStart ? nextFn : fnStart + 3000) : ''

check('找得到 findItem', fnStart > 0)
check('findItem 优先走单条查询', /loadOneItem\(settings, cacheDir, key\)/.test(fnBody))
check('单条查询失败/查不到时回退到整库', /const lib = await library\(\)/.test(fnBody),
  '没有回退的话，「条目没 PDF」这类情况会变成莫名其妙的失败')
check('快路径在 library() 之前执行', (() => {
  /**
   * 必须**先去掉注释**再比较位置。
   *
   * 这段函数体的说明注释里就写着 `const lib = await library()`（用来解释
   * 原来的写法），直接 indexOf 会命中注释里的那处，得出「顺序反了」的
   * 假结论 —— 实测已经踩过一次。
   */
  const codeOnly = fnBody
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const k = line.indexOf('//')
      return k >= 0 ? line.slice(0, k) : line
    })
    .join('\n')
  const fast = codeOnly.indexOf('loadOneItem')
  const slow = codeOnly.indexOf('await library()')
  return fast > 0 && slow > 0 && fast < slow
})(), '顺序反了就白做一次整库查询，快路径失去意义')
check('保留了原来的报错语义',
  /找不到条目/.test(fnBody) && /没有可读的本地 PDF 附件/.test(fnBody))

const host = readFileSync(join(root, 'host', 'zotero.js'), 'utf8')
check('loadOneItem 已导出', /export async function loadOneItem/.test(host))
check('单条查询同时支持父条目 key 与附件 key',
  /p\.key = \? OR i2\.key = \?/.test(host))
check('单条查询走同一套快照（不会读到更旧的数据）',
  /snapshotDatabase\(dataDir, cacheDir\)/.test(host))

/* ---------- 2. 实测：只读，不写任何东西 ---------- */

const dataDir = 'C:\\Users\\30759\\Zotero'
if (!existsSync(join(dataDir, 'zotero.sqlite'))) {
  console.log('  skip 真实库不存在，跳过端到端部分')
} else {
  const mod = await import(pathToFileURL(join(root, 'host', 'zotero.js')).href)
  const cacheDir = join(process.env.USERPROFILE, '.dsh-zotero-reader', 'cache')
  const config = { zoteroDataDir: dataDir }

  const lib = await mod.loadLibrary(config, cacheDir)
  const sample = lib.items.filter((x) => x.pdfPath)[0]

  if (!sample) {
    console.log('  skip 库里没有可读 PDF，跳过')
  } else {
    const one = await mod.loadOneItem(config, cacheDir, sample.itemKey)
    check('单条查询能查到条目', Boolean(one))
    check('与整库给出的 pdfPath 一致', one && one.pdfPath === sample.pdfPath,
      `one=${one?.pdfPath}\n         lib=${sample.pdfPath}`)
    check('与整库给出的标题一致', one && one.title === sample.title)

    const byAttach = await mod.loadOneItem(config, cacheDir, sample.attachmentKey)
    check('用附件 key 也能查到', Boolean(byAttach))
    check('附件 key 查到的路径也一致', byAttach && byAttach.pdfPath === sample.pdfPath)

    const missing = await mod.loadOneItem(config, cacheDir, 'ZZZZZZZZ')
    check('不存在的 key 返回 null（交给上层回退，不抛错）', missing === null)

    // 粗略性能：单条查询应当明显快于整库
    const t1 = Date.now()
    for (let i = 0; i < 3; i++) await mod.loadOneItem(config, cacheDir, sample.itemKey)
    const oneAvg = (Date.now() - t1) / 3
    const t2 = Date.now()
    for (let i = 0; i < 3; i++) await mod.loadLibrary(config, cacheDir)
    const libAvg = (Date.now() - t2) / 3
    console.log(`  info 单条 ${oneAvg.toFixed(0)}ms vs 整库 ${libAvg.toFixed(0)}ms`)
    check('单条查询确实快于整库查询', oneAvg < libAvg,
      `单条 ${oneAvg.toFixed(0)}ms 应当小于整库 ${libAvg.toFixed(0)}ms`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
