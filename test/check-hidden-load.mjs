/**
 * 隐藏态不加载 PDF / 零尺寸不 setDocument。
 *
 * 锁住的是一个「重启后加载很久、然后跳回第 1 页」的具体 bug，两个现象同源：
 *
 *   1. 右栏用 display:none 保活，PaperView 在隐藏时照常挂载并开跑加载链路。
 *      隐藏容器 clientWidth/clientHeight 都是 0，waitForSize() 白等到超时
 *      （实测 pdf:ready → viewer:before-setdoc 之间空了 4.8 秒）。
 *   2. 等不到尺寸仍照常 setDocument。pdf.js 在 0×0 容器里建不出 .page，
 *      `viewer.currentPageNumber = n` 被静默丢弃，12 次重试全失败
 *      （日志 want:3 got:1 attempts:13 ok:false），最终停在第一页。
 *
 * 约束：
 *   · PaperView 必须有 active 开关，不可见时不发起加载；
 *   · 两个调用点都要把可见性传下去；
 *   · 零尺寸不得 setDocument，要退回并限次重来。
 *
 * 跑法：node test/check-hidden-load.mjs
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failed = 0
function check(label, ok) {
  if (ok) console.log(`OK   ${label}`)
  else { console.log(`FAIL ${label}`); failed += 1 }
}

/* ---------- 1. PaperView 接受 active ---------- */
check('PaperView 定义带 active 参数（默认 true）',
  /function PaperView\(\{[^}]*active\s*=\s*true/.test(src))

/* ---------- 2. 加载 effect 有 active 守卫 ---------- */
const loadEffectStart = src.indexOf('/* ---------- 加载 PDF ---------- */')
check('找得到加载 PDF 的 effect', loadEffectStart > 0)
/**
 * 窗口取到「下一个 effect 边界」为止，而不是固定字符数。
 *
 * 这里踩过一次：守卫上方有一大段说明注释，按 600 字符切会切不到守卫，
 * 于是断言假失败。用结构边界（下一个 setStatus('loading') 之后足够远，
 * 或干脆找到 if (!active) 自己）才稳。
 */
const loadEffect = loadEffectStart > 0 ? src.slice(loadEffectStart, loadEffectStart + 3000) : ''
check('加载 effect 区块已定位（负向断言的前提）', loadEffect.length > 600)
check('effect 开头就有 if (!active) 守卫（在 setStatus 之前）',
  loadEffect.length > 600 && (() => {
    const guard = loadEffect.indexOf('if (!active) return')
    const setLoading = loadEffect.indexOf("setStatus('loading')")
    return guard > 0 && setLoading > 0 && guard < setLoading
  })())
check('active 在依赖数组里（隐藏→显示会重新加载）',
  /\},\s*\[itemKey,\s*reloadToken,\s*active\]/.test(src))

/* ---------- 3. 两个调用点都传了 active ---------- */
check('readPane 传 active: mode === \'read\'',
  /active:\s*mode === 'read'/.test(src))
check('PapersView 内传 active 且同时考虑 paneActive',
  /active:\s*key === active && paneActive/.test(src))
check('PapersView 接受 paneActive 参数',
  /function PapersView\(\{[^}]*paneActive/.test(src))
check('papersPane 按 tab 状态传入 paneActive',
  /paneActive:\s*tab === 'papers'/.test(src))

/* ---------- 4. 零尺寸不得 setDocument ---------- */
check('存在零尺寸守卫', /if\s*\(!sized \|\| container\.clientWidth === 0 \|\| container\.clientHeight === 0\)/.test(src))
check('零尺寸会退回并重来（自增 reloadToken）',
  /viewer:defer-zero-size[\s\S]{0,700}?setReloadToken\(\(v\) => v \+ 1\)/.test(src))
check('零尺寸路径在 setDocument 之前返回',
  src.indexOf('viewer:defer-zero-size') < src.indexOf('viewer.setDocument(pdf.doc)'))
check('重试有上限，不会无限自旋',
  /zeroSizeRetryRef\.current < 8/.test(src))
check('拿到尺寸后重试计数归零',
  /zeroSizeRetryRef\.current = 0/.test(src))

/* ---------- 5. waitForSize 不再长等 ---------- */
check('waitForSize 上限已收紧到 90 帧',
  /frames > 90/.test(src))
check('旧的 180 帧长等已移除',
  !/frames > 180/.test(src))

/* ---------- 6. 既有行为不受影响 ---------- */
check('setDocument 仍只调用一次', (src.match(/viewer\.setDocument/g) ?? []).length === 1)
check('恢复阅读位置仍读 localStorage',
  /readSavedPos\(itemKey, pdf\.doc\.numPages\)/.test(src))
check('仍会恢复页码',
  /const resumePage = savedPos\?\.page \?\? 1/.test(src))

console.log(failed === 0 ? '\n===== 全部通过 =====' : `\n===== ${failed} 项失败 =====`)
process.exit(failed === 0 ? 0 : 1)
