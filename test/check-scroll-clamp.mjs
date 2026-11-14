#!/usr/bin/env node
/**
 * 「刷新后闪回第一页 + 状态被抹除」的最后一道防线。
 *
 * 用户的原话很准确：「需要一段时间后才能跳转到当前页，在此之前的所有状态被抹除」。
 * 拆开是三个叠加的缺陷：
 *
 *   ① scrollPageIntoView 对第 1 页恒返回 false
 *      target 算成 pageTop-8 = -8，而 scrollTop 最小是 0，永远差 8>2。
 *      于是恢复第 1 页被判失败，重试 25 次（日志 attempts=25 ok=False）。
 *
 *   ② 重试期间 resumeDoneRef 不置位
 *      这段时间内用户翻的每一页都不被记录 —— 就是「状态被抹除」。
 *
 *   ③ 3 秒保底闸无条件放行
 *      恢复还在重试时闸就开了，pdf.js 抛的 pagechanging(1) 漏进来，
 *      位置被写成第 1 页，形成「怎么刷都回第一页」的循环。
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

/* ---------- ① 目标位置必须夹在滚动区间内 ---------- */

const scrollFnStart = src.indexOf('function scrollPageIntoView')
const scrollFnEnd = src.indexOf('\n    }', src.indexOf('return Math.abs(scroller.scrollTop - target)', scrollFnStart))
const scrollFn = scrollFnStart > 0 ? src.slice(scrollFnStart, scrollFnEnd + 6) : ''

check('找得到 scrollPageIntoView', scrollFnStart > 0)
check('函数体已定位（负向断言的前提）', scrollFn.length > 400)

check('target 被夹住（不会出现负数）',
  /Math\.max\(0,\s*pageTop - 8/.test(scrollFn),
  '第 1 页 pageTop=0，减 8 得 -8，scrollTop 到不了负值 → 判失败')

check('target 不超过最大滚动量',
  /Math\.min\(\s*maxTop/.test(scrollFn) && /scrollHeight - scroller\.clientHeight/.test(scrollFn),
  '不夹上界时，末尾页的目标会超出可滚范围，同样判失败')

check('仍保留原有的 offset 语义（两页之间落点）',
  /pageH \* Math\.min\(0\.98/.test(scrollFn))

/* ---------- ② 保底闸不能无条件放行 ---------- */

const timeoutIdx = src.indexOf("event: 'viewer:resume-timeout'")
check('保底闸存在且有日志', timeoutIdx > 0)

const timeoutBlock = timeoutIdx > 0 ? src.slice(timeoutIdx - 500, timeoutIdx + 200) : ''
check('保底闸先判断是否已落地',
  /if \(disposed \|\| resumeDoneRef\.current\) return/.test(timeoutBlock),
  '无条件放行会让恢复期抛的 pagechanging(1) 漏进来，位置又被写成第 1 页')

/* ---------- ③ 落地时校正 lastSaved，避免 cleanup 写旧值 ---------- */

const appliedIdx = src.indexOf("event: 'viewer:resume-applied'")
const beforeApplied = appliedIdx > 0 ? src.slice(appliedIdx - 900, appliedIdx) : ''

check('落地前置位 resumeDoneRef', /resumeDoneRef\.current = true/.test(beforeApplied))
check('落地时把 lastSavedPage 对齐到恢复目标',
  /lastSavedPageRef\.current = resumePage/.test(beforeApplied),
  '不对齐的话，恢复期被守卫挡掉的更新会让 lastSaved 停在旧值，cleanup 会写回去')

/* ---------- ④ 守卫本身仍在 ---------- */

check('pagechanging 仍有恢复期守卫',
  /if \(!resumeDoneRef\.current\) return/.test(src))

/* ---------- ⑤ 判据不放水 ---------- */

check('ok 判据仍要求真的滚到位（没有用 attempt 兜底）',
  /const ok = pageOk && scrolled/.test(src),
  '写成 ok = pageOk && (scrolled || attempt >= N) 会把「页码对但没滚」记成成功')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
