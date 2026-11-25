/**
 * 全文搜索：在已收藏 PDF 的全文里找关键词。
 *
 * ## 数据在哪（实测，不是猜的）
 *
 * 本机 Zotero 7 的结构：
 *
 *   zotero.sqlite 的 `fulltextItems` 表 **只有元数据**，没有正文：
 *     itemID, indexedPages, totalPages, indexedChars, totalChars, version, synced
 *   正文在**独立的 `fulltext.sqlite`** 里（本机 33 MB）：
 *     fulltextContent        FTS5(text, tokenize='unicode61', content='', contentless_delete=1)
 *     fulltextContentCJK     FTS5(text, tokenize='ascii', content='', contentless_delete=1)
 *     fulltextNotes          笔记全文（trigram）
 *     fulltextIndexState     itemID → version
 *
 * 关键结论（都用真实库验证过）：
 *   · FTS 表的 **rowid 就是附件 itemID**（fulltextIndexState.itemID 与 rowid 一一对应）
 *   · 所以结果必须再回 zotero.sqlite 查「附件 itemID → 父条目 key + 标题」
 *   · `fulltextContent`（unicode61）对中文意外地好用：`人因学`、`心理科学进展` 都能命中
 *   · `fulltextContentCJK`（ascii）是 **bigram** 分词：`人因` 命中，但 `人因学`、单字 `的`
 *     都不命中。所以中文查询要拆成 bigram 用 AND 连起来才能精确
 *   · 页码**不在任何表里**。要定位页码只能读附件旁的 `.zotero-ft-cache`
 *     纯文本缓存（实测用 0x0C 换页符分页，13 个分隔符 = 14 页）
 *
 * ## 设计取舍
 *
 * 1. 先查 FTS 拿候选 itemID，再回 zotero.sqlite 补标题/父条目 key —— 顺序不能反，
 *    否则要对整库做全文匹配。
 * 2. 页码用 `.zotero-ft-cache` 反查，**拿不到就给 null 而不是瞎猜**。
 *    前端据此决定要不要显示「第 N 页」跳转。
 * 3. 索引不存在/表缺失时返回 `indexed:false`，不是抛错 ——
 *    「Zotero 还没建全文索引」是正常状态，不是故障。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 载入 node:sqlite，不可用时给可读错误。与 host/zotero.js 保持同一策略。 */
async function openSqlite(file, options) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error('当前 Node 版本不支持内置 node:sqlite（需要 Node 22.5+），无法读取全文索引。')
  }
  return new DatabaseSync(file, options)
}

/**
 * 全文索引文件位置。
 *
 * 它与 zotero.sqlite 同目录（实测本机为 C:\Users\<user>\Zotero\fulltext.sqlite）。
 * 老版本 Zotero（6 早期）没有这个文件，那时全文在 zotero.sqlite 的 fulltextWords 表里，
 * 这里不兼容 —— 遇到就给 indexed:false 并说明原因。
 */
export function fulltextDbPath(dataDir) {
  return path.join(dataDir, 'fulltext.sqlite')
}

/** 判断本地是否有可用的全文索引（只查文件，不打开库）。 */
export function hasFulltextIndex(dataDir) {
  try {
    return fs.statSync(fulltextDbPath(dataDir)).isFile()
  } catch {
    return false
  }
}

/**
 * 复制一份全文索引再查。
 *
 * 理由与 host/zotero.js 的快照一致：Zotero 运行时会对库加锁，
 * 直接打开可能 SQLITE_BUSY。fulltext.sqlite 有 33 MB，复制有成本，
 * 但搜索是用户主动触发的低频操作，可接受。
 */
async function snapshotFulltext(dataDir, cacheDir) {
  const src = fulltextDbPath(dataDir)
  const dst = path.join(cacheDir, 'fulltext.snapshot.sqlite')
  await fsp.mkdir(cacheDir, { recursive: true })

  /** 源库指纹：大小 + mtime。没变就不重复复制 33 MB。 */
  const fingerprint = async () => {
    const parts = []
    for (const f of [src, `${src}-wal`]) {
      try {
        const st = await fsp.stat(f)
        parts.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`)
      } catch {
        parts.push(`${f}:missing`)
      }
    }
    return parts.join('|')
  }

  let sig = null
  try { sig = await fingerprint() } catch { /* 取不到就老实复制 */ }
  const meta = `${dst}.meta.json`
  if (sig && fs.existsSync(dst)) {
    try {
      const saved = JSON.parse(await fsp.readFile(meta, 'utf8'))
      if (saved?.sig === sig) return dst
    } catch { /* 元数据坏了就重新复制 */ }
  }

  await fsp.copyFile(src, dst)
  for (const suffix of ['-wal', '-shm']) {
    const side = `${src}${suffix}`
    if (fs.existsSync(side)) {
      try { await fsp.copyFile(side, `${dst}${suffix}`) } catch { /* shm 失败无妨 */ }
    }
  }
  if (sig) {
    // 元数据必须在复制**之后**写，且用复制前的指纹（与 zotero.js 同一考量）
    try { await fsp.writeFile(meta, JSON.stringify({ sig }), 'utf8') } catch { /* 写不进去就每次重复制 */ }
  }
  return dst
}

/* --------------------------------------------------------- 查询构造 */

/**
 * 判断查询里是否含 CJK 字符。
 *
 * 有 CJK 才需要走 bigram 构造；纯英文直接交给 unicode61 就行。
 */
export function hasCJK(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(String(text ?? ''))
}

/**
 * 把中文串拆成 bigram。
 *
 * 为什么必须拆：CJK 表用 `tokenize='ascii'`，它对中文实际按**双字**建索引
 * （实测 `人因` 命中、`人因学` 和单字 `的` 都不命中）。
 * 所以「人因学」要写成 `"人因" AND "因学"` 才能精确匹配。
 */
export function toBigrams(text) {
  const out = []
  const seen = new Set()
  const runs = String(text ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g) ?? []
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!seen.has(gram)) { seen.add(gram); out.push(gram) }
    }
  }
  return out
}

/**
 * 转义 FTS5 查询词。
 *
 * FTS5 的 MATCH 语法里 `"` `*` `(` `)` `-` `:` 都有含义，用户随手输入一个
 * 未闭合的引号会让整条查询抛 `unterminated string`。这里一律包成双引号短语，
 * 内部的双引号按 FTS5 规则转义成两个。
 */
export function escapeFtsTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`
}

/**
 * 构造 FTS5 MATCH 表达式。
 *
 * 返回 `{ expr, mode }`：
 *   · 含 CJK 且长度 > 2 → bigram AND（对 CJK 表精确）
 *   · 其它             → 原样短语（对 unicode61 表）
 *
 * 多个词之间用 AND：用户的直觉是「都要包含」，OR 会让「人因学 发展」把
 * 只提到「发展」的几百篇都拉出来。
 */
export function buildMatchExpr(query) {
  const raw = String(query ?? '').trim()
  if (!raw) return { expr: '', mode: 'empty' }

  // 拆词：中英文、数字都算词；标点当分隔符
  const terms = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (terms.length === 0) return { expr: '', mode: 'empty' }

  const parts = []
  let usedBigram = false
  for (const term of terms) {
    if (hasCJK(term) && term.length > 2) {
      const grams = toBigrams(term)
      if (grams.length > 0) {
        usedBigram = true
        // 每个 bigram 单独成短语，之间 AND
        parts.push(grams.map(escapeFtsTerm).join(' AND '))
        continue
      }
    }
    parts.push(escapeFtsTerm(term))
  }

  const expr = parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' AND ')
  return { expr, mode: usedBigram ? 'bigram' : 'phrase' }
}

/* ------------------------------------------------------------ 搜索 */

/**
 * 在本地全文索引里搜索。
 *
 * @param {object} options
 * @param {string} options.dataDir    Zotero 数据目录（含 fulltext.sqlite）
 * @param {string} options.cacheDir   快照缓存目录
 * @param {string} options.query      查询词
 * @param {number} [options.limit=50] 最多返回多少条
 * @param {object} options.zoteroDb    可选的已打开 zotero.sqlite 连接（补标题用）
 * @returns {Promise<{indexed:boolean, results:Array, total:number, reason?:string}>}
 */
export async function searchFulltext(options = {}) {
  const { dataDir, cacheDir, query, limit = 50 } = options
  const raw = String(query ?? '').trim()

  if (!raw) {
    return { indexed: true, results: [], total: 0, reason: '查询词为空' }
  }

  // 索引不存在是正常状态（用户可能从没打开过这些 PDF），不是错误
  if (!hasFulltextIndex(dataDir)) {
    return {
      indexed: false,
      results: [],
      total: 0,
      reason: `没有找到 Zotero 全文索引（${fulltextDbPath(dataDir)}）。在 Zotero 里打开过 PDF 后它才会生成。`,
    }
  }

  const { expr, mode } = buildMatchExpr(raw)
  if (!expr) {
    return { indexed: true, results: [], total: 0, reason: '查询词里没有可搜索的内容' }
  }

  const snapshot = await snapshotFulltext(dataDir, cacheDir)
  const db = await openSqlite(snapshot, { readOnly: true })
  try {
    const available = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    )
    /**
     * 老版 Zotero 没有这两张 FTS 表（或索引损坏）。这种情况回 indexed:false 并说明，
     * 而不是让 SQL 抛 `no such table` 变成 500。
     */
    if (!available.has('fulltextContent') && !available.has('fulltextContentCJK')) {
      return {
        indexed: false,
        results: [],
        total: 0,
        reason: 'Zotero 全文索引里没有可搜索的表（可能版本过旧或索引已损坏）。可在 Zotero 设置 → 高级 → 重建索引。',
      }
    }

    /**
     * 两个索引都查，结果合并。
     *
     * 为什么不能只用一个：
     *   · unicode61 对中文实测可用，且对英文正确
     *   · CJK 表专门为中文建 bigram，中文精确匹配更好
     * 只查一个都会漏。合并按 itemID 去重，命中次数累加作为粗略相关度。
     */
    const hits = new Map()
    const run = (table, expression) => {
      if (!available.has(table)) return
      let rows
      try {
        rows = db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT ?`).all(expression, limit * 4)
      } catch {
        // 单个索引查询失败（表达式与分词器不兼容）不该让整个搜索失败
        return
      }
      for (const row of rows) {
        const id = Number(row.rowid)
        if (!Number.isFinite(id)) continue
        hits.set(id, (hits.get(id) ?? 0) + 1)
      }
    }

    // unicode61 用原短语；CJK 用 bigram 构造
    run('fulltextContent', expr)
    if (mode === 'bigram' || hasCJK(raw)) {
      run('fulltextContentCJK', expr)
      // CJK 表对纯英文词也可能有内容，用短语形式再查一次
      if (mode === 'bigram') run('fulltextContentCJK', raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(escapeFtsTerm).join(' AND '))
    }

    if (hits.size === 0) {
      return { indexed: true, results: [], total: 0 }
    }

    // 按命中次数排序，取前 limit
    const ordered = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)

    const meta = await resolveItems(dataDir, cacheDir, ordered.map(([id]) => id), options)
    const results = []
    for (const [attachItemID, score] of ordered) {
      const info = meta.get(attachItemID)
      if (!info) continue
      results.push({
        itemKey: info.itemKey,
        attachmentKey: info.attachmentKey,
        title: info.title,
        page: null,           // 页码需要读 ft-cache，见 locatePages
        snippet: '',
        score,
        indexed: true,
      })
    }

    return { indexed: true, results, total: results.length }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * 附件 itemID → 父条目 key / 标题。
 *
 * 必须回 zotero.sqlite 查：fulltext.sqlite 只存正文和 itemID，没有任何书目信息。
 */
async function resolveItems(dataDir, cacheDir, attachItemIDs, options = {}) {
  const out = new Map()
  if (attachItemIDs.length === 0) return out

  let db = options.zoteroDb
  let own = false
  if (!db) {
    const { openZoteroSnapshot } = await import('./zotero.js')
    db = await openZoteroSnapshot(dataDir, cacheDir)
    own = true
  }
  try {
    const placeholders = attachItemIDs.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT a.itemID AS attachItemID, i.key AS attachmentKey,
             p.key AS itemKey, t.value AS title
      FROM itemAttachments a
      JOIN items i ON i.itemID = a.itemID
      LEFT JOIN items p ON p.itemID = COALESCE(a.parentItemID, a.itemID)
      LEFT JOIN itemData d ON d.itemID = p.itemID AND d.fieldID = (
        SELECT fieldID FROM fieldsCombined WHERE fieldName = 'title' LIMIT 1
      )
      LEFT JOIN itemDataValues t ON t.valueID = d.valueID
      WHERE a.itemID IN (${placeholders})
    `).all(...attachItemIDs)
    for (const row of rows) {
      out.set(row.attachItemID, {
        itemKey: row.itemKey ?? '',
        attachmentKey: row.attachmentKey ?? '',
        title: row.title ?? '(无标题)',
      })
    }
  } finally {
    if (own) { try { db.close() } catch { /* ignore */ } }
  }
  return out
}

/* --------------------------------------------------------- 页码定位 */

/**
 * 读 `.zotero-ft-cache` 并定位关键词所在页。
 *
 * 页码**不在数据库里**，只在这个纯文本缓存里：Zotero 用它存抽取出来的正文，
 * 页与页之间用换页符 `\f`(0x0C) 分隔。
 *
 * **重要限制（实测）**：本机 645 个 ft-cache 里，424 个带换页符、**221 个一个都没有**
 * （英文 PDF 居多 —— Zotero 对部分文档抽取时不分页，整篇被当成一段）。
 * 对这类文件「第 1 页」是**假的**：关键词可能在第 12 页，但缓存里根本没有页边界。
 * 所以没有换页符时返回 `page: null` 并标 `paged: false`，让前端老实说「无法定位页码」，
 * 而不是给一个看起来精确、实际会把人带到错误页的数字。
 *
 * 返回 `{ page, snippet, paged }`；找不到就给 `page: null`。
 * 页号从 1 开始（与阅读器一致）。
 */
export function locateInFtCache(text, query, contextChars = 90) {
  const raw = String(query ?? '').trim()
  if (!text || !raw) return { page: null, snippet: '', paged: false }

  // 用第一个词定位：多词查询里第一个词最可能出现在目标页
  const needle = (raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0] ?? raw).toLowerCase()
  if (!needle) return { page: null, snippet: '', paged: false }

  const source = String(text)
  // 没有换页符 = 这篇的缓存不分页，页码无从谈起
  const paged = source.includes('\f')
  const pages = source.split('\f')

  for (let i = 0; i < pages.length; i += 1) {
    const idx = pages[i].toLowerCase().indexOf(needle)
    if (idx < 0) continue
    const start = Math.max(0, idx - contextChars)
    const end = Math.min(pages[i].length, idx + needle.length + contextChars)
    const snippet = pages[i]
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim()
    // 不分页时 page 必须是 null：给 1 会让前端跳到一个不相关的页
    return { page: paged ? i + 1 : null, snippet, paged }
  }
  return { page: null, snippet: '', paged }
}

/** 读附件目录下的 .zotero-ft-cache；没有就返回 null。 */
export async function readFtCache(dataDir, attachmentKey) {
  if (!attachmentKey) return null
  const file = path.join(dataDir, 'storage', String(attachmentKey), '.zotero-ft-cache')
  try {
    return await fsp.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 给搜索结果补页码与摘要。
 *
 * 单独一步而不是塞进 searchFulltext：读 ft-cache 是文件 IO，
 * 用户可能只要列表不要页码，分开便于按需调用。
 */
export async function enrichWithPages(dataDir, results, query) {
  const out = []
  for (const item of results) {
    const text = await readFtCache(dataDir, item.attachmentKey)
    const located = text ? locateInFtCache(text, query) : { page: null, snippet: '', paged: false }
    out.push({ ...item, page: located.page, snippet: located.snippet, paged: located.paged })
  }
  return out
}
