#!/usr/bin/env node
/**
 * 关闭 pdf.js 文本层无障碍排序（这是最大单点开销）。
 *
 * 实测依据：一次打开里 #compareElementPositions 被调 113 次、累计 14.7 秒，
 * 占 longTask 的 53%。它做的唯一事情是给文本层 span 设 aria-owns
 * （屏幕阅读器按视觉顺序朗读），不影响画面、选词、高亮、批注、复制。
 *
 * 这里守住四个要点 —— 任何一个错了，要么白改，要么把阅读器弄坏：
 *   ① 必须在任何页绘制之前覆盖，否则第一批页已经排过序了
 *   ② 空壳必须满足 pdf.js 的全部调用，且 enable 不能抛
 *      （真实现在重复调用时抛 "already enabled"）
 *   ③ 用公开导出的 PDFPageView，而不是猜实例字段
 *   ④ 覆盖后要有日志，便于现场确认到底生效没有
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

/* ---------- 1. 覆盖存在且用公开导出 ---------- */

check('PDFPageView 被解构出来', /const \{[^}]*PDFPageView[^}]*\} = viewerMod/.test(src),
  '它是 pdf_viewer.mjs 公开导出的类，用它比猜实例字段可靠')
check('覆盖的是 PDFPageView.prototype.draw',
  /PDFPageView\.prototype\.draw = function patchedDraw/.test(src))
check('有幂等标记，避免重复包装', /__zrA11yPatched/.test(src),
  '重复包装会让 draw 层层嵌套，越用越慢')
check('包装里调用了原始 draw', /return origDraw\.apply\(this, args\)/.test(src),
  '不调原实现页面就画不出来')

/* ---------- 2. 时机：必须在 setDocument 之前 ---------- */

const patchIdx = src.indexOf('PDFPageView.prototype.draw = ')
const setDocIdx = src.indexOf('viewer.setDocument(pdf.doc)')
check('覆盖发生在 setDocument 之前',
  patchIdx > 0 && setDocIdx > patchIdx,
  `覆盖@${patchIdx} 必须早于 setDocument@${setDocIdx}，否则首批页已排过序`)

/**
 * 还要早于「页视图创建」。PDFViewer 在 setDocument 里建页，
 * 所以只要早于 setDocument 就够了。
 */
check('覆盖发生在 new PDFViewer 之后（原型已可用）',
  patchIdx > src.indexOf('new PDFViewer('))

/* ---------- 3. 空壳必须完整且安全 ---------- */

/**
 * 切片不能用「第一个右花括号」——空壳里 `setTextMapping() {}` 自带花括号，
 * 第一个 `}` 就把切片截断了，导致六项断言集体假失败（已经踩过一次）。
 * 改为取到 `let a11yPatched` 之前，跟着结构走。
 */
const stubStart = src.indexOf('const noopAccessibility = {')
const stubMarkerEnd = src.indexOf('let a11yPatched', stubStart)
const stub = stubStart > 0 && stubMarkerEnd > stubStart
  ? src.slice(stubStart, stubMarkerEnd)
  : ''

check('空壳已定义', stub.length > 50, `实际长度 ${stub.length}`)
check('空壳区块已完整定位（负向断言的前提）', stub.includes('moveElementInDOM'),
  '切片不完整时下面的六项断言会集体误报')

for (const m of ['setTextMapping', 'enable', 'disable', 'addPointerInTextLayer',
  'removePointerInTextLayer', 'moveElementInDOM']) {
  check(`空壳实现 ${m}`, new RegExp(`${m}\\s*\\(`).test(stub),
    'pdf.js 会调用它，缺一个就抛 TypeError')
}

/**
 * enable() 必须是什么都不做。真实现重复调用会抛
 * "TextAccessibilityManager is already enabled."，空壳若转发就炸。
 */
check('空壳 enable 不抛错（不转发给真实现）',
  /enable\s*\(\)\s*\{\s*\}/.test(stub),
  '真实现的 enable 重复调用会抛 already enabled')

check('addPointerInTextLayer 返回 null',
  /addPointerInTextLayer\s*\(\)\s*\{\s*return null\s*\}/.test(stub),
  '它要有返回值，调用方会用它判断 parent')

/* ---------- 4. 判定条件用 == null（覆盖 null 与 undefined） ---------- */

check('注入条件是 == null 而不是 === null',
  /_accessibilityManager == null/.test(src),
  'pdf.js 里该字段初始可能是 undefined，用 === null 会漏掉')

/* ---------- 5. 有日志便于确认生效 ---------- */

check('成功时有日志', /event: 'viewer:a11y-disabled',\s*patched/.test(src))
check('失败时有日志（不静默吞掉）', /viewer:a11y-disable-failed/.test(src),
  '覆盖失败只是慢回去，但必须能从日志看出来，否则下次又白查')

/* ---------- 6. 不该碰的功能：确认没顺手禁掉别的东西 ---------- */

check('没有禁掉 highlighter', !/highlighter.*=\s*null/.test(src.slice(patchIdx - 400, patchIdx + 200)))
check('没有改动 textLayerMode', !/textLayerMode\s*:/.test(src),
  '关文本层会连带废掉选词与高亮，那是另一回事')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
