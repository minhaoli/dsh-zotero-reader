/**
 * 配置 schema。
 *
 * 为什么需要它：不导出 `Config`，宿主的插件页就不会渲染任何设置表单
 * （`listConfigs` 里 status 是 `absent`）。MinerU 模式这类开关必须能让用户改，
 * 否则只能改 YAML —— 用户实际上就是被卡在这里。
 *
 * 为什么用动态 import + 兜底路径：本插件是 link 安装，模块解析不会向上走到
 * profile 的 node_modules，直接 `import '@deepseek-ai/schemastery'` 会
 * ERR_MODULE_NOT_FOUND（实测）。而宿主的插件页确实从这个包读 schema，
 * 所以按「先正常 import，再试 profile 绝对路径」两段来取。
 *
 * 取不到时导出 `undefined`：宿主显示「无配置」而不是崩溃，插件本身照常工作。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadSchemaModule() {
  // 1) 常规解析：打包安装或依赖被提升时走这条
  try {
    const mod = await import('@deepseek-ai/schemastery')
    return mod.default ?? mod
  } catch { /* 落到下一条 */ }

  /**
   * 2) link 安装：模块解析不会向上走到 profile 的 node_modules，必须直接指过去。
   *
   * 注意不能硬编码 `lib/index.js` —— 这个包的入口是 `lib/index.mjs`
   * （package.json 的 exports 里写明 import → ./lib/index.mjs），
   * 猜错入口会让 export 变成 undefined，宿主于是显示「无配置」。
   * 所以这里读 package.json 的 exports，取它的 import 入口。
   */
  const home = process.env['USERPROFILE'] || process.env['HOME'] || ''
  if (!home) return null
  const dir = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery')
  try {
    const { default: fsp } = await import('node:fs/promises')
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    const entry = pkg?.exports?.['.']?.import
      ?? pkg?.module
      ?? pkg?.main
      ?? 'lib/index.mjs'
    const mod = await import(pathToFileURL(path.join(dir, entry)).href)
    return mod.default ?? mod
  } catch {
    return null
  }
}

const z = await loadSchemaModule()

export const Config = z
  ? z.object({
    zoteroDataDir: z.string().description('Zotero 数据目录；留空则自动探测').default(''),
    dataDir: z.string().description('缓存目录；留空则在 ~/.dsh-zotero-reader').default(''),

    translateConcurrency: z.number().description('翻译并发数').min(1).max(16).default(4),
    translateChunkChars: z.number().description('翻译分段字符数').min(500).max(8000).default(2400),
    selectionProvider: z.string().description('划词翻译的 provider；留空跟随宿主模型').default(''),
    selectionModel: z.string().description('划词翻译的 model；留空跟随宿主模型').default(''),

    mineruMode: z
      .union([
        z.const('none').description('关闭'),
        z.const('local').description('本地服务'),
        z.const('cloud').description('云端 API'),
      ])
      .description('MinerU 增强模式：扫描件或公式乱码时用它重新解析')
      .default('none'),
    mineruLocalUrl: z.string().description('本地 MinerU 服务地址').default('http://127.0.0.1:8000'),
    mineruCloudToken: z.string()
      .description('MinerU 云端 token（mineru.net 用户中心获取）')
      .role('secret')
      .default(''),
    mineruAutoOnScanned: z.boolean().description('扫描件自动改用 MinerU').default(true),
  })
  : undefined

export default Config
