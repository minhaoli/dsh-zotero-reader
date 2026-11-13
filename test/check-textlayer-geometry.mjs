import fs from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const file = 'C:/Users/30759/Zotero/storage/23UVLWSZ/Xu和Ge - 2018 - 人因学发展的新取向.pdf'
const scale = 1.15
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false }).promise
const page = await doc.getPage(1)
const viewport = page.getViewport({ scale })
const { items } = await page.getTextContent()

const boxes = []
for (const item of items) {
  if (typeof item.str !== 'string' || !item.str) continue
  const tx = pdfjs.Util.transform(viewport.transform, item.transform)
  const fontHeight = Math.hypot(tx[2], tx[3])
  boxes.push({
    str: item.str,
    left: tx[4],
    top: tx[5] - fontHeight,
    h: fontHeight,
    widthCss: item.width * scale,      // 前端用的公式
    widthRaw: item.width,              // 原始（文本空间）
  })
}

// 同一行的相邻块：左边 + 宽度 应≈下一块的左边
const gaps = []
const byLine = new Map()
for (const b of boxes) {
  const key = Math.round(b.top)
  if (!byLine.has(key)) byLine.set(key, [])
  byLine.get(key).push(b)
}
for (const [, line] of byLine) {
  line.sort((a, b) => a.left - b.left)
  for (let i = 1; i < line.length; i += 1) {
    const prev = line[i - 1]
    const gap = line[i].left - (prev.left + prev.widthCss)
    if (Math.abs(gap) < 400) gaps.push(gap)
  }
}
gaps.sort((a, b) => a - b)
const median = gaps[Math.floor(gaps.length / 2)]
const p90 = gaps[Math.floor(gaps.length * 0.9)]
console.log('同页文本块数', boxes.length, '  行内相邻对数', gaps.length)
console.log('间隙中位数 %s px，p90 %s px', median?.toFixed(2), p90?.toFixed(2))
console.log('样本（str | left | widthCss | 下一块 left）:')
const line0 = [...byLine.entries()].sort((a, b) => a[0] - b[0])[3]
for (const b of (line0?.[1] ?? []).slice(0, 4)) console.log('  %s | %s | %s', JSON.stringify(b.str.slice(0, 14)), b.left.toFixed(1), b.widthCss.toFixed(1))
doc.destroy?.()
