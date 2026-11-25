/**
 * 设置契约测试：GET / POST /zotero-reader/settings。
 *
 * 覆盖提交 105cf88 新增的设置字段：
 *   1. GET 只回 `xxSet` 布尔，绝不回明文 secret（cloudApiKey / mineruCloudToken）
 *   2. POST 接受 cloudApiKey / cloudUserID / features / translateEfforts 并落盘
 *   3. features 必须是对象（数组、字符串、数字、null → 400），键集合固定四键
 *   4. normalizeFeatures 对缺失 / null / 数组 / 字符串 / 半截对象容错，不抛错
 *   5. translateEfforts 默认序列与 host/translate.js 原硬编码一致，可覆盖且会归一化
 *   6. 模型覆盖优先级：features.<name> > selectionProvider/selectionModel > 跟随会话
 *
 * 全部本地：临时 dataDir + 桩 ctx，**不联网、不依赖 Zotero 运行**。
 * 与 index.js 的对应位置：normalizeConfig L478-508、normalizeFeatures L517-531、
 * normalizeEfforts L534-553、selectionOverride L696-712、GET/POST /settings L833-905。
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

/** 桩 ctx：只实现 apply 会用到的那几个属性。 */
function makeCtx({ llmCalls = [], session } = {}) {
  const sel = session ?? { provider: 'session-p', model: 'session-m', reasoningEffort: 'high' }
  const ctx = {
    tools: { register: (def) => { registered.tools.push(def); return () => {} } },
    effect: (fn) => fn(),
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

/** 起一次插件（= 一次「启动」），返回临时 dataDir 与 llm 调用记录。 */
function boot(config = {}, opts = {}) {
  const dir = opts.dataDir ?? newDataDir()
  const llmCalls = []
  registered.routes.length = 0
  apply(makeCtx({ llmCalls, session: opts.session }), { dataDir: dir, ...config })
  return { dir, llmCalls, settingsFile: path.join(dir, 'settings.json') }
}

/** 起一次插件并 GET /settings。 */
async function settingsOf(config) {
  const b = boot(config)
  const res = await call('/zotero-reader/settings')
  return { ...b, res }
}

const SECRET_CLOUD_KEY = 'SECRET_CLOUD_KEY_0123456789'
const SECRET_MINERU_TOKEN = 'mineru-secret-token-XYZ'

/* ---------------------------------------- 1) GET：秘密只回布尔，不回明文 */

const A = await settingsOf({
  cloudApiKey: SECRET_CLOUD_KEY,
  cloudUserID: '  1234567  ',
  mineruCloudToken: SECRET_MINERU_TOKEN,
  features: { translate: { provider: ' p1 ', model: ' m1 ', reasoningEffort: ' high ' } },
})
const g1 = A.res
const g1json = g1.json ?? {}
const g1text = g1.text

check('GET /settings → 200', g1.statusCode === 200, `status=${g1.statusCode}`)
check('GET 响应体有 cloudApiKeySet 字段', Object.keys(g1json).includes('cloudApiKeySet'))
check('GET cloudApiKeySet 为 true（已配置）', g1json.cloudApiKeySet === true,
  String(g1json.cloudApiKeySet))
check('GET 响应体不含 cloudApiKey 明文', !g1text.includes(SECRET_CLOUD_KEY))
check('GET 响应体没有 cloudApiKey 字段（只回 Set 布尔）',
  !Object.keys(g1json).includes('cloudApiKey'), Object.keys(g1json).join(','))
check('GET 响应体有 mineruCloudTokenSet 字段', Object.keys(g1json).includes('mineruCloudTokenSet'))
check('GET mineruCloudTokenSet 为 true', g1json.mineruCloudTokenSet === true,
  String(g1json.mineruCloudTokenSet))
check('GET 响应体不含 mineruCloudToken 明文', !g1text.includes(SECRET_MINERU_TOKEN))
check('GET 响应体没有 mineruCloudToken 字段',
  !Object.keys(g1json).includes('mineruCloudToken'))
check('GET cloudUserID 被 trim', g1json.cloudUserID === '1234567', JSON.stringify(g1json.cloudUserID))
check('GET 返回 resolvedDataDir（只读展示）', g1json.resolvedDataDir === A.dir, String(g1json.resolvedDataDir))
check('GET 返回 zoteroDataDir（可编辑字段）', typeof g1json.zoteroDataDir === 'string')

const B = await settingsOf({})
check('未配置 key 时 cloudApiKeySet 为 false', B.res.json?.cloudApiKeySet === false,
  String(B.res.json?.cloudApiKeySet))
check('未配置 token 时 mineruCloudTokenSet 为 false', B.res.json?.mineruCloudTokenSet === false,
  String(B.res.json?.mineruCloudTokenSet))
check('未配置时 cloudUserID 为空串', B.res.json?.cloudUserID === '',
  JSON.stringify(B.res.json?.cloudUserID))

/* ----------------------------------- 2) features 结构（四键、三字段、trim） */

check('FEATURE_KEYS 就是四个功能键',
  JSON.stringify(FEATURE_KEYS) === JSON.stringify(['translate', 'explain', 'ask', 'docTranslate']),
  JSON.stringify(FEATURE_KEYS))

const featKeys = Object.keys(g1json.features ?? {}).sort()
check('GET /settings 的 features 正好覆盖四个键',
  JSON.stringify(featKeys) === JSON.stringify([...FEATURE_KEYS].sort()), featKeys.join(','))

const featTranslate = g1json.features?.translate ?? {}
check('features 每个功能含 provider / model / reasoningEffort',
  ['provider', 'model', 'reasoningEffort'].every((k) => k in featTranslate),
  Object.keys(featTranslate).join(','))
check('features.translate.provider 被 trim', featTranslate.provider === 'p1',
  JSON.stringify(featTranslate.provider))
check('features.translate.model 被 trim', featTranslate.model === 'm1',
  JSON.stringify(featTranslate.model))
check('features.translate.reasoningEffort 被 trim', featTranslate.reasoningEffort === 'high',
  JSON.stringify(featTranslate.reasoningEffort))

/* ------------------------------- 3) normalizeFeatures 容错（不抛错、补全） */

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
  check(`features=${label} → 响应 200 且补成四键默认结构`,
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
    && feats.translate?.provider === '' && feats.ask?.provider === '' && feats.docTranslate?.provider === '',
    JSON.stringify(feats))
}

{
  const r = await settingsOf({ features: { nope: { provider: 'x', model: 'y' } } })
  check('features 未知键被丢弃',
    !Object.keys(r.res.json?.features ?? {}).includes('nope'),
    Object.keys(r.res.json?.features ?? {}).join(','))
}

/* --------------------------- 4) POST：四个字段都接受、生效、落盘、可重启 */

const C = boot({})
const p1 = await call('/zotero-reader/settings', {
  method: 'POST',
  body: {
    cloudApiKey: '  POSTKEY123  ',
    cloudUserID: ' 7654321 ',
    features: { translate: { provider: 'pp', model: 'mm' } },
    translateEfforts: ['high', 'high', ' low ', null, 5, ''],
  },
})
check('POST /settings → 200', p1.statusCode === 200, `status=${p1.statusCode}`)
check('POST 接受 cloudApiKey → cloudApiKeySet: true', p1.json?.cloudApiKeySet === true)
check('POST 响应也不含 cloudApiKey 明文', !p1.text.includes('POSTKEY123'))
check('POST 接受 cloudUserID 并 trim', p1.json?.cloudUserID === '7654321',
  JSON.stringify(p1.json?.cloudUserID))
check('POST 接受 features 并生效',
  p1.json?.features?.translate?.provider === 'pp' && p1.json?.features?.translate?.model === 'mm',
  JSON.stringify(p1.json?.features?.translate))
check('POST 接受 translateEfforts 并归一化（去重 / trim / 保留 null / 丢非法）',
  JSON.stringify(p1.json?.translateEfforts) === JSON.stringify(['high', 'low', null]),
  JSON.stringify(p1.json?.translateEfforts))

check('POST 已落盘 settings.json', fs.existsSync(C.settingsFile))
const disk = fs.existsSync(C.settingsFile) ? JSON.parse(fs.readFileSync(C.settingsFile, 'utf8')) : {}
check('落盘含 cloudApiKey（存储层必须有明文）', disk.cloudApiKey === 'POSTKEY123',
  JSON.stringify(disk.cloudApiKey))
check('落盘 cloudUserID 已 trim', disk.cloudUserID === '7654321', JSON.stringify(disk.cloudUserID))
check('落盘 features 已补齐四键', FEATURE_KEYS.every((k) => disk.features?.[k]),
  Object.keys(disk.features ?? {}).join(','))
check('落盘 translateEfforts 已归一化',
  JSON.stringify(disk.translateEfforts) === JSON.stringify(['high', 'low', null]),
  JSON.stringify(disk.translateEfforts))

// 「重启」：同目录重新 apply，设置应从 settings.json 读回
{
  registered.routes.length = 0
  apply(makeCtx({}), { dataDir: C.dir })
  const g = await call('/zotero-reader/settings')
  check('重启后 cloudApiKeySet 仍为 true', g.json?.cloudApiKeySet === true)
  check('重启后 features 仍生效', g.json?.features?.translate?.provider === 'pp',
    JSON.stringify(g.json?.features?.translate))
  check('重启后 translateEfforts 仍为归一化值',
    JSON.stringify(g.json?.translateEfforts) === JSON.stringify(['high', 'low', null]),
    JSON.stringify(g.json?.translateEfforts))
}

{
  const p2 = await call('/zotero-reader/settings', { method: 'POST', body: { cloudApiKey: '' } })
  check('POST 空 key 表示清除 → cloudApiKeySet: false',
    p2.statusCode === 200 && p2.json?.cloudApiKeySet === false, String(p2.json?.cloudApiKeySet))
  const p3 = await call('/zotero-reader/settings', { method: 'POST', body: { cloudUserID: '999' } })
  check('POST 只改 cloudUserID 不影响 features',
    p3.json?.features?.translate?.provider === 'pp', JSON.stringify(p3.json?.features?.translate))
  check('POST 只改 cloudUserID 时 translateEfforts 保留',
    JSON.stringify(p3.json?.translateEfforts) === JSON.stringify(['high', 'low', null]))
}

/* ------------------------------------------ 5) POST 参数校验：非法输入 400 */

const D = boot({})
for (const [label, features] of [
  ['数组', []],
  ['字符串', 'x'],
  ['null', null],
  ['数字', 42],
]) {
  const r = await call('/zotero-reader/settings', { method: 'POST', body: { features } })
  check(`POST features=${label} → 400 且提示 features`,
    r.statusCode === 400 && /features/.test(r.json?.error ?? ''),
    `status=${r.statusCode} ${r.text.slice(0, 80)}`)
}

for (const [label, translateEfforts] of [
  ['字符串', 'off'],
  ['数字', 5],
  ['对象', { 0: 'off' }],
  ['null', null],
]) {
  const r = await call('/zotero-reader/settings', { method: 'POST', body: { translateEfforts } })
  check(`POST translateEfforts=${label} → 400 且提示 translateEfforts`,
    r.statusCode === 400 && /translateEfforts/.test(r.json?.error ?? ''),
    `status=${r.statusCode} ${r.text.slice(0, 80)}`)
}

check('校验失败时不落盘（settings.json 未生成）', !fs.existsSync(D.settingsFile))

/* ------------------------------ 6) translateEfforts 默认值与归一化边界 */

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
  const E = boot({})
  const r1 = await call('/zotero-reader/settings', { method: 'POST', body: { translateEfforts: [] } })
  check('POST translateEfforts=[] → 回退默认序列（空序列会让回退链一次都不跑）',
    JSON.stringify(r1.json?.translateEfforts) === JSON.stringify(['off', 'low', null]),
    JSON.stringify(r1.json?.translateEfforts))
  const r2 = await call('/zotero-reader/settings', { method: 'POST', body: { translateEfforts: ['', 0, {}, null] } })
  check('POST 全非法值只留下 null 一档', JSON.stringify(r2.json?.translateEfforts) === JSON.stringify([null]),
    JSON.stringify(r2.json?.translateEfforts))
  const r3 = await call('/zotero-reader/settings', { method: 'POST', body: { translateEfforts: [' medium '] } })
  check('POST 单档位序列原样生效', JSON.stringify(r3.json?.translateEfforts) === JSON.stringify(['medium']),
    JSON.stringify(r3.json?.translateEfforts))
}

/* --------------------- 7) 模型覆盖优先级（走 /selection 的真实路径） */

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
  selectionProvider: 'old-p',
  selectionModel: 'old-m',
})
check('/selection 真实调用了 llm 并返回译文',
  O1.res.statusCode === 200 && O1.res.json?.text === '译文' && O1.calls > 0,
  `status=${O1.res.statusCode} text=${JSON.stringify(O1.res.json?.text)} calls=${O1.calls}`)
check('优先级：features.translate 压过 selectionProvider/selectionModel',
  O1.provider === 'feat-p' && O1.model === 'feat-m', `${O1.provider}/${O1.model}`)

const O2 = await selectionRun({ selectionProvider: 'old-p', selectionModel: 'old-m' })
check('优先级：没有 features 时用 selectionProvider/selectionModel',
  O2.provider === 'old-p' && O2.model === 'old-m', `${O2.provider}/${O2.model}`)

const O3 = await selectionRun({})
check('优先级：两者都为空时跟随会话当前模型',
  O3.provider === 'session-p' && O3.model === 'session-m', `${O3.provider}/${O3.model}`)

const O4 = await selectionRun({
  features: { translate: { provider: 'feat-p' } },
  selectionProvider: 'old-p',
  selectionModel: 'old-m',
})
check('features 只给 provider 不算覆盖（回落 selection*）',
  O4.provider === 'old-p' && O4.model === 'old-m', `${O4.provider}/${O4.model}`)

const O5a = await selectionRun({
  features: { explain: { provider: 'x-p', model: 'x-m' } },
  selectionProvider: 'old-p',
  selectionModel: 'old-m',
}, 'explain')
check('features.explain 作用于「解释」', O5a.provider === 'x-p' && O5a.model === 'x-m',
  `${O5a.provider}/${O5a.model}`)

const O5b = await selectionRun({
  features: { explain: { provider: 'x-p', model: 'x-m' } },
  selectionProvider: 'old-p',
  selectionModel: 'old-m',
}, 'translate')
check('features.explain 不影响「翻译」（回落 selection*）',
  O5b.provider === 'old-p' && O5b.model === 'old-m', `${O5b.provider}/${O5b.model}`)

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
for (const dir of tmpDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
process.exit(failed === 0 ? 0 : 1)
