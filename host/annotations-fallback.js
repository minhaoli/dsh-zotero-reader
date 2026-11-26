/**
 * 云端回退层：本地 Zotero 关着时，让批注读写改走 api.zotero.org。
 *
 * 为什么单独一层：判定「本地到底能不能用」是**策略**，不该散在 index.js 的
 * 两个路由里；而云端身份（userID / 能否写）要跨请求缓存，也需要一个模块作用域。
 * index.js 只负责「先本地，本地通道不在就问这里」。
 *
 * 一条硬规矩：**只有通道缺失才回退**。
 * 本地返回业务错误（条目不存在、参数非法、授权被拒、服务端拒绝写入）时改走云端，
 * 会把「这条批注本身有问题」包装成「云端也失败了」，用户既看不到真原因，
 * 还会得到一条内容错误的云端批注。判定见 localChannelAbsent()。
 */

import { deriveSortIndex } from './annotations.js'
import {
  ERROR_CODES,
  CloudApiError,
  cloudRequest,
  createCloudAnnotation,
  listCloudAnnotations,
  probeCloudKey,
  toErrorPayload,
} from './zotero-cloud.js'

/* ------------------------------------------------------------ 1) 回退判定 */

/**
 * 本地写入失败里，哪些算「通道根本不在」，可以改走云端。
 *
 * 只认 host/annotations.js 自己置的机器可读标记，**不匹配任何提示文案**
 * （文案会改，改一次就静默失效）：
 *
 *   · `unavailable: true` —— 探测阶段连不上 127.0.0.1:23119：
 *       ECONNREFUSED（Zotero 没开）、ENOTFOUND / EAI_AGAIN（解析异常）、
 *       EHOSTUNREACH / ENETUNREACH、ECONNRESET、ETIMEDOUT、ABORT_ERR（2.5s 超时），
 *       以及 Zotero 开着但本地 API 被关（`/api/` 回 403）。
 *   · `unsupported: true` —— 探测通过但没有 Zotero-Server-ID（Zotero < 10，
 *       本地写入这条路在这个版本上不存在）。
 *
 * 明确**不回退**的情况（拿到了 ok:false 也照原样回给前端）：
 *   · needAuth / 401 —— 用户拒了授权、或旧 key 失效。云端能写，但那是另一个
 *     身份体系；静默换通道会让用户以为本地授权修好了。
 *   · 本地 POST 非 2xx、响应体里没有 success['0']、'Zotero 未确认写入' ——
 *     这些是「通道通、请求被拒」，重发到云端只会掩盖问题，还可能写出重复批注。
 *   · 探测成功之后写入途中才断网 —— 请求可能已经落地，再发一次就是重复批注。
 *   · 前置校验失败（没有选中文字、便签没有位置、找不到 PDF 附件）。
 */
export function localChannelAbsent(result) {
  if (!result || result.ok !== false) return false
  return result.unavailable === true || result.unsupported === true
}

/* ------------------------------------------------------ 2) 云端身份与缓存 */

/**
 * 进程内身份缓存：一个 apiKey 只探一次 `/keys/current`。
 *
 * 不缓存失败：key 填错了用户会马上改，缓存住反而要他重启。
 * 换 key 后 apiKey 不同，自然命中不了旧缓存。
 */
let identityCache = null

/** 写入探测失败时记住的短暂结果（见 cloudWriteCapability）。 */
let capabilityFailure = null
const CAPABILITY_FAILURE_TTL_MS = 60_000

/** 测试用：清掉缓存，让下一次调用重新探测。 */
export function resetCloudIdentityCache() {
  identityCache = null
  capabilityFailure = null
}

/**
 * 解析云端身份：`{ apiKey, userID, username, canWrite, source }`。
 *
 * userID 的来源优先级：设置里手填的 `cloudUserID` > `/keys/current` 返回的 userID。
 * 但**无论有没有手填，都会探测一次**——因为 `canWrite` 只能从这次探测里拿到，
 * 缺了它就只能在写入被 403 之后才告诉用户「这个 key 是只读的」。
 *
 * 拿不到就抛 CloudApiError（带 code），绝不静默回一个空 userID：
 * 调用方会把 code 映射成可读提示。
 */
export async function resolveCloudIdentity(settings = {}, options = {}) {
  const apiKey = String(settings.cloudApiKey ?? '').trim()
  if (!apiKey) {
    throw new CloudApiError(
      ERROR_CODES.NO_KEY,
      '未配置云端 Zotero API key：把 zotero.org/settings/keys 生成的 key 放进环境变量（默认 ZOTERO_API_KEY），并确认插件设置里的 cloudApiKeyEnv 指向它，然后重启 DSH。',
    )
  }

  if (identityCache && identityCache.apiKey === apiKey) {
    return { ...identityCache, cached: true }
  }

  const probe = await probeCloudKey(apiKey, options)
  const configured = String(settings.cloudUserID ?? '').trim()
  if (configured && !/^\d+$/.test(configured)) {
    throw new CloudApiError(
      ERROR_CODES.BAD_REQUEST,
      `云端的 userID 必须是一串数字，当前配置是「${configured}」。清空它让插件自动探测，或从 zotero.org/settings/keys 页面上的数字 userID 复制。`,
    )
  }
  const userID = configured || String(probe.userID ?? '').trim()
  if (!userID) {
    throw new CloudApiError(
      ERROR_CODES.UNKNOWN,
      '云端 key 校验通过，但 /keys/current 没有返回 userID。请在插件设置里手动填 cloudUserID（zotero.org/settings/keys 页面顶部那串数字）。',
    )
  }

  identityCache = {
    apiKey,
    userID,
    username: probe.username ?? '',
    // 探测结果里这是布尔值；只读 key 会得到 false，写前就能给出明确提示
    canWrite: probe.canWrite === true,
    source: configured ? 'settings' : 'probe',
  }
  return { ...identityCache, cached: false }
}

/**
 * 只问「云端现在能不能写」——给 GET /annotations 算 canWrite 用，永不抛错。
 *
 * 本地 API 关着但云端能写时，前端不应该继续把「写批注」按钮判成不可用。
 */
export async function cloudWriteCapability(settings = {}, options = {}) {
  const apiKey = String(settings.cloudApiKey ?? '').trim()
  if (!apiKey) {
    return { configured: false, canWrite: false, userID: null, username: '', reason: null }
  }
  /**
   * 探测失败要短暂记住：打开一次批注面板就会走这里一次，断网时若每次都去连
   * （哪怕只有 4 秒），面板会一直转圈。只记失败 60 秒；成功由 identityCache
   * 永久记住，直到 key 变化。
   */
  const remembered = staleCapabilityFailure(apiKey)
  if (remembered) return remembered
  try {
    const identity = await resolveCloudIdentity(settings, options)
    return {
      configured: true,
      canWrite: identity.canWrite === true,
      userID: identity.userID,
      username: identity.username,
      reason: identity.canWrite === true ? null : '云端 key 只有读权限，写不了批注（需要 Allow write access）',
    }
  } catch (error) {
    const value = {
      configured: true,
      canWrite: false,
      userID: null,
      username: '',
      reason: errorText(error),
      code: error?.code ?? ERROR_CODES.UNKNOWN,
    }
    capabilityFailure = { apiKey, at: Date.now(), value }
    return value
  }
}

/** 60 秒内的失败结果，直接复用。 */
function staleCapabilityFailure(apiKey) {
  if (!capabilityFailure || capabilityFailure.apiKey !== apiKey) return null
  if (Date.now() - capabilityFailure.at > CAPABILITY_FAILURE_TTL_MS) {
    capabilityFailure = null
    return null
  }
  return capabilityFailure.value
}

/* ------------------------------------------------------------ 3) 附件定位 */

/**
 * 找某条文献在云端的 PDF 附件 key。
 *
 * 为什么需要它：批注在 Zotero 里挂的是**附件**，不是文献
 * （本地 `payload.parentItem = attachmentKey` 同理）。本地库读不到时前端拿不到
 * 附件 key，只能按文献 key 现查。itemKey 本身可能已经是附件 key（同一条批注
 * 从本地读回来时前端就是这样传的），所以先认一下自己，再查子条目。
 */
export async function findCloudPdfAttachment(options = {}) {
  const { identity, itemKey, ...io } = options
  const key = String(itemKey ?? '').trim()
  if (!key) return null

  const self = await cloudRequest({
    apiKey: identity.apiKey,
    userID: identity.userID,
    path: `/items/${encodeURIComponent(key)}`,
    ...io,
  })
  const selfData = self.json?.data
  if (selfData?.itemType === 'attachment' && isPdf(selfData.contentType)) return key

  const res = await cloudRequest({
    apiKey: identity.apiKey,
    userID: identity.userID,
    path: `/items/${encodeURIComponent(key)}/children`,
    query: { itemType: 'attachment', limit: 100 },
    ...io,
  })
  const rows = Array.isArray(res.json) ? res.json : []
  const pdf = rows.find((row) => row?.data?.itemType === 'attachment' && isPdf(row.data.contentType))
  return pdf?.key ?? null
}

function isPdf(contentType) {
  return /pdf/i.test(String(contentType ?? ''))
}

/* ------------------------------------------------------------------ 4) 写 */

/**
 * 把前端的批注类型映射成云端认识的值。
 *
 * ink 映射成 note：云端 ink 批注要求 `annotationPosition.paths` 里的笔迹点列，
 * 而本插件只有矩形，写 ink 只会得到一条渲染不出来的批注 —— 落成便签至少看得见。
 * freetext 同本地一样落成 note（Zotero 的 text 型还要 fontSize/rotation）。
 */
export function cloudAnnotationType(kind) {
  const wanted = String(kind || 'highlight').toLowerCase()
  if (wanted === 'underline') return 'underline'
  if (wanted === 'note' || wanted === 'freetext' || wanted === 'ink') return 'note'
  return 'highlight'
}

/**
 * 走云端写一条批注。成功回 `{ ok:true, key, version, parentItem, userID }`，
 * 失败**抛出** CloudApiError，由调用方用 cloudFailureResponse() 转成响应。
 *
 * 只发一次请求，不重试：写操作不幂等，超时后重发可能生成两条一样的批注。
 * cloudRequest 内部也只对 429 重试（那是服务端明确要求稍后再试）。
 */
export async function writeAnnotationViaCloud(options = {}) {
  const {
    settings = {},
    itemKey,
    attachmentKey = null,
    text = '',
    comment = '',
    color = '#ffd400',
    pageIndex = 0,
    rects = [],
    pageLabel,
    pageHeightPt,
    annotationKind,
  } = options
  const io = ioOptions(options)

  const identity = await resolveCloudIdentity(settings, io)
  if (identity.canWrite !== true) {
    throw new CloudApiError(
      ERROR_CODES.READ_ONLY,
      `云端 key 只有读权限，写不了批注（账号 ${identity.username || identity.userID}）。去 zotero.org/settings/keys 编辑这个 key，勾上 Allow write access 后重启 DSH。`,
    )
  }

  const parentItem = String(attachmentKey ?? '').trim()
    || await findCloudPdfAttachment({ identity, itemKey, ...io })
  if (!parentItem) {
    throw new CloudApiError(
      ERROR_CODES.NOT_FOUND,
      '云端找不到这篇文献的 PDF 附件，批注没地方挂。请确认云端 key 对应的账号里有这篇文献、且已同步过 PDF。',
    )
  }

  const type = cloudAnnotationType(annotationKind)
  /**
   * 文字的落点要跟本地一致：`annotationText` 只对 highlight / underline 合法，
   * note 型的文字走 `annotationComment`（本地 createAnnotation 也是这么分的）。
   */
  const acceptsText = type === 'highlight' || type === 'underline'
  const itemText = acceptsText ? String(text ?? '') : ''
  const itemComment = String(comment ?? '') || (acceptsText ? '' : String(text ?? ''))
  if (!itemText && !itemComment) {
    throw new CloudApiError(
      ERROR_CODES.BAD_REQUEST,
      '云端 API 不接受空批注（本地 API 会自动补空字段，云端不会）。涂鸦和空便签请先加一句备注，或改用高亮/下划线。',
    )
  }

  const out = await createCloudAnnotation({
    apiKey: identity.apiKey,
    userID: identity.userID,
    fields: {
      parentItem,
      text: itemText,
      comment: itemComment,
      color,
      pageLabel: pageLabel ?? pageIndex + 1,
      // 必须和本地算出同一个值，否则两条通道写出的批注排序会错开
      sortIndex: deriveSortIndex({ pageIndex, rects, pageHeightPt }),
      position: JSON.stringify({ pageIndex, rects }),
      annotationType: type,
    },
    ...io,
  })

  if (!out?.ok) {
    throw new CloudApiError(
      ERROR_CODES.UNKNOWN,
      '云端没有确认写入（响应里没有成功的条目），这条批注可能没保存。稍后重试一次；若仍失败，检查 key 的写权限。',
    )
  }
  return { ok: true, key: out.key, version: out.version, parentItem, userID: identity.userID }
}

/* ------------------------------------------------------------------ 5) 读 */

/**
 * 走云端读一条文献的批注。返回的形状与本地 `readAnnotations` 对齐
 * （`{ annotations, attachmentKey }`，每条 `{key,type,text,comment,color,tags,page,pageIndex,rects,sortIndex}`），
 * 前端不需要知道这次是云端来的，`via` 由路由层加到响应外层。
 */
export async function readAnnotationsViaCloud(options = {}) {
  const { settings = {}, itemKey, attachmentKey = null } = options
  const io = ioOptions(options)

  const identity = await resolveCloudIdentity(settings, io)
  const parentItem = String(attachmentKey ?? '').trim()
    || await findCloudPdfAttachment({ identity, itemKey, ...io })
  if (!parentItem) {
    throw new CloudApiError(
      ERROR_CODES.NOT_FOUND,
      '云端找不到这篇文献的 PDF 附件，读不到批注（云端批注挂在 PDF 附件下面）。',
    )
  }

  const out = await listCloudAnnotations({
    apiKey: identity.apiKey,
    userID: identity.userID,
    itemKey: parentItem,
    ...io,
  })
  const annotations = (out.annotations ?? []).map(toLocalAnnotationShape)
  return {
    annotations,
    attachmentKey: parentItem,
    total: out.total ?? annotations.length,
    userID: identity.userID,
    // 只读 key 也能读批注，所以「读到了」不等于「能写」；写按钮按这个字段来
    canWrite: identity.canWrite === true,
    writeBlockedReason: identity.canWrite === true
      ? null
      : '云端 key 只有读权限，写不了批注（需要 Allow write access）',
  }
}

/** 云端批注 → 本地批注形状。字段语义逐个对齐 host/annotations.js 的 readAnnotations。 */
function toLocalAnnotationShape(row) {
  const pos = parsePosition(row.position)
  const pageIndex = Number.isInteger(pos?.pageIndex) ? pos.pageIndex : null
  const label = String(row.pageLabel ?? '').trim()
  return {
    key: row.key,
    type: row.annotationType || 'highlight',
    text: row.text ?? '',
    comment: row.comment ?? '',
    color: row.color || '#ffd400',
    tags: Array.isArray(row.tags) ? row.tags : [],
    // pageLabel 就是用户看到的页码；缺失时退回 pageIndex+1（与本地一致）
    page: label && Number.isFinite(Number(label)) ? Number(label) : (pageIndex === null ? null : pageIndex + 1),
    pageIndex,
    // rects 是 PDF 坐标（左下原点），与本地读回的语义相同
    rects: Array.isArray(pos?.rects) ? pos.rects : [],
    sortIndex: row.sortIndex ?? '',
  }
}

function parsePosition(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return null }
}

/* ------------------------------------------------------------ 6) 失败分类 */

/**
 * 错误码 → HTTP 状态。
 *
 * 为什么还要映射状态码：前端现在只把非 2xx 当失败，状态码决定了它是「配置没填」
 * （400，改设置）、「key 不对」（401，换 key）、「没权限」（403）、还是「网络问题」
 * （502/504，稍后重试）。真正的可读原因在响应体的 `error` 里。
 */
const HTTP_STATUS_BY_CODE = {
  [ERROR_CODES.NO_KEY]: 400,
  [ERROR_CODES.BAD_REQUEST]: 400,
  [ERROR_CODES.INVALID_KEY]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.READ_ONLY]: 403,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.VERSION_CONFLICT]: 409,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.NETWORK]: 502,
  [ERROR_CODES.TIMEOUT]: 504,
  [ERROR_CODES.SERVER]: 502,
  [ERROR_CODES.UNKNOWN]: 502,
}

/** 把云端异常转成 `{ status, body }`，body 里带 code 和可读原因。 */
export function cloudFailureResponse(error) {
  const payload = toErrorPayload(error)
  return { status: HTTP_STATUS_BY_CODE[payload.code] ?? 502, body: payload }
}

/** 取一段可读的错误文本，供 `localError` 之类的字段用。 */
export function errorText(error) {
  if (!error) return ''
  if (error instanceof CloudApiError) return error.message
  const code = error?.code ?? error?.cause?.code ?? ''
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return code ? `${message}（${code}）` : message
}

/** 只把测试要注入的 IO 选项透传下去，避免 undefined 覆盖默认值。 */
function ioOptions(options) {
  const io = {}
  if (typeof options.fetchImpl === 'function') io.fetchImpl = options.fetchImpl
  if (typeof options.sleep === 'function') io.sleep = options.sleep
  return io
}
