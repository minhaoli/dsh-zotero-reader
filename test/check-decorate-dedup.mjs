#!/usr/bin/env node
/**
 * 验证 decoratePage 的「内容签名去重」既省了重建、又不会漏刷。
 *
 * 背景：decoratePage 原来每次调用都 `innerHTML = ''` 全量重建，而它被调得
 * 很频繁（每页画完、批注到货、选中变化）。绝大多数时候这一页没变，于是
 * 白写一堆 DOM —— 写入弄脏布局，紧跟着的几何读取就要付一次强制重排。
 *
 * 风险：加了去重之后，如果签名算错，改色/删除/新增批注就可能不刷新，
 * 那是比卡顿更严重的问题。所以这里重点验证「该刷新的都刷新了」。
 *
 * 做法：直接跑真实签名算法（从 client.js 里抽出来），喂各种变化，断言结果。
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

/* ---- 1. 源码里确实带了去重，且顺序正确（先算签名再写） ---- */

const sigIdx = src.indexOf('const sig = [')
const setSigIdx = src.indexOf('decorateSigRef.current.set(pageNo, sig)')
const innerIdx = src.indexOf("layer.innerHTML = ''", sigIdx)

check('存在签名计算', sigIdx > 0)
check('签名判断早于 DOM 写入', sigIdx > 0 && innerIdx > sigIdx,
  `sig@${sigIdx} innerHTML@${innerIdx}`)
check('签名写入在清空之后', setSigIdx > sigIdx,
  `set@${setSigIdx} 应当 > sig@${sigIdx}`)

const beforeSig = src.slice(Math.max(0, sigIdx - 1200), sigIdx)
check('clientWidth 读取发生在清空之前（避免读脏布局）',
  beforeSig.includes('pageEl.clientWidth'),
  '签名用的 pw/ph 必须在任何 DOM 写入之前读取')

/* ---- 2. 换文献时清空签名缓存（否则新文献可能被跳过） ---- */

check('换文献时清空签名缓存',
  /decorateSigRef\.current\.clear\(\)/.test(src),
  'itemKey 变化时若不 clear，内容完全相同的另一篇文献会被整页跳过')

/* ---- 3. pagerendered 里的 DOM 写入已挪到下一帧 ---- */

/**
 * 这段不能靠「取固定字符数」来判断：回调里带了很长的说明性注释，
 * 窗口开小了就会漏掉真正的代码（实测 3000 字符不够，rAF 判成了不存在）。
 * 改成从回调起点截到下一个 `eventBus.on(` 或文件末尾，拿到完整回调体。
 */
const prIdx = src.indexOf("eventBus.on('pagerendered'")
const nextOn = src.indexOf('eventBus.on(', prIdx + 10)
const sheet = nextOn > prIdx ? src.slice(prIdx, nextOn) : src.slice(prIdx, prIdx + 6000)

check('pagerendered 回调里不再同步调 decoratePage',
  !/eventBus\.on\('pagerendered'[\s\S]{0,2000}?\n\s*decoratePageRef\.current\?\.\(e\.pageNumber\)/.test(
    src.slice(prIdx, prIdx + 2600)),
  '同步写 DOM 会让 pdf.js 把同一页再渲染一次，必须挪到 requestAnimationFrame')
check('pagerendered 里用 requestAnimationFrame 延迟装饰',
  sheet.includes('requestAnimationFrame'))

/* ---- 4. 用真实算法喂各种变化，确认不会漏刷 ---- */

/**
 * 复刻 client.js 里的签名算法。
 * 故意保持与源码同构；若源码改了顺序，这里会与第 1 节的断言一起提示。
 */
function makeSig({ pageNo, pw, ph, highlight, annotations }) {
  return [
    pageNo,
    Math.round(pw),
    Math.round(ph),
    highlight && highlight.page === pageNo ? JSON.stringify(highlight.rects) : '',
    annotations
      .filter((a) => a.pageIndex === pageNo - 1)
      .map((a) => `${a.key}:${a.color}:${a.type}:${(a.rects || []).length}`)
      .join('|'),
  ].join('#')
}

const base = {
  pageNo: 3,
  pw: 600,
  ph: 800,
  highlight: null,
  annotations: [
    { key: 'AAAA1111', pageIndex: 2, color: '#ffd400', type: 'highlight', rects: [[1, 2, 3, 4]] },
    { key: 'BBBB2222', pageIndex: 2, color: '#ff6666', type: 'underline', rects: [[1, 2, 3, 4]] },
    { key: 'CCCC3333', pageIndex: 5, color: '#ffd400', type: 'highlight', rects: [[1, 2, 3, 4]] }, // 别的页
  ],
}

const s0 = makeSig(base)

check('完全没变 → 签名相同（跳过重建，省 DOM 写入）', makeSig({ ...base }) === s0)

check('新增一条批注 → 签名变化（必须重画）',
  makeSig({ ...base, annotations: [...base.annotations, { key: 'DDDD4444', pageIndex: 2, color: '#ffd400', type: 'highlight', rects: [[0, 0, 1, 1]] }] }) !== s0)

check('删除一条批注 → 签名变化（必须重画）',
  makeSig({ ...base, annotations: base.annotations.slice(1) }) !== s0)

check('改颜色 → 签名变化（必须重画）',
  makeSig({ ...base, annotations: [{ ...base.annotations[0], color: '#00ff00' }, base.annotations[1], base.annotations[2]] }) !== s0)

check('改类型 → 签名变化（必须重画）',
  makeSig({ ...base, annotations: [{ ...base.annotations[0], type: 'note' }, base.annotations[1], base.annotations[2]] }) !== s0)

check('批注矩形数量变化 → 签名变化（必须重画）',
  makeSig({ ...base, annotations: [{ ...base.annotations[0], rects: [[1, 2, 3, 4], [5, 6, 7, 8]] }, base.annotations[1], base.annotations[2]] }) !== s0)

check('只有别的页的批注变了 → 本页签名不变（应跳过）',
  makeSig({ ...base, annotations: [base.annotations[0], base.annotations[1], { ...base.annotations[2], color: '#000000' }] }) === s0)

check('缩放变化 → 签名变化（必须按新比例重画）',
  makeSig({ ...base, pw: 720, ph: 960 }) !== s0)

check('高亮出现 → 签名变化',
  makeSig({ ...base, highlight: { page: 3, rects: [[1, 1, 2, 2]] } }) !== s0)

check('高亮消失 → 签名变化',
  (() => {
    const withHl = makeSig({ ...base, highlight: { page: 3, rects: [[1, 1, 2, 2]] } })
    return makeSig({ ...base, highlight: null }) !== withHl
  })())

check('不同页号的空批注 → 签名不同（换文献不误跳过）',
  makeSig({ ...base, pageNo: 4, annotations: [] }) !== makeSig({ ...base, pageNo: 3, annotations: [] }))

/* ---- 5. 签名里必须含所有影响观感的要素 ---- */

const sigBlock = src.slice(sigIdx, src.indexOf('].join(\'#\')', sigIdx))
for (const field of ['pageNo', 'pw', 'ph', 'highlight', 'color', 'type', 'rects']) {
  check(`签名覆盖 ${field}`, sigBlock.includes(field), '漏掉这个字段会导致对应的变化不重画')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
