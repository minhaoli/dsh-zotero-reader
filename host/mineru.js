/**
 * MinerU 增强通道：把扫描件 / 公式乱码的 PDF 重新解析成带 LaTeX 的 Markdown。
 *
 * 两条通道，同一份输出契约：
 * - 本地：POST <mineruLocalUrl>/file_parse（multipart），返回 zip 或 JSON（老版 magic-pdf）
 * - 云端：POST https://mineru.net/api/v4/file-urls/batch 拿上传地址 → PUT 上传
 *         → 轮询 GET /extract-results/batch/<batch_id> → full_zip_url → 下载
 *
 * 为什么值得接：PDF 文本层把公式拆成 `α = 1 2 m v 2`（分数和上标全丢），翻译时模型
 * 只能瞎猜。MinerU 的 LaTeX 输出让公式在中文版里还是公式。
 *
 * 解压不引依赖：Node 内置 DecompressionStream('deflate-raw')，这里只实现读 zip 所必需的
 * 那部分（EOCD → central directory → local header → inflate）。够用且不会随依赖漂移。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const CLOUD_BASE = 'https://mineru.net/api/v4'

/* ------------------------------------------------------------------ zip */

/**
 * 从 zip 字节里取出指定后缀的文件。只支持 store(0) 与 deflate(8)，这正是 MinerU 用的。
 * @returns {Promise<Map<string,string>>} 文件名 → utf8 文本
 */
export async function unzipTextFiles(buffer, wanted = /\.(md|txt|json|tex)$/i) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // 1) 找 EOCD（签名 0x06054b50），从尾部往前扫
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到目录尾记录')

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)

  const decoder = new TextDecoder('utf-8')
  const out = new Map()

  for (let n = 0; n < entryCount; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen

    if (!wanted.test(name) || name.endsWith('/')) continue

    // 2) 从 local header 定位数据起点
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) continue
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = bytes.subarray(dataStart, dataStart + compressedSize)

    if (method === 0) {
      out.set(name, decoder.decode(data))
    } else if (method === 8) {
      try {
        const inflated = await inflateRaw(data)
        out.set(name, decoder.decode(inflated))
      } catch { /* 单个文件坏了不影响其它文件 */ }
    }
  }
  return out
}

async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 从解压结果里挑出正文 Markdown。MinerU 通常叫 full.md，也可能叫 <名字>.md。 */
function pickMarkdown(files) {
  const candidates = [...files.entries()]
    .filter(([name]) => /\.md$/i.test(name))
    .sort((a, b) => {
      const score = (n) => (/full\.md$/i.test(n) ? 0 : /\/[^/]+\.md$/i.test(n) ? 1 : 2)
      return score(a[0]) - score(b[0]) || a[0].length - b[0].length
    })
  if (candidates.length === 0) return null
  return { name: candidates[0][0], markdown: candidates[0][1] }
}

/* ------------------------------------------------------- 共享的后处理 */

/**
 * 把 MinerU 的 Markdown 拆成「页 → 文本」，供阅读器按页渲染。
 * MinerU 的 md 里没有可靠分页（HTML 里才有），所以这里按 `## ` 一级标题切成若干节，
 * 再给每节一个**估算页码**——明确标注为估算，不冒充精确页码。
 * 精确页码只在原生文本层路径上成立，这是两条路径的诚实差别。
 */
export function sectionsFromMarkdown(markdown) {
  const lines = markdown.split('\n')
  const sections = []
  let current = { title: '正文', text: '' }
  for (const line of lines) {
    const heading = /^#{1,2}\s+(.{1,80})$/.exec(line)
    if (heading && current.text.trim()) {
      sections.push(current)
      current = { title: heading[1].trim(), text: '' }
      continue
    }
    if (heading && !current.text.trim()) {
      current.title = heading[1].trim()
      continue
    }
    current.text += line + '\n'
  }
  if (current.text.trim()) sections.push(current)

  // 统计每节字符数，按累计占比估算页码（假定成书式线性分布）
  const total = sections.reduce((n, s) => n + s.text.length, 0) || 1
  let acc = 0
  return sections.map((s, i) => {
    const startRatio = acc / total
    acc += s.text.length
    return {
      index: i + 1,
      title: s.title,
      text: s.text.trim(),
      // 估算值：调用方必须原样展示「约第 N 页」，不得当作精确页码使用
      approxPage: Math.max(1, Math.round(startRatio * 100) / 100),
    }
  })
}

/* --------------------------------------------------------------- 本地通道 */

/**
 * 把 fetch 的底层报错翻译成用户能照做的提示。
 *
 * `fetch failed` 是 Node 在连接阶段失败时抛的通用消息，它不告诉你「连不上谁、该怎么办」。
 * 实测用户看到的就是这一句，完全无从下手 —— 而真实原因是本机根本没跑 MinerU。
 */
function explainNetworkError(error, base) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code ?? ''
  const host = base.replace(/^https?:\/\//, '')
  if (code === 'ECONNREFUSED') {
    return new Error(
      `没有找到 MinerU 软件：${host} 上没有任何服务在运行。\n`
      + '这表示本机还没装 MinerU（或装了但没启动）。\n'
      + '两个选择：① 安装并启动（如 `mineru-kit api-server --host 127.0.0.1 --port 8000`）；'
      + '② 直接关掉 MinerU —— 不装它也能正常读论文，只有扫描件和公式乱码时才需要它。',
    )
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`没有找到 MinerU 软件：地址 ${host} 无法解析，请检查设置里的地址是否写错。`)
  }
  if (code === 'ETIMEDOUT' || error?.name === 'AbortError') {
    return new Error(`连接 ${host} 超时。若 MinerU 确实在跑，首次加载模型可能较慢，请稍后重试；用不上就关掉它。`)
  }
  return new Error(`调用本地 MinerU 失败（${host}）：${error?.message ?? error}${code ? `（${code}）` : ''}`)
}

/**
 * 本地 MinerU 服务（magic-pdf / mineru-kit）解析。
 * 兼容两种返回：新版返回 zip（attachment），老版返回 JSON { md_content }。
 */
export async function parseLocal(pdfPath, options = {}) {
  const base = (options.url || 'http://127.0.0.1:8000').replace(/\/+$/, '')
  const buffer = await fsp.readFile(pdfPath)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), path.basename(pdfPath))
  form.append('return_md', 'true')
  form.append('return_content_list', 'false')
  form.append('return_images', 'false')
  if (options.lang) form.append('lang', options.lang)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15 * 60_000)
  try {
    let res
    try {
      res = await fetch(`${base}/file_parse`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
    } catch (networkError) {
      // 连接阶段的失败在这里统一翻译成人话，别让 `fetch failed` 直接冒到界面上
      throw explainNetworkError(networkError, base)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`本地 MinerU 返回 ${res.status}${detail ? `：${detail.slice(0, 300)}` : ''}。请确认 mineru-kit api-server 已在 ${base} 运行。`)
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (/json/i.test(contentType)) {
      const data = await res.json()
      const markdown = data.md_content ?? data.markdown ?? data.md ?? ''
      if (!markdown) throw new Error('本地 MinerU 返回的 JSON 里没有 md_content 字段')
      return { markdown, source: 'mineru-local', filename: null }
    }
    const zipBuffer = await res.arrayBuffer()
    const files = await unzipTextFiles(zipBuffer)
    const picked = pickMarkdown(files)
    if (!picked) throw new Error('本地 MinerU 返回的压缩包里没有 Markdown 文件')
    return { markdown: picked.markdown, source: 'mineru-local', filename: picked.name }
  } finally {
    clearTimeout(timer)
  }
}

/* --------------------------------------------------------------- 云端通道 */

function cloudHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
  }
}

async function cloudJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`MinerU 云端返回非 JSON（${res.status}）：${text.slice(0, 200)}`) }
  if (res.status === 401 || data.code === 'A0202' || data.code === 'A0211') {
    throw new Error('MinerU 云端 token 无效或已过期，请到 https://mineru.net/user-center/api-token 重新获取并填入插件设置。')
  }
  if (data.code !== 0) {
    const hint = data.code === -60018 ? '（今日免费额度已用完）'
      : data.code === -60005 ? '（文件超过 200MB）'
        : data.code === -60006 ? '（超过 600 页上限）' : ''
    throw new Error(`MinerU 云端错误 ${data.code}${hint}：${data.msg ?? '未知错误'}`)
  }
  return data.data
}

/**
 * 云端精确解析：批量上传 → PUT → 轮询 → 下载 zip。
 * 单文件也走 batch（官方对本地文件只有这条路）。
 */
export async function parseCloud(pdfPath, options = {}) {
  const token = options.token
  if (!token) throw new Error('未配置 MinerU 云端 token。请到插件设置填写，或把 MinerU 模式切到「本地」。')
  const buffer = await fsp.readFile(pdfPath)
  const filename = path.basename(pdfPath)

  // 1) 申请上传地址
  const created = await cloudJson(`${CLOUD_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: cloudHeaders(token),
    body: JSON.stringify({
      enable_formula: true,
      enable_table: true,
      language: options.lang ?? 'ch',
      model_version: options.modelVersion ?? 'vlm',
      files: [{ name: filename, data_id: 'zotero-reader' }],
    }),
  })
  const batchId = created.batch_id
  const uploadUrl = created.file_urls?.[0]
  if (!batchId || !uploadUrl) throw new Error('MinerU 云端未返回 batch_id / 上传地址')

  // 2) PUT 上传（不要带 Content-Type，否则对象存储签名校验失败）
  const put = await fetch(uploadUrl, { method: 'PUT', body: buffer })
  if (!put.ok) throw new Error(`上传 PDF 到 MinerU 失败：HTTP ${put.status}`)

  // 3) 轮询
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000)
  let zipUrl = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, options.pollMs ?? 3000))
    const result = await cloudJson(`${CLOUD_BASE}/extract-results/batch/${batchId}`, {
      method: 'GET',
      headers: cloudHeaders(token),
    })
    const entry = result.extract_result?.[0]
    if (!entry) continue
    if (entry.state === 'failed') {
      throw new Error(`MinerU 云端解析失败：${entry.err_msg || '未给出原因'}`)
    }
    if (entry.state === 'done' && entry.full_zip_url) { zipUrl = entry.full_zip_url; break }
  }
  if (!zipUrl) throw new Error('MinerU 云端解析超时，请稍后重试或改用本地通道。')

  // 4) 下载并解压
  const zipRes = await fetch(zipUrl)
  if (!zipRes.ok) throw new Error(`下载 MinerU 结果失败：HTTP ${zipRes.status}`)
  const files = await unzipTextFiles(await zipRes.arrayBuffer())
  const picked = pickMarkdown(files)
  if (!picked) throw new Error('MinerU 云端的压缩包里没有 Markdown 文件')
  return { markdown: picked.markdown, source: 'mineru-cloud', filename: picked.name }
}

/** 按配置选通道。 */
export async function parseWithMineru(pdfPath, config = {}) {
  const mode = config.mineruMode ?? 'none'
  if (mode === 'local') return parseLocal(pdfPath, { url: config.mineruLocalUrl })
  if (mode === 'cloud') return parseCloud(pdfPath, { token: config.mineruCloudToken })
  throw new Error('未启用 MinerU。请在插件设置里把 MinerU 模式设为「本地」或「云端」。')
}
