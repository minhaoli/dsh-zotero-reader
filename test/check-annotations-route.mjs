/**
 * /annotations 两条路由的接线测试（离线，不写用户库）。
 *
 * 目的：host-e2e 覆盖不到批注路由，而云端回退是在这两条路由里接的 ——
 * 这里验证「本地路径照旧工作」以及「业务错误不会被误判成通道缺失」。
 *
 * 全程不产生写入：POST 的三个用例分别停在参数校验和 findItem 报错，
 * 走不到 createAnnotation。fetchImpl 被替换成必失败的桩，即使代码真的
 * 尝试连云端也只会立刻失败，不会碰到真实 api.zotero.org。
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

/** 必失败的 fetch：任何云端请求都会立刻抛网络错误，测试不会打到真实 API。 */
const offlineFetch = async () => {
  const error = new Error('stub: network disabled')
  error.cause = { code: 'ECONNREFUSED' }
  throw error
}

apply(makeCtx(), { zoteroDataDir: '', mineruMode: 'none', __fetchImpl: offlineFetch })

/* --------------------------------------------------- 1) 读批注（本地） */

const lib = await callHandler('/zotero-reader/library?limit=3')
const itemKey = lib.json?.items?.[0]?.key
check('库里有可测条目', Boolean(itemKey), String(itemKey))

const readRes = await callHandler(`/zotero-reader/annotations?key=${itemKey}`)
const readJson = readRes.json ?? {}
check('GET /annotations → 200', readRes.statusCode === 200, `status=${readRes.statusCode}`)
check('返回 annotations 数组', Array.isArray(readJson.annotations), typeof readJson.annotations)
check('返回 attachmentKey', Boolean(readJson.attachmentKey), String(readJson.attachmentKey))
check('标了 via=local', readJson.via === 'local', String(readJson.via))
check('canWrite 是布尔', typeof readJson.canWrite === 'boolean', String(readJson.canWrite))
check('colors 仍在', Array.isArray(readJson.colors) && readJson.colors.length > 0)

/* --------------------------------------------------- 2) 读批注（错误） */

const noKey = await callHandler('/zotero-reader/annotations')
check('缺 key → 400', noKey.statusCode === 400, `status=${noKey.statusCode}`)
check('缺 key 的提示', /缺少 key/.test(noKey.json?.error ?? ''), noKey.json?.error)

const badKey = await callHandler('/zotero-reader/annotations?key=ZZZZZZZZ')
check('未知条目 → 非 200（不当成通道缺失）', badKey.statusCode !== 200, `status=${badKey.statusCode}`)
check('未知条目报「找不到条目」', /找不到条目/.test(badKey.json?.error ?? ''), badKey.json?.error)
check('未知条目没有伪装成云端错误', !/云端|cloud/i.test(badKey.json?.error ?? ''))

/* --------------------------------------------------- 3) 写批注（不落盘） */

const noText = await callHandler('/zotero-reader/annotations', {
  method: 'POST',
  body: { itemKey, annotationKind: 'highlight', text: '', pageIndex: 0, rects: [[1, 2, 3, 4]] },
})
check('空高亮 → 400', noText.statusCode === 400, `status=${noText.statusCode}`)
check('空高亮的提示', /没有选中文字/.test(noText.json?.error ?? ''), noText.json?.error)

const noteNoPos = await callHandler('/zotero-reader/annotations', {
  method: 'POST',
  body: { itemKey, annotationKind: 'note', text: '', comment: '' },
})
check('空便签 → 400', noteNoPos.statusCode === 400, `status=${noteNoPos.statusCode}`)
check('空便签的提示', /便签需要一个位置/.test(noteNoPos.json?.error ?? ''), noteNoPos.json?.error)

const unknownPost = await callHandler('/zotero-reader/annotations', {
  method: 'POST',
  body: { itemKey: 'ZZZZZZZZ', annotationKind: 'highlight', text: '随便一段', pageIndex: 0, rects: [[1, 2, 3, 4]] },
})
check('未知条目写入 → 非 2xx', unknownPost.statusCode !== 200, `status=${unknownPost.statusCode}`)
check('未知条目写入报「找不到条目」', /找不到条目/.test(unknownPost.json?.error ?? ''), unknownPost.json?.error)
check('未知条目写入没有触发云端回退', !/云端|云端 key|cloud/i.test(unknownPost.json?.error ?? ''))

/* ------------------------------------------------------------ 汇总 */

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
