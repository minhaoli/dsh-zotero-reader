/**
 * 读最近一次「打开 PDF」的渲染证据链，判断画布到底有没有画出来。
 *
 * 起因：`viewer:ready` 曾经只打文档总页数，哪怕一页都没建出来也照打，
 * 排查时被这条假绿灯误导过（表现为画布全黑但日志「正常」）。
 * 现在以 DOM 里的 `.page` 实际数量为准。
 *
 * 用法：node test/watch-render.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const logPath = path.join(os.homedir(), '.dsh-zotero-reader', 'client-log.jsonl')
if (!fs.existsSync(logPath)) {
  console.error('没有客户端日志:', logPath)
  process.exit(2)
}

const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
const evts = []
for (const l of lines) {
  try { evts.push(JSON.parse(l)) } catch { /* 坏行跳过 */ }
}

let last = -1
for (let i = evts.length - 1; i >= 0; i--) {
  if (evts[i].event === 'pdf:start') { last = i; break }
}
console.log(`日志事件总数 ${evts.length}`)
if (last < 0) {
  console.log('日志里还没有任何 pdf:start')
  process.exit(0)
}

const pick = (e) => {
  switch (e.event) {
    case 'viewer:before-setdoc':
      return `container=${JSON.stringify(e.containerSize)} viewer=${JSON.stringify(e.viewerSize)} host=${JSON.stringify(e.hostSize)}`
    case 'annot:scale':
      return `page=${e.pageNo} k=${e.k}`
    case 'viewer:ready':
      return `pages=${e.pages} domPages=${e.domPages} scale=${e.viewerScale}`
    case 'viewer:render-check':
      return `domPages=${e.domPages} rendered=${e.rendered}`
    case 'viewer:doc-set':
      return `pages=${e.pages}`
    default:
      return e.message ? String(e.message).slice(0, 160) : ''
  }
}

const SHOW = new Set([
  'pdf:start', 'pdf:bytes', 'pdf:ready', 'viewer:before-setdoc', 'viewer:doc-set',
  'viewer:ready', 'viewer:render-check', 'annot:scale', 'viewer:error', 'window:error',
])

console.log('=== 最近一次打开 PDF ===')
const session = evts.slice(last)
const flags = { docSet: false, ready: false, renderCheck: null, scale: 0, err: null }
for (const e of session) {
  if (e.event === 'viewer:doc-set') flags.docSet = true
  if (e.event === 'viewer:ready') flags.ready = true
  if (e.event === 'viewer:render-check') flags.renderCheck = e.rendered
  if (e.event === 'annot:scale') flags.scale += 1
  if (e.event === 'window:error' || e.event === 'viewer:error') flags.err = e.message
  if (!SHOW.has(e.event)) continue
  console.log(` ${e.at}  ${e.event.padEnd(20)} ${pick(e)}`)
}

console.log('\n=== 结论 ===')
console.log('  文档已交给 viewer (viewer:doc-set) :', flags.docSet)
console.log('  viewer:ready                      :', flags.ready)
console.log('  DOM 里有页元素 (render-check)      :', flags.renderCheck)
console.log('  decoratePage 被调用次数 (annot:scale):', flags.scale)
if (flags.err) console.log('  最近的错误                        :', flags.err)

const ok = flags.docSet && flags.ready && flags.renderCheck === true && flags.scale > 0
console.log('\n  ' + (ok
  ? '✅ 画布已渲染（有页元素、pagerendered 触发了 decoratePage）'
  : '❌ 画布未确认渲染，看上表哪一项没通过'))
process.exitCode = ok ? 0 : 1
