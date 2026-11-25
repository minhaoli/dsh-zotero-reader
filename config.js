/**
 * 配置 schema。
 *
 * 这个导出有两个作用：
 *   1. Host 激活插件时按它校验 profile 里的 `config`（写错会在加载期报错，而不是运行到一半才炸）；
 *   2. 让宿主的 Config inspect 能读出字段说明。
 *
 * 注意它**不会**自动生成配置表单：DSH 插件页的配置页由插件自己注册 slot
 * （本插件的浏览器半边注册了 `plugins.row.config`），读取/保存走 `/zotero-reader/config`，
 * 保存由 Host 用 `ctx.configEditor.edit()` 写回 profile patch，改完由宿主重载插件生效。
 *
 * 为什么用动态 import + 兜底路径：本插件是 link 安装，模块解析不会向上走到
 * profile 的 node_modules，直接 `import '@deepseek-ai/schemastery'` 会
 * ERR_MODULE_NOT_FOUND（实测）。而 Host 确实从这个包读 schema，
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

/** 单个功能的模型覆盖：三项都留空 = 跟随会话当前模型。 */
function featureSchema(label) {
  return z.object({
    provider: z.string().description(`${label}的 provider；留空跟随会话`).default(''),
    model: z.string().description(`${label}的 model；留空跟随会话`).default(''),
    reasoningEffort: z.string().description(`${label}的推理档位；留空用模型默认`).default(''),
  })
}

export const Config = z
  ? z.object({
    zoteroDataDir: z.string().description('Zotero 数据目录；留空则自动探测').default(''),
    dataDir: z.string().description('缓存目录；留空则在 ~/.dsh-zotero-reader').default(''),

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
    mineruTokenEnv: z.string()
      .description('MinerU 云端 token 的**环境变量名**（值从 DSH 启动时加载的 .env / 系统环境读取）')
      .default('MINERU_API_TOKEN'),
    mineruAutoOnScanned: z.boolean().description('扫描件自动改用 MinerU').default(true),

    /**
     * Zotero 云端 Web API（api.zotero.org）。
     *
     * 与 Zotero 10+ 本地 API 的授权 key 完全无关：后者由 host/annotations.js 自动申请并
     * 持久化在 dataDir/zotero-api-key.json，不需要用户填。这里只存**环境变量名**，
     * 值放在 ~/.dsh/.env 的 ZOTERO_API_KEY 里。
     */
    cloudApiKeyEnv: z.string()
      .description('Zotero 云端 Web API key 的环境变量名（默认 ZOTERO_API_KEY）')
      .default('ZOTERO_API_KEY'),
    cloudUserID: z.string().description('Zotero 云端 userID（数字 ID，可在同一页面看到）').default(''),

    /** 向量检索用的 embedding key：同样只存变量名，值放 .env。 */
    embeddingApiKeyEnv: z.string()
      .description('Embedding API key 的环境变量名（默认 SILICONFLOW_API_KEY）')
      .default('SILICONFLOW_API_KEY'),

    /** 各功能的模型覆盖：`{ translate|explain|ask: { provider, model, reasoningEffort } }`。 */
    features: z.object({
      translate: featureSchema('划词翻译'),
      explain: featureSchema('解释'),
      ask: featureSchema('提问'),
    }).description('各功能的模型覆盖；三项都留空表示跟随会话当前模型').default({}),

    /**
     * 划词翻译的推理档位回退序列（原来硬编码在 host/translate.js）。
     * `null` 是合法元素，表示「模型默认」，所以用 union 而不是纯 string 数组。
     */
    translateEfforts: z.array(z.union([z.string(), z.const(null)]))
      .description('划词翻译的推理档位回退序列；null 表示模型默认。默认 off → low → 模型默认')
      .default(['off', 'low', null]),
  })
  : undefined

export default Config
