/**
 * 负向验证：移除 pagechanging 的恢复期守卫，
 * 确认 check-resume-no-overwrite.mjs 会失败。
 *
 * 这个缺陷不会报任何错 —— 只是位置每次都被覆盖成第 1 页，
 * 用户看到「刷新后先回第一页」，而代码看起来完全正常。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

const guard = '              if (!resumeDoneRef.current) return\n'
if (!orig.includes(guard)) {
  console.log('SKIP: 找不到守卫行')
  process.exit(2)
}

fs.writeFileSync(real, orig.replace(guard, ''), 'utf8')
console.log('已移除恢复期守卫，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-resume-no-overwrite.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /pagechanging 里有守卫/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
