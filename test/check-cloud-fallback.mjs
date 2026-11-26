/**
 * 云端回退层测试。
 *
 * 全部用假的 fetchImpl：这里验证的是「什么情况下回退、回退时发什么请求、
 * 失败怎么分类」，不碰真实网络（也没有真实 Zotero 账号）。
 *
 * 运行：在插件目录里 `node test/check-cloud-fallback.mjs`
 */

import { deriveSortIndex } from '../host/annotations.js'
import {
  ERROR_CODES,
  CloudApiError,
} from '../host/zotero-cloud.js'
import {
  localChannelAbsent,
  resolveCloudIdentity,
  resetCloudIdentityCache,
  cloudAnnotationType,
  writeAnnotationViaCloud,
  readAnnotationsViaCloud,
  findCloudPdfAttachment,
  cloudWriteCapability,
  cloudFailureResponse,
} from '../host/annotations-fallback.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* --------------------------------------------------- 假 fetch 基础设施 */

/** 造一个 Response 的最小替身：cloudRequest 只用到 status/headers.get/text()。 */
function reply(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() { return text },
  }
}

const USER = '123456'
const KEY = 'A'.repeat(24)

/**
 * 按「方法 + 路径」路由的假云端。
 * routes 的值可以是回复对象，也可以是 (init) => 回复对象的函数。
 */
function makeCloud(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase()
    const pathname = new URL(String(url)).pathname
    calls.push({ method, pathname, url: String(url), body: init.body ? JSON.parse(init.body) : null })
    const route = routes[`${method} ${pathname}`]
    if (!route) return reply(404, { error: `未模拟的路由：${method} ${pathname}` })
    return typeof route === 'function' ? route(init) : route
  }
  return { calls, fetchImpl }
}

const probeWrite = reply(200, { userID: Number(USER), username: 'tester', access: { user: { write: true } } })
const probeReadOnly = reply(200, { userID: Number(USER), username: 'tester', access: { user: { write: false } } })
const selfAttachment = reply(200, { key: 'ATTACH01', version: 3, data: { itemType: 'attachment', contentType: 'application/pdf' } })

/** 一次完整的写：探测 → 认领自己（附件）→ POST 条目。 */
function happyWriteRoutes(overrides = {}) {
  return {
    [`GET /keys/current`]: probeWrite,
    [`GET /users/${USER}/items/ATTACH01`]: selfAttachment,
    [`POST /users/${USER}/items`]: reply(200, { successful: { 0: { key: 'ANN00001', version: 7 } }, failed: {} }),
    ...overrides,
  }
}

/* ------------------------------------------------ 1) 回退判定谓词 */

check('unavailable → 回退', localChannelAbsent({ ok: false, unavailable: true, reason: '连不上' }) === true)
check('unsupported（Zotero<10）→ 回退', localChannelAbsent({ ok: false, unsupported: true, needAuth: true }) === true)
check('授权被拒（needAuth）→ 不回退',
  localChannelAbsent({ ok: false, needAuth: true, reason: 'Zotero 授权被拒绝' }) === false)
check('本地服务端拒绝写入 → 不回退',
  localChannelAbsent({ ok: false, reason: 'Zotero 拒绝创建批注：parent item 不存在' }) === false)
check('写入途中断网（无标记）→ 不回退',
  localChannelAbsent({ ok: false, reason: '写入 Zotero 时连接失败：ECONNRESET' }) === false)
check('unavailable 显式为 false → 不回退', localChannelAbsent({ ok: false, unavailable: false }) === false)
check('成功结果 → 不触发回退', localChannelAbsent({ ok: true, key: 'X' }) === false)
check('null 安全', localChannelAbsent(null) === false)

/* ------------------------------------------------ 2) 批注类型映射 */

check('highlight 原样', cloudAnnotationType('highlight') === 'highlight')
check('underline 原样（不能写成高亮）', cloudAnnotationType('underline') === 'underline')
check('note 原样', cloudAnnotationType('note') === 'note')
check('freetext → note', cloudAnnotationType('freetext') === 'note')
check('ink → note（云端 ink 需要笔迹点列）', cloudAnnotationType('ink') === 'note')
check('未知/空 → highlight', cloudAnnotationType('') === 'highlight' && cloudAnnotationType(undefined) === 'highlight')

/* ------------------------------------------------ 3) sortIndex 与本地同源 */

const sortIndex = deriveSortIndex({ pageIndex: 2, rects: [[10, 20, 30, 700]], pageHeightPt: 842 })
check('sortIndex 三段格式', /^\d{5}\|\d{6}\|\d{5}$/.test(sortIndex), sortIndex)
check('sortIndex 具体值', sortIndex === '00002|000000|00142', sortIndex)
check('缺页高时退化为 rectTop', deriveSortIndex({ pageIndex: 0, rects: [[0, 0, 0, 700]] }) === '00000|000000|00700')

/* ------------------------------------------------ 4) 身份解析与缓存 */

resetCloudIdentityCache()
let noKey = null
try { await resolveCloudIdentity({}) } catch (e) { noKey = e }
check('没配 key → no_key', noKey?.code === ERROR_CODES.NO_KEY, String(noKey?.code))
check('no_key 提示提到环境变量', /ZOTERO_API_KEY/.test(noKey?.message ?? ''))

resetCloudIdentityCache()
const c1 = makeCloud({ [`GET /keys/current`]: probeWrite })
const id1 = await resolveCloudIdentity({ cloudApiKey: KEY }, { fetchImpl: c1.fetchImpl })
check('自动取到 userID', id1.userID === USER, id1.userID)
check('canWrite=true', id1.canWrite === true)
check('来源是探测', id1.source === 'probe')
const id2 = await resolveCloudIdentity({ cloudApiKey: KEY }, { fetchImpl: c1.fetchImpl })
check('第二次命中缓存，不再探测', c1.calls.length === 1 && id2.cached === true, `calls=${c1.calls.length}`)

resetCloudIdentityCache()
const c2 = makeCloud({ [`GET /keys/current`]: probeReadOnly })
const ro = await resolveCloudIdentity({ cloudApiKey: KEY }, { fetchImpl: c2.fetchImpl })
check('只读 key → canWrite=false', ro.canWrite === false)

resetCloudIdentityCache()
const c3 = makeCloud({ [`GET /keys/current`]: probeWrite })
const manual = await resolveCloudIdentity({ cloudApiKey: KEY, cloudUserID: '999' }, { fetchImpl: c3.fetchImpl })
check('手填 userID 优先于探测', manual.userID === '999' && manual.source === 'settings')

resetCloudIdentityCache()
const c4 = makeCloud({ [`GET /keys/current`]: probeWrite })
let badId = null
try { await resolveCloudIdentity({ cloudApiKey: KEY, cloudUserID: 'abc' }, { fetchImpl: c4.fetchImpl }) } catch (e) { badId = e }
check('非数字 userID → bad_request', badId?.code === ERROR_CODES.BAD_REQUEST, String(badId?.code))

resetCloudIdentityCache()
const c5 = makeCloud({ [`GET /keys/current`]: reply(403, 'Invalid key') })
let badKey = null
try { await resolveCloudIdentity({ cloudApiKey: KEY }, { fetchImpl: c5.fetchImpl }) } catch (e) { badKey = e }
check('无效 key → invalid_key', badKey?.code === ERROR_CODES.INVALID_KEY, String(badKey?.code))

/* ------------------------------------------------ 5) 云端写入 */

resetCloudIdentityCache()
const w1 = makeCloud(happyWriteRoutes())
const written = await writeAnnotationViaCloud({
  settings: { cloudApiKey: KEY },
  itemKey: 'ITEM0001',
  attachmentKey: 'ATTACH01',
  text: '被高亮的原文',
  comment: '我的批注',
  color: '#ffd400',
  pageIndex: 2,
  rects: [[10, 20, 30, 700]],
  pageHeightPt: 842,
  pageLabel: 3,
  annotationKind: 'highlight',
  fetchImpl: w1.fetchImpl,
})
check('云端写入回 key', written.ok === true && written.key === 'ANN00001', String(written.key))
check('云端写入回 version', written.version === 7)
check('parentItem 是附件 key', written.parentItem === 'ATTACH01')

const postCall = w1.calls.find((c) => c.method === 'POST')
const postedItem = postCall?.body?.[0] ?? {}
check('只发一次 POST（不重试）', w1.calls.filter((c) => c.method === 'POST').length === 1)
check('请求体是条目数组', Array.isArray(postCall?.body) && postCall.body.length === 1)
check('批注 itemType', postedItem.itemType === 'annotation')
check('批注挂附件 key', postedItem.parentItem === 'ATTACH01')
check('annotationText 写入', postedItem.annotationText === '被高亮的原文')
check('annotationComment 写入', postedItem.annotationComment === '我的批注')
check('annotationColor 写入', postedItem.annotationColor === '#ffd400')
check('pageLabel 是字符串', postedItem.annotationPageLabel === '3')
check('sortIndex 与本地同一个函数算出', postedItem.annotationSortIndex === sortIndex, postedItem.annotationSortIndex)
check('position 是 {pageIndex, rects}',
  JSON.parse(postedItem.annotationPosition).pageIndex === 2
  && JSON.stringify(JSON.parse(postedItem.annotationPosition).rects) === JSON.stringify([[10, 20, 30, 700]]))
check('annotationType=highlight', postedItem.annotationType === 'highlight')

/* 便签：文字要落到 comment，不能写 annotationText（Zotero 会拒） */
resetCloudIdentityCache()
const w2 = makeCloud(happyWriteRoutes())
await writeAnnotationViaCloud({
  settings: { cloudApiKey: KEY },
  itemKey: 'ITEM0001',
  attachmentKey: 'ATTACH01',
  text: '便签内容',
  pageIndex: 0,
  rects: [[1, 2, 3, 4]],
  annotationKind: 'note',
  fetchImpl: w2.fetchImpl,
})
const noteItem = w2.calls.find((c) => c.method === 'POST').body[0]
check('便签 annotationType=note', noteItem.annotationType === 'note')
check('便签文字进 comment', noteItem.annotationComment === '便签内容')
check('便签 annotationText 为空', noteItem.annotationText === '')

/* 下划线不能被写成高亮 */
resetCloudIdentityCache()
const w3 = makeCloud(happyWriteRoutes())
await writeAnnotationViaCloud({
  settings: { cloudApiKey: KEY },
  itemKey: 'ITEM0001',
  attachmentKey: 'ATTACH01',
  text: '下划线',
  pageIndex: 0,
  rects: [[1, 2, 3, 4]],
  annotationKind: 'underline',
  fetchImpl: w3.fetchImpl,
})
check('下划线保持 underline', w3.calls.find((c) => c.method === 'POST').body[0].annotationType === 'underline')

/* 只读 key：写之前就拒绝，一次写请求都不发 */
resetCloudIdentityCache()
const w4 = makeCloud({ [`GET /keys/current`]: probeReadOnly })
let readOnlyErr = null
try {
  await writeAnnotationViaCloud({
    settings: { cloudApiKey: KEY }, itemKey: 'ITEM0001', attachmentKey: 'ATTACH01',
    text: 'x', rects: [[1, 2, 3, 4]], fetchImpl: w4.fetchImpl,
  })
} catch (e) { readOnlyErr = e }
check('只读 key → read_only', readOnlyErr?.code === ERROR_CODES.READ_ONLY, String(readOnlyErr?.code))
check('只读 key 不发写请求', w4.calls.filter((c) => c.method === 'POST').length === 0)
check('只读提示提到 Allow write access', /Allow write access/.test(readOnlyErr?.message ?? ''))

/* 空批注（涂鸦/空便签无备注）：明确拒绝，不发请求 */
resetCloudIdentityCache()
const w5 = makeCloud(happyWriteRoutes())
let emptyErr = null
try {
  await writeAnnotationViaCloud({
    settings: { cloudApiKey: KEY }, itemKey: 'ITEM0001', attachmentKey: 'ATTACH01',
    pageIndex: 0, rects: [[1, 2, 3, 4]], annotationKind: 'ink', fetchImpl: w5.fetchImpl,
  })
} catch (e) { emptyErr = e }
check('空批注 → bad_request', emptyErr?.code === ERROR_CODES.BAD_REQUEST, String(emptyErr?.code))
check('空批注不发 POST', w5.calls.filter((c) => c.method === 'POST').length === 0)

/* 云端 500：只发一次，不重试 */
resetCloudIdentityCache()
const w6 = makeCloud(happyWriteRoutes({ [`POST /users/${USER}/items`]: reply(500, 'boom') }))
let serverErr = null
try {
  await writeAnnotationViaCloud({
    settings: { cloudApiKey: KEY }, itemKey: 'ITEM0001', attachmentKey: 'ATTACH01',
    text: 'x', rects: [[1, 2, 3, 4]], fetchImpl: w6.fetchImpl,
  })
} catch (e) { serverErr = e }
check('500 → server 错误', serverErr?.code === ERROR_CODES.SERVER, String(serverErr?.code))
check('500 只发一次 POST（没有重试风暴）', w6.calls.filter((c) => c.method === 'POST').length === 1)

/* 写入途中网络断：一次 POST 后就放弃 */
resetCloudIdentityCache()
const netCalls = []
const netFetch = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase()
  const pathname = new URL(String(url)).pathname
  netCalls.push({ method, pathname })
  if (pathname.endsWith('/keys/current')) return probeWrite
  if (method === 'GET') return selfAttachment
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNRESET' }
  throw err
}
let netErr = null
try {
  await writeAnnotationViaCloud({
    settings: { cloudApiKey: KEY }, itemKey: 'ITEM0001', attachmentKey: 'ATTACH01',
    text: 'x', rects: [[1, 2, 3, 4]], fetchImpl: netFetch,
  })
} catch (e) { netErr = e }
check('写入断网 → network', netErr?.code === ERROR_CODES.NETWORK, String(netErr?.code))
check('断网只尝试一次 POST', netCalls.filter((c) => c.method === 'POST').length === 1)

/* 412 版本冲突（用 update 类语义时会出现；这里直接验分类映射） */
check('412 → version_conflict',
  cloudFailureResponse(new CloudApiError(ERROR_CODES.VERSION_CONFLICT, 'conflict')).status === 409)

/* ------------------------------------------------ 6) 云端附件定位 */

resetCloudIdentityCache()
const f1 = makeCloud({
  [`GET /keys/current`]: probeWrite,
  [`GET /users/${USER}/items/ITEM0001`]: reply(200, { key: 'ITEM0001', data: { itemType: 'journalArticle' } }),
  [`GET /users/${USER}/items/ITEM0001/children`]: reply(200, [
    { key: 'SNAP0001', data: { itemType: 'attachment', contentType: 'text/html' } },
    { key: 'ATTACH02', data: { itemType: 'attachment', contentType: 'application/pdf' } },
  ]),
})
const identityA = await resolveCloudIdentity({ cloudApiKey: KEY }, { fetchImpl: f1.fetchImpl })
const foundPdf = await findCloudPdfAttachment({ identity: identityA, itemKey: 'ITEM0001', fetchImpl: f1.fetchImpl })
check('从子条目里挑出 PDF 附件', foundPdf === 'ATTACH02', String(foundPdf))

resetCloudIdentityCache()
const f2 = makeCloud({
  [`GET /keys/current`]: probeWrite,
  [`GET /users/${USER}/items/ATTACH09`]: reply(200, { key: 'ATTACH09', data: { itemType: 'attachment', contentType: 'application/pdf' } }),
})
const identityB = await resolveCloudIdentity({ cloudApiKey: KEY }, { fetchImpl: f2.fetchImpl })
const selfPdf = await findCloudPdfAttachment({ identity: identityB, itemKey: 'ATTACH09', fetchImpl: f2.fetchImpl })
check('itemKey 本身就是 PDF 附件时直接用', selfPdf === 'ATTACH09')
check('认领自己后不再查 children',
  f2.calls.filter((c) => c.pathname.endsWith('/children')).length === 0)

/* 没有附件 → 写之前报 not_found */
resetCloudIdentityCache()
const f3 = makeCloud({
  [`GET /keys/current`]: probeWrite,
  [`GET /users/${USER}/items/ITEM0002`]: reply(200, { key: 'ITEM0002', data: { itemType: 'journalArticle' } }),
  [`GET /users/${USER}/items/ITEM0002/children`]: reply(200, []),
})
let noPdfErr = null
try {
  await writeAnnotationViaCloud({
    settings: { cloudApiKey: KEY }, itemKey: 'ITEM0002',
    text: 'x', rects: [[1, 2, 3, 4]], fetchImpl: f3.fetchImpl,
  })
} catch (e) { noPdfErr = e }
check('云端没有 PDF → not_found', noPdfErr?.code === ERROR_CODES.NOT_FOUND, String(noPdfErr?.code))
check('找不到附件时不发 POST', f3.calls.filter((c) => c.method === 'POST').length === 0)

/* ------------------------------------------------ 7) 云端读取与字段映射 */

resetCloudIdentityCache()
const r1 = makeCloud({
  [`GET /keys/current`]: probeWrite,
  [`GET /users/${USER}/items/ATTACH01/children`]: reply(200, [
    {
      key: 'ANN00001', version: 4,
      data: {
        itemType: 'annotation',
        annotationType: 'underline',
        annotationText: '被划的原文',
        annotationComment: '注释',
        annotationColor: '#2ea8e5',
        annotationPageLabel: '',
        annotationSortIndex: '00002|000000|00142',
        annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[1, 2, 3, 4]] }),
        tags: [{ tag: '重点' }],
      },
    },
    {
      key: 'ANN00002', version: 5,
      data: {
        itemType: 'annotation', annotationType: 'note', annotationText: '',
        annotationComment: '便签', annotationColor: '#ffd400', annotationPageLabel: '9',
        annotationPosition: 'not-json', tags: [],
      },
    },
  ], { 'total-results': '2' }),
})
const read1 = await readAnnotationsViaCloud({
  settings: { cloudApiKey: KEY }, itemKey: 'ATTACH01', attachmentKey: 'ATTACH01', fetchImpl: r1.fetchImpl,
})
check('读回 2 条', read1.annotations.length === 2, String(read1.annotations.length))
const a0 = read1.annotations[0]
check('读回类型', a0.type === 'underline')
check('读回正文/备注/颜色', a0.text === '被划的原文' && a0.comment === '注释' && a0.color === '#2ea8e5')
check('读回 tags 是数组', JSON.stringify(a0.tags) === JSON.stringify(['重点']))
check('pageLabel 缺失时用 pageIndex+1', a0.page === 3, String(a0.page))
check('读回 pageIndex', a0.pageIndex === 2)
check('读回 rects', JSON.stringify(a0.rects) === JSON.stringify([[1, 2, 3, 4]]))
check('读回 sortIndex', a0.sortIndex === '00002|000000|00142')
check('损坏的 position 不炸', read1.annotations[1].rects.length === 0 && read1.annotations[1].pageIndex === null)
check('pageLabel 有值时用它', read1.annotations[1].page === 9)
check('读回 attachmentKey', read1.attachmentKey === 'ATTACH01')
check('读回带 canWrite', read1.canWrite === true)

/* 只读 key 也能读，但 canWrite=false */
resetCloudIdentityCache()
const r2 = makeCloud({
  [`GET /keys/current`]: probeReadOnly,
  [`GET /users/${USER}/items/ATTACH01/children`]: reply(200, []),
})
const read2 = await readAnnotationsViaCloud({
  settings: { cloudApiKey: KEY }, itemKey: 'ATTACH01', attachmentKey: 'ATTACH01', fetchImpl: r2.fetchImpl,
})
check('只读 key 可读批注', Array.isArray(read2.annotations))
check('只读 key 读回 canWrite=false', read2.canWrite === false)
check('只读 key 给出写受阻原因', /读权限/.test(read2.writeBlockedReason ?? ''))

/* ------------------------------------------------ 8) 能力探测 */

resetCloudIdentityCache()
const cap0 = await cloudWriteCapability({})
check('没配 key → configured=false', cap0.configured === false && cap0.canWrite === false)
check('没配 key 不抛错', typeof cap0.reason === 'string' || cap0.reason === null)

resetCloudIdentityCache()
const capCalls = []
const capFetch = async (url) => {
  capCalls.push(String(url))
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  throw err
}
const cap1 = await cloudWriteCapability({ cloudApiKey: KEY }, { fetchImpl: capFetch, timeoutMs: 1000 })
check('探测失败 → canWrite=false', cap1.configured === true && cap1.canWrite === false)
check('探测失败给可读原因', /连不上|网络/.test(cap1.reason ?? ''), cap1.reason)
const cap2 = await cloudWriteCapability({ cloudApiKey: KEY }, { fetchImpl: capFetch, timeoutMs: 1000 })
check('探测失败 60 秒内不重复联网', capCalls.length === 1 && cap2.canWrite === false, `calls=${capCalls.length}`)

/* ------------------------------------------------ 9) 错误分类表 */

const expectedStatus = [
  [ERROR_CODES.NO_KEY, 400],
  [ERROR_CODES.INVALID_KEY, 401],
  [ERROR_CODES.FORBIDDEN, 403],
  [ERROR_CODES.READ_ONLY, 403],
  [ERROR_CODES.NOT_FOUND, 404],
  [ERROR_CODES.VERSION_CONFLICT, 409],
  [ERROR_CODES.RATE_LIMITED, 429],
  [ERROR_CODES.NETWORK, 502],
  [ERROR_CODES.TIMEOUT, 504],
  [ERROR_CODES.SERVER, 502],
  [ERROR_CODES.BAD_REQUEST, 400],
  [ERROR_CODES.UNKNOWN, 502],
]
for (const [code, status] of expectedStatus) {
  const out = cloudFailureResponse(new CloudApiError(code, `${code} 的说明`))
  check(`${code} → ${status}`, out.status === status && out.body.code === code, `${out.status}`)
  check(`${code} 带可读原因`, typeof out.body.error === 'string' && out.body.error.length > 0)
}
check('非 CloudApiError 归到 unknown', cloudFailureResponse(new Error('boom')).code === undefined
  ? cloudFailureResponse(new Error('boom')).body.code === ERROR_CODES.UNKNOWN
  : cloudFailureResponse(new Error('boom')).body.code === ERROR_CODES.UNKNOWN)

/* ------------------------------------------------------------ 汇总 */

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
