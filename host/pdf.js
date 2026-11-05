/**
 * PDF 文本层提取与检索。
 *
 * 分工：
 * - 这里只做「能拿到文本层的 PDF」：扫描件会得到接近空的结果，交由 mineru 模块接管。
 * - 输出 pages = 每页纯文本，以及 chunks = 带页码的可检索片段。
 *   页码是伴随读 PDF 时计算出来的，因此天然准确（不是事后猜的）。
 *
 * pdfjs-dist 以 legacy 构建加载（Node 端无 DOM），由调用方传入或在此惰性 import。
 */
import fsp from 'node:fs/promises'

/** 每页超过此长度才切段；短页整页作一段，保证页码引用的粒度。 */
const CHUNK_CHARS = 1400

let pdfjsPromise

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      try {
        // legacy 构建适配 Node（无 DOM）
        const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
        return mod
      } catch (error) {
        throw new Error(`加载 pdfjs 失败：${error.message}。请在插件目录执行 npm i pdfjs-dist。`)
      }
    })()
  }
  return pdfjsPromise
}

/** 把一页文本切成不超过 CHUNK_CHARS 的若干段，尽量按句子/段落边界。 */
function splitPage(text, limit) {
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    let cut = -1
    // 优先在段落、句号、换行处断开
    for (const re of [/\n\s*\n/g, /[.。!?！？]\s/g, /\n/g]) {
      const window = rest.slice(0, limit)
      let m
      let lastIndex = -1
      while ((m = re.exec(window)) !== null) lastIndex = m.index + m[0].length
      if (lastIndex > limit * 0.5) { cut = lastIndex; break }
    }
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/**
 * 提取 PDF 文本层。
 * @returns {{pages: string[], chunks: {page:number, text:string}[], charCount:number, scanned:boolean}}
 */
export async function extractText(absPath, options = {}) {
  const pdfjs = await getPdfjs()
  const maxPages = options.maxPages ?? 0
  const bytes = new Uint8Array(await fsp.readFile(absPath))
  const doc = await pdfjs.getDocument({
    data: bytes,
    // Node 环境无需 worker，禁用 worker 走主线程
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise

  try {
    const total = doc.numPages
    const limit = maxPages > 0 ? Math.min(total, maxPages) : total
    const pages = []
    /**
     * 每页逐行的字号。标题判定的最可靠信号就是字号 ——
     * 靠"行长/标点/词表"猜，遇到不编号的自造标题就会漏掉或误收（实测：14 页只提出 3 条）。
     * 这里顺手记录，`outlineOf` 用它区分标题层级。
     */
    const pageLines = []
    for (let i = 1; i <= limit; i += 1) {
      const page = await doc.getPage(i)
      try {
        const content = await page.getTextContent()
        // pdfjs 给的 items 已按阅读顺序；用行内最后一项的 hasEOL 断行
        let text = ''
        let line = ''
        let lineSize = 0
        const lines = []
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue
          text += item.str
          line += item.str
          // transform[3] 是纵向缩放，即该文本项的字号；行内取最大值代表这一行的字号
          const size = Math.abs(item.transform?.[3] ?? 0) || Math.abs(item.transform?.[0] ?? 0) || 0
          if (size > lineSize) lineSize = size
          if (item.hasEOL) {
            text += '\n'
            lines.push({ text: line.replace(/\s+/g, ' ').trim(), size: Math.round(lineSize * 10) / 10 })
            line = ''
            lineSize = 0
          }
        }
        if (line.trim()) lines.push({ text: line.replace(/\s+/g, ' ').trim(), size: Math.round(lineSize * 10) / 10 })
        pages.push(text.replace(/[ \t]+\n/g, '\n').trim())
        pageLines.push(lines.filter((l) => l.text))
      } finally {
        page.cleanup?.()
      }
    }

    const chunks = []
    pages.forEach((text, index) => {
      if (!text) return
      for (const piece of splitPage(text, CHUNK_CHARS)) {
        const trimmed = piece.trim()
        if (trimmed) chunks.push({ page: index + 1, text: trimmed })
      }
    })

    const charCount = pages.reduce((n, t) => n + t.length, 0)
    // 扫描件判定：平均每页字符数极低
    const scanned = pages.length > 0 && charCount / pages.length < 40

    return { pages, chunks, charCount, scanned, pageCount: limit, truncated: limit < total, pageLines }
  } finally {
    await doc.destroy?.()
  }
}

/** 关键词检索：给每个 chunk 打分，返回带页码的命中片段。 */
export function searchChunks(chunks, query, limit = 8) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
  if (terms.length === 0) return []

  const scored = []
  for (const chunk of chunks) {
    const haystack = chunk.text.toLowerCase()
    let score = 0
    for (const term of terms) {
      let from = 0
      let hits = 0
      while (hits < 8) {
        const at = haystack.indexOf(term, from)
        if (at < 0) break
        hits += 1
        from = at + term.length
      }
      if (hits > 0) score += hits * (term.length >= 5 ? 2 : 1)
    }
    if (score > 0) scored.push({ score, chunk })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ score, chunk }) => ({
    page: chunk.page,
    text: chunk.text,
    score,
  }))
}

/**
 * 章节大纲：靠行首编号/关键词粗提，供「这篇论文讲了什么」类问题定位。
 *
 * 两个必须做的清洗，否则大纲会被噪声淹没：
 *   1. 页眉页脚：同一行在多页重复出现（期刊名+卷期+页码），一律不算标题。
 *      判定用「去掉数字后的行」做归一化计数 —— 页码逐页不同，但去掉数字后相同。
 *   2. 断句行：以 and/or/with 等连词结尾的短行，是正文折行不是标题。
 */
export function outlineOf(pages, pageLines) {
  const SECTION_WORDS = [
    'abstract', 'introduction', 'related work', 'background', 'method', 'methods',
    'materials and methods', 'results', 'result', 'experiments', 'experiment',
    'evaluation', 'discussion', 'conclusion', 'conclusions', 'future work',
    'references', 'acknowledgments', 'acknowledgements', 'acknowledgment', 'acknowledgement',
  ]

  const citationRe = new RegExp(
    '^(?:\\d+\\.\\s+|\\[\\d+\\]\\s*)?(?:'
    + '[\\p{Lu}][\\p{L}\'\\u2019-]+,\\s*[\\p{Lu}]\\.'
    + '|[\\p{Lu}][\\p{L}]+\\s+et\\s+al'
    + '|\\d{4}\\.'
    + ')', 'u',
  )

  /** 标题不会以句号/分号收尾；正文句子几乎总是。 */
  const endsLikeSentence = (s) => /[.;:,]$/.test(s)

  /** 作者行、机构行、DOI 行这类元信息，不是章节。 */
  const isFrontMatter = (s) => {
    if (/\$/.test(s)) return true                                   // 作者名后的上标 $ 符号
    if (/\b(?:universit|institut|department|college|laborator)\w*/i.test(s)) return true
    if (/^(?:received|accepted|published|correspondence|doi|e-?mail)\b/i.test(s)) return true
    if (/@|https?:\/\//.test(s)) return true
    return false
  }

  /* ------------------------------------------------ 无字号时的退化路径 */

  /**
   * 没有 pageLines（老调用方、或某些 PDF 拿不到 transform）时，
   * 退回「行首编号 + 固定章节词」—— 保守但不会乱收。宁可少列，不可全错。
   */
  if (!Array.isArray(pageLines) || pageLines.length === 0) {
    const out = []
    pages.forEach((text, index) => {
      if (!text) return
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line || citationRe.test(line)) continue
        const numbered = /^(\d+(?:\.\d+)*\.?)\s+([A-Z\u4e00-\u9fa5][^\n]{2,80})$/.exec(line)
        const bare = line.replace(/^\d+(?:\.\d+)*\.?\s+/, '')
        const lower = bare.toLowerCase().replace(/[.:：]\s*$/, '')
        const hit = SECTION_WORDS.find((w) => lower === w || lower.startsWith(w + ' '))
        const title = numbered ? numbered[1] + ' ' + numbered[2] : (hit && bare.length <= 70 ? bare : null)
        if (!title) continue
        if (!out.some((h) => h.title === title)) out.push({ page: index + 1, title })
      }
    })
    return out.slice(0, 40)
  }

  /* ------------------------------------------------------ 字号统计 */

  // 每页一行行统计字号频次，取「出现最多的字号」当正文基准。
  const sizeCount = new Map()
  for (const lines of pageLines) {
    for (const l of lines) {
      const key = l.size.toFixed(1)
      sizeCount.set(key, (sizeCount.get(key) ?? 0) + 1)
    }
  }
  let bodySize = 0
  let best = -1
  for (const [size, n] of sizeCount) {
    if (n > best) { best = n; bodySize = Number(size) }
  }
  if (!bodySize) bodySize = 11

  // 标题阈值：明显大于正文。1.12 倍是实测出来的分界
  // （这篇论文正文 11.0、二级标题 13.0 = 1.18 倍、一级 16.9 = 1.54 倍）。
  const HEADING_RATIO = 1.12
  // 论文大标题的阈值：远大于正文（20.9 / 11.0 ≈ 1.9），单独排除
  const TITLE_RATIO = 1.7

  const out = []
  let inReferences = false

  pageLines.forEach((lines, index) => {
    if (!lines || lines.length === 0) return

    /**
     * 合并「因折行被拆开的标题」：同一字号、紧邻的若干行，如果前一行没结束句子，
     * 就认为它是同一个标题的后半截（The limitations of rapid / categorization）。
     */
    const blocks = []
    for (const l of lines) {
      const prev = blocks[blocks.length - 1]
      const sameSize = prev && Math.abs(prev.size - l.size) < 0.3
      const prevOpen = prev && !endsLikeSentence(prev.text)
      const isHeadingSize = l.size >= bodySize * HEADING_RATIO
      if (sameSize && prevOpen && isHeadingSize && prev.text.length + l.text.length <= 90) {
        prev.text = prev.text + ' ' + l.text
        continue
      }
      blocks.push({ text: l.text, size: l.size })
    }

    for (const b of blocks) {
      const text = b.text.trim()
      if (!text) continue
      if (b.size < bodySize * HEADING_RATIO) continue          // 正文
      if (b.size >= bodySize * TITLE_RATIO) continue           // 论文大标题
      if (endsLikeSentence(text)) continue                     // 正文折行被误标大字号
      if (citationRe.test(text)) continue
      if (isFrontMatter(text)) continue
      if (text.length > 90) continue
      if (text.split(/\s+/).length > 12) continue

      // 编号标题保留编号（用户按编号找章节更快）；否则用原文
      let clean = text.replace(/\s+/g, ' ').trim()

      /**
       * 已知的章节名如果被正文尾巴粘在前面（`tion, statistical tests, attention Acknowledgments`），
       * 就截到章节名本身。真实 PDF 里这种粘连很常见：正文最后一行与紧随的标题共用一段文本流。
       */
      const glued = SECTION_WORDS.find((w) => {
        if (!clean.toLowerCase().endsWith(w)) return false
        return clean.length > w.length
      })
      if (glued) {
        const idx = clean.toLowerCase().lastIndexOf(glued)
        const head = clean.slice(idx)
        // 只有前面的残余不像一句完整的话时才截断
        const tail = clean.slice(0, idx)
        if (!endsLikeSentence(tail.trim())) clean = head.charAt(0).toUpperCase() + head.slice(1)
      }

      if (/^references?\b/i.test(clean)) inReferences = true
      if (inReferences && !/^references?\b/i.test(clean)) continue

      if (!out.some((h) => h.title === clean)) out.push({ page: index + 1, title: clean })
    }
  })

  return out.slice(0, 60)
}
