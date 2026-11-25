/**
 * 云端 Web API 契约测试。
 *
 * 只测**纯逻辑**：URL 构造、错误分类、限流退避、请求体形状、参数校验。
 * **不碰真实网络** —— 这条链路要过 VPN，测试红绿不该取决于用户代理状态。
 * 需要验证连通性时用 `/cloud/status` 路由（人工触发）。
 *
 * 用法：node test/check-cloud-api.mjs
 */
import {
  classifyStatus, classifyNetworkError, parseTotalResults, retryDelayMs,
  validateApiKey, validateUserID, buildCloudUrl, cloudRequest,
  makeWriteToken, buildAnnotationItem, toErrorPayload,
  CloudApiError, ERROR_CODES, CLOUD_BASE,
} from '../host/zotero-cloud.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const VALID_KEY = 'A'.repeat(24)

/* -------------------------------------------------- 1) 错误分类（状态码） */

const s401 = classifyStatus(401, '')
check('401 → invalid_key', s401?.code === ERROR_CODES.INVALID_KEY, s401?.code)

/**
 * 这条是实测得出的关键分类：云端对无效 key 返回 **403 + 纯文本 Invalid key**，
 * 不是 401。若只按状态码分类会误判成「无权限」，用户就会去改 key 权限，
 * 而真正该做的是换 key。
 */
const s403Invalid = classifyStatus(403, 'Invalid key')
check('403 Invalid key → invalid_key（不是 forbidden）',
  s403Invalid?.code === ERROR_CODES.INVALID_KEY, s403Invalid?.code)

const s403Forbidden = classifyStatus(403, 'Forbidden')
check('403 Forbidden → forbidden', s403Forbidden?.code === ERROR_CODES.FORBIDDEN, s403Forbidden?.code)

check('404 → not_found', classifyStatus(404, '')?.code === ERROR_CODES.NOT_FOUND)
check('412 → version_conflict', classifyStatus(412, '')?.code === ERROR_CODES.VERSION_CONFLICT)
check('429 → rate_limited', classifyStatus(429, '')?.code === ERROR_CODES.RATE_LIMITED)
check('500 → server', classifyStatus(500, '')?.code === ERROR_CODES.SERVER)
check('400 → bad_request', classifyStatus(400, '')?.code === ERROR_CODES.BAD_REQUEST)
check('200 → null（成功不抛错）', classifyStatus(200, '') === null)
check('204 → null', classifyStatus(204, '') === null)

/** 错误消息必须能指向「下一步做什么」，不能只有状态码 */
const msg403 = classifyStatus(403, 'Invalid key')?.message ?? ''
check('invalid_key 消息提示本地 key 与云端 key 不同',
  /zotero\.org/.test(msg403) && /本地/.test(msg403), msg403.slice(0, 60))

/* ------------------------------------------------ 2) 错误分类（网络层） */

const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
check('AbortError → timeout', classifyNetworkError(abortErr).code === ERROR_CODES.TIMEOUT)

const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
check('ECONNREFUSED → network', classifyNetworkError(refused).code === ERROR_CODES.NETWORK)

const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
const dnsErr = classifyNetworkError(dns)
check('ENOTFOUND → network', dnsErr.code === ERROR_CODES.NETWORK)
check('网络错误消息提到 VPN/代理', /VPN|代理/.test(dnsErr.message), dnsErr.message.slice(0, 50))
check('网络错误带出 cause 码', /ENOTFOUND/.test(dnsErr.message), dnsErr.message.slice(0, 60))

/* ------------------------------------------------------ 3) 限流退避 */

check('Retry-After=2 → 2000ms', retryDelayMs(0, '2') === 2000, String(retryDelayMs(0, '2')))
check('无 Retry-After 时指数退避 attempt0=1000', retryDelayMs(0, null) === 1000)
check('无 Retry-After 时 attempt1=2000', retryDelayMs(1, null) === 2000)
check('无 Retry-After 时 attempt2=4000', retryDelayMs(2, null) === 4000)
check('退避上限 30s', retryDelayMs(10, null) === 30_000, String(retryDelayMs(10, null)))
check('Retry-After 超大也封顶 30s', retryDelayMs(0, '9999') === 30_000)

/* ------------------------------------------------------ 4) 参数校验 */

check('合法 24 位 key 通过', validateApiKey(VALID_KEY).ok === true)
check('空 key 拒绝', validateApiKey('').ok === false)
check('含空格拒绝', validateApiKey('AAA AAA').ok === false)
check('23 位拒绝', validateApiKey('A'.repeat(23)).ok === false)
/** 本地 key（含下划线或长度不同）必须被拦下并提示别混用 */
const localKey = validateApiKey('ntFcccabfXBnwd61wPussIvEYRMsqya4')
check('本地 Zotero key 被拒绝', localKey.ok === false)
check('拒绝消息说明两套 key 不同', /本地|zotero\.org/.test(localKey.reason), localKey.reason.slice(0, 50))

check('userID 纯数字通过', validateUserID('1234567').ok === true)
check('userID 空拒绝', validateUserID('').ok === false)
check('userID 含字母拒绝', validateUserID('12ab').ok === false)

/* ------------------------------------------------------ 5) URL 构造 */

const urlItems = buildCloudUrl('12345', '/items', { limit: 100, start: 0 })
check('items URL 形状正确',
  urlItems === `${CLOUD_BASE}/users/12345/items?limit=100&start=0`, urlItems)
check('limit=0 也会被保留（0 是合法 start）',
  buildCloudUrl('1', '/items', { start: 0 }).includes('start=0'))
check('undefined 参数被跳过',
  !buildCloudUrl('1', '/items', { itemType: undefined }).includes('itemType'))
check('空字符串参数被跳过',
  !buildCloudUrl('1', '/items', { itemType: '' }).includes('itemType'))
check('keys/current 不带 users 前缀',
  buildCloudUrl(null, '/keys/current') === `${CLOUD_BASE}/keys/current`,
  buildCloudUrl(null, '/keys/current'))
/** 中文查询词必须被编码，否则造出非法 URL */
const urlCjk = buildCloudUrl('1', '/items', { q: '人因学' })
check('中文参数被 URL 编码', !/[^\x00-\x7F]/.test(urlCjk) && urlCjk.includes('%'), urlCjk)

/* ------------------------------------- 6) 请求构造与限流重试（桩 fetch） */

/** 记录调用并返回预设响应的桩 */
function stubFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const spec = responses[Math.min(calls.length - 1, responses.length - 1)]
    const headers = new Map(Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    return {
      status: spec.status ?? 200,
      ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
      headers: {
        get: (name) => headers.get(String(name).toLowerCase()) ?? null,
      },
      text: async () => spec.body ?? '',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }
  }
  fn.calls = calls
  return fn
}

/* 6.1 认证头与 API 版本 */
{
  const f = stubFetch([{ status: 200, body: '{"userID":42,"username":"tester"}' }])
  await cloudRequest({ apiKey: VALID_KEY, path: '/keys/current', fetchImpl: f, sleep: async () => {} })
  const init = f.calls[0]?.init ?? {}
  check('请求带 Authorization: Bearer',
    init.headers?.Authorization === `Bearer ${VALID_KEY}`, String(init.headers?.Authorization))
  check('请求带 Zotero-API-Version: 3',
    init.headers?.['Zotero-API-Version'] === '3', String(init.headers?.['Zotero-API-Version']))
}

/* 6.2 没有 key 时不发请求 */
{
  const f = stubFetch([{ status: 200, body: '{}' }])
  let caught = null
  try { await cloudRequest({ apiKey: '', path: '/keys/current', fetchImpl: f }) } catch (e) { caught = e }
  check('无 key → 抛 no_key 且不发请求',
    caught?.code === ERROR_CODES.NO_KEY && f.calls.length === 0,
    `code=${caught?.code} calls=${f.calls.length}`)
}

/* 6.3 429 后重试成功 */
{
  const f = stubFetch([
    { status: 429, headers: { 'Retry-After': '1' }, body: '' },
    { status: 200, body: '{"ok":true}' },
  ])
  const slept = []
  const out = await cloudRequest({
    apiKey: VALID_KEY, path: '/keys/current', fetchImpl: f,
    sleep: async (ms) => { slept.push(ms) },
  })
  check('429 后重试并最终成功', out.status === 200 && f.calls.length === 2, `calls=${f.calls.length}`)
  check('按 Retry-After=1 睡 1000ms', slept[0] === 1000, JSON.stringify(slept))
}

/* 6.4 429 重试耗尽后抛 rate_limited */
{
  const f = stubFetch([{ status: 429, headers: { 'Retry-After': '0' }, body: '' }])
  let caught = null
  try {
    await cloudRequest({ apiKey: VALID_KEY, path: '/keys/current', fetchImpl: f, retries: 2, sleep: async () => {} })
  } catch (e) { caught = e }
  check('429 重试耗尽 → rate_limited', caught?.code === ERROR_CODES.RATE_LIMITED, String(caught?.code))
  check('重试次数正确（首次 + 2 次重试）', f.calls.length === 3, `calls=${f.calls.length}`)
}

/* 6.5 401 不重试 */
{
  const f = stubFetch([{ status: 401, body: '' }])
  let caught = null
  try { await cloudRequest({ apiKey: VALID_KEY, path: '/keys/current', fetchImpl: f, sleep: async () => {} }) } catch (e) { caught = e }
  check('401 不重试（只请求一次）', f.calls.length === 1, `calls=${f.calls.length}`)
  check('401 抛 invalid_key', caught?.code === ERROR_CODES.INVALID_KEY)
}

/* 6.6 Total-Results 解析 */
check('Total-Results 解析', parseTotalResults({ get: (k) => (k === 'Total-Results' ? '654' : null) }) === 654)
check('Total-Results 缺失 → null（不是 0）',
  parseTotalResults({ get: () => null }) === null)
check('Total-Results 非数字 → null',
  parseTotalResults({ get: () => 'abc' }) === null)

/* 6.7 写操作必须带版本号 */
{
  const f = stubFetch([{ status: 200, body: '{}' }])
  const { updateCloudItem } = await import('../host/zotero-cloud.js')
  let caught = null
  try {
    await updateCloudItem({ apiKey: VALID_KEY, userID: '1', itemKey: 'ABCD1234', fetchImpl: f })
  } catch (e) { caught = e }
  check('PATCH 缺 version → bad_request',
    caught?.code === ERROR_CODES.BAD_REQUEST && f.calls.length === 0,
    `code=${caught?.code} calls=${f.calls.length}`)
}

/* 6.8 PATCH 带 If-Unmodified-Since-Version */
{
  const f = stubFetch([{ status: 200, body: '{}' }])
  const { updateCloudItem } = await import('../host/zotero-cloud.js')
  await updateCloudItem({
    apiKey: VALID_KEY, userID: '1', itemKey: 'ABCD1234', version: 77,
    patch: { title: 'x' }, fetchImpl: f, sleep: async () => {},
  })
  const init = f.calls[0]?.init ?? {}
  check('PATCH 带 If-Unmodified-Since-Version: 77',
    init.headers?.['If-Unmodified-Since-Version'] === '77',
    String(init.headers?.['If-Unmodified-Since-Version']))
  check('PATCH 方法正确', init.method === 'PATCH', String(init.method))
  check('PATCH body 是 JSON', init.body === '{"title":"x"}', String(init.body))
}

/* 6.9 POST 带 Zotero-Write-Token */
{
  const f = stubFetch([{ status: 200, body: '{"successful":{}}' }])
  const { createCloudItems } = await import('../host/zotero-cloud.js')
  await createCloudItems({
    apiKey: VALID_KEY, userID: '1',
    items: [{ itemType: 'annotation' }], fetchImpl: f, sleep: async () => {},
  })
  const init = f.calls[0]?.init ?? {}
  check('POST 带 Zotero-Write-Token',
    typeof init.headers?.['Zotero-Write-Token'] === 'string' && init.headers['Zotero-Write-Token'].length > 0,
    String(init.headers?.['Zotero-Write-Token']))
  check('POST 方法正确', init.method === 'POST', String(init.method))
}

/* 6.10 DELETE 带版本号 */
{
  const f = stubFetch([{ status: 204, body: '' }])
  const { deleteCloudItem } = await import('../host/zotero-cloud.js')
  await deleteCloudItem({ apiKey: VALID_KEY, userID: '1', itemKey: 'K', version: 9, fetchImpl: f, sleep: async () => {} })
  const init = f.calls[0]?.init ?? {}
  check('DELETE 带版本号', init.headers?.['If-Unmodified-Since-Version'] === '9')
  check('DELETE 方法正确', init.method === 'DELETE')
}

/* -------------------------------------------- 7) 批注请求体形状 */

const annItem = buildAnnotationItem({
  parentItem: 'ATTACH01', text: '被高亮的原文', comment: '我的批注',
  color: '#ffd400', pageLabel: '12', sortIndex: '00012|000001',
})
check('批注 itemType=annotation', annItem.itemType === 'annotation', annItem.itemType)
check('批注挂 parentItem', annItem.parentItem === 'ATTACH01')
check('批注带 annotationText', annItem.annotationText === '被高亮的原文')
check('批注带 annotationComment', annItem.annotationComment === '我的批注')
check('批注带 pageLabel', annItem.annotationPageLabel === '12')
check('批注带 sortIndex', annItem.annotationSortIndex === '00012|000001')
check('批注默认颜色', buildAnnotationItem({ parentItem: 'A', text: 'x' }).annotationColor === '#ffd400')

let annErr = null
try { buildAnnotationItem({ text: 'x' }) } catch (e) { annErr = e }
check('批注缺 parentItem → bad_request', annErr?.code === ERROR_CODES.BAD_REQUEST, String(annErr?.code))

let annErr2 = null
try { buildAnnotationItem({ parentItem: 'A' }) } catch (e) { annErr2 = e }
check('批注无 text 且无 comment → bad_request', annErr2?.code === ERROR_CODES.BAD_REQUEST)

/* ------------------------------------------------- 8) 错误载荷形状 */

const payload = toErrorPayload(new CloudApiError(ERROR_CODES.INVALID_KEY, '坏 key'))
check('toErrorPayload 回 ok:false', payload.ok === false)
check('toErrorPayload 带 code', payload.code === ERROR_CODES.INVALID_KEY)
check('toErrorPayload 带 message', payload.error === '坏 key')
check('toErrorPayload 处理非 CloudApiError',
  toErrorPayload(new Error('boom')).code === ERROR_CODES.UNKNOWN)

/* ------------------------------------------------- 9) write token 唯一性 */

const t1 = makeWriteToken()
const t2 = makeWriteToken()
check('write token 非空', typeof t1 === 'string' && t1.length >= 16, t1)
check('write token 每次不同', t1 !== t2, `${t1} vs ${t2}`)

/* ------------------------------------------------------------ 汇总 */

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
