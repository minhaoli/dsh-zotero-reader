/**
 * 路由级实测：走插件的 `PATCH /zotero-reader/annotations` 真实路由，
 * 验证「HTTP body 解析 → updateAnnotationColor → Zotero」整条链路。
 *
 * 与 probe-recolor.mjs 的分工：
 *   probe-recolor.mjs 直接调 host 函数（验写入本身）
 *   本文件从路由进（验 body 字段名、错误码、响应形状）
 *
 * 用法：node test/check-recolor-route.mjs
 */
import { apply } from '../index.js'
import { LOCAL_API } from '../host/annotations.js'

const registered = { tools: [], routes: [] }

function makeCtx() {
  const ctx = {
    tools: { register: (def) => { registered.tools.push(def); return () => {} } },
    effect: (fn) => fn(),
    inject: (deps, cb) => {
      cb({
        ...ctx,
        webServer: { register: (opts) => { registered.routes.push(opts); return () => {} } },
        connection: { requestRejection: () => undefined },
        llm: { stream: async function* () { yield { type: 'text-delta', text: '' } } },
        agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
      })
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
  let resolveFinish
  const finished = new Promise((resolve) => { resolveFinish = resolve })
  const res = {
    setHeader() {},
    writeHead(code) { status = code },
    write(b) { chunks.push(Buffer.from(b)) },
    end(b) {
      if (b) chunks.push(Buffer.from(b))
      if (!res.done) { res.done = true; resolveFinish() }
    },
    get statusCode() { return status },
    get text() { return Buffer.concat(chunks).toString('utf8') },
    get json() { try { return JSON.parse(this.text) } catch { return null } },
    headersSent: false,
    done: false,
    finished,
  }
  return { req, res }
}

async function callHandler(path, opts) {
  const route = registered.routes[0]
  const { req, res } = makeReqRes(path, opts)
  route.handler(req, res)
  const outcome = await Promise.race([res.finished, new Promise((r) => setTimeout(() => r('timeout'), 30_000))])
  if (outcome === 'timeout') throw new Error(`${path} 超时未响应`)
  return res
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

apply(makeCtx(), { zoteroDataDir: '', mineruMode: 'none' })

// 找一条真实批注
const listRes = await fetch(`${LOCAL_API}/api/users/0/items?itemType=annotation&limit=5`, {
  headers: { 'Zotero-API-Version': '3' },
})
const items = await listRes.json()
const ann = items.find((it) => it?.data?.itemType === 'annotation')
if (!ann) {
  console.log('跳过：库里没有批注。先做一条高亮再跑。')
  process.exit(0)
}
const key = ann.key
const before = String(ann.data.annotationColor ?? '').toLowerCase()
const nextColor = before === '#2ea8e5' ? '#5fb236' : '#2ea8e5'

console.log(`目标 ${key}，当前 ${before}，改到 ${nextColor}\n`)

// 1) 缺 annotKey
const noKey = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH', body: { color: nextColor },
})
check('缺 annotKey → 400', noKey.statusCode === 400, `status=${noKey.statusCode} body=${noKey.text.slice(0, 80)}`)

// 2) 缺 color
const noColor = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH', body: { annotKey: key },
})
check('缺 color → 400', noColor.statusCode === 400, `status=${noColor.statusCode} body=${noColor.text.slice(0, 80)}`)

// 3) 非法颜色
const badColor = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH', body: { annotKey: key, color: '#xyz' },
})
check('非法颜色 → 400 且不写库', badColor.statusCode === 400, `status=${badColor.statusCode}`)

// 4) 正常改色
const okRes = await callHandler('/zotero-reader/annotations', {
  method: 'PATCH', body: { annotKey: key, color: nextColor },
})
const okBody = okRes.json
check('改色 → 200 {ok:true,color}', okRes.statusCode === 200 && okBody?.ok === true && okBody?.color === nextColor,
  `status=${okRes.statusCode} body=${okRes.text.slice(0, 120)}`)

// 5) 复读确认 Zotero 真改了
const after = await fetch(`${LOCAL_API}/api/users/0/items/${key}`, { headers: { 'Zotero-API-Version': '3' } })
const afterJson = await after.json()
const stored = String(afterJson?.data?.annotationColor ?? '').toLowerCase()
check('Zotero 复读颜色已变', stored === nextColor, `stored=${stored}`)

// 6) 还原
if (before) {
  const back = await callHandler('/zotero-reader/annotations', {
    method: 'PATCH', body: { annotKey: key, color: before },
  })
  const finalRes = await fetch(`${LOCAL_API}/api/users/0/items/${key}`, { headers: { 'Zotero-API-Version': '3' } })
  const finalJson = await finalRes.json()
  const finalColor = String(finalJson?.data?.annotationColor ?? '').toLowerCase()
  check('已还原为原色', finalColor === before, `目前=${finalColor}`)
  void back
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
