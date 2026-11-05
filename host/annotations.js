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
    out.push({
      key: r.key,
      type: ANNOTATION_TYPES[r.type] ?? 'highlight',
      text: r.text ?? '',
      comment: r.comment ?? '',
      color: r.color ?? '#ffd400',
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
    return {
      available: false,
      writable: false,
      reason: code === 'ECONNREFUSED'
        ? 'Zotero 没有在运行。高亮/备注要写回 Zotero，必须先打开 Zotero 桌面版。'
        : `连接 Zotero 本地 API 失败：${error?.message ?? error}`,
    }
  } finally {
    clearTimeout(timer)
  }
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
  } = options

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

  // 1) 申请授权
  let apiKey
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
    apiKey = authBody?.key
    if (!apiKey) return { ok: false, reason: 'Zotero 未返回写入密钥' }
  } catch (error) {
    return { ok: false, reason: `申请写入授权时连接失败：${error?.message ?? error}` }
  }

  // 2) 创建批注条目
  const position = { pageIndex, rects }
  const payload = [{
    itemType: 'annotation',
    parentItem: attachmentKey,
    annotationType: 'highlight',
    annotationText: text,
    annotationComment: comment,
    annotationColor: color,
    annotationPageLabel: String(pageLabel ?? pageIndex + 1),
    annotationSortIndex: sortIndex ?? `${String(pageIndex + 1).padStart(5, '0')}|${String(Math.round((rects[0]?.[3] ?? 0) * 100)).padStart(6, '0')}`,
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
    const parsed = JSON.parse(bodyText)
    const key = parsed?.success?.['0'] ?? parsed?.successful?.['0']?.key ?? null
    return { ok: true, key }
  } catch (error) {
    return { ok: false, reason: `写入 Zotero 时连接失败：${error?.message ?? error}` }
  }
}

/** 删除一条批注（按 key）。 */
export async function deleteAnnotation(annotationKey) {
  const probe = await probeLocalApi()
  if (!probe.available) return { ok: false, reason: probe.reason }
  const serverId = probe.serverId
  if (!serverId) return { ok: false, needAuth: true, reason: '当前 Zotero 不支持本地写入（需要 Zotero 10+）。' }

  try {
    const authRes = await fetch(`${LOCAL_API}/api/local/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
      body: JSON.stringify({ appName: 'DSH Zotero Reader' }),
    })
    if (!authRes.ok) return { ok: false, reason: `申请删除授权失败（${authRes.status}）` }
    const { key: apiKey } = await authRes.json()

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

/** 取条目的当前版本，删除时要用 If-Unmodified-Since-Version 做前置条件。 */
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
