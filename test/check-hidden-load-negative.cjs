/**
 * 负向验证：把 active 放回依赖数组（即退回「切 tab 就销毁重建」的坏形态），
 * 确认 check-hidden-load.mjs 会失败。
 *
 * 只做内存字符串替换 + 临时写回，跑完立刻还原，绝不留下改动。
 */
const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const real = path.join(root, 'client.js')
const orig = fs.readFileSync(real, 'utf8')

const broken = orig.replace(
  '      }, [itemKey, reloadToken])',
  '      }, [itemKey, reloadToken, active])',
)

if (broken === orig) {
  console.log('SKIP: 没找到依赖数组，负向验证未执行')
  process.exit(2)
}

fs.writeFileSync(real, broken, 'utf8')
console.log('已临时把 active 放回依赖数组，运行检查…')

let code = 0
let out = ''
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'check-hidden-load.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout || '') + String(e.stderr || '')
}

fs.writeFileSync(real, orig, 'utf8')

const hit = /active 不在加载 effect 的依赖里/.test(out) && /FAIL/.test(out)
console.log(out.split('\n').filter((l) => /FAIL|passed|failed/.test(l)).join('\n'))
console.log('---')
if (code === 1 && hit) {
  console.log('PASS: 缺陷被抓住（退出码 1，命中断言）')
  process.exit(0)
}
console.log(`FAIL: 没抓住（exit=${code}, 命中=${hit}）`)
process.exit(1)
