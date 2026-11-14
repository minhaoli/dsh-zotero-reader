#!/usr/bin/env node
/**
 * 刷新后先回第一页 —— 防回归。
 *
 * 根因是一个自我强化的循环：
 *   ① setDocument 之后 pdf.js 把 currentPageNumber 置为 1，
 *      并立刻抛一次 pagechanging(pageNumber=1)
 *   ② 监听把它记进 lastSavedPageRef 并 debounce 写盘
 *      → localStorage 里那篇文献的位置被改成 1
 *   ③ resume-page 去读，读到 1 → 目标页变成第 1 页
 *   ④ cleanup 再把 1 写回去，下次还是 1
 *
 * 日志规律印证：目标=1 的打开，resume-applied 全是
 * attempts=25 ok=False（第 1 页已在顶部，滚不出位移）。
 *
 * 守住四点：
 *   ① 恢复落地前，pagechanging 不得写盘
 *   ② 复位必须早于 setDocument（它一执行就会抛 pagechanging）
 *   ③ 恢复成功与失败都要放行，否则后续翻页永不保存
 *   ④ 必须有保底闸 —— applyResume 若因异常没置位，保存不能永久失效
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

/* ---- 1. 守卫存在 ---- */

check('存在 resumeDoneRef', /const resumeDoneRef = useRef\(false\)/.test(src))

const pcIdx = src.indexOf("eventBus.on('pagechanging'")
const guardIdx = src.indexOf('if (!resumeDoneRef.current) return', pcIdx)
const writeIdx = src.indexOf('writeSavedPos(itemKey, lastSavedPageRef.current', pcIdx)

check('pagechanging 里有守卫', guardIdx > pcIdx && guardIdx < writeIdx,
  `守卫@${guardIdx} 必须在写盘@${writeIdx} 之前`)

/* ---- 2. 复位早于 setDocument ---- */

const resetIdx = src.indexOf('resumeDoneRef.current = false')
const setDocIdx = src.indexOf('viewer.setDocument(pdf.doc)')
check('复位早于 setDocument', resetIdx > 0 && resetIdx < setDocIdx,
  `复位@${resetIdx} 必须早于 setDocument@${setDocIdx}，否则它抛的第一条 pagechanging 就漏过去了`)

/* ---- 3. 恢复落地时放行（成败都放行） ---- */

const appliedIdx = src.indexOf("event: 'viewer:resume-applied'")
const doneIdx = src.indexOf('resumeDoneRef.current = true', appliedIdx - 500)
check('恢复落地时置位', doneIdx > 0 && doneIdx < appliedIdx,
  '置位应在写日志之前，且不区分 ok/失败 —— 失败也必须在，否则后续翻页永不保存')

/**
 * 置位不能写在 `if (ok) { ... }` 里 —— 那样失败就永不保存。
 * 简单判据：置位那一行到日志之间不应出现 `if (ok`。
 */
const between = src.slice(doneIdx, appliedIdx)
check('置位不依赖成功分支', !/if\s*\(\s*ok\s*\)/.test(between),
  '如果只在成功时置位，恢复失败后用户翻页全部不会被记住')

/* ---- 4. 保底闸 ---- */

check('有保底闸（3 秒后强制放行）',
  /setTimeout\(\(\) => \{ if \(!disposed\) resumeDoneRef\.current = true \}, 3000\)/.test(src),
  'applyResume 若因异常没置位，保存会永久失效 —— 那比回第一页更糟')

/* ---- 5. 不该顺手破坏的 ---- */

check('仍会写入位置（没有把功能整个关掉）',
  /writeSavedPos\(itemKey, lastSavedPageRef\.current/.test(src))
check('仍会读取保存的位置', /readSavedPos\(itemKey, pdf\.doc\.numPages\)/.test(src))
check('cleanup 里仍会落盘最后位置',
  /writeSavedPos\(itemKey, lastSavedPageRef\.current, lastSavedOffsetRef\.current \?\? 0\)/.test(src))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
