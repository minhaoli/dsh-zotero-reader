/**
 * 页码输入框：编辑期间必须允许空值。
 *
 * 锁住的是一个回归过的具体 bug：把 jumpPage（数字）直接绑给受控 input，
 * 用户删光内容时 Number('') = 0，被 `|| 1` 兜成 1 写回，表现为
 * 「删不干净，删完自己变回 1，没法重新输入」。
 *
 * 正确形态：input 绑一个可为空的字符串缓冲（pageDraft），
 * 只在回车/失焦时解析；onChange 里不得出现 Number()+兜底。
 *
 * 跑法：node test/check-page-input.mjs
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failed = 0
function check(label, ok) {
  if (ok) console.log(`OK   ${label}`)
  else { console.log(`FAIL ${label}`); failed += 1 }
}

/** 取出页码 input 那一段（从 onChange 前 400 字到 style 结束），供逐条断言。 */
const inputStart = src.indexOf("type: 'number'")
check('找得到页码输入框', inputStart > 0)
const inputBlock = inputStart > 0 ? src.slice(inputStart, inputStart + 1600) : ''
/**
 * 区块没定位到时，`inputBlock` 是空串 —— 此时所有「不得出现 X」的负向断言
 * 都会空转通过，看起来全绿实则什么都没验。所以先把「区块拿到了」作为前提，
 * 下面的断言才有意义。
 */
check('输入框区块已定位（负向断言的前提）', inputBlock.length > 200)

/* ---------- 1. 必须有编辑缓冲 ---------- */
check('存在 pageDraft 编辑缓冲状态', /const \[pageDraft, setPageDraft\] = useState\(null\)/.test(src))
check('输入框 value 绑的是缓冲（允许 null 回落）',
  /value:\s*pageDraft\s*\?\?\s*String\(jumpPage\)/.test(inputBlock))
check('value 是字符串而非裸数字',
  !/value:\s*jumpPage\s*,/.test(inputBlock))

/* ---------- 2. onChange 不得解析 ---------- */
check('onChange 只写缓冲，不解析',
  /onChange:\s*\(e\)\s*=>\s*\{[\s\S]{0,160}setPageDraft\(e\.target\.value\)/.test(inputBlock))
check('onChange 里没有 Number(...) || 1 的兜底',
  inputBlock.length > 200 && !/onChange:[\s\S]{0,300}Number\(e\.target\.value\)\s*\|\|/.test(inputBlock))
check('onChange 里不直接 setJumpPage',
  inputBlock.length > 200 && !/onChange:[\s\S]{0,300}setJumpPage\(/.test(inputBlock))
check('整个输入框区块没有旧写法 setJumpPage(Number(',
  inputBlock.length > 200 && !/setJumpPage\(Number\(/.test(inputBlock))

/* ---------- 3. 空输入是合法的中间态 ---------- */
check('失焦时空输入被当作放弃编辑',
  /onBlur:[\s\S]{0,320}if\s*\(!raw\)\s*return/.test(inputBlock))
check('回车时空输入被当作放弃编辑',
  /onKeyDown:[\s\S]{0,420}if\s*\(!raw\)\s*return/.test(inputBlock))
check('提交后清空缓冲以恢复跟随',
  /setPageDraft\(null\)/.test(inputBlock))
check('Esc 可退出编辑',
  /e\.key === 'Escape'/.test(inputBlock))

/* ---------- 4. 提交路径仍然跳转 ---------- */
check('失焦提交走 gotoPage', /onBlur:[\s\S]{0,420}gotoPage\(/.test(inputBlock))
check('回车提交走 gotoPage', /onKeyDown:[\s\S]{0,520}gotoPage\(/.test(inputBlock))
check('非数字输入被忽略', /Number\.isFinite\(n\)/.test(inputBlock))

/* ---------- 5. 既有行为未被破坏 ---------- */
check('jumpPage 仍是当前页的事实来源', /const \[jumpPage, setJumpPage\] = useState\(1\)/.test(src))
check('滚动仍会同步 jumpPage', /setJumpPage\(e\.pageNumber\)/.test(src))
check('恢复阅读位置仍会同步 jumpPage', /setJumpPage\(resumePage\)/.test(src))
check('上一页按钮仍可用', /gotoPage\(jumpPage - 1\)/.test(src))
check('下一页按钮仍可用', /gotoPage\(jumpPage \+ 1\)/.test(src))

console.log(failed === 0 ? '\n===== 全部通过 =====' : `\n===== ${failed} 项失败 =====`)
process.exit(failed === 0 ? 0 : 1)
