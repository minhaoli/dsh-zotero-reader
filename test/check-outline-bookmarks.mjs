/**
 * 大纲取书签的回归测试（不依赖本机 Zotero 库，可独立跑）。
 *
 * 覆盖三件事：
 *   · 有书签时按书签原样输出，页码与层级都不丢；
 *   · 页码解析失败的条目（page = 0）被丢掉，不占位置；
 *   · 没有书签时退回字号启发式，且编号标题能绕过字号门槛被认出来。
 *
 * 跑法：node test/check-outline-bookmarks.mjs
 */
import { outlineOf } from '../host/pdf.js'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// 1) 书签优先：原样输出，层级保留
const bookmarks = [
  { depth: 0, title: 'Part One', page: 10 },
  { depth: 1, title: '1. Introduction', page: 12 },
  { depth: 0, title: 'Part Two', page: 40 },
]
const fromBookmarks = outlineOf([''], [[]], bookmarks)
check('有书签时按书签输出', fromBookmarks.length === 3, `got ${fromBookmarks.length}`)
check('书签页码保留', fromBookmarks[1]?.page === 12, `got ${fromBookmarks[1]?.page}`)
check('书签层级保留', fromBookmarks[1]?.depth === 1, `got ${fromBookmarks[1]?.depth}`)

// 2) 解析不出页码的条目被过滤
const withBroken = outlineOf([''], [[]], [
  { depth: 0, title: 'Broken', page: 0 },
  { depth: 0, title: 'Good', page: 7 },
])
check('page 为 0 的书签被过滤', withBroken.length === 1 && withBroken[0].title === 'Good', JSON.stringify(withBroken))

// 3) 没有书签时退回启发式：正文 10pt、标题 12pt
const bodyLine = { text: 'This is a body sentence that ends like a sentence.', size: 10 }
const pageLines = [[bodyLine, bodyLine, bodyLine, bodyLine, { text: 'Discussion', size: 12 }]]
const heuristic = outlineOf(['page text'], pageLines, [])
check('无书签时走启发式', heuristic.length === 1 && heuristic[0].title === 'Discussion', JSON.stringify(heuristic))
check('启发式条目不带宽窄无关的 depth', heuristic[0]?.depth === undefined, String(heuristic[0]?.depth))

// 4) 编号标题在字号与正文相同时也能认出来
const sameSize = [[
  bodyLine,
  { text: '1.1. Participants', size: 10 },
  bodyLine,
]]
const numbered = outlineOf(['x'], sameSize, [])
check('同字号编号标题被识别', numbered.some((o) => o.title === '1.1. Participants'), JSON.stringify(numbered))

console.log(`\n===== ${pass}/${pass + fail} 通过 =====`)
process.exit(fail === 0 ? 0 : 1)
