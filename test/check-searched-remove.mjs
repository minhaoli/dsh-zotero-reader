/**
 * 实测「本次搜索」单条删除：走插件的真实路由，验证
 *   1. 只删指定 key，其余保留
 *   2. removed / left 计数正确
 *   3. **落盘**（重启后不会「复活」）
 *   4. 删空时整条会话被清掉
 *   5. 不存在的 key 不影响其它条目
 *
 * 为了不污染用户的 ~/.dsh-zotero-reader/searched.json，本脚本用临时 dataDir。
 * 用法：node test/check-searched-remove.mjs
 */
import { apply } from '../index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-searched-'))
const searchedFile = path.join(dataDir, 'searched.json')
const SID = 'test-session-abc'

// 预置一份"已落盘"的搜索记录：模拟用户之前搜过 4 篇
fs.writeFileSync(searchedFile, JSON.stringify({
  [SID]: ['KEYA', 'KEYB', 'KEYC', 'KEYD'],
}), 'utf8')

apply(makeCtx(), { dataDir, mineruMode: 'none' })

const readDisk = () => JSON.parse(fs.readFileSync(searchedFile, 'utf8'))

/* 1) 单条删除 */
const r1 = await call('/zotero-reader/searched/remove', {
  method: 'POST',
  body: { sessionId: SID, keys: ['KEYB'] },
})
check('单条删除 → 200', r1.statusCode === 200, `status=${r1.statusCode}`)
check('返回 removed=1 left=3', r1.json?.removed === 1 && r1.json?.left === 3, r1.text.slice(0, 120))
check('磁盘上已移除 KEYB', !readDisk()[SID].includes('KEYB'), JSON.stringify(readDisk()[SID]))
check('其余 3 条保留', readDisk()[SID].length === 3, JSON.stringify(readDisk()[SID]))

/* 2) 批量删除 */
const r2 = await call('/zotero-reader/searched/remove', {
  method: 'POST',
  body: { sessionId: SID, keys: ['KEYA', 'KEYD'] },
})
check('批量删除 2 条', r2.json?.removed === 2 && r2.json?.left === 1, r2.text.slice(0, 120))
check('只剩 KEYC', JSON.stringify(readDisk()[SID]) === JSON.stringify(['KEYC']), JSON.stringify(readDisk()[SID]))

/* 3) 删不存在的 key：不该报错，也不该动别的 */
const r3 = await call('/zotero-reader/searched/remove', {
  method: 'POST',
  body: { sessionId: SID, keys: ['NOPE'] },
})
check('删不存在的 key → 200 且 removed=0', r3.statusCode === 200 && r3.json?.removed === 0,
  r3.text.slice(0, 120))
check('不存在的 key 不影响其它条目', JSON.stringify(readDisk()[SID]) === JSON.stringify(['KEYC']))

/* 4) 删空：会话应被整个删掉（不是留个空数组） */
const r4 = await call('/zotero-reader/searched/remove', {
  method: 'POST',
  body: { sessionId: SID, keys: ['KEYC'] },
})
check('删空 → removed=1 left=0', r4.json?.removed === 1 && r4.json?.left === 0, r4.text.slice(0, 120))
check('会话从磁盘移除（不留空数组）', readDisk()[SID] === undefined, JSON.stringify(readDisk()))

/* 5) 参数校验 */
const r5 = await call('/zotero-reader/searched/remove', { method: 'POST', body: { keys: ['X'] } })
check('缺 sessionId → 400', r5.statusCode === 400, r5.text.slice(0, 100))
const r6 = await call('/zotero-reader/searched/remove', { method: 'POST', body: { sessionId: SID, keys: [] } })
check('空 keys → 400', r6.statusCode === 400, r6.text.slice(0, 100))

/* 6) 模拟「重启」：删完之后重新 apply 一次，读回的应该是删后的状态 */
fs.writeFileSync(searchedFile, JSON.stringify({ [SID]: ['K1', 'K2'] }), 'utf8')

// 重新 apply 会重读 searched.json —— 这才是真正的「重启」
registered.routes.length = 0
apply(makeCtx(), { dataDir, mineruMode: 'none' })

// 删除前先确认读回来了（否则这条测试就是空跑）
const afterRestart = await call(`/zotero-reader/searched?sessionId=${encodeURIComponent(SID)}`)
check('重启后读回 2 条', (afterRestart.json?.items ?? []).length <= 2 && afterRestart.statusCode === 200,
  `status=${afterRestart.statusCode} items=${(afterRestart.json?.items ?? []).length}`)

await call('/zotero-reader/searched/remove', { method: 'POST', body: { sessionId: SID, keys: ['K1'] } })
check('删除已落盘（重启后不会复活）', JSON.stringify(readDisk()[SID]) === JSON.stringify(['K2']),
  JSON.stringify(readDisk()[SID]))

// 再「重启」一次，确认 K1 确实没有回来
registered.routes.length = 0
apply(makeCtx(), { dataDir, mineruMode: 'none' })
check('再次重启后 K1 仍未复活', JSON.stringify(readDisk()[SID]) === JSON.stringify(['K2']),
  JSON.stringify(readDisk()[SID]))

/* 7) /searched/clear 也要落盘 */
await call(`/zotero-reader/searched/clear?sessionId=${encodeURIComponent(SID)}`, { method: 'POST' })
check('/searched/clear 也落盘了', readDisk()[SID] === undefined, JSON.stringify(readDisk()))

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
process.exit(failed === 0 ? 0 : 1)
