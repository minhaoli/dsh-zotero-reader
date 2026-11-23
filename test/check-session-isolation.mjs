/**
 * 静态检查：切换会话时「已打开的 PDF」必须各看各的。
 *
 * 这个 bug 的表现是「会话 1 打开 pdf1-2-3，切到会话 2，右栏还是 pdf1-2-3」。
 * 根因不是某一行写错，而是**数据结构**：
 *   · 模块级单例 `openedState = { keys, active, titles, listeners }` 被所有会话共写，
 *     谁后写谁赢；
 *   · `tab 类型注册` 用了 `keepMounted: true`（切走不卸载，免得回来重载 PDF），
 *     所以切换会话时旧会话的面板**还活着**，两个会话确实同时在读写同一个对象。
 *
 * 因此下面这些断言检查的都是「结构」而不是「行为」——行为要靠浏览器里切会话才看得到，
 * 而结构错了行为必错。判据保守，只报确定的：
 *
 *   A. 模块级单例 `const openedState = { keys: ... }` 必须不存在；
 *   B. 必须存在按 sessionId 分桶的 Map；
 *   C. `openedAdd` / `openedActivate` / `openedRemove` / `openedTitle` 的形参
 *      必须以 sessionId 开头（第一个参数是桶的键）；
 *   D. `openedSubscribe` 必须收 sessionId（否则 A 的改动会唤醒 B 的面板）；
 *   E. localStorage 钥匙必须按 sessionId 生成，空会话回退到 `default`；
 *   F. `keepMounted: true` 必须**保留**——它和分桶是两件事，改掉它会引入
 *      「切回 tab 黑屏重载 PDF」的老问题；
 *   G. `zotero-reader:open` 事件必须带 sessionId，且监听方按 sessionId 过滤。
 */
import fs from 'node:fs'

const file = process.argv[2] ?? 'client.js'
const src = fs.readFileSync(file, 'utf8')

let failed = 0
function check(name, ok, hint) {
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL ${name}`)
  if (hint) console.log(`       → ${hint}`)
}

console.log('=== 目标文件 ===')
console.log(' ', file)
console.log('')

/* ---- A. 模块级单例必须消灭 ---------------------------------------------- */
console.log('=== A. 不再有共享的 openedState 单例 ===')
check(
  '不存在 `const openedState = { keys: ...`',
  !/const\s+openedState\s*=\s*\{[^}]*\bkeys\s*:/.test(src),
  '所有会话共写一个对象就是本 bug 的根因，必须整体换成分桶结构',
)
check(
  '不存在「当前桶」变量 openedSession',
  !/^\s*(?:let|const)\s+openedSession\s*=/m.test(src),
  '「当前桶」假定同一时刻只有一个会话在用这份状态，而 keepMounted 让两个面板同时活着',
)

/* ---- B. 分桶 Map 必须存在 ---------------------------------------------- */
console.log('\n=== B. 按 sessionId 分桶 ===')
check(
  '存在 openedBySession 这个 Map',
  /const\s+openedBySession\s*=\s*new\s+Map\s*\(/.test(src),
  '需要一个 sessionId -> { keys, active, titles } 的 Map',
)
check(
  '存在取桶函数，且以 sessionId 为键',
  /function\s+openedBucket\s*\(\s*sessionId\s*\)/.test(src)
    && /openedBySession\.get\(\s*sid\s*\)/.test(src),
  'openedBucket(sessionId) 必须按会话取桶，而不是取「当前桶」',
)
check(
  '订阅表按 sessionId 分开',
  /const\s+openedListeners\s*=\s*new\s+Map\s*\(/.test(src)
    && /openedListeners\.get\(\s*openedSid\(\s*sessionId\s*\)\s*\)/.test(src),
  '订阅表若全局共用，A 的改动会把 B 的面板也唤醒',
)

/* ---- C. 写操作必须显式带 sessionId -------------------------------------- */
console.log('\n=== C. 所有写操作显式带 sessionId ===')
for (const fn of ['openedAdd', 'openedActivate', 'openedRemove', 'openedTitle']) {
  check(
    `${fn} 的第一个形参是 sessionId`,
    new RegExp(`function\\s+${fn}\\s*\\(\\s*sessionId\\s*,`).test(src),
    '老签名从「当前桶」猜会话，切到新会话那一刻正好会猜错',
  )
}

/* ---- D. 订阅必须带 sessionId ------------------------------------------- */
console.log('\n=== D. 订阅按会话投递 ===')
check(
  'openedSubscribe 收 sessionId 作为第一个形参',
  /function\s+openedSubscribe\s*\(\s*sessionId\s*,/.test(src),
  '订阅全局 = 会话 B 的改动重渲染会话 A 的面板',
)
check(
  'PapersView 订阅时传了自己的 sessionId',
  /openedSubscribe\(\s*sessionId\s*,/.test(src),
  'PapersView 应该只订阅自己那个会话',
)

/* ---- E. localStorage 钥匙按会话分开 ------------------------------------ */
console.log('\n=== E. 每个会话一把 localStorage 钥匙 ===')
check(
  'openedStorageKey 以 sessionId 为参数',
  /function\s+openedStorageKey\s*\(\s*sessionId\s*\)/.test(src),
  '读写共用一把钥匙就会互相覆盖',
)
check(
  '空 sessionId 回退到 default 段（兼容历史数据）',
  /dsh-zotero-reader:opened:\$\{[\w.]*openedSid\(\s*sessionId\s*\)\s*\|\|\s*'default'\}/.test(src),
  '保持 `...:opened:default`，否则老数据读不到',
)

/* ---- F. keepMounted 必须保留 ------------------------------------------ */
console.log('\n=== F. keepMounted 保留（与分桶共存） ===')
/**
 * 必须锚定在 `tabs.register({ ... })` 那个块里，不能全文件搜 `keepMounted: true`
 * ——注释里也写着这两个词（解释为什么要保留它），全文件搜会把「注释还在、
 * 实际已改掉」误判成通过。负向验证时正是这样漏过了一次。
 */
const registerAt = src.indexOf('tabs.register({')
const registerBlock = registerAt > 0 ? src.slice(registerAt, registerAt + 800) : ''
check('已定位 tab 注册块（负向断言的前提）', registerBlock.includes('id: TAB_KEY'))
check(
  'tab 注册块里仍然 keepMounted: true',
  /^\s*keepMounted:\s*true\s*,/m.test(registerBlock),
  '改掉它会回到「切走再切回来 PDF 重载/黑屏」的老问题；隔离靠分桶，不靠卸载',
)

/* ---- G. 打开事件必须按会话投递 ----------------------------------------- */
console.log('\n=== G. zotero-reader:open 事件带 sessionId ===')
check(
  '派发事件时带上 sessionId',
  /new\s+CustomEvent\(\s*'zotero-reader:open'[\s\S]{0,200}sessionId/.test(src),
  '不带 sessionId 时，display:none 里的旧会话面板也会响应',
)
check(
  '监听方按 sessionId 过滤事件',
  /detail\?\.sessionId[\s\S]{0,200}String\(\s*sessionId\s*\?\?\s*''\s*\)/.test(src),
  '事件是 document 上全局派发的，不过滤就把别人的 PDF 塞进自己的阅读区',
)

/* ---- 汇总 -------------------------------------------------------------- */
console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败：会话隔离不成立，切会话时 PDF 列表会串。`)
  process.exit(1)
}
console.log('✓ 全部通过：已打开的 PDF 按会话分桶，两个面板同时挂载也互不影响。')
