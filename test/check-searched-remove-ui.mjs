/**
 * 回归护栏：「本次搜索」的勾选删除。
 *
 * 为什么需要：harness-render 只渲染默认 tab，走不到 `tab === 'searched'` 那个分支，
 * 所以那里的渲染期错误不会被冒烟测试抓到。
 *
 * 检查两类：
 *   A. 结构：勾选框 / 全选 / 删除按钮 / 说明文案 都在
 *   B. **语义**：不能让人以为在删 Zotero 文献（用户最容易误解的点）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSrc = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
const indexSrc = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}${detail ? '  — ' + detail : ''}`)
}

/* ---------------- 后端 ---------------- */
check('后端有 /searched/remove 路由', /sub === '\/searched\/remove' && method === 'POST'/.test(indexSrc))
check('按 keys 逐条过滤（不是整个清空）',
  /const after = before\.filter\(\(k\) => !wanted\.has\(k\)\)/.test(indexSrc))
check('删空时整条会话移除（不留空数组）',
  /after\.length === 0\) deps\.searched\.delete\(sessionId\)/.test(indexSrc))
check('落盘走 deps（handleRequest 在模块顶层，够不到闭包）',
  /deps\.persistSearched\(\)/.test(indexSrc))
// 只检查 handleRequest 内部（模块顶层函数，够不到闭包）。
// applyInner 里的裸 persistSearched() 是合法的，不能一起判死；
// 注释里举例提到函数名也不该算违规，所以先把注释剥掉。
const handleReqAt = indexSrc.indexOf('async function handleRequest')
const insideHandleRequest = (handleReqAt > 0 ? indexSrc.slice(handleReqAt) : '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
check('handleRequest 里不再裸调 persistSearched',
  insideHandleRequest.length > 0 && !/[^.\w]persistSearched\(\)/.test(insideHandleRequest),
  handleReqAt > 0 ? '' : 'handleRequest 未找到')
check('handleRequest 里不再裸调 reportHostDiag',
  insideHandleRequest.length > 0 && !/[^.\w]reportHostDiag\(/.test(insideHandleRequest))
check('/searched/clear 也落盘了',
  /sub === '\/searched\/clear'[\s\S]{0,600}deps\.persistSearched\(\)/.test(indexSrc))
check('返回 removed / left 计数',
  /removed: before\.length - after\.length/.test(indexSrc) && /left: after\.length/.test(indexSrc))

/* ---------------- 前端 ---------------- */
check('有勾选状态 pickedKeys', /const \[pickedKeys, setPickedKeys\]/.test(clientSrc))
check('有删除处理函数 removePicked', /const removePicked = useCallback/.test(clientSrc))
check('删完重新拉列表（以后端为准）',
  /removePicked[\s\S]{0,900}await load\('', 'searched'\)/.test(clientSrc))
check('删完清空选中态', /removePicked[\s\S]{0,700}setPickedKeys\(new Set\(\)\)/.test(clientSrc))
check('每条有复选框', /type: 'checkbox'[\s\S]{0,200}zr-item-check/.test(clientSrc)
  || /zr-item-check[\s\S]{0,300}type: 'checkbox'/.test(clientSrc))
check('勾选框不会触发打开 PDF', /zr-item-check[\s\S]{0,400}onClick: \(event\) => event\.stopPropagation\(\)/.test(clientSrc))
check('表头有全选框', /const togglePickAll/.test(clientSrc) && /onChange: togglePickAll/.test(clientSrc))
check('全选框支持半选（indeterminate）', /el\.indeterminate = somePicked/.test(clientSrc))
check('删除按钮显示选中数量', /searchedRemove: '从本次搜索移除 \(\{\{n\}\}\)'/.test(clientSrc))
check('删除按钮在 0 选中时禁用', /disabled: pickedCount === 0 \|\| removing/.test(clientSrc))
check('切 tab / 换搜索词时清空选中', /setPickedKeys\(new Set\(\)\)[\s\S]{0,120}\}, \[tab, debounced\]/.test(clientSrc))
check('searched 分支用的是专用渲染（不影响 library 树的 renderItem）',
  /state\.items\.map\(renderSearchedItem\)/.test(clientSrc))

/* ---------------- 语义：不能让人以为在删文献 ---------------- */
check('按钮文案点明「从本次搜索移除」', clientSrc.includes('从本次搜索移除'))
check('有明确的「不影响 Zotero 库」说明', clientSrc.includes('Zotero 库中的文献不受影响'))
check('按钮 tooltip 也说明只删记录', /searchedRemoveHint: '[^']*Zotero 库里的文献不会删除/.test(clientSrc))
check('没有沿用旧的「清空」措辞作为删除文案', !/searchedRemove: '[^']*清空/.test(clientSrc))

/* ---------------- 禁止碰的东西还在 ---------------- */
check('几何段仍在（inkTopFrac）', clientSrc.includes('inkTopFrac'))
check('几何段仍在（emPt）', clientSrc.includes('emPt'))
check('viewer.setDocument 仍在', clientSrc.includes('viewer.setDocument'))

const failed = results.filter((r) => !r.ok).length
console.log(failed === 0 ? '\n「本次搜索」勾选删除检查全部通过' : `\n${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
