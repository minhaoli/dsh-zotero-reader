#!/usr/bin/env node
/**
 * 恢复期遮罩 —— 「闪回第一页再回到当前页」的最终解法。
 *
 * 实测数据（不可回避的事实）：
 *   viewer:doc-set      目标=6
 *   +320ms  paint page=1    ← 用户此刻看到第 1 页
 *   +1522ms paint page=6    ← 这才到正确位置
 *
 * pdf.js 在 setDocument 之后必定先渲染第 1 页：那时页容器刚建出来、
 * 尺寸没量准，滚不动；目标页要等 1.2–1.6 秒。加页码、改顺序、
 * 提前滚动都试过，都改变不了「先画第 1 页」这件事。
 *
 * 所以做法变成不让用户看到中间态。这里守住几个关键点：
 *   ① 只在目标页 > 1 时遮（第 1 页本来就不用跳，遮了多此一举）
 *   ② 用 visibility 而不是 display:none（后者让容器塌成 0 高，
 *      pdf.js 算不出页尺寸，反而更糟）
 *   ③ 揭开判据是「目标页真的画出来」，不是「跳转成功」
 *      （跳转在 180ms 就完成，但那时 canvas 还没画，提前揭开会看到空白）
 *   ④ 必须有超时兜底（目标页可能永远画不出来，一直遮等于变砖）
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

/* ---------- ① CSS 用 visibility，且作用域正确 ---------- */

check('CSS 用 visibility 隐藏画布',
  /\.zr-pdfviewer-host\[data-restoring="1"\] \.zr-pdfviewer-container\{visibility:hidden\}/.test(src),
  'display:none 会让容器塌成 0 高，pdf.js 算不出页尺寸')

check('没有用 display:none 藏画布',
  !/data-restoring="1"\][^{]*\{[^}]*display:none/.test(src))
    check('恢复提示用伪元素（不额外插 DOM）',
  /data-restoring="1"\]::after\{content:/.test(src),
  'host.innerHTML 会被反复清空，普通子元素要跟着管，伪元素没有生命周期问题')

/* ---------- ② 只在目标页 > 1 时遮 ---------- */

const maskIdx = src.indexOf("host.dataset.restoring = '1'")
const condIdx = src.lastIndexOf('if (resumePage > 1 && host)', maskIdx)
check('设置了遮罩', maskIdx > 0)
check('只在目标页 > 1 时遮', condIdx > 0 && condIdx < maskIdx && maskIdx - condIdx < 200,
  '第 1 页本来就不用跳，遮一下反而让每次打开都白等')

check('不需要遮的时候会清掉标记',
  /delete host\?\.dataset\?\.restoring/.test(src))

/* ---------- ③ 揭开判据是「目标页画出来」 ---------- */

const prIdx = src.indexOf("eventBus.on('pagerendered'")
const unmaskInPr = src.indexOf('delete host.dataset.restoring', prIdx)
check('在 pagerendered 里揭开', unmaskInPr > prIdx && unmaskInPr - prIdx < 1200)

check('揭开要求页号等于目标页',
  /e\.pageNumber === want/.test(src),
  '不等目标页就揭开会看到空白（跳转 180ms 就完成，但 canvas 要 1.2s 后才画好）')

check('用 ref 存目标页（避开 TDZ）',
  /const resumeTargetRef = useRef\(0\)/.test(src),
  'pagerendered 监听注册在 resumePage 算出来之前，闭包引用会踩 TDZ')

/* ---------- ④ 超时兜底 ---------- */

check('有超时兜底', /timeout: true/.test(src),
  '目标页若永远画不出来，一直遮着等于让阅读器变砖')

check('兜底会清掉遮罩',
  /if \(host\?\.dataset\?\.restoring === '1'\) \{[\s\S]{0,200}?delete host\.dataset\.restoring/.test(src))

/* ---------- ⑤ 不破坏既有恢复流程 ---------- */

check('仍会设页码（遮罩不代替定位）', /viewer\.currentPageNumber = resumePage/.test(src))
check('仍会做几何滚动', /scrollPageIntoView\(host, resumePage, resumeOffset\)/.test(src))
check('遮罩有日志（能确认到底生效没有）', /event: 'viewer:restore-mask'/.test(src))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
