// dsh-zotero-reader — 右侧栏阅读器（浏览器半边）。
//
// 装配方式全部走官方 seam，不劫持任何别人的槽位：
//   · 注册一个右栏 tab 类型（sidebarRightTabs）+ 同 key 的 tab 内容（sidebar.right.pane.tab）
//   · 打开入口有两个：① 用户在会话里点 `zotero://<key>` 链接；② 右栏 tab 里的文献列表
//
// 来源说明：右栏 tab 的注册方式（含 guide 字段生成入口卡片）参考了
// @ggboy123/dsh-paper-reader（MIT，https://github.com/GGboya/dsh-paper-reader）。
// 代码为本插件自行实现，未复制其源码。
//
// 「在会话里识别搜出来的文章」不靠监听消息：
//   工具返回的每条结果都带 itemKey，模型把它写成 zotero://<key>。前端只是在 document 上
//   挂一个捕获阶段的 click 委托，认得这个 scheme 就打开对应 PDF。既不拦截渲染，也不改消息。
//
// PDF 渲染用 pdfjs 的**同一个包**（宿主已装）——不内嵌一份 3MB 的 pdf.js，也不自建路由页面。

window.__ModuleLoader__.load({
  id: 'dsh-zotero-reader',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, useMemo } = React
    const h = React.createElement

    const NS = 'dsh-zotero-reader'
    const TAB_KEY = 'zotero-reader'
    /** 与 host 侧 ROUTE_PREFIX 一致。 */
    const API = '/zotero-reader'
    /** 会话消息里可点击的文献链接。 */
    const SCHEME_RE = /^zotero:\/\/([A-Z0-9]{8})$/i

    /* ------------------------------------------------------------ i18n */

    const zh = {
      title: 'Zotero',
      pdfTab: 'Zotero',
      guideDesc: '浏览 Zotero 全部文献，或回到本次对话搜过的文章',
      tabLibrary: '全部文献库',
      tabSearched: '本次搜索',
      searchedEmpty: '这次对话还没搜过 Zotero 文献。让 AI 搜一下，命中的文章会出现在这里。',
      uncategorized: '未分类',
      libStat: '共 {{total}} 篇有 PDF',
      empty: '让 AI 搜索你的 Zotero 文献，搜到的文章会出现在这里；点一篇即可开始阅读。',
      browse: '浏览文献库',
      searchPlaceholder: '搜索标题、作者、期刊…',
      loading: '正在加载 PDF…',
      loadFailed: 'PDF 加载失败',
      pageOfTotal: '第 {{page}} / {{total}} 页',
      prevPage: '上一页',
      nextPage: '下一页',
      zoomIn: '放大',
      zoomOut: '缩小',
      fitWidth: '适应宽度',
      translateSelection: '翻译',
      askSelection: '询问',
      explainSelection: '解释',
      mineruRunning: 'MinerU 解析中…',
      sourceLocal: '本地文本层',
      sourceMineruLocal: '本地 MinerU',
      sourceMineruCloud: '云端 MinerU',
      approxPages: '页码为估算值',
      close: '关闭',
      noText: '这一页没有可提取的文字（可能是扫描页）',
      selectionEmpty: '选中文本后再点按钮',
      outline: '大纲',
      settings: '设置',
      annotations: '批注',
      annotEmpty: '这篇文献在 Zotero 里还没有批注。划选文字后点「高亮」即可添加。',
      annotCannotWrite: '暂时不能写入 Zotero',
      annotNeedSelection: '请选中 PDF 里的文字再高亮',
      annotSaved: '已保存到 Zotero',
      annotColor: '高亮颜色',
      highlightSelection: '高亮',
      mineruTitle: 'MinerU 增强解析',
      mineruHint: 'PDF 文本层把公式拆碎时会用到；扫描件可选。不装也能正常读论文。',
      mineruNone: '关闭',
      mineruNoneDesc: '只用 PDF 自带文本层（最快，公式可能碎）',
      mineruLocal: '本地服务',
      mineruLocalDesc: '需要本机跑着 MinerU（mineru-kit api-server）',
      mineruCloud: '云端 API',
      mineruCloudDesc: '需要 mineru.net 的 token，按页计费',
      mineruLocalUrl: '本地服务地址',
      mineruToken: '云端 token',
      mineruTokenSet: '已保存（重新输入可覆盖）',
      mineruTokenPlaceholder: '粘贴 mineru.net 的 API token',
      mineruTokenHint: '在 mineru.net 用户中心 → API 管理里获取',
      mineruAuto: '扫到扫描件时自动改用 MinerU',
      testConnection: '测试连接',
      testing: '测试中…',
      testOk: '连接正常',
      testFail: '连接失败',
      saving: '保存中…',
      dataDirLabel: '数据目录',
      refresh: '刷新',
      configHint: '在设置里配置 MinerU 或 Zotero 路径',
      searchNoResult: '没有匹配的文献',
      translatingFailed: '翻译失败',
      selectionFailed: '翻译失败',
    }
    const en = {
      title: 'Zotero Paper Reader',
      pdfTab: 'Paper',
      guideDesc: 'Browse the whole Zotero library, or return to papers found in this conversation',
      tabLibrary: 'Library',
      tabSearched: 'Found here',
      searchedEmpty: 'No Zotero papers searched in this conversation yet.',
      uncategorized: 'Uncategorized',
      libStat: '{{total}} papers with PDF',
      empty: 'Ask the assistant to search your Zotero library; results appear here. Click one to read.',
      browse: 'Browse library',
      searchPlaceholder: 'Search title, author, journal…',
      loading: 'Loading PDF…',
      loadFailed: 'Failed to load PDF',
      pageOfTotal: 'Page {{page}} of {{total}}',
      prevPage: 'Previous',
      nextPage: 'Next',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fitWidth: 'Fit width',
      translateSelection: 'Translate',
      askSelection: 'Ask',
      explainSelection: 'Explain',
      mineruRunning: 'Parsing with MinerU…',
      sourceLocal: 'Local text layer',
      sourceMineruLocal: 'Local MinerU',
      sourceMineruCloud: 'Cloud MinerU',
      approxPages: 'Page numbers are approximate',
      close: 'Close',
      noText: 'No extractable text on this page (possibly scanned)',
      selectionEmpty: 'Select some text first',
      outline: 'Outline',
      settings: 'Settings',
      annotations: 'Annotations',
      annotEmpty: 'No annotations yet. Select text and click Highlight to add one.',
      annotCannotWrite: 'Cannot write to Zotero right now',
      annotNeedSelection: 'Select text in the PDF first',
      annotSaved: 'Saved to Zotero',
      annotColor: 'Highlight color',
      highlightSelection: 'Highlight',
      mineruTitle: 'MinerU enhanced parsing',
      mineruHint: 'Useful when the PDF text layer shreds formulas; required for scanned PDFs. Optional.',
      mineruNone: 'Off',
      mineruNoneDesc: 'Use the PDF text layer only (fastest, formulas may be broken)',
      mineruLocal: 'Local service',
      mineruLocalDesc: 'Requires MinerU running locally (mineru-kit api-server)',
      mineruCloud: 'Cloud API',
      mineruCloudDesc: 'Requires a mineru.net token, billed per page',
      mineruLocalUrl: 'Local service URL',
      mineruToken: 'Cloud token',
      mineruTokenSet: 'Saved (re-enter to replace)',
      mineruTokenPlaceholder: 'Paste your mineru.net API token',
      mineruTokenHint: 'Get it from mineru.net → User center → API',
      mineruAuto: 'Auto-switch to MinerU for scanned PDFs',
      testConnection: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection OK',
      testFail: 'Connection failed',
      saving: 'Saving…',
      dataDirLabel: 'Data directory',
      refresh: 'Refresh',
      configHint: 'Configure MinerU or the Zotero path in settings',
      searchNoResult: 'No matching papers',
      translatingFailed: 'Translation failed',
      selectionFailed: 'Translation failed',
    }

    /* -------------------------------------------------------- 工具函数 */

    const escapeHtml = (text) => text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

    /** 从右栏 tab 的 key 里取 itemKey（形如 `zotero-reader:ABCD1234`）。 */
    function keyFromTabKey(tabKey) {
      const m = /:([A-Z0-9]{8})$/i.exec(tabKey ?? '')
      return m ? m[1].toUpperCase() : null
    }

    async function fetchJson(url, init) {
      const res = await fetch(url, { credentials: 'same-origin', ...init })
      const text = await res.text()
      let data
      try { data = text ? JSON.parse(text) : {} } catch { throw new Error(text.slice(0, 200) || `HTTP ${res.status}`) }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      return data
    }

    /* ------------------------------------------------------ pdfjs 加载 */

    /**
     * 从插件自己的路由取 pdf.js。
     *
     * 两个坑都在这里：
     *
     * 1. 不能用 `require('pdfjs-dist')` —— 那依赖「宿主里恰好装着这个包」，而这以前是
     *    paper-reader 带来的，删掉它之后宿主里就没有了（实测报「找不到 pdfjs-dist」）。
     *    所以改成插件自带一份、由 /vendor/ 路由发出去。
     *
     * 2. 也不能直接 `import('/zotero-reader/vendor/pdf.mjs')` —— 本插件是被宿主以
     *    模块方式装载的，动态 import 的相对基准是**模块自身**，实测被解析成
     *    `dsh-app://app/zotero-reader/vendor/pdf.mjs` 而失败。`fetch` 走的是页面源，
     *    所以先 fetch 成文本、再造 blob URL 来 import，彻底绕开模块基准问题。
     *
     * worker 同样用 blob：pdf.js 会按 workerSrc 去创建 Worker，跨 scheme 会失败。
     */
    let pdfjsPromise = null
    let workerUrl = null

    async function importFromSource(pathname) {
      const res = await fetch(pathname, { credentials: 'same-origin' })
      if (!res.ok) {
        /**
         * 必须把响应体读出来带上。
         * 只报 `HTTP 400` 的话，服务端到底说了「未知路径」「unauthorized」还是某条异常
         * 全都看不见 —— 这次排查在这一点上绕了好几圈（实测教训）。
         */
        let detail = ''
        try {
          const body = await res.text()
          detail = body ? `：${body.slice(0, 200)}` : ''
        } catch { /* 读不出来就只报状态码 */ }
        throw new Error(`HTTP ${res.status} ${pathname}${detail}`)
      }
      const code = await res.text()
      const blob = new Blob([code], { type: 'text/javascript' })
      return URL.createObjectURL(blob)
    }

    function getPdfjs() {
      if (!pdfjsPromise) {
        pdfjsPromise = (async () => {
          const moduleUrl = await importFromSource(`${API}/vendor/pdf.mjs`)
          const mod = await import(/* @vite-ignore */ moduleUrl)
          const lib = mod.getDocument ? mod : mod.default
          if (!lib?.getDocument) throw new Error('pdf.js 资源加载异常：模块里没有 getDocument')
          try {
            if (!workerUrl) workerUrl = await importFromSource(`${API}/vendor/pdf.worker.mjs`)
            lib.GlobalWorkerOptions.workerSrc = workerUrl
          } catch { /* 拿不到 worker 就退化为主线程解析，仍能显示，只是大文件慢一点 */ }
          return lib
        })().catch((error) => {
          pdfjsPromise = null
          throw new Error(`加载 pdf.js 失败：${error.message}`)
        })
      }
      return pdfjsPromise
    }

    /* ----------------------------------------------------------- 样式 */

    const CSS = `
      .zr-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsh-text-primary,#e6e6e6);background:var(--dsh-bg-primary,#1b1b1b)}
      .zr-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsh-border,#333);flex:0 0 auto;flex-wrap:wrap}
      .zr-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
      .zr-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;border:1px solid var(--dsh-border,#3a3a3a);background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1.6}
      .zr-btn:hover:not(:disabled){background:var(--dsh-bg-hover,rgba(255,255,255,.08))}
      .zr-btn:disabled{opacity:.45;cursor:default}
      .zr-btn[data-on="1"]{background:var(--dsh-accent,#3d6af2);border-color:transparent;color:#fff}
      .zr-page{flex:1 1 auto;overflow:auto;padding:8px;min-height:0;position:relative}
      /*
       * 浮层锚点层：绝对定位覆盖整个阅读区，但**不接收鼠标事件**（pointer-events:none），
       * 所以不会挡住滚动、选中文本；它的子面板各自 pointer-events:auto。
       *
       * 关键点：这一层直接挂在根容器上（而不是 .zr-page 滚动容器里），
       * 因此 PDF 滚到第几页它都待在原地 —— 大纲不会再「只附在第一页」。
       */
      .zr-root{position:relative}
      .zr-page-anchors{position:absolute;inset:0;pointer-events:none;z-index:20}
      .zr-page-anchors > *{pointer-events:auto}
      .zr-canvas-wrap{display:flex;flex-direction:column;gap:10px;align-items:center}
      .zr-pagebox{position:relative;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.4);line-height:0}
      .zr-pagebox canvas{display:block;max-width:100%;height:auto}
      .zr-textlayer{position:absolute;inset:0;overflow:hidden;line-height:1;opacity:.25}
      .zr-textlayer span{position:absolute;color:transparent;white-space:pre;transform-origin:0 0;cursor:text}
      .zr-textlayer span::selection{background:rgba(61,106,242,.55);color:transparent}
      .zr-textlayer span::-moz-selection{background:rgba(61,106,242,.55)}
      .zr-pagemark{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.55);color:#fff;padding:1px 6px;border-radius:4px;font-size:11px;line-height:1.5}
      .zr-hl{position:absolute;background:rgba(255,196,0,.42);border-radius:2px;pointer-events:none;mix-blend-mode:multiply}
      .zr-note{padding:10px 12px;color:var(--dsh-text-secondary,#9aa0a6);font-size:12px;line-height:1.7}
      .zr-err{padding:10px 12px;color:#ff8a80;font-size:12px;line-height:1.7}
      .zr-list{overflow:auto;flex:1 1 auto;min-height:0;padding:4px 0}
      .zr-lib-head{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsh-border,#333);flex:0 0 auto}
      .zr-lib-tabs{display:flex;gap:4px}
      .zr-lib-tab{flex:1 1 0;min-width:0;padding:5px 8px;font-size:12px;cursor:pointer;border-radius:6px;
        border:1px solid transparent;background:transparent;color:var(--dsh-text-secondary,#9a9a9a)}
      .zr-lib-tab[data-on="1"]{background:var(--dsh-bg-hover,#2b2b2b);color:var(--dsh-text-primary,#e6e6e6);
        border-color:var(--dsh-border,#3a3a3a);font-weight:600}
      .zr-lib-search{display:flex;gap:6px;align-items:center}
      .zr-input{flex:1 1 auto;min-width:0;background:transparent;color:inherit;font-size:12px;
        border:1px solid var(--dsh-border,#3a3a3a);border-radius:6px;padding:4px 8px}
      .zr-lib-stat{padding:6px 12px;font-size:11px;color:var(--dsh-text-tertiary,#7a7a7a)}
      /**
       * 字号层级：一级类 > 二级类 > 论文标题 > 作者/年份。
       * 层级靠字号 + 缩进一起表达，缩进每级约 1 个 tab（16px），子项比父项多缩进一格。
       */
      .zr-group-h{display:flex;align-items:center;gap:6px;padding:8px 12px;cursor:pointer;user-select:none;
        background:var(--dsh-bg-secondary,#232323);position:sticky;top:0;z-index:1}
      .zr-group-h[data-depth="0"]{padding-left:12px;background:var(--dsh-bg-primary,#1b1b1b)}
      .zr-group-h[data-depth="1"]{padding-left:28px;background:var(--dsh-bg-primary,#1b1b1b)}
      .zr-group-h[data-depth="2"]{padding-left:44px;background:var(--dsh-bg-primary,#1b1b1b)}
      .zr-group-h[data-depth="0"] .zr-group-n{font-weight:700;font-size:14px;color:var(--dsh-text-primary,#e6e6e6)}
      .zr-group-h[data-depth="1"] .zr-group-n{font-weight:600;font-size:13px;color:var(--dsh-text-primary,#d0d0d0)}
      .zr-group-h[data-depth="2"] .zr-group-n{font-weight:500;font-size:12.5px;color:var(--dsh-text-secondary,#b0b0b0)}
      .zr-group-h[data-depth="0"] .zr-group-c{font-size:12px}
      .zr-group-h[data-depth="1"] .zr-group-c{font-size:11.5px}
      .zr-group[data-depth="0"] .zr-item{padding-left:28px}
      .zr-group[data-depth="1"] .zr-item{padding-left:44px}
      .zr-group[data-depth="2"] .zr-item{padding-left:60px}
      .zr-group-n{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      .zr-group-c{font-size:11px;color:var(--dsh-text-tertiary,#7a7a7a);flex:0 0 auto}
      .zr-caret{font-size:10px;color:var(--dsh-text-tertiary,#7a7a7a);width:10px;flex:0 0 auto}
      .zr-item{padding:7px 12px;border-bottom:1px solid var(--dsh-border,#2a2a2a);cursor:pointer}
      .zr-item:hover{background:var(--dsh-bg-hover,rgba(255,255,255,.06))}
      .zr-item-t{font-weight:400;font-size:12px;line-height:1.45;margin-bottom:1px;
        color:var(--dsh-text-secondary,#c8c8c8)}
      .zr-item-m{color:var(--dsh-text-tertiary,#8a9096);font-size:10.5px;line-height:1.45}
      .zr-sel{position:fixed;z-index:60;display:flex;gap:4px;padding:4px;border-radius:8px;background:var(--dsh-bg-elevated,#2a2a2a);box-shadow:0 6px 22px rgba(0,0,0,.5);border:1px solid var(--dsh-border,#3a3a3a)}
      .zr-sel button{min-width:30px;height:26px;padding:0 8px;border-radius:6px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px}
      .zr-sel button:hover{background:rgba(255,255,255,.12)}
      .zr-pop{position:fixed;z-index:61;max-width:min(420px,80vw);max-height:50vh;overflow:auto;padding:10px 12px;border-radius:10px;background:var(--dsh-bg-elevated,#242424);border:1px solid var(--dsh-border,#3a3a3a);box-shadow:0 10px 30px rgba(0,0,0,.55);font-size:12.5px;line-height:1.75;white-space:pre-wrap;color:var(--dsh-text-primary,#eee)}
      .zr-pop-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;color:var(--dsh-text-secondary,#9aa0a6);font-size:11px}
      /* 大纲：绝对定位浮层，压在页面之上，不挤占正文（之前平铺在工具栏后把 PDF 顶上去了）。
         定位在 .zr-page 上（它已 position:relative），所以滚动页面不会带走它。 */
      .zr-outline{position:absolute;top:8px;right:8px;z-index:20;width:min(320px,72%);max-height:70%;
        overflow:auto;background:var(--dsh-bg-elevated,#262626);border:1px solid var(--dsh-border,#3a3a3a);
        border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5);padding:4px 0}
      .zr-outline-head{display:flex;align-items:center;gap:6px;padding:6px 10px 8px;
        border-bottom:1px solid var(--dsh-border,#3a3a3a);font-size:12px;font-weight:600;
        position:sticky;top:0;background:var(--dsh-bg-elevated,#262626);z-index:1}
      .zr-outline-head span{flex:1 1 auto;min-width:0}
      .zr-outline-row{padding:4px 12px;cursor:pointer;font-size:12px;color:var(--dsh-text-secondary,#b6b6b6);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* Zotero 批注高亮（已有批注）：颜色由内联 style 决定 */
      .zr-annot{position:absolute;border-radius:2px;pointer-events:auto;mix-blend-mode:multiply;cursor:pointer}
      .zr-annot-panel{position:absolute;top:8px;left:8px;z-index:21;width:min(340px,74%);max-height:74%;
        overflow:auto;background:var(--dsh-bg-elevated,#262626);border:1px solid var(--dsh-border,#3a3a3a);
        border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5);padding-bottom:6px}
      .zr-annot-row{padding:7px 12px;border-bottom:1px solid var(--dsh-border,#2f2f2f);cursor:pointer}
      .zr-annot-row:hover{background:var(--dsh-bg-hover,rgba(255,255,255,.07))}
      .zr-annot-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsh-text-tertiary,#8a9096);margin-bottom:2px}
      .zr-annot-dot{width:8px;height:8px;border-radius:2px;flex:0 0 auto;display:inline-block}
      .zr-annot-text{font-size:12px;line-height:1.5;color:var(--dsh-text-primary,#dcdcdc)}
      .zr-annot-comment{margin-top:3px;font-size:11px;line-height:1.5;color:var(--dsh-text-secondary,#9aa0a6);
        border-left:2px solid var(--dsh-border,#444);padding-left:7px}
      .zr-annot-colors{display:flex;align-items:center;gap:5px;padding:8px 12px 2px;flex-wrap:wrap}
      .zr-color-chip{width:16px;height:16px;border-radius:3px;border:2px solid transparent;cursor:pointer;padding:0}
      .zr-color-chip[data-on="1"]{border-color:var(--dsh-text-primary,#e6e6e6)}
      .zr-outline-row:hover{background:var(--dsh-bg-hover,rgba(255,255,255,.08));color:inherit}
      /* 设置面板：与大纲同一种浮层形态 */
      .zr-settings{position:absolute;top:8px;right:8px;z-index:22;width:min(360px,86%);max-height:78%;
        overflow:auto;background:var(--dsh-bg-elevated,#262626);border:1px solid var(--dsh-border,#3a3a3a);
        border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5)}
      .zr-settings-head{display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:12px;font-weight:600;
        border-bottom:1px solid var(--dsh-border,#3a3a3a);position:sticky;top:0;background:var(--dsh-bg-elevated,#262626);z-index:1}
      .zr-settings-head span{flex:1 1 auto;min-width:0}
      .zr-settings-body{padding:10px 12px 14px;display:flex;flex-direction:column;gap:8px}
      .zr-field-label{font-size:12px;font-weight:600;color:var(--dsh-text-primary,#e6e6e6)}
      .zr-field-hint{font-size:11px;color:var(--dsh-text-tertiary,#8a9096);line-height:1.6}
      .zr-radio{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;align-items:center;cursor:pointer;
        padding:7px 9px;border:1px solid var(--dsh-border,#3a3a3a);border-radius:7px}
      .zr-radio[data-on="1"]{border-color:var(--dsh-accent,#3d6af2);background:rgba(61,106,242,.10)}
      .zr-radio input{grid-row:1 / span 2;margin:0}
      .zr-radio-t{font-size:12px;font-weight:500}
      .zr-radio-d{font-size:11px;color:var(--dsh-text-tertiary,#8a9096);line-height:1.5}
      .zr-field{display:flex;flex-direction:column;gap:4px}
      .zr-settings-row{display:flex;gap:6px}
      .zr-check{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:var(--dsh-text-secondary,#b6b6b6)}
      .zr-empty{padding:28px 22px;color:var(--dsh-text-secondary,#9aa0a6);font-size:12.5px;line-height:1.8;text-align:center}
      .zr-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:zr-spin .8s linear infinite;vertical-align:-2px}
      @keyframes zr-spin{to{transform:rotate(360deg)}}
    `

    function useStyle() {
      useEffect(() => {
        const id = 'zr-style'
        if (document.getElementById(id)) return
        const el = document.createElement('style')
        el.id = id
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    /* ------------------------------------------------------- 主组件 */

    /**
     * @param {object} props 由宿主注入：tabKey / sessionId 等
     */
    function Reader(props) {
      const bound = props.bound ?? ((k) => k)
      const t = (key, vars) => {
        let text = bound(key)
        if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{{${k}}}`, String(v))
        return text
      }
      useStyle()

      const tabKey = props.tabKey ?? props.key ?? ''
      const [itemKey, setItemKey] = useState(() => keyFromTabKey(tabKey))
      /**
       * 有 itemKey 才直接进阅读；否则一律先给列表。
       * 之前的 bug：无论 tab 带不带 key 都从 browse 起，而点卡片开的是裸 key，
       * 于是用户看到的是「上次那篇」，而不是全部文献。
       */
      const [mode, setMode] = useState(() => (keyFromTabKey(tabKey) ? 'read' : 'browse'))
      const [err, setErr] = useState(null)

      // 监听「打开某一篇」的全局请求（会话里点 zotero:// 链接、或列表里点条目）
      useEffect(() => {
        const onOpen = (event) => {
          const key = event?.detail?.itemKey
          if (key) {
            setItemKey(String(key).toUpperCase())
            setMode('read')
            setErr(null)
          }
        }
        window.addEventListener('zotero-reader:open', onOpen)
        return () => window.removeEventListener('zotero-reader:open', onOpen)
      }, [])

      if (mode === 'read' && itemKey) {
        return h(PaperView, {
          itemKey,
          t,
          onBack: () => setMode('browse'),
          onError: (message) => setErr(message),
          topError: err,
        })
      }
      return h(LibraryView, {
        t,
        sessionId: props.sessionId,
        onPick: (key) => {
          /**
           * 每个 PDF 单独开一个右栏 tab，而不是在同一个 tab 里换内容。
           * 这样用户可以同时开着几篇对照读，每篇各自保留页码、缩放和滚动位置
           * （tab 用了 keepMounted，切回来不会被重置）。
           */
          if (openTabImpl) {
            openTabImpl(`${TAB_KEY}:${key}`)
            return
          }
          // 右栏接口拿不到时退回本 tab 内切换，至少还能读
          setItemKey(key)
          setMode('read')
          setErr(null)
        },
      })
    }

    /* ---------------------------------------------------- 文献库列表 */

    function LibraryView({ t, onPick, sessionId }) {
      /**
       * 两个来源，一个列表：
       *   · library  —— Zotero 全部文献（按用户自己的专题分组）
       *   · searched —— 本次会话里 AI 搜索命中过的文章（host 侧按 sessionId 记）
       * 用户要的是「能看全库，也能快速回到刚搜过的那几篇」，所以做成两个 tab。
       */
      const [tab, setTab] = useState('library')          // library | searched
      const [state, setState] = useState({ loading: true, items: [], collections: [], total: 0, error: null })
      const [query, setQuery] = useState('')
      const [debounced, setDebounced] = useState('')
      /**
       * 折叠状态存 localStorage：用户把哪一类展开过，下次打开还在那儿。
       * 按路径做 key（`父/子`），专题重命名后旧状态自然失效，不会串到别的分类上。
       */
      const STORAGE_KEY = 'dsh-zotero-reader:openGroups'
      const [openGroups, setOpenGroups] = useState(() => {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY)
          const parsed = raw ? JSON.parse(raw) : null
          return parsed && typeof parsed === 'object' ? parsed : {}
        } catch { return {} }
      })

      const toggleGroup = useCallback((path, next) => {
        setOpenGroups((prev) => {
          const merged = { ...prev, [path]: next }
          try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)) } catch { /* 隐私模式下会抛，忽略 */ }
          return merged
        })
      }, [])

      useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 260)
        return () => clearTimeout(timer)
      }, [query])

      const load = useCallback(async (q, which) => {
        setState((prev) => ({ ...prev, loading: true, error: null }))
        try {
          if (which === 'searched') {
            const sid = sessionId ?? 'default'
            const data = await fetchJson(`${API}/searched?sessionId=${encodeURIComponent(String(sid))}`)
            let items = data.items ?? []
            if (q) {
              const terms = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
              items = items.filter((item) => {
                const hay = `${item.title} ${item.publication} ${(item.authors ?? []).join(' ')}`.toLowerCase()
                return terms.every((term) => hay.includes(term))
              })
            }
            setState({ loading: false, items, collections: [], total: items.length, error: null })
            return
          }
          const url = q ? `${API}/library?q=${encodeURIComponent(q)}` : `${API}/library`
          const data = await fetchJson(url)
          setState({
            loading: false,
            items: data.items ?? [],
            collections: data.collections ?? [],
            total: data.withPdf ?? 0,
            matched: data.matched ?? (data.items ?? []).length,
            error: null,
            dataDir: data.dataDir,
          })
        } catch (error) {
          setState({ loading: false, items: [], collections: [], total: 0, error: error.message })
        }
      }, [sessionId])

      useEffect(() => { load(debounced, tab) }, [debounced, tab, load])

      // 切到「本次搜索」时，若有新命中要能看到，所以每次进入都重取
      useEffect(() => { if (tab === 'searched') load(debounced, 'searched') }, [tab])

      const header = h('div', { className: 'zr-lib-head' },
        h('div', { className: 'zr-lib-tabs' },
          h('button', {
            className: 'zr-lib-tab',
            'data-on': tab === 'library' ? '1' : '0',
            onClick: () => setTab('library'),
          }, t('tabLibrary')),
          h('button', {
            className: 'zr-lib-tab',
            'data-on': tab === 'searched' ? '1' : '0',
            onClick: () => setTab('searched'),
          }, t('tabSearched')),
        ),
        h('div', { className: 'zr-lib-search' },
          h('input', {
            value: query,
            onChange: (e) => setQuery(e.target.value),
            placeholder: t('searchPlaceholder'),
            className: 'zr-input',
          }),
          h('button', { className: 'zr-btn', onClick: () => load(debounced, tab), title: t('refresh') }, '⟳'),
        ),
      )

      const renderItem = (item) => h('div', {
        key: item.key,
        className: 'zr-item',
        onClick: () => onPick(item.key),
      },
      h('div', { className: 'zr-item-t' }, item.title),
      h('div', { className: 'zr-item-m' }, [
        (item.authors ?? []).slice(0, 3).join(', '),
        item.year,
        item.publication,
      ].filter(Boolean).join(' · ')),
      )

      if (state.error) {
        return h('div', { className: 'zr-root' }, header, h('div', { className: 'zr-err' }, state.error))
      }
      if (state.loading && state.items.length === 0) {
        return h('div', { className: 'zr-root' }, header,
          h('div', { className: 'zr-note' }, h('span', { className: 'zr-spin' }), ' ', t('loading')))
      }

      if (tab === 'searched') {
        if (state.items.length === 0) {
          return h('div', { className: 'zr-root' }, header,
            h('div', { className: 'zr-empty' }, t('searchedEmpty')))
        }
        return h('div', { className: 'zr-root' }, header,
          h('div', { className: 'zr-list' }, state.items.map(renderItem)))
      }

      // 全部文献库：按 Zotero 专题分组
      if (state.items.length === 0) {
        return h('div', { className: 'zr-root' }, header,
          h('div', { className: 'zr-empty' }, debounced ? t('searchNoResult') : t('empty')))
      }

      /**
       * 按 Zotero 的专题树组织：一级是大类，二级是子类，论文挂在最末一级下面。
       *
       * host 送来的 collection 是完整路径（`父/子/孙`），这里据此还原层级。
       * 用户在 Zotero 里怎么组织，这里就怎么呈现，不另造分类。
       * 一篇论文可能同时属于多个专题，所以它会出现在多处以保持与 Zotero 一致。
       */
      const tree = { children: new Map(), items: [] }
      for (const item of state.items) {
        const paths = item.collections && item.collections.length > 0 ? item.collections : [t('uncategorized')]
        const seen = new Set()
        for (const full of paths) {
          if (seen.has(full)) continue
          seen.add(full)
          const segments = String(full).split('/').filter(Boolean)
          let node = tree
          for (const segment of segments) {
            if (!node.children.has(segment)) {
              node.children.set(segment, { name: segment, children: new Map(), items: [], path: '' })
            }
            const child = node.children.get(segment)
            node = child
          }
          node.items.push(item)
        }
      }

      /** 子树去重后的论文总数，用于在大类标题上显示篇数。 */
      const countOf = (node, acc = new Set()) => {
        for (const item of node.items) acc.add(item.key)
        for (const child of node.children.values()) countOf(child, acc)
        return acc.size
      }

      const searching = Boolean(debounced)

      const renderNode = (node, depth, parentPath) => {
        const path = parentPath ? `${parentPath}/${node.name}` : node.name
        const total = countOf(node)
        if (total === 0) return null
        /**
         * 默认全部收起（用户明确要求）；只有在搜索时才强制展开，
         * 否则搜出来的结果藏在收起的组里，等于没搜。
         * 用户手动开合过的组以 localStorage 里的记录为准。
         */
        const defaultOpen = searching
        const open = openGroups[path] === undefined ? defaultOpen : openGroups[path]

        return h('div', { key: path, className: 'zr-group', 'data-depth': String(depth) },
          h('div', {
            className: 'zr-group-h',
            'data-depth': String(depth),
            onClick: () => toggleGroup(path, !open),
          },
          h('span', { className: 'zr-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'zr-group-n' }, node.name),
          h('span', { className: 'zr-group-c' }, String(total)),
          ),
          open ? [
            ...[...node.children.values()]
              .sort((a, b) => countOf(b) - countOf(a) || a.name.localeCompare(b.name))
              .map((child) => renderNode(child, depth + 1, path)),
            ...node.items.map(renderItem),
          ] : null,
        )
      }

      return h('div', { className: 'zr-root' }, header,
        h('div', { className: 'zr-list' },
          h('div', { className: 'zr-lib-stat' }, t('libStat').replace('{{total}}', String(state.total))),
          ...[...tree.children.values()]
            .sort((a, b) => countOf(b) - countOf(a) || a.name.localeCompare(b.name))
            .map((child) => renderNode(child, 0, '')),
          ...tree.items.map(renderItem),
        ),
      )
    }

    /** 与 host 侧 HIGHLIGHT_COLORS 保持一致；前端自带一份避免多一次请求。 */
    const HIGHLIGHT_COLORS_CLIENT = [
      { value: '#ffd400', label: '黄' },
      { value: '#ff6666', label: '红' },
      { value: '#5fb236', label: '绿' },
      { value: '#2ea8e5', label: '蓝' },
      { value: '#a28ae5', label: '紫' },
      { value: '#f19837', label: '橙' },
    ]

    /* ---------------------------------------------------------- 设置面板 */

    /**
     * 设置面板。
     *
     * 为什么做在这里而不是「宿主插件页」：实测宿主并没有把这个插件的配置渲染成
     * 可点的入口，用户只能看到「未启用 MinerU，请去设置里改」，却找不到设置 —
     * 那句话等于死胡同。所以设置直接放在阅读器里：改完立刻存、立刻生效。
     */
    function SettingsPanel({ t, onClose }) {
      const [form, setForm] = useState(null)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const [tokenDraft, setTokenDraft] = useState('')

      useEffect(() => {
        let alive = true
        fetchJson(`${API}/settings`)
          .then((data) => { if (alive) setForm(data) })
          .catch((e) => { if (alive) setError(e.message) })
        return () => { alive = false }
      }, [])

      const save = useCallback(async (patch) => {
        setSaving(true)
        setError(null)
        try {
          const data = await fetchJson(`${API}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setForm((prev) => ({ ...prev, ...data }))
        } catch (e) {
          setError(e.message)
        } finally {
          setSaving(false)
        }
      }, [])

      const test = useCallback(async () => {
        setTesting(true)
        setTestResult(null)
        try {
          const data = await fetchJson(`${API}/settings/test-mineru`, { method: 'POST' })
          setTestResult(data)
        } catch (e) {
          setTestResult({ ok: false, error: e.message })
        } finally {
          setTesting(false)
        }
      }, [])

      if (!form) {
        return h('div', { className: 'zr-settings' },
          h('div', { className: 'zr-settings-head' }, h('span', null, t('settings')), h('button', { className: 'zr-btn', onClick: onClose }, '×')),
          error ? h('div', { className: 'zr-err' }, error) : h('div', { className: 'zr-note' }, t('loading')))
      }

      const modes = [
        ['none', t('mineruNone'), t('mineruNoneDesc')],
        ['local', t('mineruLocal'), t('mineruLocalDesc')],
        ['cloud', t('mineruCloud'), t('mineruCloudDesc')],
      ]

      return h('div', { className: 'zr-settings' },
        h('div', { className: 'zr-settings-head' },
          h('span', null, t('settings')),
          h('button', { className: 'zr-btn', onClick: onClose }, '×'),
        ),
        h('div', { className: 'zr-settings-body' },
          h('div', { className: 'zr-field-label' }, t('mineruTitle')),
          h('div', { className: 'zr-field-hint' }, t('mineruHint')),

          ...modes.map(([value, label, desc]) => h('label', {
            key: value,
            className: 'zr-radio',
            'data-on': form.mineruMode === value ? '1' : '0',
          },
          h('input', {
            type: 'radio',
            name: 'mineruMode',
            checked: form.mineruMode === value,
            onChange: () => save({ mineruMode: value }),
          }),
          h('span', { className: 'zr-radio-t' }, label),
          h('span', { className: 'zr-radio-d' }, desc),
          )),

          form.mineruMode === 'local'
            ? h('div', { className: 'zr-field' },
              h('div', { className: 'zr-field-label' }, t('mineruLocalUrl')),
              h('input', {
                className: 'zr-input',
                defaultValue: form.mineruLocalUrl,
                onBlur: (e) => {
                  const v = e.target.value.trim()
                  if (v && v !== form.mineruLocalUrl) save({ mineruLocalUrl: v })
                },
              }),
            )
            : null,

          form.mineruMode === 'cloud'
            ? h('div', { className: 'zr-field' },
              h('div', { className: 'zr-field-label' }, t('mineruToken')),
              h('input', {
                className: 'zr-input',
                type: 'password',
                placeholder: form.mineruCloudTokenSet ? t('mineruTokenSet') : t('mineruTokenPlaceholder'),
                value: tokenDraft,
                onChange: (e) => setTokenDraft(e.target.value),
                onBlur: () => {
                  if (tokenDraft.trim()) { save({ mineruCloudToken: tokenDraft.trim() }); setTokenDraft('') }
                },
              }),
              h('div', { className: 'zr-field-hint' }, t('mineruTokenHint')),
            )
            : null,

          form.mineruMode !== 'none'
            ? h('div', { className: 'zr-settings-row' },
              h('button', { className: 'zr-btn', disabled: testing, onClick: test },
                testing ? t('testing') : t('testConnection')),
            )
            : null,

          testResult
            ? h('div', { className: testResult.ok ? 'zr-note' : 'zr-err' },
              testResult.ok
                ? `${t('testOk')}${testResult.target ? ` · ${testResult.target}` : ''}${testResult.note ? ` · ${testResult.note}` : ''}`
                : `${t('testFail')}${testResult.error ? `：${testResult.error}` : ''}`)
            : null,

          h('label', { className: 'zr-check' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(form.mineruAutoOnScanned),
              onChange: (e) => save({ mineruAutoOnScanned: e.target.checked }),
            }),
            h('span', null, t('mineruAuto')),
          ),

          h('div', { className: 'zr-field-hint' },
            `${t('dataDirLabel')}：${form.resolvedDataDir ?? '—'}`),

          error ? h('div', { className: 'zr-err' }, error) : null,
          saving ? h('div', { className: 'zr-note' }, t('saving')) : null,
        ),
      )
    }

    /* ------------------------------------------------------- 论文视图 */

    function PaperView({ itemKey, t, onBack, topError }) {
      const hostRef = useRef(null)
      const scrollRef = useRef(null)
      const pdfRef = useRef(null)          // { doc, pdfjs }
      const pageElsRef = useRef(new Map()) // pageNo → { wrap, canvas, textLayer }
      const renderTaskRef = useRef(new Map())

      const [info, setInfo] = useState(null)
      const [status, setStatus] = useState('loading')  // loading | ready | error
      const [error, setError] = useState(topError ?? null)
      const [pageCount, setPageCount] = useState(0)
      const [visiblePage, setVisiblePage] = useState(1)
      const [jumpPage, setJumpPage] = useState(1)
      const [scale, setScale] = useState(1.15)
      const [outlineOpen, setOutlineOpen] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [highlight, setHighlight] = useState(null)  // { page, rects:[{x,y,w,h}] }
      /**
       * Zotero 里已有的批注。用 ref 而不是 state 参与渲染循环 ——
       * 页面 canvas 是命令式渲染的，放 state 会让每次批注变化都重绘整页。
       */
      const annotationsRef = useRef([])
      const [annotationCount, setAnnotationCount] = useState(0)
      const [canWriteAnnot, setCanWriteAnnot] = useState(false)
      const [annotWriteReason, setAnnotWriteReason] = useState(null)
      const [annotColor, setAnnotColor] = useState('#ffd400')
      const [annotBusy, setAnnotBusy] = useState(false)
      const [annotListOpen, setAnnotListOpen] = useState(false)
      const [annotations, setAnnotations] = useState([])
      const attachmentKeyRef = useRef(null)
      const [pop, setPop] = useState(null)               // { x, y, text, loading, title }
      const [selbar, setSelbar] = useState(null)         // { x, y, text }
      const [mineruBusy, setMineruBusy] = useState(false)

      /* ---------- 加载文档元信息 ---------- */
      useEffect(() => {
        let alive = true
        setStatus('loading')
        setError(null)
        ;(async () => {
          try {
            const doc = await fetchJson(`${API}/doc?key=${encodeURIComponent(itemKey)}`)
            if (!alive) return
            setInfo(doc)
            setPageCount(doc.pageCount || 0)
          } catch (e) {
            if (!alive) return
            setError(e.message)
            setStatus('error')
          }
        })()
        return () => { alive = false }
      }, [itemKey])

      /**
       * 加载 Zotero 里已有的批注。
       *
       * 与文档元信息分开取：批注会随用户在 Zotero 里操作而变，
       * 而且这里还要顺带拿到「能不能写」（取决于 Zotero 是否在运行、本地 API 是否开启）。
       */
      const loadAnnotationsFromZotero = useCallback(async () => {
        try {
          const data = await fetchJson(`${API}/annotations?key=${encodeURIComponent(itemKey)}`)
          const list = Array.isArray(data.annotations) ? data.annotations : []
          annotationsRef.current = list
          setAnnotations(list)
          setAnnotationCount(list.length)
          setCanWriteAnnot(Boolean(data.canWrite))
          setAnnotWriteReason(data.writeBlockedReason ?? null)
          attachmentKeyRef.current = data.attachmentKey ?? null
          return list
        } catch (e) {
          setAnnotWriteReason(e.message)
          return []
        }
      }, [itemKey])

      useEffect(() => {
        annotationsRef.current = []
        setAnnotations([])
        setAnnotationCount(0)
        loadAnnotationsFromZotero()
      }, [itemKey, loadAnnotationsFromZotero])

      /* ---------- 加载 PDF ---------- */
      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const pdfjs = await getPdfjs()
            const doc = await pdfjs.getDocument({
              url: `${API}/pdf?key=${encodeURIComponent(itemKey)}`,
              withCredentials: true,
            }).promise
            if (!alive) { doc.destroy?.(); return }
            pdfRef.current = { doc, pdfjs }
            setPageCount(doc.numPages)
            setStatus('ready')
          } catch (e) {
            if (!alive) return
            setError(e.message || String(e))
            setStatus('error')
          }
        })()
        return () => {
          alive = false
          for (const task of renderTaskRef.current.values()) { try { task.cancel() } catch { /* ignore */ } }
          renderTaskRef.current.clear()
          pdfRef.current?.doc?.destroy?.()
          pdfRef.current = null
          pageElsRef.current.clear()
        }
      }, [itemKey])

      /* ---------- 逐页渲染：用 IntersectionObserver 懒渲染 ---------- */
      useEffect(() => {
        if (status !== 'ready') return undefined
        const host = hostRef.current
        if (!host) return undefined
        const { doc } = pdfRef.current

        host.innerHTML = ''
        pageElsRef.current.clear()

        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const pageNo = Number(entry.target.dataset.page)
            if (entry.isIntersecting) {
              setVisiblePage(pageNo)
              renderPage(pageNo)
            }
          }
        }, { root: scrollRef.current, rootMargin: '600px 0px' })

        for (let i = 1; i <= doc.numPages; i += 1) {
          const wrap = document.createElement('div')
          wrap.className = 'zr-pagebox'
          wrap.dataset.page = String(i)
          wrap.style.minHeight = '360px'
          const canvas = document.createElement('canvas')
          wrap.appendChild(canvas)
          const mark = document.createElement('div')
          mark.className = 'zr-pagemark'
          mark.textContent = String(i)
          wrap.appendChild(mark)
          host.appendChild(wrap)
          pageElsRef.current.set(i, { wrap, canvas })
          observer.observe(wrap)
        }

        return () => observer.disconnect()
      }, [status, scale, itemKey])

      const renderPage = useCallback(async (pageNo) => {
        const entry = pageElsRef.current.get(pageNo)
        const pdf = pdfRef.current
        if (!entry || !pdf || entry.rendered === `${scale}`) return
        const { doc } = pdf
        try {
          const page = await doc.getPage(pageNo)
          const viewport = page.getViewport({ scale })
          const canvas = entry.canvas
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          canvas.width = Math.floor(viewport.width * dpr)
          canvas.height = Math.floor(viewport.height * dpr)
          canvas.style.width = `${Math.floor(viewport.width)}px`
          canvas.style.height = `${Math.floor(viewport.height)}px`
          entry.wrap.style.minHeight = '0'
          const cctx = canvas.getContext('2d')
          const task = page.render({
            canvasContext: cctx,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          })
          renderTaskRef.current.set(pageNo, task)
          await task.promise
          renderTaskRef.current.delete(pageNo)
          entry.rendered = `${scale}`

          // 文字层：可选中、可划词（透明文字覆盖在 canvas 上）
          const textContent = await page.getTextContent()
          const layer = document.createElement('div')
          layer.className = 'zr-textlayer'
          for (const item of textContent.items) {
            if (typeof item.str !== 'string' || !item.str) continue
            const tx = pdf.pdfjs.Util.transform(viewport.transform, item.transform)
            const span = document.createElement('span')
            span.textContent = item.str
            const fontHeight = Math.hypot(tx[2], tx[3])
            span.style.left = `${tx[4]}px`
            span.style.top = `${tx[5] - fontHeight}px`
            span.style.fontSize = `${fontHeight}px`
            span.style.fontFamily = 'sans-serif'
            if (item.width) span.style.width = `${item.width * scale}px`
            layer.appendChild(span)
          }
          entry.wrap.appendChild(layer)
          entry.textLayer = layer

          // 若这一页有高亮目标，画上去
          if (highlight && highlight.page === pageNo) paintHighlight(entry, highlight.rects)

          /**
           * 画这一页的 Zotero 批注。
           * viewport 在 scale=1 时的高度就是 PDF 的原始页高（pt），
           * 用它做 y 轴翻转的基准最准，不受缩放影响。
           */
          if (annotationsRef.current.length > 0) {
            const pageAnnots = annotationsRef.current.filter((a) => a.pageIndex === pageNo - 1)
            if (pageAnnots.length > 0) {
              const rawHeight = viewport.height / scale
              paintAnnotations(entry, pageAnnots, rawHeight, scale)
            }
          }
        } catch (e) {
          if (!/cancel/i.test(String(e?.message ?? e))) {
            entry.wrap.style.minHeight = '120px'
          }
        }
      }, [scale, highlight, pdfRef])

      const paintHighlight = (entry, rects) => {
        for (const r of rects ?? []) {
          const box = document.createElement('div')
          box.className = 'zr-hl'
          box.style.left = `${r.x}px`
          box.style.top = `${r.y}px`
          box.style.width = `${r.w}px`
          box.style.height = `${r.h}px`
          entry.wrap.appendChild(box)
        }
      }

      /**
       * 画 Zotero 里已有的批注。
       *
       * 坐标换算是这里唯一需要小心的地方：
       * Zotero 的 position.rects 是 **PDF 坐标**（原点在左下角，单位 pt），
       * 而页面用 CSS 像素（原点左上角）。所以 y 要翻过来：y_css = pageHeight - y_pdf - h。
       * pageHeight 用未缩放的 viewBox 高度，再统一乘 scale。
       */
      const paintAnnotations = (entry, list, viewportHeightPt, scaleFactor) => {
        for (const a of list) {
          const color = a.color || '#ffd400'
          for (const r of a.rects ?? []) {
            const [x1, y1, x2, y2] = r
            const left = Math.min(x1, x2) * scaleFactor
            const width = Math.abs(x2 - x1) * scaleFactor
            const height = Math.abs(y2 - y1) * scaleFactor
            // PDF 左下原点 → CSS 左上原点
            const top = (viewportHeightPt - Math.max(y1, y2)) * scaleFactor
            const box = document.createElement('div')
            box.className = 'zr-annot'
            box.dataset.annotKey = a.key
            box.style.left = `${left}px`
            box.style.top = `${top}px`
            box.style.width = `${width}px`
            box.style.height = `${height}px`
            box.style.background = `${color}88`
            if (a.comment) box.title = a.comment
            entry.wrap.appendChild(box)
          }
        }
      }

      /* ---------- 页码跳转 + 高亮 ---------- */
      const gotoPage = useCallback((pageNo, rects) => {
        const target = Math.max(1, Math.min(pageNo, pageCount || pageNo))
        setJumpPage(target)
        setHighlight(rects ? { page: target, rects } : null)
        const entry = pageElsRef.current.get(target)
        if (entry) {
          entry.wrap.scrollIntoView({ block: 'start', behavior: 'smooth' })
          if (rects) {
            // 等这一页渲染完再画高亮框
            setTimeout(() => {
              const box = pageElsRef.current.get(target)
              if (box) paintHighlight(box, rects)
            }, 60)
          }
        }
      }, [pageCount])

      /* ---------- 全局跳转请求（来自会话里的页码点击） ---------- */
      useEffect(() => {
        const onJump = (event) => {
          const detail = event?.detail ?? {}
          if (detail.itemKey && String(detail.itemKey).toUpperCase() !== itemKey) return
          if (detail.page) gotoPage(detail.page, detail.rects)
        }
        window.addEventListener('zotero-reader:jump', onJump)
        return () => window.removeEventListener('zotero-reader:jump', onJump)
      }, [gotoPage, itemKey])

      /* ---------- 划词工具条 ---------- */
      useEffect(() => {
        const onUp = () => {
          const selection = window.getSelection()
          const text = selection?.toString().trim() ?? ''
          if (!text || text.length < 2) {
            setSelbar(null)
            return
          }
          // 只在阅读区内划词才响应
          const anchor = selection.anchorNode
          if (!anchor || !hostRef.current?.contains(anchor.nodeType === 3 ? anchor.parentNode : anchor)) {
            setSelbar(null)
            return
          }
          const range = selection.getRangeAt(0)
          const rect = range.getBoundingClientRect()

          /**
           * 把选区矩形换算成 Zotero 需要的 PDF 坐标（左下原点、单位 pt）。
           *
           * 做法：取选区覆盖到的那些页，用该页 wrap 的 bounding rect 求出偏移，
           * 再除以当前 scale 还原成 pt，最后把 y 翻成左下原点。
           * 跨页选择只取第一页那部分 —— Zotero 的批注也是按页存的，跨页本来就要拆成多条。
           */
          const pdfRects = []
          let pageIndex = visiblePage - 1
          try {
            const rects = range.getClientRects()
            const byPage = new Map()
            for (const cr of rects) {
              // 找到这个矩形落在哪一页
              for (const [pageNo, entry] of pageElsRef.current) {
                const box = entry.wrap?.getBoundingClientRect()
                if (!box) continue
                if (cr.top >= box.top - 2 && cr.bottom <= box.bottom + 2
                  && cr.left >= box.left - 2 && cr.right <= box.right + 2) {
                  const pageObj = pageElsRef.current.get(pageNo)
                  if (!byPage.has(pageNo)) byPage.set(pageNo, { entry, pageObj, list: [] })
                  byPage.get(pageNo).list.push(cr)
                  break
                }
              }
            }
            if (byPage.size > 0) {
              const firstPage = Math.min(...byPage.keys())
              const { entry, list } = byPage.get(firstPage)
              const box = entry.wrap.getBoundingClientRect()
              const cssHeight = box.height
              // 该页在 CSS 下的高度对应 PDF 的多少 pt
              const heightPt = cssHeight / scale
              for (const cr of list) {
                const x1 = (cr.left - box.left) / scale
                const x2 = (cr.right - box.left) / scale
                const topPt = (cr.top - box.top) / scale
                const botPt = (cr.bottom - box.top) / scale
                // CSS 上原点 → PDF 下原点
                const y1 = heightPt - botPt
                const y2 = heightPt - topPt
                pdfRects.push([Number(x1.toFixed(2)), Number(y1.toFixed(2)), Number(x2.toFixed(2)), Number(y2.toFixed(2))])
              }
              pageIndex = firstPage - 1
            }
          } catch { /* 换算失败就不带坐标，用户仍能只加备注 */ }

          setSelbar({
            x: Math.min(Math.max(8, rect.left + rect.width / 2 - 60), window.innerWidth - 140),
            y: Math.max(8, rect.top - 40),
            text,
            pageIndex,
            rects: pdfRects,
          })
        }
        document.addEventListener('mouseup', onUp)
        return () => document.removeEventListener('mouseup', onUp)
      }, [])

      /* ---------- 划词动作（译 / 解 / 问）---------- */
      const doSelection = useCallback(async (kind) => {
        const text = selbar?.text
        if (!text) return
        setSelbar(null)
        setPop({ x: selbar.x, y: Math.max(8, selbar.y + 42), text: '', loading: true, title: kind === 'explain' ? t('explainSelection') : t('translateSelection') })
        try {
          const data = await fetchJson(`${API}/selection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, mode: kind === 'explain' ? 'explain' : 'translate' }),
          })
          setPop((prev) => (prev ? { ...prev, text: data.text ?? '', loading: false } : prev))
        } catch (e) {
          setPop((prev) => (prev ? { ...prev, text: e.message || String(e), loading: false } : prev))
        }
      }, [selbar, t])

      /**
       * 「高亮」：把当前选区写成 Zotero 里的批注。
       *
       * 走本地 API 而不是直接改 sqlite —— 由 Zotero 自己完成校验、索引和同步，
       * 效果等同于用户在 Zotero 界面里划高亮。写入需要 Zotero 10+ 并弹一次授权框。
       */
      const doHighlight = useCallback(async () => {
        const sel = selbar
        if (!sel?.text) return
        if (!canWriteAnnot) {
          setPop({
            x: sel.x,
            y: Math.max(8, sel.y + 42),
            text: annotWriteReason || t('annotCannotWrite'),
            loading: false,
            title: t('highlightSelection'),
          })
          setSelbar(null)
          return
        }
        const rects = sel.rects ?? []
        if (rects.length === 0) {
          setPop({
            x: sel.x,
            y: Math.max(8, sel.y + 42),
            text: t('annotNeedSelection'),
            loading: false,
            title: t('highlightSelection'),
          })
          setSelbar(null)
          return
        }
        setSelbar(null)
        setAnnotBusy(true)
        setPop({ x: sel.x, y: Math.max(8, sel.y + 42), text: '', loading: true, title: t('highlightSelection') })
        try {
          const data = await fetchJson(`${API}/annotations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              itemKey,
              attachmentKey: attachmentKeyRef.current,
              text: sel.text,
              color: annotColor,
              pageIndex: sel.pageIndex ?? (visiblePage - 1),
              pageLabel: (sel.pageIndex ?? (visiblePage - 1)) + 1,
              rects,
            }),
          })
          setPop((prev) => (prev ? { ...prev, text: t('annotSaved'), loading: false } : prev))
          // 重新拉一次，新批注立刻出现在页面上
          await loadAnnotationsFromZotero()
          // 强制这一页重绘，把新框画上去
          const entry = pageElsRef.current.get((sel.pageIndex ?? (visiblePage - 1)) + 1)
          if (entry) {
            for (const el of entry.wrap.querySelectorAll('.zr-annot')) el.remove()
            entry.rendered = ''
            renderPage((sel.pageIndex ?? (visiblePage - 1)) + 1)
          }
          void data
        } catch (e) {
          setPop((prev) => (prev ? { ...prev, text: e.message || String(e), loading: false } : prev))
        } finally {
          setAnnotBusy(false)
        }
      }, [selbar, canWriteAnnot, annotWriteReason, annotColor, itemKey, visiblePage, t, loadAnnotationsFromZotero, renderPage])

      /** 「问」：把选中片段塞进当前会话的输入框并聚焦，让主会话模型答。 */
      const doAsk = useCallback(() => {
        const text = selbar?.text
        if (!text) return
        setSelbar(null)
        const quote = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
        const prompt = `关于《${info?.title ?? itemKey}》${visiblePage ? ` 第 ${visiblePage} 页` : ''}的这一段：\n\n> ${quote.replace(/\n+/g, ' ')}\n\n`
        window.dispatchEvent(new CustomEvent('dsh:composer-insert', { detail: { text: prompt } }))
        // 宿主没有这个事件时，退化为复制到剪贴板并提示
        if (!window.__zrComposerOk) {
          navigator.clipboard?.writeText(prompt).then(() => {
            setPop({ x: selbar.x, y: Math.max(8, selbar.y + 42), text: '已复制到剪贴板，粘贴到对话框即可提问。', loading: false, title: t('askSelection') })
          }).catch(() => { /* 剪贴板不可用就算了 */ })
        }
      }, [selbar, info, visiblePage, itemKey, t])

      /* ---------- 渲染 ---------- */
      const sourceLabel = useMemo(() => {
        if (!info) return ''
        if (info.source === 'mineru-local') return t('sourceMineruLocal')
        if (info.source === 'mineru-cloud') return t('sourceMineruCloud')
        return t('sourceLocal')
      }, [info, t])

      if (status === 'error') {
        return h('div', { className: 'zr-root' },
          h('div', { className: 'zr-bar' },
            h('button', { className: 'zr-btn', onClick: onBack }, '←'),
            h('span', { className: 'zr-title' }, t('loadFailed'))),
          h('div', { className: 'zr-err' }, error))
      }

      return h('div', { className: 'zr-root' },
        // 顶栏
        h('div', { className: 'zr-bar' },
          h('button', { className: 'zr-btn', onClick: onBack, title: t('browse') }, '←'),
          h('span', { className: 'zr-title', title: info?.title ?? '' }, info?.title ?? t('loading')),
          h('span', {
            style: { fontSize: 11, opacity: .7, whiteSpace: 'nowrap' },
            title: info?.approxPages ? t('approxPages') : '',
          }, sourceLabel + (info?.approxPages ? ' · ≈' : '')),
        ),

        // 工具条
        h('div', { className: 'zr-bar' },
          h('button', { className: 'zr-btn', onClick: () => gotoPage(jumpPage - 1), disabled: jumpPage <= 1, title: t('prevPage') }, '‹'),
          h('input', {
            type: 'number', value: jumpPage, min: 1, max: pageCount || 1,
            onChange: (e) => setJumpPage(Number(e.target.value) || 1),
            onKeyDown: (e) => { if (e.key === 'Enter') gotoPage(Number(e.target.value) || 1) },
            style: { width: 52, background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-border,#3a3a3a)', borderRadius: 6, padding: '2px 4px', fontSize: 12 },
          }),
          h('span', { style: { fontSize: 11, opacity: .7, whiteSpace: 'nowrap' } }, '/ ' + (pageCount || '?')),
          h('button', { className: 'zr-btn', onClick: () => gotoPage(jumpPage + 1), disabled: pageCount > 0 && jumpPage >= pageCount, title: t('nextPage') }, '›'),
          h('button', { className: 'zr-btn', onClick: () => setScale((s) => Math.min(3, +(s + 0.15).toFixed(2))), title: t('zoomIn') }, '+'),
          h('button', { className: 'zr-btn', onClick: () => setScale((s) => Math.max(0.4, +(s - 0.15).toFixed(2))), title: t('zoomOut') }, '−'),
          h('button', {
            className: 'zr-btn', title: t('fitWidth'),
            onClick: () => {
              const width = scrollRef.current?.clientWidth ?? 600
              setScale(Math.max(0.4, +((width - 24) / 612).toFixed(2)))
            },
          }, '⤢'),

          // MinerU 重解析
          mineruBusy
            ? h('span', { className: 'zr-btn', style: { cursor: 'default' } }, h('span', { className: 'zr-spin' }), ' ', t('mineruRunning'))
            : h('button', {
              className: 'zr-btn',
              title: t('sourceMineruLocal'),
              onClick: async () => {
                setMineruBusy(true)
                try {
                  const doc = await fetchJson(`${API}/doc?key=${encodeURIComponent(itemKey)}&mineru=1`)
                  setInfo(doc)
                  setPageCount(doc.pageCount || 0)
                } catch (e) {
                  setError(e.message)
                } finally {
                  setMineruBusy(false)
                }
              },
            }, 'MinerU'),
          info?.outline?.length
            ? h('button', { className: 'zr-btn', 'data-on': outlineOpen ? '1' : '0', onClick: () => setOutlineOpen((v) => !v), title: t('outline') }, '☰')
            : null,
          // 设置：直接开面板里的设置，不指望宿主插件页（实测那边没有可点的入口）
          h('button', {
            className: 'zr-btn',
            'data-on': settingsOpen ? '1' : '0',
            title: t('settings'),
            onClick: () => setSettingsOpen((v) => !v),
          }, '⚙'),
          // 批注列表：显示这篇文献在 Zotero 里的所有高亮/备注
          h('button', {
            className: 'zr-btn',
            'data-on': annotListOpen ? '1' : '0',
            title: t('annotations'),
            onClick: () => {
              setAnnotListOpen((v) => !v)
              if (!annotListOpen) loadAnnotationsFromZotero()
            },
          }, `✎${annotationCount > 0 ? ` ${annotationCount}` : ''}`),
        ),

        // 正文
        h('div', { className: 'zr-page', ref: scrollRef },
          h('div', { className: 'zr-canvas-wrap', ref: hostRef }),
          status === 'loading'
            ? h('div', { className: 'zr-note' }, h('span', { className: 'zr-spin' }), ' ', t('loading'))
            : null,
        ),

        /**
         * 大纲与设置：挂在根容器上，**与滚动容器同级**，因此不随 PDF 滚动。
         *
         * 之前的两个问题都出在定位上：
         *   · 放进 .zr-page 里 → 它相对滚动内容定位，滚到第 2 页以后就跟着移出视野，
         *     看起来像「只附在第一页」；
         *   · 点条目时还顺手 setOutlineOpen(false) → 一跳转就关掉。
         * 现在：常驻，只有用户点 × 才关。
         */
        h('div', { className: 'zr-page-anchors' },
          outlineOpen && info?.outline?.length
            ? h('div', { className: 'zr-outline', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'zr-outline-head' },
                h('span', null, t('outline')),
                h('button', { className: 'zr-btn', onClick: () => setOutlineOpen(false) }, '×'),
              ),
              info.outline.map((o, i) => h('div', {
                key: i,
                className: 'zr-outline-row',
                onClick: () => { gotoPage(o.page) },
              }, `${info.approxPages ? '≈' : ''}p${o.page}  ${o.title}`)))
            : null,

          settingsOpen
            ? h(SettingsPanel, { t, onClose: () => setSettingsOpen(false) })
            : null,

          /**
           * 批注列表：列出这篇文献在 Zotero 里的全部高亮/备注。
           * 点条目跳到那一页；有备注的直接显示在下面。
           */
          annotListOpen
            ? h('div', { className: 'zr-annot-panel', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'zr-outline-head' },
                h('span', null, `${t('annotations')}${annotationCount > 0 ? ` · ${annotationCount}` : ''}`),
                h('button', { className: 'zr-btn', onClick: () => setAnnotListOpen(false) }, '×'),
              ),
              !canWriteAnnot && annotWriteReason
                ? h('div', { className: 'zr-field-hint', style: { padding: '6px 12px' } }, annotWriteReason)
                : null,
              annotations.length === 0
                ? h('div', { className: 'zr-note' }, t('annotEmpty'))
                : annotations.map((a) => h('div', {
                  key: a.key,
                  className: 'zr-annot-row',
                  onClick: () => gotoPage((a.pageIndex ?? 0) + 1),
                },
                h('div', { className: 'zr-annot-meta' },
                  h('span', { className: 'zr-annot-dot', style: { background: a.color } }),
                  h('span', null, `p${a.page ?? (a.pageIndex ?? 0) + 1}`),
                ),
                h('div', { className: 'zr-annot-text' }, a.text.slice(0, 160)),
                a.comment
                  ? h('div', { className: 'zr-annot-comment' }, a.comment.replace(/🔤/g, '').slice(0, 200))
                  : null,
                )),
              canWriteAnnot
                ? h('div', { className: 'zr-annot-colors' },
                  h('span', { className: 'zr-field-hint' }, t('annotColor')),
                  ...HIGHLIGHT_COLORS_CLIENT.map((c) => h('button', {
                    key: c.value,
                    className: 'zr-color-chip',
                    'data-on': annotColor === c.value ? '1' : '0',
                    style: { background: c.value },
                    title: c.label,
                    onClick: () => setAnnotColor(c.value),
                  })),
                )
                : null,
            )
            : null,
        ),

        // 错误提示条
        error ? h('div', { className: 'zr-err', style: { flex: '0 0 auto' } }, error) : null,

        // 划词工具条
        selbar ? h('div', { className: 'zr-sel', style: { left: selbar.x, top: selbar.y } },
          h('button', { onClick: () => doSelection('translate'), title: t('translateSelection') }, t('translateSelection')),
          h('button', { onClick: () => doSelection('explain'), title: t('explainSelection') }, t('explainSelection')),
          h('button', { onClick: doAsk, title: t('askSelection') }, t('askSelection')),
          // 高亮：写回 Zotero
          h('button', {
            onClick: doHighlight,
            disabled: annotBusy,
            title: canWriteAnnot ? t('highlightSelection') : (annotWriteReason || t('annotCannotWrite')),
            style: { borderLeft: '1px solid var(--dsh-border,#3a3a3a)' },
          }, h('span', { style: { color: annotColor } }, '▮'), ' ', t('highlightSelection')),
        ) : null,

        // 划词结果浮窗
        pop ? h('div', { className: 'zr-pop', style: { left: pop.x, top: pop.y } },
          h('div', { className: 'zr-pop-head' },
            h('span', null, pop.title),
            h('button', {
              className: 'zr-btn', style: { padding: '0 6px' },
              onClick: () => setPop(null),
            }, '×')),
          pop.loading ? h('div', null, h('span', { className: 'zr-spin' }), ' …') : h('div', null, pop.text),
        ) : null,
      )
    }

    /* -------------------------------------------------- 全局链接拦截 */

    /**
     * 会话里点 `zotero://<key>`：打开右栏 tab 并派发打开请求。
     * 用捕获阶段 + closest('a[href^="zotero://"]')，不改动任何别人的渲染结果。
     */
    function installLinkInterceptor(ctx) {
      const onClick = (event) => {
        const anchor = event.target?.closest?.('a[href^="zotero://" i]')
        if (!anchor) return
        const href = anchor.getAttribute('href') ?? ''
        const m = SCHEME_RE.exec(href.trim())
        if (!m) return
        event.preventDefault()
        event.stopPropagation()
        openInReader(ctx, m[1].toUpperCase())
      }
      document.addEventListener('click', onClick, true)
      return () => document.removeEventListener('click', onClick, true)
    }

    /**
     * tab 标题渲染（chip 上那行字，以及浮动面板的头部）。
     * 打开的是具体某篇时就显示论文短标题，否则显示通用名。
     */
    function TabTitle(props) {
      const bound = props.bound ?? ((k) => k)
      const raw = String(props.tabKey ?? props.key ?? props.tab?.key ?? '')
      const itemKey = keyFromTabKey(raw)
      const [label, setLabel] = useState(() => (itemKey ? itemKey : bound('pdfTab')))

      useEffect(() => {
        if (!itemKey) { setLabel(bound('pdfTab')); return }
        let alive = true
        fetchJson(`${API}/doc?key=${encodeURIComponent(itemKey)}`)
          .then((doc) => { if (alive && doc?.title) setLabel(shorten(doc.title, 22)) })
          .catch(() => { /* 标题拿不到就保留 key，不影响打开 */ })
        return () => { alive = false }
      }, [itemKey])

      return h('span', { className: 'zr-tabtitle', title: label }, label)
    }

    /** 从 `<TAB_KEY>:<itemKey>` 里取出 itemKey。 */
    function keyFromTabKey(raw) {
      const text = String(raw ?? '')
      const at = text.indexOf(':')
      if (at < 0) return ''
      const tail = text.slice(at + 1).trim().toUpperCase()
      return /^[A-Z0-9]{8}$/.test(tail) ? tail : ''
    }

    function shorten(text, max) {
      const s = String(text ?? '').trim()
      return s.length <= max ? s : s.slice(0, max - 1) + '…'
    }

    /**
     * 右栏控制器是稍后 provide 的，apply 阶段可能还取不到。
     * 声明放在靠前处并集中在一处：列表点选、会话链接都经它开新 tab，
     * 若在组件之后声明会踩 `let` 的暂时性死区。
     */
    let openTabImpl = null

    function openInReader(ctx, itemKey) {
      const key = itemKey ? `${TAB_KEY}:${itemKey}` : TAB_KEY
      try {
        if (openTabImpl) openTabImpl(key)
      } catch { /* 右栏不可用时只派发事件 */ }
      window.dispatchEvent(new CustomEvent('zotero-reader:open', { detail: { itemKey } }))
    }

    /**
     * Zotero 标志形状的图标：一张纸 + 右侧竖排三条色条（红 / 灰 / 深蓝）。
     * 用内联 SVG 而不是 emoji —— emoji 在不同系统里字形不一致，且在 16px 下糊成一团。
     * 签名与宿主 tab 图标一致：接收 size，返回 React 元素。
     */
    function ZoteroIcon(size = 16) {
      const s = typeof size === 'number' && size > 0 ? size : 16
      return h('svg', {
        width: s,
        height: s,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        style: { display: 'block', flex: '0 0 auto' },
      },
      // 纸张轮廓
      h('rect', {
        x: 1.5, y: 1, width: 13, height: 14, rx: 2,
        stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.75,
      }),
      // 三条色条：Zotero 的配色（红 / 中灰 / 深蓝）
      h('rect', { x: 4, y: 3.6, width: 1.6, height: 8.8, rx: 0.4, fill: '#cc2b2b' }),
      h('rect', { x: 6.6, y: 3.6, width: 1.6, height: 8.8, rx: 0.4, fill: '#8a8a8a' }),
      h('rect', { x: 9.2, y: 3.6, width: 1.6, height: 8.8, rx: 0.4, fill: '#24427a' }),
      )
    }

    /* -------------------------------------------------------- 插件体 */

    return {
      inject: ['slots', 'locale', 'layout', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        const bound = ctx.locale.bind(NS)
        const t = (key) => bound(key)

        /**
         * 右栏 tab 类型的注册。
         *
         * 这里必须走 `ctx.inject(['sidebarRightTabs'], ...)` 再 `injected.get(...)`：
         * 该服务由右栏 UI 包在稍后的生命周期里 provide，直接写进本插件顶层 `inject`
         * 会让 apply 一直等待（实测：apply 根本不执行）。同理 sidebarRight 也在这里取。
         *
         * `guide` 数组就是右栏「开始」页那张卡片 —— 用户点一下就能进来。
         * 没有它，类型虽然存在，用户也找不到入口（这正是之前缺的那一步）。
         */
        ctx.inject(['sidebarRightTabs'], (injected) => {
          const tabs = injected.get('sidebarRightTabs')
          if (tabs === undefined || typeof tabs.register !== 'function') return

          ctx.effect(() => tabs.register({
            id: TAB_KEY,
            kind: TAB_KEY,
            // keepMounted：切走再切回来不重载 PDF，也不丢当前页
            keepMounted: true,
            priority: 'extension',
            title: () => t('pdfTab'),
            guide: [{
              id: TAB_KEY,
              order: 42,
              title: () => t('title'),
              description: () => t('guideDesc'),
              icon: ZoteroIcon,
            }],
          }))

          // tab 内容（key 用前缀匹配，`zotero-reader:ABCD1234` 也命中）
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_KEY,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          }, (props) => h(Reader, { ...props, bound }))))

          // tab 标题（chip 上显示的那行字）
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: TAB_KEY,
            locale: NS,
          }, (props) => h(TabTitle, { ...props, bound }))))
        })

        // 右栏控制器：只取用，不要求必须在 inject 里（取不到就跳过）
        ctx.inject(['sidebarRight'], (injected) => {
          const right = injected.get('sidebarRight')
          if (right === undefined) return
          openTabImpl = (key) => right.openTab(key, { revealIfOpened: true })
        })

        // 会话里 zotero:// 链接
        ctx.effect(() => installLinkInterceptor(ctx))
      },
    }
  },
})
