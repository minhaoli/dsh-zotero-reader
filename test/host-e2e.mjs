/**
 * Host 半边的离线端到端测试：用桩 ctx 把 apply() 跑起来，直接调用注册出来的
 * HTTP handler，验证「路由 → 鉴权 → 库 → PDF 字节流 → 文档元信息」整条链路。
 *
 * 目的：DSH 重启代价高（会杀掉正在跑的会话），先在这里把能验的都验掉。
 * 不启动真服务器：把 req/res 做成最小桩，只验证 handler 自身行为。
 */
import { apply } from '../index.js'

const registered = { tools: [], routes: [] }

/** 最小 ctx 桩：只实现插件真正用到的接口。 */
function makeCtx() {
  const ctx = {
    tools: { register: (def) => { registered.tools.push(def); return () => {} } },
    effect: (fn) => fn(),
    inject: (deps, cb) => {
      // 插件把 webServer/connection/llm/agentDefaultModel 作为一组依赖等齐
      const stub = {
        webServer: { register: (opts) => { registered.routes.push(opts); return () => {} } },
        connection: { requestRejection: () => undefined },
        llm: { stream: async function* () { yield { type: 'text-delta', text: '【译文】' } } },
        agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
      }
      cb({ ...ctx, ...stub })
    },
  }
  return ctx
}

/**
 * 最小 req/res 桩。
 * 注意：插件的 route.handler 是同步箭头函数，内部 handleRequest 的 promise 不会返回出来，
 * 所以这里靠 res.end 被调用来判定「这次请求真的处理完了」，而不是 await handler 的返回值。
 */
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
  // 等 res.end；超时则说明 handler 漏了响应
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 60_000))
  const outcome = await Promise.race([res.finished, timeout])
  if (outcome === 'timeout') throw new Error(`请求 ${path} 超时未响应`)
  return res
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

apply(makeCtx(), { zoteroDataDir: '', mineruMode: 'none' })

// 1) 注册面
check('三个工具已注册', registered.tools.length === 3, registered.tools.map((t) => t.name).join(', '))
check('每个工具都有 output.schema', registered.tools.every((t) => t.output?.schema), '')
check('每个工具都有 render', registered.tools.every((t) => typeof t.output?.render === 'function'), '')
check('parameters 是 object schema', registered.tools.every((t) => t.parameters?.type === 'object' && t.parameters.properties), '')
check('路由已注册', registered.routes.length === 1, registered.routes[0]?.path ?? '')

// 2) health
const health = await callHandler('/zotero-reader/health')
check('GET /health → 200', health.statusCode === 200, `status=${health.statusCode}`)
const healthJson = health.json ?? {}
check('health 报出库路径与条目数', healthJson.ok === true && healthJson.items > 0, `items=${healthJson.items} withPdf=${healthJson.withPdf}`)

// 3) library
const lib = await callHandler('/zotero-reader/library?limit=5')
const libJson = lib.json ?? {}
check('GET /library → 200 且有条目', lib.statusCode === 200 && (libJson.items?.length ?? 0) > 0, `returned=${libJson.items?.length} total=${libJson.total}`)
check('library 条目含 key/title', Boolean(libJson.items?.[0]?.key && libJson.items?.[0]?.title), libJson.items?.[0]?.title?.slice(0, 40))

// 4) PDF 字节流（整份 + Range）
const key = libJson.items?.[0]?.key
const pdfFull = await callHandler(`/zotero-reader/pdf?key=${key}`)
const magic = pdfFull.body.subarray(0, 5).toString('latin1')
check('GET /pdf → 200 且是 PDF', pdfFull.statusCode === 200 && magic === '%PDF-', `bytes=${pdfFull.body.length} magic=${JSON.stringify(magic)}`)

const pdfRange = await callHandler(`/zotero-reader/pdf?key=${key}`, { headers: { range: 'bytes=0-1023' } })
check('Range 请求 → 206 且长度正确', pdfRange.statusCode === 206 && pdfRange.body.length === 1024,
  `status=${pdfRange.statusCode} len=${pdfRange.body.length} contentRange=${pdfRange.headers['Content-Range']}`)

// 5) 文档元信息
const doc = await callHandler(`/zotero-reader/doc?key=${key}`)
const docJson = doc.json ?? {}
check('GET /doc → 200 且有页数与来源', doc.statusCode === 200 && docJson.pageCount > 0 && Boolean(docJson.source),
  `pages=${docJson.pageCount} source=${docJson.source} outline=${docJson.outline?.length ?? 0}`)

// 6) 单页文本
const page1 = await callHandler(`/zotero-reader/page?key=${key}&page=1`)
const pageJson = page1.json ?? {}
check('GET /page?page=1 → 有正文', page1.statusCode === 200 && (pageJson.text?.length ?? 0) > 50,
  `chars=${pageJson.text?.length}`)

// 7) 不存在的 key → 明确报错而不是 500 崩溃
const bad = await callHandler('/zotero-reader/pdf?key=ZZZZZZZZ')
check('未知 key → 400 且有错误信息', bad.statusCode === 400 && Boolean(bad.json?.error), `status=${bad.statusCode} error=${bad.json?.error?.slice(0, 50)}`)

// 8) 未知路径 → 404
const unknown = await callHandler('/zotero-reader/nope')
check('未知路径 → 404', unknown.statusCode === 404, `status=${unknown.statusCode}`)

// 9) 划词翻译（走桩 LLM）
const sel = await callHandler('/zotero-reader/selection', {
  method: 'POST',
  body: { text: 'efficient coding', mode: 'translate' },
})
check('POST /selection → 返回译文', sel.statusCode === 200 && Boolean(sel.json?.text), `text=${JSON.stringify(sel.json?.text)}`)

// 10) 工具实际执行
const searchTool = registered.tools.find((t) => t.name === 'search_zotero_library')
const searchOut = await searchTool.execute({ query: 'efficient coding', limit: 3 })
check('search_zotero_library 能搜到结果', (searchOut.items?.length ?? 0) > 0, `total=${searchOut.total}`)

const readTool = registered.tools.find((t) => t.name === 'read_zotero_paper')
const readOut = await readTool.execute({ itemKey: key, query: 'efficient coding' })
check('read_zotero_paper 返回带页码片段', (readOut.matches?.length ?? 0) > 0,
  `matches=${readOut.matches?.length} firstPage=${readOut.matches?.[0]?.page}`)

const askTool = registered.tools.find((t) => t.name === 'ask_zotero_paper')
const askOut = await askTool.execute({ itemKey: key, question: 'What is efficient coding?' })
check('ask_zotero_paper 返回片段与指令', (askOut.passages?.length ?? 0) > 0 && Boolean(askOut.instruction),
  `passages=${askOut.passages?.length}`)

// 11) render 不炸
for (const tool of registered.tools) {
  try {
    const out = await tool.execute(
      tool.name === 'search_zotero_library' ? { query: 'cognition', limit: 2 }
        : tool.name === 'read_zotero_paper' ? { itemKey: key, page: 1 }
          : { itemKey: key, question: 'method' },
    )
    const blocks = tool.output.render({}, out)
    check(`${tool.name} 的 render 产出文本块`, Array.isArray(blocks) && blocks.length > 0 && blocks[0].type === 'text',
      `${blocks?.[0]?.text?.slice(0, 46)}…`)
  } catch (error) {
    check(`${tool.name} 的 render 不抛错`, false, error.message)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(' -', f.name, f.detail)
  process.exitCode = 1
}
