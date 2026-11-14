/**
 * 负向验证：让「覆盖 draw」晚于「setDocument」。
 *
 * 做法：把 setDocument 那一行**复制**到覆盖代码之前（形成一次提前的 setDocument），
 * 这样 indexOf('viewer.setDocument(pdf.doc)') 会命中到前面那个，测试就会判失败。
 *
 * 这是最贴近真实错误的模拟 —— 真出这个 bug 时，代码往往就是把初始化顺序写反了，
 * 而它**不会有任何报错**，只是白改。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

const patchMarker = '            const noopAccessibility = {'
if (!orig.includes(patchMarker)) {
  console.log('SKIP: 找不到覆盖区块起点')
  process.exit(2)
}

// 在覆盖区块之前插一行 setDocument，让它的首次出现位置提前
const broken = orig.replace(
  patchMarker,
  '            void viewer.setDocument(pdf.doc) // 模拟顺序错误\n' + patchMarker,
)

if (broken === orig) {
  console.log('SKIP: 替换未生效')
  process.exit(2)
}

fs.writeFileSync(real, broken, 'utf8')
console.log('已把 setDocument 提前到覆盖之前，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-a11y-disable.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /覆盖发生在 setDocument 之前/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
