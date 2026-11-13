/**
 * 负向验证：把 openWinRef 的修复临时退回成跨 effect 的局部 const，
 * 确认 check-scope-refs.mjs 真的会失败（退出码 1）。
 *
 * 只做内存内的字符串替换 + 写临时副本，绝不碰真实 client.js。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const bak = path.join(root, 'client.js.__negbak')

const orig = fs.readFileSync(real, 'utf8')

// 退回修复：setDocument-total 重新读局部 openWin（跨 effect）
const broken = orig.replace(
  "perf.attribute('setDocument-total', openWinRef.current)",
  "perf.attribute('setDocument-total', openWin)",
)

if (broken === orig) {
  console.log('SKIP: 没找到要替换的片段，负向验证未执行')
  process.exit(2)
}

fs.writeFileSync(bak, orig, 'utf8')
fs.writeFileSync(real, broken, 'utf8')
console.log('已临时植入跨作用域引用，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-scope-refs.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

// 无论如何都要还原
fs.writeFileSync(real, orig, 'utf8')
fs.unlinkSync(bak)

const hit = /没有跨 effect 引用/.test(out) && /FAIL/.test(out)
console.log(out.trim())
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被测试抓住（退出码 1，命中断言）')
  process.exit(0)
}
console.log(`FAIL: 测试没抓住缺陷（exit=${code}, 命中=${hit}）`)
process.exit(1)
