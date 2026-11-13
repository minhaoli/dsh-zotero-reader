/**
 * Zotero 批注（高亮 / 备注）的读写。
 *
 * 两条路，各有明确边界：
 *
 * **读** —— 走数据库快照。批注存在 itemAnnotations 表里，position 字段是 JSON
 * （pageIndex + rects），正是渲染高亮所需的坐标。快照读不会影响运行中的 Zotero。
 *
 * **写** —— 走 Zotero 本地 API（127.0.0.1:23119）。
 * 为什么不直接写 sqlite：Zotero 运行时独占数据库，绕过它写会让内存状态、索引、同步
 * 三者不一致；而且直接写库不会同步到 zotero.org。走本地 API 则由 Zotero 自己完成
 * 校验、索引与同步，与用户在界面里加批注完全等价。
 *
 * 版本要求：本地 API 的**写入**是 Zotero 10+ 才有的（7/8 只读），并且需要一次授权
 * 确认。所以这里的策略是：能读永远可用；写入失败时给出可照做的原因，不静默失败。
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

export const LOCAL_API = 'http://127.0.0.1:23119'

/** Zotero 的批注类型编号（来自 schema）。 */
const ANNOTATION_TYPES = { 1: 'highlight', 2: 'note', 3: 'image', 4: 'ink', 5: 'underline', 6: 'text' }

/** Zotero 官方提供的几种荧光色，用于前端选色。 */
export const HIGHLIGHT_COLORS = [
  { value: '#ffd400', label: '黄' },
  { value: '#ff6666', label: '红' },
  { value: '#5fb236', label: '绿' },
  { value: '#2ea8e5', label: '蓝' },
  { value: '#a28ae5', label: '紫' },
  { value: '#e56eee', label: '品红' },
  { value: '#f19837', label: '橙' },
  { value: '#aaaaaa', label: '灰' },
]

/**
 * 从快照库读某篇文献的所有批注。
 * @param {object} db  已打开的 node:sqlite DatabaseSync
 * @param {string} parentItemKey 文献（父条目）的 itemKey
 * @returns {Array} 批注数组，按页排序
 */
/**
 * 从快照库读某篇文献的所有批注。
 *
 * 关键：批注挂在 **PDF 附件**条目上，不是文献条目（实测 parentItemID 全是 attachment）。
 * 所以这里先按文献 key 找到它的附件，再按附件 id 查批注 —— 直接用文献 key 查会一条都查不到。
 *
 * @param {object} db  已打开的 node:sqlite DatabaseSync
 * @param {string} itemKey 文献（父条目）的 itemKey；也接受附件 key
 * @returns {{annotations:Array, attachmentKey:string|null}}
 */
export function readAnnotations(db, itemKey) {
  const row = db.prepare('SELECT itemID, itemTypeID FROM items WHERE key = ?').get(itemKey)
  if (!row) return { annotations: [], attachmentKey: null }

  // 判断传进来的是文献还是附件：是附件就直接用，是文献就找它的 PDF 附件
  let attachmentId = null
  let attachmentKey = null

  const selfAtt = db.prepare(`
    SELECT a.itemID, i.key, a.contentType
    FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
    WHERE a.itemID = ?
  `).get(row.itemID)

  if (selfAtt && selfAtt.contentType === 'application/pdf') {
    attachmentId = selfAtt.itemID
    attachmentKey = selfAtt.key
  } else {
    const att = db.prepare(`
      SELECT a.itemID, i.key
      FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
      WHERE a.parentItemID = ? AND a.contentType = 'application/pdf'
      LIMIT 1
    `).get(row.itemID)
    if (att) {
      attachmentId = att.itemID
      attachmentKey = att.key
    }
  }

  if (!attachmentId) return { annotations: [], attachmentKey: null }

  const rows = db.prepare(`
    SELECT a.itemID, a.type, a.text, a.comment, a.color, a.pageLabel, a.sortIndex, a.position, i.key
    FROM itemAnnotations a
    JOIN items i ON i.itemID = a.itemID
    LEFT JOIN deletedItems d ON d.itemID = a.itemID
    WHERE a.parentItemID = ? AND d.itemID IS NULL
    ORDER BY a.sortIndex
  `).all(attachmentId)

  const out = []
  for (const r of rows) {
    let pos = null
    try { pos = r.position ? JSON.parse(r.position) : null } catch { pos = null }
    let tags = []
    /**
     * 这条批注的标签。
     *
     * Zotero 的标签是 item 级的：`itemTags(itemID, tagID)` 关联到 `tags(tagID, name)`。
     * 逐行单独查（不在主查询里 GROUP_CONCAT）：标签名可能含逗号，
     * 拼成字符串再拆会拆错，直接拿数组更稳。一条批注通常 0-3 个标签，开销可忽略。
     */
    try {
      tags = db.prepare(`
        SELECT t.name
        FROM itemTags it JOIN tags t ON t.tagID = it.tagID
        WHERE it.itemID = ?
        ORDER BY t.name
      `).all(r.itemID).map((x) => x.name).filter(Boolean)
    } catch { /* 结构差异：没标签就当空数组，不影响其它字段 */ }

    out.push({
      key: r.key,
      type: ANNOTATION_TYPES[r.type] ?? 'highlight',
      text: r.text ?? '',
      comment: r.comment ?? '',
      color: r.color ?? '#ffd400',
      tags,
      // pageLabel 在 Zotero 里就是用户看到的页码；缺失时退回 pageIndex+1
      page: r.pageLabel ? Number(r.pageLabel) : (pos?.pageIndex !== undefined ? pos.pageIndex + 1 : null),
      pageIndex: pos?.pageIndex ?? null,
      // rects 是 PDF 坐标（左下原点），前端换算到画布坐标
      rects: Array.isArray(pos?.rects) ? pos.rects : [],
      sortIndex: r.sortIndex ?? '',
    })
  }
  return { annotations: out, attachmentKey }
}

/* --------------------------------------------------------------- 写入 */

/**
 * 探测本地 API 是否可用。
 * 返回 { available, writable, version?, reason? }，让前端能解释「为什么不能加批注」。
 */
export async function probeLocalApi(timeoutMs = 2500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${LOCAL_API}/api/`, {
      headers: { 'Zotero-API-Version': '3' },
      signal: controller.signal,
    })
    const versionHeader = res.headers.get('Zotero-API-Version') ?? ''
    const serverId = res.headers.get('Zotero-Server-ID') ?? ''
    if (res.status === 403) {
      return {
        available: false,
        writable: false,
        reason: 'Zotero 本地 API 未启用。请在 Zotero 里打开：设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」，然后重开 Zotero。',
      }
    }
    return {
      available: res.ok || res.status < 500,
      // 写入需要 Zotero 10+ 与一次授权；这里只报「可能可写」，真正的判定在写入时
      writable: Boolean(serverId),
      versionHeader,
      serverId,
    }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? ''
    /**
     * 真正把错误码和 cause 带出来。
     *
     * 之前所有失败都被渲染成「连不上…可能是 Zotero 没打开」，
     * 而这个判断只在 ECONNREFUSED 时成立。实测（Node 直接跑同一个函数）
     * /api/ 返回 200 且 serverId 正常，说明宿主进程里的失败另有原因，
     * 但被这句笼统文案盖住了 —— 用户照着提示去勾设置，永远不会好。
     */
    const detail = [code, error?.message].filter(Boolean).join(' / ')
    return {
      available: false,
      writable: false,
      code,
      detail,
      reason: code === 'ECONNREFUSED'
        ? '连不上 Zotero 的本地服务（127.0.0.1:23119）。可能是 Zotero 没打开，或本地 API 未启用：Zotero → 设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」，然后重启 Zotero。'
        : `连接 Zotero 本地 API 失败：${String(detail || error || '未知错误').slice(0, 240)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 写入密钥：内存缓存 + 磁盘持久化。
 *
 * 为什么需要缓存：Zotero 的 `/api/local/authorize` 每调一次都会**弹一次确认框**，
 * 即使用户勾了「始终允许」也一样 —— 它记住的是「这个 app 曾获授权」，但不会
 * 把上一次的 key 还给你。
 *
 * 实测（连调两次 authorize）：
 *   · 每次返回的 key 都不同
 *   · 但**旧 key 依然有效**（用第一次的 key 写入返回 400 "No items provided"，
 *     而不是 401，说明鉴权是通过的）
 *
 * 只放内存不够：宿主一重启变量就没了，于是每次重启又弹一次授权 ——
 * 这正是「每次重启都在用新 key」的原因。所以落盘到插件数据目录，
 * 下次启动直接复用，直到 Zotero 那边返回 401。
 */
let cachedApiKey = null
let cachedServerId = null
/** 由 apply() 注入：返回密钥文件的绝对路径（没有数据目录时为 null）。 */
let apiKeyStorePath = null

/** 注入持久化位置。 */
export function setApiKeyStore(filePath) {
  apiKeyStorePath = filePath || null
}

async function loadPersistedApiKey(serverId) {
  if (!apiKeyStorePath) return null
  try {
    const raw = await fsp.readFile(apiKeyStorePath, 'utf8')
    const saved = JSON.parse(raw)
    // serverId 必须一致：Zotero 换了实例，旧 key 必然无效
    if (saved?.serverId === serverId && typeof saved?.key === 'string' && saved.key) {
      return saved.key
    }
  } catch { /* 文件不存在或损坏，按没有处理 */ }
  return null
}

async function persistApiKey(serverId, key) {
  if (!apiKeyStorePath) return
  try {
    await fsp.mkdir(path.dirname(apiKeyStorePath), { recursive: true })
    await fsp.writeFile(apiKeyStorePath, JSON.stringify({ serverId, key, savedAt: new Date().toISOString() }), 'utf8')
  } catch { /* 写不了就只保留内存缓存，不影响功能 */ }
}

async function ensureApiKey(serverId) {
  // serverId 变了说明 Zotero 重启过，旧 key 不再可信
  if (cachedApiKey && cachedServerId === serverId) {
    return { ok: true, key: cachedApiKey }
  }
  /**
   * 先试磁盘上存下来的 key。
   *
   * 这是「每次重启都换新 key」的解法：内存缓存活不过宿主重启，
   * 而落盘的 key 只要 Zotero 实例没变就仍然有效（serverId 校验过）。
   * 真失效了，后面的写入会收到 401，那时 invalidateApiKey() 清掉再重申请。
   */
  const persisted = await loadPersistedApiKey(serverId)
  if (persisted) {
    cachedApiKey = persisted
    cachedServerId = serverId
    return { ok: true, key: persisted, restored: true }
  }
  try {
    const authRes = await fetch(`${LOCAL_API}/api/local/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
      body: JSON.stringify({ appName: 'DSH Zotero Reader' }),
    })
    if (authRes.status === 403) {
      const body = await authRes.json().catch(() => ({}))
      if (body?.denied) return { ok: false, reason: '你在 Zotero 里拒绝了这次写入授权。再点一次可以重新申请。' }
      return { ok: false, reason: `Zotero 拒绝了写入授权（403）。${body?.message ?? ''}` }
    }
    if (authRes.status === 429) {
      return { ok: false, reason: '短时间内授权请求过多，请在 Zotero 里操作一次后再试。' }
    }
    if (!authRes.ok) {
      const detail = await authRes.text().catch(() => '')
      return { ok: false, reason: `申请 Zotero 写入授权失败（${authRes.status}）${detail ? `：${detail.slice(0, 160)}` : ''}` }
    }
    const authBody = await authRes.json()
    const key = authBody?.key
    if (!key) return { ok: false, reason: 'Zotero 未返回写入密钥' }
    cachedApiKey = key
    cachedServerId = serverId
    // 落盘，下次宿主重启直接复用，不再弹授权
    await persistApiKey(serverId, key)
    return { ok: true, key }
  } catch (error) {
    return { ok: false, reason: `申请写入授权时连接失败：${error?.message ?? error}` }
  }
}

/** key 失效时清掉缓存，下次调用会重新申请。 */
function invalidateApiKey() {
  cachedApiKey = null
  cachedServerId = null
}

/**
 * 向 Zotero 写入一条高亮 / 备注。
 *
 * 流程按 Zotero 10 文档：
 *   1. 取 Zotero-Server-ID（每个写入请求都要求）
 *   2. POST /api/local/authorize 申请一次性写入密钥（用户会看到确认框）
 *   3. POST /api/users/0/items 创建批注条目，带 Zotero-API-Key
 *
 * @returns {{ok:true, key:string}|{ok:false, reason:string, needAuth?:boolean}}
 */
export async function createAnnotation(options) {
  const {
    parentItemKey,
    attachmentKey,
    text,
    comment = '',
    color = '#ffd400',
    pageIndex = 0,
    rects = [],
    pageLabel,
    sortIndex,
    /** 该页在 PDF 里的高度（pt）。sortIndex 第三段要用它算「距页面底部的距离」。 */
    pageHeightPt,
    /**
     * 批注类型：highlight / underline / freetext / ink。
     *
     * Zotero 的 annotationType 是枚举字符串，编辑器新建的批注可能不是高亮，
     * 一律写成 highlight 会让文字批注和涂鸦在 Zotero 里显示成高亮。
     * 没有 text 的（涂鸦）用 note，避免 Zotero 报「高亮必须有文字」。
     */
    annotationKind,
  } = options

  /**
   * 归一化批注类型。
   * Zotero 只接受这几个值：highlight / underline / note / text / image / ink。
   */
  const zoteroType = (() => {
    const wanted = String(annotationKind || 'highlight').toLowerCase()
    if (wanted === 'ink') return 'ink'
    /**
     * 便签：统一用 `note`。
     *
     * `text`（自由文字）在 Zotero 里需要 fontSize/rotation 等额外字段，
     * 而且它在页面上是一块可编辑文字框，与「点一下留个便条」的语义不同；
     * note 才是 Zotero 阅读器里那个 22pt 的小方块角标。
     */
    if (wanted === 'freetext' || wanted === 'note') return 'note'
    if (wanted === 'underline') return 'underline'
    return 'highlight'
  })()

  const probe = await probeLocalApi()
  if (!probe.available) return { ok: false, reason: probe.reason }
  if (!probe.serverId) {
    return {
      ok: false,
      needAuth: true,
      reason: '当前 Zotero 不支持本地写入（需要 Zotero 10 及以上）。可以先在 Zotero 里手动加批注，或升级 Zotero。',
    }
  }

  const serverId = probe.serverId

  // 1) 取写入密钥（复用缓存，避免每次都弹 Zotero 确认框）
  const authResult = await ensureApiKey(serverId)
  if (!authResult.ok) return { ok: false, reason: authResult.reason }
  const apiKey = authResult.key

  /**
   * 位置与排序索引。
   *
   * Zotero 对 `annotationSortIndex` 做**正则校验**（item.js 的 sortIndex setter）：
   *   PDF 附件必须是 `/^\d{5}\|\d{6}\|\d{5}$/`
   * 格式不对会抛 `Invalid sortIndex`，整条批注被拒。
   *
   * 三段语义照抄 reader.js 的 getSortIndex()：
   *   ① pageIndex（**0 基**，左补零 5 位）
   *   ② 字符偏移（6 位）—— 需要文本层字符表才能算，宿主侧没有，用 0
   *   ③ `Math.floor(pageHeight - rectTop)`（5 位）—— 视觉上「距页面顶部的距离」
   *
   * 之前这里写的是 `pageIndex+1` 与 `topY*100 / leftX*100`：
   * 前者让每条批注的页码都大 1（排序错位），后者在 x>10pt 后变成 6 位数，
   * 直接让正则不匹配 —— 也就解释了为什么部分批注明明走到了写入却回不出 key。
   */
  const position = { pageIndex, rects }
  const firstRect = Array.isArray(rects[0]) ? rects[0] : [0, 0, 0, 0]
  const rectTop = Number(firstRect[3]) || 0
  /**
   * 「距页面顶部」的距离。缺 pageHeightPt 时（前端没传、或页尺寸未知）
   * 退化为 rectTop 取整 —— 量级仍在 5 位内，Zotero 至少能接受。
   */
  const fromTop = Number.isFinite(Number(pageHeightPt)) && Number(pageHeightPt) > rectTop
    ? Math.floor(Number(pageHeightPt) - rectTop)
    : Math.floor(rectTop)
  const derivedSortIndex = [
    String(Math.max(0, Math.trunc(pageIndex))).slice(0, 5).padStart(5, '0'),
    '0'.padStart(6, '0'),
    String(Math.max(0, fromTop)).slice(0, 5).padStart(5, '0'),
  ].join('|')

  /**
   * `annotationText` 只对 highlight / underline 合法
   * （item.js：`'annotationText' can only be set for highlight and underline annotations`）。
   * note / text 型写 text 会被 Zotero 直接抛异常，所以便签的文字走 annotationComment。
   */
  const acceptsText = zoteroType === 'highlight' || zoteroType === 'underline'
  const payloadText = acceptsText ? text : ''

  const payload = [{
    itemType: 'annotation',
    parentItem: attachmentKey,
    annotationType: zoteroType,
    annotationText: payloadText,
    annotationComment: comment || (acceptsText ? '' : text) || '',
    annotationColor: color,
    annotationPageLabel: String(pageLabel ?? pageIndex + 1),
    annotationSortIndex: sortIndex ?? derivedSortIndex,
    annotationPosition: JSON.stringify(position),
  }]

  try {
    const res = await fetch(`${LOCAL_API}/api/users/0/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Zotero-API-Version': '3',
        'Zotero-Server-ID': serverId,
        'Zotero-API-Key': apiKey,
      },
      body: JSON.stringify(payload),
    })
    const bodyText = await res.text()
    if (res.status === 401) {
      // 缓存的 key 失效了（Zotero 重启或权限被撤销）：清掉，下次重申请
      invalidateApiKey()
      return { ok: false, needAuth: true, reason: 'Zotero 写入密钥已失效，请再点一次（会重新弹授权框）。' }
    }
    if (!res.ok) {
      let detail = bodyText
      try {
        const j = JSON.parse(bodyText)
        detail = j?.failed?.['0']?.message ?? j?.message ?? bodyText
      } catch { /* 原样 */ }
      return { ok: false, reason: `Zotero 写入失败（${res.status}）：${String(detail).slice(0, 220)}` }
    }
    /**
     * **不能**把 HTTP 200 当成写入成功。
     *
     * Zotero 的批量写接口即使某条创建失败，也常返回 200，真正的结果在 body 里：
     *   { success: { "0": "NEWKEY" }, failed: { "0": { message: "..." } } }
     * 之前这里只检查 res.ok 就直接返回 ok:true，于是创建失败时界面仍报
     * 「已保存到 Zotero」，而库里一条都没有（实测确认：最近批注停在 10 月 18 日）。
     *
     * 现在必须能从 success 里取到真实 key 才算成功；否则把 failed 的 message 抛上去。
     */
    /**
     * 解析 Zotero 的批量写响应。
     *
     * 形如：{ success: { "0": "NEWKEY" }, failed: {} }
     * 注意 `failed` 在**成功时是一个空对象**，不是 undefined ——
     * 之前写成 `parsed?.failed?.['0'] ?? parsed?.failed`，空对象 {} 是真值，
     * 于是每次成功都被判成「Zotero 拒绝创建批注：{}」。
     * 用户看到的就是「报错说拒绝，其实已经建好了」。
     * 所以这里必须先判断 success，并且只在 failed 里真的有 '0' 条目时才算失败。
     */
    let parsed
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { ok: false, reason: `Zotero 返回了无法解析的响应：${bodyText.slice(0, 200)}` }
    }

    const successEntry = parsed?.success?.['0'] ?? parsed?.successful?.['0']
    const failedEntry = parsed?.failed?.['0']

    // 真正拿到了 key 就是成功，不管 failed 是不是空对象
    if (successEntry) {
      const key = typeof successEntry === 'string' ? successEntry : (successEntry?.key ?? null)
      if (key) return { ok: true, key }
    }

    // 只有 failed 里确实有这一条时才算失败
    if (failedEntry) {
      const message = typeof failedEntry === 'string'
        ? failedEntry
        : (failedEntry?.message ?? JSON.stringify(failedEntry))
      return { ok: false, reason: `Zotero 拒绝创建批注：${String(message).slice(0, 220)}` }
    }

    /**
     * 既没成功也没失败 —— 这不是「创建成功」的形态。
     * 宁可报错也不要假成功：假成功会让用户以为标注好了，实际丢了。
     */
    return {
      ok: false,
      reason: `Zotero 未确认写入（响应里没有 success）：${bodyText.slice(0, 200)}`,
    }
  } catch (error) {
    const detail = [error?.cause?.code, error?.message].filter(Boolean).join(' / ')
    return { ok: false, reason: `写入 Zotero 时连接失败：${String(detail || error).slice(0, 240)}` }
  }
}

/** 删除一条批注（按 key）。 */
export async function deleteAnnotation(annotationKey) {
  const probe = await probeLocalApi()
  if (!probe.available) return { ok: false, reason: probe.reason }
  const serverId = probe.serverId
  if (!serverId) return { ok: false, needAuth: true, reason: '当前 Zotero 不支持本地写入（需要 Zotero 10+）。' }

  try {
    // 复用缓存的 key（与创建共用），避免删除时又弹一次授权框
    const authResult = await ensureApiKey(serverId)
    if (!authResult.ok) return { ok: false, reason: authResult.reason }
    const apiKey = authResult.key

    const res = await fetch(`${LOCAL_API}/api/users/0/items/${annotationKey}`, {
      method: 'DELETE',
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-Server-ID': serverId,
        'Zotero-API-Key': apiKey,
        ...(await currentVersion(annotationKey, apiKey, serverId)),
      },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: `删除失败（${res.status}）：${detail.slice(0, 180)}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `删除时连接失败：${error?.message ?? error}` }
  }
}

/** 合法的批注颜色：`#` + 6 位十六进制。 */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * 改一条已有批注的颜色。
 *
 * 走 PATCH `/api/users/0/items/<annotationKey>`，body 只带 `annotationColor` ——
 * Zotero 的 PATCH 是局部更新，没提到的字段保持原样，所以不会碰文字和坐标。
 *
 * 写法和删除保持一致：先探测本地 API，再复用缓存的写入密钥，
 * 最后带 `If-Unmodified-Since-Version` 做乐观并发。
 * 版本号取不到时不带这个头（让 Zotero 直接写），而不是拒绝执行 ——
 * 改颜色是幂等的低风险操作，读版本失败不该让用户改不了颜色。
 *
 * @param {string} annotationKey 批注条目 key
 * @param {string} color 形如 `#ff6666`
 * @returns {{ok:true,color:string}|{ok:false, reason:string, needAuth?:boolean}}
 */
export async function updateAnnotationColor(annotationKey, color) {
  const r = await updateAnnotation(annotationKey, { color })
  return r.ok ? { ok: true, color: r.patch?.color } : r
}

/**
 * 改一条已有批注的若干字段（颜色 / 评论 / 标签，可同时传）。
 *
 * 和 updateAnnotationColor 走同一条 PATCH，只是 body 不止一个字段。
 * Zotero 的 PATCH 是**局部更新**：没提到的字段保持原样，
 * 所以只改评论时不必回传颜色和坐标。
 *
 * 字段映射（Zotero item 的 JSON 字段名）：
 *   color   → annotationColor
 *   comment → annotationComment
 *   tags    → tags: [{tag}, ...]
 *
 * @param {string} annotationKey
 * @param {{color?:string, comment?:string, tags?:string[]|{tag:string}[]}} patch
 * @returns {{ok:true, patch:object}|{ok:false, reason:string, needAuth?:boolean}}
 */
export async function updateAnnotation(annotationKey, patch = {}) {
  const key = String(annotationKey ?? '').trim()
  if (!key) return { ok: false, reason: '缺少批注 key' }

  const body = {}

  if (patch.color !== undefined && patch.color !== null && patch.color !== '') {
    // 统一小写：Zotero 里存的是小写十六进制，大小写混用会让前端颜色比较失效
    const nextColor = String(patch.color).trim().toLowerCase()
    if (!COLOR_RE.test(nextColor)) {
      return { ok: false, reason: `颜色格式不对（要 #rrggbb）：${String(patch.color).slice(0, 40)}` }
    }
    body.annotationColor = nextColor
  }

  if (patch.comment !== undefined && patch.comment !== null) {
    /**
     * 评论可以是空串 —— 那是「清空评论」这个合法操作，不能当成「没传」。
     * 所以在判断里用 `!== undefined` 而不是真值判断。
     */
    body.annotationComment = String(patch.comment)
  }

  if (patch.tags !== undefined && patch.tags !== null) {
    /**
     * 标签归一成 `[{tag:'x'}]`。
     *
     * 清空标签要显式传 `[]` —— Zotero 收到空数组才会删光，
     * 字段缺省则表示「不动标签」。调用方传 [] 是有效操作。
     */
    const list = Array.isArray(patch.tags) ? patch.tags : []
    const seen = new Set()
    const out = []
    for (const t of list) {
      const name = String(typeof t === 'string' ? t : (t?.tag ?? '')).trim()
      if (!name) continue
      // 去重：Zotero 同一批注重复 tag 会显示两条，界面上却只看到一个
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ tag: name })
    }
    body.tags = out
  }

  if (Object.keys(body).length === 0) {
    return { ok: false, reason: '没有要修改的字段（color / comment / tags 至少给一个）' }
  }

  const probe = await probeLocalApi()
  if (!probe.available) return { ok: false, reason: probe.reason }
  const serverId = probe.serverId
  if (!serverId) return { ok: false, needAuth: true, reason: '当前 Zotero 不支持本地写入（需要 Zotero 10+）。' }

  try {
    // 复用缓存的 key（与创建/删除共用），改批注不该再弹一次授权框
    const authResult = await ensureApiKey(serverId)
    if (!authResult.ok) return { ok: false, reason: authResult.reason }
    const apiKey = authResult.key

    const res = await fetch(`${LOCAL_API}/api/users/0/items/${key}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Zotero-API-Version': '3',
        'Zotero-Server-ID': serverId,
        'Zotero-API-Key': apiKey,
        ...(await currentVersion(key, apiKey, serverId)),
      },
      body: JSON.stringify(body),
    })

    if (res.status === 401) {
      invalidateApiKey()
      return { ok: false, needAuth: true, reason: 'Zotero 写入密钥已失效，请再试一次（会重新弹授权框）。' }
    }

    const bodyText = await res.text().catch(() => '')

    if (!res.ok) {
      let detail = bodyText
      try {
        // Zotero 的错误体可能是 { failed: {...} } 或 { message }
        const j = JSON.parse(bodyText)
        detail = j?.failed?.['0']?.message ?? j?.message ?? bodyText
      } catch { /* 原样输出 */ }
      return { ok: false, reason: `修改批注失败（${res.status}）：${String(detail).slice(0, 200)}` }
    }

    /**
     * 和创建一样，**不能**只把 HTTP 200 当成成功 —— 但判据不能照抄。
     *
     * 创建是批量端点，成功时返回 `{success:{"0":KEY}, failed:{}}`；
     * PATCH 单个条目在 Zotero 上成功时通常返回**空 body 或改后的条目对象**，
     * 没有 `success['0']`。照抄「必须有 success」会把每次成功都判成失败。
     *
     * 所以这里的规则是：没进 401、没进 !res.ok 就算成功；
     * 只有在 body 里**明确**出现 `failed` 且其中确实有 '0' 条目时才算失败。
     */
    if (bodyText.trim()) {
      try {
        const parsed = JSON.parse(bodyText)
        const failedEntry = parsed?.failed?.['0']
        if (failedEntry) {
          const message = typeof failedEntry === 'string'
            ? failedEntry
            : (failedEntry?.message ?? JSON.stringify(failedEntry))
          return { ok: false, reason: `Zotero 拒绝修改批注：${String(message).slice(0, 200)}` }
        }
      } catch { /* 不是 JSON：按成功处理 */ }
    }

    return { ok: true, patch: body }
  } catch (error) {
    const detail = [error?.cause?.code, error?.message].filter(Boolean).join(' / ')
    return { ok: false, reason: `修改批注时连接失败：${String(detail || error).slice(0, 240)}` }
  }
}

/** 取条目的当前版本，删除/改色时要用 If-Unmodified-Since-Version 做前置条件。 */
async function currentVersion(itemKey, apiKey, serverId) {
  try {
    const res = await fetch(`${LOCAL_API}/api/users/0/items/${itemKey}`, {
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': apiKey, 'Zotero-Server-ID': serverId },
    })
    if (!res.ok) return {}
    const data = await res.json()
    const v = data?.version
    return typeof v === 'number' ? { 'If-Unmodified-Since-Version': String(v) } : {}
  } catch { return {} }
}
