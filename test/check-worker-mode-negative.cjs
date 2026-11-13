/**
 * 负向验证：把 globalThis.pdfjsWorker 提前到探测之前设置，
 * 确认 check-worker-mode.mjs 会失败。
 *
 * 这个错误形态最危险：一旦提前设置，pdf.js 的 #initialize() 会直接
 * 走 #setupFakeWorker，真 worker 永远没机会 —— 而表面上一个错都不报，
 * 只是「怎么还是主线程」，极难发现。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

// 在探测之前插入一行提前设置
const marker = 'const probe = await canWorkerReply()'
const broken = orig.replace(marker, 'globalThis.pdfjsWorker = { WorkerMessageHandler: () => {} }\n            ' + marker)

if (broken === orig) {
  console.log('SKIP: 没找到插入点')
  process.exit(2)
}

fs.writeFileSync(real, broken, 'utf8')
console.log('已临时把 pdfjsWorker 提前到探测之前，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-worker-mode.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /只在探测之后设置/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1，命中断言）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
