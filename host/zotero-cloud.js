/**
 * Zotero 云端 Web API（api.zotero.org）访问层。
 *
 * 为什么需要它：本地库读取依赖 Zotero 桌面版在跑，且批注写入依赖本地 API 的
 * 一次运行时授权（`zotero-api-key.json`）。用户在没开 Zotero、或想在别的机器上
 * 用时，这两条路都断。云端 Web API 用 zotero.org 的 key 直连，不需要任何本地运行时。
 *
 * **两套 key 完全不同，不能混用**（实测：把本地 `zotero-api-key.json` 里的 key
 * 拿去打 `/keys/current`，返回 403 `Invalid key`）：
 *   · 本地 key：Zotero 10+ 运行时通过 `/api/local/authorize` 发放，只对 127.0.0.1:23119 有效
 *   · 云端 key：用户在 zotero.org/settings/keys 自己创建，格式 24 位字母数字
 *
 * 这个模块只做「协议正确」，不做业务判断：
 *   · 错误一律抛 CloudApiError（带 code/status/retryAfter），由路由层决定回什么 JSON
 *   · 429 按 Retry-After 退避重试；401/403/404/412 不重试（重试也不会有不同结果）
 *   · 分页读 `Total-Results` 响应头
 *
 * 可测试性：所有网络函数接受 `fetchImpl`，测试传桩函数即可断言请求构造与错误分类，
 * 不需要真实网络（VPN 状态不该决定测试红绿）。
 */

export const CLOUD_BASE = 'https://api.zotero.org'
export const API_VERSION = '3'

/** 默认超时。云端 API 正常在 1 秒内响应（实测 285–1129ms）。 */
const DEFAULT_TIMEOUT_MS = 20_000
/** 429 最多重试几次。3 次足够跨过一分钟窗口，再多用户会以为界面卡死。 */
const DEFAULT_RETRIES = 3

/**
 * 错误分类码。
 *
 * 前端要按这些码给不同提示（「key 无效」和「网络不通」的处置方式完全不同），
 * 所以不能只回一个 message。
 */
export const ERROR_CODES = {
  NO_KEY: 'no_key',
  INVALID_KEY: 'invalid_key',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VERSION_CONFLICT: 'version_conflict',
  RATE_LIMITED: 'rate_limited',
  BAD_REQUEST: 'bad_request',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  SERVER: 'server',
  UNKNOWN: 'unknown',
}

export class CloudApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'CloudApiError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 把 HTTP 状态码 + 响应正文分类成错误码。
 *
 * **为什么必须看正文**：实测 `/keys/current` 对无效 key 返回的是 **403 + 纯文本
 * `Invalid key`**，而不是 401 JSON。只按状态码分类会把「key 无效」误判成
 * 「无权限」，用户就会去改 key 的权限设置，而真正该做的是换一个 key。
 * 无 Authorization 头时同样 403，正文是 `Forbidden`，那是另一回事。
 */
export function classifyStatus(status, bodyText = '') {
  const body = String(bodyText ?? '')
  if (status >= 200 && status < 300) return null

  if (status === 400) {
    return new CloudApiError(ERROR_CODES.BAD_REQUEST, `请求参数被云端拒绝（400）：${firstLine(body) || '无正文'}`)
  }
  if (status === 401) {
    return new CloudApiError(ERROR_CODES.INVALID_KEY, '云端 key 无效或已过期（401）。请在 zotero.org/settings/keys 重新生成后填入。')
  }
  if (status === 403) {
    // 同一个状态码，两种含义：正文说 Invalid key 就是 key 本身不对
    if (/invalid\s*key/i.test(body)) {
      return new CloudApiError(
        ERROR_CODES.INVALID_KEY,
        '云端 key 无效（403 Invalid key）。注意本地 Zotero 的 API key 与 zotero.org 的 key 是两回事，这里要填 zotero.org 生成的那个。',
      )
    }
    return new CloudApiError(ERROR_CODES.FORBIDDEN, '云端 key 没有该操作的权限（403）。请确认 key 勾选了 library 读/写权限。')
  }
  if (status === 404) {
    return new CloudApiError(ERROR_CODES.NOT_FOUND, '云端找不到该条目（404）。它可能还没同步到云端，或已被删除。')
  }
  if (status === 412) {
    return new CloudApiError(ERROR_CODES.VERSION_CONFLICT, '版本冲突（412）：该条目在你读取之后被改过。请刷新后重试。')
  }
  if (status === 429) {
    return new CloudApiError(ERROR_CODES.RATE_LIMITED, '触发云端限流（429），稍后重试。')
  }
  if (status >= 500) {
    return new CloudApiError(ERROR_CODES.SERVER, `Zotero 云端服务错误（${status}）${firstLine(body) ? `：${firstLine(body)}` : ''}`)
  }
  return new CloudApiError(ERROR_CODES.UNKNOWN, `云端请求失败（${status}）${firstLine(body) ? `：${firstLine(body)}` : ''}`)
}

/**
 * 网络层异常分类。
 *
 * `fetch failed` 对用户没有信息量，必须拆成可照做的原因：
 * 超时 / 连不上（可能要走代理）/ 其它。
 */
export function classifyNetworkError(error) {
  const name = error?.name ?? ''
  const code = error?.cause?.code ?? error?.code ?? ''
  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return new CloudApiError(ERROR_CODES.TIMEOUT, '连接 api.zotero.org 超时。若在国内网络，请确认代理/VPN 是否生效。')
  }
  const detail = [code, error?.message].filter(Boolean).join(' / ')
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) {
    return new CloudApiError(
      ERROR_CODES.NETWORK,
      `连不上 api.zotero.org（${code}）。这通常是网络问题：请确认 VPN/代理已开启并可访问境外站点。`,
      { cause: detail },
    )
  }
  return new CloudApiError(ERROR_CODES.NETWORK, `请求 api.zotero.org 失败：${detail || '未知网络错误'}`, { cause: detail })
}

/** 只取正文首行并截断，避免把整页 HTML 塞进错误消息。 */
function firstLine(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  const line = s.split(/\r?\n/)[0]
  // 云端 400 有时回 HTML 片段，去掉标签
  const plain = line.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain
}

/** 读 `Total-Results` 头（分页总数）。拿不到就返回 null，不要猜 0。 */
export function parseTotalResults(headers) {
  const raw = headers?.get?.('Total-Results') ?? headers?.['Total-Results'] ?? headers?.['total-results']
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * 429 退避时长。
 *
 * 优先用服务端的 `Retry-After`（Zotero 会带，单位秒）；没有就指数退避
 * 1s / 2s / 4s。上限 30s —— 再长用户会以为界面死了。
 */
export function retryDelayMs(attempt, retryAfterHeader) {
  const raw = retryAfterHeader === undefined || retryAfterHeader === null ? '' : String(retryAfterHeader).trim()
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000))
    // HTTP-date 形式：按当前时间换算
    const at = Date.parse(raw)
    if (Number.isFinite(at)) {
      const delta = at - Date.now()
      if (delta > 0) return Math.min(30_000, delta)
      return 0
    }
  }
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
}

/** 云端 key 形态校验：24 位字母数字。返回 { ok, reason? }。 */
export function validateApiKey(value) {
  const key = String(value ?? '').trim()
  if (!key) return { ok: false, reason: '未填写云端 API key' }
  if (/\s/.test(key)) return { ok: false, reason: 'key 里不能有空格' }
  if (!/^[A-Za-z0-9]{24}$/.test(key)) {
    return {
      ok: false,
      reason: '云端 key 应为 24 位字母数字。本地 Zotero 的 API key 与 zotero.org 的 key 是两回事，不要混用。',
    }
  }
  return { ok: true, key }
}

/** userID 校验：Zotero 的用户 ID 是纯数字。 */
export function validateUserID(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: false, reason: '未填写 userID' }
  if (!/^\d+$/.test(raw)) return { ok: false, reason: 'userID 应为纯数字（在 zotero.org/settings/keys 页面可看到）' }
  return { ok: true, userID: raw }
}

/**
 * 构造请求 URL。
 *
 * 用 URL + searchParams 而不是拼字符串：参数里有中文/空格时拼字符串会造出
 * 非法 URL，而 searchParams 会自动编码。
 */
export function buildCloudUrl(userID, endpointPath, query = {}) {
  const base = userID === null || userID === undefined || userID === ''
    ? CLOUD_BASE
    : `${CLOUD_BASE}/users/${encodeURIComponent(String(userID))}`
  const url = new URL(`${base}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }
  return url.toString()
}

/**
 * 底层请求：统一超时、限流重试、错误分类。
 *
 * 返回 `{ status, headers, body, json, totalResults }`；失败抛 CloudApiError。
 */
export async function cloudRequest(options = {}) {
  const {
    apiKey,
    method = 'GET',
    path: endpointPath,
    userID = null,
    query = {},
    body,
    extraHeaders = {},
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options

  const key = String(apiKey ?? '').trim()
  if (!key) {
    throw new CloudApiError(ERROR_CODES.NO_KEY, '未配置云端 API key。请在设置里填入 zotero.org 生成的 key。')
  }
  if (typeof fetchImpl !== 'function') {
    throw new CloudApiError(ERROR_CODES.UNKNOWN, '当前运行环境没有可用的 fetch')
  }

  const url = buildCloudUrl(userID, endpointPath, query)
  const headers = {
    // 读用 3：云端对 v3 返回稳定结构；v4 尚未定稿
    'Zotero-API-Version': API_VERSION,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    ...extraHeaders,
  }
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let lastRateLimit = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal: controller.signal })
    } catch (error) {
      clearTimeout(timer)
      // 网络错误不重试：VPN 断了重试三次也只是多等 60 秒
      throw classifyNetworkError(error)
    }
    clearTimeout(timer)

    const text = typeof res.text === 'function' ? await res.text() : ''
    const error = classifyStatus(res.status, text)
    if (!error) {
      let json = null
      if (text) {
        try { json = JSON.parse(text) } catch { json = null }
      }
      return {
        status: res.status,
        headers: res.headers,
        body: text,
        json,
        totalResults: parseTotalResults(res.headers),
      }
    }

    // 只有限流值得重试
    if (error.code === ERROR_CODES.RATE_LIMITED && attempt < retries) {
      lastRateLimit = error
      const retryAfter = res.headers?.get?.('Retry-After') ?? null
      const delay = retryDelayMs(attempt, retryAfter)
      error.retryAfter = retryAfter
      error.attempt = attempt + 1
      await sleep(delay)
      continue
    }
    throw error
  }
  throw lastRateLimit ?? new CloudApiError(ERROR_CODES.UNKNOWN, '云端请求失败')
}

/* ------------------------------------------------------------------ 端点 */

/**
 * 验证 key：`GET /keys/current`。
 *
 * 返回 `{ ok, userID, username, canWrite, access }`。
 * 这是唯一不需要先知道 userID 的端点，所以配置流程第一步就是它。
 */
export async function probeCloudKey(apiKey, options = {}) {
  const res = await cloudRequest({
    apiKey,
    path: '/keys/current',
    userID: null,
    ...options,
  })
  const data = res.json ?? {}
  const access = data.access ?? {}
  /**
   * canWrite 的判定要覆盖两种形状：
   *   · 新式：access.user.write
   *   · 旧式/部分 key：access.user.library + write 缺省
   * 拿不到就回 false，不要乐观默认 true —— 前端会据此决定要不要显示「写批注」按钮。
   */
  const userAccess = access.user ?? {}
  const canWrite = userAccess.write === true
  return {
    ok: true,
    userID: data.userID ?? null,
    username: data.username ?? '',
    canWrite,
    access,
    key: data.key ?? '',
  }
}

/** 列云端文献。分页靠 limit/start，总数取 Total-Results。 */
export async function listCloudItems(options = {}) {
  const { userID, limit = 100, start = 0, itemType, ...rest } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const res = await cloudRequest({
    path: '/items',
    userID: id.userID,
    query: { limit, start, itemType },
    ...rest,
  })
  return {
    items: Array.isArray(res.json) ? res.json : [],
    total: res.totalResults,
    start: Number(start) || 0,
    limit: Number(limit) || 100,
    lastVersion: res.headers?.get?.('Last-Modified-Version') ?? null,
  }
}

/** 读单条文献（含 version，写操作要用它做 If-Unmodified-Since-Version）。 */
export async function getCloudItem(options = {}) {
  const { userID, itemKey, ...rest } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const key = String(itemKey ?? '').trim()
  if (!key) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '缺少 itemKey')
  const res = await cloudRequest({ path: `/items/${encodeURIComponent(key)}`, userID: id.userID, ...rest })
  return res.json ?? null
}

/**
 * 取 PDF 字节流：`GET /users/<id>/items/<key>/file`。
 *
 * **硬限制**：只对已同步到云端的附件有效。Zotero 的 file 端点不会替你上传，
 * 本地有、云端没有的 PDF 一律 404 —— 这是设计，不是 bug，所以错误消息要点明。
 */
export async function getCloudFile(options = {}) {
  const { userID, itemKey, fetchImpl = globalThis.fetch, timeoutMs = 60_000, apiKey } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const key = String(itemKey ?? '').trim()
  if (!key) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '缺少 itemKey')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(buildCloudUrl(id.userID, `/items/${encodeURIComponent(key)}/file`), {
      headers: {
        'Zotero-API-Version': API_VERSION,
        Authorization: `Bearer ${String(apiKey ?? '').trim()}`,
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : ''
      if (res.status === 404) {
        throw new CloudApiError(
          ERROR_CODES.NOT_FOUND,
          '云端没有这个 PDF（404）。Zotero 只允许下载**已同步到云端**的附件；请先在 Zotero 里确认该附件已上传（或改用本地库读取）。',
        )
      }
      throw classifyStatus(res.status, text) ?? new CloudApiError(ERROR_CODES.UNKNOWN, `下载 PDF 失败（${res.status}）`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType: res.headers?.get?.('content-type') ?? 'application/pdf', bytes: buffer.length }
  } catch (error) {
    if (error instanceof CloudApiError) throw error
    throw classifyNetworkError(error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 写 token：Zotero 要求新建条目时带 `Zotero-Write-Token` 防重复提交。
 * 用随机 UUID —— 同一个 token 重复提交会被云端当作同一次写入而幂等。
 */
export function makeWriteToken() {
  const g = globalThis.crypto
  if (g?.randomUUID) return g.randomUUID()
  // 兜底：足够随机的 16 字节十六进制
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 新建条目：POST /items（数组形式，云端接受批量）。 */
export async function createCloudItems(options = {}) {
  const { userID, items, ...rest } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const list = Array.isArray(items) ? items : [items]
  if (list.length === 0 || !list[0]) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '没有要写入的条目')
  const res = await cloudRequest({
    method: 'POST',
    path: '/items',
    userID: id.userID,
    body: list,
    extraHeaders: { 'Zotero-Write-Token': makeWriteToken() },
    ...rest,
  })
  return res.json ?? null
}

/**
 * 更新条目：PATCH /items/<key>。
 *
 * **必须带 `If-Unmodified-Since-Version`**，否则云端拒绝（428/412）。
 * version 由调用方从最近一次读到的条目里带过来 —— 这是防「覆盖别人改动」的唯一手段。
 */
export async function updateCloudItem(options = {}) {
  const { userID, itemKey, version, patch, ...rest } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const key = String(itemKey ?? '').trim()
  if (!key) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '缺少 itemKey')
  const ver = Number(version)
  if (!Number.isFinite(ver) || ver < 0) {
    throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '缺少有效的 version（更新必须带 If-Unmodified-Since-Version）')
  }
  const res = await cloudRequest({
    method: 'PATCH',
    path: `/items/${encodeURIComponent(key)}`,
    userID: id.userID,
    body: patch ?? {},
    extraHeaders: { 'If-Unmodified-Since-Version': String(ver) },
    ...rest,
  })
  return res.json ?? null
}

/** 删除条目：DELETE /items/<key>，同样要版本号。 */
export async function deleteCloudItem(options = {}) {
  const { userID, itemKey, version, ...rest } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const key = String(itemKey ?? '').trim()
  if (!key) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '缺少 itemKey')
  const ver = Number(version)
  if (!Number.isFinite(ver) || ver < 0) {
    throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '删除必须带 version（If-Unmodified-Since-Version）')
  }
  await cloudRequest({
    method: 'DELETE',
    path: `/items/${encodeURIComponent(key)}`,
    userID: id.userID,
    extraHeaders: { 'If-Unmodified-Since-Version': String(ver) },
    ...rest,
  })
  return { ok: true }
}

/**
 * 读某条目的云端批注。
 *
 * 批注是附件（PDF）的子条目，所以路径挂在 itemKey 下面。也接受直接给附件 key。
 * 云端把批注作为 `itemType: 'annotation'` 的子条目返回。
 */
export async function listCloudAnnotations(options = {}) {
  const { userID, itemKey, ...rest } = options
  const id = validateUserID(userID)
  if (!id.ok) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, id.reason)
  const key = String(itemKey ?? '').trim()
  if (!key) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '缺少 itemKey')
  const res = await cloudRequest({
    path: `/items/${encodeURIComponent(key)}/children`,
    userID: id.userID,
    query: { itemType: 'annotation', limit: 100 },
    ...rest,
  })
  const rows = Array.isArray(res.json) ? res.json : []
  const annotations = rows
    .filter((row) => row?.data?.itemType === 'annotation')
    .map((row) => ({
      key: row.key,
      version: row.version,
      parentItem: row.data.parentItem ?? null,
      annotationType: row.data.annotationType ?? 'highlight',
      text: row.data.annotationText ?? '',
      comment: row.data.annotationComment ?? '',
      color: row.data.annotationColor ?? '',
      pageLabel: row.data.annotationPageLabel ?? '',
      sortIndex: row.data.annotationSortIndex ?? '',
      position: row.data.annotationPosition ?? '',
      tags: Array.isArray(row.data.tags) ? row.data.tags.map((t) => t.tag ?? t) : [],
      dateAdded: row.data.dateAdded ?? '',
    }))
  return { annotations, total: res.totalResults ?? annotations.length }
}

/**
 * 构造一条云端批注条目（纯函数，便于测试请求体形状）。
 *
 * 云端要的字段和本地 API 略有不同：本地 `/api/local/annotations` 接受扁平字段，
 * 云端要的是标准 item 形状 `{ itemType, parentItem, annotation*, tags }`。
 */
export function buildAnnotationItem(fields = {}) {
  const parentItem = String(fields.parentItem ?? '').trim()
  if (!parentItem) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '写批注需要 parentItem（附件 key）')
  const text = String(fields.text ?? '')
  const comment = String(fields.comment ?? '')
  if (!text && !comment) throw new CloudApiError(ERROR_CODES.BAD_REQUEST, '批注至少要有 text 或 comment')
  const item = {
    itemType: 'annotation',
    parentItem,
    annotationType: fields.annotationType === 'note' ? 'note' : 'highlight',
    annotationText: text,
    annotationComment: comment,
    annotationColor: fields.color || '#ffd400',
    tags: Array.isArray(fields.tags) ? fields.tags.map((tag) => ({ tag: String(tag) })) : [],
  }
  if (fields.pageLabel) item.annotationPageLabel = String(fields.pageLabel)
  if (fields.sortIndex) item.annotationSortIndex = String(fields.sortIndex)
  if (fields.position) item.annotationPosition = String(fields.position)
  return item
}

/** 写一条云端批注。 */
export async function createCloudAnnotation(options = {}) {
  const { userID, fields, ...rest } = options
  const item = buildAnnotationItem(fields)
  const out = await createCloudItems({ userID, items: [item], ...rest })
  const successful = out?.successful ?? {}
  const first = Object.values(successful)[0]
  return {
    ok: Boolean(first),
    key: first?.key ?? null,
    version: first?.version ?? null,
    raw: out,
  }
}

/** 把任意异常统一成 `{ ok:false, code, error }`，供路由层直接回 JSON。 */
export function toErrorPayload(error) {
  if (error instanceof CloudApiError) {
    return {
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    }
  }
  return { ok: false, code: ERROR_CODES.UNKNOWN, error: error instanceof Error ? error.message : String(error) }
}
