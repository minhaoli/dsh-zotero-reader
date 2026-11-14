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
/**
 * 守卫生效，但**只管首次加载**。
 *
 * 原断言要求 `if (!active) return` 原样存在，并且 active 必须在依赖里。
 * 后来发现那个组合会造成「切 tab → cleanup 销毁 pdf → 切回来重新下载」，
 * 用户看到先黑屏再刷新（日志：25 秒内 pdf:start 六次，reader:mount 一次）。
 * 所以两条断言都必须改，否则它们反而在保护 bug。
 *
 * 现在的正确形态：
 *   · 守卫是 `!active && !pdfRef.current` —— 没加载过才等可见；
 *   · active **不在**依赖里 —— 已加载的切走不销毁；
 *   · 补跑由单独的 wasActive 监听 effect 负责。
 */
check('effect 开头有守卫，且只在「未加载过」时拦（不销毁已加载的）',
  loadEffect.length > 600 && (() => {
    const guard = loadEffect.indexOf('if (!active && !pdfRef.current) return')
    const setLoading = loadEffect.indexOf("setStatus('loading')")
    return guard > 0 && setLoading > 0 && guard < setLoading
  })())

check('active 不在加载 effect 的依赖里（切 tab 不得销毁重建）',
  !/\},\s*\[itemKey,\s*reloadToken,\s*active\]/.test(src),
  '把 active 放回依赖会让切 tab 触发 cleanup：销毁 pdf 文档 + 清空 DOM，表现为黑屏后重新加载')

check('有 wasActive 监听负责「首次可见时补跑」',
  /wasActiveRef/.test(src) && /setReloadToken\(\(v\) => v \+ 1\)/.test(src),
  'active 移出依赖后，必须有人负责在首次可见时触发加载，否则一直是空的')

/* ---------- 3. 两个调用点都传了 active ---------- */
check('readPane 传 active: mode === \'read\'',
  /active:\s*mode === 'read'/.test(src))
check('PapersView 内传 active 且同时考虑 paneActive',
  /active:\s*key === active && paneActive/.test(src))
check('PapersView 接受 paneActive 参数',
  /function PapersView\(\{[^}]*paneActive/.test(src))
check('papersPane 按 tab 状态传入 paneActive',
  /paneActive:\s*tab === 'papers'/.test(src))

/* ---------- 4. 零尺寸不得 setDocument，且不得自旋 ---------- */
check('存在零尺寸守卫', /if\s*\(!sized \|\| container\.clientWidth === 0 \|\| container\.clientHeight === 0\)/.test(src))
/**
 * 区块按结构切到 setDocument 为止，不用固定字符窗口。
 *
 * 原来这两条断言写的是 `zeroSizeRetryRef.current < 8` 和
 * `zeroSizeRetryRef.current = 0` —— 它们把「自旋重来」当成了正确行为。
 * 实测日志（同一毫秒两条 pdf:start）：隐藏实例每轮重新下载 650KB、
 * 重新解析整篇 PDF，连着重来 9 次。所以断言要改成「只等、不自旋」。
 */
const zeroGuardIdx = src.indexOf('if (!sized || container.clientWidth === 0')
const zeroBlock = zeroGuardIdx > 0
  ? src.slice(zeroGuardIdx, src.indexOf('viewer.setDocument(pdf.doc)'))
  : ''
check('零尺寸区块已定位（负向断言的前提）', zeroBlock.length > 300)
check('零尺寸改为等 ResizeObserver，不再按次数自旋',
  /new ResizeObserver/.test(zeroBlock) && !/zeroSizeRetryRef/.test(src),
  '自旋每轮都要重新下载并解析整篇 PDF（实测连着重来 9 次）')
check('尺寸真正出现后触发一次重来', /setReloadToken\(\(v\) => v \+ 1\)/.test(zeroBlock))
check('零尺寸路径在 setDocument 之前返回',
  src.indexOf('viewer:defer-zero-size') < src.indexOf('viewer.setDocument(pdf.doc)'))

/* ---------- 4b. 数据 effect 在下载之前就挡住隐藏实例 ---------- */
check('尺寸闸门在取字节之前（隐藏实例根本不发请求）',
  src.indexOf('pdf:await-size') > 0 && src.indexOf('pdf:await-size') < src.indexOf("event: 'pdf:start'"))
check('等尺寸的观察者会随卸载断开', /sizeObserver\?\.disconnect\(\)/.test(src))

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
