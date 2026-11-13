/**
 * Zotero 本地库只读访问。
 *
 * 设计要点：
 * - 只读复制库文件再查询。Zotero 运行时对 zotero.sqlite 加独占锁，直接打开会
 *   报 SQLITE_BUSY；复制一份（含 -wal/-shm 同目录会被一并读到的状态）再查最稳。
 * - 不引入 sqlite 依赖：Node 22+ 内置 node:sqlite。检测不到就报可读错误。
 * - 附件路径拼法：storage/<附件 item 的 key>/<path 去掉 'storage:' 前缀>。
 *   实测本地 8/8 命中；linked_file 类型（path 以 'attachments:' 开头）单独处理。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Zotero 数据目录候选（按优先级）。 */
const DATA_DIR_CANDIDATES = () => {
  const home = os.homedir()
  return [
    path.join(home, 'Zotero'),
    path.join(home, 'Documents', 'Zotero'),
    'D:\\Zotero',
    'C:\\Zotero',
    path.join(home, 'OneDrive', 'Zotero'),
  ]
}

export async function detectZoteroDataDir(configured) {
  if (configured) {
    const p = configured.trim()
    if (p && fs.existsSync(path.join(p, 'zotero.sqlite'))) return p
    if (p && fs.existsSync(p)) return p
    throw new Error(`配置的 Zotero 数据目录无效：${p}（未找到 zotero.sqlite）`)
  }
  for (const candidate of DATA_DIR_CANDIDATES()) {
    try {
      const st = await fsp.stat(path.join(candidate, 'zotero.sqlite'))
      if (st.isFile()) return candidate
    } catch { /* 继续下一个候选 */ }
  }
  throw new Error(
    '未找到 Zotero 数据目录。请确认已安装 Zotero 桌面版，或在插件设置里指定数据目录'
    + `（当前查找：${DATA_DIR_CANDIDATES().join(' / ')}）。`,
  )
}

/** 加载 node:sqlite；不可用时给出可操作错误。 */
async function openSqlite(file, options) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error('当前 Node 版本不支持内置 node:sqlite（需要 Node 22.5+），无法读取 Zotero 库。')
  }
  return new DatabaseSync(file, options)
}

/**
 * 把 zotero.sqlite 复制到缓存目录，返回副本路径。
 * 原件可能正被 Zotero 独占，复制采用「失败逐个重试」的策略。
 *
 * **源库没变就不重复复制。**
 *
 * 这个库实测 15.7 MB，加上 -wal 又有 15.2 MB，每次复制约 31 MB。
 * 而它原来被调用得极其频繁：每次打开 PDF 都要经 findItem → library()，
 * 库索引一过 TTL 就整份重建，重建的第一步就是这 31 MB 复制。
 * 客户端日志里 `fetch-bytes` 因此从 180ms 剧烈波动到 16 秒 ——
 * 同一篇 PDF，只因为上次读库是 15 秒之前，就要多等十几秒。
 *
 * 判据用「源文件与 -wal 的大小 + 修改时间」：
 *   · 只读打开不会改动快照，所以快照的 mtime 天然比源文件旧；
 *   · -wal 必须一起算 —— Zotero 写入时常只动 wal，主库文件本身不变，
 *     漏掉它就会拿旧快照读到过时数据。
 * 签名存成旁路 .meta.json，和快照同目录，随快照一起失效。
 */
async function snapshotDatabase(dataDir, cacheDir) {
  const src = path.join(dataDir, 'zotero.sqlite')
  await fsp.mkdir(cacheDir, { recursive: true })
  const dst = path.join(cacheDir, 'zotero.snapshot.sqlite')
  const meta = dst + '.meta.json'

  /** 源库指纹：主库与 wal 各自的大小 + 修改时间。 */
  const fingerprint = async () => {
    const parts = []
    for (const f of [src, src + '-wal']) {
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
  try { sig = await fingerprint() } catch { /* 取不到就老老实实复制 */ }

  if (sig && fs.existsSync(dst)) {
    try {
      const saved = JSON.parse(await fsp.readFile(meta, 'utf8'))
      if (saved && saved.sig === sig) return dst
    } catch { /* 没有元数据或损坏 → 重新复制 */ }
  }

  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.copyFile(src, dst)
      // -wal 存在时一并复制，避免读到未 checkpoint 的最新改动
      for (const suffix of ['-wal', '-shm']) {
        const side = src + suffix
        if (fs.existsSync(side)) {
          try { await fsp.copyFile(side, dst + suffix) } catch { /* shm 复制失败无妨 */ }
        }
      }
      /**
       * 元数据必须在复制**之后**写，而且要用复制前的指纹。
       * 先写后复制的话，复制过程中源库又被 Zotero 改动，
       * 就会记下一个对不上实际内容的签名，下次误判为「没变」。
       */
      if (sig) {
        try { await fsp.writeFile(meta, JSON.stringify({ sig }), 'utf8') } catch { /* 写不进去就每次重复制 */ }
      }
      return dst
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)))
    }
  }
  throw new Error(`复制 Zotero 数据库失败：${lastError?.message ?? 'unknown'}`)
}

const FIELD = {
  title: 'title',
  abstract: 'abstractNote',
  date: 'date',
  DOI: 'DOI',
  url: 'url',
  publication: 'publicationTitle',
  journalAbbrev: 'journalAbbreviation',
  volume: 'volume',
  pages: 'pages',
  language: 'language',
  extra: 'extra',
  itemType: 'itemType',
}

/** 主查询：带 PDF 附件的顶层文献 + 常用元数据。 */
const LIST_SQL = `
WITH pdf AS (
  SELECT a.parentItemID AS parentItemID, a.itemID AS attachItemID, a.path AS attPath,
         a.contentType AS contentType, i.key AS attachKey
  FROM itemAttachments a
  JOIN items i ON i.itemID = a.itemID
  WHERE a.contentType = 'application/pdf'
    AND a.parentItemID IS NOT NULL
), meta AS (
  SELECT d.itemID AS itemID, f.fieldName AS fieldName, v.value AS value
  FROM itemData d
  JOIN itemDataValues v ON v.valueID = d.valueID
  JOIN fieldsCombined f ON f.fieldID = d.fieldID
  WHERE f.fieldName IN ('title','abstractNote','date','DOI','publicationTitle','language','url')
)
SELECT i.itemID, i.key, t.typeName,
       MAX(CASE WHEN m.fieldName='title' THEN m.value END) AS title,
       MAX(CASE WHEN m.fieldName='abstractNote' THEN m.value END) AS abstract,
       MAX(CASE WHEN m.fieldName='date' THEN m.value END) AS date,
       MAX(CASE WHEN m.fieldName='DOI' THEN m.value END) AS doi,
       MAX(CASE WHEN m.fieldName='publicationTitle' THEN m.value END) AS publication,
       MAX(CASE WHEN m.fieldName='language' THEN m.value END) AS language,
       MAX(CASE WHEN m.fieldName='url' THEN m.value END) AS url,
       p.attPath, p.attachKey
FROM items i
JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
JOIN pdf p ON p.parentItemID = i.itemID
LEFT JOIN meta m ON m.itemID = i.itemID
LEFT JOIN deletedItems del ON del.itemID = i.itemID
WHERE del.itemID IS NULL
GROUP BY i.itemID
ORDER BY i.dateModified DESC
`

function creatorsFor(db, itemIDs) {
  if (itemIDs.length === 0) return new Map()
  const placeholders = itemIDs.map(() => '?').join(',')
  const sql = `
    SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, ic.orderIndex
    FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
    WHERE ic.itemID IN (${placeholders})
    ORDER BY ic.itemID, ic.orderIndex
  `
  const out = new Map()
  for (const row of db.prepare(sql).all(...itemIDs)) {
    const name = row.fieldMode === 1
      ? (row.lastName || '')
      : [row.firstName, row.lastName].filter(Boolean).join(' ')
    if (!out.has(row.itemID)) out.set(row.itemID, [])
    if (name) out.get(row.itemID).push(name)
  }
  return out
}

/**
 * 读取每篇文献所属的专题**完整路径**。
 *
 * Zotero 的专题是树：collections 表用 parentCollectionID 表达层级。只取 collectionName
 * 会把它拍平成一个长列表（实测 72 个平铺分组，用户看不出哪个属于哪个）。
 * 这里沿 parentCollectionID 一路上溯，拼成 `父 / 子` 的路径，右侧栏就能按原样分两级展开。
 */
function collectionsFor(db, itemIDs) {
  if (itemIDs.length === 0) return new Map()

  // 先把整棵专题树读出来（几百行，一次读完最省事）
  const nodes = new Map()
  for (const row of db.prepare('SELECT collectionID, collectionName, parentCollectionID FROM collections').all()) {
    nodes.set(row.collectionID, {
      name: row.collectionName,
      parent: row.parentCollectionID ?? null,
    })
  }

  const pathCache = new Map()
  const pathOf = (id, guard = 0) => {
    if (pathCache.has(id)) return pathCache.get(id)
    const node = nodes.get(id)
    if (!node || guard > 20) return ''
    const name = String(node.name ?? '').replace(/[\\/]/g, '／')
    const full = node.parent !== null && nodes.has(node.parent)
      ? `${pathOf(node.parent, guard + 1)}/${name}`
      : name
    pathCache.set(id, full)
    return full
  }

  const placeholders = itemIDs.map(() => '?').join(',')
  const sql = `
    SELECT ci.itemID, ci.collectionID
    FROM collectionItems ci
    WHERE ci.itemID IN (${placeholders})
  `
  const out = new Map()
  for (const row of db.prepare(sql).all(...itemIDs)) {
    const full = pathOf(row.collectionID)
    if (!full) continue
    if (!out.has(row.itemID)) out.set(row.itemID, [])
    if (!out.get(row.itemID).includes(full)) out.get(row.itemID).push(full)
  }
  return out
}

/** 把数据库 path 字段解析成本地绝对路径。 */
export function resolveAttachmentPath(dataDir, attachKey, attPath) {
  if (!attPath) return null
  if (attPath.startsWith('storage:')) {
    const filename = attPath.slice('storage:'.length)
    return path.join(dataDir, 'storage', attachKey, filename)
  }
  if (attPath.startsWith('attachments:')) {
    // 链接式附件：相对于 Zotero 设置里的「链接附件根目录」，无法从库里得知，
    // 兜底按数据目录旁的同名目录尝试。
    return path.join(dataDir, attPath.slice('attachments:'.length))
  }
  return path.isAbsolute(attPath) ? attPath : null
}

/**
 * 读取整库文献索引。返回带绝对 PDF 路径的条目数组。
 * 每次调用都重新快照，保证拿到 Zotero 里刚改过的内容；调用方负责缓存。
 */
export async function loadLibrary(config, cacheDir) {
  const dataDir = await detectZoteroDataDir(config.zoteroDataDir)
  const snapshot = await snapshotDatabase(dataDir, cacheDir)
  const db = await openSqlite(snapshot, { readOnly: true })
  try {
    const rows = db.prepare(LIST_SQL).all()
    const ids = rows.map((r) => r.itemID)
    const creators = creatorsFor(db, ids)
    const collections = collectionsFor(db, ids)
    const items = []
    for (const row of rows) {
      const absPath = resolveAttachmentPath(dataDir, row.attachKey, row.attPath)
      const exists = absPath ? fs.existsSync(absPath) : false
      items.push({
        itemKey: row.key,
        /** PDF 附件的 itemKey —— 批注挂在附件上，读写都要用它 */
        attachmentKey: row.attachKey,
        title: row.title ?? '(无标题)',
        abstract: row.abstract ?? '',
        date: row.date ?? '',
        year: (String(row.date ?? '').match(/\d{4}/) ?? [''])[0],
        doi: row.doi ?? '',
        publication: row.publication ?? '',
        language: row.language ?? '',
        url: row.url ?? '',
        itemType: row.typeName ?? '',
        creators: creators.get(row.itemID) ?? [],
        collections: collections.get(row.itemID) ?? [],
        // PDF 是核心：没有可读 PDF 的条目不参与「打开阅读」
        pdfPath: exists ? absPath : null,
        pdfMissing: !exists,
      })
    }
    return { dataDir, items, updatedAt: Date.now() }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * 读取某篇文献的批注。
 *
 * 单独开一次快照、读完就关：批注会随用户在 Zotero 里操作而变，
 * 跟着库索引一起缓存会读到旧数据。
 */
export async function loadAnnotations(config, cacheDir, itemKey, readFn) {
  const dataDir = await detectZoteroDataDir(config.zoteroDataDir)
  const snapshot = await snapshotDatabase(dataDir, cacheDir)
  const db = await openSqlite(snapshot, { readOnly: true })
  try {
    return readFn(db, itemKey)
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * 列表摘要：喂给模型时只给必要字段，避免把整库塞进上下文。
 *
 * 注意：**不能留 undefined 值的字段**。工具的返回值要过宿主的「无损 JSON」校验，
 * 而 `{ missingPdf: undefined }` 一经 JSON 序列化就整个键消失，无法无损往返，
 * 宿主会直接报 `value is not lossless JSON`（实测踩过）。没有值就干脆不给这个键。
 */
export function summarizeItem(item) {
  const out = {
    key: item.itemKey,
    title: item.title,
    authors: item.creators.slice(0, 6),
    year: item.year,
    publication: item.publication,
    collections: item.collections.slice(0, 4),
    hasPdf: Boolean(item.pdfPath),
  }
  if (item.pdfMissing) out.missingPdf = true
  return out
}

/**
 * 只查一条文献——给「打开某篇 PDF」这类只需要 pdfPath 的场景用。
 *
 * 为什么不复用 loadLibrary：那个要跑整库查询（实测 588 条 226ms），
 * 而打开一篇 PDF 时我们只需要一行记录。`findItem` 原来无条件走
 * `library()`，于是每打开一篇就白付一次整库成本，库越大越慢。
 *
 * 这里直接按 key 精确查询，只取附件路径与标题。用同一套快照，
 * 所以不会读到比 loadLibrary 更旧的数据。
 */
export async function loadOneItem(config, cacheDir, itemKey) {
  const key = String(itemKey ?? '').trim()
  if (!key) return null
  const dataDir = await detectZoteroDataDir(config.zoteroDataDir)
  const snapshot = await snapshotDatabase(dataDir, cacheDir)
  const db = await openSqlite(snapshot, { readOnly: true })
  try {
    /**
     * PDF 附件挂在父条目上，所以先按父条目查；也兼容直接传附件 key
     * （调用方有时拿到的是附件 key）。
     */
    const row = db.prepare(`
      SELECT p.key AS itemKey, i2.key AS attachKey, a.path AS attPath,
             t.value AS title, a.contentType AS contentType
      FROM itemAttachments a
      JOIN items i2 ON i2.itemID = a.itemID
      JOIN items p ON p.itemID = COALESCE(a.parentItemID, a.itemID)
      LEFT JOIN itemData d ON d.itemID = p.itemID AND d.fieldID = (
        SELECT fieldID FROM fieldsCombined WHERE fieldName = 'title' LIMIT 1
      )
      LEFT JOIN itemDataValues t ON t.valueID = d.valueID
      WHERE (p.key = ? OR i2.key = ?) AND a.contentType = 'application/pdf'
      LIMIT 1
    `).get(key, key)
    if (!row?.attPath) return null
    const absPath = resolveAttachmentPath(dataDir, row.attachKey, row.attPath)
    if (!absPath || !fs.existsSync(absPath)) return null
    return {
      itemKey: row.itemKey,
      attachmentKey: row.attachKey,
      title: row.title ?? '(无标题)',
      pdfPath: absPath,
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}
