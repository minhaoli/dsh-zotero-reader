/**
 * PATCH / DELETE /annotations 的云端回退接线测试（离线，不写用户库）。
 *
 * 「本地不可用」是**真的**造出来的：把 globalThis.fetch 临时换成必失败的桩，
 * 于是 probeLocalApi() 抛 ECONNREFUSED —— 与用户关掉 Zotero 时走的是同一条路径，
 * 不是靠伪造返回值骗过判定。
 *
 * 云端用 deps.fetchImpl 注入假云端；即使代码真的想连 api.zotero.org 也只会打到桩上。
 *
 * 运行：在插件目录里 `node test/check-annotation-writeback-route.mjs`
 */

import { apply } from '../index.js'

const registered = { tools: [], routes: [] }

function makeCtx() {
  const ctx = {
    tools: { register: (def) => { registered.tools.push(def); return () => {} } },
    effect: (fn) => fn(),
    inject: (deps, cb) => {
      const stub = {
        webServer: { register: (opts) => { registered.routes.push(opts); return () => {} } },
        connection: { requestRejection: () => undefined },
        llm: { stream: async function* () { yield { type: 'text-delta', text: '' } } },
        agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
      }
      cb({ ...ctx, ...stub })
    },
  }
  return ctx
}

function makeReqRes(path, { method = 'GET', headers = {}, body } = {}) {
  const req = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
  const chunks = []
  let status = 0
  let resHeaders = {}
  let finished
  const done = new Promise((resolve) => { finished = resolve })
  const res = {
    setHeader: (k, v) => { resHeaders[k] = v },
    writeHead: (code, hdrs) => { status = code; resHeaders = { ...resHeaders, ...hdrs } },
    write: (b) => { chunks.push(Buffer.from(b)) },
    end: (b) => {
      if (b) chunks.push(Buffer.from(b))
      if (!res.done) { res.done = true; finished() }
    },
    get statusCode() { return status },
    get headers() { return resHeaders },
    get body() { return Buffer.concat(chunks) },
    get text() { return Buffer.concat(chunks).toString('utf8') },
    get json() { try { return JSON.parse(this.text) } catch { return null } },
    headersSent: false,
    done: false,
    finished: done,
  }
  return { req, res }
}

async function callHandler(path, opts) {
  const route = registered.routes[0]
  if (!route) throw new Error('没有注册任何路由')
  const { req, res } = makeReqRes(path, opts)
  route.handler(req, res)
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 60_000))
  const outcome = await Promise.race([res.finished, timeout])
  if (outcome === 'timeout') throw new Error(`请求 ${path} 超时未响应`)
  return res
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------ 假云端 */

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
/** 独立的变量名：这个 key 只在本测试里有效，不读用户的 ~/.dsh/.env。 */
const KEY = 'C'.repeat(24)

function makeCloud(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase()
    const pathname = new URL(String(url)).pathname
    calls.push({
      method,
      pathname,
      body: init.body ? JSON.parse(init.body) : null,
      headers: { ...(init.headers ?? {}) },
    })
    const route = routes[`${method} ${pathname}`]
    if (!route) return reply(404, { error: `未模拟的路由：${method} ${pathname}` })
    return typeof route === 'function' ? route(init) : route
  }
  return { calls, fetchImpl }
}

const probeWrite = reply(200, {
  userID: Number(USER),
  username: 'tester',
  access: { user: { write: true } },
})

const cloud = makeCloud({
  'GET /keys/current': probeWrite,
  [`GET /users/${USER}/items/ANN00001`]: reply(200, {
    key: 'ANN00001',
    version: 5,
    data: { itemType: 'annotation', parentItem: 'ATTACH01' },
  }),
  [`PATCH /users/${USER}/items/ANN00001`]: reply(204, ''),
  [`DELETE /users/${USER}/items/ANN00001`]: reply(204, ''),
  [`GET /users/${USER}/items/ANN00002`]: reply(200, {
    key: 'ANN00002',
    version: 5,
    data: { itemType: 'annotation', parentItem: 'ATTACH01' },
  }),
  // 这条模拟「读完之后被别人改了」：PATCH 回来 412
  [`PATCH /users/${USER}/items/ANN00002`]: reply(412, 'Precondition Failed'),
  [`GET /users/${USER}/items/ANN00003`]: reply(404, { error: 'Not found' }),
})

process.env.DSH_TEST_CLOUD_KEY = KEY
apply(makeCtx(), {
  zoteroDataDir: '',
  mineruMode: 'none',
  cloudApiKeyEnv: 'DSH_TEST_CLOUD_KEY',
  __fetchImpl: cloud.fetchImpl,
})

/* 从这里开始，本地 API 一律连不上（等同 Zotero 没开） */
const realFetch = globalThis.fetch
const localDown = async () => {
  const error = new Error('fetch failed')
  error.cause = { code: 'ECONNREFUSED' }
  throw error
}
globalThis.fetch = localDown

/* ------------------------------------------------- 1) 改色（云端回退） */

const p1 = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH',
  body: { annotKey: 'ANN00001', color: '#FF6666' },
})
check('本地不可用时改色 → 200', p1.statusCode === 200, `status=${p1.statusCode} body=${p1.text.slice(0, 120)}`)
check('改色标 via=cloud', p1.json?.via === 'cloud', String(p1.json?.via))
check('改色回 patch.annotationColor',
  p1.json?.patch?.annotationColor === '#ff6666', JSON.stringify(p1.json?.patch))
check('改色带回本地失败原因', /连不上|连接/.test(p1.json?.localError ?? ''), p1.json?.localError)

const p1Patch = cloud.calls.find((c) => c.method === 'PATCH')
check('改色 PATCH 带 If-Unmodified-Since-Version',
  p1Patch?.headers?.['If-Unmodified-Since-Version'] === '5',
  String(p1Patch?.headers?.['If-Unmodified-Since-Version']))
check('改色只发一次 PATCH', cloud.calls.filter((c) => c.method === 'PATCH' && c.pathname.endsWith('ANN00001')).length === 1)

/* -------------------------------------- 2) 非法颜色：业务错误不回退 */

const beforeBad = cloud.calls.length
const p2 = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH',
  body: { annotKey: 'ANN00001', color: '#xyz' },
})
check('非法颜色 → 400', p2.statusCode === 400, `status=${p2.statusCode}`)
check('非法颜色标 via=local（没有换通道）', p2.json?.via === 'local', String(p2.json?.via))
check('非法颜色提示颜色格式', /颜色格式不对/.test(p2.json?.error ?? ''), p2.json?.error)
check('非法颜色不发任何云端请求', cloud.calls.length === beforeBad, `calls=${cloud.calls.length - beforeBad}`)

/* ------------------------------------- 3) 412：409 + 可操作提示 */

const p3 = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH',
  body: { annotKey: 'ANN00002', color: '#00ff00' },
})
check('改色 412 → 409', p3.statusCode === 409, `status=${p3.statusCode}`)
check('改色 412 提示重新读取后再改',
  /重新打开批注面板|最新状态/.test(p3.json?.error ?? ''), p3.json?.error)
check('改色 412 标 via=null', p3.json?.via === null, String(p3.json?.via))
check('改色 412 只发一次 PATCH（没有静默重试）',
  cloud.calls.filter((c) => c.method === 'PATCH' && c.pathname.endsWith('ANN00002')).length === 1)

/* --------------------------------------------- 4) 删除（云端回退） */

const d1 = await callHandler('/zotero-reader/annotations?annotKey=ANN00001', { method: 'DELETE' })
check('本地不可用时删除 → 200', d1.statusCode === 200, `status=${d1.statusCode} body=${d1.text.slice(0, 120)}`)
check('删除标 via=cloud', d1.json?.via === 'cloud', String(d1.json?.via))
check('删除回 parentItem', d1.json?.parentItem === 'ATTACH01', String(d1.json?.parentItem))
const d1Delete = cloud.calls.find((c) => c.method === 'DELETE')
check('删除带 If-Unmodified-Since-Version',
  d1Delete?.headers?.['If-Unmodified-Since-Version'] === '5',
  String(d1Delete?.headers?.['If-Unmodified-Since-Version']))
check('删除只发一次 DELETE', cloud.calls.filter((c) => c.method === 'DELETE').length === 1)

/* -------------------------------- 5) 删除：参数缺失 / 云端已不存在 */

const d2 = await callHandler('/zotero-reader/annotations', { method: 'DELETE' })
check('删除缺 annotKey → 400', d2.statusCode === 400, `status=${d2.statusCode}`)
check('删除缺 annotKey 不发云端请求', !cloud.calls.some((c) => c.method === 'DELETE' && c.pathname.endsWith('/items/')))

const d3 = await callHandler('/zotero-reader/annotations?annotKey=ANN00003', { method: 'DELETE' })
check('删除云端已不存在 → 404', d3.statusCode === 404, `status=${d3.statusCode}`)
check('删除 404 不冒充成功', d3.json?.ok !== true)
check('删除 404 不发 DELETE', cloud.calls.filter((c) => c.method === 'DELETE' && c.pathname.endsWith('ANN00003')).length === 0)

/* ------------------------------------------------------------ 汇总 */

globalThis.fetch = realFetch

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
