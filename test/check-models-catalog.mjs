/**
 * 模型目录端点契约测试：GET /models、GET /model-info。
 *
 * 覆盖：
 *   1. 只投影 provider/model 的 id 与展示名，上游附带的敏感字段不出现
 *   2. listProviders 抛错 → 空目录（前端据此退回手输入）
 *   3. 只有列得出模型的 provider 才进目录；listModels 抛错/空列表 → 整个 provider 不出现
 *   4. model-info 返回推理档位与默认档位；缺参 400；解析失败 → 200 空列表 + error
 *   5. llm 服务没有这些方法时同样降级为空，不抛错
 *   6. client.js 里确实存在 datalist 与失败降级路径、档位始终可选的兜底（源码断言）
 *   7. 判据与 DSH 模型选择器一致：注册 ≠ 已配置，零模型的 provider 不出现
 *
 * 全部本地：桩 llm + 临时 dataDir，不联网。
 *
 * 用法：node test/check-models-catalog.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const registered = { routes: [] }
const tmpDirs = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

function makeLlm(overrides = {}) {
  return {
    stream: async function* () { yield { type: 'text-delta', text: '' } },
    listProviders: () => [
      { id: 'deepseek', name: 'DeepSeek', apiKey: 'SHOULD_NOT_LEAK_PROVIDER' },
      { id: 'siliconflow', name: 'SiliconFlow' },
    ],
    listModels: async (provider) => (provider === 'deepseek'
      ? [
        { provider, id: 'v4', name: 'DeepSeek V4', apiKey: 'SHOULD_NOT_LEAK_MODEL' },
        { provider, id: 'r1', name: 'DeepSeek R1' },
      ]
      : []),
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    }),
    ...overrides,
  }
}

function makeCtx(llm) {
  const ctx = {
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
    get: () => undefined,
    fiber: { entry: { options: { id: 'zotero-reader', name: 'dsh-zotero-reader' } } },
    inject: (deps, cb) => cb({
      ...ctx,
      webServer: { register: (opts) => { registered.routes.push(opts); return () => {} } },
      connection: { requestRejection: () => undefined },
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'session-p', model: 'session-m' }) },
    }),
  }
  return ctx
}

function makeReqRes(pathname) {
  const req = { method: 'GET', url: pathname, headers: {}, async *[Symbol.asyncIterator]() {} }
  const chunks = []
  let status = 0
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const res = {
    setHeader() {},
    writeHead(code) { status = code },
    write(b) { chunks.push(Buffer.from(b)) },
    end(b) { if (b) chunks.push(Buffer.from(b)); if (!res.done) { res.done = true; finish() } },
    get statusCode() { return status },
    get text() { return Buffer.concat(chunks).toString('utf8') },
    get json() { try { return JSON.parse(this.text) } catch { return null } },
    headersSent: false,
    done: false,
  }
  return { req, res, done }
}

async function call(pathname) {
  const route = registered.routes[0]
  if (!route) throw new Error('没有注册路由')
  const { req, res, done } = makeReqRes(pathname)
  route.handler(req, res)
  const outcome = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000))])
  if (outcome === 'timeout') throw new Error(`${pathname} 超时`)
  return res
}

function boot(llm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-models-'))
  tmpDirs.push(dir)
  registered.routes.length = 0
  apply(makeCtx(llm), { dataDir: dir })
}

/* ------------------------------------------------ 1) 正常目录 */

boot(makeLlm())
{
  const r = await call('/zotero-reader/models')
  const body = r.json ?? {}
  check('GET /models → 200', r.statusCode === 200, `status=${r.statusCode}`)
  check('GET /models 只返回能列出模型的 provider',
    body.providers?.length === 1 && body.providers?.[0]?.id === 'deepseek', JSON.stringify(body.providers))
  check('注册但没配置（零模型）的 provider 不进目录',
    !body.providers?.some((p) => p.id === 'siliconflow') && !('siliconflow' in (body.models ?? {})),
    JSON.stringify(body.models))
  check('provider 只含 id/name', body.providers?.every((p) => Object.keys(p).sort().join(',') === 'id,name'),
    JSON.stringify(body.providers?.[0]))
  check('models.deepseek 有两个模型', body.models?.deepseek?.length === 2, JSON.stringify(body.models?.deepseek))
  check('model 只含 id/name', body.models?.deepseek?.every((m) => Object.keys(m).sort().join(',') === 'id,name'),
    JSON.stringify(body.models?.deepseek?.[0]))
  check('响应不含上游敏感字段', !r.text.includes('SHOULD_NOT_LEAK'))
}

/* ------------------------------------- 2) listProviders 抛错 → 空目录 */

boot(makeLlm({ listProviders: () => { throw new Error('llm down') } }))
{
  const r = await call('/zotero-reader/models')
  check('listProviders 抛错 → 200 空目录', r.statusCode === 200
    && Array.isArray(r.json?.providers) && r.json.providers.length === 0
    && r.json?.models && Object.keys(r.json.models).length === 0, r.text.slice(0, 120))
}

/* ------------------- 3) 单个 provider 的 listModels 抛错 → 该 provider 不出现 */

boot(makeLlm({
  listModels: async (provider) => {
    if (provider === 'deepseek') throw new Error('catalog failed')
    return [{ provider, id: 'm1', name: 'M1' }]
  },
}))
{
  const r = await call('/zotero-reader/models')
  check('单个 provider 失败 → 该 provider 不出现、其它保留',
    !('deepseek' in (r.json?.models ?? {}))
    && !r.json?.providers?.some((p) => p.id === 'deepseek')
    && r.json?.providers?.length === 1
    && r.json?.models?.siliconflow?.length === 1,
    JSON.stringify(r.json))
}

/* ------------------------------------------ 4) model-info 档位 */

boot(makeLlm())
{
  const r = await call('/zotero-reader/model-info?provider=deepseek&model=v4')
  check('GET /model-info → 200', r.statusCode === 200, `status=${r.statusCode}`)
  check('model-info 返回两个档位',
    JSON.stringify(r.json?.efforts?.map((e) => e.id)) === JSON.stringify(['low', 'high']),
    JSON.stringify(r.json?.efforts))
  check('model-info 返回默认档位', r.json?.defaultEffort === 'low', String(r.json?.defaultEffort))
  check('model-info 档位只含 id/name', r.json?.efforts?.every((e) => Object.keys(e).sort().join(',') === 'id,name'))

  const bad = await call('/zotero-reader/model-info?provider=deepseek')
  check('model-info 缺 model → 400', bad.statusCode === 400, `status=${bad.statusCode}`)
}

boot(makeLlm({ resolveModelInfo: async () => { throw new Error('no such model') } }))
{
  const r = await call('/zotero-reader/model-info?provider=x&model=y')
  check('model-info 解析失败 → 200 空档位 + error',
    r.statusCode === 200 && Array.isArray(r.json?.efforts) && r.json.efforts.length === 0
    && /no such model/.test(r.json?.error ?? ''), r.text.slice(0, 120))
}

/* -------------------------- 5) llm 没有这些方法时也不崩 */

boot({ stream: async function* () { yield { type: 'text-delta', text: '' } } })
{
  const models = await call('/zotero-reader/models')
  check('llm 无 listProviders → 200 空目录',
    models.statusCode === 200 && models.json?.providers?.length === 0, models.text.slice(0, 80))
  const info = await call('/zotero-reader/model-info?provider=x&model=y')
  check('llm 无 resolveModelInfo → 200 空档位',
    info.statusCode === 200 && Array.isArray(info.json?.efforts) && info.json.efforts.length === 0)
}

/* ------------- 7) 判据：注册 ≠ 已配置，只有列得出模型的才进目录 */

boot(makeLlm({
  listProviders: () => [
    { id: 'configured', name: 'Configured' },
    { id: 'registered-empty', name: 'Registered, no key' },
    { id: 'registered-throws', name: 'Registered, broken' },
  ],
  listModels: async (provider) => {
    if (provider === 'configured') return [{ id: 'm1', name: 'M1' }, { id: 'm2' }]
    if (provider === 'registered-throws') throw new Error('no credentials')
    return []
  },
}))
{
  const r = await call('/zotero-reader/models')
  check('只保留列得出模型的 provider',
    JSON.stringify(r.json?.providers?.map((p) => p.id)) === JSON.stringify(['configured']),
    JSON.stringify(r.json?.providers))
  check('缺展示名时回落到 id，且不因缺 name 丢模型',
    r.json?.models?.configured?.length === 2 && r.json?.models?.configured?.[1]?.name === 'm2',
    JSON.stringify(r.json?.models?.configured))
  check('抛错与空列表一样视为未配置',
    Object.keys(r.json?.models ?? {}).join(',') === 'configured', JSON.stringify(r.json?.models))
}

/* ---------------------- 6) client 侧降级路径（源码断言） */

{
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  check('client 拉取 /models 目录', src.includes('`${API}/models`'))
  check('client 的目录请求失败不抛页（fetch 后有 catch）',
    /fetchJson\(`\$\{API\}\/models`\)[\s\S]{0,400}?\.catch\(/.test(src))
  check('provider 使用 datalist 可手输',
    src.includes("list: 'zr-cfg-provider-options'") && src.includes('zr-cfg-model-options-'))
  check('档位用 input + datalist（始终可选、可手输）',
    src.includes('list: listId')
    && src.includes("h('datalist', { key: 'effort-options', id: listId }")
    && src.includes('zr-cfg-effort-options-'))
  check('datalist 第一项是空值的「模型默认」',
    /h\('option', \{ value: '' \}, t\('cfgEffortModelDefault'\)\)/.test(src))
  const fallbackMatch = /const EFFORT_FALLBACKS = (\[[^\]]*\])/.exec(src)
  let fallback = []
  try {
    fallback = fallbackMatch ? JSON.parse(fallbackMatch[1].replace(/'/g, '"')) : []
  } catch {
    fallback = []
  }
  check('兜底档位非空且按 canonical 顺序覆盖 DSH 已知档位',
    JSON.stringify(fallback) === JSON.stringify(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    JSON.stringify(fallback))
  check('有真实 efforts 时优先用真实的',
    /const efforts = effortsOf\(provider, model\)[\s\S]{0,80}?if \(efforts && efforts\.length > 0\) return efforts/.test(src))
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
for (const dir of tmpDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
process.exit(failed === 0 ? 0 : 1)
