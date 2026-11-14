/**
 * 负向验证：把链接监听从 capture 改成 bubble 阶段。
 *
 * 这个回归极难发现：点击看起来「有时灵有时不灵」——
 * pdf.js 的处理器挂在 <a> 自身的 onclick 上，bubble 阶段到 host 时
 * 事件已经先经过 <a>，pdf.js 已经执行了它的导航逻辑（被宿主拦掉），
 * 我们的 preventDefault 来得太晚，只能补一次 window.open，
 * 于是表现为「偶尔打开两个窗口」或「没反应」。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

const good = "host.addEventListener('click', onPdfLinkClick, true)"
const bad = "host.addEventListener('click', onPdfLinkClick)"
if (!orig.includes(good)) {
  console.log('SKIP: 找不到 capture 监听')
  process.exit(2)
}

fs.writeFileSync(real, orig.replace(good, bad), 'utf8')
console.log('已把链接监听改成 bubble 阶段，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-pdf-links.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /用 capture 阶段/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
