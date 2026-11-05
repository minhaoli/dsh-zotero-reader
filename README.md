# dsh-zotero-reader — Zotero 伴读

**中文** | [English](README.en.md)

在 DSH 右侧栏里读 Zotero 的本地 PDF：带页码的问答、原文大纲、以及和 Zotero 互通的批注。

## 解决什么问题

在 DSH 里做研究时，文献都在 Zotero 里，但读的时候要在两个应用之间来回切：想引用某段话，得手动记页码；想知道某篇讲了什么，得先自己翻一遍；在 Zotero 里划过的高亮，在别处读时又看不到。

这个插件让 AI 能直接读你 Zotero 库里的 PDF，并把内容按页对上：

- 让 AI 搜你的 Zotero 库，它返回的每篇都带 `itemKey`，在回答里写成 `zotero://<key>` 就能点开读
- 右侧栏打开 PDF，问答时能精确引用「第 N 页」，点页码跳回原文并高亮
- 大纲从 PDF 文本层按字号提取，章节结构原样呈现
- 在 PDF 里划词可以翻译、解释，或写回 Zotero 变成高亮

## 功能

| 功能 | 说明 |
|---|---|
| 文献检索工具 | `search_zotero_library` / `read_zotero_paper` / `ask_zotero_paper`，供模型调用 |
| 右侧栏阅读器 | pdf.js 渲染，支持缩放、跳页、连续滚动 |
| 文献库浏览 | 589 篇按 Zotero 专题树两级展开，可搜索；另有「本次搜索」视图 |
| 带页码问答 | 片段来自文本层，页码即真实页码；回答里的页码可点击跳转 |
| 大纲 | 按字号判标题层级（比按行长/词表可靠），一键跳到章节 |
| 划词动作 | 译 / 解 / 问 / 高亮 |
| 批注互通 | 读取并显示 Zotero 已有批注；划词可写回 Zotero |
| 多 PDF 并行 | 每篇单独一个右栏 tab，页码/缩放各自独立 |
| MinerU（可选） | 扫描件或公式乱码时用它重解析，默认关闭 |

## 安装

在 DSH 的 profile 目录里执行：

```bash
npm i minhaoli/dsh-zotero-reader
```

这会把插件和它的依赖（`pdfjs-dist`）一起装进 `node_modules`，不需要手动 clone，也不用再单独跑 `npm i`。

然后把 bundle 加进 profile 的 `package.json`（依赖项 npm 已经写好了）：

```json
{
  "dsh": { "profile": { "bundles": ["...已有的...", "dsh-zotero-reader"] } }
}
```

重启 DSH，右栏「开始」页会出现「Zotero 伴读」卡片。

升级到新版本：重跑同一条 `npm i minhaoli/dsh-zotero-reader` 即可。

### 从本地目录开发

要改代码时，用 link 指向源码目录，改完重载插件就生效：

```json
{ "dependencies": { "dsh-zotero-reader": "link:D:/path/to/dsh-zotero-reader" } }
```

这种方式下依赖要自己在插件目录里装一次：`npm i`。

## 配置

配置项在插件的 `cordis.patch.yml` 里，也可以在阅读器工具栏的 ⚙ 面板里改（即时生效，存到 `~/.dsh-zotero-reader/settings.json`）。

| 项 | 默认 | 说明 |
|---|---|---|
| `zoteroDataDir` | 自动探测 | Zotero 数据目录（含 `zotero.sqlite`） |
| `mineruMode` | `none` | `none` / `local` / `cloud` |
| `mineruLocalUrl` | `http://127.0.0.1:8000` | 本地 MinerU 服务地址 |
| `mineruCloudToken` | 空 | mineru.net 的 token |
| `mineruAutoOnScanned` | `true` | 扫描件自动改用 MinerU |
| `selectionProvider` / `selectionModel` | 空 | 划词用的模型；留空跟随宿主 |

### 关于批注写入

写回 Zotero 走的是 [Zotero 本地 API](https://www.zotero.org/support/dev/web_api/v3/local_api)，需要：

1. **Zotero 10 或更高**（7/8 的本地 API 只读）
2. 打开 Zotero，在 设置 → 高级 里勾选「允许此计算机上的其他应用程序与 Zotero 通信」
3. 第一次写入时 Zotero 会弹框确认，选「Allow」或「Always Allow」

读取已有批注不受这些限制，用数据库快照即可，Zotero 开着也能读。

## 数据落在哪

- 设置与缓存：`~/.dsh-zotero-reader/`（`settings.json`、`cache/`、`translate/`）
- 不会改动 Zotero 的数据库；写入一律经 Zotero 本地 API，由 Zotero 自己完成索引与同步

## 开发

```bash
node --check index.js          # 语法检查
node test/host-e2e.mjs         # 主机侧端到端（需要本机有 Zotero 库）
```

`test/host-e2e.mjs` 走真实代码路径：用最小 proxy ctx 跑 `apply()`，抓到 `webServer.register` 的 handler 再用假 req/res 调用。

## 已知限制

- 页码：原生文本层路径页码精确；经 MinerU 重排的文件页码是估算值，界面会标「≈」
- 跨页选择只取第一页那部分（Zotero 的批注本身按页存）
- 批注写入依赖 Zotero 10+ 的本地 API；不满足时「高亮」按钮会禁用并说明原因
- 大纲对极端排版（标题与正文同字号）会退化为按章节词识别

## 致谢与来源

本插件在实现方式上参考了 [@ggboy123/dsh-paper-reader](https://github.com/GGboya/dsh-paper-reader)（作者 GGboya，MIT 许可）。它是我在本插件之前实际使用的论文阅读插件，卸载它之后才有了重做一份的想法。

本仓库**未复制该项目的源代码**（不含来自它的任何文件）。参考之处：工具声明的规整形态（`host/define-tool.js`）、右栏 tab 的注册方式与 `guide` 入口卡片（`client.js`）、以及 pdf.js 的取用思路。

依据 MIT 许可证「须在副本或实质部分中保留版权声明与许可声明」的要求，下面原样收录其版权声明与完整许可证文本；第三方依赖 pdf.js（Apache-2.0）的声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

**Upstream**: https://github.com/GGboya/dsh-paper-reader
**Version referenced**: 1.7.0
**License**: MIT

```text
Copyright (c) 2026 GGboya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## License

[MIT](LICENSE)。

本插件在运行时使用 [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0，作为 `pdfjs-dist` 依赖由 npm 安装，不随本仓库分发）。
