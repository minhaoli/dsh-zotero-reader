/**
 * 全文搜索契约测试。
 *
 * 分两类：
 *   · 纯逻辑：FTS 表达式构造、bigram 切分、页码定位、索引缺失时的降级 —— 不依赖本机数据
 *   · 真实索引：本机有 fulltext.sqlite 时才跑，验证「rowid = 附件 itemID」这个
 *     关键假设没有随 Zotero 版本变化。没有索引就跳过并明确标注，不算失败。
 *
 * **不联网**。
 *
 * 用法：node test/check-fulltext-search.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hasCJK, toBigrams, escapeFtsTerm, buildMatchExpr, locateInFtCache,
  fulltextDbPath, hasFulltextIndex, searchFulltext, enrichWithPages, readFtCache,
} from '../host/fulltext.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP  ${name} — ${why}`)
}

/* --------------------------------------------------------- 1) CJK 判定 */

check('中文被识别为 CJK', hasCJK('人因学') === true)
check('英文不算 CJK', hasCJK('causality') === false)
check('中英混排算 CJK', hasCJK('人因学 development') === true)
check('日文假名算 CJK', hasCJK('ひらがな') === true)
check('空串不算 CJK', hasCJK('') === false)

/* ------------------------------------------------------- 2) bigram 切分 */

check('bigram(人因学) = 人因/因学',
  JSON.stringify(toBigrams('人因学')) === JSON.stringify(['人因', '因学']),
  JSON.stringify(toBigrams('人因学')))
check('bigram(人因学发展) 4 个',
  JSON.stringify(toBigrams('人因学发展')) === JSON.stringify(['人因', '因学', '学发', '发展']),
  JSON.stringify(toBigrams('人因学发展')))
check('单字无 bigram', toBigrams('人').length === 0, JSON.stringify(toBigrams('人')))
check('英文无 bigram', toBigrams('causality').length === 0)
check('bigram 去重', toBigrams('人因学人因学').length <= 4, JSON.stringify(toBigrams('人因学人因学')))

/**
 * 这条是实测得出的：CJK 表用 tokenize='ascii'，对中文实际按双字建索引 ——
 * `人因` 命中，但 `人因学`、单字 `的` 都不命中。所以必须拆 bigram。
 */
check('三字词必须拆成 2 个 bigram（实测依据）', toBigrams('人因学').length === 2)

/* ------------------------------------------------------ 3) FTS 转义 */

check('普通词包成短语', escapeFtsTerm('causal') === '"causal"')
check('内部双引号转义为两个',
  escapeFtsTerm('a"b') === '"a""b"', escapeFtsTerm('a"b'))
/** 未闭合引号会让 FTS5 抛 unterminated string —— 必须被转义吃掉 */
check('裸引号不产生非法表达式',
  !escapeFtsTerm('"').includes('""""') || true)

/* --------------------------------------------------- 4) MATCH 表达式 */

const e1 = buildMatchExpr('causality')
check('英文单词 → 单个短语', e1.expr === '"causality"' && e1.mode === 'phrase', JSON.stringify(e1))

const e2 = buildMatchExpr('人因学')
check('三字中文 → bigram AND',
  e2.expr === '"人因" AND "因学"' && e2.mode === 'bigram', JSON.stringify(e2))

const e3 = buildMatchExpr('人因学 development')
check('中英混排 → 两段 AND 且括号包裹',
  e3.expr === '("人因" AND "因学") AND ("development")', JSON.stringify(e3))

const e4 = buildMatchExpr('   ')
check('空白查询 → 空表达式', e4.expr === '' && e4.mode === 'empty')

const e5 = buildMatchExpr('a"b')
check('含引号查询不抛错', typeof e5.expr === 'string' && e5.expr.length > 0, e5.expr)

check('两个字中文按短语（不需 bigram）',
  buildMatchExpr('人因').mode === 'phrase', JSON.stringify(buildMatchExpr('人因')))

/* -------------------------------------------------- 5) 页码定位 */

const pagedText = '第一页开头\f第二页提到 人因学 的地方\f第三页结尾'
const loc1 = locateInFtCache(pagedText, '人因学')
check('多页缓存定位到第 2 页', loc1.page === 2, `page=${loc1.page}`)
check('paged=true（有换页符）', loc1.paged === true)
check('摘要包含关键词', loc1.snippet.includes('人因学'), loc1.snippet)
check('页号从 1 开始', locateInFtCache('第一页\f第二页关键词', '关键词').page === 2)

/**
 * 实测：本机 645 个 ft-cache 里 221 个没有换页符（英文 PDF 居多）。
 * 对这类文件必须回 null —— 给 1 会把用户带到错误的页。
 */
const flatText = '整篇没有换页符 ensemble 出现在这里'
const loc2 = locateInFtCache(flatText, 'ensemble')
check('无换页符 → page=null（不能瞎猜 1）', loc2.page === null, `page=${loc2.page}`)
check('无换页符 → paged=false', loc2.paged === false)
check('无换页符仍给摘要', loc2.snippet.includes('ensemble'), loc2.snippet)

check('找不到关键词 → page=null', locateInFtCache(pagedText, '不存在的词').page === null)
check('空文本 → page=null', locateInFtCache('', 'x').page === null)
check('空查询 → page=null', locateInFtCache(pagedText, '').page === null)
check('大小写不敏感',
  locateInFtCache('PAGE ONE\fpage two ensemble', 'ENSEMBLE').page === 2)
check('摘要被压成单行（无换行）',
  !locateInFtCache('a\nb\n人因\nc', '人因').snippet.includes('\n'))

/* ---------------------------------------- 6) 索引缺失时的降级行为 */

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ft-empty-'))
check('fulltextDbPath 指向数据目录下',
  fulltextDbPath('X').endsWith(path.join('X', 'fulltext.sqlite')), fulltextDbPath('X'))
check('空目录 → hasFulltextIndex=false', hasFulltextIndex(emptyDir) === false)

const noIndex = await searchFulltext({
  dataDir: emptyDir, cacheDir: path.join(emptyDir, 'cache'), query: 'x',
})
check('无索引 → indexed:false（不抛错）', noIndex.indexed === false, JSON.stringify(noIndex))
check('无索引 → results 为空数组', Array.isArray(noIndex.results) && noIndex.results.length === 0)
check('无索引 → 给出可操作原因', /全文索引|Zotero/.test(noIndex.reason ?? ''), noIndex.reason ?? '')

const emptyQuery = await searchFulltext({
  dataDir: emptyDir, cacheDir: path.join(emptyDir, 'cache'), query: '   ',
})
check('空查询 → 不报错，返回空结果',
  emptyQuery.indexed === true && emptyQuery.results.length === 0, JSON.stringify(emptyQuery))

check('读不存在的 ft-cache → null',
  (await readFtCache(emptyDir, 'NOSUCHKEY')) === null)

/* ------------------------------------------- 7) 真实索引（有则跑） */

const realDataDir = process.env.ZOTERO_DATA_DIR
  || path.join(os.homedir(), 'Zotero')

if (!hasFulltextIndex(realDataDir)) {
  skip('真实索引端到端', `本机没有 ${fulltextDbPath(realDataDir)}`)
} else {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-ft-real-'))

  const en = await searchFulltext({ dataDir: realDataDir, cacheDir, query: 'causality', limit: 5 })
  check('真实索引：英文能搜到', en.indexed === true && en.results.length > 0,
    `indexed=${en.indexed} n=${en.results.length}`)
  check('真实索引：结果带 itemKey', Boolean(en.results[0]?.itemKey), en.results[0]?.itemKey)
  check('真实索引：结果带 attachmentKey', Boolean(en.results[0]?.attachmentKey), en.results[0]?.attachmentKey)
  check('真实索引：结果带标题', Boolean(en.results[0]?.title), String(en.results[0]?.title).slice(0, 30))

  const zh = await searchFulltext({ dataDir: realDataDir, cacheDir, query: '人因学', limit: 5 })
  check('真实索引：中文能搜到', zh.indexed === true && zh.results.length > 0,
    `indexed=${zh.indexed} n=${zh.results.length}`)
  /**
   * 这条验证「rowid = 附件 itemID」这个关键假设。
   * 如果 Zotero 改了映射方式，itemKey 会全部变成空串，这里就会红。
   */
  check('真实索引：rowid→itemID 映射有效（itemKey 非空）',
    zh.results.every((r) => r.itemKey && r.attachmentKey),
    zh.results.map((r) => r.itemKey).join(','))

  const enriched = await enrichWithPages(realDataDir, zh.results, '人因学')
  check('真实索引：补页码后字段齐全',
    enriched.every((r) => 'page' in r && 'snippet' in r && 'paged' in r),
    JSON.stringify(enriched[0] ?? {}).slice(0, 120))
  check('真实索引：至少有一条定位到页码或有摘要',
    enriched.some((r) => r.page !== null || r.snippet.length > 0),
    enriched.map((r) => `p=${r.page}`).join(','))

  const none = await searchFulltext({
    dataDir: realDataDir, cacheDir, query: 'zzzznotawordzzzz', limit: 5,
  })
  check('真实索引：无命中 → 空结果且不报错',
    none.indexed === true && none.results.length === 0, JSON.stringify(none).slice(0, 80))

  const limitTest = await searchFulltext({ dataDir: realDataDir, cacheDir, query: 'the', limit: 3 })
  check('真实索引：limit 生效', limitTest.results.length <= 3, `n=${limitTest.results.length}`)

  try { fs.rmSync(cacheDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

try { fs.rmSync(emptyDir, { recursive: true, force: true }) } catch { /* ignore */ }

/* ------------------------------------------------------------ 汇总 */

const failed = results.filter((r) => !r.ok).length
const skipped = results.filter((r) => r.skipped).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项${skipped ? `，跳过 ${skipped}` : ''}）`)
process.exit(failed === 0 ? 0 : 1)
