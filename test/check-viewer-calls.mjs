/**
 * 回归护栏：检查「关键调用是否还在」。
 *
 * 起因：清理 pdf.js 编辑器链路时用脚本按行切片，切多了两行，
 * 把 viewer.setDocument 一起删了 —— 而它是页面渲染的唯一入口。
 * 这类「删掉一个必需调用」不会报错，只会静默不工作，所以用清单兜住。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/** [说明, 必须出现的片段] */
const REQUIRED = [
  ['创建 PDFViewer', 'new PDFViewer'],
  ['把 viewer 交给 linkService', 'linkService.setViewer(viewer)'],
  ['把文档交给 viewer（渲染前置，缺了整页不画）', 'viewer.setDocument(pdf.doc)'],
  ['把文档交给 linkService', 'linkService.setDocument(pdf.doc, null)'],
  ['页码变化回填 state', "eventBus.on('pagechanging'"],
  ['缩放变化回填 state', "eventBus.on('scalechanging'"],
  ['页面画完叠批注', "eventBus.on('pagerendered'"],
  ['首屏贴合栏宽', 'currentScaleValue'],
  ['首屏强制渲染第一页', 'viewer.currentPageNumber'],
  ['触发一次重排', 'viewer.update'],
  ['批注写入后重绘浮层', 'decoratePage('],
  ['批注写入唯一出口', 'const writeAnnotation'],
  ['便签落点', 'const addNoteAtPoint'],
]

let bad = 0
for (const [label, needle] of REQUIRED) {
  const ok = src.includes(needle)
  if (!ok) bad += 1
  console.log((ok ? 'OK   ' : 'MISS ') + label + '  (' + needle + ')')
}
console.log(bad === 0 ? '\n关键调用清单全部命中' : `\n缺失 ${bad} 项`)
process.exitCode = bad === 0 ? 0 : 1
