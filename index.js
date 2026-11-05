/**
 * dsh-zotero-reader —— Host 半边。
 *
 * 核心立场（呼应「不要插件自己注册论文伴读」这条要求）：
 *
 *   · 插件**不维护自己的文献列表**。Zotero 库是唯一事实来源，每次检索现读库。
 *     用户在 Zotero 里新加的文献，下一次提问就能搜到，不需要在插件里再导入一次。
 *
 *   · 「在会话中识别搜出来的文章」靠**工具返回值**：search_zotero_library 每条结果都带
 *     itemKey，模型把它写成 `zotero://<key>`，前端按这个约定渲染「打开阅读」入口。
 *     插件不拦截消息、不改会话流程、不自己注册会话。
 *
 *   · 「打开一篇来阅读」靠右侧栏 tab：这里的 HTTP 路由把 PDF 字节流按 key 送出去，
 *     阅读器自己用 pdf.js 渲染。PDF 全程不出本机。
 *
 * 权限边界：插件路由挂在宿主 webServer 上，但**不经过宿主的会话鉴权链**，必须自己判断 ——
 * 用 ctx.connection.requestRejection(req)，返回非空即拒绝。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLibrary, loadAnnotations } from './host/zotero.js'
import { extractText, searchChunks, outlineOf } from './host/pdf.js'
import { translateDocument, translateSelection, pickSelection } from './host/translate.js'
import { parseWithMineru, sectionsFromMarkdown } from './host/mineru.js'
import { searchTool, readTool, askTool } from './host/tools.js'
import {
  readAnnotations, createAnnotation, deleteAnnotation,
  probeLocalApi, HIGHLIGHT_COLORS,
} from './host/annotations.js'

export const name = 'dsh-zotero-reader'
export const inject = ['tools']

/**
 * 配置 schema 转出。
 * 宿主只认这个导出：没有它，插件页就不渲染设置表单（listConfigs 里 status 是 absent），
 * MinerU 模式这类开关用户就没法改 —— 这正是「根本没地方给我设置」的原因。
 * 取不到 schemastery 时它是 undefined，宿主显示「无配置」，插件功能不受影响。
 */
export { Config } from './config.js'

const ROUTE_PREFIX = '/zotero-reader'

/**
 * 找到插件自带的 pdfjs-dist 资源文件。
 *
 * 用 `fileURLToPath` 而不是手工处理 `URL.pathname`：Windows 下 pathname 是
 * `/D:/%E6%96%87...` 这种形态，手工 replace + decode 容易在中文字符或盘符边界出错。
 *
 * 两个候选落点，覆盖 link 安装（源码目录即包目录）与打包安装：
 *   1. <包目录>/node_modules/pdfjs-dist/...   —— 依赖就装在自己下面
 *   2. <包目录>/../node_modules/pdfjs-dist/... —— 被提升到上一层时
 * 找不到返回 null，由调用方给出可读的错误提示。
 */
async function resolvePdfjsAsset(relPath) {
  const anchorDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(anchorDir, 'node_modules', 'pdfjs-dist', relPath),
    path.join(anchorDir, '..', 'node_modules', 'pdfjs-dist', relPath),
  ]
  for (const file of candidates) {
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile()) return file
    } catch { /* 试下一个 */ }
  }
  return null
}
/** 库索引缓存时长：短到新加文献能立刻被搜到，长到不必每次提问都重读 sqlite。 */
const LIBRARY_TTL_MS = 15_000

/**
 * apply 里的异常会让宿主把 fiberPhase 记成 failed，而那条堆栈默认不进任何地方。
 * 宿主列表只告诉你「失败了」，所以这里自己把它写到磁盘：插件起不来时，
 * 用户（和排查的人）能直接读到原因，而不是对着 failed 猜。
 */
function recordFailure(stage, error) {
  try {
    const dir = process.env['DSH_ZOTERO_READER_DATA'] || path.join(os.homedir(), '.dsh-zotero-reader')
    fs.mkdirSync(dir, { recursive: true })
    const line = [
      `[${new Date().toISOString()}] stage=${stage}`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      '',
    ].join('\n')
    fs.appendFileSync(path.join(dir, 'host-error.log'), line, 'utf8')
  } catch { /* 连日志都写不了就只能放弃 */ }
  console.error(`[dsh-zotero-reader] ${stage} failed:`, error)
}

export function apply(ctx, config = {}) {
  try {
    return applyInner(ctx, config)
  } catch (error) {
    recordFailure('apply', error)
    throw error
  }
}

function applyInner(ctx, config = {}) {
  const docs = new Map()          // itemKey → 文本层缓存
  /**
   * 会话 → 本次搜索命中过的 itemKey（按出现顺序，去重）。
   * 右侧栏「本次搜索」tab 读它，于是列表只反映这次对话真正搜出来的文章。
   * 存内存不落盘：这是「这次对话」的视角，重启后本就不该还留着。
   */
  const searched = new Map()
  const translating = new Map()   // itemKey:lang → 进度
  const state = { libraryCache: null, libraryAt: 0 }

  // 数据目录：显式配置 > 环境变量 > ~/.dsh-zotero-reader。
  // **不能**用 ctx.baseDir —— Cordis 的 proxy 属性不写进 inject 就会抛
  // `cannot get property "baseDir" without inject`（安装时实测踩过）。
  const dataDir = normalizeConfig(config).dataDir
    || process.env['DSH_ZOTERO_READER_DATA']
    || path.join(os.homedir(), '.dsh-zotero-reader')
  const cacheDir = path.join(dataDir, 'cache')

  /**
   * 运行期设置。
   *
   * 宿主插件页里改配置要重载整个插件才生效，而 MinerU 这类开关用户是想即时切的；
   * 而且实测宿主没把这个插件渲染成可点的设置入口。所以设置改为「面板里直接改、
   * 存一份 json、立即生效」，YAML 里的值只作为初始默认。
   */
  const settings = normalizeConfig(config)
  const settingsFile = path.join(dataDir, 'settings.json')
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (saved && typeof saved === 'object') Object.assign(settings, normalizeConfig({ ...settings, ...saved }))
  } catch { /* 没有存过就用默认 */ }

  function saveSettings(patch) {
    const next = normalizeConfig({ ...settings, ...patch })
    Object.assign(settings, next)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      throw new Error(`保存设置失败：${error.message}`)
    }
    return settings
  }

  /* ------------------------------------------------------------ 库与文档 */

  let inflightLibrary = null
  /**
   * 取库索引。TTL 缓存 + 并发去重：多个工具同时调用只跑一次快照。
   */
  async function library(force = false) {
    if (!force && state.libraryCache && Date.now() - state.libraryAt < LIBRARY_TTL_MS) {
      return state.libraryCache
    }
    if (inflightLibrary) return inflightLibrary
    inflightLibrary = (async () => {
      try {
        const result = await loadLibrary(settings, cacheDir)
        state.libraryCache = result
        state.libraryAt = Date.now()
        return result
      } finally {
        inflightLibrary = null
      }
    })()
    return inflightLibrary
  }

  async function findItem(itemKey) {
    const key = String(itemKey ?? '').trim()
    if (!key) throw new Error('缺少 itemKey')
    const lib = await library()
    const item = lib.items.find((x) => x.itemKey === key)
    if (!item) throw new Error(`Zotero 库里找不到条目 ${key}`)
    if (!item.pdfPath) throw new Error(`条目「${item.title}」没有可读的本地 PDF 附件`)
    return item
  }

  /**
   * 取文档文本。来源优先级：
   *   1) 显式要求 MinerU → MinerU
   *   2) 本地文本层（快，页码精确）
   *   3) 文本层为空/乱码，且配了 MinerU → 自动升级到 MinerU
   * MinerU 失败不能让阅读失败：退回文本层并把原因带出去。
   */
  async function documentOf(item, options = {}) {
    const cached = docs.get(item.itemKey)
    if (cached && !options.refresh && !options.forceMineru) return cached

    const fromText = async () => {
      const e = await extractText(item.pdfPath)
      return {
        pages: e.pages,
        chunks: e.chunks,
        // pageLines 带每行字号：大纲靠字号判标题层级，比词表/行长可靠得多
        outline: outlineOf(e.pages, e.pageLines),
        source: 'pdf-text',
        scanned: e.scanned,
        pageCount: e.pageCount,
        approxPages: false,
      }
    }

    const fromMineru = async () => {
      const parsed = await parseWithMineru(item.pdfPath, settings)
      const sections = sectionsFromMarkdown(parsed.markdown)
      return {
        pages: sections.map((s) => s.text),
        // MinerU 的 md 没有可靠分页：页码按章节位置估算，对外必须标 approxPages
        chunks: sections.map((s) => ({ page: s.approxPage, text: s.text })),
        outline: sections.map((s) => ({ page: s.approxPage, title: s.title })),
        source: parsed.source,
        approxPages: true,
        scanned: false,
        markdown: parsed.markdown,
        pageCount: sections.length,
      }
    }

    let doc
    if (options.forceMineru) {
      doc = await fromMineru()
    } else {
      doc = await fromText()
      const garbled = isGarbageText(doc.pages)
      if ((doc.scanned || garbled) && settings.mineruMode !== 'none' && settings.mineruAutoOnScanned) {
        try {
          const enhanced = await fromMineru()
          enhanced.fallbackReason = doc.scanned ? 'scanned' : 'garbled'
          doc = enhanced
        } catch (error) {
          doc.mineruError = error instanceof Error ? error.message : String(error)
        }
      }
    }

    docs.set(item.itemKey, doc)
    return doc
  }

  /* ---------------------------------------------------------------- 工具 */

  ctx.tools.register(searchTool(() => library(true), {
    /**
     * 记下这次搜索命中的文章，供右侧栏「本次搜索」tab 使用。
     * 用 exec 里的会话 id 区分：同一台机器上多个会话各有各的清单。
     */
    onHits(sessionId, keys) {
      if (!sessionId || keys.length === 0) return
      const list = searched.get(sessionId) ?? []
      for (const key of keys) {
        if (!list.includes(key)) list.push(key)
      }
      searched.set(sessionId, list)
    },
  }))
  ctx.tools.register(readTool({ findItem, documentOf }))
  ctx.tools.register(askTool({ findItem, documentOf }))

  /* ---------------------------------------------------------------- 路由 */

  const deps = {
    findItem, documentOf, library, docs, searched, translating, settings, dataDir, cacheDir, ctx,
    saveSettings,
    // 设置里换了 Zotero 路径后，旧缓存必须作废，否则还按老路径读
    invalidateLibrary() {
      state.libraryCache = null
      state.libraryAt = 0
      docs.clear()
    },
  }

  ctx.inject(['webServer', 'connection', 'llm', 'agentDefaultModel'], (rctx) => {
    try {
      rctx.effect(() => {
        const dispose = rctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            handleRequest(rctx, req, res, deps).catch((error) => {
              if (!res.headersSent) {
                sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
              } else {
                try { res.end() } catch { /* 已断开 */ }
              }
            })
          },
        })
        return dispose
      })
    } catch (error) {
      // 路由挂不上不该让整个插件死掉：工具仍然可用，只是没有阅读器。
      recordFailure('routes', error)
    }
  })
}

/* ---------------------------------------------------------------- 配置 */

function normalizeConfig(config) {
  return {
    zoteroDataDir: config.zoteroDataDir ?? '',
    dataDir: config.dataDir ?? '',
    translateConcurrency: clampInt(config.translateConcurrency, 1, 16, 4),
    translateChunkChars: clampInt(config.translateChunkChars, 500, 8000, 2400),
    selectionProvider: config.selectionProvider ?? '',
    selectionModel: config.selectionModel ?? '',
    mineruMode: ['none', 'local', 'cloud'].includes(config.mineruMode) ? config.mineruMode : 'none',
    mineruLocalUrl: config.mineruLocalUrl || 'http://127.0.0.1:8000',
    mineruCloudToken: config.mineruCloudToken ?? '',
    mineruAutoOnScanned: config.mineruAutoOnScanned !== false,
  }
}

function clampInt(value, min, max, fallback) {
  // 注意 `Number(null) === 0` 且 isFinite(0) 为真：不显式挡掉 null/''/undefined
  // 的话，缺省的查询参数会被读成 0，再 clamp 到 min —— 于是 limit 变成 1，
  // 列表只出一篇（实测踩过）。
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 乱码判定：PDF 文本层常见的坏情况是私用区字符、替换符，以及「每个字之间塞空格」。
 * 命中比例高就认为文本层不可用，值得交给 MinerU 重解析。
 */
function isGarbageText(pages) {
  const sample = pages.slice(0, 12).join('')
  if (!sample) return true
  const bad = (sample.match(/[\uE000-\uF8FF\uFFFD]/g) ?? []).length
  const spaced = (sample.match(/\b\w\b\s/g) ?? []).length
  return bad / sample.length > 0.02 || spaced / sample.length > 0.25
}

/* ---------------------------------------------------------------- HTTP */

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求体不是合法 JSON') }
}

/**
 * 把 pdf.js 的构建产物送给浏览器。
 *
 * 为什么需要这条路：客户端插件跑在页面里，`require('pdfjs-dist')` 依赖宿主预装该包；
 * 而这块内容以前是 paper-reader 带来的，那个插件一删，宿主里就没有 pdfjs-dist 了
 * （实测报「找不到 pdfjs-dist（宿主未装载该包）」）。改成插件自带一份、由自己的路由
 * 发出去 —— 别人装什么、删什么都与本插件无关。
 *
 * 白名单而非通用静态目录：只放行 pdf.js 需要的几个文件，不把 node_modules 暴露出去。
 * 不需要认证（在 handleRequest 里先于 requestRejection 处理）：这些都是公开的库代码。
 */
const VENDOR_FILES = {
  'pdf.mjs': ['build/pdf.min.mjs', 'application/javascript; charset=utf-8'],
  'pdf.worker.mjs': ['build/pdf.worker.min.mjs', 'application/javascript; charset=utf-8'],
  'pdf-legacy.mjs': ['legacy/build/pdf.min.mjs', 'application/javascript; charset=utf-8'],
}

async function serveVendorAsset(res, subPath) {
  const name = subPath.slice('/vendor/'.length)
  const entry = VENDOR_FILES[name]
  if (!entry) {
    sendJson(res, 404, { error: `未知静态资源 ${name}` })
    return
  }
  const file = await resolvePdfjsAsset(entry[0])
  if (!file) {
    sendJson(res, 503, { error: '插件目录里没有 pdfjs-dist，请在插件目录执行 npm i pdfjs-dist' })
    return
  }
  const data = await fsp.readFile(file)
  res.writeHead(200, {
    'Content-Type': entry[1],
    'Content-Length': String(data.length),
    'Cache-Control': 'public, max-age=86400',
  })
  res.end(data)
}

function selectionOverride(settings) {
  return settings.selectionProvider && settings.selectionModel
    ? { provider: settings.selectionProvider, model: settings.selectionModel }
    : undefined
}

/**
 * 路由回调里取 LLM 服务。
 * 这两个服务已在 ctx.inject 里点名，因此 rctx.llm / rctx.agentDefaultModel 是可直接读的；
 * 不要再写 rctx.get('llm') 之类的兜底 —— Cordis 的 ctx 是 proxy，未注入的属性
 * 连「读一下看看在不在」都会抛错。
 */
function llmFacade(rctx) {
  return { llm: rctx.llm, agentDefaultModel: rctx.agentDefaultModel }
}

async function handleRequest(rctx, req, res, deps) {
  const parsed = new URL(req.url ?? '/', 'http://localhost')
  // prefix 路由下 req.url 通常带完整前缀；这里兼容「已被宿主剥掉」的情况，
  // 否则 `/vendor/pdf.mjs` 会被 slice 成 `"s"` 而匹配不到任何分支（实测踩过）。
  const rawPath = parsed.pathname
  const subPath = rawPath.startsWith(ROUTE_PREFIX)
    ? (rawPath.slice(ROUTE_PREFIX.length) || '/')
    : (rawPath || '/')

  /**
   * 静态资源必须在**认证之前**处理。
   *
   * `/vendor/*` 是 pdf.js 的构建产物，本身不含任何用户数据；而 `requestRejection`
   * 是按浏览器凭据判断的，`fetch` 拿这类资源时经常拿不到放行（实测 pdf.js 一直报
   * 「Failed to fetch dynamically imported module」）。放行它既安全又必要。
   */
  if (subPath.startsWith('/vendor/')) {
    try {
      return await serveVendorAsset(res, subPath)
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: `读取静态资源失败：${error.message}` })
      return undefined
    }
  }

  // 插件路由不在宿主鉴权链上，必须自己判断
  const rejection = rctx.connection?.requestRejection?.(req)
  if (rejection !== undefined && rejection !== null && rejection !== false) {
    sendJson(res, typeof rejection === 'number' ? rejection : 403, { error: 'unauthorized' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const method = req.method ?? 'GET'

  try {
    if (sub === '/health') {
      const lib = await deps.library()
      sendJson(res, 200, {
        ok: true,
        dataDir: lib.dataDir,
        items: lib.items.length,
        withPdf: lib.items.filter((x) => x.pdfPath).length,
        mineruMode: deps.settings.mineruMode,
      })
      return
    }

    /**
     * 设置读写。
     * 面板里改、存 json、立即生效 —— 不用去翻 YAML，也不用重载插件。
     * GET 返回可编辑字段（token 这类秘密不回显明文，只回是否已填）。
     */
    if (sub === '/settings' && method === 'GET') {
      const s = deps.settings
      return sendJson(res, 200, {
        mineruMode: s.mineruMode,
        mineruLocalUrl: s.mineruLocalUrl,
        mineruAutoOnScanned: s.mineruAutoOnScanned,
        mineruCloudTokenSet: Boolean(s.mineruCloudToken),
        zoteroDataDir: s.zoteroDataDir,
        // 只读展示，便于排查
        resolvedDataDir: deps.dataDir,
      })
    }

    if (sub === '/settings' && method === 'POST') {
      const body = await readJsonBody(req)
      const patch = {}
      if (typeof body.mineruMode === 'string') {
        if (!['none', 'local', 'cloud'].includes(body.mineruMode)) {
          return sendJson(res, 400, { error: 'mineruMode 只能是 none / local / cloud' })
        }
        patch.mineruMode = body.mineruMode
      }
      if (typeof body.mineruLocalUrl === 'string') patch.mineruLocalUrl = body.mineruLocalUrl.trim()
      if (typeof body.mineruAutoOnScanned === 'boolean') patch.mineruAutoOnScanned = body.mineruAutoOnScanned
      if (typeof body.mineruCloudToken === 'string') patch.mineruCloudToken = body.mineruCloudToken.trim()
      if (typeof body.zoteroDataDir === 'string') patch.zoteroDataDir = body.zoteroDataDir.trim()

      const saved = deps.saveSettings(patch)
      // 库路径变了要作废缓存，否则还按老路径读
      if ('zoteroDataDir' in patch) deps.invalidateLibrary()
      return sendJson(res, 200, {
        ok: true,
        mineruMode: saved.mineruMode,
        mineruLocalUrl: saved.mineruLocalUrl,
        mineruAutoOnScanned: saved.mineruAutoOnScanned,
        mineruCloudTokenSet: Boolean(saved.mineruCloudToken),
        zoteroDataDir: saved.zoteroDataDir,
      })
    }

    /**
     * MinerU 连通性测试：用户点「测试」时用它确认到底通不通，
     * 而不是等真正解析时才失败。
     */
    if (sub === '/settings/test-mineru' && method === 'POST') {
      const mode = deps.settings.mineruMode
      if (mode === 'none') return sendJson(res, 200, { ok: false, error: 'MinerU 当前是关闭状态' })
      if (mode === 'local') {
        const base = deps.settings.mineruLocalUrl.replace(/\/+$/, '')
        const host = base.replace(/^https?:\/\//, '')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 6000)
        try {
          const r = await fetch(`${base}/`, { method: 'GET', signal: controller.signal })
          return sendJson(res, 200, { ok: true, status: r.status, target: base })
        } catch (error) {
          /**
           * `fetch failed` 对用户毫无信息量。这里按错误码给出可照做的说明 ——
           * 实测最常见的原因就是本机压根没跑 MinerU（端口没人监听）。
           */
          const code = error?.cause?.code ?? error?.code ?? ''
          const reason = code === 'ECONNREFUSED'
            ? `没有找到 MinerU 软件：${host} 上没有任何服务在运行（本机未安装或未启动）。可以启动它，或把模式改回「关闭」—— 不装也能正常读论文。`
            : code === 'ETIMEDOUT' || error?.name === 'AbortError'
              ? `${host} 连接超时。首次加载模型可能较慢；用不上就改回「关闭」。`
              : `调用 MinerU 失败（${host}）：${error?.message ?? error}${code ? `（${code}）` : ''}`
          return sendJson(res, 200, { ok: false, error: reason })
        } finally {
          clearTimeout(timer)
        }
      }
      // 云端：有 token 且能拿到接口响应即视为可通
      if (!deps.settings.mineruCloudToken) return sendJson(res, 200, { ok: false, error: '云端模式需要先填 token' })
      return sendJson(res, 200, { ok: true, note: 'token 已配置；实际可用性会在首次解析时验证' })
    }

    if (sub === '/library') {
      const lib = await deps.library(true)
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      let items = lib.items.filter((x) => x.pdfPath)
      if (q) {
        const terms = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
        items = items.filter((item) => {
          const hay = `${item.title} ${item.publication} ${item.creators.join(' ')} ${item.collections.join(' ')}`.toLowerCase()
          return terms.every((t) => hay.includes(t))
        })
      }

      /**
       * 专题分组。
       * 「所有文献库」要能按用户自己的 collection 归类——用户在 Zotero 里怎么组织，
       * 这里就怎么呈现，插件不另造一套分类。没有归入任何专题的单独兜底成「未分类」。
       */
      const groups = new Map()
      for (const item of items) {
        const names = item.collections.length > 0 ? item.collections : ['未分类']
        for (const name of names) {
          if (!groups.has(name)) groups.set(name, [])
          groups.get(name).push(item)
        }
      }
      const collections = [...groups.entries()]
        .map(([name, list]) => ({ name, count: list.length }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

      const limit = clampInt(url.searchParams.get('limit'), 1, 2000, 400)
      sendJson(res, 200, {
        dataDir: lib.dataDir,
        total: lib.items.length,
        withPdf: lib.items.filter((x) => x.pdfPath).length,
        matched: items.length,
        collections,
        items: items.slice(0, limit).map((item) => ({
          key: item.itemKey,
          title: item.title,
          authors: item.creators.slice(0, 4),
          year: item.year,
          publication: item.publication,
          collections: item.collections,
        })),
      })
      return
    }

    /**
     * 本会话被搜索过的文章。
     *
     * 「搜索过」的判定放在 host 侧、按会话记：模型调用 search_zotero_library 时
     * 把命中的 key 追加进该会话的清单。这样右侧栏的「本次搜索」tab 显示的就是
     * 这次对话真正讨论过的文章，而不是又给一遍整个库。
     */
    if (sub === '/searched') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const keys = deps.searched.get(sessionId) ?? []
      if (keys.length === 0) return sendJson(res, 200, { items: [] })
      const lib = await deps.library()
      const byKey = new Map(lib.items.map((item) => [item.itemKey, item]))
      const items = keys
        .map((key) => byKey.get(key))
        .filter(Boolean)
        .map((item) => ({
          key: item.itemKey,
          title: item.title,
          authors: item.creators.slice(0, 4),
          year: item.year,
          publication: item.publication,
          collections: item.collections,
        }))
      return sendJson(res, 200, { items })
    }

    if (sub === '/searched/clear' && method === 'POST') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      deps.searched.delete(sessionId)
      return sendJson(res, 200, { ok: true })
    }

    // PDF 字节流：阅读器用 pdf.js 直接渲染，支持 Range 以便大文件按需加载
    if (sub === '/pdf') {
      const item = await deps.findItem(url.searchParams.get('key') ?? '')
      const stat = await fsp.stat(item.pdfPath)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'private, max-age=60')
      const range = req.headers.range
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? Number(m[1]) : 0
        const end = m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1
        if (start >= stat.size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        })
        const handle = await fsp.open(item.pdfPath, 'r')
        try {
          await new Promise((resolve) => {
            const stream = handle.createReadStream({ start, end })
            // 用事件手工转发，而不是 stream.pipe(res)：pipe 要求 res 是完整 Writable 流，
            // 在非标准宿主/测试桩下会抛 "dest.on is not a function"。手工转发只依赖 write/end。
            stream.on('data', (chunk) => {
              try { res.write(chunk) } catch { stream.destroy() }
            })
            stream.on('error', resolve)
            stream.on('end', () => { try { res.end() } catch { /* 已断开 */ } ; resolve() })
          })
        } finally {
          await handle.close().catch(() => {})
        }
        return
      }
      res.writeHead(200, { 'Content-Length': String(stat.size) })
      res.end(await fsp.readFile(item.pdfPath))
      return
    }

    // 文档元信息 + 大纲
    if (sub === '/doc') {
      const item = await deps.findItem(url.searchParams.get('key') ?? '')
      const forceMineru = url.searchParams.get('mineru') === '1'
      const doc = await deps.documentOf(item, { forceMineru })
      sendJson(res, 200, {
        key: item.itemKey,
        title: item.title,
        authors: item.creators,
        year: item.year,
        publication: item.publication,
        abstract: item.abstract?.slice(0, 1200) ?? '',
        pageCount: doc.pageCount,
        source: doc.source,
        approxPages: Boolean(doc.approxPages),
        scanned: Boolean(doc.scanned),
        outline: doc.outline.slice(0, 40),
        ...(doc.mineruError ? { mineruError: doc.mineruError } : {}),
      })
      return
    }

    /**
     * 批注：读。
     * 返回已有高亮/备注 + 附件 key（写入时要靠它定位父条目），
     * 外加本地 API 的可用性，让前端能提前说明「能不能加」。
     */
    if (sub === '/annotations' && method === 'GET') {
      const itemKey = url.searchParams.get('key') ?? ''
      const item = await deps.findItem(itemKey)
      const result = await loadAnnotations(deps.settings, deps.cacheDir, itemKey, readAnnotations)
      const probe = await probeLocalApi()
      return sendJson(res, 200, {
        annotations: result.annotations,
        attachmentKey: result.attachmentKey ?? item.attachmentKey ?? null,
        canWrite: probe.available && probe.writable,
        writeBlockedReason: probe.available && probe.writable ? null : (probe.reason ?? null),
        colors: HIGHLIGHT_COLORS,
      })
    }

    /** 批注：新建（高亮 + 可选备注）。 */
    if (sub === '/annotations' && method === 'POST') {
      const body = await readJsonBody(req)
      const itemKey = String(body.itemKey ?? '')
      const text = String(body.text ?? '').trim()
      if (!text) return sendJson(res, 400, { error: '没有选中文字' })
      const item = await deps.findItem(itemKey)

      // 附件 key：前端可能已知（从 /annotations 拿到），否则现查一次
      let attachmentKey = body.attachmentKey ? String(body.attachmentKey) : (item.attachmentKey ?? null)
      if (!attachmentKey) {
        const r = await loadAnnotations(deps.settings, deps.cacheDir, itemKey, readAnnotations)
        attachmentKey = r.attachmentKey
      }
      if (!attachmentKey) return sendJson(res, 400, { error: '这篇文献没有找到 PDF 附件，无法挂批注' })

      const result = await createAnnotation({
        parentItemKey: itemKey,
        attachmentKey,
        text,
        comment: String(body.comment ?? ''),
        color: String(body.color ?? '#ffd400'),
        pageIndex: Number(body.pageIndex ?? 0),
        rects: Array.isArray(body.rects) ? body.rects : [],
        pageLabel: body.pageLabel,
      })
      if (!result.ok) return sendJson(res, result.needAuth ? 401 : 400, { error: result.reason })
      return sendJson(res, 200, { ok: true, key: result.key })
    }

    /** 批注：删除。 */
    if (sub === '/annotations' && method === 'DELETE') {
      const key = url.searchParams.get('annotKey') ?? ''
      if (!key) return sendJson(res, 400, { error: '缺少 annotKey' })
      const result = await deleteAnnotation(key)
      if (!result.ok) return sendJson(res, result.needAuth ? 401 : 400, { error: result.reason })
      return sendJson(res, 200, { ok: true })
    }

    /** Zotero 本地 API 状态：设置面板里用它提示写入是否就绪。 */
    if (sub === '/zotero/status') {
      const probe = await probeLocalApi()
      return sendJson(res, 200, probe)
    }

    // 单页文本（划词兜底、提问定位用）
    if (sub === '/page') {
      const item = await deps.findItem(url.searchParams.get('key') ?? '')
      const doc = await deps.documentOf(item)
      const page = clampInt(url.searchParams.get('page'), 1, Math.max(1, doc.pages.length), 1)
      sendJson(res, 200, { page, total: doc.pages.length, text: doc.pages[page - 1] ?? '' })
      return
    }

    // 全文翻译：按页产出，磁盘缓存
    if (sub === '/translate') {
      const item = await deps.findItem(url.searchParams.get('key') ?? '')
      const force = url.searchParams.get('force') === '1'
      if (!force) {
        const cached = await readCache(deps.dataDir, `${item.itemKey}.zh.json`)
        if (cached) {
          sendJson(res, 200, { pages: cached.pages, cached: true })
          return
        }
      }
      const jobKey = `${item.itemKey}:zh`
      const running = deps.translating.get(jobKey)
      if (running) {
        sendJson(res, 409, { error: '正在翻译中', done: running.done, total: running.total })
        return
      }
      const doc = await deps.documentOf(item)
      const job = { done: 0, total: doc.pages.filter((p) => p.trim()).length }
      deps.translating.set(jobKey, job)
      try {
        const result = await translateDocument(llmFacade(rctx), doc, {
          chunkChars: deps.settings.translateChunkChars,
          concurrency: deps.settings.translateConcurrency,
          override: selectionOverride(deps.settings),
          onPage: () => { job.done += 1 },
        })
        await writeCache(deps.dataDir, `${item.itemKey}.zh.json`, {
          key: item.itemKey,
          title: item.title,
          pages: result.pages,
          approxPages: Boolean(doc.approxPages),
          at: Date.now(),
        })
        sendJson(res, 200, {
          pages: result.pages,
          failed: result.failed,
          approxPages: Boolean(doc.approxPages),
          cached: false,
        })
      } finally {
        deps.translating.delete(jobKey)
      }
      return
    }

    if (sub === '/translate/progress') {
      const job = deps.translating.get(`${url.searchParams.get('key')}:zh`)
      sendJson(res, 200, job ? { running: true, done: job.done, total: job.total } : { running: false })
      return
    }

    // 划词：翻译 / 解释
    if (sub === '/selection' && method === 'POST') {
      const body = await readJsonBody(req)
      const text = String(body.text ?? '').trim()
      if (!text) {
        sendJson(res, 400, { error: '没有选中文本' })
        return
      }
      const out = await translateSelection(llmFacade(rctx), text, {
        mode: body.mode === 'explain' ? 'explain' : 'translate',
        override: selectionOverride(deps.settings),
      })
      sendJson(res, 200, { text: out, mode: body.mode === 'explain' ? 'explain' : 'translate' })
      return
    }

    sendJson(res, 404, { error: `未知路径 ${sub}` })
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/* ---------------------------------------------------------------- 缓存 */

async function readCache(dataDir, filename) {
  try {
    const raw = await fsp.readFile(path.join(dataDir, 'translate', filename), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.pages) ? parsed : null
  } catch { return null }
}

async function writeCache(dataDir, filename, value) {
  try {
    const dir = path.join(dataDir, 'translate')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, filename), JSON.stringify(value), 'utf8')
  } catch { /* 缓存失败不该让翻译失败 */ }
}

export { pickSelection }
