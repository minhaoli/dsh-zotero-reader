/**
 * 对三个工具逐个跑 execute，检查返回值能否无损 JSON 往返。
 * 规则：JSON.parse(JSON.stringify(v)) 必须完全等于 stringify 结果，
 * 且任何层级都不能出现 undefined / 非有限数 / BigInt / Map / Set / 循环。
 */
import { searchTool, readTool, askTool } from '../host/tools.js'
import { loadLibrary } from '../host/zotero.js'
import { extractText, outlineOf } from '../host/pdf.js'
import { searchChunks } from '../host/pdf.js'
import os from 'node:os'
import path from 'node:path'

/** 缓存目录跟着当前用户走，不要在仓库里写死某台机器的绝对路径。 */
const cacheDir = process.env['DSH_ZOTERO_READER_DATA']
  ? path.join(process.env['DSH_ZOTERO_READER_DATA'], 'cache')
  : path.join(os.homedir(), '.dsh-zotero-reader', 'cache')
const lib = await loadLibrary({ zoteroDataDir: '' }, cacheDir)

const docs = new Map()
async function documentOf(item) {
  if (docs.has(item.itemKey)) return docs.get(item.itemKey)
  const ex = await extractText(item.pdfPath)
  const doc = { pages: ex.pages, chunks: ex.chunks, outline: outlineOf(ex.pages), source: 'pdf-text', pageCount: ex.pageCount }
  docs.set(item.itemKey, doc)
  return doc
}
async function findItem(key) {
  const item = lib.items.find((x) => x.itemKey === key)
  if (!item) throw new Error('not found: ' + key)
  return item
}

function problems(value, pathStr = '$', seen = new Set()) {
  const bad = []
  if (value === undefined) { bad.push(`${pathStr} = undefined`); return bad }
  if (typeof value === 'bigint') { bad.push(`${pathStr} = BigInt`); return bad }
  if (typeof value === 'number' && !Number.isFinite(value)) { bad.push(`${pathStr} = ${value}`); return bad }
  if (value && typeof value === 'object') {
    if (seen.has(value)) { bad.push(`${pathStr} = circular`); return bad }
    seen.add(value)
    if (value instanceof Map) bad.push(`${pathStr} = Map`)
    if (value instanceof Set) bad.push(`${pathStr} = Set`)
    for (const [k, v] of Object.entries(value)) bad.push(...problems(v, `${pathStr}.${k}`, seen))
  }
  return bad
}

function check(label, value) {
  const bad = problems(value)
  const json = JSON.stringify(value)
  const lossless = JSON.stringify(JSON.parse(json)) === json
  const ok = bad.length === 0 && lossless
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (json ${json.length} chars, lossless=${lossless})`)
  bad.forEach((b) => console.log('        ', b))
  return ok
}

const search = searchTool(async () => lib)
const read = readTool({ findItem, documentOf })
const ask = askTool({ findItem, documentOf })

let all = true

// 1) search
all = check('search_zotero_library (query)', await search.execute({ query: 'efficient coding', limit: 3 })) && all
all = check('search_zotero_library (empty query)', await search.execute({ limit: 2 })) && all
all = check('search_zotero_library (no match)', await search.execute({ query: 'zzzznotfound' })) && all

// 2) read
const target = lib.items.find((x) => x.itemKey === 'RNGQDXLI') ?? lib.items[0]
all = check('read_zotero_paper (head)', await read.execute({ itemKey: target.itemKey, maxChars: 3000 })) && all
all = check('read_zotero_paper (query)', await read.execute({ itemKey: target.itemKey, query: 'efficient coding' })) && all
all = check('read_zotero_paper (page)', await read.execute({ itemKey: target.itemKey, page: 2 })) && all

// 3) ask
all = check('ask_zotero_paper', await ask.execute({ itemKey: target.itemKey, question: 'what is the model?', topK: 3 })) && all

console.log(all ? '\nALL TOOL OUTPUTS LOSSLESS' : '\nSOME OUTPUTS BROKEN')
