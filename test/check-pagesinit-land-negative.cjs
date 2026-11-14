/**
 * 负向验证：把 pagesinit 注册挪到 setDocument 之后。
 *
 * 这是最贴近真实回归的模拟 —— 有人后来「顺手整理一下初始化顺序」，
 * 把监听挪到 setDocument 后面。代码看起来完全正常，也**不会报任何错**，
 * 只是 pagesinit 永远收不到（它 once 且只派发一次），
 * 于是「第一次渲染目标页」彻底失效，用户又开始看到闪回第一页。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

// 在 setDocument 之前插一行假的 pdf 调用，让「注册早于 setDocument」判定失败
const marker = '            eventBus.on(\n              \'pagesinit\','
if (!orig.includes(marker)) {
  console.log('SKIP: 找不到 pagesinit 注册块')
  process.exit(2)
}

// 把 setDocument 提到注册之前（模拟顺序错误）
const broken = orig.replace(
  marker,
  '            void viewer.setDocument(pdf.doc) // 模拟顺序错误\n' + marker,
)

if (broken === orig) {
  console.log('SKIP: 替换未生效')
  process.exit(2)
}

fs.writeFileSync(real, broken, 'utf8')
console.log('已把 setDocument 提前到 pagesinit 注册之前，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-pagesinit-land.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /pagesinit 在 setDocument 之前注册/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
