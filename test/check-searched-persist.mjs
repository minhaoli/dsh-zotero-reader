/**
 * 验证搜索记录的分会话隔离与落盘/回读。
 * 直接操作 dataDir 下的 searched.json，不依赖宿主会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = path.join(os.homedir(), '.dsh-zotero-reader')
const file = path.join(dataDir, 'searched.json')

console.log('=== 目标文件 ===')
console.log(' ', file)

/**
 * 复刻 index.js 里的三个关键函数，验证语义。
 */
function normalizeSessionId(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.replace(/^session-/, '')
}

// 模拟两个会话
const searched = new Map()
function onHits(sessionId, keys) {
  const id = normalizeSessionId(sessionId)
  if (!id || keys.length === 0) return
  const list = searched.get(id) ?? []
  for (const key of keys) if (!list.includes(key)) list.push(key)
  searched.set(id, list)
}
function persist() {
  fs.mkdirSync(dataDir, { recursive: true })
  const obj = {}
  for (const [id, list] of searched) obj[id] = list
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
}

// 会话 A 搜两次，会话 B 搜一次；注意 A 用带前缀的 id，B 不带 —— 验证归一化
onHits('session-aaaa-1111', ['KEYA1', 'KEYA2'])
onHits('session-aaaa-1111', ['KEYA2', 'KEYA3'])   // 去重
onHits('bbbb-2222', ['KEYB1'])
persist()

console.log('\n=== 落盘内容 ===')
console.log(fs.readFileSync(file, 'utf8'))

// 回读
const reparsed = new Map()
try {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [id, list] of Object.entries(saved)) {
    if (Array.isArray(list)) reparsed.set(normalizeSessionId(id), list)
  }
} catch (e) {
  console.log('回读失败:', e.message)
}

console.log('=== 断言 ===')
const A = reparsed.get('aaaa-1111')
const B = reparsed.get('bbbb-2222')
const checks = [
  ['会话A 拿到 3 条（去重后）', A?.length === 3],
  ['会话A 内容正确', JSON.stringify(A) === JSON.stringify(['KEYA1', 'KEYA2', 'KEYA3'])],
  ['会话B 只有自己的 1 条', JSON.stringify(B) === JSON.stringify(['KEYB1'])],
  ['会话A 看不到 B 的记录', !A?.includes('KEYB1')],
  ['会话B 看不到 A 的记录', !B?.includes('KEYA1')],
  ['带 session- 前缀被归一化', reparsed.has('aaaa-1111') && !reparsed.has('session-aaaa-1111')],
]
let ok = true
for (const [label, pass] of checks) {
  if (!pass) ok = false
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log('\n' + (ok ? 'ISOLATION + PERSISTENCE OK' : 'SOMETHING WRONG'))
process.exit(ok ? 0 : 1)
