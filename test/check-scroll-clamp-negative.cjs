/**
 * 负向验证：去掉 target 的下界夹取（退回 `pageTop - 8`），
 * 确认 check-scroll-clamp.mjs 会失败。
 *
 * 这个缺陷的后果很隐蔽：页面看着正常、日志也不报错，
 * 只是第 1 页永远判「没滚到位」，进而让恢复流程空转 25 次。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

// 把夹取退回成原来的裸计算
const broken = orig.replace(
  /const target = Math\.min\(\s*maxTop,\s*Math\.max\(0, pageTop - 8 \+ pageH \* Math\.min\(0\.98, Math\.max\(0, offset\)\)\),\s*\)/,
  'const target = pageTop - 8 + pageH * Math.min(0.98, Math.max(0, offset))',
)

if (broken === orig) {
  console.log('SKIP: 没找到夹取代码')
  process.exit(2)
}

fs.writeFileSync(real, broken, 'utf8')
console.log('已移除 target 夹取，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-scroll-clamp.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /target 被夹住/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
