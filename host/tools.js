/**
 * Zotero 伴读的模型侧工具。
 *
 * 三个工具构成「搜 → 读 → 问」的最小闭环，插件自己**不存任何文献列表**：
 * 每次 search 都现读 Zotero 本地库，所以用户在 Zotero 里新加的文献下一次就能搜到。
 *
 * 回答里的页码与 key 是这套东西的关键：
 *   · 工具返回 itemKey，提示模型写成 `zotero://<key>` → 前端渲染成「打开阅读」。
 *   · 工具返回页码 → 前端把「第 N 页」渲染成可点击跳转并高亮。
 * 插件不拦截、不改写会话消息，只靠约定好的文本形态，前端按正则识别即可。
 */
import { defineTool } from './define-tool.js'
import { summarizeItem } from './zotero.js'
import { searchChunks } from './pdf.js'

const ITEM_KEY_DOC =
  'itemKey 是 Zotero 的 8 位条目 key。回答里引用某篇文献时，把它写成 zotero://<itemKey> 的形式'
  + '（例如 zotero://ABCD1234），前端会渲染成可点击的「打开阅读」入口。'

const pageWord = (approx) => (approx ? '约第 N 页' : '第 N 页')

/** 搜库。 */
export function searchTool(getLibrary, hooks = {}) {
  return defineTool({
    name: 'search_zotero_library',
    description:
      '搜索本机 Zotero 文献库里的论文，返回带 itemKey 的条目。'
      + '用户让你找文献、问「我库里有没有 X」「有哪些讲 Y 的论文」时用它。'
      + '数据来自 Zotero 本地库本身（不是联网搜索），因此只返回用户真正收藏的文献。'
      + `引用结果时把 key 写成 zotero://<itemKey>，用户点一下就能在右侧栏读原文。${ITEM_KEY_DOC}`,
    parameters: {
      query: { type: 'string', description: '关键词，匹配标题、摘要、作者、期刊、专题。留空则返回最近修改的文献。' },
      collection: { type: 'string', description: '只在某个 Zotero 专题（collection 名称，可只写一部分）内搜索。' },
      limit: { type: 'integer', description: '返回条数，默认 20，最多 50。', minimum: 1, maximum: 50 },
      requirePdf: { type: 'boolean', description: '只返回带本地 PDF 的文献，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer', required: true, description: '命中总数（未截断前）。' },
          items: {
            type: 'array',
            required: true,
            description: '命中的文献。',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', required: true, description: 'Zotero itemKey，写成 zotero://<key> 引用。' },
                title: { type: 'string', required: true },
                authors: { type: 'array', required: true, items: { type: 'string' } },
                year: { type: 'string', required: true },
                publication: { type: 'string' },
                collections: { type: 'array', items: { type: 'string' } },
                hasPdf: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.items.length === 0) {
          return [{ type: 'text', text: 'Zotero 库里没有匹配的文献。' }]
        }
        const lines = value.items.map((item) => {
          const meta = [item.authors.slice(0, 3).join(', '), item.year, item.publication].filter(Boolean).join(' · ')
          return `- [${item.title}](zotero://${item.key})${meta ? ` — ${meta}` : ''}`
        })
        return [{
          type: 'text',
          text: `在 Zotero 库里找到 ${value.total} 篇，显示前 ${value.items.length} 篇：\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args = {}, exec) {
      const lib = await getLibrary()
      let items = lib.items
      if (args.requirePdf !== false) items = items.filter((x) => x.pdfPath)
      if (args.collection) {
        const wanted = String(args.collection).toLowerCase()
        items = items.filter((x) => x.collections.some((c) => c.toLowerCase().includes(wanted)))
      }
      const query = String(args.query ?? '').trim()
      if (query) {
        const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
        items = items.filter((item) => {
          const hay = `${item.title} ${item.abstract} ${item.publication} ${item.creators.join(' ')} ${item.collections.join(' ')}`.toLowerCase()
          return terms.every((t) => hay.includes(t))
        })
      }
      const limit = args.limit ?? 20
      const picked = items.slice(0, limit)
      /**
       * 记进本会话的「搜过的文章」清单（右侧栏那个 tab 读它）。
       *
       * 会话身份在 `exec.agent.id`，不是 `exec.sessionId` —— 后者不存在
       * （实测 exec 的字段是 token/callId/rootCallId/name/signal/agent/…，
       *  `sessionId` 为 undefined）。用错地方会让清单永远记在 undefined 下，
       * 前端怎么查都是空的。
       */
      const sessionId = exec?.sessionId ?? exec?.agent?.id ?? exec?.agent?.session?.id
      hooks.onHits?.(sessionId, picked.map((item) => item.itemKey))
      return {
        total: items.length,
        items: picked.map((item) => ({
          ...summarizeItem(item),
          authors: item.creators.slice(0, 6),
        })),
      }
    },
  })
}

/** 读正文（按页 / 按关键词 / 从开头读）。 */
export function readTool({ findItem, documentOf }) {
  return defineTool({
    name: 'read_zotero_paper',
    description:
      '读取 Zotero 某篇论文的正文（带页码）。回答要引用具体内容时先调用它，然后在回答里用「第 N 页」标注出处，'
      + '前端会把页码渲染成可点击的跳转。可以对同一篇多次调用以读不同部分：'
      + '先用 query 定位相关段落，需要上下文时再用 page 读整页。'
      + '扫描件会自动走 MinerU；也可用 useMineru 强制。',
    parameters: {
      itemKey: { type: 'string', required: true, description: 'Zotero 条目的 8 位 key。' },
      query: { type: 'string', description: '要查找的内容关键词。给了就只返回最相关片段（省上下文）。' },
      page: { type: 'integer', description: '只读某一页（从 1 开始）。', minimum: 1 },
      maxChars: { type: 'integer', description: '返回正文字符上限，默认 12000。', minimum: 1000, maximum: 40000 },
      useMineru: { type: 'boolean', description: '强制用 MinerU 解析（扫描件、公式多时有用）。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', required: true },
          pageCount: { type: 'integer', required: true },
          source: { type: 'string', required: true, description: 'pdf-text / mineru-local / mineru-cloud' },
          pageNumbersApproximate: { type: 'string', description: '存在即表示页码是估算值。' },
          outline: { type: 'array', items: { type: 'object' } },
          pages: { type: 'array', description: '按页正文。', items: { type: 'object' } },
          matches: { type: 'array', description: '按关键词检索到的片段。', items: { type: 'object' } },
          page: { type: 'integer' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          hint: { type: 'string' },
          mineruError: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const approx = Boolean(value.pageNumbersApproximate)
        const head = `《${value.title}》共 ${value.pageCount} 页（来源：${value.source}）`
        if (typeof value.page === 'number') {
          return [{ type: 'text', text: `${head}\n\n${pageWord(approx).replace('N', String(value.page))}\n${value.text}` }]
        }
        if (Array.isArray(value.matches)) {
          const body = value.matches
            .map((m) => `【${pageWord(approx).replace('N', String(m.page))}】${m.text}`)
            .join('\n\n')
          return [{ type: 'text', text: `${head}\n\n${body}` }]
        }
        const body = (value.pages ?? [])
          .map((p) => `【${pageWord(approx).replace('N', String(p.page))}】${p.text}`)
          .join('\n\n')
        return [{ type: 'text', text: `${head}\n\n${body}${value.truncated ? '\n\n（已截断，用 query 或 page 继续读）' : ''}` }]
      },
    },
    async execute(args = {}) {
      const item = await findItem(String(args.itemKey ?? ''))
      const doc = await documentOf(item, { forceMineru: args.useMineru === true })
      const head = {
        itemKey: item.itemKey,
        title: item.title,
        authors: item.creators.slice(0, 8),
        year: item.year,
        publication: item.publication,
        pageCount: doc.pageCount,
        source: doc.source,
        ...(doc.approxPages
          ? { pageNumbersApproximate: '本文件经 MinerU 重排，没有精确页码；引用时说「约第 N 页」。' }
          : {}),
        ...(doc.mineruError ? { mineruError: doc.mineruError } : {}),
      }

      if (typeof args.page === 'number' && args.page >= 1) {
        const page = Math.min(args.page, doc.pages.length)
        return { ...head, page, text: doc.pages[page - 1] ?? '' }
      }

      const query = String(args.query ?? '').trim()
      if (query) {
        const hits = searchChunks(doc.chunks, query, 8)
        if (hits.length > 0) {
          return {
            ...head,
            matches: hits.map((h) => ({ page: h.page, text: h.text.slice(0, 2200) })),
            hint: `引用时写「${pageWord(doc.approxPages)}」，前端会把页码变成可点击跳转。`,
          }
        }
        // 没命中就退回从头读，别让模型空手而归
      }

      const maxChars = args.maxChars ?? 12000
      let used = 0
      const pages = []
      for (let i = 0; i < doc.pages.length; i += 1) {
        const text = doc.pages[i]
        if (!text) continue
        if (used + text.length > maxChars) {
          const room = Math.max(0, maxChars - used)
          if (room > 200) pages.push({ page: i + 1, text: text.slice(0, room) })
          break
        }
        used += text.length
        pages.push({ page: i + 1, text })
      }
      return {
        ...head,
        outline: doc.outline.slice(0, 30),
        pages,
        truncated: used >= maxChars,
        hint: '需要更多内容时用 query 定位，或指定 page 读单页。',
      }
    },
  })
}

/** 带页码依据的问答（检索 + 给模型指令，回答仍由主会话模型生成）。 */
export function askTool({ findItem, documentOf }) {
  return defineTool({
    name: 'ask_zotero_paper',
    description:
      '在 Zotero 某篇论文里做带页码依据的检索：先捞出与问题最相关的原文段落，再由你基于这些段落回答。'
      + '适合「这篇论文的方法是什么」「它怎么处理 X」这类需要定位到原文的问题。'
      + '返回的片段带页码，回答时请逐条标出页码。',
    parameters: {
      itemKey: { type: 'string', required: true, description: 'Zotero 条目的 8 位 key。' },
      question: { type: 'string', required: true, description: '要回答的问题。' },
      topK: { type: 'integer', description: '检索片段数，默认 6。', minimum: 1, maximum: 12 },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', required: true },
          source: { type: 'string', required: true },
          passages: { type: 'array', required: true, items: { type: 'object' } },
          instruction: { type: 'string', required: true },
          pageNumbersApproximate: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.passages.length === 0) {
          return [{ type: 'text', text: `《${value.title}》里没有检索到相关段落。` }]
        }
        const word = pageWord(Boolean(value.pageNumbersApproximate))
        const body = value.passages
          .map((p) => `【${word.replace('N', String(p.page))}】${p.text}`)
          .join('\n\n')
        return [{ type: 'text', text: `《${value.title}》相关原文：\n\n${body}` }]
      },
    },
    async execute(args = {}) {
      const item = await findItem(String(args.itemKey ?? ''))
      const doc = await documentOf(item)
      const hits = searchChunks(doc.chunks, String(args.question ?? ''), args.topK ?? 6)
      return {
        itemKey: item.itemKey,
        title: item.title,
        source: doc.source,
        ...(doc.approxPages ? { pageNumbersApproximate: true } : {}),
        passages: hits.map((h) => ({ page: h.page, text: h.text.slice(0, 1800) })),
        instruction: hits.length === 0
          ? '没有检索到相关段落。改用 read_zotero_paper 的 query 换关键词，或先看大纲判断这篇是否真的涉及该问题。'
          : `基于这些片段回答，每处结论后标注页码（${pageWord(doc.approxPages)}）。`
            + '片段不足以回答时明确说明，不要补外部知识。',
      }
    },
  })
}
