/**
 * 设置契约测试：GET /settings、POST /settings（已停用）、GET/POST /zotero-reader/config。
 *
 * 配置入口已统一到 DSH 插件页（`plugins.row.config` → Host 的 configEditor）：
 *   1. GET /settings 仍保留，但只作诊断；POST /settings 必须是 501 并指向插件页
 *   2. secret 只存**环境变量名**：接口只回 `xxxEnv` / `xxxPresent` / `xxxLength`，
 *      值与明文都不出现；本地授权只回 `serverId` / `savedAt` / 是否匹配
 *   3. POST /config 经 configEditor 写回；非法输入 400、无编辑器 501、被上层覆盖 409；
 *      写回前剥掉旧明文字段，绝不把 key 落进 YAML
 *   4. 迁移：config 仍是默认值、旧 settings.json 有非默认值时用旧值补齐
 *      （MinerU 模式/开关不能丢）；旧明文 token 不再参与运行，只触发告警
 *   5. 通过插件页保存成功后，旧 settings.json 改名，回退不再参与后续启动
 *   6. features / translateEfforts 的归一化与「features > 跟随会话」优先级
 *      （旧 selectionProvider/selectionModel 已移除，配置里残留也应被忽略）
 *
 * 全部本地：临时 dataDir + 桩 ctx / 桩 configEditor，**不联网、不依赖 Zotero 运行**。
 * 三个测试用环境变量由本文件自己注入，跑完不需要清理（进程退出即消失）。
 *
 * 用法：node test/check-settings-contract.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, FEATURE_KEYS, DEFAULT_TRANSLATE_EFFORTS } from '../index.js'
import { DEFAULT_TRANSLATE_EFFORTS as HOST_TRANSLATE_EFFORTS } from '../host/translate.js'

const registered = { tools: [], routes: [] }
const tmpDirs = []

/** 桩 configEditor：模拟 configEditor.entries()/edit()，并把每次写入的完整配置记下来。 */
function makeConfigEditor(initial = {}) {
  const state = {
    entries: [{
      options: { id: 'zotero-reader', name: 'dsh-zotero-reader', config: structuredClone(initial) },
      fiber: { state: 'active' },
    }],
    edits: [],
    fail: null,
  }
  return {
    state,
    entries: () => state.entries,
    async edit(entry, change) {
      if (state.fail) throw state.fail
      const next = change(structuredClone(entry.options.config ?? {}), {})
      state.edits.push(structuredClone(next))
      entry.options.config = structuredClone(next)
    },
  }
}

/** 桩 ctx：只实现 apply 会用到的那几个属性。 */
function makeCtx({ llmCalls = [], session, editor } = {}) {
  const sel = session ?? { provider: 'session-p', model: 'session-m', reasoningEffort: 'high' }
  const ctx = {
    tools: { register: (def) => { registered.tools.push(def); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => (name === 'configEditor' ? editor : undefined),
    fiber: { entry: { options: { id: 'zotero-reader', name: 'dsh-zotero-reader' } } },
    inject: (deps, cb) => {
      cb({
        ...ctx,
        webServer: { register: (opts) => { registered.routes.push(opts); return () => {} } },
        connection: { requestRejection: () => undefined },
        llm: {
          stream: (params) => {
            llmCalls.push(params)
            return (async function* () { yield { type: 'text-delta', text: '译文' } })()
          },
        },
        agentDefaultModel: { currentSelection: () => sel },
      })
    },
  }
  return ctx
}

/** 最小 req/res，够 handleRequest 用（与 check-searched-remove.mjs 同款）。 */
function makeReqRes(pathname, { method = 'GET', headers = {}, body } = {}) {
  const req = {
    method,
    url: pathname,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
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

async function call(pathname, opts) {
  const route = registered.routes[0]
  if (!route) throw new Error('没有注册路由')
  const { req, res } = makeReqRes(pathname, opts)
  route.handler(req, res)
  const outcome = await Promise.race([res.finished, new Promise((r) => setTimeout(() => r('timeout'), 15_000))])
  if (outcome === 'timeout') throw new Error(`${pathname} 超时`)
  return res
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

let bootSeq = 0
function newDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zr-settings-${++bootSeq}-`))
  tmpDirs.push(dir)
  return dir
}

/** 起一次插件（= 一次「启动」），返回临时 dataDir、llm 调用记录与 configEditor 桩。 */
function boot(config = {}, opts = {}) {
  const dir = opts.dataDir ?? newDataDir()
  if (opts.legacy !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(opts.legacy, null, 2), 'utf8')
  }
  const llmCalls = []
  const editor = opts.editor ?? null
  registered.routes.length = 0
  apply(makeCtx({ llmCalls, session: opts.session, editor }), { dataDir: dir, ...config })
  return { dir, llmCalls, settingsFile: path.join(dir, 'settings.json'), editor }
}

/** 起一次插件并 GET /settings。 */
async function settingsOf(config, opts = {}) {
  const b = boot(config, opts)
  const res = await call('/zotero-reader/settings')
  return { ...b, res }
}

/** 起一次插件并 GET /config。 */
async function configOf(config, opts = {}) {
  const b = boot(config, opts)
  const res = await call('/zotero-reader/config')
  return { ...b, res }
}

/**
 * secret 现在只存**环境变量名**：测试自己注入三个变量，
 * 断言接口只回 Present/Length，绝不回值。
 */
const TEST_ENV_MINERU = 'ZR_TEST_MINERU_TOKEN'
const TEST_ENV_CLOUD = 'ZR_TEST_CLOUD_KEY'
const TEST_ENV_EMBED = 'ZR_TEST_EMBED_KEY'
const SECRET_CLOUD_KEY = 'SECRET_CLOUD_KEY_0123456789'
const SECRET_MINERU_TOKEN = 'mineru-secret-token-XYZ'
const SECRET_EMBED_KEY = 'embed-secret-key-000'
const SECRET_LOCAL_KEY = 'LOCAL_ZOTERO_KEY_DO_NOT_LEAK'
process.env[TEST_ENV_MINERU] = SECRET_MINERU_TOKEN
process.env[TEST_ENV_CLOUD] = SECRET_CLOUD_KEY
process.env[TEST_ENV_EMBED] = SECRET_EMBED_KEY
/** 指向不存在变量的配置：用来断言 Present=false / Length=0。 */
const EMPTY_ENV = {
  mineruTokenEnv: 'ZR_NOPE_MINERU',
  cloudApiKeyEnv: 'ZR_NOPE_CLOUD',
  embeddingApiKeyEnv: 'ZR_NOPE_EMBED',
}
/** 指向测试注入变量的配置。 */
const ENV_CONFIG = {
  mineruTokenEnv: TEST_ENV_MINERU,
  cloudApiKeyEnv: TEST_ENV_CLOUD,
  embeddingApiKeyEnv: TEST_ENV_EMBED,
}

/* ------------------------- 1) GET /settings：secret 只回变量名/存在/长度 */

const A = await settingsOf({
  ...ENV_CONFIG,
  cloudUserID: '  1234567  ',
  features: { translate: { provider: ' p1 ', model: ' m1 ', reasoningEffort: ' high ' } },
})
const g1 = A.res
const g1json = g1.json ?? {}
const g1text = g1.text

check('GET /settings → 200', g1.statusCode === 200, `status=${g1.statusCode}`)
check('GET /settings 回 mineruTokenEnv 变量名', g1json.mineruTokenEnv === TEST_ENV_MINERU,
  String(g1json.mineruTokenEnv))
check('GET /settings mineruTokenPresent 为 true', g1json.mineruTokenPresent === true,
  String(g1json.mineruTokenPresent))
check('GET /settings mineruTokenLength 等于真实长度', g1json.mineruTokenLength === SECRET_MINERU_TOKEN.length,
  String(g1json.mineruTokenLength))
check('GET /settings 响应体不含 mineru token 的值', !g1text.includes(SECRET_MINERU_TOKEN))
check('GET /settings 没有 mineruCloudToken 字段', !Object.keys(g1json).includes('mineruCloudToken'))
check('GET /settings 没有 mineruCloudTokenSet 字段', !Object.keys(g1json).includes('mineruCloudTokenSet'))
check('GET /settings 回 cloudApiKeyEnv 变量名', g1json.cloudApiKeyEnv === TEST_ENV_CLOUD)
check('GET /settings cloudApiKeyPresent 为 true', g1json.cloudApiKeyPresent === true)
check('GET /settings cloudApiKeyLength 等于真实长度', g1json.cloudApiKeyLength === SECRET_CLOUD_KEY.length)
check('GET /settings 响应体不含 cloud key 的值', !g1text.includes(SECRET_CLOUD_KEY))
check('GET /settings 没有 cloudApiKey 字段', !Object.keys(g1json).includes('cloudApiKey'))
check('GET /settings 没有 cloudApiKeySet 字段', !Object.keys(g1json).includes('cloudApiKeySet'))
check('GET /settings 回 embeddingApiKeyEnv', g1json.embeddingApiKeyEnv === TEST_ENV_EMBED)
check('GET /settings embeddingApiKeyPresent 为 true', g1json.embeddingApiKeyPresent === true)
check('GET /settings 响应体不含 embedding key 的值', !g1text.includes(SECRET_EMBED_KEY))
check('GET /settings cloudUserID 被 trim', g1json.cloudUserID === '1234567', JSON.stringify(g1json.cloudUserID))
check('GET /settings 返回 resolvedDataDir（只读展示）', g1json.resolvedDataDir === A.dir, String(g1json.resolvedDataDir))
check('GET /settings 返回 zoteroDataDir（可编辑字段）', typeof g1json.zoteroDataDir === 'string')
check('GET /settings 标注配置已托管（configManaged）', g1json.configManaged === true)

const B = await settingsOf({ ...EMPTY_ENV })
check('环境变量不存在时 mineruTokenPresent 为 false', B.res.json?.mineruTokenPresent === false,
  String(B.res.json?.mineruTokenPresent))
check('环境变量不存在时 mineruTokenLength 为 0', B.res.json?.mineruTokenLength === 0,
  String(B.res.json?.mineruTokenLength))
check('环境变量不存在时 cloudApiKeyPresent 为 false', B.res.json?.cloudApiKeyPresent === false)
check('未配置时 cloudUserID 为空串', B.res.json?.cloudUserID === '',
  JSON.stringify(B.res.json?.cloudUserID))

/* ------------------- 2) GET /config：表单公开视图（无明文、无明文值） */

const C0 = await configOf({
  ...ENV_CONFIG,
  cloudUserID: '  1234567  ',
  features: { translate: { provider: ' p1 ', model: ' m1 ', reasoningEffort: ' high ' } },
})
const c0 = C0.res
const c0json = c0.json ?? {}
const c0text = c0.text
check('GET /config → 200', c0.statusCode === 200, `status=${c0.statusCode}`)
check('GET /config 有 config 对象', c0json.config && typeof c0json.config === 'object')
check('GET /config 标明 managedBy=cordis-patch', c0json.managedBy === 'cordis-patch', String(c0json.managedBy))
check('GET /config 不含 mineru token 明文', !c0text.includes(SECRET_MINERU_TOKEN))
check('GET /config 不含 cloud key 明文', !c0text.includes(SECRET_CLOUD_KEY))
check('GET /config 不含 embedding key 明文', !c0text.includes(SECRET_EMBED_KEY))
check('GET /config 不含 mineruCloudToken 字段', !Object.keys(c0json.config ?? {}).includes('mineruCloudToken'))
check('GET /config 不含 cloudApiKey 字段', !Object.keys(c0json.config ?? {}).includes('cloudApiKey'))
check('GET /config 回 mineruTokenEnv + Present + Length',
  c0json.config?.mineruTokenEnv === TEST_ENV_MINERU
  && c0json.config?.mineruTokenPresent === true
  && c0json.config?.mineruTokenLength === SECRET_MINERU_TOKEN.length)
check('GET /config 回 cloudApiKeyEnv + Present + Length',
  c0json.config?.cloudApiKeyEnv === TEST_ENV_CLOUD
  && c0json.config?.cloudApiKeyPresent === true
  && c0json.config?.cloudApiKeyLength === SECRET_CLOUD_KEY.length)
check('GET /config 回 embeddingApiKeyEnv + Present',
  c0json.config?.embeddingApiKeyEnv === TEST_ENV_EMBED
  && c0json.config?.embeddingApiKeyPresent === true)
check('GET /config cloudUserID 被 trim', c0json.config?.cloudUserID === '1234567', JSON.stringify(c0json.config?.cloudUserID))
check('GET /config resolvedDataDir 是本进程的 dataDir', c0json.config?.resolvedDataDir === C0.dir)
check('GET /config features 覆盖三个键',
  JSON.stringify(Object.keys(c0json.config?.features ?? {}).sort()) === JSON.stringify([...FEATURE_KEYS].sort()))
check('GET /config features.translate.provider 被 trim', c0json.config?.features?.translate?.provider === 'p1',
  JSON.stringify(c0json.config?.features?.translate))
check('GET /config 默认 translateEfforts 与 host 常量一致',
  JSON.stringify(c0json.config?.translateEfforts) === JSON.stringify(HOST_TRANSLATE_EFFORTS))

/* -------------------------------- 3) 本地授权 key 的状态：不泄露 key 明文 */

{
  const dir = newDataDir()
  fs.writeFileSync(path.join(dir, 'zotero-api-key.json'), JSON.stringify({
    serverId: 'SERVER_ID_ABC',
    key: SECRET_LOCAL_KEY,
    savedAt: '2026-01-02T03:04:05.000Z',
  }), 'utf8')
  const r = await configOf({}, { dataDir: dir })
  const j = r.res.json ?? {}
  check('GET /config 有 localKey 状态对象', j.localKey && typeof j.localKey === 'object')
  check('GET /config localKey.authorized 为 true', j.localKey?.authorized === true, String(j.localKey?.authorized))
  check('GET /config localKey.serverId 原样返回', j.localKey?.serverId === 'SERVER_ID_ABC', String(j.localKey?.serverId))
  check('GET /config localKey.savedAt 原样返回', j.localKey?.savedAt === '2026-01-02T03:04:05.000Z',
    String(j.localKey?.savedAt))
  check('GET /config 响应体不含本地 key 明文', !r.res.text.includes(SECRET_LOCAL_KEY))
  check('GET /config localKey 没有 key 字段', !Object.keys(j.localKey ?? {}).includes('key'),
    Object.keys(j.localKey ?? {}).join(','))
}

/* ---------------------------- 4) POST /settings 已停用：501 + 指向插件页 */

{
  const D = boot({})
  const p = await call('/zotero-reader/settings', { method: 'POST', body: { mineruMode: 'cloud' } })
  check('POST /settings → 501（写入口已迁移）', p.statusCode === 501, `status=${p.statusCode}`)
  check('POST /settings 提示里去插件页', /插件页|Plugins/.test(p.json?.error ?? ''), p.text.slice(0, 120))
  check('POST /settings 标注 migratedTo=plugins.row.config', p.json?.migratedTo === 'plugins.row.config')
  check('POST /settings 不再写 settings.json', !fs.existsSync(D.settingsFile))
}

/* --------------------------------------- 5) POST /config：写入、合并、落盘语义 */

{
  // 旧配置里可能还有明文字段：写回时应被剥掉，只留变量名。
  const initial = {
    mineruMode: 'none',
    mineruTokenEnv: TEST_ENV_MINERU,
    mineruCloudToken: 'LEGACY-PLAINTEXT-TOKEN',
    cloudApiKey: 'LEGACY-CLOUD-PLAINTEXT',
  }
  const editor = makeConfigEditor(initial)
  const legacy = { mineruMode: 'none' }
  const E = boot(initial, { editor, legacy })
  const p = await call('/zotero-reader/config', {
    method: 'POST',
    body: {
      mineruTokenEnv: `  ${TEST_ENV_MINERU}  `,
      cloudApiKeyEnv: `  ${TEST_ENV_CLOUD}  `,
      embeddingApiKeyEnv: TEST_ENV_EMBED,
      cloudUserID: ' 7654321 ',
      mineruLocalUrl: '  http://127.0.0.1:9000  ',
      features: { translate: { provider: 'pp', model: 'mm' } },
      translateEfforts: ['high', 'high', ' low ', null, 5, ''],
      mineruMode: 'local',
    },
  })
  check('POST /config → 200', p.statusCode === 200, `status=${p.statusCode} ${p.text.slice(0, 120)}`)
  check('POST /config 响应不含 mineru token 明文', !p.text.includes(SECRET_MINERU_TOKEN))
  check('POST /config 响应不含 cloud key 明文', !p.text.includes(SECRET_CLOUD_KEY))
  check('POST /config 响应不含旧明文字段', !p.text.includes('LEGACY-PLAINTEXT-TOKEN'))
  check('POST /config 响应回 mineruTokenPresent=true', p.json?.config?.mineruTokenPresent === true)
  check('POST /config 响应回 mineruTokenLength',
    p.json?.config?.mineruTokenLength === SECRET_MINERU_TOKEN.length)
  check('POST /config 响应回 cloudApiKeyPresent=true', p.json?.config?.cloudApiKeyPresent === true)
  check('POST /config 走过 configEditor（写入一次）', editor.state.edits.length === 1,
    `edits=${editor.state.edits.length}`)
  const written = editor.state.edits[0] ?? {}
  check('写入值：已移除的整篇翻译字段不再写入',
    written.translateConcurrency === undefined && written.translateChunkChars === undefined,
    `${JSON.stringify(written.translateConcurrency)} / ${JSON.stringify(written.translateChunkChars)}`)
  check('写入值：mineruTokenEnv 已 trim', written.mineruTokenEnv === TEST_ENV_MINERU,
    JSON.stringify(written.mineruTokenEnv))
  check('写入值：cloudApiKeyEnv 已 trim', written.cloudApiKeyEnv === TEST_ENV_CLOUD,
    JSON.stringify(written.cloudApiKeyEnv))
  check('写入值：embeddingApiKeyEnv 已写入', written.embeddingApiKeyEnv === TEST_ENV_EMBED,
    JSON.stringify(written.embeddingApiKeyEnv))
  check('写入值：cloudUserID 已 trim', written.cloudUserID === '7654321', JSON.stringify(written.cloudUserID))
  check('写入值：旧明文 mineruCloudToken 被剥掉', written.mineruCloudToken === undefined,
    JSON.stringify(written.mineruCloudToken))
  check('写入值：旧明文 cloudApiKey 被剥掉', written.cloudApiKey === undefined,
    JSON.stringify(written.cloudApiKey))
  check('写入值：不含运行时解析值 mineruToken', written.mineruToken === undefined)
  check('写入值：不含运行时解析值 embeddingApiKey', written.embeddingApiKey === undefined)
  check('写入值：features 三键齐全', FEATURE_KEYS.every((k) => written.features?.[k]),
    Object.keys(written.features ?? {}).join(','))
  check('FEATURE_KEYS 不再包含 docTranslate', !FEATURE_KEYS.includes('docTranslate'), FEATURE_KEYS.join(','))
  check('写入值：features.translate 生效', written.features?.translate?.provider === 'pp',
    JSON.stringify(written.features?.translate))
  check('写入值：translateEfforts 已归一化（去重 / trim / 保留 null / 丢非法）',
    JSON.stringify(written.translateEfforts) === JSON.stringify(['high', 'low', null]),
    JSON.stringify(written.translateEfforts))
  check('POST /config 后旧 settings.json 被改名（不再参与回退）', !fs.existsSync(E.settingsFile),
    fs.readdirSync(E.dir).join(','))
  check('改名的备份文件保留了原内容',
    (() => {
      const backup = fs.readdirSync(E.dir).find((name) => name.startsWith('settings.json.migrated-'))
      if (!backup) return false
      try {
        return JSON.parse(fs.readFileSync(path.join(E.dir, backup), 'utf8')).mineruMode === 'none'
      } catch { return false }
    })(), fs.readdirSync(E.dir).join(','))
}

/* --------------------------------- 6) POST /config 校验：非法输入不写入 */

{
  const editor = makeConfigEditor({})
  const F = boot({}, { editor })
  const bad = [
    ['features=数组', { features: [] }],
    ['features=字符串', { features: 'x' }],
    ['features=null', { features: null }],
    ['features=数字', { features: 42 }],
    ['translateEfforts=字符串', { translateEfforts: 'off' }],
    ['translateEfforts=对象', { translateEfforts: { 0: 'off' } }],
    ['translateEfforts=null', { translateEfforts: null }],
    ['mineruMode=auto', { mineruMode: 'auto' }],
    ['mineruCloudToken 明文', { mineruCloudToken: 'x' }],
    ['cloudApiKey 明文', { cloudApiKey: 'x' }],
    ['mineruTokenEnv=数字', { mineruTokenEnv: 5 }],
    ['空对象', {}],
  ]
  for (const [label, body] of bad) {
    const r = await call('/zotero-reader/config', { method: 'POST', body })
    check(`POST /config ${label} → 400`, r.statusCode === 400, `status=${r.statusCode} ${r.text.slice(0, 80)}`)
  }
  check('校验失败时不调用 configEditor', editor.state.edits.length === 0, `edits=${editor.state.edits.length}`)
  check('校验失败时不落 settings.json', !fs.existsSync(F.settingsFile))
}

/* --------------------------- 7) POST /config 的失败模式：无编辑器 / 找不到 / 被覆盖 */

{
  const noEditor = boot({})
  const r1 = await call('/zotero-reader/config', { method: 'POST', body: { mineruMode: 'cloud' } })
  check('没有 configEditor 时 POST /config → 501', r1.statusCode === 501, `status=${r1.statusCode}`)
  check('没有 configEditor 的报错点名 configEditor', /configEditor/.test(r1.json?.error ?? ''), r1.text.slice(0, 120))

  const editor = makeConfigEditor({})
  const G = boot({}, { editor })
  editor.state.entries = []
  const r2 = await call('/zotero-reader/config', { method: 'POST', body: { mineruMode: 'cloud' } })
  check('configEditor 里找不到本插件条目 → 400', r2.statusCode === 400, `status=${r2.statusCode}`)
  check('找不到条目的报错点名 dsh-zotero-reader', /dsh-zotero-reader/.test(r2.json?.error ?? ''), r2.text.slice(0, 120))
  check('找不到条目不写 settings.json', !fs.existsSync(G.settingsFile))

  editor.state.entries = [{
    options: { id: 'zotero-reader', name: 'dsh-zotero-reader', config: {} },
    fiber: { state: 'active' },
  }]
  editor.state.fail = new Error('Configuration for "zotero-reader" is overridden by a home patch or command-line overlay')
  const r3 = await call('/zotero-reader/config', { method: 'POST', body: { mineruMode: 'cloud' } })
  check('被 home patch 覆盖时 POST /config → 409', r3.statusCode === 409, `status=${r3.statusCode}`)
  check('被覆盖的报错原样回传', /overridden/i.test(r3.json?.error ?? ''), r3.text.slice(0, 120))
}

/* ------------------------------- 8) 迁移：旧 settings.json 只读回退、显式配置优先 */

const LEGACY = {
  zoteroDataDir: '',
  dataDir: '',
  selectionProvider: '',
  selectionModel: '',
  mineruMode: 'cloud',
  mineruLocalUrl: 'http://127.0.0.1:8000',
  mineruCloudToken: 'sk-LEGACY-TOKEN-XYZ',
  mineruAutoOnScanned: false,
}

{
  const M = await configOf({ ...EMPTY_ENV }, { legacy: LEGACY })
  const j = M.res.json ?? {}
  check('迁移：config 默认 none + 旧 json cloud → 生效 cloud', j.config?.mineruMode === 'cloud', String(j.config?.mineruMode))
  check('迁移：旧 json 的明文 token 不再生效（Present=false）', j.config?.mineruTokenPresent === false,
    String(j.config?.mineruTokenPresent))
  check('迁移：旧 json mineruAutoOnScanned=false 覆盖默认 true', j.config?.mineruAutoOnScanned === false)
  check('迁移：旧 json 不回传 token 明文', !M.res.text.includes('sk-LEGACY-TOKEN-XYZ'))
  check('迁移：old settings.json 仍在（用户重配前不删）', fs.existsSync(M.settingsFile))
}

{
  const M2 = await configOf({ ...ENV_CONFIG }, { legacy: LEGACY })
  check('迁移：环境变量存在时 Present=true，且长度来自环境变量',
    M2.res.json?.config?.mineruTokenPresent === true
    && M2.res.json?.config?.mineruTokenLength === SECRET_MINERU_TOKEN.length)
  check('迁移：环境变量的值不会因为旧明文存在而混入响应',
    !M2.res.text.includes(SECRET_MINERU_TOKEN))
}

{
  const N = await configOf({ ...EMPTY_ENV, mineruMode: 'local', mineruAutoOnScanned: true }, { legacy: LEGACY })
  check('迁移：显式 config mineruMode=local 压过旧 json cloud', N.res.json?.config?.mineruMode === 'local',
    String(N.res.json?.config?.mineruMode))
  // 注意：`mineruAutoOnScanned: true` 与 schema 默认值相同，运行时无法区分
  // 「用户显式写了 true」和「用户没写」。迁移规则按「等于默认值就用旧文件补」执行，
  // 所以旧 json 的 false 会生效 —— 警告里已提示用户到插件页重配后删文件。
  check('迁移：显式 true 等于默认值 → 仍按默认处理（旧 false 生效，警告已提示）',
    N.res.json?.config?.mineruAutoOnScanned === false,
    String(N.res.json?.config?.mineruAutoOnScanned))
}

{
  const O = await configOf({ ...EMPTY_ENV })
  check('没有旧 json 时 mineruMode 保持默认 none', O.res.json?.config?.mineruMode === 'none')
  check('没有旧 json 且环境变量不存在时 Present=false', O.res.json?.config?.mineruTokenPresent === false)
}

/* --------------------------- 9) features 容错：GET /settings 的补全行为不变 */

const defaultShape = (feats) => FEATURE_KEYS.every((k) =>
  feats?.[k] && feats[k].provider === '' && feats[k].model === '' && feats[k].reasoningEffort === '')

for (const [label, features] of [
  ['缺失', undefined],
  ['null', null],
  ['数组', []],
  ['字符串', 'not-an-object'],
  ['数字', 42],
]) {
  const r = await settingsOf(features === undefined ? {} : { features })
  check(`features=${label} → 响应 200 且补成三键默认结构`,
    r.res.statusCode === 200 && defaultShape(r.res.json?.features),
    r.res.text.slice(0, 90))
}

{
  const r = await settingsOf({
    features: {
      translate: { provider: 123, model: {}, reasoningEffort: [] },
      explain: { provider: '  e  ', model: '  em  ' },
    },
  })
  const feats = r.res.json?.features ?? {}
  check('features 内非字符串字段归一化为空串',
    feats.translate?.provider === '' && feats.translate?.model === '' && feats.translate?.reasoningEffort === '')
  check('features 只配一半时其余键补默认',
    feats.explain?.provider === 'e' && feats.explain?.model === 'em'
    && feats.translate?.provider === '' && feats.ask?.provider === '',
    JSON.stringify(feats))
}

{
  const r = await settingsOf({ features: { nope: { provider: 'x', model: 'y' }, docTranslate: { provider: 'x', model: 'y' } } })
  const keys = Object.keys(r.res.json?.features ?? {})
  check('features 未知键被丢弃（含已删除的 docTranslate）',
    !keys.includes('nope') && !keys.includes('docTranslate'), keys.join(','))
}

/* ------------------------------ 10) translateEfforts 默认值与归一化边界 */

check('index.js 的默认序列与 host/translate.js 原硬编码一致',
  JSON.stringify(DEFAULT_TRANSLATE_EFFORTS) === JSON.stringify(HOST_TRANSLATE_EFFORTS),
  `${JSON.stringify(DEFAULT_TRANSLATE_EFFORTS)} vs ${JSON.stringify(HOST_TRANSLATE_EFFORTS)}`)
check('默认序列字面量为 off → low → 模型默认（null）',
  JSON.stringify(DEFAULT_TRANSLATE_EFFORTS) === JSON.stringify(['off', 'low', null]),
  JSON.stringify(DEFAULT_TRANSLATE_EFFORTS))
check('新装的设置里 translateEfforts 就是默认序列',
  JSON.stringify(B.res.json?.translateEfforts) === JSON.stringify(['off', 'low', null]),
  JSON.stringify(B.res.json?.translateEfforts))

{
  const editor = makeConfigEditor({})
  const E = boot({}, { editor })
  const r1 = await call('/zotero-reader/config', {
    method: 'POST', body: { translateEfforts: [] },
  })
  check('POST /config translateEfforts=[] → 回退默认序列（空序列会让回退链一次都不跑）',
    JSON.stringify(r1.json?.config?.translateEfforts) === JSON.stringify(['off', 'low', null]),
    JSON.stringify(r1.json?.config?.translateEfforts))
  const r2 = await call('/zotero-reader/config', {
    method: 'POST', body: { translateEfforts: ['', 0, {}, null] },
  })
  check('POST /config 全非法值只留下 null 一档',
    JSON.stringify(r2.json?.config?.translateEfforts) === JSON.stringify([null]),
    JSON.stringify(r2.json?.config?.translateEfforts))
  const r3 = await call('/zotero-reader/config', {
    method: 'POST', body: { translateEfforts: [' medium '] },
  })
  check('POST /config 单档位序列原样生效',
    JSON.stringify(r3.json?.config?.translateEfforts) === JSON.stringify(['medium']),
    JSON.stringify(r3.json?.config?.translateEfforts))
}

/* --------------------- 11) 模型覆盖优先级（走 /selection 的真实路径） */

/**
 * 一次划词请求，返回 llm.stream 实际收到的 provider/model。
 * 这样验证的是 index.js `selectionOverride` → host/translate.js `pickSelection`
 * → `llm.stream` 的完整链路，而不是把优先级逻辑抄一份。
 */
async function selectionRun(config, mode = 'translate') {
  const b = boot(config)
  const res = await call('/zotero-reader/selection', {
    method: 'POST',
    body: { text: '被选中的原文', mode },
  })
  const params = b.llmCalls[0] ?? {}
  return { res, provider: params.provider, model: params.model, calls: b.llmCalls.length }
}

const O1 = await selectionRun({
  features: { translate: { provider: 'feat-p', model: 'feat-m' } },
})
check('/selection 真实调用了 llm 并返回译文',
  O1.res.statusCode === 200 && O1.res.json?.text === '译文' && O1.calls > 0,
  `status=${O1.res.statusCode} text=${JSON.stringify(O1.res.json?.text)} calls=${O1.calls}`)
check('features.translate 生效（provider/model 来自覆盖）',
  O1.provider === 'feat-p' && O1.model === 'feat-m', `${O1.provider}/${O1.model}`)

const O2 = await selectionRun({})
check('没有 features 时跟随会话当前模型',
  O2.provider === 'session-p' && O2.model === 'session-m', `${O2.provider}/${O2.model}`)

// 旧字段已从 schema / normalizeConfig 移除；即使旧配置文件里还残留，也必须被忽略。
const O2b = await selectionRun({ selectionProvider: 'old-p', selectionModel: 'old-m' })
check('残留的 selectionProvider/selectionModel 被忽略（仍跟随会话）',
  O2b.provider === 'session-p' && O2b.model === 'session-m', `${O2b.provider}/${O2b.model}`)

const O3 = await selectionRun({
  features: { explain: { provider: 'x-p', model: 'x-m' } },
}, 'explain')
check('features.explain 作用于「解释」',
  O3.provider === 'x-p' && O3.model === 'x-m', `${O3.provider}/${O3.model}`)

const O3b = await selectionRun({
  features: { explain: { provider: 'x-p', model: 'x-m' } },
}, 'translate')
check('features.explain 不影响「翻译」（跟随会话）',
  O3b.provider === 'session-p' && O3b.model === 'session-m', `${O3b.provider}/${O3b.model}`)

const O4 = await selectionRun({
  features: { translate: { provider: 'feat-p' } },
})
check('features 只给 provider 不算覆盖（跟随会话）',
  O4.provider === 'session-p' && O4.model === 'session-m', `${O4.provider}/${O4.model}`)

/* ------------------- 12) 整篇翻译后端已删除：路由不再存在（404） */

{
  boot({})
  const t1 = await call('/zotero-reader/translate?key=ABC')
  check('GET /translate 已删除 → 404', t1.statusCode === 404, `status=${t1.statusCode}`)
  const t2 = await call('/zotero-reader/translate/progress?key=ABC')
  check('GET /translate/progress 已删除 → 404', t2.statusCode === 404, `status=${t2.statusCode}`)
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
for (const dir of tmpDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
process.exit(failed === 0 ? 0 : 1)
