#!/usr/bin/env node
/**
 * pagesinit 抢跑 —— 「第一次就渲染目标页」的根治办法。
 *
 * 用户问得很直接：「为什么不控制直接第一个渲染当前页？」
 * 答案是：可以，之前只是时机都没找对。
 *
 * pdf.js 的 PDFViewer.setDocument 末尾（pdf_viewer.mjs L8660/L8673）：
 *   eventBus.dispatch("pagesinit")                    ← 页容器已进 DOM、高度已撑开
 *   if (this.defaultRenderingQueue) this.update()      ← 这里才决定渲染哪些页
 * 两句在同一个微任务里，pagesinit 在前。
 *
 * 所以在 pagesinit 里把 scrollTop 设到目标页，update() 第一次算可见页
 * 得到的就是目标页，pdf.js 根本不会去渲染第 1 页。
 *
 * 之前三次失败都是时机问题：
 *   ① setDocument 之后同步设 currentPageNumber → 页视图未建，赋值被丢弃
 *   ② 等 120ms 用 setTimeout → pdf.js 已在 update() 里决定画第 1 页
 *   ③ 完全不设 → 默认从第 1 页开始
 *
 * 这个测试守住时序 —— 一旦有人把这段挪到 setDocument 之后，就彻底失效了，
 * 而且不会有任何报错，只是「又开始闪第 1 页」。
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

/* ---------- ① 三者的相对顺序 ---------- */

const calcIdx = src.indexOf('const resumePage = savedPos?.page')
const regIdx = src.indexOf("'pagesinit'")
const setDocIdx = src.indexOf('viewer.setDocument(pdf.doc)')

check('找得到 resumePage 计算', calcIdx > 0)
check('找得到 pagesinit 注册', regIdx > 0)
check('找得到 setDocument', setDocIdx > 0)

check('resumePage 在 setDocument 之前算出', calcIdx < setDocIdx,
  '算得晚就来不及挂 pagesinit —— pagesinit 由 setDocument 内部派发')

check('pagesinit 在 setDocument 之前注册', regIdx < setDocIdx,
  '注册晚于 setDocument 就收不到这次 pagesinit（它是 once 且只派发一次）')

/* ---------- ② 回调里必须真的滚动 ---------- */

const regLineEnd = src.indexOf(')', src.indexOf('{ once: true }', regIdx))
const block = src.slice(regIdx, regLineEnd > regIdx ? regLineEnd : regIdx + 1200)

check('pagesinit 回调调用了 scrollPageIntoView',
  /scrollPageIntoView\(host, resumePage, resumeOffset\)/.test(block),
  '不滚的话 update() 仍按默认算第 1 页，等于没做')

check('目标页是第 1 页时不折腾', /resumePage <= 1/.test(block),
  '第 1 页本来就在顶部，再滚一次没必要')

check('有重试（页高可能还没最终确定）',
  /requestAnimationFrame\(land\)/.test(block) && /tries < \d+/.test(block),
  'pagesinit 时页容器刚进 DOM，个别情况下高度未定，量出来的 pageTop 会偏')

check('有日志便于现场确认', /viewer:pagesinit-land/.test(block))

/* ---------- ③ 不能因此重复声明 ---------- */

const calcCount = (src.match(/const resumePage = savedPos\?\.page/g) || []).length
check('resumePage 只声明一次（重复声明是 SyntaxError）', calcCount === 1,
  `实际声明 ${calcCount} 次`)

/* ---------- ④ 遮罩仍在（pagesinit 万一没赶上的兜底） ---------- */

check('恢复期遮罩仍在（兜底）',
  /host\.dataset\.restoring = '1'/.test(src),
  'pagesinit 若因某种原因没赶上，遮罩保证用户看不到第 1 页闪现')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
