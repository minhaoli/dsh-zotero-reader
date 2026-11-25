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
    const { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } = React
    const h = React.createElement

    const NS = 'dsh-zotero-reader'
    const TAB_KEY = 'zotero-reader'
    /** 与 host 侧 ROUTE_PREFIX 一致。 */
    const API = '/zotero-reader'
    /** 会话消息里可点击的文献链接。 */
    const SCHEME_RE = /^zotero:\/\/([A-Z0-9]{8})$/i

    /**
     * 批注总开关（变量二分用）。
     *
     * 「一打开某个条目就黑屏」排查时，把批注当成唯一变量：置 false 后
     * 加载 Zotero 批注这条链路整体停用（连带页面上的批注色块也不再画，
     * 因为绘制只在数组非空时才发生），其余功能一律不变。
     * 定位完把这里改回 true 即可，不留其它痕迹。
     */
    const ANNOTATIONS_ENABLED = true

    /*
     * 批注工具与调色板。
     *
     * 【为什么不再用 pdf.js 的 AnnotationEditor】
     *
     * 这层最初直接把交付押在 `viewer.annotationEditorMode` 上（HIGHLIGHT=9 /
     * FREETEXT=3 / INK=15），结果整条链路是坏的，且坏在我们无法修复的地方：
     *
     *   `viewer.annotationStorage` 的 getter 实现是
     *     return self.pdfDocument?.annotationStorage
     *   （pdf_viewer.mjs:8318），而 `pdfDocument.annotationStorage` 来自
     *   getDocument()，我们直接调 getDocument({data}) 时它是 undefined。
     *   编辑器提交时 AnnotationEditorUIManager 会调用
     *     this.#annotationStorage.getRawValue(editorId)   // build/pdf.mjs ~L4241
     *   **没有任何 null 检查** → 抛 "Cannot read properties of null (reading 'get')"，
     *   编辑器当场崩掉。这正是「连高亮都没有了」的根因。
     *
     * 试图补一个本地 annotationStorage 替身也没用（试过了）：UIManager 内部持有
     * 的引用与 viewer 的 getter 不是同一个对象，替身补不上它那一侧。
     *
     * 【现在的做法：自建标注层】
     *
     * 不进入任何编辑器模式，用户选完文字我们自己算矩形，直接 POST 给宿主写进
     * Zotero（批注在 Zotero 里就是 itemType:"annotation" 的普通条目，本地 API
     * 的 POST /api/users/0/items 就能建）。页面上的显示也是我们自己画的浮层，
     * 不依赖 pdf.js 的 AnnotationEditorLayer / 标注渲染。
     */
    const ANNOT_TOOLS = [
      { kind: 'highlight', icon: '🖍', title: '高亮' },
      { kind: 'underline', icon: 'U̲', title: '下划线' },
      { kind: 'note', icon: '🗨', title: '便签（选文字或点页面留便条）' },
    ]

    /**
     * 与 Zotero 自带调色板一致的八色。
     *
     * `label` 是 Zotero 中文界面里的名字，三点菜单按截图逐项显示「色块 + 名字」；
     * `name` 保留给老调用方（工具条上的色块 title）。
     */
    const EDIT_COLORS = [
      { value: '#ffd400', name: '黄', label: '黄色' },
      { value: '#ff6666', name: '红', label: '红色' },
      { value: '#5fb236', name: '绿', label: '绿色' },
      { value: '#2ea8e5', name: '蓝', label: '蓝色' },
      { value: '#a28ae5', name: '紫', label: '紫色' },
      { value: '#e56eee', name: '洋红', label: '洋红色' },
      { value: '#f19837', name: '橙', label: '橙色' },
      { value: '#aaaaaa', name: '灰', label: '灰色' },
    ]

    /* ------------------------------------------------------------ i18n */

    const zh = {
      title: 'Zotero',
      pdfTab: 'Zotero',
      guideDesc: '浏览 Zotero 全部文献，或回到本次对话搜过的文章',
      tabLibrary: '全部文献库',
      tabSearched: '本次搜索',
      searchedEmpty: '这次对话还没搜过 Zotero 文献。让 AI 搜一下，命中的文章会出现在这里。',
      searchedPick: '选中这条搜索记录',
      searchedPickAll: '全选',
      searchedRemove: '从本次搜索移除 ({{n}})',
      searchedRemoving: '移除中…',
      searchedRemoveHint: '只从「本次搜索」这份记录里移除，Zotero 库里的文献不会删除',
      searchedEnterPick: '移除记录',
      searchedPickNote: '这里移除的只是「本次搜索」的记录，Zotero 库中的文献不受影响。',
      cancel: '取消',
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
      backToPrev: '返回跳转前的位置',
      backToPrevDepth: '返回跳转前的位置（可回退 {{depth}} 步）',
      translateSelection: '翻译',
      askSelection: '询问',
      askInserted: '已放入下方输入框，补充问题后发送即可',
      askCopied: '无法写入输入框（会话未就绪），已复制到剪贴板',
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
      annotPage: '{{page}} 页',
      annotComment: '添加评论',
      annotTags: '添加标签...',
      annotMore: '更多操作',
      annotCommentNote: '评论、标签改动会在失焦或回车后自动写入 Zotero。',
      annotCommentDraft: '正在写入 Zotero…',
      annotMetaFailed: '写入失败',
      annotTagAdd: '添加标签',
      annotTagRemove: '删除标签',
      annotDelete: '删除',
      annotDeleting: '删除中…',
      annotMoreHint: '从 Zotero 删除这条批注',
      annotRecolorFailed: '改色失败',
      annotConvertFailed: '转换失败',
      annotToUnderline: '转为下划线',
      annotToUnderlineHint: '把这条高亮改成下划线（写回 Zotero）',
      annotToHighlight: '转为高亮',
      annotToHighlightHint: '把这条下划线改成高亮（写回 Zotero）',
      highlightSelection: '高亮',
      underlineSelection: '下划线',
      noteSelection: '便签',
      noteTool: '便签',
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
      papersTab: 'Zotero PDF',
      papersTitle: 'Zotero PDF',
      papersDesc: '汇总这次打开过的每一篇，点一下切换过去',
      papersEmpty: '还没有打开任何 PDF。到「Zotero」栏里点一篇，它就会出现在这里。',
      closePaper: '关闭这篇',
    }
    const en = {
      title: 'Zotero Paper Reader',
      pdfTab: 'Paper',
      guideDesc: 'Browse the whole Zotero library, or return to papers found in this conversation',
      tabLibrary: 'Library',
      tabSearched: 'Found here',
      searchedEmpty: 'No Zotero papers searched in this conversation yet.',
      searchedPick: 'Select this search record',
      searchedPickAll: 'Select all',
      searchedRemove: 'Remove from this search ({{n}})',
      searchedRemoving: 'Removing…',
      searchedRemoveHint: 'Only removes the record from this search list; papers in your Zotero library are not deleted',
      searchedEnterPick: 'Remove records',
      searchedPickNote: 'Removing here only clears this search record — papers in your Zotero library are untouched.',
      cancel: 'Cancel',
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
      backToPrev: 'Back to previous position',
      backToPrevDepth: 'Back to previous position ({{depth}} step(s) available)',
      fitWidth: 'Fit width',
      translateSelection: 'Translate',
      askSelection: 'Ask',
      askInserted: 'Inserted into the composer below — add your question and send',
      askCopied: 'Could not reach the composer (session not ready); copied to clipboard instead',
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
      annotPage: 'p. {{page}}',
      annotComment: 'Add comment',
      annotTags: 'Add tags...',
      annotMore: 'More actions',
      annotCommentNote: 'Comments and tags are written to Zotero on blur or Enter.',
      annotCommentDraft: 'Saving to Zotero…',
      annotMetaFailed: 'Failed to save',
      annotTagAdd: 'Add tag',
      annotTagRemove: 'Remove tag',
      annotDelete: 'Delete',
      annotDeleting: 'Deleting…',
      annotMoreHint: 'Delete this annotation from Zotero',
      annotRecolorFailed: 'Failed to change color',
      annotConvertFailed: 'Failed to convert',
      annotToUnderline: 'Convert to underline',
      annotToUnderlineHint: 'Turn this highlight into an underline (written back to Zotero)',
      annotToHighlight: 'Convert to highlight',
      annotToHighlightHint: 'Turn this underline into a highlight (written back to Zotero)',
      highlightSelection: 'Highlight',
      underlineSelection: 'Underline',
      noteSelection: 'Note',
      noteTool: 'Note',
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
      papersTab: 'Opened PDFs',
      papersTitle: 'Opened PDFs',
      papersDesc: 'Every paper opened in this session; click one to switch to it',
      papersEmpty: 'No PDF opened yet. Pick one in the Zotero tab and it shows up here.',
      closePaper: 'Close this paper',
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
    let workerPort = null

    /**
     * 把客户端运行时事实回报给宿主写盘。
     *
     * 这一轮黑屏排查最大的障碍是「看不到浏览器里发生了什么」：控制台报错用户不便抄，
     * 而如果问题就在路径解析或认证上，连日志都可能送不进去。
     * 所以把三个关键事实一次性带上：页面基址、本次解析出的实际 URL、当前状态。
     * 失败静默——诊断本身绝不影响阅读。
     */
    function reportDiag(payload) {
      try {
        const record = {
          baseURI: typeof document !== 'undefined' ? document.baseURI : null,
          href: typeof window !== 'undefined' ? window.location.href : null,
          origin: typeof window !== 'undefined' ? window.location.origin : null,
          ...payload,
        }
        for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
        const text = JSON.stringify(record)

        /**
         * GET 兜底。
         *
         * 之前只发 POST，结果 client-log.jsonl 一直不存在 —— 而库列表能正常加载，
         * 说明 GET 通道是通的。所以 POST 失败、被拒或 1.5 秒内没响应，就改走
         * `GET ?d=<json>`。宁可偶尔重复一条，也不能在这类「全黑、什么都不显示」
         * 的问题上继续蒙着眼。
         */
        let settled = false
        const viaGet = () => {
          try {
            void fetch(`${API}/client-log?d=${encodeURIComponent(text)}`, {
              method: 'GET',
              credentials: 'same-origin',
            }).catch(() => { /* 送不出去就算了 */ })
          } catch { /* 同上 */ }
        }
        const timer = setTimeout(() => { if (!settled) viaGet() }, 1500)

        void fetch(`${API}/client-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: text,
        }).then((res) => {
          settled = true
          clearTimeout(timer)
          if (!res || !res.ok) viaGet()
        }).catch(() => {
          settled = true
          clearTimeout(timer)
          viaGet()
        })
      } catch { /* 同上 */ }
    }

    /** 给任何 await 加超时：没有它，一个不 settle 的 promise 就是永久「加载中」。 */
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
        }),
      ])
    }

    /**
     * ============================ 性能探针 ============================
     *
     * 目的：用**不受主线程排队影响**的测量回答「卡在哪」。
     *
     * 为什么不能只用现有诊断打点：
     * `viewer:render-check` 是 `setTimeout(..., 600)`，它在日志里显示的
     * 「doc-set 之后 7311ms」不是渲染耗时，而是定时器被主线程堵住、晚了 6.7 秒才执行。
     * 同理 `resume-applied` 的 3112ms 里含 120ms×N 重试。直接把这两个数当耗时，
     * 会把「主线程阻塞」误读成「渲染慢」，而这两者的改法完全不同。
     *
     * 所以本探针同时量两条独立的东西：
     *   ① 各阶段真实耗时 —— 用 render() 的 Promise resolve / pagerendered 事件做锚点，
     *      这些在任务真正完成时触发，不靠定时器；
     *   ② 主线程健康度 —— longtask 与 rAF 帧间隔，用来解释「为什么定时器晚了 6.7 秒」。
     *
     * 限流：明细事件按「每次操作」聚合，汇总事件 2 秒内最多一条。
     * 绝不可能每帧一行 —— 帧间隔只在内存里累积，2 秒汇总时取分位数。
     */
    /**
     * 探针版本。心跳里带上它，日志里一看就知道当前页面跑的是哪一版探针。
     * 改动探针逻辑时记得同步 +1，否则「刷新了没生效」又要靠猜。
     */
    const PERF_PROBE_VERSION = 'p3-2026-11-13'

    const perf = (() => {
      const t0 = (typeof performance !== 'undefined' ? performance : Date)
      const now = () => t0.now()

      /** 帧间隔采样（ms）。只在内存里累积，开销是一次 now() 相减。 */
      let frameSamples = []
      let frameMax = 0
      let lastFrame = 0
      let rafOn = false

      /** longtask 采样 */
      let longTasks = []
      let longtaskOn = false

      /** 按操作分组暂存的明细，汇总后清空 */
      let phaseLog = []

      let lastSummaryAt = 0
      const SUMMARY_MIN_GAP = 2000
      /** 本轮累积的起点。首次汇总时由 startFrames/startLongTasks 设好，0 表示还没开始。 */
      let periodStart = 0
      /** 按 label 分别限流：open / jump / scroll 互不挤占，各自最多每 2s 一条。 */
      const lastSummaryByLabel = new Map()

      const percentile = (arr, p) => {
        if (!arr.length) return 0
        const s = [...arr].sort((a, b) => a - b)
        const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
        return s[i]
      }
      const round1 = (v) => Math.round(v * 10) / 10

      /**
       * rAF 帧间隔采样器。
       * 侧栏隐藏时浏览器会把 rAF 节流到 ~1Hz 甚至暂停，这本身也是要测的事实
       * （「隐藏时是否还在空转」），所以照常记录，由汇总区分。
       */
      function startFrames() {
        if (rafOn || typeof requestAnimationFrame !== 'function') return
        rafOn = true
        lastFrame = now()
        // 采样开始即本轮计时的起点；未开始计时时 spanMs 无从谈起
        if (!(periodStart > 0)) periodStart = lastFrame
        const tick = () => {
          if (!rafOn) return
          const t = now()
          const dt = t - lastFrame
          lastFrame = t
          if (dt > 0 && dt < 60000) {
            frameSamples.push(dt)
            if (dt > frameMax) frameMax = dt
            // 每个汇总周期最多留 600 个样本，够算分位数且不会无限涨
            if (frameSamples.length > 600) frameSamples = frameSamples.slice(-600)
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }

      function startLongTasks() {
        if (longtaskOn || typeof PerformanceObserver !== 'function') return
        try {
          const po = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) })
              if (longTasks.length > 400) longTasks = longTasks.slice(-400)
            }
          })
          po.observe({ entryTypes: ['longtask'] })
          longtaskOn = true
        } catch { /* 不支持 longtask 就算了，帧间隔仍可用 */ }
      }

      /**
       * 强制同步布局（forced reflow）探针。
       *
       * 这是最能把「卡顿」解释清楚的指标，也是 pdf.js 与自绘标注层最典型的病根：
       * 只要「改样式/改 DOM」之后紧跟一次「读取几何」（getBoundingClientRect、
       * offsetTop、scrollTop、getComputedStyle…），浏览器就必须立刻重排整个页面，
       * 把本来可以合批的布局拆成一次一次同步做。几百次下来就是几秒。
       *
       * 检测方式：包住 Element.prototype.getBoundingClientRect 与 getComputedStyle，
       * 记录每次调用的耗时；若单次耗时超过阈值（说明触发了真实重排而非读缓存），
       * 就计一次「强制布局」。同时统计总调用次数与累计耗时。
       *
       * 注意：包装会带来微小开销，但这是纯函数转发，量级远低于它要测的重排本身。
       */
      const layout = (() => {
        /**
         * 阅读器子树根节点。由组件在挂载后写入，用来区分「阅读器内的布局读」
         * 和「DSH 主界面的布局读」。为 null 时全部算 outside —— 宁可少算，
         * 也不能把别处的开销记到阅读器头上。
         */
        const layoutRootRef = { el: null }

        let calls = 0
        let costly = 0
        let totalMs = 0
        let maxMs = 0
        let installed = false
        /** 阅读器子树内 / 外的累计耗时。两个都要，才能算出「账记在谁头上」。 */
        let insideMs = 0
        let insideCalls = 0
        let outsideMs = 0
        let outsideCalls = 0

        /**
         * 调用方归因。
         *
         * 光知道「布局读取吃掉 8.2 秒」没法改 —— 必须知道是谁在读。
         * 按「元素特征」分组聚合：哪个类名/标签的元素被读了这么多次、
         * 每次多贵。聚合完只在 summary 里给 top 5，日志量不增加。
         */
        const groups = new Map()
        /** 慢读的调用栈样本（只留前 2 帧），用来回答「是谁在读」而不是「读的是什么」 */
        const stacks = new Map()
        function bucketOf(el) {
          try {
            if (!el || el.nodeType !== 1) return 'non-element'
            const cls = typeof el.className === 'string' ? el.className : ''
            const tag = (el.tagName || '?').toLowerCase()
            // class 只取前两个，避免把动态样式名撑成无数个桶
            const key = cls ? `${tag}.${cls.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : tag
            return key.length > 60 ? `${key.slice(0, 60)}…` : key
          } catch {
            return 'unknown'
          }
        }

        /**
         * 这个元素是否在阅读器子树里。
         *
         * 关键修正：`Element.prototype.getBoundingClientRect` 是**全局原型**，
         * 包了它就会把 DSH 主界面（会话列表、消息流里的超链接、工具栏按钮）
         * 的布局读取一并算进阅读器的账上 —— 实测榜上出现过
         * `button.acoR2W_iconButton` 和 `a`（47 次 / 3.9 秒），都不属于阅读器。
         * 不区分内外，`layoutMs` 就是全应用的数，不能用来判断阅读器慢不慢。
         */
        function isInsideReader(el) {
          try {
            const root = layoutRootRef.el
            if (!root || !el) return false
            return root === el || root.contains(el)
          } catch {
            return false
          }
        }
        function note(el, d, kind) {
          const inside = isInsideReader(el)
          if (inside) { insideCalls += 1; insideMs += d } else { outsideCalls += 1; outsideMs += d }
          // 分桶只统计阅读器内的慢读 —— 外面的（DSH 主界面）不该混进热点榜
          if (!inside) return
          const b = bucketOf(el)
          let g = groups.get(b)
          if (!g) { g = { n: 0, ms: 0, max: 0, kind }; groups.set(b, g) }
          g.n += 1
          g.ms += d
          if (d > g.max) g.max = d
        }

        /**
         * 慢读的调用栈，只对 >1ms 的调用取，且只留前 2 帧。
         *
         * 归因到元素只能回答「读的是什么」（一个 `<a>`），回答不了「谁在读」。
         * 真正要改代码时必须知道调用方。栈取一次有成本，所以严格限定在慢调用上，
         * 并对同一调用点去重计数，避免撑爆内存。
         */
        function noteStack(d, reReadMs = -1) {
          try {
            const st = new Error().stack
            if (!st) return
            /**
             * **两帧要分开截断，不能先 join 再截。**
             *
             * 原来写的是 `frames.join(' <- ').slice(0, 160)`，而第一帧是
             * 我们自己的 patchedGBCR，路径长 + 行号列号，160 字符正好把
             * 第一帧占满 —— 真正要看的调用方（第二帧）一个字都留不下。
             *
             * 实测后果：日志里只有 `patchedGBCR ... client.js:644:53`，
             * 完全看不出是谁在读布局，排查停在原地。
             *
             * 现在各自压到 90 字符并去掉重复的插件路径前缀，两帧都留得下。
             */
            const tidy = (s) =>
              s
                .trim()
                .replace(/^at\s+/, '')
                .replace(/dsh-app:\/\/app\/plugins\/\?\?[^)]*$/, '(plugin)')
                .replace(/\(dsh-app:\/\/app\/[^)]*\)/, '(app)')
                .slice(0, 90)
            const frames = st.split('\n').slice(2, 4).map(tidy)
            const key = frames.join(' <- ')
            if (!key) return
            let g = stacks.get(key)
            if (!g) { g = { n: 0, ms: 0, max: 0, reReads: 0, reReadMax: 0 }; stacks.set(key, g) }
            g.n += 1
            g.ms += d
            if (d > g.max) g.max = d
            /**
             * 收下「紧跟着再读一次」的耗时。
             *
             * 判读方式：
             *   · reReadMax 很小（几毫秒） → 刚才那笔开销是**前面 DOM 写入
             *     积压**的，布局已被第一次读取冲干净。要去改那个写入方。
             *   · reReadMax 和 max 一个量级 → 这个元素本身就贵，读取真慢。
             *
             * 没有这个字段就只能看着 173ms 猜，方向全凭运气。
             */
            if (reReadMs >= 0) {
              g.reReads += 1
              if (reReadMs > g.reReadMax) g.reReadMax = reReadMs
            }
          } catch { /* 取不到栈就算了，不影响主功能 */ }
        }
        function topStacks(limit = 5) {
          return [...stacks.entries()]
            .map(([k, g]) => ({
              at: k,
              n: g.n,
              ms: Math.round(g.ms),
              max: round1(g.max),
              // 紧跟着的第二次读取：小 = 前面写入积压；大 = 读取本身贵
              reReadMax: round1(g.reReadMax || 0),
            }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, limit)
        }
        function topGroups(limit = 5) {
          return [...groups.entries()]
            .map(([k, g]) => ({
              el: k,
              n: g.n,
              ms: Math.round(g.ms),
              max: round1(g.max),
            }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, limit)
        }

        function install() {
          if (installed || typeof Element === 'undefined') return
          installed = true
          try {
            const proto = Element.prototype
            const origRect = proto.getBoundingClientRect
            if (typeof origRect === 'function') {
              proto.getBoundingClientRect = function patchedGBCR() {
                const s = now()
                const r = origRect.apply(this, arguments)
                const d = now() - s
                calls += 1
                totalMs += d
                if (d > maxMs) maxMs = d
                /**
                 * 阈值取 1ms：读缓存布局通常只有几十微秒，
                 * 一次真实重排至少在 1ms 量级，两者能分开。
                 */
                if (d > 1) costly += 1
                /**
                 * 只对**已经慢了**的调用做二次判断：刚才那 d 毫秒里，
                 * 有多少是「替前面某次 DOM 写入还债」。
                 *
                 * 做法：紧接着再读一次同样的 rect。若这次极快，说明布局已经
                 * 干净 —— 那么刚才那笔开销就是前面写入积压的，该去查写入方；
                 * 若这次还是慢，说明这个元素本身就贵（比如超长文本层）。
                 *
                 * 为什么不在每次调用前都探一次：那会让探针自己变成主要开销
                 * （强制布局发生在每一次读取上），测出来的数就不可信了。
                 * 只在慢调用上多付一次，代价可以忽略。
                 */
                let reReadMs = -1
                if (d > 4) {
                  try {
                    const s2 = now()
                    origRect.apply(this, arguments)
                    reReadMs = now() - s2
                  } catch { /* 失败就不给这个字段 */ }
                }
                /**
                 * 归因只在慢调用上做。快调用占绝大多数（98%），
                 * 逐次分组会把这份开销本身变成可观测的噪声。
                 * 栈也只在这类慢调用上取。
                 */
                if (d > 1) { note(this, d, 'rect'); noteStack(d, reReadMs) }
                return r
              }
            }
          } catch { /* 无法包装就算了，不影响阅读 */ }
          try {
            const origGCS = window.getComputedStyle
            if (typeof origGCS === 'function') {
              window.getComputedStyle = function patchedGCS(el) {
                const s = now()
                const r = origGCS.apply(this, arguments)
                const d = now() - s
                calls += 1
                totalMs += d
                if (d > maxMs) maxMs = d
                if (d > 1) costly += 1
                if (d > 1) { note(el, d, 'style'); noteStack(d) }
                return r
              }
            }
          } catch { /* 同上 */ }
        }

        function stats() {
          return {
            layoutReads: calls,
            layoutForced: costly,
            layoutMs: Math.round(totalMs),
            layoutMax: round1(maxMs),
            /** 阅读器子树内的读：这才是判断「阅读器卡不卡」该看的数 */
            layoutInsideMs: Math.round(insideMs),
            layoutInsideCalls: insideCalls,
            /** 阅读器之外的读：DSH 主界面等，只作对照，不计入阅读器的账 */
            layoutOutsideMs: Math.round(outsideMs),
            layoutOutsideCalls: outsideCalls,
            layoutTop: topGroups(5),
            layoutStacks: topStacks(10),
            /**
             * 全部慢读的**总量**，不受 top-N 截断影响。
             *
             * 只给榜单会漏：榜单按单条累计耗时排序取前十，若慢读很分散
             * （每条都只占一点），前十加起来远小于实际总量，看着像「没热点」，
             * 实际上是「到处都是」——这两种情况的改法完全不同。
             * layoutStackTotal 与 layoutMs 的比值能直接告诉我们是哪一种。
             */
            layoutStackTotal: (() => {
              let n = 0
              let ms = 0
              for (const g of stacks.values()) { n += g.n; ms += g.ms }
              return { n, ms: Math.round(ms) }
            })(),
          }
        }
        function reset() {
          calls = 0
          costly = 0
          totalMs = 0
          maxMs = 0
          insideMs = 0
          insideCalls = 0
          outsideMs = 0
          outsideCalls = 0
          groups.clear()
          stacks.clear()
        }
        return { install, stats, reset, setRoot: (el) => { layoutRootRef.el = el || null }, isInsideReader }
      })()

      /** 记录一个阶段的耗时（同步或异步都可以） */
      function phase(name, ms, extra) {        // 第二参数是数字时按「耗时」处理，否则当成纯标记（如页码），不参与求和
        if (typeof ms !== 'number') {
          phaseLog.push({ n: name, tag: ms, ...(extra || {}) })
          if (phaseLog.length > 200) phaseLog = phaseLog.slice(-200)
          return
        }
        if (!(ms >= 0)) return
        phaseLog.push({ n: name, ms: round1(ms), ...(extra || {}) })
        if (phaseLog.length > 200) phaseLog = phaseLog.slice(-200)
      }

      /**
       * 页渲染计数：回答「15 页是不是一次性全画了」和「有没有重复画」。
       *
       * 这里有**两份**计数，缺一不可：
       *   `painted`   —— 按汇总周期清零，回答「这一次操作里重复了几次」；
       *   `lifePainted` —— 从页面加载起从不清零，回答「这页总共被画了几次」。
       *
       * 为什么必须分开：汇总周期一再切分，同一页被画 6 次可能分散在 3 个周期里，
       * 每个周期各 2 次 —— 只看周期内计数会得出「没有重复」的错误结论。
       * 反过来，长周期计数又会把用户几次独立打开叠加在一起。
       * 两者放在同一条记录里，才能分清「一次操作内重复」和「多次打开各画一次」。
       */
      const painted = new Map()
      const lifePainted = new Map()
      function notePainted(pageNo) {
        painted.set(pageNo, (painted.get(pageNo) || 0) + 1)
        lifePainted.set(pageNo, (lifePainted.get(pageNo) || 0) + 1)
      }
      function paintedStats() {
        const pages = [...painted.keys()]
        const dup = [...painted.entries()].filter(([, n]) => n > 1)
        const lifeDup = [...lifePainted.entries()].filter(([, n]) => n > 1)
        return {
          paintedPages: pages.length,
          paintedList: pages.sort((a, b) => a - b).slice(0, 40),
          repaintPages: dup.length,
          repaintTimes: dup.reduce((a, [, n]) => a + (n - 1), 0),
          /** 本页生命周期内被重复画的页数与多余次数（跨周期累加，不受限流切分影响） */
          lifeRepaintPages: lifeDup.length,
          lifeRepaintTimes: lifeDup.reduce((a, [, n]) => a + (n - 1), 0),
          /** 明细，直接点名哪一页画了几次 */
          lifePaintMap: Object.fromEntries([...lifePainted.entries()].sort((a, b) => a[0] - b[0])),
        }
      }

      /**
       * 长任务归因：把 longtask 的时间区间和调用方打的时间窗做交集。
       *
       * 这是回答「主线程被谁占了」的关键 —— 光知道有 6 秒长任务不够，
       * 还要知道这 6 秒是不是落在 pdf.js 的某一段里。
       * 用法：const w = perf.window(); ...干活...; perf.attribute('pdf-render', w)
       */
      function windowOpen() {
        return { s: now(), e: 0 }
      }
      function attribute(label, w) {
        if (!w) return
        w.e = now()
        const covered = longTasks
          .filter((x) => x.t + x.d > w.s && x.t < w.e)
          .reduce((a, x) => a + Math.max(0, Math.min(x.t + x.d, w.e) - Math.max(x.t, w.s)), 0)
        phaseLog.push({
          n: label,
          ms: round1(w.e - w.s),
          // 这一段里主线程被长任务占了多久 —— 越大说明该段越「堵」
          blockedMs: Math.round(covered),
        })
        if (phaseLog.length > 200) phaseLog = phaseLog.slice(-200)
      }

      /** 包一个 Promise，量它真正 settle 的时间 */
      async function timed(name, fn, extra) {
        const s = now()
        try {
          return await fn()
        } finally {
          phase(name, now() - s, extra)
        }
      }

      /**
       * 汇总一条 perf:summary。
       * 低于 SUMMARY_MIN_GAP 的重复调用直接丢弃 —— 这是唯一的限流闸门，
       * 保证日志不会被探针撑爆。
       */
      function summary(label, extra) {
        const t = now()
        /**
         * 限流按 label 分开：一次操作里的 open / jump / scroll 不会互相挤掉。
         * 但全局仍有 2s 地板，避免极端情况下同一瞬间刷出一堆记录。
         */
        const lastSame = lastSummaryByLabel.get(label) ?? 0
        if (t - lastSame < SUMMARY_MIN_GAP) return false
        if (t - lastSummaryAt < 300) return false
        lastSummaryByLabel.set(label, t)
        lastSummaryAt = t

        /**
         * 本轮累积跨度 = 现在 - 上次清零的时刻。
         *
         * 早先这里写的是 `Math.round(t)`，直接把 performance.now() 的绝对值
         * 当成跨度报了出去 —— 于是日志里出现 spanMs=728687（12 分钟）、
         * 803776 这种荒唐数字，而实际每轮只有几秒。
         * 绝对值和时长量纲一样、单位也一样，肉眼极难发现，
         * 所以必须在日志里能自证：跨度应当 ≈ 各阶段耗时之和的量级。
         */
        const spanMs = periodStart > 0 ? Math.round(t - periodStart) : 0
        periodStart = t

        /**
         * 自证断言：跨度必须是「这一段」的量级，不能是绝对时间戳。
         *
         * 判据用各阶段耗时之和（含长任务）作参照 —— 跨度远超它，说明
         * periodStart 没被正确重置（比如又写回了 performance.now() 的绝对值）。
         * 这类错误量纲相同、单位相同，肉眼看不出来，只能靠断言兜住。
         */
        const phaseSum = phaseLog.reduce((a, p) => a + (typeof p.ms === 'number' ? p.ms : 0), 0)
        const ltSum = longTasks.reduce((a, x) => a + x.d, 0)
        const ref = Math.max(phaseSum, ltSum, 1)
        if (spanMs > ref * 3) {
          reportDiag({
            event: 'perf:suspect',
            label,
            spanMs,
            phaseSum: Math.round(phaseSum),
            longTaskMs: Math.round(ltSum),
            reason: 'spanMs 远超本轮各阶段耗时之和，向上限流或计时起点可能被污染',
          })
        }

        const frames = frameSamples
        const lt = longTasks
        const ltTotal = lt.reduce((a, b) => a + b.d, 0)
        const rec = {
          event: 'perf:summary',
          label,
          spanMs,
          frames: frames.length,
          frameP50: round1(percentile(frames, 50)),
          frameP95: round1(percentile(frames, 95)),
          frameMax: round1(frameMax),
          /** 超过 50ms ≈ 丢掉 3 帧以上，是肉眼可见的卡 */
          jank: frames.filter((v) => v > 50).length,
          /** 超过 200ms 基本等于「界面定住了」 */
          freeze: frames.filter((v) => v > 200).length,
          longTasks: lt.length,
          longTaskMs: Math.round(ltTotal),
          longTaskMax: lt.length ? Math.round(Math.max(...lt.map((x) => x.d))) : 0,
          phases: phaseLog.slice(-40),
          ...paintedStats(),
          ...layout.stats(),
          ...(extra || {}),
        }
        reportDiag(rec)

        // 汇总后清空，下一轮重新累积 —— 这样每个数都是「这一段」的，不是全程累加的
        frameSamples = []
        frameMax = 0
        longTasks = []
        phaseLog = []
        painted.clear()
        layout.reset()
        return true
      }

      return { now, startFrames, startLongTasks, phase, timed, summary, percentile, notePainted, paintedStats, windowOpen, attribute, installLayoutProbe: layout.install, setLayoutRoot: layout.setRoot, periodStart: () => periodStart }
    })()

    /**
     * vendor 模块的 blob URL 缓存。
     *
     * 为什么要缓存：importFromSource 每次都会 fetch 整个文件、再造一个
     * 新的 blob URL 交给 import()。而 pdf.js 这几个文件不小 ——
     * pdf.min.mjs 463KB、pdf.worker.min.mjs 1.2MB、pdf_viewer.mjs 315KB，
     * 合计约 2MB。**每打开一篇文献都要重来一遍**：重新下载、重新解析、
     * 重新编译。实测单次打开里 pdfjs:worker-mode 要 175ms、
     * viewer:before-setdoc 要 425ms —— 这 600ms 全花在这里，
     * 而真正读 PDF 只要 59ms、解析只要 15ms。
     *
     * 缓存之后，同一个 URL 在页面生命周期内只下载编译一次。第二篇起
     * 直接命中，import() 也走模块缓存，几乎瞬时。
     *
     * 用 Map 而非单例变量：三个模块各自缓存，互不影响。
     * 存的是 Promise 而不是 URL —— 并发调用时（首屏要同时准备 pdf.mjs
     * 与 worker）能共享同一次下载，不会各拉一份。
     */
    const vendorModuleCache = new Map()

    async function importFromSource(pathname) {
      const cached = vendorModuleCache.get(pathname)
      if (cached) return cached
      const pending = (async () => {
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
      })()
      /**
       * 失败**不能**留在缓存里：否则一次网络抖动会让这条路径永久坏掉，
       * 直到用户重启页面。所以失败时把它删掉，下次重试。
       */
      vendorModuleCache.set(pathname, pending)
      pending.catch(() => vendorModuleCache.delete(pathname))
      return pending
    }

    function getPdfjs() {
      if (!pdfjsPromise) {
        pdfjsPromise = (async () => {
          const moduleUrl = await importFromSource(`${API}/vendor/pdf.mjs`)
          const mod = await import(/* @vite-ignore */ moduleUrl)
          const lib = mod.getDocument ? mod : mod.default
          if (!lib?.getDocument) throw new Error('pdf.js 资源加载异常：模块里没有 getDocument')
          /**
           * worker 用 blob module worker + `workerPort`，不用 `workerSrc`。
           *
           * 实测（headless Chrome 四变体对照）证明 pdf.js 6.5 的 blob import 与 workerSrc
           * 两种做法都能出页，所以这不是黑屏的根因。但 `workerSrc` 依赖
           * `new Worker(url, {type:'module'})`，而宿主在 Electron 下的页面基址是自定义
           * scheme（`dsh-app://`），自定义 scheme 创建 Worker 可能被拒；显式传一个
           * blob module worker 端口可以绕开这个限制，而且不需要知道端口与主机名。
           *
           * `API` 保持相对路径：`fetch` 会按 `document.baseURI` 解析，
           * http 部署与自定义 scheme 部署都自动正确。
           */
          try {
            /**
             * **先试真 Worker，不成再退回主线程。**
             *
             * 为什么值得试：主线程模式下 pdf.js 的解析、字体、流解码全在 UI
             * 线程上跑，和渲染抢同一条线程。Zotero 用真 worker，解析在独立
             * 线程，界面不受影响 —— 这是两者体感差距的一个来源。
             *
             * 之前直接放弃了真 worker，因为「能创建但不回执，getDocument
             * 永久挂起，30 秒后超时，连错误都没有」。但那次的探针不够细：
             * 没有区分「构造失败」「postMessage 失败」「worker 脚本报错」
             * 三种情况，所以只知道坏、不知道为什么坏。
             *
             * 现在改成带**明确的握手超时**：worker 建好后必须在 4 秒内回一个
             * 消息，否则判定不可用、回退主线程。四种建法依次尝试，每种都记录
             * 结果，下次能直接看出是哪一环断的。
             *
             * 关键：`globalThis.pdfjsWorker` **只在回退分支里设置**。
             * 一旦设置，pdf.js 的 #initialize() 会直接走 #setupFakeWorker，
             * 真 worker 就永远没机会了（见 pdf.mjs 的 PDFWorker.#initialize）。
             */
            const workerUrl = await importFromSource(`${API}/vendor/pdf.worker.mjs`)

            /**
             * 探测这个环境到底能不能跑「会回执」的 worker。
             *
             * **不能直接往 pdf.worker.mjs 里 post 一条消息等它回**：那个模块
             * 只认自己的协议（MessageHandler 的 action），收到不认识的消息
             * 不会回话 —— 用它做探针会把「可用」误判成「不可用」。
             *
             * 正确做法：用一段 wrapper 脚本，让 worker **自己报告**
             * 「我起来了」和「vendor 模块能不能 import」。这样一次探测同时
             * 覆盖两件事：blob worker 能不能建、模块能不能在 worker 里加载。
             *
             * 用绝对地址而不是相对路径：worker 里的相对路径基准是 worker 自身
             * 的 blob URL，解析不出 /zotero-reader/... 这种页面路径。
             */
            const absWorker = new URL(`${API}/vendor/pdf.worker.mjs`, document.baseURI).href
            const wrapperCode = `
              try {
                await import(${JSON.stringify(absWorker)})
                self.postMessage({ zr: 'ok' })
              } catch (e) {
                self.postMessage({ zr: 'import-failed', message: String(e && e.message || e) })
              }
            `

            const canWorkerReply = () =>
              new Promise((resolve) => {
                let w = null
                let settled = false
                const finish = (ok, reason) => {
                  if (settled) return
                  settled = true
                  try { w?.terminate() } catch { /* ignore */ }
                  resolve({ ok, reason })
                }
                /**
                 * 8 秒窗口。worker 要 import 的是 1.2MB 的 min 版 worker 文件，
                 * 模块求值本身需要时间；这个数字给得宽是因为**超时的代价**是
                 * 退回主线程（功能正常、只是慢），而**误判可用的代价**是
                 * getDocument 永久挂起（打不开）。宁可等久一点。
                 */
                const timer = setTimeout(() => finish(false, 'no-reply-8s'), 8000)
                try {
                  const blob = new Blob([wrapperCode], { type: 'text/javascript' })
                  w = new Worker(URL.createObjectURL(blob), { type: 'module' })
                } catch (e) {
                  clearTimeout(timer)
                  return finish(false, `construct:${e?.message ?? e}`)
                }
                w.onmessage = (ev) => {
                  clearTimeout(timer)
                  const d = ev?.data ?? {}
                  if (d.zr === 'ok') finish(true, 'module-loaded')
                  else finish(false, `import-failed:${String(d.message ?? '').slice(0, 120)}`)
                }
                w.onerror = (e) => { clearTimeout(timer); finish(false, `onerror:${e?.message ?? 'unknown'}`) }
                w.onmessageerror = () => { clearTimeout(timer); finish(false, 'messageerror') }
              })

            const probe = await canWorkerReply()
            reportDiag({ event: 'pdfjs:worker-probe', ok: probe.ok, reason: probe.reason })

            if (probe.ok) {
              /**
               * 真 worker 可用 → 用 workerSrc 让 pdf.js 自己建实例。
               *
               * 不给 workerPort：它要求传一个我们 new 出来的 Worker，而探测阶段
               * 那个实例已经 terminate（一个 port 只能配一个 PDFWorker，见
               * pdf.mjs 的 #workerPorts WeakMap）。workerSrc 让 pdf.js 建自己的。
               *
               * 另外 pdf.js 对 workerSrc 这条路自带兜底：worker 触发 error 时
               * 会自动 #setupFakeWorker()，所以我们不用担心它彻底打不开。
               */
              lib.GlobalWorkerOptions.workerSrc = absWorker
              lib.GlobalWorkerOptions.workerPort = null
              reportDiag({ event: 'pdfjs:worker-mode', mode: 'dedicated-worker' })
            } else {
              /**
               * 回退主线程。设 `globalThis.pdfjsWorker` 会让 pdf.js 的
               * #initialize() 直接走 #setupFakeWorker —— 这正是我们想要的。
               */
              const workerLib = await import(/* @vite-ignore */ workerUrl)
              const Handler = workerLib?.WorkerMessageHandler ?? workerLib?.default?.WorkerMessageHandler
              if (!Handler) throw new Error('worker 模块里没有 WorkerMessageHandler')
              globalThis.pdfjsWorker = { WorkerMessageHandler: Handler }
              lib.GlobalWorkerOptions.workerPort = null
              reportDiag({ event: 'pdfjs:worker-mode', mode: 'main-thread' })
            }
          } catch (error) {
            reportDiag({ event: 'pdfjs:worker-fallback', message: String(error?.message ?? error) })
          }
          return lib
        })().catch((error) => {
          pdfjsPromise = null
          reportDiag({ event: 'pdfjs:load-failed', message: String(error?.message ?? error) })
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
      /*
       * 阅读区外壳：只负责「撑满剩余高度」。
       *
       * 滚动交给内层 .zr-pdfviewer-container —— 两层都 overflow:auto 会互相干扰，
       * 官方 viewer 的滚动位置计算（watchScroll）也会算错。
       */
      .zr-page{flex:1 1 auto;overflow:hidden;min-height:0;position:relative;display:flex;flex-direction:column}
      /*
       * 浮层锚点层：绝对定位覆盖整个阅读区，但**不接收鼠标事件**（pointer-events:none），
       * 所以不会挡住滚动、选中文本；它的子面板各自 pointer-events:auto。
       *
       * 关键点：这一层直接挂在根容器上（而不是 .zr-page 滚动容器里），
       * 因此 PDF 滚到第几页它都待在原地 —— 大纲不会再「只附在第一页」。
       */
      .zr-root{position:relative}
      /* 「已打开的 PDF」那栏顶部：与返回箭头同一行，纯文字切换，不铺灰底 */
      .zr-papers-bar{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--dsh-border,#333);flex:0 0 auto;overflow-x:auto}
      .zr-papers-chip{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;max-width:210px;padding:2px 6px;border-radius:5px;border:0;background:transparent;color:var(--dsh-text-secondary,#9a9a9a);font:inherit;font-size:12px;line-height:1.7;cursor:pointer}
      .zr-papers-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .zr-papers-chip:hover{background:rgba(255,255,255,.06)}
      .zr-papers-chip[data-active="1"]{color:var(--dsh-text-primary,#e6e6e6);font-weight:600}
      .zr-papers-x{opacity:0;font-size:11px;line-height:1;padding:0 1px}
      .zr-papers-chip:hover .zr-papers-x,.zr-papers-chip[data-active="1"] .zr-papers-x{opacity:.55}
      .zr-papers-x:hover{opacity:1}
      .zr-papers-empty{padding:16px 14px;color:var(--dsh-text-secondary,#9a9a9a);font-size:12px;line-height:1.8}
      .zr-page-anchors{position:absolute;inset:0;pointer-events:none;z-index:20}
      .zr-page-anchors > *{pointer-events:auto}
      .zr-canvas-wrap{display:flex;flex-direction:column;gap:10px;align-items:center;padding-bottom:12px}
      .zr-pagebox{position:relative;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.4);line-height:0;flex:0 0 auto}
      /*
       * 画布**绝不能**被 CSS 缩小（原先是 max-width:100%;height:auto）。
       *
       * 文字层和批注框是按「未缩放的 CSS 像素」绝对定位的。画布一旦被 max-width 压小，
       * 上层仍按原来的坐标去画 —— 于是越靠右偏得越多、框比字宽，选区和批注全部对不上。
       * 宁可让 .zr-page 横向滚动，也不破坏坐标系；适配栏宽交给载入时自动算的 scale。
       */
      .zr-pagebox canvas{display:block}
      /* 高亮/批注浮层：不参与布局、不吃鼠标事件，坐标直接相对 .zr-pagebox */
      .zr-float-layer{position:absolute;inset:0;pointer-events:none;z-index:2}
      /* 文字层样式由官方 pdf_viewer.css 提供（.textLayer），这里不再自定义 */
      .zr-pagemark{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.55);color:#fff;padding:1px 6px;border-radius:4px;font-size:11px;line-height:1.5}
      .zr-hl{position:absolute;background:rgba(255,196,0,.42);border-radius:2px;pointer-events:none;mix-blend-mode:multiply}
      /*
       * 跳转闪烁：点了文档内链接后，在落点处短暂铺一层蓝色半透明底，
       * 约 1 秒后淡出。和 .zr-hl（会话跳页留下的高亮）是两回事：
       *   · .zr-hl 由 highlight state 驱动、跟随标注层一起重建，会一直留着；
       *   · 这个是**一次性临时元素**，挂在页面元素上，自己定时移除。
       * 用独立 class 是为了两套生命周期互不影响 —— 复用 .zr-hl 的话，
       * 标注层重绘会把闪烁块当成常驻高亮重新画出来。
       *
       * 蓝色调（用户明确要的），multiply 让底下文字仍然透出来。
       */
      .zr-jump-flash{position:absolute;z-index:3;border-radius:2px;pointer-events:none;
        background:rgba(64,150,255,.34);mix-blend-mode:multiply;
        opacity:1;transition:opacity .45s ease-out}
      .zr-jump-flash[data-fade="1"]{opacity:0}
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
      /* 「本次搜索」的勾选删除工具栏 */
      .zr-pick-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;flex:0 0 auto;
        border-bottom:1px solid var(--dsh-border,#2a2a2a)}
      .zr-pick-all{display:inline-flex;align-items:center;gap:5px;cursor:pointer;
        font-size:11.5px;color:var(--dsh-text-secondary,#c8c8c8);user-select:none}
      .zr-pick-all input{width:13px;height:13px;margin:0;cursor:pointer;accent-color:var(--dsh-accent,#3d6af2)}
      /* 说明文案：明确「删的是记录不是文献」，避免误删恐慌 */
      .zr-pick-note{font-size:10.5px;line-height:1.45;color:var(--dsh-text-tertiary,#8a9096);
        padding:4px 12px 6px;flex:0 0 auto}
      .zr-pick-del{margin-left:auto;border:1px solid var(--dsh-border,#3f3f3f);border-radius:5px;
        background:transparent;color:inherit;font-size:11.5px;padding:3px 9px;cursor:pointer}
      .zr-pick-del:hover:not(:disabled){background:rgba(255,107,107,.14);border-color:#ff6b6b;color:#ff8080}
      .zr-pick-del:disabled{opacity:.45;cursor:default}
      /* 进入/取消选择模式的按钮：低调的描边样式，不抢视线 */
      .zr-pick-enter,.zr-pick-cancel{border:1px solid var(--dsh-border,#3f3f3f);border-radius:5px;
        padding:3px 9px;font-size:11px;cursor:pointer;background:transparent;color:inherit;opacity:.85}
      .zr-pick-enter{margin-left:auto}
      .zr-pick-enter:hover,.zr-pick-cancel:hover{opacity:1;background:rgba(255,255,255,.08)}
      .zr-pick-cancel:disabled{opacity:.45;cursor:default}
      /* 标题行：复选框与标题同一行，标题在剩余宽度里折行 */
      .zr-item-head{display:block}
      .zr-item-head-pick{display:flex;align-items:flex-start;gap:0}
      /* 勾选行：复选框 + 正文并排，正文占满剩余宽度 */
      .zr-item[data-picked="1"]{background:rgba(61,106,242,.12)}
      .zr-item-check{flex:0 0 auto;width:13px;height:13px;margin:0 8px 0 0;cursor:pointer;
        accent-color:var(--dsh-accent,#3d6af2);align-self:flex-start;margin-top:2px}
      .zr-item-main{flex:1 1 auto;min-width:0}
      /* 只有「本次搜索」的行带 .zr-item-pick 才改成 flex；普通列表项保持块级 */
      .zr-item.zr-item-pick{display:flex;align-items:flex-start}
      /* 标题与复选框同一行：标题本身不换行也不撑高行高 */
      .zr-item.zr-item-pick .zr-item-t{display:block}
      /*
       * 划词工具条。
       *
       * white-space:nowrap 是硬要求：六个按钮（翻译/解释/询问/高亮/下划线/便签）
       * 在窄侧栏里一旦被允许换行，就会挤成「翻/译」「解/释」两行，非常难看。
       * 所以宽度一律由内容决定，放不下时由 JS 整体平移，绝不折行。
       * width:max-content 保证 flex 容器不会被父级宽度限制（position:fixed 已不受影响，
       * 但显式声明让行为不依赖布局上下文）。
       */
      .zr-sel{position:fixed;z-index:60;display:flex;gap:4px;padding:4px;border-radius:8px;background:var(--dsh-bg-elevated,#2a2a2a);box-shadow:0 6px 22px rgba(0,0,0,.5);border:1px solid var(--dsh-border,#3a3a3a);white-space:nowrap;width:max-content}
      .zr-sel button{min-width:30px;height:26px;padding:0 8px;border-radius:6px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap}
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
      /* 删除按钮：贴在每条批注右侧，平时淡、悬停变红 */
      .zr-annot-del{margin-left:auto;flex:0 0 auto;border:none;background:transparent;color:inherit;
        opacity:.45;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;border-radius:4px}
      .zr-annot-row:hover .zr-annot-del{opacity:.9}
      .zr-annot-del:hover{color:#ff6b6b;background:rgba(255,107,107,.12)}
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
      /*
       * 官方 PDFViewer 的外壳。
       *
       * 官方样式要求滚动容器是 .pdfViewer、内层是 .pdfViewerContainer，
       * 这里只负责把它们撑满可用高度（官方 CSS 不设定高，它假设整页都是阅读器）。
       */
      /*
       * 官方 PDFViewer 的外壳。
       *
       * 结构必须是：相对定位的挂载点 → 绝对定位的滚动容器 → 文档流里的 .pdfViewer。
       * .pdfViewer 自己**不能**绝对定位 —— 它是被页面撑开的容器，
       * 设成 inset:0 会塌成零高度，页面就画不出来（实测：日志 viewer:ready 但一片空白）。
       */
      .zr-pdfviewer-host{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
      /*
       * 恢复阅读位置期间遮住画布。
       *
       * 为什么需要：pdf.js 在 setDocument 之后**总会先渲染第 1 页** ——
       * 那时页容器刚建出来、尺寸还没量准，无法滚动；而目标页要等 1.2–1.6 秒
       * 才画好。这段窗口里用户看到的就是第 1 页，随后才跳到目标页，
       * 表现为「先闪回第一页再回到当前页」。
       *
       * 实测时序（日志）：
       *   viewer:doc-set      → 目标=6
       *   +320ms  paint page=1   ← 用户在这里看到第 1 页
       *   +1522ms paint page=6   ← 这时才到正确位置
       *
       * 用 visibility 而不是 display:none —— 后者会让容器塌成 0 高，
       * pdf.js 立刻算不出页尺寸，反而更糟（这个坑项目里踩过）。
       * visibility 不改变布局，只是不画，隐藏期间 pdf.js 照常建页渲染，
       * 等目标页真的画好了再揭开。
       */
      .zr-pdfviewer-host[data-restoring="1"] .zr-pdfviewer-container{visibility:hidden}
      /*
       * 提示文字用伪元素，不额外插 DOM ——
       * host.innerHTML 会被反复清空重建，普通子元素得跟着一起管，
       * 伪元素则完全跟着 data-restoring 走，没有生命周期问题。
       */
      .zr-pdfviewer-host[data-restoring="1"]::after{content:"正在恢复阅读位置…";
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        font-size:12px;color:var(--dsh-text-tertiary,#8a9096);pointer-events:none}
      /*
       * PDF 内链接的悬停预览。
      /*
       * 链接悬停预览卡片。
       *
       * 最初是单行省略条（nowrap + ellipsis），只能显示一小段地址：
       * 长条目被截断、内部跳转只显示目标名，和 Zotero 自己的悬停卡片差很远。
       * 改成多行卡片：限宽放宽到 min(560px,86vw)，可换行、行高 1.6。
       *
       * 用 position:fixed 而不是 absolute：宿主 .zr-pdfviewer-host 是
       * overflow:hidden，absolute 定位的提示在贴边时会被裁掉。
       * fixed 相对视口，直接吃 getBoundingClientRect() 的值，不会被裁剪。
       * 代价是滚动时位置不会跟着动 —— 但鼠标移出链接就会隐藏，
       * 实际不会在滚动中停留。
       */
      .zr-link-tip{position:fixed;z-index:2147483000;
        /*
         * **没有边框、没有容器感。**
         *
         * 用户的原话是「悬浮窗外圈不要加黑色的方框」。原来有
         * border + box-shadow，看起来像一个浮起来的黑卡片；
         * 现在位图直接浮在页面上，容器只剩一条极淡的投影把它和
         * 正文区分开（完全去掉会糊在正文里，边界不清）。
         */
        padding:0;border-radius:4px;background:transparent;
        box-shadow:0 2px 10px rgba(0,0,0,.16);
        font-size:12px;line-height:1.6;color:var(--dsh-text-primary,#e6e6e6);
        /*
         * **接收鼠标事件。**
         *
         * 用户澄清了真实意图：「光标不落在悬浮窗以及超链接上连续超过 0.3s
         * 关闭悬浮窗。如果落在悬浮窗上需要有滑动悬浮窗页面的功能」。
         * 所以浮窗必须能收 mouseenter/mouseleave（参与 0.3s 判定），
         * 也必须能接收到滚轮去滚动它自己的内容。
         *
         * 注意「不能移动悬浮窗的页面」指的是**滚轮不能穿透到背后的 PDF**，
         * 不是「浮窗不可滚动」——见下面的 wheel 拦截。
         */
        pointer-events:auto;white-space:normal;overflow-wrap:anywhere;
        opacity:0;visibility:hidden;transition:opacity .12s}
      .zr-link-tip[data-on="1"]{opacity:1;visibility:visible}
      /*
       * 位图预览区：**一整页**，按浮窗宽度等比缩放。
       *
       * 高度由 JS 用行内值设成 popupH（0.3 × 页高，实测 297px），
       * 内容是一整页（同一页在 630px 宽下约 892px）→ 必然溢出，
       * 滚轮与滚动条才有可滚的余量（scrollHeight - clientHeight 大于 0）。
       *
       * **只允许纵向滚动。** 纵向滚动条会占掉约 5px 内容宽，630 宽的 canvas
       * 在 625 的内容框里就会横向溢出，浏览器再加一条横向滚动条 ——
       * 用户以前吐槽的「两个进度条」正是这么来的（实测 shotClientH 比
       * popupH 少 5px）。位图是按宽度等比缩放的，横向滚动没有意义，
       * 直接 overflow-x:hidden 把那条线去掉；代价是页面右缘约 5px
       * （通常是白边）被裁掉。
       *
       * 这里保留 max-height 只作骨架帧兜底：JS 还没写行内高度时，
       * 别让空槽塌成 0 高；一旦写入行内 height，它优先于这条规则。
       */
      .zr-link-tip .zr-tip-shot{display:block;overflow-y:auto;overflow-x:hidden;
        max-height:min(80vh,780px);background:#fff;border-radius:3px;
        overscroll-behavior:contain}
      /*
       * canvas 的显示尺寸由 JS 显式写死成 popupW × (页面高/宽 × popupW)
       * —— 宽度与浮窗同源，高度只按页面比例推。
       *
       * 这里不能再写 max-width:100%：那会在 canvas 比容器宽时把它压扁，
       * 又变成「canvas 和浮窗两套几何」。行内 style 也覆盖 height:auto，
       * 所以高度不会被宽度比例反推回去；溢出交给上面的 overflow:auto。
       */
      .zr-link-tip .zr-tip-shot canvas{display:block;max-width:none;height:auto}
      /* 位图加载中的占位，避免浮窗先塌成一条线再突然撑开 */
      .zr-link-tip .zr-tip-shot[data-loading="1"]{min-height:96px;
        background:var(--dsh-bg-elevated,#2b2b2b)}
      /* 文字补充行：位图之下，带一点底色以便在正文上可读 */
      .zr-link-tip .zr-tip-title{font-weight:600;color:var(--dsh-text-primary,#e6e6e6);
        display:block;margin-bottom:2px}
      /* 卡片副行：文献信息 / 页码，允许折行 */
      .zr-link-tip .zr-tip-line{display:block;color:var(--dsh-text-secondary,#d0d0d0);
        background:rgba(0,0,0,.62);padding:2px 6px;border-radius:3px}
      /* DOI / URL 那一行：蓝色下划线，模仿 Zotero 的可点样式（这里不可点，只做视觉区分） */
      .zr-link-tip .zr-tip-link{display:block;color:var(--dsh-accent,#6cb0ff);
        text-decoration:underline;overflow-wrap:anywhere;
        background:rgba(0,0,0,.62);padding:2px 6px;border-radius:3px}
      /* 目标名这类次要信息 */
      .zr-link-tip .zr-tip-dim{display:block;color:var(--dsh-text-tertiary,#c8c8c8);
        font-size:11px;background:rgba(0,0,0,.62);padding:2px 6px;border-radius:3px}
      /* 告警态：外部链接被宿主拒掉时用，颜色区分「这是个失败的提示」 */
      .zr-link-tip[data-warn="1"] .zr-tip-line,
      .zr-link-tip[data-warn="1"] .zr-tip-dim{color:#ffb4ab}
      /* 工具条里阅读控件与批注工具之间的分隔线 */
      .zr-sep{width:1px;height:18px;background:var(--dsh-border,#3a3a3a);margin:0 2px;flex:0 0 auto}
      /* 调色板：八个小色块，当前颜色加描边 */
      .zr-palette{display:inline-flex;align-items:center;gap:3px;padding:0 2px}
      .zr-swatch{width:14px;height:14px;border-radius:3px;border:1px solid rgba(0,0,0,.35);cursor:pointer;padding:0;
        outline:none;flex:0 0 auto}
      .zr-swatch[data-on="1"]{box-shadow:0 0 0 2px var(--dsh-accent,#3d6af2);border-color:transparent}
      .zr-pdfviewer-container{position:absolute;inset:0;overflow:auto}
      .zr-pdfviewer-container .pdfViewer{position:relative;padding-bottom:8px}
      /*
       * 把每一页的排版影响关在页内。
       *
       * 为什么需要：pdf.js 建文本层时会对整页 span 排序，每次比较都调
       * getBoundingClientRect。一旦布局是「脏」的，每次读都会触发一次
       * **全文档**重排 —— 我们这里有 14 个页容器，一次重排要把它们全算一遍，
       * 实测单次最高 149ms、累计 3.9 秒，就是滑动卡顿的主因。
       *
       * contain:layout 告诉浏览器：页内元素的变化不会影响页外布局，
       * 于是重排被限制在单个 .page 内，不再波及整个文档。.page 自身有
       * 明确的 width/height（pdf.js 按 viewport 写死），所以收缩尺寸计算
       * 是安全的，不会让页面塌掉。
       *
       * 这里刻意**不用** contain:strict / size：那会把 .page 的高度改成
       * 由内容决定，而 pdf.js 依赖它写死的 1056px 来做滚动定位，
       * 一旦塌成 0 高，翻页与恢复阅读位置全都会失效（踩过一次）。
       */
      .zr-pdfviewer-container .pdfViewer .page{contain:layout}
      /*
       * 批注浮层：只负责显示 Zotero 里已有的批注色块。
       *
       * 关键约束：**不能影响官方编辑器层的布局**。
       *   · 层自身 pointer-events:none —— 不抢鼠标事件，划词和编辑器都还要工作
       *   · 单条批注元素 pointer-events:auto —— 只让「批注自己」可点（选中/右键删除），
       *     层仍然是透的，所以批注之间、批注之外的空白处照常划词。
       *     这也避免了把整层设为 auto 后 textLayer 被挡住、选不中文字。
       *   · 不设 z-index —— 让它保持在默认层序里，避免与官方 .annotationEditorLayer
       *     抢层级（设了 z-index 会创建新的 stacking context，
       *     官方弹出的「添加评论」浮层就可能被压到页面顶部）
       */
      .zr-annot-layer{position:absolute;inset:0;pointer-events:none}
      .zr-annot-layer .zr-hl{position:absolute;background:rgba(255,196,0,.35);border-radius:2px;pointer-events:none;mix-blend-mode:multiply}
      .zr-annot-layer .zr-annot{position:absolute;border-radius:2px;pointer-events:auto;cursor:pointer;mix-blend-mode:multiply}
      /* 下划线：不铺底色，只在矩形底边画一条 2px 的线 */
      .zr-annot-layer .zr-annot-underline{position:absolute;pointer-events:auto;cursor:pointer;mix-blend-mode:multiply;border-bottom:2px solid currentColor}
      /* 便签：Zotero 里是 22pt 的方块角标，这里画成同尺寸的浅色方块 + 边框 */
      /* 边框走 currentColor；填充由 decoratePage 按批注颜色写成半透明色 ——
         写死一个黄色底会让改色后「边框变了、底还是黄的」，看起来像没改干净 */
      .zr-annot-layer .zr-annot-note{position:absolute;pointer-events:auto;cursor:pointer;border:2px solid currentColor;border-radius:3px}
      /*
       * 选中态：**一个**包围盒外框，不是每行一个。
       *
       * 为什么要单独一层 .zr-annot-select：一条跨行批注在 decoratePage 里会拆成
       * 每行一个 rect div，如果在每个 div 上画 outline，多行就变成一串小方框 ——
       * 用户明确否掉了那个样子。这里改成「算出这批 div 的联合包围盒，只画一个框」，
       * 由 JS 在最外层 .zr-annot-layer 里放一个绝对定位的空 div。
       * outline 不参与布局，不会把包围盒撑大、也不会挤压相邻批注。
       */
      .zr-annot-select{position:absolute;pointer-events:none;border-radius:3px;
        outline:2px solid var(--dsh-accent,#3d6af2);outline-offset:2px}
      .zr-annot-menu{z-index:62;min-width:186px;padding:6px;border-radius:10px;
        background:var(--dsh-bg-elevated,#2b2b2b);border:1px solid var(--dsh-border,#3f3f3f);
        box-shadow:0 12px 34px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.4);
        backdrop-filter:blur(6px)}
      /* 三点菜单是一列条目：色块 + 中文名 + 当前色对勾 */
      .zr-annot-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;
        padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsh-text-primary,#e4e4e4);
        font-size:12.5px;line-height:1.3;cursor:pointer}
      .zr-annot-menu button:hover{background:rgba(255,255,255,.10)}
      .zr-annot-menu button:disabled{opacity:.5;cursor:default}
      .zr-annot-menu .zr-annot-menu-del{color:#ff6b6b}
      .zr-annot-menu .zr-annot-menu-del:hover{background:rgba(255,107,107,.14)}
      .zr-menu-swatch{width:13px;height:13px;border-radius:3px;flex:0 0 auto;
        border:1px solid rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px rgba(255,255,255,.10)}
      .zr-menu-label{flex:1 1 auto;min-width:0}
      .zr-menu-check{width:12px;flex:0 0 auto;text-align:center;color:var(--dsh-accent,#7aa2ff);font-size:12px}
      .zr-menu-sep{height:1px;margin:5px 2px;background:var(--dsh-border,#3f3f3f)}
      /*
       * 批注面板（Zotero 式）：点一条批注后在它旁边弹出。
       *
       * 卡片边缘那个小三角是「指向被选中批注」的指示器，Zotero 也有：
       * 卡片在批注右边时三角在左边缘朝左（data-arrow="left"），反之朝右。
       * 三角的纵向位置由 JS 写成 --zr-arrow-y，对准批注的垂直中心。
       * position:fixed + 打开时算定的视口坐标；滚动即关闭由外层 effect 负责。
       */
      .zr-annot-card{position:fixed;z-index:61;width:300px;max-height:min(340px,70vh);
        display:flex;flex-direction:column;overflow:hidden;border-radius:10px;
        background:var(--dsh-bg-elevated,#2b2b2b);border:1px solid var(--dsh-border,#3f3f3f);
        box-shadow:0 14px 40px rgba(0,0,0,.62),0 2px 8px rgba(0,0,0,.4);
        color:var(--dsh-text-primary,#e4e4e4);backdrop-filter:blur(6px)}
      .zr-annot-card::before{content:"";position:absolute;width:9px;height:9px;
        background:inherit;box-shadow:0 0 0 1px var(--dsh-border,#3f3f3f)}
      .zr-annot-card::before{clip-path:polygon(0 0,100% 0,0 100%)}
      /* 上下排布：卡片在批注下方时三角朝上（贴卡片顶边），在上方时朝下（贴底边） */
      .zr-annot-card[data-arrow="top"]::before{top:-5px;left:var(--zr-arrow-x,50%);
        transform:translateX(-50%) rotate(45deg)}
      .zr-annot-card[data-arrow="bottom"]::before{bottom:-5px;left:var(--zr-arrow-x,50%);
        transform:translateX(-50%) rotate(225deg)}
      .zr-annot-card-head{display:flex;align-items:center;gap:7px;padding:7px 8px 7px 11px;
        border-bottom:1px solid var(--dsh-border,#3f3f3f);flex:0 0 auto}
      .zr-annot-card-kind{width:13px;height:13px;border-radius:3px;flex:0 0 auto;
        border:1px solid rgba(0,0,0,.35)}
      .zr-annot-card-page{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;letter-spacing:.2px;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .zr-annot-card-btn{flex:0 0 auto;border:0;background:transparent;color:inherit;
        opacity:.75;cursor:pointer;font-size:14px;line-height:1;padding:3px 5px;border-radius:5px}
      .zr-annot-card-btn:hover{opacity:1;background:rgba(255,255,255,.10)}
      .zr-annot-card-btn[data-on="1"]{opacity:1;background:rgba(255,255,255,.13)}
      .zr-annot-card-body{padding:8px 10px;display:flex;flex-direction:column;gap:7px;
        overflow:auto;flex:1 1 auto}
      /* 选中文字本身（highlight/underline 的批注正文）：Zotero 也把它显示在评论框上方 */
      .zr-annot-card-quote{font-size:12px;line-height:1.5;color:var(--dsh-text-secondary,#a8a8a8);
        border-left:2px solid var(--dsh-accent,#3d6af2);padding-left:7px;max-height:66px;overflow:auto}
      .zr-annot-card-input{width:100%;box-sizing:border-box;resize:vertical;min-height:58px;
        font:inherit;font-size:12.5px;line-height:1.5;padding:6px 7px;border-radius:6px;
        background:var(--dsh-bg-input,rgba(0,0,0,.22));color:var(--dsh-text-primary,#e4e4e4);
        border:1px solid var(--dsh-border,#3f3f3f);outline:none}
      .zr-annot-card-input:focus{border-color:var(--dsh-accent,#3d6af2)}
      .zr-annot-card-foot{padding:6px 10px 8px;border-top:1px solid var(--dsh-border,#3f3f3f);flex:0 0 auto}
      .zr-annot-card-tags{width:100%;box-sizing:border-box;font:inherit;font-size:12px;
        padding:4px 0;background:transparent;border:0;outline:none;color:var(--dsh-text-primary,#e4e4e4)}
      .zr-annot-card-tags::placeholder{color:var(--dsh-text-tertiary,#8a9096)}
      /* 标签 chip 列表：每项一个圆角小格，右侧 × 删除 */
      .zr-annot-taglist{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
      .zr-annot-tag{display:inline-flex;align-items:center;gap:3px;max-width:100%;
        padding:2px 4px 2px 7px;border-radius:10px;font-size:11.5px;
        background:var(--dsh-bg-hover,rgba(255,255,255,.09));color:var(--dsh-text-secondary,#c8c8c8)}
      .zr-annot-tag>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .zr-annot-tag-x{border:0;background:transparent;color:inherit;cursor:pointer;
        font-size:12px;line-height:1;padding:0 2px;opacity:.65}
      .zr-annot-tag-x:hover{opacity:1;color:#ff6b6b}
      .zr-annot-tag-x:disabled{opacity:.35;cursor:default}
      .zr-annot-card-note{font-size:11px;line-height:1.5;color:var(--dsh-text-tertiary,#8a9096)}
    `

    function useStyle() {
      useEffect(() => {
        /**
         * 官方 viewer 的样式表（168KB）。
         *
         * 必须加载，否则 `.pdfViewer` / `.page` / `.textLayer` 全部没有样式，
         * 页面会以纯文本流的形式堆叠，看起来就是「白屏」。
         * 走插件自己的 /vendor 路由，内容来自 pdfjs-dist 包内的 web/pdf_viewer.css。
         */
        const viewerCssId = 'zr-viewer-style'
        if (!document.getElementById(viewerCssId)) {
          const link = document.createElement('link')
          link.id = viewerCssId
          link.rel = 'stylesheet'
          link.href = `${API}/vendor/pdf_viewer.css`
          document.head.appendChild(link)
        }

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
    /**
     * 视口顶部「落在第 pageNo 页的百分之几」（0..1）。
     *
     * 提到模块作用域，是因为它被两处用：
     *   · 组件内 `pagechanging` 保存阅读位置
     *   · 工具栏「刷新」按钮在重载前同步落盘
     * 两处都需要同一套算法，复制一份迟早走偏。
     *
     * 拿不到几何信息时返回 0（等价于「停在页首」）—— 那是安全值。
     */
    /**
     * 找页元素真正在滚的那个祖先。
     *
     * 不能假定某个固定节点就是滚动容器：侧栏里叠着若干层 overflow:hidden，
     * pdf.js 又把页元素包在 .pdfViewer / .pdfViewerContainer 里，
     * 实际吃滚动的是哪一层只能按几何判定（overflow 为 auto/scroll 且内容高于自身）。
     */
    function findScrollParent(node) {
      let el = node?.parentElement ?? null
      let guard = 0
      while (el && guard++ < 12) {
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
        const overflowY = style?.overflowY ?? ''
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) return el
        el = el.parentElement
      }
      return null
    }

    /**
     * 把某一页滚到视野顶部，返回是否真的滚到位。
     *
     * 为什么不能只设 `viewer.currentPageNumber`：pdf.js 的 setter 内部按
     * **它自己的 container** 与页元素的 `offsetParent` 链滚动画布。侧栏这层
     * 容器是 overflow:hidden、`scrollHeight === clientHeight`，那条链落在
     * 一个永远不滚的节点上 —— 滚动被静默丢弃，不抛错、不生效。
     * 现场日志：hasScroller 为真，但 scrollerTop 恒为 0、716/716。
     *
     * 从 `gotoPage` 里提取出来，因为**加载时恢复阅读位置**走的是另一条路径，
     * 之前只设了页码、没做这层滚动，于是出现「页码显示第 4 页、视图停在第 1 页」
     * ——而且判据只看 currentPageNumber，还误报 ok:true。
     *
     * 做法：先 scrollIntoView 让浏览器把所有该滚的祖先一起滚开（不必猜是哪一层），
     * 再按**视口矩形差值**精确定位。不能用 offsetTop 直接相减：offsetTop 的
     * 参照系是 offsetParent，与滚动容器的 scrollTop 不同源。
     */
    function scrollPageIntoView(hostEl, pageNo, offset = 0) {
      try {
        const pageEl = hostEl?.querySelector(`.page[data-page-number="${pageNo}"]`)
        if (!pageEl) return false
        try { pageEl.scrollIntoView({ block: 'start', inline: 'nearest' }) } catch { /* 老内核忽略选项 */ }
        const scroller = findScrollParent(pageEl)
        if (!scroller) return true
        const pageH = pageEl.clientHeight || 0
        // 页首 + 页内偏移（offset 是 0..1 的比例，落在两页之间时用）
        const pageTop = pageEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        /**
         * 目标位置要夹在滚动区间内。
         *
         * 原来直接写 `pageTop - 8`，而第 1 页的 pageTop 是 0，算出来 -8。
         * `scrollTop` 最小是 0，永远差 8 像素 —— 于是下面那句
         * `Math.abs(scrollTop - target) <= 2` 对第 1 页**恒为 false**。
         *
         * 后果不是「第 1 页滚不动」这么简单：恢复流程拿 scrolled=false
         * 当失败，白白重试 25 次（日志 attempts=25 ok=False），
         * 期间 resumeDoneRef 一直不置位，用户这段时间的翻页全不被记录，
         * 而 pdf.js 在 setDocument 后抛的 pagechanging(1) 恰好在这时漏进来 ——
         * 位置就被覆盖成第 1 页，形成「刷新后总是回第一页」的循环。
         *
         * 夹住之后，第 1 页的 target 就是 0，滚到位即判定成功。
         */
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        const target = Math.min(
          maxTop,
          Math.max(0, pageTop - 8 + pageH * Math.min(0.98, Math.max(0, offset))),
        )
        if (Math.abs(scroller.scrollTop - target) > 2) scroller.scrollTop = target
        return Math.abs(scroller.scrollTop - target) <= 2
      } catch { return false }
    }

    function measureScrollOffset(scrollEl, hostEl, pageNo) {
      try {
        if (!scrollEl || !hostEl || !pageNo) return 0
        const pageEl = hostEl.querySelector(`.page[data-page-number="${pageNo}"]`)
        if (!pageEl) return 0
        const h = pageEl.clientHeight || 0
        if (h <= 0) return 0
        const rel = (scrollEl.scrollTop - (pageEl.offsetTop || 0)) / h
        if (!Number.isFinite(rel)) return 0
        return Math.min(0.98, Math.max(0, rel))
      } catch { return 0 }
    }

    /**
     * 连续缩放手势的判定间隔（ms）。
     *
     * 一次滚轮手势会连发 3–5 个 wheel 事件，彼此间隔几十毫秒。间隔小于这个值
     * 就认为是**同一次手势**，沿用第一次捕获的锚点；超过就当作新手势重新捕获。
     * 取 320ms：明显长于同一手势内的间隔，又短于人的两次独立缩放操作。
     */
    const ZOOM_GESTURE_GAP_MS = 320

    /**
     * **量出「页号 + 页内比例」，也就是 `scrollPageIntoView` 的入参。**
     *
     * 这是 `scrollPageIntoView(hostEl, pageNo, offset)` 的**反函数**：
     * 它按页顶 + `pageH * offset` 定位，这里就把当前滚动位置换算回同一个
     * `(pageNo, offset)`，两者拼起来才是「记住这个位置，之后原样回去」。
     *
     * 为什么不能用上面那个 `measureScrollOffset`：它是给「阅读位置存档」用的，
     * 收的是**滚动元素**、按 `offsetTop` 算 —— 而 `offsetTop` 的参照系是
     * `offsetParent`，与滚动容器的坐标系不同源。这里全部用**视口矩形差值**，
     * 与 `scrollPageIntoView` 里那一套完全同源，方向才不会差一页。
     *
     * 两个必须踩准的点：
     *   · 滚动容器用 `findScrollParent` 现找。`scrollRef.current` 挂在 `.zr-page`
     *     上，那个节点并不吃滚动，量它的 scrollTop 恒为 0。
     *   · clientHeight 为 0（显示为 none 的隐藏面板）时直接放弃，
     *     返回 null 由调用方决定压不压栈 —— 量不到就别记垃圾位置。
     *
     * 返回 `{ pageNo, offset }`；量不到返回 null。
     */
    function measurePosByGeometry(hostEl, pageNo) {
      try {
        if (!hostEl || !pageNo) return null
        const pageEl = hostEl.querySelector(`.page[data-page-number="${pageNo}"]`)
        if (!pageEl) return null
        const scroller = findScrollParent(pageEl)
        if (!scroller) return null
        const pageH = pageEl.clientHeight || 0
        if (pageH <= 0) return null
        /**
         * 视口顶部落在该页的百分之几（与 scrollPageIntoView 的算式同源）。
         *
         * `scrollPageIntoView` 的落点是
         *     scrollTop = pageTop - 8 + pageH * offset
         * 以它为基准反解：同一位置上，页顶相对滚动容器视口顶的位移是
         *     pageRect.top - scrollerRect.top = 8 - pageH * offset
         * 移项即得
         *     offset = (scrollerTop - pageTop + 8) / pageH
         * 那个 `+8` 是必须的：`-8` 是「放置」时让页眉别贴死上边框的余量，
         * 反算时不补回来，量出的比例会恒偏小 8/pageH（约 0.01 量级），
         * 而压栈→返回是一次往返，偏差会原样叠加到落点上。
         *
         * 夹到 0..0.98 —— 上界与 scrollPageIntoView 内部的 `Math.min(0.98, …)`
         * 对齐，否则量出 0.99 再传回去会被夹成 0.98，位置漂一小段。
         */
        const rel = (
          scroller.getBoundingClientRect().top
          - pageEl.getBoundingClientRect().top
          + 8
        ) / pageH
        if (!Number.isFinite(rel)) return null
        return { pageNo, offset: Math.min(0.98, Math.max(0, rel)) }
      } catch { return null }
    }

    /**
     * 找出屏幕坐标 (x, y) 底下是第几页。
     *
     * 先用 elementFromPoint —— 它给的正是「用户眼睛看到的那一页」，天然处理了
     * 页间距、批注浮层、文本层这些覆盖物。拿不到 `.page`（指针落在页间空隙、
     * 滚动条、或者某层抢了命中）时，退回按几何找：
     *   · 优先取垂直方向真正覆盖该点的页；
     *   · 都不覆盖就取垂直距离最近的一页（页间空隙就属于这种）。
     * 必须有兜底：指针停在两页之间的空白是很常见的，那时若放弃锚点，
     * 缩放就会退回「当前页贴顶」—— 正是要修的那个行为。
     */
    function pageElementAtPoint(hostEl, clientX, clientY) {
      try {
        if (!hostEl) return null
        const hit = (typeof document !== 'undefined' && document.elementFromPoint)
          ? document.elementFromPoint(clientX, clientY)
          : null
        const fromHit = hit?.closest?.('.page[data-page-number]')
        if (fromHit && hostEl.contains(fromHit)) return fromHit
        const pages = hostEl.querySelectorAll('.page[data-page-number]')
        if (!pages.length) return null
        let best = null
        let bestDist = Infinity
        for (const el of pages) {
          const r = el.getBoundingClientRect()
          if (r.height <= 0) continue
          if (clientY >= r.top && clientY <= r.bottom) return el
          const dist = clientY < r.top ? r.top - clientY : clientY - r.bottom
          if (dist < bestDist) { bestDist = dist; best = el }
        }
        return best
      } catch { return null }
    }

    /**
     * **记下缩放前的「指针锚点」。**
     *
     * 这是「以光标所在点为原点缩放」的全部依据：把屏幕点换算成
     * 「某页 + 该页内的归一化坐标 (nx, ny)」，缩放到任意比例后同一对
     * 归一化坐标仍然指同一个文档位置 —— 因为 pdf.js 的每页几何是纯线性缩放，
     * 页内归一化坐标不随 scale 改变。
     *
     * 注意 nx/ny **不夹到 [0,1]**：指针可能停在页边缘外一点（padding、页间空隙），
     * 那仍是合法的线性坐标，夹取反而会让锚点突然跳到页边，缩放时抖一下。
     */
    function captureZoomAnchor(hostEl, clientX, clientY) {
      try {
        const pageEl = pageElementAtPoint(hostEl, clientX, clientY)
        if (!pageEl) return null
        const pageNo = Number(pageEl.dataset.pageNumber)
        if (!Number.isInteger(pageNo) || pageNo <= 0) return null
        const rect = pageEl.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        return {
          pageNo,
          nx: (clientX - rect.left) / rect.width,
          ny: (clientY - rect.top) / rect.height,
          clientX,
          clientY,
        }
      } catch { return null }
    }

    /**
     * **缩放后把锚点拽回原处。**
     *
     * 缩放改变的是页面的 CSS 尺寸，于是同一归一化坐标会跑到屏幕的另一处。
     * 这里重新取该页当前的矩形，算出它此刻落在哪（wantX/wantY），
     * 再按差值滚动容器 —— 差值就是「该点被推开了多远」，滚回去即抵消，
     * 于是指针下的文档坐标点在屏幕上保持不动。
     *
     * 三个必须踩准的点：
     *   · 滚动容器用 findScrollParent 现找。`scrollRef.current` 挂在 `.zr-page`
     *     上，它不是真正吃滚动的节点，写它的 scrollTop 不产生任何效果
     *     （本项目为此专门留过注释，别再踩）。
     *   · 用增量 `+=` 而不是绝对赋值：pdf.js 在 #setScaleUpdatePages 里
     *     已经自己滚过一次（按旧 _location 保位，会贴顶），我们要在它的结果
     *     之上校正，不是从头定位。
     *   · 横向也要管：放大后页宽超过容器时，锚点的横向位置同样会漂。
     *
     * 返回实际补偿量，量不到就返回 null。
     */
    function applyZoomAnchor(hostEl, anchor) {
      try {
        if (!hostEl || !anchor) return null
        const pageEl = hostEl.querySelector(`.page[data-page-number="${anchor.pageNo}"]`)
        if (!pageEl) return null
        const rectNow = pageEl.getBoundingClientRect()
        if (rectNow.width <= 0 || rectNow.height <= 0) return null
        const scroller = findScrollParent(pageEl)
        if (!scroller) return null
        const wantX = rectNow.left + anchor.nx * rectNow.width
        const wantY = rectNow.top + anchor.ny * rectNow.height
        const dx = wantX - anchor.clientX
        const dy = wantY - anchor.clientY
        if (Math.abs(dx) > 0.5) scroller.scrollLeft += dx
        if (Math.abs(dy) > 0.5) scroller.scrollTop += dy
        return { dx, dy }
      } catch { return null }
    }

    /**
     * 判断两个锚点是否「其实是同一个点」。
     *
     * 同一个手势里若要沿用旧锚点，必须确认锚点仍是同一个物理位置：
     * 页号相同，且屏幕坐标几乎没变。若用户在同一次手势里把指针挪到了另一页，
     * 那就是换了注视目标，应当以新的为准 —— 否则会补偿到用户不再看的地方。
     */
    function isSameAnchorPoint(a, b) {
      if (!a || !b) return false
      if (a.pageNo !== b.pageNo) return false
      return Math.abs(a.clientX - b.clientX) <= 2 && Math.abs(a.clientY - b.clientY) <= 2
    }

    function Reader(props) {
      const bound = props.bound ?? ((k) => k)
      /** 宿主注入的会话 id：本面板的「已打开」桶就以它为键。 */
      const sessionId = props.sessionId
      const t = (key, vars) => {
        let text = bound(key)
        if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{{${k}}}`, String(v))
        return text
      }
      useStyle()

      const tabKey = props.tabKey ?? props.key ?? ''
      const [itemKey, setItemKey] = useState(() => keyFromTabKey(tabKey))

      /**
       * 挂载即上报一次。
       * 「面板纯黑、连工具栏都没有」这种情况，三态（loading/ready/error）都渲染不出来，
       * 说明组件可能压根没挂上。有了这条记录就能直接区分「没挂载」和「挂载了但渲染失败」。
       */
      useEffect(() => {
        reportDiag({
          event: 'reader:mount',
          tabKey,
          hasSessionId: Boolean(sessionId),
          hasCtx: Boolean(props.ctx),
        })
        /**
         * 探针心跳。
         *
         * 只有打开 PDF 才会产出 perf:summary，于是「日志里没有 perf 行」
         * 分不清是「页面还是旧代码」还是「刷新了但没打开 PDF」——
         * 这两种情况下要做的事完全不同。挂载时打一条版本心跳，
         * 一眼就能分辨：有心跳=新代码已加载，没心跳=需要刷新页面。
         */
        reportDiag({
          event: 'perf:probe-ready',
          version: PERF_PROBE_VERSION,
          raf: typeof requestAnimationFrame === 'function',
          longtaskObserver: typeof PerformanceObserver === 'function'
            && Array.isArray(PerformanceObserver.supportedEntryTypes)
            && PerformanceObserver.supportedEntryTypes.includes('longtask'),
          layoutProbe: typeof Element !== 'undefined' && Boolean(Element.prototype.getBoundingClientRect),
        })
      }, [])

      /**
       * 一开始就确立会话身份。
       *
       * 必须在任何一次「打开某篇」之前完成，否则 openedAdd 会先写进 `default` 桶，
       * 又被「已打开」那栏按真实 sessionId 的读取覆盖掉（这个 bug 已经踩过一次）。
       */
      useEffect(() => { openedLoad(sessionId) }, [sessionId])
      /**
       * 有 itemKey 才直接进阅读；否则一律先给列表。
       * 之前的 bug：无论 tab 带不带 key 都从 browse 起，而点卡片开的是裸 key，
       * 于是用户看到的是「上次那篇」，而不是全部文献。
       */
      const [mode, setMode] = useState(() => (keyFromTabKey(tabKey) ? 'read' : 'browse'))
      /**
       * 分段控件的当前段。提到 Reader 这层，是因为「打开某篇」要能把用户直接送到
       * 「已打开的 PDF」那一段 —— 段状态若留在 LibraryView 里就切不动。
       */
      const [segment, setSegment] = useState('library')   // library | papers | searched
      const [err, setErr] = useState(null)

      /**
       * 登记本面板的根节点，供「点击会话里的 zotero:// 链接」判断该记进哪个会话。
       *
       * `keepMounted: true` 让切走的面板留在 DOM 里，所以「谁在响应」不能靠挂载顺序，
       * 只能靠这一刻谁真的可见 —— 由 `currentReaderSession()` 现场看。
       * 依赖带 sessionId：同一个实例会随会话切换收到新的 sessionId，节点要登记到新会话名下。
       */
      const rootRef = useRef(null)
      useEffect(() => {
        registerReaderRoot(sessionId, rootRef.current)
        return () => registerReaderRoot(sessionId, null)
      }, [sessionId])

      /**
       * 监听「打开某一篇」的全局请求（会话里点 zotero:// 链接、或列表里点条目）。
       *
       * **按 sessionId 过滤**：事件是从 document 上全局派发的，不过滤的话那个
       * `display:none` 里的旧会话面板也会响应，把别的会话的 PDF 塞进自己的阅读区。
       * 老事件没有 sessionId（兼容），按「不指定会话=所有面板都响应」处理。
       */
      useEffect(() => {
        const onOpen = (event) => {
          const target = event?.detail?.sessionId
          if (target !== undefined && String(target) !== String(sessionId ?? '')) return
          const key = event?.detail?.itemKey
          if (key) {
            setItemKey(String(key).toUpperCase())
            // 打开一篇就跳到「已打开的 PDF」段，PDF 在那一栏里显示
            setSegment('papers')
            setMode('browse')
            setErr(null)
          }
        }
        window.addEventListener('zotero-reader:open', onOpen)
        return () => window.removeEventListener('zotero-reader:open', onOpen)
      }, [sessionId])

      /**
       * **不要把 PaperView 条件渲染掉。**
       *
       * 用户原话：「就不应该卸载组件，只要会话开着就让它留着，除非下次重启再全部卸载」。
       *
       * 原来这里是 `if (mode === 'read' && itemKey) return h(PaperView, ...)`：
       * 点「←」回列表时 mode 变 browse，PaperView 被条件渲染掉 = 卸载，
       * 连带 effect 的 cleanup 销毁 PDF 文档。再点回来就要重新取字节、重新解析、
       * 重建 PDFViewer、重渲染每一页 —— 这就是用户说的「有点笨重」。
       *
       * 现在改成：只要这篇论文还开着（itemKey 有值），PaperView 就**一直挂着**，
       * 只是用 display:none 隐藏。文档、viewer、页码、缩放、滚动位置全部原样保留，
       * 切回来是瞬时的。
       *
       * 与「已打开的 PDF」那一栏（PapersView）的做法一致 —— 那边早就用
       * `display:none` 保活了，两条路径现在语义统一。
       *
       * doc 的销毁只在**真正卸载**时发生（会话关闭/页面刷新），effect 的 cleanup
       * 保持原样，不做额外处理。
       */
      const readPane = itemKey
        ? h('div', {
            key: `reader:${itemKey}`,
            /**
             * 只在「read 态直接把 readPane 当根」时它是可见的根；browse 态它被
             * `display:none` 包在 shell 里，此刻 shell 的 ref 会随后覆盖掉它
             * （React 先设子节点、后设父节点的 ref），最终存的是可见的那个。
             */
            ref: rootRef,
            style: mode === 'read'
              ? { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }
              : { display: 'none' },
          }, h(PaperView, {
            itemKey,
            t,
            ctx: props.ctx,
            sessionId,
            // 隐藏态（mode 为 browse）不加载 PDF：容器宽高为 0 会让 pdf.js 建不出页，
            // 页码恢复随之失效。见 PaperView 里加载 effect 的说明。
            active: mode === 'read',
            onBack: () => setMode('browse'),
            onError: (message) => setErr(message),
            topError: err,
          }))
        : null

      if (mode === 'read' && itemKey) return readPane

      /**
       * browse 态：列表和 readPane **同时**渲染，readPane 只是 display:none。
       *
       * 不能在这里 `return h(LibraryView, ...)` 就完事 —— 那样 readPane 被条件
       * 渲染掉，PaperView 又会被卸载，绕回原来的问题。两个兄弟并存，
       * 由 CSS 决定谁可见（display:none 的子树不参与布局，也不影响列表）。
       */
      return h('div', {
        className: 'zr-root',
        /**
         * browse 态的可见根就是它。父节点 ref 在子节点之后设置，所以 readPane 隐藏时
         * 存下来的是这个 shell（它可见）；read 态则反过来，`readPane` 才是可见的那个。
         * 两者都只是「本会话面板的可见根」，`currentReaderSession()` 用它们区分会话。
         */
        ref: rootRef,
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      },
      readPane,
      h(LibraryView, {
        t,
        sessionId,
        ctx: props.ctx,
        tab: segment,
        setTab: setSegment,
        onPick: (key) => {
          /**
           * 点条目 → 另起一个 tab 打开这篇 PDF。
           *
           * 不再在本 tab 内切换内容：那样看两篇就会互相顶掉，回不到上一篇。
           * 同一个 key 再点只是一次「显示已有 tab」，所以重复点不会开重复 tab。
           *
           * 显式带上 sessionId：这里是「哪个会话的列表被点了」最清楚的一处，
           * 不依赖 `currentReaderSession()` 的 DOM 探测。
           */
          openInReader(props.ctx, key, sessionId)
        },
      }))
    }

    /* ---------------------------------------------------- 文献库列表 */

    function LibraryView({ t, onPick, sessionId, ctx, tab, setTab }) {
      /**
       * 一开始就把会话身份确立下来。
       *
       * 现在 `openedAdd` 必须显式带 sessionId，写进去的一定是正确的桶，所以这一步
       * 不再是「抢在写入之前确立身份」——它只是尽早把该会话的历史读进内存，
       * 免得用户点开第一篇时列表还没从 localStorage 恢复。
       */
      useEffect(() => { openedLoad(sessionId) }, [sessionId])

      /**
       * 两个来源，一个列表：
       *   · library  —— Zotero 全部文献（按用户自己的专题分组）
       *   · searched —— 本次会话里 AI 搜索命中过的文章（host 侧按 sessionId 记）
       * 用户要的是「能看全库，也能快速回到刚搜过的那几篇」，所以做成两个 tab。
       */
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
            /**
             * 会话 id 去掉 `session-` 前缀再发。
             * host 侧工具拿到的是 `exec.agent.id`（形如 `session-<uuid>`），
             * 而 tab 注入的 sessionId 可能不带前缀；两端都在同一个归一化规则下才对得上。
             */
            const sid = String(sessionId ?? '').replace(/^session-/, '') || 'default'
            /**
             * 诊断：把「前端拿到的原始 sessionId」和「归一化后发出去的 sid」都记下来。
             *
             * 「本次搜索」空白有两类原因，看这条就能一次分清：
             *   · sid 与 host 写入时用的 key 不一致 → 说明归一化规则没对齐（记的是 A，查的是 B）
             *   · sid 正确但 items 为空 → 说明 host 侧压根没写进这个会话
             */
            reportDiag({ event: 'searched:query', rawSessionId: String(sessionId ?? ''), sid })
            const data = await fetchJson(`${API}/searched?sessionId=${encodeURIComponent(sid)}`)
            reportDiag({ event: 'searched:result', sid, count: (data.items ?? []).length })
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

      /**
       * 「本次搜索」的选中集合：`Set<itemKey>`。
       *
       * 只对 searched tab 有意义，但放在这里而不是 LibraryView 外部 ——
       * 它在切 tab 时会被清掉（见下面的 effect），不做跨 tab 的残留。
       */
      const [pickedKeys, setPickedKeys] = useState(() => new Set())
      /**
       * 是否处于「选择待移除」模式。
       *
       * 默认关闭：列表平时就是干净的浏览状态，不带任何复选框。
       * 点工具栏的「移除记录」按钮才进入，此时每行前面才出现复选框，
       * 表头才出现全选 —— 用户不会一进来就看到一屏没用的方框。
       */
      const [pickMode, setPickMode] = useState(false)
      /** 删除请求在飞：按钮转圈并禁点，避免连点删两次。 */
      const [removing, setRemoving] = useState(false)
      /** 删除失败的原因；成功不提示。 */
      const [removeError, setRemoveError] = useState(null)

      const togglePick = useCallback((key) => {
        setPickedKeys((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])

      /**
       * 删掉当前「本次搜索」里选中的条目。
       *
       * **只删这份搜索记录**，Zotero 库里的文献一个字都不动 ——
       * 后端 /searched/remove 只操作 searched 这个 Map 并落盘。
       * UI 上的措辞必须把这一点说清楚，否则用户会以为自己的文献被删了。
       */
      const removePicked = useCallback(async () => {
        const keys = [...pickedKeys]
        if (keys.length === 0 || removing) return
        const sid = String(sessionId ?? '').replace(/^session-/, '') || 'default'
        setRemoving(true)
        setRemoveError(null)
        try {
          await fetchJson(`${API}/searched/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, keys }),
          })
          setPickedKeys(new Set())
          // 重新拉列表：删除结果以后端为准，不在前端自己过滤（避免两份真相）
          await load('', 'searched')
        } catch (e) {
          setRemoveError(String(e?.message ?? e))
        } finally {
          setRemoving(false)
        }
      }, [pickedKeys, removing, sessionId, load])

      /** 切走 tab / 重新搜索后，选中态与错误都要清掉，否则会残留到下一批结果上。 */
      useEffect(() => {
        setPickedKeys(new Set())
        setRemoveError(null)
      }, [tab, debounced])

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
            'data-on': tab === 'papers' ? '1' : '0',
            onClick: () => setTab('papers'),
          }, t('papersTab')),
          h('button', {
            className: 'zr-lib-tab',
            'data-on': tab === 'searched' ? '1' : '0',
            onClick: () => setTab('searched'),
          }, t('tabSearched')),
        ),
        // 搜索框只属于「全部文献库」：另两段没有可搜索的列表，摆着只会误导
        tab === 'library'
          ? h('div', { className: 'zr-lib-search' },
            h('input', {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: t('searchPlaceholder'),
              className: 'zr-input',
            }),
            h('button', { className: 'zr-btn', onClick: () => load(debounced, tab), title: t('refresh') }, '⟳'),
          )
          : null,
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

      /**
       * 「本次搜索」专用的一行：比通用 renderItem 多一个勾选框。
       *
       * 不复用 renderItem —— 那个函数还被「全部文献库」的专题树用着，
       * 给它加勾选参数会把两个 tab 的行为绑在一起。
       *
       * 点行本身仍然是「打开这篇 PDF」（保持原有交互）；
       * 只有点复选框才是「选中」—— 所以复选框那一下要 stopPropagation，
       * 否则勾选会顺带打开 PDF。
       */
      const renderSearchedItem = (item) => h('div', {
        key: item.key,
        className: pickMode ? 'zr-item zr-item-pick' : 'zr-item',
        'data-picked': pickedKeys.has(item.key) ? '1' : '0',
        onClick: () => {
          // 选择模式下点整行＝切换勾选，不要顺带打开 PDF
          if (pickMode) { togglePick(item.key); return }
          onPick(item.key)
        },
      },
      h('div', { className: 'zr-item-main' },
        /**
         * 复选框放进标题这一行。
         *
         * 之前它和 `.zr-item-main` 是平级 flex 子项，标题换行时复选框还停在
         * 第一行的顶部，看起来像是「分成了两行」。现在让它成为标题行内的
         * 第一个元素，标题再长也只在复选框右侧折行。
         */
        h('div', { className: pickMode ? 'zr-item-head zr-item-head-pick' : 'zr-item-head' },
          pickMode
            ? h('input', {
              type: 'checkbox',
              className: 'zr-item-check',
              checked: pickedKeys.has(item.key),
              title: t('searchedPick'),
              onClick: (event) => event.stopPropagation(),
              onChange: () => togglePick(item.key),
            })
            : null,
          h('div', { className: 'zr-item-t' }, item.title),
        ),
        h('div', { className: 'zr-item-m' }, [
          (item.authors ?? []).slice(0, 3).join(', '),
          item.year,
          item.publication,
        ].filter(Boolean).join(' · ')),
      ),
      )

      /** 全选复选框的三种状态：全选 / 半选 / 未选。 */
      const allKeys = state.items.map((item) => item.key)
      const pickedCount = allKeys.filter((k) => pickedKeys.has(k)).length
      const allPicked = allKeys.length > 0 && pickedCount === allKeys.length
      const somePicked = pickedCount > 0 && !allPicked

      const togglePickAll = () => {
        setPickedKeys(allPicked ? new Set() : new Set(allKeys))
      }

      /**
       * 「已打开的 PDF」这一栏**常驻**，只切显隐。
       *
       * 用户要求：「就不应该卸载组件，只要会话开着就让它留着，除非下次重启再全部卸载」。
       *
       * 宿主自己也这么做：`dsh-better-sidebar` 的 tab 容器用
       * `leaf.tabs.map(...)` **无条件渲染全部 tab**，非激活的只多一个
       * `display:none` 的 class（`.nArs4W_paneTabHidden`）。它没有 keepAlive
       * 之类的声明机制，因为默认就是全保留。
       *
       * 为什么这里尤其要紧：PapersView 里每一篇 PaperView 都持有 pdf.js 文档、
       * viewer、页码、缩放、滚动位置。条件渲染掉 PapersView 就等于把这些全部销毁，
       * 切回来必须重新取字节 + 解析 + 重建 viewer + 重渲染每一页 —— 就是「有点笨重」。
       *
       * **必须用 useMemo 固定元素引用**：如果每个分支各自调用一次
       * `h(PapersView, ...)`，即便类型相同，React 在不同位置的返回值也可能
       * 被当成不同的子树重建（实测表现：同一个 itemKey 出现两次
       * `viewer:before-setdoc`，其中一次 containerSize 是 0×0，画布直接白屏）。
       * 固定成同一个元素对象后，它在所有分支里都是「同一个 child」，
       * React 按 (type, key, position) 复用，effect 不会重跑。
       */
      const papersPane = useMemo(() => h('div', {
        key: 'zr-papers-pane',
        style: tab === 'papers'
          ? { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }
          : { display: 'none' },
      }, h(PapersView, { t, ctx, sessionId, paneActive: tab === 'papers' })), [tab === 'papers', t, ctx, sessionId])

      /**
       * **所有分支必须共用同一个外层结构。**
       *
       * 这里原来每个分支都各自 `return h('div', {key:'zr-lib'}, header, papersPane, ...)`
       * —— 看起来 key 相同、papersPane 也是同一个对象，但 React 的对账是基于
       * 「父容器下 children 数组的第几个位置」：不同分支里 papersPane 后面的
       * 兄弟节点数量和内容都不同，一旦切换分支，papersPane 的位置或相邻关系变了，
       * React 就认为那是另一棵树，**把 PapersView 整个卸载重建**。
       *
       * 后果非常贵：PapersView 里每篇 PaperView 都持有 pdf.js 文档、已建好的
       * 页面 DOM 与画布，卸载即全丢。重建时会重新 /pdf、重新 getDocument、
       * 重新 setDocument、重新画页 —— 这就是「切一下 tab 回来，PDF 又要加载一遍」。
       * 日志里 `<reader:mount>` 之后 0.1 秒内紧跟 `pdf:start` 出现了 42 次，
       * 全是这个原因。
       *
       * 所以改成：外层 `zr-lib > header + papersPane + content` 恒定不变，
       * 各分支只决定最后的 `content` 是什么。papersPane 永远在第 2 个位置、
       * 前后邻居固定，React 才会复用它而不是重建。
       */
      const shell = (...content) => h('div', { key: 'zr-lib', className: 'zr-root' }, header, papersPane, ...content)

      if (state.error) {
        return shell(h('div', { className: 'zr-err' }, state.error))
      }

      /**
       * 第三段：已打开的 PDF。
       *
       * 用户要求的布局是「全部文献库 | 已打开的 PDF | 本次搜索」三段并排，
       * 所以它不再是右栏另一个标签页，而是这个分段控件里的一段。
       * 这里必须在 loading / error 判断之后、且不依赖文档库数据（打开过的论文
       * 与文献库是否加载成功无关）。
       */
      if (tab === 'papers') {
        return shell(null)
      }

      if (state.loading && state.items.length === 0) {
        return shell(h('div', { className: 'zr-note' }, h('span', { className: 'zr-spin' }), ' ', t('loading')))
      }

      if (tab === 'searched') {
        if (state.items.length === 0) {
          return shell(h('div', { className: 'zr-empty' }, t('searchedEmpty')))
        }
        return shell(
          /**
           * 工具栏：平时只有一个「移除记录」入口；点进去才展开全选与删除。
           *
           * 措辞刻意区分「记录」与「文献」：
           * 这里删的只是「本次搜索」这份清单，Zotero 库里那篇论文毫发无伤。
           * 用户第一次看到「删除」很容易以为在删文献，所以按钮文案与下面的提示
           * 都点明「记录」。这是本功能唯一容易出误解的地方。
           */
          h('div', { className: 'zr-pick-bar' },
            pickMode
              ? [
                h('label', { className: 'zr-pick-all', key: 'all' },
                  h('input', {
                    type: 'checkbox',
                    checked: allPicked,
                    // 半选没有 React 属性，只能命令式设置（见下面的 ref）
                    ref: (el) => { if (el) el.indeterminate = somePicked },
                    disabled: state.items.length === 0,
                    onChange: togglePickAll,
                  }),
                  h('span', null, t('searchedPickAll')),
                ),
                h('button', {
                  key: 'del',
                  className: 'zr-pick-del',
                  disabled: pickedCount === 0 || removing,
                  title: t('searchedRemoveHint'),
                  onClick: removePicked,
                }, removing
                  ? t('searchedRemoving')
                  : t('searchedRemove', { n: pickedCount })),
                h('button', {
                  key: 'cancel',
                  className: 'zr-pick-cancel',
                  disabled: removing,
                  onClick: () => { setPickMode(false); setPickedKeys(new Set()) },
                }, t('cancel')),
              ]
              : h('button', {
                className: 'zr-pick-enter',
                onClick: () => setPickMode(true),
                title: t('searchedRemoveHint'),
              }, t('searchedEnterPick')),
          ),
          removeError ? h('div', { className: 'zr-err', style: { margin: '0 0 6px' } }, removeError) : null,
          pickMode ? h('div', { className: 'zr-pick-note' }, t('searchedPickNote')) : null,
          h('div', { className: 'zr-list' }, state.items.map(renderSearchedItem)))
      }

      // 全部文献库：按 Zotero 专题分组
      if (state.items.length === 0) {
        return shell(h('div', { className: 'zr-empty' }, debounced ? t('searchNoResult') : t('empty')))
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

      return shell(
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

    /**
     * 栏宽提示。
     *
     * 「已打开的 PDF」那栏里未激活的 PaperView 是 `display:none` 的，
     * 此时它自己的 clientWidth 为 0 —— 拿 0 算适配缩放会得出 0.4 这种荒谬值，
     * 第一次切过去就是横向溢出加错位。已显示的兄弟节点会把真实栏宽记在这里兜底。
     */
    let paneWidthHint = 0

    /* ------------------------------------------------------- 论文视图 */

    function PaperView({ itemKey, t, onBack, topError, ctx, sessionId, bare, active = true }) {
      const hostRef = useRef(null)
      const scrollRef = useRef(null)
      const pdfRef = useRef(null)          // { doc, pdfjs }
      const pageElsRef = useRef(new Map()) // pageNo → { wrap, canvas, textLayer }
      const renderTaskRef = useRef(new Map())
      /** scale=1 时第 1 页的宽度（pt）。「按宽适配」用它，而不是写死 612。 */
      const baseWidthRef = useRef(0)

      const [info, setInfo] = useState(null)
      const [status, setStatus] = useState('loading')  // loading | ready | error
      const [error, setError] = useState(topError ?? null)
      const [pageCount, setPageCount] = useState(0)
      const [visiblePage, setVisiblePage] = useState(1)
      const [jumpPage, setJumpPage] = useState(1)
      /**
       * 页码输入框的**编辑缓冲**：允许为空、允许是「1」「12」这种半截输入。
       *
       * 为什么不能直接把 jumpPage 绑给 input：删光内容时 Number('') 得 0，
       * 一旦被 ||1 兜成 1，受控 input 立刻被回填成「1」，光标也跳走 ——
       * 表现为「删不干净，删完自己变成 1，没法重新输入」。
       * 所以输入期间只有这个字符串在变，回车/失焦才解析成页码并走 gotoPage。
       *
       * null 表示「没在编辑」，此时显示 jumpPage 的值。
       */
      const [pageDraft, setPageDraft] = useState(null)
      const [scale, setScale] = useState(1.15)
      const [outlineOpen, setOutlineOpen] = useState(false)
      /**
       * 「跳转历史」栈的**可见层数**。
       *
       * 真正的栈在 hopStackRef 这个 ref 里（内容用 ref 才不会被闭包读旧），
       * 这里只镜像一个长度给按钮用 —— 按钮的 enabled/disabled 必须走 state，
       * 否则压栈之后 React 不重渲染，按钮会一直是灰的。
       */
      const [hopDepth, setHopDepth] = useState(0)
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
      /**
       * 批注列表面板里的选色就是工具条的选色 —— 同一个概念不要两个状态，
       * 否则用户在面板里选的颜色不会作用于下一次标注（反之亦然）。
       */
      const editColor = annotColor
      const setEditColor = setAnnotColor
      const [annotBusy, setAnnotBusy] = useState(false)
      const [annotListOpen, setAnnotListOpen] = useState(false)
      /** 正在删除的批注 key（删除中显示 …，避免连点重复删）。 */
      const [annotDeleting, setAnnotDeleting] = useState(null)
      /**
       * 正在改色的批注 key。
       *
       * 独立于 annotDeleting：删除和改色是两个动作，共用一个 state 会让
       * 「删到一半去改色」互相把对方的 busy 清掉。也和 annotMenu 无关 ——
       * 菜单是 annot-delete 的 state，这里只借它传进来的 key。
       */
      const [annotRecoloring, setAnnotRecoloring] = useState(null)
      /**
       * 正在删除的批注 key 的**同步镜像**。
       *
       * `annotDeleting` 是 state，同一个 tick 里连按两下 Delete 读到的还是旧值，
       * 挡不住重复请求；keydown 长按会真的重复触发，所以另用 ref 做硬闸。
       */
      const annotDeletingRef = useRef(null)
      /**
       * 当前选中的批注 key —— 点一下页面上已有的色块选中，再按 Delete 删除。
       *
       * 为什么要 ref 镜像：装饰层由 `decoratePage` 命令式重画，自动重画
       * （pagerendered、批注数据到货、缩放）时也要能恢复选中描边，那一刻读不到
       * 闭包里的最新 state。
       */
      const [annotSelected, setAnnotSelected] = useState(null)
      const annotSelectedRef = useRef(null)
      /**
       * 选中外框重画函数的 ref 镜像。
       *
       * `decoratePage` 每次 `layer.innerHTML = ''` 会把外框一起清掉，重画完必须
       * 再补一个；但它声明在 `paintAnnotSelection` 之前，直接引用会踩 TDZ。
       * 用 ref 中转：decoratePage 只调用 `paintSelectRef.current?.()`。
       */
      const paintSelectRef = useRef(null)
      /**
       * 每页上一次画批注时的内容签名，用来跳过「内容没变也重建 DOM」。
       *
       * `decoratePage` 被调用得很频繁（每页画完、批注到货、选中变化……），
       * 但多数时候这一页的批注没变。原来的实现每次都 `innerHTML = ''` 再
       * 全量重建，白白写一堆 DOM，还顺带弄脏布局、逼出强制重排。
       * 签名相同就整体跳过，见 decoratePage 里的用法。
       */
      const decorateSigRef = useRef(new Map())
      /**
       * 批注三点菜单：`{ key, pageNo, kind }`。坐标由卡片自己算（贴着卡片右上角），
       * 所以这里不再存 x/y —— 菜单的锚点是面板，不是鼠标。
       *
       * 刻意不复用 `pop`：那是划词工具条的保存/错误回执，粘在一起会让
       * 「点空白处关菜单」顺手把正在显示的译文弹窗也关掉。
       */
      const [annotMenu, setAnnotMenu] = useState(null)
      /**
       * 批注卡片（Zotero 式主面板）的位置与状态。
       *
       * `{ key, pageNo, kind, left, top, arrow, place }`：
       *   left/top  —— position:fixed 的视口坐标，由批注矩形包围盒算出来
       *   arrow     —— 指向批注的小三角朝上还是朝下（top/bottom）
       *   place     —— 卡片在批注右边还是左边（right/left），贴边时翻方向
       * 位置在打开那一刻算好：卡片开着的时候批注不会动，滚动则直接关闭。
       */
      const [annotPanel, setAnnotPanel] = useState(null)
      /**
       * `annotPanel` 的同步镜像。
       *
       * `closeAnnotPanel` 是在事件回调/effect 里被调用的，那里的 `annotPanel`
       * 可能是上一次渲染的闭包值（点空白关闭时读到 null 就白刷了）。
       * ref 永远指向最新值，用它判断「关闭的是哪一条」才可靠。
       */
      const annotPanelRef = useRef(null)
      annotPanelRef.current = annotPanel
      /** 评论草稿：`{ [annotKey]: 文本 }`。失焦时才写回 Zotero，输入过程只暂存在这里。 */
      const [annotDraft, setAnnotDraft] = useState({})
      /** `annotDraft` 的同步镜像，供 closeAnnotPanel 读取最新草稿。 */
      const annotationsDraftRef = useRef({})
      annotationsDraftRef.current = annotDraft
      /**
       * `closeAnnotPanel` 的转发 ref。
       *
       * 关闭入口散布在很早的事件回调里（点击委托、各种 effect），
       * 而它的真实实现依赖 `saveAnnotationMeta`（声明在后面）。
       * 直接引用会踩暂时性死区，所以先放一个稳定的转发函数在这里，
       * 等真实实现声明完再赋给 ref —— 调用时永远拿到最新那个。
       */
      const closeAnnotPanelRef = useRef(() => setAnnotPanel(null))
      const closeAnnotPanel = useCallback(() => closeAnnotPanelRef.current(), [])
      /**
       * 正在保存评论/标签的批注 key。
       *
       * 与 annotRecoloring 分开：改色和改评论是两个动作，
       * 共用一个 state 会让「改色途中改评论」互相把对方的 busy 清掉。
       */
      const [annotMetaBusy, setAnnotMetaBusy] = useState(null)
      /** 标签输入框的内容：`{ [annotKey]: 文本 }`（回车后清空）。 */
      const [annotTagDraft, setAnnotTagDraft] = useState({})
      const [annotations, setAnnotations] = useState([])
      /**
       * 批注数据的版本号。
       *
       * 批注是独立请求，通常晚于页面渲染返回；不重建 DOM 之后，页面不会再自己画一次，
       * 批注就不会出现。这个计数器专门用来触发一次「补画装饰层」。
       */
      const [annotVersion, setAnnotVersion] = useState(0)
      /** 每页在 scale=1 时的尺寸（pt）：缩放时先按它把所有页撑到位，避免只有可见页跟着变。 */
      const pageSizesRef = useRef(new Map())
      /**
       * 当前比例的镜像。
       *
       * 异步渲染里拿不到「最新」的 state（闭包会锁住旧值），用它判断一次渲染是否已经过期，
       * 过期就不写 DOM —— 否则旧比例的渲染会把页面改回旧尺寸，表现为几页大几页小。
       */
      const scaleRef = useRef(1)
      // 每次渲染同步镜像，供异步渲染判断「我这次是不是已经过期了」
      scaleRef.current = scale
      const attachmentKeyRef = useRef(null)
      /**
       * 当前可见页与当前编辑颜色的 ref 镜像。
       *
       * 编辑器的保存回调在 viewer 的异步闭包里执行，那里拿不到最新的 state，
       * 直接引用 state 会读到初始化时的旧值（典型表现：批注存到第 1 页）。
       */
      const visiblePageRef = useRef(1)
      const editColorRef = useRef('#ffd400')
      const [pop, setPop] = useState(null)               // { x, y, text, loading, title }
      const [selbar, setSelbar] = useState(null)         // { anchor, text, pageIndex, rects }
      const [mineruBusy, setMineruBusy] = useState(false)
      /**
       * 重新加载当前 PDF 的触发器。
       *
       * 加载 effect 的依赖里有 reloadToken —— 自增它就重走一整条 `pdf:start` 链路
       * （重新取字节、重建 PDFViewer、清掉旧 DOM）。页码不丢：它存在 localStorage 里，
       * viewer 的 effect 重建时按同一把钥匙读回来。
       */
      const [reloadToken, setReloadToken] = useState(0)

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
       * 把标题记进「自己那个会话」的切换条。
       *
       * 单独一个 effect、依赖带 sessionId：原来它写在加载 doc 的异步链里，
       * 那条链的依赖只有 itemKey，切会话时不会重跑 —— 标题就记到旧会话的桶里去了。
       */
      useEffect(() => {
        if (!info?.title) return
        openedTitle(sessionId, itemKey, info.title)
      }, [sessionId, itemKey, info?.title])

      /**
       * 加载 Zotero 里已有的批注。
       *
       * 与文档元信息分开取：批注会随用户在 Zotero 里操作而变，
       * 而且这里还要顺带拿到「能不能写」（取决于 Zotero 是否在运行、本地 API 是否开启）。
       */
      const loadAnnotationsFromZotero = useCallback(async () => {
        if (!ANNOTATIONS_ENABLED) return []
        try {
          const data = await fetchJson(`${API}/annotations?key=${encodeURIComponent(itemKey)}`)
          const list = Array.isArray(data.annotations) ? data.annotations : []
          annotationsRef.current = list
          setAnnotations(list)
          setAnnotationCount(list.length)
          // 触发装饰层补画：页面早已渲染完，不会自己再画一次
          setAnnotVersion((v) => v + 1)
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
        /**
         * 换文献必须清掉装饰签名。
         *
         * 签名里含页号与批注 key，按理不同文献不会撞 —— 但两篇文献停在
         * 同一页、又都没有批注时，签名会完全一致（`页号#宽#高##`），
         * 于是新文献的页面会因为是「相同签名」而被跳过重建。
         * 清零最省事，也最不容易在以后改签名格式时踩坑。
         */
        decorateSigRef.current.clear()
        // 换文献时先抹掉上一批批注的图，再等新数据到货补画
        setAnnotVersion((v) => v + 1)
        loadAnnotationsFromZotero()
      }, [itemKey, loadAnnotationsFromZotero])

      /* ---------- 加载 PDF ---------- */
      /**
       * 本次打开 PDF 的性能计时窗口，供 viewer 的 effect 共用。
       *
       * 两个 effect 有明确分工：这个负责取字节 + getDocument，
       * viewer 那个负责 setDocument + 建页。`setDocument-total` 要衡量
       * 「点开文献到页建好」的整段，起点必须在这个 effect 里拿，
       * 而终点在另一个 —— 所以只能经由 ref 传递。
       */
      const openWinRef = useRef(null)
      useEffect(() => {
        let alive = true
        /**
         * **隐藏时不要加载。**
         *
         * 这一层 tab 用 `display:none` 保活（切走不卸载，切回来瞬时），
         * 但副作用是：元素在但宽高为 0。原先这里是直接开跑的，
         * 于是加载链路走进 `waitForSize()` 的死等 —— 实测
         * `viewer:before-setdoc` 连续三次都是 `sized:false, {w:0,h:0}`，
         * pdf:ready 到 before-setdoc 之间白耗 4.8 秒。
         *
         * 更糟的是等在 0×0 后面照常 setDocument：pdf.js 在零尺寸容器里
         * 建不出页视图，`viewer.currentPageNumber = n` 全部被静默丢弃，
         * 12 次重试都失败（日志 `want:3 got:1 attempts:13 ok:false`），
         * 用户看到的就是「重启后加载很久，然后跳回第 1 页」。
         *
         * 所以：不可见就什么都不做，等 active 变 true 再整条重来。
         * 依赖里带上 active，隐藏→显示会自然触发一次完整加载。
         *
         * **但「不可见就不加载」只该管首次加载，不该管已加载的文档。**
         *
         * 把 active 放进依赖的副作用是：切走 tab 时 active 变 false，
         * cleanup 就销毁 pdf.js 文档、清空 DOM；切回来 effect 重跑，
         * 重新 /pdf、getDocument、setDocument —— 用户看到「先黑屏再刷新」。
         * 日志证据：00:32:10~00:32:35 的 25 秒里 pdf:start 出现 6 次，
         * 而 reader:mount 只有 1 次 —— 组件没重挂，是 effect 在反复跑。
         *
         * 真正的诉求只是「别在 0×0 里白跑第一趟」。已经拿到过文档的，
         * 隐藏时保持原样即可（DOM 还在、画布还在，切回来瞬时），
         * 这正是当初把 PaperView 常驻的意义。
         */
        if (!active && !pdfRef.current) return undefined
        /**
         * **必须先把状态压回 loading。**
         *
         * 这是「刷新按钮点了没反应」的根因：
         *   ① reloadToken 变化 → 本 effect 的 cleanup 执行，把 pdfRef 置 null；
         *   ② viewer effect 依赖里也有 reloadToken，于是它也重跑，
         *      但它开头有 `if (status !== 'ready') return` 和 `if (!pdf) return` ——
         *      此刻 pdfRef 已是 null，它**什么都不做就返回了**；
         *   ③ 本 effect 重新取到字节、写好 pdfRef、再 setStatus('ready')，
         *      可 status 本来就是 'ready'，**值没变 → viewer effect 不会被重新触发**。
         * 结果：doc 有了，viewer 却永远没重建，画面停在旧状态（或空白）。
         *
         * 在这里压回 loading 就打破了那个死结：status 真正发生 ready→loading→ready
         * 的变化，viewer effect 才会在数据就绪后重新跑一次。
         */
        setStatus('loading')
        /**
         * **尺寸闸门要放在下载之前，而不是放到 setDocument 之前。**
         *
         * 日志实测（同一毫秒两条 pdf:start，同一个 itemKey）：刷新后右栏和
         * 主区各挂了一个 PaperView，其中隐藏的那个容器是 0×0。原来的闸门在
         * viewer effect 里，那时整篇 PDF 已经下载并解析完了 —— 于是隐藏实例
         * 每重来一轮就白下载 650KB、白解析一遍，连着重来 9 次
         * （viewer:defer-zero-size attempt 0→8）。
         *
         * 挪到这里：没有尺寸就**连请求都不发**。用 ResizeObserver 等它出现
         * 真实尺寸（隐藏的 `display:none` 元素不会触发，这正是我们要的），
         * 一旦可见立刻接着加载 —— 既没有自旋，也不用轮询。
         */
        let sizeObserver = null
        ;(async () => {
          const laidOut = await new Promise((resolve) => {
            const el = hostRef.current
            if (!el) { resolve(false); return }
            if (el.clientWidth > 0 && el.clientHeight > 0) { resolve(true); return }
            reportDiag({ event: 'pdf:await-size', itemKey })
            sizeObserver = new ResizeObserver(() => {
              if (!alive) return
              if (el.clientWidth > 0 && el.clientHeight > 0) {
                try { sizeObserver?.disconnect() } catch { /* ignore */ }
                resolve(true)
              }
            })
            sizeObserver.observe(el)
          })
          if (!alive || !laidOut) return
          reportDiag({ event: 'pdf:start', itemKey })
          /**
           * 打开一篇 PDF 是这套阅读器最重的操作，探针从这一刻开始累积。
           * 采样器只启动一次（内部有幂等守卫），重复调用无副作用。
           */
          perf.startFrames()
          perf.startLongTasks()
          // 强制同步布局计数：必须在打开前装好，否则漏掉首屏最大的一段
          perf.installLayoutProbe()
          /**
           * 划定阅读器子树边界。
           *
           * 布局探针包的是全局 `Element.prototype`，不圈定范围就会把
           * DSH 主界面的布局读取（消息流超链接、工具栏按钮）算进阅读器的账 ——
           * 实测榜上出现过 47 次读取耗时 3.9 秒的 `<a>`，那根本不是阅读器的元素。
           * 这里用 hostRef（阅读器宿主）作根，内外分开统计。
           */
          perf.setLayoutRoot(hostRef.current)
          /**
           * 计时窗口要跨两个 effect 用，所以存到 ref 上。
           *
           * `setDocument` 跑在**另一个** effect 里（viewer 那个，依赖 status 变成
           * 'ready' 才启动），把它写成局部 const 会直接 ReferenceError ——
           * 实测「官方阅读器加载失败：openWin is not defined」，PDF 完全打不开。
           * ref 让两个 effect 共享同一个起点，`setDocument-total` 才是从这里算起。
           */
          const openWin = perf.windowOpen()
          openWinRef.current = openWin
          try {
            /**
             * **单独给「加载 pdf.js」计时，别混进 fetch-bytes。**
             *
             * 原来 openWin 建好之后紧接着就 await getPdfjs()，于是首次加载
             * 那 460KB+1.2MB 模块的时间全被算进 fetch-bytes ——
             * 日志里出现过 fetch-bytes=16162ms 而 getDocument 只有 3.3ms
             * 的荒谬组合：等的是模块，账却记在取字节上，方向完全带偏。
             *
             * 拆成独立阶段后，才能看出「首次冷启动」与「取文件慢」是两回事。
             */
            const pdfjsWin = perf.windowOpen()
            // 两处都套超时：任何一个 await 不 settle 都会让界面永久停在「加载中」
            const pdfjs = await withTimeout(getPdfjs(), 15000, '加载 pdf.js')
            perf.attribute('load-pdfjs-module', pdfjsWin)

            /**
             * 不要用 `getDocument({ url })`。
             *
             * 页面基址是自定义 scheme（`dsh-app://app/`），pdf.js 的 URL 加载器走 XHR，
             * 实测在这个环境里永远不 settle —— 客户端日志只剩 `pdf:start`，30 秒后报
             * 「读取 PDF 超时」，连一个 HTTP 状态都拿不到，没有任何可查的线索。
             * `fetch` 在同一个页面里是通的（文献库、设置全走它），所以先取字节，
             * 再把 `data` 交给 pdf.js；顺带也不依赖服务端的 Range 支持。
             */
            const res = await withTimeout(
              fetch(`${API}/pdf?key=${encodeURIComponent(itemKey)}`, { credentials: 'same-origin' }),
              20000,
              '下载 PDF',
            )
            if (!res.ok) throw new Error(`下载 PDF 失败：HTTP ${res.status}`)
            const bytes = new Uint8Array(await withTimeout(res.arrayBuffer(), 20000, '读取 PDF 字节'))
            reportDiag({ event: 'pdf:bytes', itemKey, bytes: bytes.length })
            perf.attribute('fetch-bytes', openWin)

            const docWin = perf.windowOpen()
            /**
             * `wasmUrl` 必须给 —— 否则 CCITT / JBIG2 / JPEG2000 的图全是空白。
             *
             * pdf.js 6.5 把这些图像解码器搬进了 WASM，运行时按
             * `wasmUrl + 文件名` 去取。默认值是 null，拼出来就是
             * "nulljbig2.wasm"，必然 404，而失败是**静默**的（只有一条
             * warning，图直接不画）。
             *
             * 实测：2001 年那篇 Seeing Sets 有 3 张 /CCITTFaxDecode 图，
             * 阅读器里整块空白，Zotero 却能显示 —— 差别就在这里。
             *
             * 末尾必须带斜杠：pdf.js 是直接字符串拼接（`${wasmUrl}${filename}`），
             * 漏了斜杠会拼成 ".../vendorjbig2.wasm"。用绝对地址而不是相对路径，
             * 因为页面基址是 dsh-app:// 自定义 scheme，相对路径容易被解析歪。
             */
            const wasmBase = new URL(`${API}/vendor/`, document.baseURI).href
            const doc = await withTimeout(
              pdfjs.getDocument({ data: bytes, wasmUrl: wasmBase }).promise,
              30000,
              '解析 PDF',
            )
            perf.attribute('getDocument', docWin)
            if (!alive) { doc.destroy?.(); return }
            pdfRef.current = { doc, pdfjs }
            setPageCount(doc.numPages)

            /**
             * 载入即按栏宽适配。
             *
             * 这样做不是为了好看，是为了**坐标系正确**：画布不再被 CSS 缩小，
             * 所以必须让 scale 本身就适配栏宽，否则宽页面要横向拖动才看得全，
             * 而文字层/批注框也就不会因为外层缩放而错位（错位只会由缩放引起）。
             */
            try {
              const first = await doc.getPage(1)
              const base = first.getViewport({ scale: 1 })
              baseWidthRef.current = base.width
              /**
               * 预取每页尺寸（只读元数据，很便宜）。
               *
               * 缩放时先按这些尺寸把所有页的盒子撑到目标大小，否则只有已经渲染过的
               * 可见页会变 —— 用户看到的就是「缩放只对部分页面生效」。
               *
               * 但**不能串行 await**：原来是 `for (i=1..600) await doc.getPage(i)`，
               * 等于把主线程连续切碎 600 次，一打开就明显卡住（用户实测反馈）。
               * 现在按批并发，并且只预取前 120 页 —— 更远的页滚到时再补，
               * 拿不到尺寸就用 minHeight 兜底，不影响正确性。
               */
              pageSizesRef.current = new Map()
              const sizeLimit = Math.min(doc.numPages, 120)
              const CONCURRENCY = 16
              const sizeWin = perf.windowOpen()
              for (let base = 1; base <= sizeLimit; base += CONCURRENCY) {
                const batch = []
                for (let i = base; i < Math.min(base + CONCURRENCY, sizeLimit + 1); i += 1) {
                  batch.push(
                    (i === 1 ? Promise.resolve(first) : doc.getPage(i))
                      .then((page) => {
                        const vp = page.getViewport({ scale: 1 })
                        pageSizesRef.current.set(i, { w: vp.width, h: vp.height })
                      })
                      .catch(() => { /* 单页取不到就跳过，渲染时再兜底 */ }),
                  )
                }
                await Promise.all(batch)
                // 每批让出一帧，避免连续占用主线程把界面卡死
                if (!alive) return
              }
              const paneWidth = (scrollRef.current?.clientWidth ?? 0) || paneWidthHint
              perf.attribute('prefetch-page-sizes', sizeWin)
              if (paneWidth > 80 && base.width > 0) {
                setScale(Math.max(0.4, Math.min(3, Number(((paneWidth - 24) / base.width).toFixed(3)))))
              }
            } catch { /* 拿不到就沿用当前缩放 */ }

            setStatus('ready')
            reportDiag({ event: 'pdf:ready', itemKey, numPages: doc.numPages })

          } catch (e) {
            if (!alive) { reportDiag({ event: 'pdf:error-after-unmount', itemKey, message: String(e?.message ?? e) }); return }
            setError(e.message || String(e))
            setStatus('error')
            reportDiag({ event: 'pdf:error', itemKey, message: String(e?.message ?? e) })
          }
        })()
        return () => {
          alive = false
          // 还在等尺寸的观察者要断开，否则组件已卸载还在盯一个死节点
          try { sizeObserver?.disconnect() } catch { /* ignore */ }
          sizeObserver = null
          for (const task of renderTaskRef.current.values()) { try { task.cancel() } catch { /* ignore */ } }
          renderTaskRef.current.clear()
          /**
           * **这里必须真正销毁 doc。**
           *
           * 缓存删掉之后，doc 的生命周期就完全跟着这个 effect：
           *   · 会话内切换（文献库 ↔ 已打开 PDF、切右栏 tab）—— 走不到这里，
           *     因为组件常驻、effect 依赖没变，cleanup 不执行；
           *   · 真正卸载（关掉这篇 / 刷新页面 / 点刷新按钮让 reloadToken 变）——
           *     才执行到这里，此时确实该把 pdf.js 文档释放掉，否则内存泄漏。
           *
           * 不销毁的后果很明确：每打开一篇就永久多占一份解码后的页数据。
           */
          try { pdfRef.current?.doc?.destroy?.() } catch { /* 已销毁或未建出来 */ }
          pdfRef.current = null
          pageElsRef.current.clear()
        }
        /**
         * **依赖里不再放 active。**
         *
         * 放了它，切 tab 就销毁重建（黑屏 + 重新下载解析）。
         * 去掉之后，让它在「从未可见 → 现在可见」时补跑一次，
         * 由下面的 activeRef 监听 effect 负责，不参与本次加载的清理逻辑。
         */
      }, [itemKey, reloadToken])

      /**
       * 首次「由不可见变为可见」时补跑加载。
       *
       * 上一个 effect 在 `!active && 还没有文档` 时直接返回，为的是避免在
       * 0×0 容器里白跑一趟（那会让 pdf.js 建不出页、页码恢复全失效）。
       * 既然它不再依赖 active，就得有人负责在容器真正可见时叫醒它 ——
       * 就是这里，靠 reloadToken 触发一次重跑。
       *
       * 已经加载过的（pdfRef 有值）不响应：那正是「切回来不该重载」的诉求。
       */
      const wasActiveRef = useRef(active)
      useEffect(() => {
        const was = wasActiveRef.current
        wasActiveRef.current = active
        if (active && !was && !pdfRef.current) {
          setReloadToken((v) => v + 1)
        }
      }, [active])

      /* ---------- 官方 PDFViewer 接管渲染 ---------- */
      /**
       * 把渲染交给 pdf.js 官方的 PDFViewer。
       *
       * 为什么换：自建页循环里，文本层要靠我们逐 span 摆位并测量字宽，
       * 在宿主的主线程里实测每页要 4–8 秒（112 个片段），一打开就卡死整个界面。
       * 官方 viewer 用虚拟化滚动 + 官方 TextLayer + 官方渲染队列，
       * 同一套 pdf.js 内核，但排版与调度都是他们调优过的实现。
       *
       * 我们保留的东西：
       *   · 外层面板（页头、页码条、大纲、批注列表、划词工具）
       *   · 批注浮层（Zotero 的批注要叠加在页面上，官方不读 Zotero 数据）
       *   · 缩放与页码跳转（转成官方 viewer 的 currentScale / currentPageNumber）
       */
      const viewerRef = useRef(null)
      /** 页码跳转的序号：新一轮跳转作废上一轮还在重试的旧跳转。 */
      const jumpSeqRef = useRef(0)
      /**
       * **「跳转历史」栈本体：`[{ pageNo, offset }]`，后进先出。**
       *
       * 只记「跳转前的位置」，不记普通滚动 —— 用户滚几屏再点返回时，
       * 应该回到上一个**有意义**的落点，而不是退回几像素之前。
       *
       * 用 ref 不用 state：压栈/弹栈都发生在事件回调与异步闭包里
       * （链接点击、抽屉 async 解析），读 state 会拿到旧快照，
       * 连续两次跳转就会互相覆盖，栈只剩一条。给界面看的是 hopDepth。
       */
      const hopStackRef = useRef([])
      /**
       * **循环保护：正在执行「从历史恢复」的标记。**
       *
       * 恢复本身也要滚页、也要写 currentPageNumber，外观和一次跳转一模一样。
       * 若恢复路径同样压栈，点一次返回就会把「返回前的位置」重新压进去，
       * 栈永远见不了底 —— 表现为「返回按钮永远能点、永远退不出去」。
       *
       * 用一个 flag 而不是「让恢复绕开某个函数」：跳转入口有好几处
       * （链接、页码、大纲、批注列表），逐个绕开总会漏一个；
       * 在压栈的唯一出口上判一次，将来再加跳转入口也自动受保护。
       */
      const hopRestoringRef = useRef(false)
      /**
       * 页数上限的 ref 镜像。
       *
       * popHop 是 useCallback([])，读不到最新的 pageCount；而历史里存的页号
       * 理论上可能因重新取字节而超出新页数（同一篇文献换了个修订版 PDF）。
       * 夹取只是兜底，正常路径下它不会改变任何值。
       */
      const pageCountRef = useRef(0)
      /**
       * **换文献就清空跳转历史。**
       *
       * 现状是每个 PaperView **实例**对应的 itemKey 固定（外部按 `key` 渲染，
       * React 会复用同 key 的实例），所以这项清理多数时候是幂等的空动作。
       * 但它的存在是刻意的：历史记录只存 `{pageNo, offset}`，**不带文献标识** ——
       * 一旦哪天实例被复用（换 key、或 itemKey 变化而实例不重建），
       * 旧文献的页码会原样滚到新文献上，那是纯粹的错乱（第 12 页 ≠ 第 12 页）。
       * 与其指望「没人会复用它」，不如在依赖变化时无条件清空，
       * 让「历史只属于当前这篇文献」成为不依赖外部渲染细节的保证。
       *
       * 换文献本身也确实没有任何合理的「退回去」语义：跨文献的位置毫无意义，
       * 第 12 页在第 A 篇是正文、在第 B 篇可能是附录。
       */
      useEffect(() => {
        hopStackRef.current = []
        setHopDepth(0)
      }, [itemKey])
      const eventBusRef = useRef(null)
      /**
       * decoratePage 的 ref 镜像。
       *
       * viewer 的 effect 里要用它，但那个 effect 声明在 decoratePage 之前，
       * 直接引用会触发 TDZ（静态检查也会报）。ref 在这里先占位，赋值在下面。
       */
      const decoratePageRef = useRef(null)
      /** 新建批注的默认颜色（与 Zotero 自带调色板一致；与 annotColor 是同一个状态）。 */
      /**
       * 当前的粘性标注工具。
       * 只有 'note' 一个值有意义 —— 便签必须先点落点，只能是「点一下」的工具模式。
       * 高亮/下划线是选区动作，不需要粘性状态（选完文字直接在划词条上点）。
       */
      const [annotTool, setAnnotTool] = useState(null)
      /**
       * ref 镜像必须放在 state 声明**之后**。
       *
       * 放到前面会在渲染期读到还没初始化的 const（TDZ），
       * 报「Cannot access 'editColor' before initialization」。
       * 供异步回调（批注保存、渲染过期判断）读到最新值。
       */
      visiblePageRef.current = visiblePage
      editColorRef.current = editColor
      pageCountRef.current = pageCount

      /**
       * **跳转历史的上限。**
       *
       * 不封顶就是个只增不减的数组：一篇论文读一下午，来回点公式、
       * 大纲、批注列表能攒出几百条，全程挂在内存里没有回收点。
       * 50 条足够覆盖「刚才看的那一段」这种真实回溯需求，
       * 超出时丢**最旧**的一条（shift）—— 留最近的才有用，
       * 和浏览器前进后退的行为一致。
       */
      const HOP_LIMIT = 50

      /**
       * **把当前位置压进历史栈。**
       *
       * 只由「跳转」入口调用，普通滚动一律不调（见 hopStackRef 说明）。
       * 三个必须守住的不变量：
       *   ① 恢复路径不压栈（循环保护）—— 否则返回按钮把自己压回去，栈永不见底；
       *   ② 量不到位置就不压 —— 面板隐藏（display:none）时 clientHeight 为 0，
       *      压进去的是一条垃圾记录，之后返回会滚到一个乱七八糟的地方；
       *   ③ 与栈顶同一个位置不重复压 —— 连点两次同一个链接不该占掉两格。
       *
       * 返回是否真的压了，供调用方打日志。
       */
      const pushHop = useCallback(() => {
        if (hopRestoringRef.current) return false
        /**
         * 页号以 viewer 为准，visiblePageRef 只作退路。
         *
         * 两处必须取同一个源：gotoPage 用 `viewer.currentPageNumber` 判断
         * 「这次跳转到底移没移动」，这里若改读 visiblePageRef（它是 state 镜像，
         * 要等一次重渲染才更新），就可能出现「按第 12 页判断移动了、
         * 却量第 11 页的页元素」—— 那是页号与位置错开一格，
         * 返回时稳稳地落错地方。
         */
        const pageNo = (() => {
          try { return viewerRef.current?.currentPageNumber || 0 } catch { return 0 }
        })() || visiblePageRef.current || 0
        if (!pageNo) return false
        const pos = measurePosByGeometry(hostRef.current, pageNo)
        if (!pos) return false
        const stack = hopStackRef.current
        const top = stack[stack.length - 1]
        if (top && top.pageNo === pos.pageNo && Math.abs(top.offset - pos.offset) < 0.005) {
          return false
        }
        stack.push(pos)
        // 超上限丢最旧的
        if (stack.length > HOP_LIMIT) stack.splice(0, stack.length - HOP_LIMIT)
        setHopDepth(stack.length)
        reportDiag({
          event: 'history:push',
          page: pos.pageNo,
          offset: Number(pos.offset.toFixed(4)),
          depth: stack.length,
        })
        return true
      }, [])

      /**
       * **弹栈并回到记录的位置。**
       *
       * 消费式：回到一处就删掉一条，所以连点两次返回会依次退两步，
       * 退到栈空后按钮自动变灰（hopDepth 归零 → disabled）。
       *
       * 恢复期间置 hopRestoringRef，让这次滚动不被当成人肉跳转压回栈里。
       * 用 try/finally 而不是「先置位、成功后再清」：中途 throw 也必须解锁，
       * 否则标记一旦卡住 true，之后所有跳转都不再记历史（静默失效）。
       */
      const popHop = useCallback(() => {
        const stack = hopStackRef.current
        if (stack.length === 0) return false
        const pos = stack.pop()
        setHopDepth(stack.length)
        const pageNo = Math.max(1, Math.min(pos.pageNo, pageCountRef.current || pos.pageNo))
        hopRestoringRef.current = true
        try {
          const viewer = viewerRef.current
          try {
            if (viewer) {
              viewer.currentPageNumber = pageNo
              viewer.update?.()
            }
          } catch { /* 页视图未建好时赋值会被丢弃，下面滚动兜住 */ }
          setVisiblePage(pageNo)
          setJumpPage(pageNo)
          const scrolled = scrollPageIntoView(hostRef.current, pageNo, pos.offset)
          reportDiag({
            event: 'history:pop',
            page: pageNo,
            offset: Number(pos.offset.toFixed(4)),
            depth: stack.length,
            scrolled,
          })
        } finally {
          hopRestoringRef.current = false
        }
        return true
      }, [])

      /**
       * 最近一次「写进官方 viewer」的缩放值。
       *
       * 用来打破 state ↔ viewer 的同步循环：viewer 抛 scalechanging 会改 state，
       * 而 state 的同步 effect 又想把值写回 viewer。记住已应用的值，相等就跳过。
       */
      const lastAppliedScaleRef = useRef(0)
      /**
       * 是否处于「自适应宽度」模式。
       *
       * 一旦用过 page-width，就不该再把某个固定数字写回 viewer.currentScale，
       * 否则侧栏变宽变窄时页面不会跟着重新适配。
       * 用户一旦手动缩放（按钮/滚轮），立即清掉这个标记。
       */
      const fitModeRef = useRef(false)
      /** 上一次已经写进 localStorage 的页码（去重用，避免同页重复写）。 */
      const lastSavedPageRef = useRef(0)
      /**
       * 本次打开的「阅读位置恢复」是否已经落地。
       *
       * 在它变 true 之前，pagechanging 只更新界面、**不写盘**。
       * 原因见 eventBus.on('pagechanging') 里的说明：pdf.js 在 setDocument
       * 之后会先抛一次 pageNumber=1，若照单全收就会把用户真实位置覆盖成第 1 页，
       * 下次打开就真的从第一页开始 —— 这是个会自我强化的循环。
       */
      const resumeDoneRef = useRef(false)
      /**
       * 本次要恢复到的目标页（0 表示不需要恢复或还没算出来）。
       *
       * 用 ref 而不是闭包变量：`pagerendered` 监听注册在 resumePage 算出来
       * **之前**（setDocument 之后立刻注册，而页码要等 readSavedPos），
       * 直接闭包引用会踩 TDZ。ref 则随时可读，且回调触发时一定已赋值。
       */
      const resumeTargetRef = useRef(0)
      /**
       * `pagesinit` 的「恢复阅读位置」这一次文档是否已经执行过。
       *
       * 定位「缩放后被拽回去」时最容易走错的一步，是把 pagesinit 当成每次布局
       * 都会重发的通用事件 —— 它**不是**。查 pdf_viewer.mjs 可见它只有一处派发点
       * （setDocument 里 firstPagePromise.then 的尾部，L8660），而 PDFViewer.refresh()
       * 只做 pageView.update() + this.update()，根本不派发 pagesinit。
       * 所以缩放不会重跑恢复，原先挂着的 `{ once: true }` 在这一点上是对的。
       *
       * 真正会重跑的，是**首屏恢复落不了地时那条 24 次重试链**（applyResume）：
       * 状态条一出现（触发 setReloadToken → setDocument 再跑一遍），新文档又拿到
       * 一个 resumePage，而页码恢复只要没落地就会继续按它滚 —— 用户此刻的缩放
       * 正好落在这段时间里，于是视图被拽回去，看上去就是「重新从第一页排」。
       *
       * 这个标记用来保证：一次文档装载最多允许 pagesinit 做一次「恢复滚页」。
       * 之后任何一次 pagesinit 都只做清理（揭遮罩），不再动滚动位置。
       */
      const resumeByInitRef = useRef(false)
      /**
       * 上一次缩放结束的时刻（performance.now()）。
       *
       * 缩放之后 pdf.js 要若干帧才把每页 viewport 重算完，这段时间里
       * 「下一帧补装饰」之类的写入会跟它抢 DOM。用时间戳而不是布尔量：
       * 它是一个会自然过期的窗口。
       */
      const zoomAtRef = useRef(0)
      /**
       * **待补偿的指针锚点**（`{ pageNo, nx, ny, clientX, clientY }`）。
       *
       * 为什么要用 ref 传递：锚点必须在**缩放前**的几何上捕获，而当场
       * 拿不到确定的缩放后页面；等 `scale` state 同步到 viewer、我们写完
       * `currentScale` 之后才有新几何。中间隔着一次 React 渲染，
       * 用 state 会多触发一轮渲染，用 ref 则是纯旁路，不参与渲染。
       *
       * 三个入口的写入方式：
       *   · Ctrl+滚轮 / 双指捏合 —— 有 event.clientX/clientY，记在指针处；
       *   · +/- 按钮 —— 没有指针，记在阅读区视口中心（见 captureCenterZoomAnchor）；
       *   · 「适应宽度」—— 同上，走中心。
       * 谁写的谁负责：消费后立即置 null，避免旧锚点影响下一次无关的缩放。
       */
      const zoomAnchorRef = useRef(null)
      /**
       * **本次连续手势的锚点**（与 zoomAnchorRef 的分工见下）。
       *
       * 为什么要分成两个 ref —— 这是「连续缩放一半对一半乱飘」的修法核心：
       *
       * 原来只有一个消费式锚点：缩放 effect 一读完就置 null，下一个 wheel 事件
       * 再捕获新锚点。可连续滚轮时 `setScale` → React 会合并同一帧内的多次
       * state 更新，effect 只跑一次（这一半是好的）；跨帧时 effect 跑多次，
       * 每次都会对**同一个物理点**重新捕获锚点 —— 但那时页面已经缩过一轮，
       * 同一个屏幕点指向的文档位置早已不同。于是各次补偿各按不同基准、
       * 互相追赶。实测日志里 dy 在 +1031 与 −1029 之间来回跳，正是这种振荡。
       *
       * 现在拆成：
       *   · zoomAnchorRef —— 手势里的**基准锚点**，整个手势期间保持不变；
       *   · zoomPendingRef —— 「有缩放待补偿」的标记，只表示要不要跑补偿链。
       * 补偿不再清掉基准锚点，所以整段手势始终以同一个 (页, nx, ny) 为基准；
       * 每次补偿都用**当时**的 scale 重算绝对目标位置（不是累加上次的残差），
       * 因此多次执行不会互相追赶，最终必然收敛到「那一点仍在原屏幕位置」。
       */
      const zoomAnchorRecentRef = useRef({ capturedAt: 0, anchor: null })
      const zoomPendingRef = useRef(false)
      /**
       * 当前在跑的补偿链句柄（非 null 表示「已有一条链在排队/执行」）。
       *
       * 存在的唯一目的就是判重：连续滚轮会在同一小段时间里反复触发同步 effect，
       * 若每次都排一条自己的 rAF 链，多条链会在同一批帧里接连补偿 ——
       * 这是「一半对一半乱飘」的另一半原因。有了它，后来的只登记、不排链，
       * 由既有的那条链在下一拍读到最新 scale 时一并处理。
       */
      const zoomCompensationRef = useRef(null)
      /** 被既有链合并掉的缩放轮次计数，随下一次补偿一并写进诊断。 */
      const pendingMergedRef = useRef(0)
      /**
       * PDF 内链接的监听清理函数。
       *
       * 监听器建在 viewer 的 effect 里（那里才拿到 host 与 linkService），
       * 而那个 effect 的 cleanup 写在很后面、且会被多次触发（切文献、
       * reloadToken 变化）。用 ref 存一份，cleanup 里直接调，
       * 避免每次都要把监听器变量再搬一遍。
       */
      const disposeLinkHandlersRef = useRef(null)
      /** 上一次保存的页内偏移（0..1）。与页号一起构成「阅读位置」。 */
      const lastSavedOffsetRef = useRef(0)
      /** 页码写入的 debounce 定时器。组件/effect 卸载时要清掉，否则会写到已切走的文献上。 */
      const savePageTimerRef = useRef(null)
      /** 缩放写入的 debounce 定时器（与页码分开，两者频率和时机都不一样）。 */
      const saveScaleTimerRef = useRef(null)
      /** 上一次打算写进 localStorage 的缩放值（数字或 'fit'），用于去重。 */
      const lastSavedScaleRef = useRef(null)

      useEffect(() => {
        if (status !== 'ready') return undefined
        const host = hostRef.current
        if (!host) return undefined
        const pdf = pdfRef.current
        if (!pdf) return undefined

        let disposed = false
        let viewer = null

        /**
         * 官方 viewer 需要自己的 DOM 骨架：一个滚动容器 .pdfViewer，
         * 里面有 .pdfViewerContainer 承载页面。class 名必须和 pdf_viewer.css 一致，
         * 否则那 168KB 样式全部落空（实测过：结构不对时页面是纯白无样式）。
         */
        host.innerHTML = ''
        const container = document.createElement('div')
        container.className = 'zr-pdfviewer-container'
        /**
         * 官方 viewer 在构造时断言 `container` 必须是绝对定位。
         *
         * 它自己的样式表里有这条规则，但依赖 `.pdfViewer` 的父选择器链；
         * 我们的挂载点在侧栏里，父级链路不满足，所以直接写内联样式最稳。
         */
        container.style.position = 'absolute'
        container.style.inset = '0'
        container.style.overflow = 'auto'
        const viewerEl = document.createElement('div')
        viewerEl.className = 'pdfViewer'
        // 只用相对定位：它是被页撑开的文档流容器，绝对定位会塌成零高度
        viewerEl.style.position = 'relative'
        const innerEl = document.createElement('div')
        innerEl.className = 'pdfViewerContainer'
        viewerEl.appendChild(innerEl)
        container.appendChild(viewerEl)
        host.appendChild(container)

        ;(async () => {
          try {
            /**
             * 把「加载 viewer 模块」与「构造 viewer」分开计时。
             *
             * 这两个成本性质完全不同：前者是下载 + 编译 315KB（可缓存、
             * 第二次起近乎免费），后者是 pdf.js 自己的初始化（每次打开
             * 都要付）。混在一起就看不出加缓存到底省了多少。
             */
            const modWin = perf.windowOpen()
            const modUrl = await importFromSource(`${API}/vendor/pdf_viewer.mjs`)
            const viewerMod = await import(/* @vite-ignore */ modUrl)
            perf.attribute('load-viewer-module', modWin)
            /**
             * `PDFPageView` 一起解构出来：它用于关掉文本层的无障碍排序
             * （见下面 viewer:a11y-disabled 那段）。它是 pdf_viewer.mjs
             * 公开导出的类，不是私有实现。
             */
            const { PDFViewer, EventBus, PDFLinkService, PDFPageView } = viewerMod
            if (!PDFViewer) throw new Error('官方 viewer 模块里没有 PDFViewer')
            if (disposed) return

            const eventBus = new EventBus()
            eventBusRef.current = eventBus

            const linkService = new PDFLinkService({ eventBus })

            viewer = new PDFViewer({
              container,
              viewer: viewerEl,
              eventBus,
              linkService,
              /**
               * **不要启用 pdf.js 的批注编辑器。**
               *
               * annotationEditorMode 给 DISABLE(-1)，PDFViewer 就不会在
               * setDocument 里创建 AnnotationEditorUIManager —— 那个对象正是
               * 崩溃来源（它在没有 annotationStorage 时提交批注会抛
               * "Cannot read properties of null (reading 'get')"）。
               *
               * 我们也不再需要它：批注由自建的标注层创建和显示，
               * 与 pdf.js 的编辑器、AnnotationEditorLayer 完全无关。
               *
               * annotationMode 取 ENABLE(1)，**不能取 0**：
               * 在 pdf.js 的枚举里 0 是 DISABLE（见 pdf.mjs 的 AnnotationMode），
               * 那样 PDF 自带的注释（链接、表单、原作者标注）就都不会渲染。
               * 1 = 正常渲染注释，只是不进入编辑状态。
               */
              annotationMode: 1,
              annotationEditorMode: -1,
              removePageBorders: true,
            })
            linkService.setViewer(viewer)
            viewerRef.current = viewer
            // 构造开销：与上面的模块加载分开算，两者优化手段不同
            perf.attribute('construct-viewer', modWin)

            /**
             * **关掉 pdf.js 的文本层无障碍排序。**
             *
             * 这是目前最大的单点开销：实测一次打开里
             * `#compareElementPositions` 被调 113 次、累计 14.7 秒，
             * 占 longTask 的 53%（单次最高 168ms）。
             *
             * 它做的事在 TextAccessibilityManager.enable() 里：
             *   this.#textChildren.sort(#compareElementPositions)
             * 对整页文本 span 排序，而**每次比较要读 2 次
             * getBoundingClientRect** —— 一页上百个 span，比较上千次，
             * 每次读取都可能触发全文档重排（日志 reReadMax≈0 说明读取
             * 本身极快，代价全在「还前面 DOM 写入的债」）。
             *
             * 排序的**唯一用途**是给文本层 span 设 `aria-owns`，让屏幕
             * 阅读器按视觉顺序朗读（见 #addIdToAriaOwns）。它不影响
             * canvas 画面、选词、高亮、批注定位、复制粘贴。
             *
             * 做法：包住 `PDFPageView.prototype.draw`，在调用前把该页视图的
             * `_accessibilityManager` 换成空壳。两条弯路记下来：
             *   · 传 null 不行 —— pdf.js 写的是 `||= new TextAccessibilityManager()`，
             *     null 会被覆盖成真对象，必须传空壳才挡得住
             *   · 遍历 viewer._pages 也不可靠 —— 那个数组会被整体重新赋值
             *     （见 pdf_viewer.mjs L8720/8738/8792），覆盖 push 会失效。
             *     改原型则与数组生命周期无关，新页老页都覆盖得到
             *
             * 空壳要满足 pdf.js 的六处调用，且 enable 不能抛 ——
             * 真实现在重复调用时会抛 "already enabled"。
             */
            const noopAccessibility = {
              setTextMapping() {},
              enable() {},
              disable() {},
              addPointerInTextLayer() { return null },
              removePointerInTextLayer() {},
              moveElementInDOM() {},
            }
            let a11yPatched = false
            try {
              /**
               * `PDFPageView` 是 pdf_viewer.mjs 公开导出的（见其末尾 export 列表），
               * 所以直接改它的原型最可靠 —— 不用猜实例字段、也不受
               * viewer._pages 数组被整体重建的影响（见 L8720/8738/8792）。
               *
               * 之前试过两条弯路：
               *   · 遍历 viewer._pages 逐个覆盖 → 构造 PDFViewer 时那个数组还是空的
               *   · 覆盖 _pages.push → 数组会被重新赋值，覆盖即失效
               */
              if (PDFPageView && PDFPageView.prototype
                  && typeof PDFPageView.prototype.draw === 'function'
                  && !PDFPageView.prototype.__zrA11yPatched) {
                const origDraw = PDFPageView.prototype.draw
                PDFPageView.prototype.draw = function patchedDraw(...args) {
                  if (this && this._accessibilityManager == null) {
                    this._accessibilityManager = noopAccessibility
                  }
                  return origDraw.apply(this, args)
                }
                PDFPageView.prototype.__zrA11yPatched = true
                a11yPatched = true
              }
              reportDiag({
                event: 'viewer:a11y-disabled',
                patched: a11yPatched,
                /**
                 * 带上诊断字段。第一次上线时只打了 patched=false，
                 * 无法判断是「没导出」「没有 draw」还是「已经打过补丁」——
                 * 三种情况的修法完全不同。这次一次说清。
                 */
                hasClass: Boolean(PDFPageView),
                hasProto: Boolean(PDFPageView && PDFPageView.prototype),
                hasDraw: Boolean(PDFPageView && PDFPageView.prototype
                  && typeof PDFPageView.prototype.draw === 'function'),
                alreadyPatched: Boolean(PDFPageView && PDFPageView.prototype
                  && PDFPageView.prototype.__zrA11yPatched),
              })
            } catch (e) {
              // 覆盖失败不影响阅读，只是会慢回去
              reportDiag({ event: 'viewer:a11y-disable-failed', message: String(e?.message ?? e) })
            }

            /**
             * 视口顶部「落在当前页的百分之几」。
             *
             * 用户常常停在两页之间：上一页尾部 + 下一页开头同时可见。
             * 只记页号会把视图吸到某一页的顶部，原本的视觉参照点就丢了。
             * 这里用滚动容器的 scrollTop 与该页 DOM 元素的 top 算出一个 0..1 的比例：
             *   0   = 正好停在该页顶部
             *   0.5 = 停在该页中间
             * 恢复时按同样的比例反推 scrollTop，落回原位。
             *
             * 拿不到几何信息时返回 0（等价于「停在页首」）。
             */
            function currentScrollOffset() {
              try {
                return measureScrollOffset(scrollRef.current, hostRef.current, viewer.currentPageNumber)
              } catch { return 0 }
            }

            /**
             * 按「页 + 页内偏移」把视图滚到该位置。
             *
             * **已废弃，保留说明以免重蹈覆辙。**
             *
             * 它直接设 `scrollRef.current.scrollTop`，而 `scrollRef` 挂在 `.zr-page` 上 ——
             * 那个节点并不是真正的滚动容器（真正滚的是 pdf.js 在 `.zr-pdfviewer-host`
             * 里建的 `.pdfViewer`）。于是写法看着正确、实际写在一个不滚的节点上，
             * 表现为「页码对了、视图没动」。
             *
             * 现在统一走模块级的 `scrollPageIntoView()`：它按几何找真正可滚的祖先，
             * 并用视口矩形差值定位。`gotoPage` 与加载时的位置恢复共用同一条路径。
             */

            /**
             * 把文档交给 viewer —— **这一步绝对不能少**。
             *
             * 没有它，PDFViewer 内部 pdfDocument 仍是 null：它不会创建任何 .page 元素，
             * pagerendered 永不触发，currentPageNumber 赋值也是空操作。
             * 表现就是「日志停在 viewer:ready，画布一片黑，且没有任何报错」。
             *
             * （这一句在之前清理编辑器链路时被一起切掉了 —— 删除的切片边界
             * 吃掉了 setDocument 那两行，而 viewer:ready 是后一句照常打的，
             * 所以日志看起来「一切正常」。）
             */
            /**
             * **必须等容器有真实尺寸再 setDocument。**
             *
             * 实测日志：`viewer:before-setdoc` 里 `containerSize` 绝大多数时候是 0×0
             * ——刷新页面时组件在布局完成前就挂上了，此时容器还没有尺寸。
             *
             * pdf.js 在 0×0 容器里 setDocument 会把每页的 viewport 算成 0 高，
             * canvas 建出来就是 0 像素，于是**画面全白**；之后 ResizeObserver 让
             * 容器恢复尺寸，也不会回头重算已经建好的 canvas。
             * 这正是「刷新后一直白屏」的成因。
             *
             * 所以这里轮询等尺寸（最多 ~3 秒），拿到非零宽高再继续。
             * 用 rAF 而不是 setTimeout：布局稳定本身就是按帧推进的，
             * rAF 能保证在下一帧布局之后才测量。
             */
            const waitForSize = () => new Promise((resolve) => {
              let frames = 0
              const tick = () => {
                if (disposed) { resolve(false); return }
                const w = container.clientWidth
                const h = container.clientHeight
                if (w > 0 && h > 0) { resolve(true); return }
                frames += 1
                /**
                 * 上限从 180 帧（~3 秒）收到 90 帧（~1.5 秒）。
                 *
                 * 原来白等 3 秒是因为零尺寸也硬着头皮 setDocument，
                 * 只能靠等碰运气。现在零尺寸会退回 loading 重来（见下方守卫），
                 * 所以这里只需要给别人「一帧就好」的机会，不必长等。
                 */
                if (frames > 90) { resolve(false); return }
                requestAnimationFrame(tick)
              }
              tick()
            })

            const sized = await waitForSize()
            if (disposed) return
            reportDiag({
              event: 'viewer:before-setdoc',
              sized,
              containerSize: {
                w: container.clientWidth,
                h: container.clientHeight,
              },
              viewerSize: { w: viewerEl.clientWidth, h: viewerEl.clientHeight },
              hostSize: { w: host.clientWidth, h: host.clientHeight },
            })
            /**
             * **零尺寸就别往下走。**
             *
             * 原先即便 sized 为 false 也照常 setDocument，后果很隐蔽：
             * pdf.js 在 0×0 容器里把每页 viewport 算成 0 高，`.page` 元素建不出来，
             * 于是 `viewer.currentPageNumber = n` 全部被静默丢弃 ——
             * 页码恢复 12 次重试全失败（日志 want:3 got:1 attempts:13 ok:false），
             * 表现为「加载很久，然后停在第一页」。
             *
             * 现在改为：容器真的没尺寸时退回 loading 并排队重来，
             * 由 active（切到可见）或 reloadToken 触发下一轮，绝不带病 setDocument。
             */
            if (!sized || container.clientWidth === 0 || container.clientHeight === 0) {
              reportDiag({
                event: 'viewer:defer-zero-size',
                containerW: container.clientWidth,
                containerH: container.clientHeight,
              })
              /**
               * **零尺寸只等，不自旋。**
               *
               * 原先这里是「重来，最多 8 次」，每轮都会让数据 effect 重跑一遍：
               * 重新 /pdf 下载、重新 getDocument 解析。而零尺寸的原因只有两个 ——
               * 容器还没布局完（几十毫秒），或者它压根是隐藏的（永远等不到）。
               * 两种情况用固定次数去猜都不对：前者一次就够，后者重来 8 次纯属浪费。
               *
               * 改成挂 ResizeObserver：尺寸真正出现的那一刻才重来一次。
               * 隐藏的 `display:none` 元素不会触发回调，所以不会再有自旋。
               */
              const ro = new ResizeObserver(() => {
                if (disposed) return
                if (container.clientWidth > 0 && container.clientHeight > 0) {
                  try { ro.disconnect() } catch { /* ignore */ }
                  setReloadToken((v) => v + 1)
                }
              })
              ro.observe(container)
              return () => { try { ro.disconnect() } catch { /* ignore */ } }
            }
            /**
             * **在 setDocument 之前就把目标页算出来，并挂好 pagesinit。**
             *
             * 这是「第一页先被渲染」的根治办法。看 pdf.js 的 setDocument 末尾：
             *   eventBus.dispatch("pagesinit")            ← 页容器已进 DOM、高度已撑开
             *   if (this.defaultRenderingQueue) this.update()   ← 这里才决定渲染哪些页
             * 两句在同一个微任务里，pagesinit 在前。
             *
             * 所以在 pagesinit 里把 scrollTop 设到目标页，`update()` 第一次
             * 算可见页得到的就是目标页 —— pdf.js 压根不会去渲染第 1 页。
             *
             * 之前三次都没成，因为时机全都不对：
             *   ① setDocument 之后同步设 currentPageNumber
             *      → 页视图还没建，赋值被静默丢弃
             *   ② 等 120ms 用 setTimeout 再设
             *      → 那时 pdf.js 早在 update() 里决定了画第 1 页
             *   ③ 完全不设，等页就绪
             *      → pdf.js 按默认从第 1 页开始渲染
             * 只有 pagesinit 这个点同时满足「页已就位」和「渲染还没决策」。
             */
            const savedPos = readSavedPos(itemKey, pdf.doc.numPages)
            const resumePage = savedPos?.page ?? 1
            const resumeOffset = savedPos?.offset ?? 0
            resumeTargetRef.current = resumePage

            eventBus.on(
              'pagesinit',
              () => {
                /**
                 * ---------- pagesinit 的完整生命周期（静态推演结论） ----------
                 *
                 * ① 谁派发：只有 PDFViewer.setDocument 的 firstPagePromise 链尾部
                 *    （pdf_viewer.mjs L8660），紧跟其后是 `if (this.defaultRenderingQueue)
                 *    this.update()`。两句同一个微任务，pagesinit 在前 —— 所以在这里
                 *    改滚动位置，能让 update() 第一次算可见页就算对，第 1 页不会被画。
                 * ② 派发几次：**一个文档一次**。PDFViewer.refresh()（refresh(noUpdate)）
                 *    只做 pageView.update() + this.update()，不派发 pagesinit；
                 *    `setScaleUpdatePages` 走的就是 refresh(true, {scale})。
                 *    于是「缩放 → refresh → pagesinit → 拽回旧页」这条链**不存在**。
                 * ③ 谁在重发：只有 setDocument 再跑一遍 —— status 回 loading、
                 *    reloadToken 变化（刷新按钮/切可见补跑）、切文献。
                 * 所以本回调的次数 == 文档装载次数，滚动位置只应该在**第一次**
                 * 装载时被写一次；后续装载是用户主动触发的，恢复由 applyResume
                 * 那条有判据的重试链负责，不归这里管。
                 */
                if (disposed) return
                const already = resumeByInitRef.current
                resumeByInitRef.current = true
                /**
                 * ---------- 与「滚页」分开的清理：每次都要做 ----------
                 *
                 * 原先这里在 `resumePage <= 1` 时直接 return，等于把清理一起跳过了。
                 * 目标页是第 1 页时遮罩本就没挂（见下面的 restore-mask 分支），
                 * 但**上一轮装载**若挂着遮罩而没等到 pagerendered，清理就会被漏掉，
                 * 阅读区会一直停在「正在恢复阅读位置…」。所以清理先无条件跑。
                 */
                if (resumePage <= 1 || resumeTargetRef.current <= 1) {
                  try {
                    if (host?.dataset?.restoring === '1') {
                      delete host.dataset.restoring
                      reportDiag({ event: 'viewer:restore-mask', on: false, by: 'pagesinit' })
                    }
                  } catch { /* 揭不开最多多遮一会儿，交给 4 秒兜底 */ }
                }
                const willScroll = !already && resumePage > 1
                /**
                 * 别刷屏：每个文档最多打一次。这条记录就是现场判断
                 * 「这一轮到底是谁在滚页」的唯一依据，字段要一次给全。
                 */
                reportDiag({
                  event: 'pagesinit',
                  willScroll,
                  already,
                  resumePage,
                  currentPage: (() => {
                    try { return viewer.currentPageNumber } catch { return 0 }
                  })(),
                })
                if (!willScroll) return
                /**
                 * pagesinit 时页容器刚进 DOM，个别情况下高度还没最终确定，
                 * 量出来的 pageTop 会偏。重试几帧再放弃 —— 每帧都重新量，
                 * 一旦滚到位就停。
                 */
                let tries = 0
                const land = () => {
                  if (disposed) return
                  const ok = scrollPageIntoView(host, resumePage, resumeOffset)
                  tries += 1
                  if (!ok && tries < 6) {
                    requestAnimationFrame(land)
                    return
                  }
                  reportDiag({ event: 'viewer:pagesinit-land', page: resumePage, ok, tries })
                }
                land()
              },
              { once: true },
            )

            /**
             * 新一轮加载开始：在阅读位置恢复落地之前，禁止把页码写盘。
             * 必须放在 setDocument **之前** —— 它一执行，pdf.js 就会先抛
             * 一次 pageNumber=1 的 pagechanging（见下方监听的说明）。
             */
            resumeDoneRef.current = false
            /**
             * 同一处复位 pagesinit 的「已消费」标记。
             *
             * 生命周期跟 resumeDoneRef 走是对的：两者都在 setDocument **之前**复位，
             * 因为 setDocument 内部就会同步派发 pagesinit（首屏页就绪时立即派发），
             * 晚一步复位就等于把上一轮的状态带进这一轮语义里。
             * 区别只在语义粒度：resumeDoneRef 管「这条恢复重试链是否允许写盘」，
             * 这里管「pagesinit 是否已经消费过它那一次恢复」。
             */
            resumeByInitRef.current = false
            viewer.setDocument(pdf.doc)
            linkService.setDocument(pdf.doc, null)
            reportDiag({ event: 'viewer:doc-set', pages: pdf.doc.numPages })
            perf.attribute('setDocument-total', openWinRef.current)

            /**
             * **PDF 内链接的点击与悬停预览。**
             *
             * 为什么点击不跳转：pdf.js 把 PDF 里的链接渲染成
             *   <a href="https://..." target="" rel="...">
             * （见 PDFLinkService.addLinkAttributes，target 取自
             * externalLinkTarget，我们没传，默认 NONE → 空 target）。
             * 空 target 等于「当前窗口导航」，而这个页面基址是
             * `dsh-app://app/` —— Electron 会把这种跨 scheme 导航拦下来，
             * 于是点了没反应，连错误都没有。
             *
             * 内部链接（PDF 里指向本文档某一页的书签）同样是 `<a href="#...">`，
             * 它依赖 pdf.js 自己那条滚动画布容器的链路 —— 而那条链在侧栏里
             * 本来就是断的（本项目为此专门实现过 scrollPageIntoView）。
             * 所以内部跳转也要我们自己接。
             *
             * 用 capture 阶段监听并在命中时 stopPropagation：
             * pdf.js 的处理器挂在 <a> 自身的 onclick 上，事件从 host 往
             * target 走，capture 先到、能把它拦下来。
             */
            /**
             * **文档内具名目标（LaTeX 的 `#eq1`、`#cite.hutchison2013semantic`）自己解析。**
             *
             * 原来这一支写的是 `linkService.navigateTo(name)` —— 而这个版本的
             * pdf_viewer.mjs 里**根本没有 navigateTo 这个方法**（全文 0 处），
             * 于是每点一次都抛 TypeError，再被空 catch 吞掉：
             * 日志只留下 link:click，画面一动不动，看起来像「处理器没被调用」。
             *
             * 官方那只入口叫 goToDestination，但它最终的落点仍然是
             * pdfViewer.scrollPageIntoView —— 即本项目已知断掉的那条滚动画布链路
             * （侧栏容器 overflow:hidden、scrollHeight === clientHeight）。
             * 所以这里只借它解析命名目标的部分，滚动交给 scrollPageIntoView。
             *
             * dest 的三种形态都要接：
             *   · 命名目标 → [pageRef, {name:'XYZ'}, left, top, zoom]
             *   · 间接目标（/Dest 里存的是另一个名字）→ 字符串，要再查一层
             *   · dest[0] 通常是 page ref 对象，也兼容直接给页号（0 基）
             */
            /**
             * **从 dest 数组里解出纵向落点，换成页顶起算的比例。**
             *
             * pdf.js 的 goToDestination 自己会把这套算完（见 pdf_viewer.mjs 里
             * `switch (destArray[1].name)` 那一段，XYZ 取 [2]=x、[3]=y、[4]=zoom），
             * 但它最终的落点是 pdfViewer.scrollPageIntoView —— 侧栏里断掉的那条链。
             * 所以这里照抄它的下标规则，只把结果换成本项目 offset 的语义。
             *
             * 两套坐标系方向相反，这是最容易写错的地方：
             *   · dest 的 y 是 PDF 用户空间，**原点在左下**，单位 point；
             *   · scrollPageIntoView 的 offset 是**页顶往下**的高度比例（0..1）。
             * 所以 offset = (pageHeightPt - y) / pageHeightPt。
             * pageHeightPt 必须取 viewport 的高度（PDF 点），**不能用 clientHeight**
             * ——后者是 CSS 像素、随缩放变化，会把落点算飞。
             *
             * 实测样本（本库那篇 LaTeX 论文）：
             *   cite.andrews1997 => [Ref(231,0), Name(XYZ), 44, 217, null]，
             *   该页 viewport.height = 842.116 → offset ≈ 0.742，落在公式/条目位置。
             *
             * 参数为 null 是 PDF 规范里的「保持不变」，不是 0，所以逐项判。
             * 取不到可靠 y 时返回 null，调用方退回页首。
             */
            /**
             * **取名目标位置附近的正文，作为悬停预览。**
             *
             * 上一轮卡片里显示的是「文档内跳转 / 第 N 页 / fig8」这类元信息，
             * 用户要看的是「点过去会到哪句话」。这段话本来就在 PDF 文本层里，
             * 不需要 DOI、不需要查 Zotero 库 —— 对 `#fig8`、`#eq1`、
             * `#cite.andrews1997` 一视同仁。
             *
             * 取法的三个要点（都是拿真实 PDF 实测踩出来的）：
             *
             * ① **先分栏**。双栏论文左栏 x≈49、右栏 x≈305，
             *    只按 y 找最近行会把相邻栏的文字混进来：`cite.collins1975`
             *    的 destX=300 在右栏，按纯 y 会取到左栏那句「283–316. doi:...」。
             *    用页宽中点判定 destX 属哪栏，再只在该栏里找。
             *
             * ② **按 x 邻近度给惩罚**。同一栏内仍可能在 destX 左侧另起一段，
             *    纯 y 最近会跳到隔壁段：`fig8` 的 destX=317 在右栏，
             *    不加横向惩罚会取到左栏正文而错过「FIGURE 8」。
             *
             * ③ **命中行之后继续往下拼一点**，凑成一段可读预览。
             */
            /**
             * 预览字数的**极端兜底**（不是主判据）。
             *
             * 主判据是「参考文献条目边界」：正常条目只有 180~260 字符，
             * 会自然停在 boundary。这个上限只防「条目识别失败、一路吃到底」。
             *
             * 原为 120 —— 连一条作者列表都放不下，用户看到的就是
             * 「只有作者名就跳到页码」。现在放宽到 600 作兜底。
             */
            const linkPreviewChars = 600
            /**
             * **参考文献条目的起始判据**（三条，满足其一）。
             *
             * 为什么不用悬挂缩进：实测这篇论文的首行与续行 x0 都是 49，
             * 排版没有悬挂缩进，那个判据会完全失效。
             * 行距也不可用：条目内与条目间都是约 8pt，没有明显间隙。
             *
             * 唯一稳定的是「作者姓 + 逗号 + 首字母」这个文献条目模式。
             */
            /** 主判据：Anderson, J. R. / Collins, A. M., and Loftus, E. F. */
            const REF_ENTRY_RE = /^[A-Z][A-Za-zÀ-ÿ'’\-]+,\s*(?:[A-Z]\.|and\s+[A-Z]|&|[A-Z][a-z]+,\s*[A-Z])/
            /** 保险1：`et al. (2004). 标题` 开头的续条目 */
            const REF_ETAL_RE = /^et\s+al\.\s*\(\d{4}/
            /** 保险2：单作者无首字母，如 `Chomsky (1957). ...` */
            const REF_SINGLE_RE = /^[A-Z][A-Za-zÀ-ÿ'’\-]+\s*\(\d{4}[a-z]?\)/
            /**
             * 保险3：**含出版年份 + 大写开头 + 足够长**。
             *
             * 这条是为「首行被邻栏遮挡」的条目准备的：实测 page14 的
             * 下一个条目拼出来只剩 `influences of semantic and grammatical
             * cues in the two cerebral hemispheres.`（首行丢了），
             * 它既不以作者名开头、也不是明确续行 —— 不加这条就会被
             * 当成本条目的续行而混进来（andrews1997 实测就是这样）。
             *
             * 反过来，`Verbal Behav . 22, 261–295.` / `doi: 10.x` /
             * `Psychol. Sci . 2, ...` 这类续行都不含 (19xx)/(20xx)，不会误判。
             */
            const REF_YEAR_RE = /\((?:19|20)\d{2}[a-z]?\)/
            /** 年份 token 检测（在累加循环里用，不要求整行以它开头） */
            const REF_YEAR_TOKEN = /\b(?:19|20)\d{2}[a-z]?\b/
            /** 条目尾部特征：DOI / URL / 页码范围 */
            const REF_TAIL_TOKEN = /doi:|https?:\/\/|\d+\s*[–\-]\s*\d+/
            const isRefEntryStart = (text) => {
              const t = String(text || '').trim()
              if (!t) return false
              if (REF_ENTRY_RE.test(t) || REF_ETAL_RE.test(t) || REF_SINGLE_RE.test(t)) return true
              // 保险3：含年份 + 大写开头 + 足够长（避免误伤短句/标题）
              return REF_YEAR_RE.test(t) && /^[A-Z]/.test(t) && t.length > 40
            }
            /**
             * 节标题：**整行只有这个词**才算。
             * 用整行匹配是为了避免误伤正文里提到 "references" 的句子。
             */
            const REF_HEADING_RE = /^(References|Bibliography|Literature Cited|参考文献)\s*$/
            const isRefHeading = (text) => REF_HEADING_RE.test(String(text || '').trim())
            /**
             * **续行特征**（不是条目起始的强信号）。
             *
             * 实测 page14 的 `[26]`：`influences of semantic and grammatical
             * cues in the two cerebral hemispheres.` —— 它以大写开头、
             * 看起来像新条目，其实是**上一个条目的续行**
             * （首行被右栏遮挡，拼出来只剩后半句）。
             *
             * 这些模式是明确的续行：
             *   · `doi: ...` / `arXiv ...` / 纯卷页数字
             *   · 期刊缩写 + 卷页（`Lang . 97, 12–24.`、`Psychol. Sci . 2, ...`）
             *   · 以介系词/连词小写开头
             */
            const REF_CONT_RE = /^(?:doi:|https?:|arXiv|\(?\d{4}\)?\.|[A-Z][A-Za-z.]*\s*\.\s*\d+,|(?:and|of|in|for|with|on|the|a|an)\s)/i
            const isRefContinuation = (text) => {
              const t = String(text || '').trim()
              if (!t) return false
              return REF_CONT_RE.test(t)
            }
            /**
             * **分栏的判据：列的起始 x 位置，不是页宽中点。**
             *
             * 原实现按「行中点落在页宽哪一半」分栏，实测只差 0.0749pt 就判反：
             * 目标行 x0=49.416 / x1=545.994，中点 297.7049，
             * 页宽中点 595.26/2 = 297.6300 —— 于是左栏的整行被算成右栏、
             * 被 scoped 整行剔除，best 落到 `References`，再跳到下一条目
             * （1983 那篇显示成 2004 那篇）。
             *
             * 列起点没有这个问题：左栏文字**从 49 起排**，右栏**从 305 起排**，
             * 判据是「这一行从哪一列起排」，与行有多宽无关。
             *
             * 取法：按 x 计数降序贪心接受，与已接受起点相差 < 24pt 视为同一列
             * （双栏论文里右栏正文常左移到 319、缩进 20pt，仍属同一列）。
             * 实测 page14 → [49, 305]，page3 → [49, 305]。
             * 不足两列时返回空数组，调用方退回全页（单栏文档不硬分行）。
             */
            const COL_START_MIN_GAP = 24
            const colStartsOf = (items) => {
              const hist = new Map()
              for (const it of items) {
                const k = Math.round(it.x)
                hist.set(k, (hist.get(k) || 0) + 1)
              }
              const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1])
              const minCount = Math.max(3, Math.round(items.length * 0.03))
              const starts = []
              for (const [x, n] of ranked) {
                if (n < minCount) continue
                if (starts.some((s) => Math.abs(s - x) < COL_START_MIN_GAP)) continue
                starts.push(x)
              }
              if (starts.length < 2) return []
              return starts.sort((a, b) => a - b)
            }
            /**
             * x 落在第几列的起点上（`starts` 已升序）。
             *
             * **必须带 2pt 容差。** 列起点是按 `Math.round(x)` 统计出来的（305），
             * 而右栏 item 的实际 x 常是 304.75 —— 严格比较会判进左栏，
             * 于是右栏整行又被拼回左栏条目里（实测 page14 的
             * `arXiv [preprint]`、`Psychol. Rev . 82, 407–428.` 等十多行都中招）。
             * 容差取 2pt：远小于列间距（≥24pt），又足够吸收取整与排版抖动。
             */
            const COL_START_TOLERANCE = 2
            const colIndexAt = (starts, x) => {
              let k = 0
              for (let i = 0; i < starts.length; i += 1) {
                if (starts[i] - COL_START_TOLERANCE <= x) k = i
              }
              return k
            }

            /**
             * 文本层缓存：pageNo → { lines, width, height }。
             *
             * getTextContent 要跨 worker 取整页文本（实测一页 320 个 item），
             * 每次悬停都做会让预览变卡。按页缓存，一篇论文很快全命中。
             * **换文档时必须清空**（见下面 cleanup），否则新 PDF 会读到上一篇的行。
             *
             * 用普通 Map 而不是 `useRef`：这段代码跑在 setDocument 的异步装载
             * 链路里，**不在组件渲染期**。在这里调 hook 会抛 React #321
             * （invalid hook call），表现为「官方阅读器加载失败」。
             * 这个缓存只被本闭包与 cleanup 用到，不需要跨渲染持久，
             * 每次装载新建一个正好——也就自然满足「换文档即清空」。
             */
            const textLinesCache = new Map()

            const pageTextLines = async (pdfDocument, pageNo) => {
              const cached = textLinesCache.get(pageNo)
              if (cached) return cached
              const page = await pdfDocument.getPage(pageNo)
              const viewport = page.getViewport({ scale: 1 })
              const content = await page.getTextContent()
              const items = []
              for (const it of content?.items ?? []) {
                // 纯空白 item 不参与（文本层里大量这种）
                if (!it?.str || !it.str.trim()) continue
                const x = it.transform?.[4]
                const y = it.transform?.[5]
                if (typeof x !== 'number' || typeof y !== 'number') continue
                items.push({ s: it.str, x, y, w: it.width ?? 0 })
              }
              const lines = []
              /** 列起点（升序）：空数组表示单栏，调用方退回全页 */
              let colStarts = []
              if (items.length > 0) {
                /**
                 * 聚行：同一基线（±4pt 容差）的 item 拼成一行。
                 * 容差取 4pt 是因为上下标差 2–3pt，再大就会把相邻行并掉。
                 *
                 * **同一基线上还要拆栏。** 双栏论文里左右栏常在同一条基线上
                 * （实测 page14：一层基线里 y=301.13 同时出现左栏
                 * `Anderson, J. R. (1983). ...` x=49 与右栏
                 * `BehnamGhader, P., ...` x=304.75）。不拆的话：
                 *   · 参考文献条目会被右栏文字割裂成两半
                 *   · 条目边界判定会误把右栏内容当成同一行
                 *
                 * 拆法有**两道**，都必须有：
                 *   ① 按**列起点**分组（colStartsOf）。这是真正拆开左右栏的那道：
                 *      左右栏之间的间隙实测只有 **14.2pt**，任何 gap 阈值都拆不开；
                 *      但「这一行从 49 起排」还是「从 305 起排」一测就准。
                 *   ② 同列内再按 x 间隙切分（gap > 100）：同一栏里的标题、图注、
                 *      右侧页码/DOI 之间可能有很大的空洞，不切会拼成怪行。
                 */
                colStarts = colStartsOf(items)
                const byBaseline = new Map()
                for (const it of items) {
                  const key = Math.round(it.y / 4)
                  if (!byBaseline.has(key)) byBaseline.set(key, [])
                  byBaseline.get(key).push(it)
                }
                for (const group of byBaseline.values()) {
                  group.sort((a, b) => a.x - b.x)
                  /**
                   * ① 先按列起点分组：每一列各自成段，跨栏不再拼接。
                   * columns 已按 x 升序，所以每个 group 内部仍是左到右。
                   */
                  const columns = []
                  if (colStarts.length >= 2) {
                    for (const it of group) {
                      const col = colIndexAt(colStarts, it.x)
                      if (!columns[col]) columns[col] = []
                      columns[col].push(it)
                    }
                  } else {
                    columns[0] = group
                  }
                  /**
                   * ② 列内再按 x 大间隙切分成若干段，每段单独成行。
                   */
                  for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
                    const colItems = columns[colIdx]
                    if (!colItems || colItems.length === 0) continue
                    const segments = []
                    let seg = [colItems[0]]
                    for (let gi = 1; gi < colItems.length; gi += 1) {
                      const prev = seg[seg.length - 1]
                      const gap = colItems[gi].x - (prev.x + (prev.w || 0))
                      if (gap > 100) { segments.push(seg); seg = [] }
                      seg.push(colItems[gi])
                    }
                    segments.push(seg)
                    for (const parts of segments) {
                      const text = parts.map((v) => v.s).join(' ').replace(/\s+/g, ' ').trim()
                      if (!text) continue
                      lines.push({
                        y: parts[0].y,
                        x0: Math.min(...parts.map((v) => v.x)),
                        x1: Math.max(...parts.map((v) => v.x + (v.w || 0))),
                        text,
                        /** 列序号：colStarts 的下标；未分栏时恒为 0 */
                        col: colStarts.length >= 2 ? colIdx : 0,
                      })
                    }
                  }
                }

                // 排版顺序：PDF 原点在左下，所以 y 递减才是从上到下
                lines.sort((a, b) => b.y - a.y)
              }
              /**
               * 空页也缓存：扫描页永远没有文本层，
               * 不缓存就会每次悬停都白跑一遍 getTextContent。
               */
              const result = { lines, width: viewport.width, height: viewport.height, colStarts }
              textLinesCache.set(pageNo, result)
              return result
            }

            /**
             * 从文本层里裁出 dest 附近的文字；取不到返回 null。
             * @returns {Promise<string|null>}
             */
            const extractDestPreview = async (dest, pageNo) => {
              try {
                const pdfDocument = pdfRef.current?.doc
                if (!pdfDocument) return null
                const packed = await pageTextLines(pdfDocument, pageNo)
                const lines = packed?.lines ?? []
                if (lines.length === 0) return null
                // destX / destY 都可能是 null（规范里的「保持不变」）
                const destX = typeof dest?.[2] === 'number' ? dest[2] : null
                const destY = typeof dest?.[3] === 'number' ? dest[3] : null
                if (destY === null) return null

                /**
                 * **分栏：按「列起点」判，不按页宽中点判。**
                 *
                 * 旧实现用行中点落在页宽哪一半，实测只差 0.0749pt 就判反：
                 * 目标行 x0=49.416 / x1=545.994（左栏文字，但整行跨到右栏边缘），
                 * 中点 297.7049 > 页宽中点 297.6300 → 被算成右栏 → 整行剔除，
                 * `best` 落到 `References`，于是 `cite.anderson1983` 显示 2004 那篇。
                 *
                 * 所以两件事一起做：
                 *   · 列由 `col` 字段（聚行时算好的列序号）给出，不再重算中点；
                 *   · 目标列取**距 destX 最近的列起点**，而不是「destX 落在哪一半」。
                 * 拿不到列起点（单栏文档）时退回全页。
                 */
                const colStarts = packed?.colStarts ?? []
                const hasCols = colStarts.length >= 2 && lines.some((l) => typeof l.col === 'number')
                /**
                 * 每一列的文字横向覆盖范围 —— 用来兜住「destX 落在栏中间」的情形。
                 * 只看列起点的话，destX=215.5（左栏里的 DOI 文字）距 49 有 166pt、
                 * 距 305 只有 90pt，会被判进右栏；按「哪个列的范围盖住了它」才对。
                 *
                 * **范围必须夹在列带宽内。** 版面里有跨栏的整宽行（页眉、横排标题），
                 * 它的 x1 会把左栏范围一路撑到页边，于是「被哪一列盖住」永远命中左栏，
                 * 兜底判据就失效了。双栏的带宽边界正是页宽中点：实测左右栏正文
                 * 分别是 49–291 与 305–546，中点 297.63 恰好落在栏间空白（14.2pt）里。
                 */
                const mid = packed.width / 2
                const colBandEdge = (i) => (colStarts.length === 2
                  ? mid
                  : (colStarts[i] + colStarts[i + 1]) / 2)
                const colExtent = colStarts.map(() => ({ lo: Infinity, hi: -Infinity }))
                if (hasCols) {
                  for (const l of lines) {
                    const c = l.col ?? 0
                    const e = colExtent[c]
                    if (!e) continue
                    const lo = c === 0 ? l.x0 : Math.max(l.x0, colBandEdge(c - 1))
                    const hi = c === colStarts.length - 1 ? l.x1 : Math.min(l.x1, colBandEdge(c))
                    if (lo < e.lo) e.lo = lo
                    if (hi > e.hi) e.hi = hi
                  }
                }
                let scoped = lines
                if (hasCols) {
                  let tcol = 0
                  if (destX !== null) {
                    /**
                     * 先判「落在哪一列的范围内」，多个列都盖住时取列起点更近的；
                     * 都不盖住（destX 在版面留白里）再退回最近列起点。
                     */
                    const covering = []
                    for (let i = 0; i < colExtent.length; i += 1) {
                      const e = colExtent[i]
                      if (e.lo <= destX && destX <= e.hi) covering.push(i)
                    }
                    const pool = covering.length > 0 ? covering : colStarts.map((_, i) => i)
                    let bestDx = Infinity
                    for (const i of pool) {
                      const d = Math.abs(colStarts[i] - destX)
                      if (d < bestDx) { bestDx = d; tcol = i }
                    }
                  }
                  const sameSide = lines.filter((l) => (l.col ?? 0) === tcol)
                  // 该栏行数占比太低（目标列判错）时退回全页，宁可多给也别一个字取不到
                  if (sameSide.length >= Math.max(2, lines.length * 0.15)) scoped = sameSide
                }
                /**
                 * 目标列（诊断用）：scoped 取自某一列时记列起点，否则 null。
                 * 只有 scoped 真被收窄成单列时才有意义。
                 */
                const scopedCol = scoped !== lines
                  ? (scoped.length > 0 ? (scoped[0].col ?? 0) : null)
                  : null
                const targetColStart = scopedCol === null ? null : colStarts[scopedCol]

                // 打分：竖向距离为主；destX 落到该行横向区间之外的偏移按 0.5 计惩罚
                let best = 0
                let bestScore = Infinity
                for (let i = 0; i < scoped.length; i += 1) {
                  const l = scoped[i]
                  const dy = Math.abs(l.y - destY)
                  const dx = destX === null
                    ? 0
                    : destX < l.x0 - 2
                      ? l.x0 - destX
                      : destX > l.x1 + 2
                        ? destX - l.x1
                        : 0
                  const score = dy + dx * 0.5
                  if (score < bestScore) { bestScore = score; best = i }
                }
                /**
                 * **目标行另算：同列内 `y <= dest.top` 里 y 最大的那一行。**
                 *
                 * 为什么不用上面的 score 直接定：
                 *   · `dy` 是对称的，`References` 标题在 dest.top 上方 10.4pt
                 *     与正下方 10.4pt 处的一行得分相同，纯距离无法区分「标题」
                 *     与「目标条目」；
                 *   · `dest.top` 是行框**顶边**，基线一定在它**下方**
                 *     （实测 top-baseline 中位数 3.96pt，条目稳定 3.4~4.3pt）。
                 *
                 * 所以序关系本身就是判据：基线在 top 上方的行不可能是目标行，
                 * 不需要任何 magic 阈值。容差 0.6pt 用来吸收坐标舍入。
                 * 不变式（可断言）：`0 < dest.top - baseline <= 该行字号`。
                 */
                let targetIdx = -1
                if (scopedCol !== null) {
                  for (let i = 0; i < scoped.length; i += 1) {
                    const l = scoped[i]
                    if (l.col !== scopedCol && typeof l.col === 'number') continue
                    if (l.y > destY + 0.6) continue
                    if (targetIdx < 0 || l.y > scoped[targetIdx].y) targetIdx = i
                  }
                }
                const pickIdx = targetIdx >= 0 ? targetIdx : best
                const targetBaseline = pickIdx >= 0 ? scoped[pickIdx].y : null
                const topMinusBaseline = destY === null || targetBaseline === null
                  ? null
                  : destY - targetBaseline
                /** 打分选出的行，只留作诊断对照；取值一律用 pickIdx */
                const scoreBest = best
                if (pickIdx >= 0) best = pickIdx

                /**
                 * **按「参考文献条目边界」取值，不按字数。**
                 *
                 * 原实现从 `best` 往后累加到 120 字 —— 实测 `best` 落在
                 * 章节标题 `References` 上（destY=305，标题 y=315.4 只差
                 * 10pt），于是输出变成「References Anderson, J. R., ...」，
                 * 到 120 字断在作者名中间。用户看到的就是
                 * 「只有作者名就跳到页码」。
                 *
                 * 现在的顺序：
                 *   1. best 若是**节标题**（整行只有 References 等）→ 跳到下一个条目起始
                 *   2. best 若**本身就是条目起始** → 直接用，不跳
                 *      （这两条必须分清，写成「总是取 next」会漏掉条目首行）
                 *   3. 从起始行向后累加，**遇到下一个条目起始就停**（boundary）
                 *   4. 找不到条目边界 → 退化：前后各 8 行（fallback）
                 *   5. 600 字兜底（chars）
                 */
                let startIdx = best
                let stopReason = 'boundary'
                let usedFallback = false
                /**
                 * ---- ① best 是节标题 → 找下一个条目起始 ----
                 */
                if (isRefHeading(scoped[best].text)) {
                  let found = -1
                  for (let i = best + 1; i < scoped.length; i += 1) {
                    if (isRefEntryStart(scoped[i].text)) { found = i; break }
                  }
                  if (found >= 0) {
                    startIdx = found
                  } else {
                    stopReason = 'fallback'
                    usedFallback = true
                  }
                } else if (!isRefEntryStart(scoped[best].text)) {
                  /**
                   * ---- ② best 既不是标题也不是条目起始（正文中间）----
                   * 向前回溯找最近的条目起始；找不到就走退化。
                   */
                  let back = -1
                  for (let i = best - 1; i >= 0 && i >= best - 12; i -= 1) {
                    if (isRefEntryStart(scoped[i].text)) { back = i; break }
                    // 遇到节标题说明已经回溯过界
                    if (isRefHeading(scoped[i].text)) break
                  }
                  if (back >= 0) {
                    startIdx = back
                  } else {
                    stopReason = 'fallback'
                    usedFallback = true
                  }
                }
                /**
                 * ---- ③ 累加 ----
                 */
                let out = ''
                let pickedLines = 0
                /** 「已见过年份 / 见过页码或 DOI」—— 正向的条目完整性证据 */
                let seenYear = false
                let seenTail = false
                if (usedFallback) {
                  /**
                   * 退化：前后各 8 行（向前回溯到节标题/条目起始为止，
                   * 避免把上一个条目也吃进来）。
                   */
                  const from = Math.max(0, best - 8)
                  const to = Math.min(scoped.length - 1, best + 8)
                  const parts = []
                  for (let i = from; i <= to; i += 1) {
                    const t = scoped[i].text || ''
                    if (!t) continue
                    parts.push(t)
                  }
                  out = parts.join(' ')
                  pickedLines = parts.length
                } else {
                  for (let i = startIdx; i < scoped.length; i += 1) {
                    const t = scoped[i].text || ''
                    if (!t) continue
                    /**
                     * **判停顺序（按 lead 定稿）：跨栏 / 完整 / 下一条目 / 兜底。**
                     *
                     * 核心改用**正向证据**：一条文献条目必然同时含
                     * 「年份 (19xx)/(20xx)」和「页码范围或 DOI」。
                     * 见到这两样就说明条目已完整，不必去猜边界 ——
                     * 猜边界正是前面反复出错的地方（续行可能以大写开头、
                     * 双栏行序交错、首行可能被遮挡）。
                     */
                    if (i > startIdx) {
                      /**
                       * ① 跨栏停：本行与起始行不在同一栏。
                       * 双栏论文的栏边界是硬的，跨栏必然是新内容。
                       */
                      const sameCol = scoped[i].x0 < scoped[startIdx].x1 + 20
                        && scoped[i].x1 > scoped[startIdx].x0
                      if (!sameCol) { stopReason = 'column'; break }
                      /**
                       * ② 下一条目起始：只作为**辅助**。
                       * 主判据是下面的「完整」。
                       */
                      if (isRefEntryStart(t) && !isRefContinuation(t) && seenYear && seenTail) {
                        stopReason = 'boundary'
                        break
                      }
                    }
                    // 遇到新的节标题也停
                    if (i > startIdx && isRefHeading(t)) { stopReason = 'boundary'; break }
                    if (out.length + 1 + t.length > linkPreviewChars) { stopReason = 'chars'; break }
                    /**
                     * 累积本行，同时更新「见过年份 / 见过页码或 DOI」。
                     * 年份允许 19xx/20xx 且可带字母后缀（2004a）。
                     */
                    out += out ? ` ${t}` : t
                    pickedLines += 1
                    if (!seenYear) seenYear = REF_YEAR_TOKEN.test(t)
                    if (!seenTail) seenTail = REF_TAIL_TOKEN.test(t)
                    /**
                     * ③ 完整了：年份 + 页码/DOI 都见过，且至少取了两行
                     * （单行就同时含两者说明条目极短，也正常，所以
                     * 判据只要求「本行之后已完整」）。
                     */
                    /**
                     * ③ 完整了：年份 + 页码/DOI 都见过。
                     *
                     * **但至少要在第二行之后才判**。实测 `anderson1983`：
                     * 首行只有作者、次行才是 `doi: ...`（有 DOI 无年份），
                     * 年份要到再下一行才出现；若首行同时含两者就立刻停，
                     * 会把条目截在作者名（这正是用户最初报的现象）。
                     * 要求 `pickedLines >= 2` 给条目留出
                     * 「作者行 + 尾部行」的自然结构。
                     */
                    if (seenYear && seenTail && pickedLines >= 2) {
                      stopReason = 'complete'
                      break
                    }
                  }
                }
                out = out.trim()
                /**
                 * **诊断：条目预览为什么信息不全。**
                 *
                 * 用户报「参考文献给出其实不是完整信息」——截图里只有
                 * 作者名就跳到页码。要分清是「best 落在条目中间」
                 * （需要向前回溯）还是「字数上限截断」（需要放宽/改判据）。
                 *
                 * 记录 best 所处位置、前后各几行的文本与 y 间距，
                 * 以及实际取了几行、为什么停。
                 */
                try {
                  const ctxBefore = []
                  for (let i = best - 1; i >= Math.max(0, best - 4); i -= 1) {
                    ctxBefore.push({
                      dy: Math.round(scoped[i].y - scoped[best].y),
                      x0: Math.round(scoped[i].x0),
                      t: (scoped[i].text || '').slice(0, 45),
                    })
                  }
                  const ctxAfter = []
                  for (let i = best + 1; i <= Math.min(scoped.length - 1, best + 4); i += 1) {
                    ctxAfter.push({
                      dy: Math.round(scoped[i].y - scoped[best].y),
                      x0: Math.round(scoped[i].x0),
                      t: (scoped[i].text || '').slice(0, 45),
                    })
                  }
                  reportDiag({
                    event: 'preview:extract',
                    pageNo,
                    destX,
                    destY,
                    bestIndex: best,
                    bestText: (scoped[best].text || '').slice(0, 60),
                    bestX0: Math.round(scoped[best].x0),
                    scopedLen: scoped.length,
                    totalLen: out.length,
                    pickedLines,
                    stopReason,
                    /** 实际取值的起始行（跳过节标题后的位置） */
                    entryStart: startIdx,
                    entryStartText: (scoped[startIdx]?.text || '').slice(0, 60),
                    /** startIdx 是否就是 best（说明没跳过任何东西） */
                    entryIsBest: startIdx === best,
                    usedFallback,
                    lineCount: pickedLines,
                    /** 分栏诊断：列起点、目标列、目标行基线、top 与基线的差 */
                    colStarts,
                    targetCol: targetColStart,
                    targetBaseline,
                    topMinusBaseline,
                    /** 打分选中的行（仅对照用；targetIndex 是实际取值行） */
                    scoreIndex: scoreBest,
                    scoreText: (scoped[scoreBest]?.text || '').slice(0, 60),
                    targetIndex: pickIdx,
                    targetText: (scoped[pickIdx]?.text || '').slice(0, 60),
                    targetIsScore: pickIdx === scoreBest,
                    ctxBefore,
                    ctxAfter,
                  })
                } catch { /* 诊断失败不影响预览 */ }
                out = out.trim()
                if (!out) return null
                if (out.length > linkPreviewChars) {
                  out = `${out.slice(0, linkPreviewChars).trimEnd()}…`
                }
                return out
              } catch { return null }
            }

            /**
             * **跳转落点闪烁。**
             *
             * 点了 `#fig8` 之后只有「滚过去了」这一个反馈，而侧栏里页与页
             * 长得差不多，用户常常找不到到底该看哪一句。所以在落点铺一层
             * 蓝色半透明底，约 1 秒后淡出。
             *
             * 定位不用 dest 的坐标自己算，而是**直接量目标行的 DOM 矩形**：
             * 文本层 span 已经由 pdf.js 摆好位置，拿它的 getBoundingClientRect
             * 再换算到页面元素内即可，比反推 scale、rotation、padding 都可靠。
             *
             * 拿不到行元素时退回「按 offset 估一个横条」，至少给个方向感。
             */
            /**
             * **把目标页渲染成位图，并按 dest 坐标裁出区块。**
             *
             * 为什么需要它：文字预览对正文够用，但 figure、公式、表格
             * 这类内容在文本层里只剩「FIGURE 8」「B3 to M3a prediction shifts...」
             * 这种碎片，用户看到的是「figure 显示还是不对」。他要的是
             * Zotero 那种**把那一块画出来的效果**。
             *
             * 两个硬约束：
             *   · **只渲染目标那一页**（用户明确要求）。不做相邻页预取，
             *     不整篇渲染 —— 每次悬停最多付一页的渲染成本。
             *   · 按 (pageNo) 缓存**整页位图**，同一页的不同目标复用同一张，
             *     只换裁切。这样连续悬停同一页的多个链接几乎零成本。
             *
             * 缓存放普通 Map（不用 hook）：这段代码在 setDocument 的异步
             * 装载链路里，调 hook 会抛 React #321。换文档时随闭包一起丢弃，
             * cleanup 里也显式 clear 一次。
             */
            const pageBitmapCache = new Map()
            /**
             * 缓存容量上限（条）。
             *
             * key 现在带目标宽度，同一页在不同浮窗宽度下会存多份，
             * 不设上限就会无限涨（每份是一整页 canvas，几 MB 量级）。
             * 超限按插入顺序淘汰最旧的（Map 保持插入序）。
             */
            const pageBitmapCacheMax = 24
            /**
             * 正在渲染的页：pageNo → Promise。
             *
             * pdf.js 明确禁止同一个 canvas 同时跑两次 render —— 会抛
             * 「Cannot use the same canvas during multiple render() operations」。
             * 而悬停是快速的：鼠标扫过同页多个链接时，第二次会赶在第一次
             * 完成之前进来。缓存只挡得住「已完成」的，挡不住在途的。
             */
            const pageBitmapPending = new Map()
            /** 一页位图最多占多少像素（宽），防止巨型页面把内存吃光。 */
            const bitmapMaxWidthPx = 1400

            /**
             * 渲染某页到离屏 canvas，返回 { canvas, scale, widthPt, heightPt }。
             * scale 取 devicePixelRatio 但夹到 2 以内 —— 再高只是白烧内存。
             */
            const renderPageBitmap = async (pdfDocument, pageNo, targetCssWidth) => {
              /**
               * **缓存 key 必须带上目标显示宽度。**
               *
               * 原来 key 只有 pageNo：浮窗宽度变了之后仍然命中旧位图，
               * 于是「改了浮窗宽度但图片没变大」。canvas 的像素尺寸是按
               * 目标宽度算的，宽度不同就是不同的位图，必须分开缓存。
               *
               * 取整后再进 key，避免 630.0001 / 630.0002 这种抖动打出多份。
               */
              const wantedCssW = Math.max(
                120,
                Math.round(Number(targetCssWidth) > 0 ? Number(targetCssWidth) : 520),
              )
              const cacheKey = `${pageNo}@${wantedCssW}`
              const cached = pageBitmapCache.get(cacheKey)
              if (cached) return cached
              // 同一页同一宽度的并发请求共用一次渲染，别让两个 render() 撞在同一个 canvas 上
              const pending = pageBitmapPending.get(cacheKey)
              if (pending) return pending
              const job = (async () => {
                const page = await pdfDocument.getPage(pageNo)
                const base = page.getViewport({ scale: 1 })
                const dpr = typeof window !== 'undefined' && window.devicePixelRatio
                  ? Math.min(2, Math.max(1, window.devicePixelRatio))
                  : 1
                /**
                 * 目标：**显示宽度就等于调用方给的浮窗宽度**（乘 dpr 保证清晰），
                 * 不再写死 520 —— 写死会让位图永远只有固定宽度，
                 * 浮窗再宽图片也不变大（用户报的「高度还是不够」的根因）。
                 *
                 * 夹住上限，避免 A0 大图或超大页面把 canvas 撑爆。
                 */
                let scale = (wantedCssW * dpr) / base.width
                scale = Math.max(0.3, Math.min(scale, bitmapMaxWidthPx / base.width, 4))
                const viewport = page.getViewport({ scale })
                const canvas = document.createElement('canvas')
                canvas.width = Math.max(1, Math.floor(viewport.width))
                canvas.height = Math.max(1, Math.floor(viewport.height))
                const ctx = canvas.getContext('2d', { alpha: false })
                if (!ctx) return null
                // 白底：PDF 的透明区域在深色浮窗里会变成灰块
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, canvas.width, canvas.height)
                const task = page.render({ canvasContext: ctx, viewport, canvas })
                await task.promise
                /**
                 * `cssWidth` 是**这次渲染对应的显示宽度**（CSS px），
                 * 由调用方用它换算裁切区、以及写 canvas 的 style 尺寸。
                 */
                const result = { canvas, scale, widthPt: base.width, heightPt: base.height, cssWidth: wantedCssW }
                pageBitmapCache.set(cacheKey, result)
                // 超限淘汰最旧的一条（Map 保持插入序）
                while (pageBitmapCache.size > pageBitmapCacheMax) {
                  const oldest = pageBitmapCache.keys().next()
                  if (oldest.done) break
                  pageBitmapCache.delete(oldest.value)
                }
                return result
              })()
              pageBitmapPending.set(cacheKey, job)
              try {
                return await job
              } finally {
                pageBitmapPending.delete(cacheKey)
              }
            }

            /**
             * 按 dest 算出「该显示页面的哪一块」，单位是 PDF 点。
             *
             * 各种 dest 类型的可用信息不同：
             *   · FitR 直接给了矩形 [left, bottom, right, top]，最省事；
             *   · XYZ / FitH 只有一个锚点 y，横向和高度都得自己估；
             *   · 都没有就整页。
             *
             * **高度要给足**：figure、公式往往比一行高得多，只给一条的话
             * 用户看到的还是「一条碎片」。所以以锚点为中心上下各取一段，
             * 宁可多给上下文。
             */
            /**
             * **这个链接该不该弹位图浮窗？**
             *
             * 用户的原话是「只有图、公式需要悬浮窗」。原来所有 PDF 内链接
             * （`#cite.*`、`#page=N`、`#eq1`、`#fig8`）都弹，既吵又白渲染。
             *
             * 判定用三类信号，**名字只是其一**（纯靠前缀猜会很脆）：
             *
             * ① 名字前缀（最直接的意图信号）。LaTeX 的 \label 约定俗成：
             *    fig/figure/table/tab/eq/equation/alg/algorithm +
             *    可选分隔符 + 编号。表格算「图」——用户说的是「图片、公式」，
             *    而表格同样是文本层里只剩碎片的非文字内容，价值相同。
             *    刻意**不用** `cite`/`bib`/`ref`/`sec`/`page` 这些——
             *    引用、章节、页码都是纯文字目标，弹窗没有增量价值。
             *
             * ② dest 类型（比名字更硬的版面信号）。`FitR` 给的是一个矩形，
             *    PDF 里用矩形框定的目标绝大多数就是图/表/公式块；
             *    而 `FitH`/`XYZ` 这种「给个 y 就完了」的定位对正文和图片
             *    一视同仁，不构成信号。
             *
             * ③ 最后兜底：名字既不像图也不像公式时，**保守不弹**。
             *    宁可少弹（用户还能点过去看），也不要乱弹一屏正文。
             *
             * 返回 true 才弹。调用方在渲染之前就要用它分流，
             * 避免为一页白渲染 bitmap。
             */
            const FIGURE_NAME_RE = /^(?:fig|figure|tab|table|eq|equation|alg|algorithm)(?:[._-]?\d|$)/i
            const isPreviewableDest = (rawName, dest) => {
              const name = String(rawName ?? '').trim()
              if (name && FIGURE_NAME_RE.test(name)) return true
              const kind = dest?.[1]?.name
              /**
               * FitR = 矩形框定。名字没命中时，矩形是唯一能说明
               * 「这一块是独立版面单元」的信号。
               */
              if (kind === 'FitR') {
                const r = [dest[2], dest[3], dest[4], dest[5]]
                // 四个分量齐全才算有效矩形
                if (r.every((v) => typeof v === 'number' && Number.isFinite(v))) return true
              }
              return false
            }

            /**
             * **只读诊断：捞锚点附近的文本层，判断能否据此推出 figure 边界。**
             *
             * 背景：当前论文的图/公式目标全是 `XYZ`——只有锚点 y、没有矩形边界，
             * 所以只能整页裁切，figure 本体只占中间一段，被整页高度绑死。
             * 若能从文本层找到「FIGURE N」这类图注行，就能把裁切区域收窄，
             * 图自然被放大。
             *
             * 这一步**不改任何渲染行为**，只把实测数据记进日志，
             * 供决定裁切规则（尤其是「图在标签上方还是下方」这个方向问题）。
             *
             * @returns {Promise<object|null>} 诊断载荷
             */
            const probeDestText = async (dest, pageNo) => {
              try {
                const pdfDocument = pdfRef.current?.doc
                if (!pdfDocument) return null
                const page = await pdfDocument.getPage(pageNo)
                const vp = page.getViewport({ scale: 1 })
                const kind = dest?.[1]?.name ?? null
                /**
                 * 锚点 y：XYZ 在 [3]，FitH/FitBH 在 [2]。
                 * FitR 用矩形上边 [5] 作参照。
                 */
                let anchorY = null
                if (kind === 'XYZ') anchorY = typeof dest[3] === 'number' ? dest[3] : null
                else if (kind === 'FitH' || kind === 'FitBH') anchorY = typeof dest[2] === 'number' ? dest[2] : null
                else if (kind === 'FitR') anchorY = typeof dest[5] === 'number' ? dest[5] : null
                const content = await page.getTextContent()
                const items = []
                for (const it of content?.items ?? []) {
                  if (!it?.str || !it.str.trim()) continue
                  const x = it.transform?.[4]
                  const y = it.transform?.[5]
                  if (typeof x !== 'number' || typeof y !== 'number') continue
                  items.push({ s: it.str.trim(), x, y, w: it.width ?? 0, h: it.height ?? 0 })
                }
                /**
                 * 锚点 ±120pt 内的文本（PDF 点）。取 ±120 是因为
                 * 图本体 + 图注在纵向上通常就跨这个量级。
                 */
                const WINDOW = 120
                const near = anchorY === null
                  ? []
                  : items
                    .filter((v) => Math.abs(v.y - anchorY) <= WINDOW)
                    .sort((a, b) => b.y - a.y)
                    .slice(0, 40)
                /**
                 * 图注/公式标签识别。命中它就能拿到「图在哪里」的定位锚。
                 */
                const LABEL_RE = /^(FIGURE|Figure|Fig\.?|TABLE|Table|Algorithm|ALGORITHM|Eq\.?|Equation)\s*\d/i
                const labels = items
                  .filter((v) => LABEL_RE.test(v.s))
                  .map((v) => ({ str: v.s.slice(0, 40), y: Math.round(v.y * 10) / 10, x: Math.round(v.x) }))
                  .slice(0, 10)
                return {
                  destKind: kind,
                  anchorY: anchorY === null ? null : Math.round(anchorY * 10) / 10,
                  pageWpt: Math.round(vp.width * 10) / 10,
                  pageHpt: Math.round(vp.height * 10) / 10,
                  totalItems: items.length,
                  nearCount: near.length,
                  /** 锚点附近文本：str 前 40 字 + y 坐标（PDF 点，原点左下） */
                  near: near.map((v) => ({
                    t: v.s.slice(0, 40),
                    y: Math.round(v.y * 10) / 10,
                    dy: Math.round((v.y - (anchorY ?? 0)) * 10) / 10,
                    x: Math.round(v.x),
                  })),
                  /** 整页命中的标签（不限于窗口内），用于判断图注在哪 */
                  labels,
                  hasLabelInWindow: near.some((v) => LABEL_RE.test(v.s)),
                }
              } catch { return null }
            }

            /**
             * **dest[0]（页 ref / 页号）→ 页号（1 基）。**
             *
             * 这段换算原先在跳转与预览两处各写了一遍，抽出来共用。
             * dest[0] 可能是 page ref 对象，也可能直接是 0 基页号。
             */
            const destPageOf = async (dest) => {
              try {
                const pdfDocument = pdfRef.current?.doc
                if (!pdfDocument) return null
                const destRef = dest?.[0]
                let pageIndex
                if (Number.isInteger(destRef)) pageIndex = destRef
                else {
                  const cached = pdfDocument.cachedPageNumber?.(destRef)
                  pageIndex = Number.isInteger(cached) && cached > 0
                    ? cached - 1
                    : await pdfDocument.getPageIndex(destRef)
                }
                if (!Number.isInteger(pageIndex) || pageIndex < 0) return null
                const pageNo = pageIndex + 1
                const total = pdfDocument.numPages || 0
                if (total > 0 && pageNo > total) return null
                return pageNo
              } catch { return null }
            }
            /**
             * **从文本层推出目标区域（图 / 公式）；推不出返回 null。**
             *
             * 背景：这类 LaTeX 论文的命名目标几乎全是 `XYZ` —— 只有锚点
             * (x, y)，没有 figure 边界。整页裁切把图本体埋在一整页里，
             * `contain` 后只有 0.93x，永远「图太小」。
             *
             * 规则（由 lead 定稿，逐条对应真实 PDF 实测）：
             *
             * ① **栏 = `dest[2]`（XYZ 的 left）落在中线哪一侧。**
             *    实测 fig1 left=61（左栏）、fig8 left=317（右栏）、
             *    eq1 left=118（左栏），页面中线 297.6，全部判断正确。
             *
             * ② **在该栏内向上扫**，直到遇到该栏的第一个文本块，
             *    得到纵向区间 [yBot, yTop]。**只在 caption 所在栏判断空白** ——
             *    这是关键：fig8 的 caption 在右栏，它描述的是右栏的图；
             *    左栏那段正文是**另一块内容**，与这张图无关。
             *    若要求「全宽无文本」才认图区，单栏图就永远不成立。
             *
             * ③ **横向：检查另一栏在同一 [yBot, yTop] 区间内是否为空。**
             *    · 空   → 扩到另一栏边界（跨栏）。实测 fig1：y∈[662,782]
             *             右栏也空 → 扩到 497pt 宽（三张热图并排，确实跨栏）
             *    · 非空 → 保持本栏。实测 fig8：左栏 y∈[410,613] 有大量正文
             *             → 保持 230pt 宽
             *    同一条规则自动给出两种结果，不需要特判。
             *
             * ④ 上下各外扩 40%（钳到页面范围）。
             *
             * ⑤ FitR 直接用矩形（不走本函数）。
             *
             * ⑥ 都推不出来 → 返回 null，调用方退回整页。
             *
             * @returns {Promise<{x,y,w,h,kindName,crossColumn}|null>} PDF 点、左下原点
             */
            const inferDestRegion = async (dest, widthPt, heightPt) => {
              const kind = dest?.[1]?.name
              if (kind === 'FitR') return null  // 有矩形，交给 destRegionPts
              if (kind !== 'XYZ' && kind !== 'FitH' && kind !== 'FitBH') return null
              const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
              const anchorY = kind === 'XYZ' ? num(dest[3]) : num(dest[2])
              if (anchorY === null) return null
              const anchorX = num(dest[2])
              try {
                const pdfDocument = pdfRef.current?.doc
                if (!pdfDocument) return null
                const pageNo = await destPageOf(dest)
                if (!pageNo) return null
                const page = await pdfDocument.getPage(pageNo)
                const content = await page.getTextContent()
                const items = []
                for (const it of content?.items ?? []) {
                  if (!it?.str || !it.str.trim()) continue
                  const x = it.transform?.[4]
                  const y = it.transform?.[5]
                  if (typeof x !== 'number' || typeof y !== 'number') continue
                  items.push({ s: it.str.trim(), x, y, w: it.width ?? 0 })
                }
                if (items.length === 0) return null

                // ---- ① 定栏 ----
                const mid = widthPt / 2
                const destIsLeft = anchorX === null ? true : anchorX < mid
                const inSameCol = (v) => (v.x < mid) === destIsLeft
                const colItems = items.filter(inSameCol)
                if (colItems.length < 4) return null

                /**
                 * 本栏 / 邻栏的横向边界。用 item 的实际极值，
                 * 不是整页宽 —— 保持单栏时不能把邻栏带进来。
                 */
                const colX0 = Math.max(0, Math.min(...colItems.map((v) => v.x)) - 6)
                const colX1 = Math.min(widthPt, Math.max(...colItems.map((v) => v.x + v.w)) + 6)
                const otherCol = items.filter((v) => !inSameCol(v))

                const LABEL_RE = /^(FIGURE|Figure|Fig\.?|TABLE|Table|Algorithm|ALGORITHM)\s*\d/i
                const EQ_NO_RE = /^\(\d+\)$/

                /**
                 * ---- ② figure：caption 在锚点附近，图在 caption 上方 ----
                 * 实测 fig1：caption y=653.4，往上到页眉 y=782 全空白 → 图区 [662,782]
                 * 实测 fig8：caption y=397.4，往上到 FIGURE 7 caption 尾巴 y=613 → [410,613]
                 */
                let label = null
                let bestDy = Infinity
                for (const it of colItems) {
                  if (!LABEL_RE.test(it.s)) continue
                  const dy = Math.abs(it.y - anchorY)
                  if (dy < bestDy && dy <= 160) { bestDy = dy; label = it }
                }
                if (label) {
                  /**
                   * ============ **表格 / 算法块：单独的判据** ============
                   *
                   * 表格与图的结构完全相反：图是「连续空白带」，表格是
                   * 「密集的多列文本行」。用图的空白带判据扫表格，
                   * 实测 #tab3 只得到 regionH=64（只盖住表头附近），
                   * 用户看到「表格只显示表头」。
                   *
                   * 真实数据结构（page13，caption y=765.5）：
                   *   y=765.5 n=1  "TABLE 3 Worst (top) and best (bottom)..."  ← caption
                   *   y=741.3 n=5  "P|T|Obs. RT|B3 RT|→"                       ← 表头
                   *   y=724.5 n=5  "Pimple|Zit|800.23|799.9|→"                ← 数据行
                   *   ...（稳定 n=5、行距 14.5pt，共 13 行）
                   *   y=550.9 n=1  "P and T refer to prime and target..."     ← 表注，表格结束
                   *
                   * 判据：从 caption 向**下**扫，
                   *   · 该行 item 数 >= 3（多列）→ 属于表格，继续
                   *   · item 数骤降到 1~2 → 表格结束（表注/正文）
                   *   · 连续 2 行多列才认（避免 caption 本身误判）
                   */
                  const isTable = /^(TABLE|Table|ALGORITHM|Algorithm)\s*\d/i.test(label.s)
                  if (isTable) {
                    /**
                     * 按基线把本栏 item 聚成行（容差 2pt）。
                     */
                    const rowMap = new Map()
                    for (const it of colItems) {
                      const key = Math.round(it.y / 2)
                      if (!rowMap.has(key)) rowMap.set(key, { y: it.y, items: [] })
                      rowMap.get(key).items.push(it)
                    }
                    const rows = [...rowMap.values()].sort((a, b) => b.y - a.y)
                    /**
                     * 从 caption 行向下（y 递减）累积，
                     * 遇到「多列行」就并进来，遇到单列行就停。
                     */
                    let tBot = label.y
                    let multiColSeen = 0
                    for (const row of rows) {
                      if (row.y >= label.y - 1) continue      // 从 caption 下方开始
                      const cols = row.items.length
                      if (cols >= 3) {
                        multiColSeen += 1
                        tBot = row.y - 6
                        continue
                      }
                      /**
                       * 单列行：表格数据已经结束（表注/正文）。
                       * 但要允许 caption 紧下方的单列行（有些表头只有一列）。
                       */
                      if (multiColSeen >= 2) break
                      // 还没见过多列行，继续往下找（容忍 2 行）
                      if (label.y - row.y > 60) break
                    }
                    /**
                     * 上界：caption 自身顶部。表格在 caption 下方，
                     * 所以 yTop 就是 caption 顶行。
                     */
                    const tTop = label.y + 4
                    const th = tTop - tBot
                    if (multiColSeen >= 2 && th > 30) {
                      let blockAbove = null
                      let blockBelow = null
                      for (const it of colItems) {
                        if (it.y > tTop && (blockAbove === null || it.y < blockAbove)) blockAbove = it.y
                        if (it.y < tBot && (blockBelow === null || it.y > blockBelow)) blockBelow = it.y
                      }
                      return {
                        x: colX0, y: tBot, w: colX1 - colX0, h: th,
                        kindName: 'table', crossColumn: false,
                        crossColumnReason: 'table-single-column',
                        blockAbove, blockBelow, pageH: heightPt,
                      }
                    }
                  }
                  /**
                   * 下界：caption 自身那几行（间距小、连续）。
                   * 先算它，因为上界判定要用到「caption 末行」。
                   */
                  let yBot = label.y - 4
                  let captionBottom = label.y
                  const captionRows = colItems
                    .filter((it) => it.y < label.y && it.y > label.y - 90)
                    .sort((a, b) => b.y - a.y)
                  let prevY = label.y
                  for (const it of captionRows) {
                    if (prevY - it.y > 22) break           // 间距突变 → 正文开始
                    yBot = it.y - 4
                    captionBottom = it.y
                    prevY = it.y
                  }
                  /**
                   * **上界：按「连续空白带」判定，不按「第一个文本块」。**
                   *
                   * 原表述「向上扫到第一个文本块」在 fig5 上暴露了缺陷：
                   * caption 在 y=596.4，上方有 150pt 连续空白（图本体），
                   * 再往上才是页眉 y=801.5 —— 按字面会取到页眉，
                   * 区域高 227pt，把整块空白连页眉都包进来。
                   *
                   * 图本体的特征恰恰是「整块连续空白」，所以改成：
                   * 从 caption 上沿逐带（10pt）向上扫，
                   *   · 该带在**图区宽度范围**内全无文本 → 继续向上
                   *   · 遇到有文本的带 → 停，yTop 取上一个全空带的上边
                   *   · 一路空到页顶 → yTop = 页顶
                   * 并剔除页眉页脚（上下 8% 边缘带内的文本不参与）。
                   *
                   * 实测 fig5 → yTop=576（150pt 空白带上沿）；
                   * fig1 的空白带是 [662,782]，规则同样给出正确结果。
                   */
                  const edgeBandTop = heightPt * 0.08
                  const edgeBandBot = heightPt * 0.08
                  /**
                   * 图区横向范围：跨栏与否还未定，先用本栏 + 可能的邻栏
                   * 一起看 —— 空白带在任一栏有字都算「有内容」，
                   * 这样才能把「图跨栏」和「邻栏有正文」区分开。
                   */
                  const widthLo = 0
                  const widthHi = widthPt
                  /**
                   * **空白带判定只在「本栏 + （若跨栏）邻栏」范围内做。**
                   *
                   * 实测 fig8：caption 在右栏 y=397.4，而它左上方 y=408.2
                   * 有左栏正文（"Moreover, extending the model..."）。
                   * 若全宽扫描，这条左栏正文会把 fig8 的图区上界压到 42pt ——
                   * 但那正文属于左栏另一块内容，与右栏的图无关。
                   *
                   * 所以按栏扫：先只看本栏；跨栏判定在下面单独做
                   * （用同一纵向区间检查邻栏）。
                   */
                  const scanSameCol = colItems
                  /** 参与空白判定的文本：剔除页眉页脚 */
                  const scanItems = scanSameCol.filter(
                    (v) => v.y > edgeBandBot && v.y < heightPt - edgeBandTop,
                  )
                  const STEP = 10
                  let yTop = heightPt
                  /**
                   * 起点必须是 **caption 末行之上**，不能是 `label.y + 1` ——
                   * caption 往往有第二行（fig5 的 y=587.4），从 label.y+1
                   * 起扫第一步就撞到那行，yTop 会停在 caption 内部。
                   */
                  let cursor = Math.max(label.y, captionBottom) + 2
                  const capTop = label.y
                  /**
                   * 页眉的上沿：边缘带里最高的那条文本。扫描到它就停 ——
                   * 否则一路空到页顶，区域会把整块页眉下方空白也算进去。
                   */
                  let headerBottom = heightPt
                  for (const v of items) {
                    if (v.y <= heightPt - edgeBandTop) continue
                    if (v.y < headerBottom) headerBottom = v.y
                  }
                  const scanCeil = Math.min(heightPt, headerBottom)
                  while (cursor < scanCeil) {
                    const bandLo = cursor
                    const bandHi = Math.min(scanCeil, cursor + STEP)
                    const hasText = scanItems.some(
                      /**
                       * 容差要**向下收紧**：caption 顶行就在 cursor 下方
                       * 1~2pt 处，若用 `bandLo - 1` 会把 caption 自身
                       * 算进这一带（实测 fig5 起步那一带就命中了
                       * `FIGURE 5` y=596.4），扫描当场停住、yTop 贴着 caption。
                       */
                      (v) => v.y > bandLo + 0.5 && v.y <= bandHi + 1
                        && v.x + v.w > widthLo && v.x < widthHi,
                    )
                    if (hasText) break
                    cursor = bandHi
                  }
                  yTop = Math.min(scanCeil, cursor)
                  /** 空白带至少要有点高度，否则退回「本栏第一个文本块」的旧逻辑 */
                  if (yTop - yBot < 20) {
                    let fallback = heightPt
                    for (const it of colItems) {
                      if (it.y <= capTop + 1) continue
                      if (it.y < fallback) fallback = it.y
                    }
                    yTop = fallback
                  }
                  const h = yTop - yBot
                  if (h > 30) {
                    /**
                     * ---- ③ 横向：邻栏在同一纵向区间是否为空 ----
                     * 空 → 跨栏（fig1/fig5）；非空 → 保持本栏（fig8）。
                     *
                     * **两个要排除的对象：**
                     *   · 页眉/页脚：距上下边缘 8% 内的文本是版面装饰，
                     *     不该挡路（实测 fig1 右栏只有一条 DOI 页眉）。
                     *   · **caption 自身**：实测 fig5 的 caption 横跨到
                     *     x=531（右栏 y=587.4 有两个 item），若算作
                     *     「邻栏有内容」就会拒绝跨栏 —— 但那是 caption
                     *     的右半截，不是图区的障碍。
                     *     只排除 caption 行，不能扩大成「整个区间都不看右栏」，
                     *     那等于永远跨栏。
                     */
                    const edgeBand = heightPt * 0.08
                    const inCaptionRange = (v) => v.y >= captionBottom - 8 && v.y <= label.y + 8
                    const overlapRaw = otherCol.filter(
                      (v) => v.y >= yBot - 2 && v.y <= yTop + 2,
                    )
                    const overlap = overlapRaw.filter(
                      (v) => v.y > edgeBand && v.y < heightPt - edgeBand
                        && !inCaptionRange(v),
                    )
                    const overlapRawCount = overlapRaw.length
                    const crossColumn = overlap.length === 0
                    let x0 = colX0
                    let x1 = colX1
                    if (crossColumn && otherCol.length > 0) {
                      x0 = Math.max(0, Math.min(x0, Math.min(...otherCol.map((v) => v.x)) - 6))
                      x1 = Math.min(widthPt, Math.max(x1, Math.max(...otherCol.map((v) => v.x + v.w)) + 6))
                    }
                    /**
                     * ---- ④ 返回**未外扩**的紧致区域 ----
                     *
                     * 外扩不在这里做：它需要知道 `availH` 与目标倍率，
                     * 而那两个值只有 `renderDestBitmap` 才有。
                     * 早先在 inferDestRegion 里按固定 40% 外扩，导致
                     * fig8 的区域高从 203pt 撑到 391pt，`scale` 被
                     * `availH/regionH` 卡成 2.25（只 +3%），比不外扩还差。
                     *
                     * 现在由 renderDestBitmap 用「受高度预算约束」的
                     * 自适应外扩统一处理（见那里的说明）。
                     */
                    if (yTop - yBot > 20) {
                      /**
                       * 顺带把「上下最近的文本块」带出去，供外扩时避让
                       * （外扩不能把正文裁进图里）。
                       */
                      let blockAbove = null   // yTop 上方最近的文本块 y
                      let blockBelow = null   // yBot 下方最近的文本块 y
                      for (const it of colItems) {
                        if (it.y > yTop && (blockAbove === null || it.y < blockAbove)) blockAbove = it.y
                        if (it.y < yBot && (blockBelow === null || it.y > blockBelow)) blockBelow = it.y
                      }
                      return {
                        x: x0, y: yBot, w: x1 - x0, h: yTop - yBot,
                        kindName: 'figure', crossColumn,
                        blockAbove, blockBelow, pageH: heightPt,
                        crossColumnReason: crossColumn
                          ? (overlapRawCount > 0 ? 'other-col-only-header' : 'other-col-empty')
                          : 'other-col-occupied',
                      }
                    }
                  }
                }

                /**
                 * ---- ⑤ 公式：靠编号 (N) 定位 ----
                 * 实测 eq1 的 (1) 在 y=88.0、与公式同基线，
                 * 其上下最近的正文块是 y=127.8 与 y=35.4（页脚）。
                 */
                let eqNo = null
                let eqDy = Infinity
                for (const it of colItems) {
                  if (!EQ_NO_RE.test(it.s)) continue
                  const dy = Math.abs(it.y - anchorY)
                  if (dy < eqDy) { eqDy = dy; eqNo = it }
                }
                if (eqNo && eqDy <= 60) {
                  const around = colItems
                    .filter((it) => Math.abs(it.y - eqNo.y) <= 120)
                    .sort((a, b) => b.y - a.y)
                  let yTop = heightPt
                  let prev = eqNo.y + 30
                  for (const it of around) {
                    if (it.y <= eqNo.y) continue
                    if (prev - it.y > 26) { yTop = it.y; break }
                    prev = it.y
                    yTop = it.y
                  }
                  let yBot = 0
                  prev = eqNo.y - 30
                  for (const it of around) {
                    if (it.y >= eqNo.y) continue
                    if (it.y < prev - 26) { yBot = it.y; break }
                    prev = it.y
                    yBot = it.y
                  }
                  if (yTop - yBot > 20) {
                    /**
                     * 同样返回紧致区域，外扩交给 renderDestBitmap 统一做。
                     */
                    let blockAbove = null
                    let blockBelow = null
                    for (const it of colItems) {
                      if (it.y > yTop && (blockAbove === null || it.y < blockAbove)) blockAbove = it.y
                      if (it.y < yBot && (blockBelow === null || it.y > blockBelow)) blockBelow = it.y
                    }
                    return {
                      x: colX0, y: yBot, w: colX1 - colX0, h: yTop - yBot,
                      kindName: 'equation', crossColumn: false,
                      crossColumnReason: 'single-column',
                      blockAbove, blockBelow, pageH: heightPt,
                    }
                  }
                }
                return null
              } catch { return null }
            }

            const destRegionPts = (dest, widthPt, heightPt) => {
              const kind = dest?.[1]?.name
              const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
              if (kind === 'FitR') {
                const left = num(dest[2])
                const bottom = num(dest[3])
                const right = num(dest[4])
                const top = num(dest[5])
                if (left !== null && bottom !== null && right !== null && top !== null) {
                  // 矩形外扩一点留白，别把边框裁掉
                  const pad = 8
                  return {
                    x: Math.max(0, left - pad),
                    y: Math.max(0, bottom - pad),
                    w: Math.min(widthPt, right + pad) - Math.max(0, left - pad),
                    h: Math.min(heightPt, top + pad) - Math.max(0, bottom - pad),
                  }
                }
              }
              /**
               * 锚点型：XYZ 的 y 在 dest[3]，FitH/FitBH 在 dest[2]。
               * PDF 坐标系原点左下，所以要沿 y 上下取一段。
               */
              let anchorY = null
              if (kind === 'XYZ') anchorY = num(dest[3])
              else if (kind === 'FitH' || kind === 'FitBH') anchorY = num(dest[2])
              if (anchorY === null) {
                // 没有可用坐标：整页
                return { x: 0, y: 0, w: widthPt, h: heightPt }
              }
              /**
               * **裁切高度：整页。**
               *
               * 用户报「现在滑动没有任何效果」——根因就在这里：
               * 原先把裁切区域定为页高的 42%（实测 354px），而容器
               * `.zr-tip-shot` 的 max-height 是 min(58vh,460px)（≥406px），
               * 内容根本没溢出，`scrollHeight - clientHeight` 恒为 0，
               * 滚轮自然滚不动（onTipWheel 里 `if (maxTop > 0)` 永假）。
               *
               * 改成整页后，浮窗内可以滑动着看目标前后的完整上下文，
               * 这也正是用户要的「滑动」语义。可见区域由 CSS 高度限制
               * （见 .zr-tip-shot 的 max-height），内容必然溢出 → 可滚。
               *
               * 从整页里把锚点滚动到视口偏上位置：目标通常在可见区的
               * 上部，下方留出后续内容。
               */
              const h = heightPt
              void anchorY
              /**
               * **区块以锚点为中心、上下对称取。**
               *
               * 为什么不能只往一个方向取：实测同一篇论文里，不同目标的
               * 锚点语义并不一致 ——
               *   · `fig8` 锚点 y=409，``FIGURE 8`` 标签在 y=397，
               *     图在标签下方（PDF 坐标 y 更小）；
               *   · `eq1` 锚点 y=85，±25pt 内直接就是公式本体
               *     「Ai = Bi + C∑…」，上下都有内容；
               *   · `cite.*` 锚点落在文献条目上，条目本身跨好几行。
               *
               * 所以「以锚点为上沿往下取」（对 figure 有效）会把公式上方
               * 的推导切掉，「往上取」又会把图切掉。对称取是唯一能同时
               * 覆盖三种情况的策略：锚点附近的内容一定在块内。
               *
               * 代价是块内可能多带一些上下文——这恰恰是任务要求的
               * 「宁可多给上下文也不要只显示一条」。
               */
              /**
               * 整页裁切时 y 恒为 0（块就是整页）。
               * 锚点位置改由 `putTipBitmap` 里的 scrollTop 定位 ——
               * 这样浮窗一出现就滚到目标附近，而不是从页首开始。
               */
              let y = 0
              void anchorY
              /**
               * 横向：默认整页宽。figure 常居中或跨栏，
               * 按 dest.x 去裁会把图裁掉半边，得不偿失。
               */
              return { x: 0, y, w: widthPt, h }
            }

            /**
             * **历史区域推导 —— 已不再用于浮窗尺寸。**
             *
             * 下面三个函数属于「从 PDF 推导图/表/公式边界 → 裁出来 →
             * 放大填满浮窗」那套旧方案：`inferDestRegion` 按文本层空白带
             * 推区域，`destRegionPts` 按 dest 取矩形，`computeBitmapGeometry`
             * 把区域做 contain 缩放并给出 popupW/popupH。
             *
             * 该方案已废弃：实测 509×308pt 的区域被渲成 1240×720px
             * （约 2.4 倍），图和字都巨大；而且它算出的 popupW/popupH
             * 与显示层各成一套几何，日志里出现 `canvasCssW=1240` 而
             * `popupW=630`。浮窗尺寸现在唯一由 `computePopupSize` 给出，
             * 内容由 `renderPagePreview` 整页输出。
             *
             * **故意保留**这三个函数：跳转高亮等场景仍可能需要按 dest
             * 定位区域，它们也有独立的回归测试。不要因为暂时没有调用点
             * 就删掉，更不要再用它们决定浮窗尺寸。
             */
            /**
             * **位图浮窗的高度天花板 —— 唯一来源。**
             *
             * `computeTipPlacement` 用它给出「空间充足时的最大高度」。
             * 位图浮窗的期望高度现在是 `popupH`（0.3 × 页高），这个
             * 天花板只作兜底：拿不到 popupH 时才会用到。
             *
             * 取 min(80vh, 780)：占视口八成、上限 780。
             */
            const bitmapHeightCap = () => Math.min(window.innerHeight * 0.8, 780)

            const computeBitmapGeometry = async (dest, pageNo, availW, availH) => {
              try {
                const pdfDocument = pdfRef.current?.doc
                if (!pdfDocument) return null
                const page = await pdfDocument.getPage(pageNo)
                const base = page.getViewport({ scale: 1 })
                const widthPt = base.width
                const heightPt = base.height
                const inferred = await inferDestRegion(dest, widthPt, heightPt)
                const baseRegion = inferred || destRegionPts(dest, widthPt, heightPt)
                /**
                 * 自适应外扩：只在「不牺牲缩放」的前提下才扩。
                 * 固定 40% 会把 fig8 的区域高从 203pt 撑到 391pt，
                 * scale 被 availH/regionH 卡成 2.25（只 +3%）。
                 */
                const wantPad = Math.max(12, Math.min(baseRegion.h * 0.25, 80))
                const targetScaleW = Math.min(
                  availW / Math.max(1, baseRegion.w),
                  4,
                  bitmapMaxWidthPx / Math.max(1, baseRegion.w),
                )
                const hBudget = availH > 0 && targetScaleW > 0 ? availH / targetScaleW : Infinity
                const maxPadByHeight = hBudget !== Infinity
                  ? Math.max(0, (hBudget - baseRegion.h) / 2)
                  : wantPad
                let maxPadByText = wantPad
                if (inferred) {
                  const pageH = inferred.pageH || heightPt
                  const roomAbove = inferred.blockAbove != null
                    ? Math.max(0, inferred.blockAbove - (baseRegion.y + baseRegion.h) - 4)
                    : Math.max(0, pageH - (baseRegion.y + baseRegion.h))
                  const roomBelow = inferred.blockBelow != null
                    ? Math.max(0, baseRegion.y - inferred.blockBelow - 4)
                    : baseRegion.y
                  maxPadByText = Math.max(0, Math.min(roomAbove, roomBelow))
                }
                const padY = Math.max(0, Math.min(wantPad, maxPadByHeight, maxPadByText))
                const region = {
                  x: baseRegion.x,
                  w: baseRegion.w,
                  y: Math.max(0, baseRegion.y - padY),
                  h: Math.min(heightPt, baseRegion.y + baseRegion.h + padY) - Math.max(0, baseRegion.y - padY),
                }
                /**
                 * contain：完整装下，长边贴边、短边留白。
                 * 上限 4 且受画布像素预算兜底。
                 */
                const scaleCap = Math.min(4, bitmapMaxWidthPx / Math.max(1, region.w))
                const scale = Math.min(availW / region.w, availH / region.h, scaleCap)
                const popupW = Math.round(region.w * scale)
                const popupH = Math.round(region.h * scale)
                return {
                  region,
                  scale,
                  scaleCap,
                  /**
                   * **高度夹取必须用 `bitmapHeightCap()`，与放置阶段同源。**
                   * 原来用 `availH`（= min(innerHeight*0.88, 880)），
                   * 而 placement 用 min(80vh,780) —— 两者不同，
                   * canvas 按 879 渲染、浮窗只有 780，底部 99px 被裁。
                   */
                  popupW: Math.max(160, Math.min(popupW, availW)),
                  popupH: Math.max(120, Math.min(popupH, availH, bitmapHeightCap())),
                  regionKind: inferred ? inferred.kindName : (dest?.[1]?.name === 'FitR' ? 'fitr' : 'page'),
                  crossColumn: inferred ? Boolean(inferred.crossColumn) : false,
                  crossColumnReason: inferred ? (inferred.crossColumnReason || '') : '',
                }
              } catch { return null }
            }
            const renderPagePreview = async (pageNo, popupW) => {
              try {
                const pdfDocument = pdfRef.current?.doc
                if (!pdfDocument) return null
                /**
                 * 按**浮窗宽度**渲染整页位图：显示宽度即 popupW，
                 * 像素密度由 renderPageBitmap 内部按 dpr 决定（夹 2 以内）。
                 */
                const bitmap = await renderPageBitmap(pdfDocument, pageNo, popupW)
                if (!bitmap) return null
                const { widthPt, heightPt } = bitmap
                /**
                 * **不再裁区域。**
                 *
                 * 旧实现拿 `computeBitmapGeometry` 的 region/scale 把目标块
                 * 从整页里复制出来，再按 contain 放大到填满浮窗 —— 实测
                 * 509×308pt 的区域被渲成 1240×720px（约 2.4 倍），图和字
                 * 都巨大，用户明确否掉了这个方向。
                 *
                 * 现在的语义是「浮窗里放一整页，按浮窗宽度等比缩小，
                 * 内部可滚动」：整页位图直接复用 `renderPageBitmap`，
                 * 它已按 `pageNo@宽度` 缓存，同一页换宽度不会命中旧位图。
                 */
                const canvas = bitmap.canvas
                /**
                 * **canvas 的 CSS 尺寸 = 浮窗宽度 × 页面自身宽高比。**
                 *
                 * 宽度必须等于 popupW（单一几何源），高度只按页面比例推，
                 * 不再由任何「区域高度 × 缩放」决定 —— 否则又会出现
                 * 「canvas 1240 而浮窗 630」那种两套几何。
                 */
                const cssW = Math.max(1, Math.round(bitmap.cssWidth))
                const cssH = Math.max(1, Math.round(cssW * (heightPt / widthPt)))
                /**
                 * **显示尺寸用 cssW/cssH（宽度 = popupW）。**
                 *
                 * 不能用 `canvas.width / scale`：那个式子数学上恒等于页面
                 * 宽度（PDF 点），与 dpr、与浮窗宽度都无关 —— 实测 A4 整页
                 * 无论 dpr=1 还是 2，CSS 永远是 595×843。
                 */
                canvas.style.width = `${cssW}px`
                canvas.style.height = `${cssH}px`
                // 不让任何 max-width 规则再压一次：宽度已经等于浮窗宽度
                canvas.style.maxWidth = 'none'
                /**
                 * 把本次实际尺寸挂到元素上，供诊断读取
                 * （判断 canvas 与浮窗是否同源、渲染是否被像素预算夹住）。
                 */
                try {
                  canvas.dataset.cssW = String(cssW)
                  canvas.dataset.cssH = String(cssH)
                  canvas.dataset.pageWpt = String(Math.round(widthPt))
                  canvas.dataset.pageHpt = String(Math.round(heightPt))
                } catch { /* ignore */ }
                // 整页位图本身就是内容；锚点定位由 putTipBitmap 的 scrollTop 做
                return canvas
              } catch { return null }
            }

            const jumpFlashMs = 1000
            /** 当前闪烁元素与定时器，必须能被 cleanup 清掉。 */
            let jumpFlashEl = null
            /** 多行高亮时除第一块之外的其余块，同样要能被清理。 */
            let jumpFlashExtraEls = []
            let jumpFlashTimer = 0
            /**
             * **闪烁的代数（generation）。**
             *
             * 为什么要它：`flashJumpTarget` 在页元素还没渲染时会挂一个
             * 延迟 retry（`pagerendered` 或 400ms 兜底），而 retry 最后
             * 会**再次调用** `flashJumpTarget` —— 那个函数开头就是
             * `clearJumpFlash()`。
             *
             * 于是连续快速跳转两次时会出现：
             *   ① 第一次跳转 → 页元素没出来 → 挂 retry
             *   ② 第二次跳转 → 页元素已出来 → 画好新高亮
             *   ③ 第一次的 retry 迟到执行 → 开头 clearJumpFlash()
             *      → 把第二次的高亮清掉
             * 用户看到「跳了但没高亮」，与原始 bug 同症状、更偶发。
             *
             * 用单调递增的代数解决：顶层调用开启新一代，retry 递归时
             * 带上同一代；入口处只要发现不是当前代就直接作废。
             */
            let jumpFlashSeq = 0

            const clearJumpFlash = () => {
              if (jumpFlashTimer) { clearTimeout(jumpFlashTimer); jumpFlashTimer = 0 }
              try { jumpFlashEl?.remove() } catch { /* 已经不在 DOM 里 */ }
              /**
               * 多行高亮会有多个块，必须全部移除，否则第二行以后
               * 的方块会永久留在页面上（它们不在 jumpFlashEl 里）。
               */
              try {
                for (const el of jumpFlashExtraEls) el?.remove?.()
              } catch { /* ignore */ }
              jumpFlashExtraEls = []
              jumpFlashEl = null
            }

            /**
             * @param {number} [seq] 代数。顶层调用不传（自增开启新一代）；
             *   retry 递归时必须带上同一代，否则会被自己的入口判据作废。
             */
            const flashJumpTarget = (pageNo, offset, previewText, seq) => {
              try {
                /**
                 * **先判代际，再清旧块。**
                 *
                 * 顺序不能反：`clearJumpFlash()` 会无条件移除当前闪烁块，
                 * 如果放在代际判断之前，一个过期 retry 会在开头就把
                 * 新一代刚画好的高亮清掉 —— 那正是要修的竞态。
                 */
                if (seq === undefined) seq = ++jumpFlashSeq
                if (seq !== jumpFlashSeq) {
                  reportDiag({ event: 'jump:flash-skip', pageNo, offset, reason: 'stale', seq, current: jumpFlashSeq })
                  return
                }
                clearJumpFlash()
                const host = hostRef.current
                const pageEl = host?.querySelector?.(`.page[data-page-number="${pageNo}"]`)
                /**
                 * **页元素可能还不存在。**
                 *
                 * `jumpToNamedDest` 里刚调完 scrollPageIntoView 就调到这里，
                 * 而 pdf.js 的目标页常常是懒渲染的：页元素要等它把
                 * 可视区滚过去之后才创建。原来在这里 `return` 掉，
                 * 结果就是「跳转成功、但高亮从不出现」——正是用户报的
                 * 「超链接跳转后也没有一个高亮窗口」。
                 *
                 * 所以页元素还没出来时，改挂到 pagerendered 上等一次，
                 * 别直接放弃。诊断里区分各种情况，便于日后判断。
                 */
                if (!pageEl) {
                  reportDiag({ event: 'jump:flash-skip', pageNo, offset, reason: 'no-page-el', seq })
                  const bus = eventBusRef.current
                  if (!bus) return
                  let once = false
                  const retry = () => {
                    if (once) return
                    once = true
                    try { bus.off('pagerendered', retry) } catch { /* ignore */ }
                    // 等一帧，让 pdf.js 把页元素真正插进 DOM；**带上同一代**
                    setTimeout(() => flashJumpTarget(pageNo, offset, previewText, seq), 60)
                  }
                  try {
                    bus.on('pagerendered', retry)
                    setTimeout(retry, 400)
                  } catch { /* 总线不可用就放弃 */ }
                  return
                }
                const pageRect = pageEl.getBoundingClientRect()
                if (!(pageRect.width > 0 && pageRect.height > 0)) {
                  reportDiag({ event: 'jump:flash-skip', pageNo, offset, reason: 'zero-size', seq })
                  return
                }

                const box = document.createElement('div')
                box.className = 'zr-jump-flash'
                /**
                 * 默认：横跨页面正文区、高约两行的一个横条，
                 * 纵向按 offset 落在目标位置。
                 */
                const pageH = pageEl.clientHeight || pageRect.height
                const lineH = Math.max(16, Math.min(30, pageH * 0.032))
                const inset = Math.max(8, pageRect.width * 0.06)
                let left = inset
                let top = pageH * Math.min(0.98, Math.max(0, offset || 0))
                let width = Math.max(40, pageRect.width - inset * 2)
                let height = lineH

                /**
                 * 更精确的做法：在文本层里找到与预览文字匹配的 span，
                 * 直接用它自己的矩形。文本层还没画出来时返回 false。
                 *
                 * 抽成函数是因为它可能要跑两次：目标页首次打开时
                 * `.textLayer` 里的 span 还没生成，得等 textlayerrendered 再补。
                 */
                                const TEXT_LAYER_MATCH_LIMIT = 60

                                /**
                                 * **在文本层里定位预览文字，返回若干「行矩形」。**
                                 *
                                 * 旧实现把匹配方向写反了：`needle.includes(t)` 判的是
                                 * 「预览文字里包含这个 span」，于是碰到 `overlap?`、`and`
                                 * 这种短 span 就立刻命中并 break，真正装着整条文献的那个
                                 * span 根本没机会被检查 —— 用户看到的就是「高亮只圈住
                                 * 一个词」。
                                 *
                                 * 现在按正确的方向做，分三步：
                                 *
                                 * ① **拼接 + 记偏移**：把所有 span 按 DOM 顺序拼成一条
                                 *    字符串，同时记下每个 span 在串里的起止位置。
                                 *    PDF 文本层里一行常被拆成多个 span
                                 *    （"..due to" / "association strength or feature " /
                                 *     "overlap" / "? A microanalytic review..."），
                                 *    只有这样跨 span 的匹配才成立。
                                 *
                                 * ② **在拼接串里 indexOf(needle)**，拿到绝对区间。
                                 *
                                 * ③ **反查出该区间覆盖的 span**，再**按行分组**，
                                 *    每行合成一个条状矩形。跨行时画多条，贴合真实形状；
                                 *    用一个大包围盒会把中间的空白也圈进去。
                                 *
                                 * 返回 null 表示匹配不到（调用方退回按 offset 估算的横条）。
                                 */
                                const locatePreviewLines = () => {
                                  if (!previewText) return null
                                  try {
                                    const spans = pageEl.querySelectorAll('.textLayer span')
                                    if (spans.length === 0) return null
                                    /**
                                     * 预览文字可能被截断并带省略号：取 `…` 之前的部分，
                                     * 否则 needle 里带着 …，永远匹配不上。
                                     */
                                    let needle = String(previewText).trim()
                                    const ell = needle.indexOf('…')
                                    if (ell >= 0) needle = needle.slice(0, ell).trim()
                                    needle = needle.replace(/\s+/g, ' ').slice(0, TEXT_LAYER_MATCH_LIMIT)
                                    if (needle.length < 4) return null

                                    // ① 拼接并按 DOM 顺序记偏移
                                    const parts = []
                                    let joined = ''
                                    for (const sp of spans) {
                                      const t = (sp.textContent || '')
                                      if (!t) continue
                                      const start = joined.length
                                      joined += t
                                      parts.push({ el: sp, start, end: joined.length })
                                    }
                                    if (!joined) return null
                                    /**
                                     * ② **只保留字母数字再比，并记住每个字符的原文位置。**
                                     *
                                     * 为什么不能直接 `joined.indexOf(needle)`：文本层与
                                     * 预览文字的**空格并不一致**。实测本库那篇 page15：
                                     *   · 文本层原文是 `association strengthor feature`
                                     *     （`strengthor` 连在一起，没有空格）
                                     *   · 而 extractDestPreview 聚行时用单空格拼接，
                                     *     给出的预览是 `strength or feature`
                                     * 逐字比较必然失败。标点、连字符、连字同理。
                                     *
                                     * 剥成纯字母数字后，`strengthor` 与 `strength or`
                                     * 都归一化成 `strengthor`，就能稳定命中；
                                     * map 数组把归一化偏移映射回原文偏移，
                                     * 从而反查出到底覆盖了哪些 span。
                                     */
                                    const stripMap = (str) => {
                                      let out = ''
                                      const map = []
                                      for (let k = 0; k < str.length; k += 1) {
                                        const ch = str[k]
                                        if (/[A-Za-z0-9]/.test(ch)) {
                                          out += ch
                                          map.push(k)
                                        }
                                      }
                                      return { out, map }
                                    }
                                    const joinedStrip = stripMap(joined)
                                    const needleStrip = stripMap(needle)
                                    if (needleStrip.out.length < 4) return null
                                    /**
                                     * 用剥后串的前 50 个字符做定位探针：
                                     * 太长会因个别差异整体失败，太短容易误匹配到别处。
                                     */
                                    const probe = needleStrip.out.slice(0, Math.min(50, needleStrip.out.length))
                                    const idxS = joinedStrip.out.indexOf(probe)
                                    if (idxS < 0) return null
                                    const s0 = joinedStrip.map[idxS]
                                    const s1 = joinedStrip.map[Math.min(
                                      joinedStrip.map.length - 1,
                                      idxS + needleStrip.out.length - 1,
                                    )]
                                    if (!(typeof s0 === 'number' && typeof s1 === 'number' && s1 > s0)) return null
                                    const hitStart = s0
                                    const hitEnd = s1 + 1
// ③ 反查覆盖到的 span
                                    const covered = parts.filter((v) => v.end > hitStart && v.start < hitEnd)
                                    if (covered.length === 0) return null

                                    // ④ 按行分组（纵向中线接近即同一行）
                                    const withRect = []
                                    for (const v of covered) {
                                      const rr = v.el.getBoundingClientRect()
                                      if (rr.width > 0 && rr.height > 0) withRect.push({ r: rr, v })
                                    }
                                    if (withRect.length === 0) return null
                                    withRect.sort((a, b) => a.r.top - b.r.top)
                                    const rows = []
                                    for (const item of withRect) {
                                      const mid = item.r.top + item.r.height / 2
                                      let row = null
                                      for (const candidate of rows) {
                                        if (Math.abs(candidate.mid - mid) <= Math.max(2, item.r.height * 0.5)) {
                                          row = candidate
                                          break
                                        }
                                      }
                                      if (!row) {
                                        row = { mid, rects: [] }
                                        rows.push(row)
                                      }
                                      row.rects.push(item.r)
                                    }
                                    // 每行取并集矩形
                                    const lines = []
                                    for (const row of rows) {
                                      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
                                      for (const rr of row.rects) {
                                        x0 = Math.min(x0, rr.left)
                                        x1 = Math.max(x1, rr.right)
                                        y0 = Math.min(y0, rr.top)
                                        y1 = Math.max(y1, rr.bottom)
                                      }
                                      if (!(x1 > x0 && y1 > y0)) continue
                                      lines.push({ x0, x1, y0, y1 })
                                    }
                                    if (lines.length === 0) return null
                                    /**
                                     * 排序后只保留**开头两行**。
                                     *
                                     * 用户要的是「看到跳到哪」的指示。一条参考文献可能跨
                                     * 五六行，全画会盖住半页；取前两行既够定位又不喧宾夺主。
                                     */
                                    lines.sort((a, b) => a.y0 - b.y0)
                                    const kept = lines.slice(0, 2)
                                    return {
                                      lines: kept,
                                      matchedText: joined.slice(hitStart, Math.min(hitEnd, hitStart + 60)),
                                      spanCount: covered.length,
                                    }
                                  } catch { return null }
                                }

const placeBox = (el, l, t, wd, ht) => {
                  el.style.left = `${Math.round(l)}px`
                  el.style.top = `${Math.round(t)}px`
                  el.style.width = `${Math.round(wd)}px`
                  el.style.height = `${Math.round(ht)}px`
                }
                /**
                 * **多块绘制。**
                 *
                 * 一条参考文献可能跨好几行，画一个大包围盒会把中间的
                 * 空白也圈进去。locatePreviewLines 返回的是**逐行**矩形，
                 * 每行一块，贴合真实形状。
                 *
                 * 匹配不到时退回单块估算横条（按 offset 定位），
                 * 保证「至少有指示」。
                 */
                const boxes = [box]
                const located = locatePreviewLines()
                const alignedNow = Boolean(located)
                if (located) {
                  const first = located.lines[0]
                  left = Math.max(0, first.x0 - pageRect.left - 2)
                  top = Math.max(0, first.y0 - pageRect.top - 1)
                  width = Math.min(pageRect.width, Math.max(8, first.x1 - first.x0 + 4))
                  height = Math.max(8, first.y1 - first.y0 + 2)
                  placeBox(box, left, top, width, height)
                  for (let i = 1; i < located.lines.length; i += 1) {
                    const ln = located.lines[i]
                    const extra = document.createElement('div')
                    extra.className = 'zr-jump-flash'
                    placeBox(
                      extra,
                      Math.max(0, ln.x0 - pageRect.left - 2),
                      Math.max(0, ln.y0 - pageRect.top - 1),
                      Math.min(pageRect.width, Math.max(8, ln.x1 - ln.x0 + 4)),
                      Math.max(8, ln.y1 - ln.y0 + 2),
                    )
                    boxes.push(extra)
                  }
                } else {
                  placeBox(box, left, top, width, height)
                }
                pageEl.appendChild(box)
                for (let i = 1; i < boxes.length; i += 1) pageEl.appendChild(boxes[i])
                jumpFlashEl = box
                /**
                 * 多出来的块要能被清理：clearJumpFlash 会一并移除。
                 */
                jumpFlashExtraEls = boxes.slice(1)
                /**
                 * **几何留痕。**
                 *
                 * 用户报「跳转后没有高亮」，而这条链路全程 try/catch 吞错，
                 * 光看代码无法区分「没创建」「创建了但位置在页外」
                 * 「创建了但看不见（配色/混合模式）」。这条诊断把落点的
                 * 实际几何记进 client-log.jsonl，一次实测就能定性。
                 */
                reportDiag({
                  event: 'jump:flash',
                  pageNo,
                  offset,
                  seq,
                  aligned: alignedNow === true,
                  /** 画了几块（跨行时 > 1） */
                  blocks: boxes.length,
                  left: Math.round(left),
                  top: Math.round(top),
                  w: Math.round(width),
                  h: Math.round(height),
                  pageW: Math.round(pageRect.width),
                  pageH: Math.round(pageH),
                  hasPreview: Boolean(previewText),
                })
                /**
                 * **匹配细节单列一条。**
                 *
                 * 万一位置还不对，这条能直接区分：
                 *   · matchedText 为空 → 根本没匹配上（几何是估算的）
                 *   · matchedText 不是预期的句子 → 匹配错了行
                 *   · matchedText 对但几何偏 → 矩形换算有问题
                 */
                if (located) {
                  reportDiag({
                    event: 'jump:flash-match',
                    pageNo,
                    needle: String(previewText).slice(0, 60),
                    spansHit: located.spanCount,
                    lines: located.lines.length,
                    text: located.matchedText.slice(0, 60),
                  })
                } else {
                  reportDiag({
                    event: 'jump:flash-match',
                    pageNo,
                    needle: String(previewText || '').slice(0, 60),
                    spansHit: 0,
                    lines: 0,
                    text: null,
                  })
                }

                /**
                 * **文本层可能还没画出来。**
                 *
                 * 目标页若是首次打开（懒渲染），`scrollPageIntoView` 那一刻
                 * 页元素在、但 `.textLayer` 里的 span 还没生成 —— 精确对齐必然失败，
                 * 用户看到的就是「一个跟内容对不上的横条」。
                 * 所以在 textlayerrendered 上挂一次性补位（只关心目标页），
                 * 页面画好后把估算块换成真实行矩形。用 once 语义 + 自身校验，
                 * 避免长期挂着或改到已经被替换掉的节点。
                 */
                const bus = eventBusRef.current
                if (!alignedNow && previewText && bus) {
                  try {
                    const onTextLayer = (evt) => {
                      if (evt?.pageNumber !== pageNo) return
                      try { bus.off('textlayerrendered', onTextLayer) } catch { /* ignore */ }
                      // 已经被清掉或换成了别的闪块：不要再改
                      if (jumpFlashEl !== box) return
                      /**
                       * 重新定位：这里要重建块（可能从 1 块变 2 块），
                       * 所以直接重跑一次 flashJumpTarget，带上同一代。
                       * 它会先 clearJumpFlash 再画，语义干净。
                       */
                      flashJumpTarget(pageNo, offset, previewText, seq)
                    }
                    bus.on('textlayerrendered', onTextLayer)
                    // 兜底：页面始终没抛该事件时也别让监听常驻
                    setTimeout(() => { try { bus.off('textlayerrendered', onTextLayer) } catch { /* ignore */ } }, 3000)
                  } catch { /* 事件总线不可用就保持估算 */ }
                }

                // 先让它可见一拍，再加淡出属性，保证 transition 真的跑起来
                jumpFlashTimer = setTimeout(() => {
                  // 多块要一起淡出，否则除了第一行其余会「啪」地消失
                  try {
                    box.setAttribute('data-fade', '1')
                    for (const el of jumpFlashExtraEls) el?.setAttribute?.('data-fade', '1')
                  } catch { /* ignore */ }
                  // 淡出结束再移除；多留 500ms 兜住 transition 的尾巴
                  jumpFlashTimer = setTimeout(() => { clearJumpFlash() }, 500)
                }, jumpFlashMs)
              } catch { /* 闪烁纯装饰，失败不影响跳转 */ }
            }

            const destVOffset = async (dest, pageNo) => {
              const kind = dest?.[1]?.name
              if (!kind) return null
              let y = null
              if (kind === 'XYZ') {
                // [2]=left [3]=top [4]=zoom，任一可为 null（"保持不变"）
                y = dest[3]
              } else if (kind === 'FitH' || kind === 'FitBH') {
                // [2]=top
                y = dest[2]
              } else if (kind === 'FitR') {
                /**
                 * [2..5] = left bottom right top，矩形框定。
                 * 取矩形**上边**（dest[5]）作为落点 —— 读者要看的是框住的
                 * 那段内容的首行，而不是它的底边。
                 */
                y = dest[5]
              } else {
                // Fit / FitB / FitV / FitBV：没有可用的纵向坐标
                return null
              }
              if (typeof y !== 'number' || !Number.isFinite(y)) return null
              try {
                const page = await pdfRef.current?.doc?.getPage(pageNo)
                const viewport = page?.getViewport?.({ scale: 1 })
                const height = viewport?.height
                if (!(typeof height === 'number' && height > 0)) return null
                // 夹在页内：y 超出页高（个别生成器会写反）时不至于滚到离谱位置
                const clamped = Math.min(height, Math.max(0, y))
                return Math.min(0.98, Math.max(0, (height - clamped) / height))
              } catch { return null }
            }

            const jumpToNamedDest = async (rawName) => {
              const pdfDocument = pdfRef.current?.doc
              if (!pdfDocument) {
                reportDiag({ event: 'link:dest-fail', name: rawName, reason: 'no-document' })
                return
              }
              /**
               * href 里的目标名是 URL 编码过的（LaTeX 生成的锚点常带括号、空格，
               * 会变成 %28、%20），而 PDF 的 Dests 字典里存的是原文。
               */
              let name = rawName
              try { name = decodeURIComponent(rawName) } catch { /* 名字里本就有裸 % 时按原样用 */ }
              try {
                let dest = await pdfDocument.getDestination(name)
                if (typeof dest === 'string') dest = await pdfDocument.getDestination(dest)
                if (!Array.isArray(dest) || dest.length === 0) {
                  reportDiag({ event: 'link:dest-fail', name, reason: 'no-dest' })
                  return
                }
                const destRef = dest[0]
                let pageIndex
                if (Number.isInteger(destRef)) {
                  pageIndex = destRef
                } else {
                  // 先用 pdf.js 自己的映射（纯本地，不跨 worker），没有再问
                  const cached = pdfDocument.cachedPageNumber?.(destRef)
                  pageIndex = Number.isInteger(cached) && cached > 0
                    ? cached - 1
                    : await pdfDocument.getPageIndex(destRef)
                }
                const pageNo = pageIndex + 1
                const pageCount = pdfDocument.numPages || 0
                if (!Number.isInteger(pageIndex) || pageIndex < 0 ||
                    (pageCount > 0 && pageNo > pageCount)) {
                  reportDiag({ event: 'link:dest-fail', name, reason: 'bad-page', page: pageNo, pages: pageCount })
                  return
                }
                /**
                 * **跳转前压栈**（PDF 内链接 → 具名目标，如 LaTeX 的 `#eq1`）。
                 *
                 * 位置必须取在下面那次 `viewer.currentPageNumber = pageNo` **之前** ——
                 * 一旦页码被改写，量到的就是目标的页顶，历史里存的全是「刚跳到的地方」，
                 * 点返回等于原地不动。pushHop 内部读的是 visiblePageRef，
                 * 它与 currentPageNumber 同步，所以在改写之前调用才拿到真正的「跳转前」。
                 */
                pushHop()
                try {
                  viewer.currentPageNumber = pageNo
                  viewer.update?.()
                  setVisiblePage(pageNo)
                  setJumpPage(pageNo)
                } catch { /* 页视图未建好时赋值会被丢弃，下面滚动兜住 */ }
                /**
                 * 纵向落点：不再固定传 0。原来那一句
                 * `scrollPageIntoView(host, pageNo, 0)` 把 dest 里的坐标整个丢掉，
                 * 于是永远停在页首 —— 页号是对的、位置是错的，用户看到的就是
                 * 「跳转了但目标位置不对」。日志里 scrolled:true 也掩盖了这一点：
                 * 它只说明「滚动生效了」，不说明「滚到了该去的地方」。
                 */
                const offset = await destVOffset(dest, pageNo)
                const scrolled = scrollPageIntoView(host, pageNo, offset ?? 0)
                /**
                 * 落点闪烁：取一次该目标的预览文字，用它去对齐文本层里的
                 * 那一行；取不到就用 offset 估一条横条。纯装饰，失败不影响跳转。
                 */
                const flashText = await extractDestPreview(dest, pageNo)
                flashJumpTarget(pageNo, offset ?? 0, flashText)
                reportDiag({
                  event: 'link:dest',
                  name,
                  page: pageNo,
                  destKind: dest?.[1]?.name ?? null,
                  destY: dest?.[1]?.name === 'XYZ' ? dest[3] : (dest?.[1]?.name?.startsWith('FitH') ? dest[2] : null),
                  offset: offset ?? 0,
                  scrolled,
                  preview: flashText ? flashText.slice(0, 60) : null,
                })
              } catch (e) {
                /**
                 * 不再空吞：命名目标解析失败正是「点了没反应」的主要来源，
                 * 而空 catch 让这件事在日志里完全隐形。
                 */
                reportDiag({ event: 'link:dest-fail', name, reason: 'throw', message: String(e?.message ?? e) })
              }
            }

            let linkTip = null
            /**
             * 浮窗内的滚轮处理：滚 `.zr-tip-shot`（唯一可滚容器）。
             *
             * **只在真的能滚时才阻止默认行为。**
             *
             * 原来是无条件 `preventDefault()`：纯文字浮窗根本没有
             * `.zr-tip-shot`（或内容没溢出），滚轮照样被吞掉，用户在浮窗上
             * 滚滚不动、背后的 PDF 也滚不动 —— 那就是「滚轮失效」。
             * 所以先把可滚性算出来，不能滚就直接放行，让事件照常传给 PDF。
             */
            const onTipWheel = (event) => {
              let scrolled = false
              try {
                const shot = linkTip?.querySelector?.('.zr-tip-shot')
                if (shot) {
                  const maxTop = shot.scrollHeight - shot.clientHeight
                  if (maxTop > 0) {
                    scrolled = true
                    shot.scrollTop += event.deltaY
                    if (shot.scrollTop <= 0 || shot.scrollTop >= maxTop) {
                      shot.scrollTop = Math.max(0, Math.min(maxTop, shot.scrollTop))
                    }
                  }
                }
              } catch { /* ignore */ }
              // 这一下确实滚动了浮窗内容：拦住冒泡与默认滚动链，避免带动 PDF
              if (scrolled) {
                event.stopPropagation()
                event.preventDefault()
              }
              // 不能滚：完全不干预，让滚轮正常作用于背后的 PDF
            }


            const ensureTip = () => {
              if (linkTip && linkTip.isConnected) return linkTip
              linkTip = document.createElement('div')
              linkTip.className = 'zr-link-tip'
              linkTip.setAttribute('data-on', '0')
              /**
               * **浮窗参与 0.3s 消失判定。**
               *
               * 用户澄清的语义：「光标不落在悬浮窗以及超链接上连续超过
               * 0.3s 关闭」。所以移进浮窗要取消消失，移出去要重排消失。
               */
              linkTip.addEventListener('mouseenter', () => { cancelHideTip() })
              linkTip.addEventListener('mouseleave', () => { scheduleHideTip() })
              /**
               * **滚轮只滚浮窗，不穿透到背后的 PDF。**
               *
               * 这就是用户说的「悬浮窗外的页面不能被移动」的真实含义：
               * 他要在浮窗里滑动看图，但背后的 PDF 不能跟着滚。
               *
               * 三个要点：
               *   · 必须 `passive:false` —— passive 监听里 preventDefault 无效。
               *   · 必须用**原生** addEventListener：React 17+ 把 wheel
               *     注册在根节点且是 passive 的，`preventDefault` 不生效
               *     （本项目在滚轮缩放那段已经踩过这个坑）。
               *   · stopPropagation 挡住冒泡，preventDefault 再断掉浏览器的
               *     默认滚动链，两层都要。
               */
              linkTip.addEventListener('wheel', onTipWheel, { passive: false })
              document.body.appendChild(linkTip)
              return linkTip
            }

            /** 悬停延时句柄；0 表示没有待执行的悬停。 */
            let linkTipTimer = 0
            /** 当前悬停的那条链接，用于 mouseover 冒泡去重。 */
            let linkTipAnchor = null
            /**
             * **上一次真正做过横向定位的锚点。**
             *
             * 为什么不能直接用 `linkTipAnchor` 判断「换链接」：
             * 它在 `onPdfLinkOver` 里于 500ms 延时**之前**就更新了，
             * 等延时到点执行时它早已指向新链接，分不出「换了链接」
             * 和「同一个链接的位图异步回流」。
             *
             * 这个变量只在**写完 left/width 之后**赋值，所以它精确表示
             * 「DOM 上现在这个位置是为谁摆的」。相邻引用之间移动鼠标时
             * （`(Anderson, 1983; Lerner, 2012)`），`cancelHideTip` 让
             * `data-on` 保持 '1'，但锚点已经变了 —— 靠它能识别出来，
             * 从而强制重算横向。这正是用户报「所有引用的 x 都一样」的根因。
             */
            let tipPlacedAnchor = null
            /** 自动隐藏句柄（只有告警用）。 */
            let linkWarnTimer = 0
            /**
             * **延迟消失句柄（0.3s）。**
             *
             * 鼠标离开后不立刻隐藏，而是等 0.3s：这段时间里从链接划到
             * 浮窗里滚动看内容、或回头再看一眼，浮窗都不会闪。
             *
             * **链接与浮窗都算「在里面」**（用户澄清过的语义：光标不落在
             * 悬浮窗以及超链接上连续超过 0.3s 才关闭）。所以两侧事件都参与：
             * 链接 mouseout / 浮窗 mouseleave → 排消失；
             * 链接 mouseover / 浮窗 mouseenter → 取消。
             * 这要求浮窗 `pointer-events:auto`（见 CSS 里那段说明）。
             */
            let linkHideTimer = 0
            const cancelHideTip = () => {
              if (linkHideTimer) { clearTimeout(linkHideTimer); linkHideTimer = 0 }
            }

            /**
             * 统一的提示写入与定位。
             *
             * `anchor` 为 null 时居中显示 —— 外部链接被宿主拒掉时没有可锚定的位置
             * （那一刻鼠标可能已经移开），居中比跟着旧矩形更稳。
             */
            const hideLinkTip = () => {
              if (linkTipTimer) { clearTimeout(linkTipTimer); linkTipTimer = 0 }
              if (linkWarnTimer) { clearTimeout(linkWarnTimer); linkWarnTimer = 0 }
              cancelHideTip()
              linkTipAnchor = null
              // 复位「已定位给谁」：下次弹出必须重新算横向
              tipPlacedAnchor = null
              // 位图槽位的加载态也一并复位，下次悬停重新开始
              try {
                const shot = linkTip?.querySelector?.('.zr-tip-shot')
                if (shot) shot.removeAttribute('data-loading')
              } catch { /* ignore */ }
              if (linkTip) linkTip.setAttribute('data-on', '0')
            }

            /**
             * 0.3 秒后隐藏 —— 期间若鼠标回到链接或浮窗上会被 cancelHideTip 取消。
             * 必须声明在 hideLinkTip 之后（它引用了它）。
             *
             * 原为 500ms，用户实测后要求缩短到 0.3s：浮窗是预览，
             * 停留太久反而挡视线。
             */
            const scheduleHideTip = () => {
              cancelHideTip()
              linkHideTimer = setTimeout(() => {
                linkHideTimer = 0
                hideLinkTip()
              }, 300)
            }

            /**
             * 把「行描述」渲染进提示卡片。
             *
             * 每一行是 `{ kind, text }`，kind 决定样式类：
             *   title（主行）/ line（文献信息）/ link（DOI、URL）/ dim（目标名这类次要信息）
             *
             * **全部用 createElement + textContent**，绝不拼 innerHTML：
             * PDF 里的链接文字、目标名、URL 都是不可信输入，
             * 一个 `#cite.<img onerror=...>` 就能在插件上下文里执行脚本。
             * textContent 只当文本，天然免疫。
             */
            const renderTipLines = (tip, lines) => {
              tip.textContent = ''
              for (const row of lines) {
                if (!row || !row.text) continue
                const div = document.createElement('div')
                div.className = row.kind === 'title'
                  ? 'zr-tip-title'
                  : row.kind === 'link'
                    ? 'zr-tip-link'
                    : row.kind === 'dim'
                      ? 'zr-tip-dim'
                      : 'zr-tip-line'
                div.textContent = String(row.text)
                tip.appendChild(div)
              }
            }

            /**
             * **浮窗尺寸：唯一一处计算 popupW / popupH。**
             *
             * 用户要的尺寸是「页面 CSS 宽 × 0.9、页面 CSS 高 × 0.3」——
             * 实测页面 700×991 时是 630×297。
             *
             * 之前同一个数被算了两遍：显示层按 0.9×页宽 摆浮窗，
             * 渲染层按 `POPUP_MAX_W`（innerWidth×0.9 夹 1240）渲 canvas ——
             * 日志里 `canvasCssW=1240` 而 `popupW=630`，canvas 被
             * `max-width:100%` 压扁一半；高度则是 879 渲染、780 显示，
             * 底部 99px 被裁。根因不是夹取写错，而是**几何有两套**。
             *
             * 现在只在这里算一次，`showLinkTip` / `placeHorizontal` /
             * 渲染器全部吃这一个结果。任何地方都不许再按页面宽高另算。
             *
             * 拿不到 `.page` 矩形时退回固定量级（630×297，与实测同阶），
             * 仍然只算这一次。
             *
             * @returns {{popupW:number, popupH:number, pageRectW:number|null, pageRectH:number|null}}
             */
            const computePopupSize = (anchor) => {
              let pageRect = null
              try {
                pageRect = anchor?.closest?.('.page')?.getBoundingClientRect?.() ?? null
                if (!pageRect || !(pageRect.width > 0) || !(pageRect.height > 0)) {
                  // 链接不在页元素里（或页面还没布局）：退回同页的第一个 .page
                  const anyPage = host?.querySelector?.('.page')
                  pageRect = anyPage?.getBoundingClientRect?.() ?? null
                  if (!pageRect || !(pageRect.width > 0) || !(pageRect.height > 0)) pageRect = null
                }
              } catch { /* 取不到就退回固定量级 */ }
              const viewportW = window.innerWidth
              const viewportH = window.innerHeight
              let popupW
              let popupH
              if (pageRect) {
                popupW = Math.round(pageRect.width * 0.9)
                popupH = Math.round(pageRect.height * 0.3)
              } else {
                popupW = Math.round(Math.min(630, viewportW - 16))
                popupH = Math.round(Math.min(297, viewportH * 0.3))
              }
              // 只做视口兜底，不改比例：正常页面下这两句不会生效
              popupW = Math.max(160, Math.min(popupW, viewportW - 16))
              popupH = Math.max(120, Math.min(popupH, viewportH - 16))
              return {
                popupW,
                popupH,
                pageRectW: pageRect ? Math.round(pageRect.width) : null,
                pageRectH: pageRect ? Math.round(pageRect.height) : null,
              }
            }

            /**
             * 把 canvas 放进浮窗的位图槽位。
             *
             * 槽位始终存在（固定顺序：位图在上、文字在下），
             * 这样异步位图到达时不用重排整张卡片，滚动位置也不会跳。
             *
             * 整页位图 + 容器限高之后**必须主动定位**：否则用户看到的是
             * 页首，目标可能在页面中下部，得自己找。这里按锚点的页内比例
             * 把 scrollTop 滚过去，让目标落在可见区靠上的位置。
             *
             * @param {number} [anchorRatio] 锚点在页内的比例（0..1，从顶部算）
             */
            const putTipBitmap = (tip, canvas, anchorRatio, popupH) => {
              let shot = tip.querySelector('.zr-tip-shot')
              if (!shot) {
                shot = document.createElement('div')
                shot.className = 'zr-tip-shot'
                tip.insertBefore(shot, tip.firstChild)
              }
              shot.textContent = ''
              shot.removeAttribute('data-loading')
              /**
               * **位图槽的高度 = 浮窗高度（popupH），用行内值固定住。**
               *
               * 不设高度时槽会被整页内容撑到 892px，而外层浮窗 maxHeight
               * 只有 297px 且 overflow:hidden —— 槽的滚动视口是 892px，
               * 真正露出来的却只有顶上 297px，`scrollTop` 就按错的视口算，
               * 表现是「滚一下直接跳到底」或者「怎么滚都看不到底部」。
               *
               * 固定成 297px 之后，滚动视口与可见窗口是同一个数，
               * `scrollHeight - clientHeight` 才是真实的剩余可滚距离。
               * 外层被 computeTipPlacement 收窄时（视口太矮）取两者较小值，
               * 不让槽比浮窗还高。
               */
              const tipCap = parseFloat(tip.style.maxHeight) || 0
              const shotH = Number(popupH) > 0
                ? Math.round(tipCap > 0 ? Math.min(Number(popupH), tipCap) : Number(popupH))
                : 0
              if (shotH > 0) shot.style.height = `${shotH}px`
              if (canvas) shot.appendChild(canvas)
              /**
               * **canvas 宽度扣掉纵向滚动条的占位。**
               *
               * 实测 `shotClientW=706` 而 `shotScrollW=711`：槽高固定成
               * popupH 后内容必然纵向溢出，浏览器给槽加一条纵向滚动条，
               * 内容框因此比 `popupW` 窄 5px。canvas 仍按 popupW 排，
               * 就在窄 5px 的框里横向溢出 —— 虽然 `overflow-x:hidden`
               * 已经把横向滚动条去掉了，但页面右缘那 5px 会被裁掉。
               *
               * 这里在**内容已入槽、滚动条已产生**之后量一次实际内容宽度，
               * 按它重设 canvas 的显示宽度。高度同比缩放，保持页面比例。
               *
               * 顺序很关键：必须 append 之后再量，否则滚动条还没出现，
               * `clientWidth` 还是满宽，量不到这 5px。
               */
              if (canvas && shot.clientWidth > 0) {
                try {
                  const contentW = shot.clientWidth
                  const cssW = parseFloat(canvas.style.width) || 0
                  if (contentW > 0 && cssW > 0 && Math.abs(contentW - cssW) > 0.5) {
                    const ratio = contentW / cssW
                    const cssH = parseFloat(canvas.style.height) || 0
                    canvas.style.width = `${Math.round(contentW)}px`
                    if (cssH > 0) canvas.style.height = `${Math.round(cssH * ratio)}px`
                  }
                } catch { /* 量不到就保持原尺寸 */ }
              }
              /**
               * 把目标滚到可见区偏上（留 18% 的上下文在上方），
               * 并夹在可滚范围内。
               */
              if (typeof anchorRatio === 'number' && Number.isFinite(anchorRatio)) {
                const maxTop = Math.max(0, shot.scrollHeight - shot.clientHeight)
                if (maxTop > 0) {
                  const ratio = Math.min(0.98, Math.max(0, anchorRatio))
                  const wanted = shot.scrollHeight * ratio - shot.clientHeight * 0.33
                  shot.scrollTop = Math.max(0, Math.min(maxTop, wanted))
                }
              }
              return shot
            }

            /**
             * @param {string|Array<{kind?:string,text:string}>} lines 纯文本或行描述数组
             * @param {HTMLElement|null} anchor 锚定元素；null 表示居中
             * @param {{bitmap?: boolean}} [opts] bitmap: 预留位图槽位（加载态）
             */

            /**
             * **决定浮窗放上方还是下方，并按该侧的可用空间给出高度与 top。**
             *
             * 这个函数把「放哪边」和「多高」合成**同一次决策**，这是修
             * 「浮窗盖住超链接」的关键。
             *
             * 之前两者是分开算的，规则相互矛盾：
             *   · `computeTipTop` 优先放**上方**（上方够就放上面）
             *   · `computeTipMaxH` 却按 `Math.max(上方空间, 下方空间)` 取高度
             * 于是「下方空间更大」时，高度按下方算出来（例如 420px），
             * 位置却按上方摆 —— 浮窗从上往下铺 420px，底边必然压过链接。
             * 用户截图里正是这个现象：浮窗很大，下缘盖住了 `Figure 5`。
             *
             * 现在一次算清：
             *   1. 上方放得下（`above >= 所需高度` 或上方空间 >= 下方）就放上方
             *   2. 否则放下方
             *   3. 高度上限 = 该侧全部可用空间（上方留 gap 到视口顶，
             *      下方留 gap 到视口底），再夹上下限
             * 这样 top 与高度必然自洽 —— 浮窗底边不会越过链接的上沿。
             *
             * 用户给的模型就是这样：取链接矩形 (x1,y1,x2,y2)，
             * 放上方则浮窗**底边 = y1 - gap**，放下方则**顶边 = y2 + gap**。
             *
             * @param {HTMLElement|null} anchor 链接元素
             * @param {number} desiredH 期望高度（位图用上限，文字用实际高度）
             * @returns {{top: number, height: number}}
             */
            const computeTipPlacement = (anchor, desiredH, isBitmap = false) => {
              const gap = 20
              const viewportH = window.innerHeight
              /**
               * 文字浮窗的可用下限与位图不同。
               *
               * 120 是为**位图**定的：位图区太小就看不清内容。
               * 但文字预览本来就可能只有一两行（实测 `cite.anderson1983`
               * 的内容高度只有 45px），强行抬到 120 会让卡片底部留出一大块
               * 空白，视觉上像“浮窗飘在远离链接的地方”——用户就是这么报的。
               *
               * 所以文字类型退到 48：足够放下两行正文 + 一行页码，且不会
               * 比内容高出太多。实测那几条引用正好落在 45~64px 区间。
               */
              const MIN_H_BITMAP = 120
              const MIN_H_TEXT = 48
              // 下限按类型取：位图要够看清，文字贴着内容即可
              const MIN_H = isBitmap ? MIN_H_BITMAP : MIN_H_TEXT
              /**
               * 高度天花板。
               *
               * 原来是 `min(46vh, 420px)` —— 420 太保守，一篇双栏论文的
               * figure 连图注一起看时明显不够，用户反馈「窗口太小了」。
               *
               * 现在放到 `min(80vh, 780px)`：占视口八成、上限 780。
               * 上限仍要给，否则在超宽屏上浮窗会高到半页都是它；
               * 真正能放多高由 `computeTipPlacement` 按链接上下可用空间
               * 再收一次，所以这个值只决定「空间充足时的最大尺寸」。
               *
               * **必须与 `computeBitmapGeometry` 的夹取上限同一个常量。**
               * 两处各写一遍就会分叉：实测 #fig8 的 geo.popupH 被夹到 879
               * 渲染 canvas，而这里又夹到 780 → canvas 底部 99px 被裁掉，
               * geoConsistent=false。
               */
              const hardCap = bitmapHeightCap()
              if (!anchor) {
                const height = Math.min(desiredH || hardCap, hardCap)
                return { top: 56, height }
              }
              let r
              try {
                r = anchor.getBoundingClientRect()
              } catch {
                const height = Math.min(desiredH || hardCap, hardCap)
                return { top: 56, height }
              }
              /**
               * 两侧各自能容纳的高度。
               * 上方：从视口顶到链接上沿，留出 gap；
               * 下方：从链接下沿到视口底，留出 gap。
               */
              const roomAbove = Math.max(0, r.top - gap - 8)
              const roomBelow = Math.max(0, viewportH - r.bottom - gap - 8)
              const want = Math.min(desiredH || hardCap, hardCap)

              /**
               * **位图类型允许盖住链接本身，换更大的显示面积。**
               *
               * 实测 `#fig1`：链接在视口下半部（linkTop=539、视口 999），
               * 上方只剩 511px，于是浮窗被收窄到 511——用户反馈「高度还是
               * 不够」。但位图的目标是 figure/公式，链接只是图注里的
               * 几个字（实测 linkW 仅 37px、linkH 12px），盖住它几乎无感，
               * 而多出来的画面面积价值更大。
               *
               * 文字预览相反：它本身就小（45~64px），而且用户要读的正是
               * 链接附近的内容，盖住链接会直接影响阅读，所以仍严格避开。
               *
               * 允许覆盖时按「整屏可用高度」算，只留 8px 边距。
               */
              const mayCover = isBitmap
              if (mayCover) {
                /**
                 * 位图：高度取「整个视口能给的全部」，不再被链接上沿截断。
                 * 位置仍尽量放在上方，实在放不下就贴顶 —— 宁可盖住链接
                 * 那一行几个字，也要让 figure 看清。
                 */
                const height = Math.max(MIN_H, Math.min(want, viewportH - 16))
                const idealTop = r.top - gap - height
                const top = Math.max(8, Math.min(idealTop, viewportH - height - 8))
                return { top, height }
              }

              /**
               * 选边：优先上方。上方装得下想要的高度就放上方；
               * 装不下但上方空间仍比下方大，也放上方（收窄高度即可）；
               * 否则放下方。
               */
              const preferAbove = roomAbove >= want || roomAbove >= roomBelow
              if (preferAbove) {
                const height = Math.max(MIN_H, Math.min(want, roomAbove))
                // 底边正好贴在链接上沿上方 gap 处
                let top = r.top - gap - height
                top = Math.max(8, top)
                return { top, height }
              }
              const height = Math.max(MIN_H, Math.min(want, roomBelow))
              // 顶边正好在链接下沿下方 gap 处
              let top = r.bottom + gap
              // 越界时上顶，但不越过链接上沿
              const maxTop = viewportH - height - 8
              if (top > maxTop) top = Math.max(r.bottom + gap, maxTop)
              top = Math.min(top, maxTop)
              return { top: Math.max(8, top), height }
            }
            /**
             * **横向定位：算出浮窗的 left 与 width 并写进 DOM。**
             *
             * 抽成函数是因为它要跑两次：首次弹出、以及**换了链接时的回流**
             * （相邻引用之间移动鼠标，`data-on` 仍为 '1' 但锚点已变）。
             *
             * 规则（用户多轮反馈定下来的）：
             *   · 位图：宽 0.9×页宽，**居中于页面**（figure 常跨栏/居中，
             *     跟随链接 x 会让同一张图在不同链接位置弹在不同地方）。
             *   · 文字：宽约**一栏**，**以链接中心为中心**对齐。
             *     早先「左边界对齐链接」，但右侧引用会被视口 clamp
             *     全部压到同一个 x —— 这正是用户报的 bug。
             *
             * 写完 left/width 后记 `tipPlacedAnchor`，表示「这个位置是为谁摆的」。
             *
             * @returns {{left:number,width:number,path:string}}
             */
            const placeHorizontal = (tip, anchor, opts) => {
              let pageRect = null
              try {
                const linkPage = anchor?.closest?.('.page')
                pageRect = linkPage?.getBoundingClientRect?.() ?? null
                if (!pageRect || !(pageRect.width > 0)) {
                  const anyPage = host?.querySelector?.('.page')
                  pageRect = anyPage?.getBoundingClientRect?.() ?? null
                }
              } catch { /* 取不到就退回视口居中 */ }

              const isBitmap = Boolean(opts?.bitmap)
              let left
              let targetW
              if (isBitmap) {
                /**
                 * **位图宽度只能来自 `opts.popupW`（单一几何源）。**
                 *
                 * 宽度由 `computePopupSize` 按「0.9 × 页面 CSS 宽」算一次，
                 * 一路透传给渲染与摆放。这里不再自算，也不再兜底重算 ——
                 * 兜底就是分叉的起点。之前正是两套几何：canvas 按
                 * `POPUP_MAX_W = min(innerWidth×0.9, 1240)` 渲染，浮窗按
                 * 0.9×页宽 摆放，实测 `canvasCssW=1240` 而 `popupW=630`，
                 * canvas 被 `max-width:100%` 压扁一半，看起来又扁又小。
                 */
                const popupW = Number(opts?.popupW)
                if (!(popupW > 0)) return null
                targetW = Math.min(popupW, window.innerWidth - 16)
                targetW = Math.max(160, targetW)
                /**
                 * 位置：居中于**页面**（figure 通常跨栏/居中），
                 * 而不是跟随链接 x。
                 */
                const pageCenter = pageRect && pageRect.width > 0
                  ? (pageRect.left + pageRect.right) / 2
                  : window.innerWidth / 2
                left = pageCenter - targetW / 2
              } else {
                /**
                 * 文字：宽度 = **3/7 页面宽**，居中于链接。
                 *
                 * 用户先说要「1/2 栏」，我按 column 理解做了栏宽测量；
                 * 后来他澄清「这里我说错了，就是 1/2 页面大，不过我改主意了，
                 * 改成 3/7 页面吧」。所以删掉 measureColumnWidth，
                 * 直接按页宽比例算 —— 3/7 ≈ 0.4286，比半页略窄。
                 *
                 * 取不到页面矩形时退回视口宽的三分之一（量级相当），
                 * 保证两条路径不会差出很多。
                 */
                const baseW = pageRect && pageRect.width > 0 ? pageRect.width : window.innerWidth
                targetW = baseW * (3 / 7)
                // 保底不窄到放不下一行字，同时夹进视口
                targetW = Math.max(160, Math.min(targetW, window.innerWidth - 16))
                /**
                 * 以**链接中心**为中心，而不是左边界对齐。
                 * 这样相邻引用（x 各不相同）会弹在各自的位置，
                 * 不会因为右侧 clamp 被压到同一个值。
                 */
                let centerX = window.innerWidth / 2
                try {
                  if (anchor) {
                    const ar = anchor.getBoundingClientRect()
                    centerX = (ar.left + ar.right) / 2
                  } else if (pageRect && pageRect.width > 0) {
                    centerX = (pageRect.left + pageRect.right) / 2
                  }
                } catch { /* 用视口中心 */ }
                left = centerX - targetW / 2
              }
              // 夹进视口（只是保底，正常情况下不会触发）
              left = Math.max(8, Math.min(left, window.innerWidth - targetW - 8))
              tip.style.right = 'auto'
              tip.style.left = `${Math.round(left)}px`
              tip.style.width = `${Math.round(targetW)}px`
              /**
               * **写完 DOM 之后再夹一次。**
               *
               * 用户截图里浮窗左侧被裁出屏幕，但日志 `left=924`、
               * `tipW=630`、`viewportW=1601` 数学上没超 —— 说明
               * **实际渲染宽度与 targetW 不一致**（canvas 比 targetW 宽时
               * 会把浮窗撑开），于是 left 得按真实宽度重算。
               *
               * 读一次真实矩形，若越界就用实际宽度重新夹并写回。
               */
              try {
                const real = tip.getBoundingClientRect()
                if (real.width > 0) {
                  const clampedLeft = Math.max(8, Math.min(
                    parseFloat(tip.style.left) || left,
                    window.innerWidth - real.width - 8,
                  ))
                  if (Math.abs(clampedLeft - (parseFloat(tip.style.left) || left)) > 0.5) {
                    tip.style.left = `${Math.round(clampedLeft)}px`
                    left = clampedLeft
                  }
                  // 记录真实宽度（可能被 canvas 撑开），诊断用它
                  targetW = real.width
                }
              } catch { /* 量不到就用理论值 */ }
              /**
               * 记下「这个横向位置是为谁摆的」。换了链接时靠它识别回流。
               */
              tipPlacedAnchor = anchor || null
              return { left, width: targetW }
            }

            /**
             * **定位诊断（统一出口）。**
             *
             * 上一轮 `tip:place` 只记了 `linkLeft`（链接自身），没记浮窗最终
             * 写入的 left/width，导致误判「x 已经跟随链接变化」——
             * 实际 DOM 上 left 只在第一次写过。所以这里必须同时记
             * 链接矩形与浮窗矩形，并标明走的是哪条路径（首次 / 同位图回流 / 换链接回流）。
             */
            const reportTipPlace = (anchor, placed, opts, path, horiz, desiredHValue, tipEl) => {
              if (!anchor) return
              try {
                const ar = anchor.getBoundingClientRect()
                reportDiag({
                  event: 'tip:place',
                  href: (anchor.getAttribute('href') || '').slice(0, 60),
                  path,
                  linkTop: Math.round(ar.top),
                  linkBottom: Math.round(ar.bottom),
                  linkLeft: Math.round(ar.left),
                  linkW: Math.round(ar.width),
                  linkH: Math.round(ar.height),
                  /**
                   * `desiredH` 是**调用方传进来的真实期望高度**。
                   *
                   * 原来这里写成 `placed && placed.height`，而
                   * computeTipPlacement 只返回 {top,height}、没有 desiredH，
                   * 于是这一行恒等于 chosenH，完全没有信息量 ——
                   * 看不出「想要多少」和「实际给了多少」的差。
                   */
                  desiredH: typeof desiredHValue === 'number' ? Math.round(desiredHValue) : null,
                  chosenH: placed ? Math.round(placed.height) : null,
                  chosenTop: placed ? Math.round(placed.top) : null,
                  /**
                   * 浮窗最终值：优先用本次写入的结果；没有就**读 DOM 实际值**。
                   *
                   * 日志里 `reflow` 路径一片 `left:null, tipW:null`，
                   * 就是因为没传 horiz 时不兜底 —— 那等于回流过程完全不可核对。
                   */
                  left: (() => {
                    if (horiz && typeof horiz.left === 'number') return Math.round(horiz.left)
                    try { return Math.round(tipEl.getBoundingClientRect().left) } catch { return null }
                  })(),
                  tipW: (() => {
                    if (horiz && typeof horiz.width === 'number') return Math.round(horiz.width)
                    try { return Math.round(tipEl.getBoundingClientRect().width) } catch { return null }
                  })(),
                  viewportW: Math.round(window.innerWidth),
                  viewportH: Math.round(window.innerHeight),
                  bitmap: Boolean(opts?.bitmap),
                })
              } catch { /* 诊断失败不影响定位 */ }
            }
            const showLinkTip = (lines, anchor, autoHideMs = 0, warn = false, opts = null) => {
              const tip = ensureTip()
              /**
               * **弹出后位置就固定。**
               *
               * 位图是异步来的，到位后会再调一次这个函数补内容。
               * 如果每次都重新算位置，卡片会「跳」一下 —— 尤其鼠标这时
               * 可能已经移到浮窗上，重算会把它挪走。
               *
               * 所以只有**首次弹出**（当前不在显示状态）才定位；
               * 已经显示时只更新内容、保留原来的 left/top。
               */
              const wasOn = tip.getAttribute('data-on') === '1'
              if (typeof lines === 'string') renderTipLines(tip, [{ kind: 'title', text: lines }])
              else renderTipLines(tip, Array.isArray(lines) ? lines : [])
              tip.setAttribute('data-warn', warn ? '1' : '0')
              /**
               * 位图槽位：需要时先放一个加载态占位。
               *
               * 为什么要占位而不是等位图到了再插：不占位的话卡片会先按
               * 文字高度定位，位图一进来整块往下长，浮窗会「跳」一下；
               * 而且定位用错了高度就可能顶出视口。
               */
              if (opts?.bitmap) {
                const shot = putTipBitmap(tip, null)
                shot.setAttribute('data-loading', '1')
              }
              if (wasOn) {
                /**
                 * **已在显示：按新内容的高度重算纵向；换了链接还要重算横向。**
                 *
                 * 这里分两种情况，之前的代码把它们混成了一种：
                 *
                 *   ① **同一个锚点的异步回流**（位图到位后补内容）：
                 *      横向保持不动，只按实际高度重排纵向 —— 否则鼠标移进
                 *      浮窗时卡片会左右/上下乱跳。
                 *
                 *   ② **换了链接**（相邻引用之间移动鼠标）：
                 *      必须连横向一起重算。用户报「参考文献的浮窗 x 所有引用
                 *      都一样」就是这个漏洞：`cancelHideTip` 让 `data-on`
                 *      保持 '1'，于是每次都走 wasOn 提前返回，left 永远是
                 *      第一条引用的值。
                 *
                 * 判据用 `tipPlacedAnchor` 而不是 `linkTipAnchor` ——
                 * 后者在 mouseover 时就提前更新了，区分不出这两种情况。
                 */
                const anchorChanged = Boolean(anchor) && anchor !== tipPlacedAnchor
                /**
                 * 本次实际写入的横向值（换链接时才有）。
                 * 诊断要用它，才能从日志看出 left 到底变没变。
                 */
                let horiz = null
                tip.style.visibility = ''
                if (anchor) {
                  /**
                   * **位图分支的 desiredH 必须用 popupH，绝不读 offsetHeight。**
                   *
                   * 实测日志把 780 打成 120 就是这个：
                   *   path:"fresh"  chosenH:297   ← 首次按 popupH（0.3×页高）算的
                   *   path:"reflow" chosenH:120   ← 6ms 后按 offsetHeight 重算
                   * 位图刚插入时 `tip.offsetHeight` 还是占位态的高度（96~120），
                   * 用它当 desiredH，`computeTipPlacement` 就按它收窄，
                   * 位图到位后反而把浮窗压成 120 —— 用户说的「高度只有现在的 1/3」。
                   *
                   * 文字浮窗内容已经排好，offsetHeight 是可靠的，仍用它。
                   */
                  tip.style.maxHeight = 'none'
                  const actualH = opts?.bitmap
                    ? (Number(opts?.popupH) > 0 ? Number(opts.popupH) : (tip.offsetHeight || 120))
                    : (tip.offsetHeight || 120)
                  const placed = computeTipPlacement(anchor, actualH, Boolean(opts?.bitmap))
                  tip.style.maxHeight = `${Math.round(placed.height)}px`
                  tip.style.top = `${Math.round(placed.top)}px`
                  if (anchorChanged || opts?.bitmap) {
                    /**
                     * 换了链接 → 必须重算横向（相邻引用 x 各家不同）；
                     * 位图分支再走一次也安全：popupW 是同一个值，
                     * 写进去不会改变宽度，只是让 left 按真实宽度重新夹一次。
                     */
                    horiz = placeHorizontal(tip, anchor, opts)
                  }
                  reportTipPlace(anchor, placed, opts, anchorChanged ? 'reflow-moved' : 'reflow', horiz, actualH, tip)
                }
                cancelHideTip()
                if (linkWarnTimer) { clearTimeout(linkWarnTimer); linkWarnTimer = 0 }
                if (autoHideMs > 0) linkWarnTimer = setTimeout(() => hideLinkTip(), autoHideMs)
                return
              }
              /**
               * **定位：横向对齐正文页面，纵向跟着链接。**
               *
               * 用户的原话：「悬浮窗应该在超链接的上方，并且位置和正文页面
               * 在同个位置，而不是根据超链接的位置会左右移动」。
               *
               * 所以横坐标取**页面元素**（`.page[data-page-number]`）的
               * 左右边界，而不是链接自己的 x —— 同一页里不同 x 的链接
               * 会弹在完全相同的横向位置，像 Zotero 那样贴着版面走。
               * 纵向仍按链接算：优先在链接上方，上方不够就放下方。
               *
               * `getBoundingClientRect` 各读一次 —— 它会强制布局，
               * 而链接是刚画出来的，前面压着一大批没偿还的 DOM 写入。
               */
              /**
               * **纵向定位用「预估最终高度」，不是占位高度。**
               *
               * 这是用户报「窗口会覆盖住超链接」的根因：
               * 首次定位时位图槽位只有一个 min-height:96px 的占位，
               * 拿 tip.offsetHeight（≈96）算 top 会把浮窗摆在链接上方
               * 很远的位置；等真位图（几百 px）插进来，浮窗向下长出去，
               * 底边就盖住了链接本身。
               *
               * 位图浮窗按 `popupH`（0.3 × 页高）预估；文字浮窗内容已经排好了，
               * 直接用实际高度即可。
               */
              /**
               * **高度与位置必须由同一次决策给出**（见 computeTipPlacement
               * 的说明：分开算会因为「取较大一侧」与「优先上方」互相矛盾
               * 而导致浮窗压住链接）。
               *
               * 位图浮窗：期望高度取 popupH，实际由该侧可用空间收窄；
               * 文字浮窗：内容已排好，用实际高度，同样会被收窄。
               */
              /**
               * 期望高度。
               *
               * 位图浮窗：取 popupH，实际由该侧可用空间收窄。
               *
               * 文字浮窗：`tip.offsetHeight` 在这里读**是可靠的**——
               * renderTipLines 刚把内容写进 DOM，读取 offsetHeight 会强制
               * 一次同步布局，拿到的就是排好版的高度（浮窗此时只是
               * visibility:hidden，仍参与布局，不是 display:none）。
               * 若拿不到（首帧还没内容）退回一个保守值。
               */
              const desiredH = opts?.bitmap
                ? (Number(opts?.popupH) > 0 ? Number(opts.popupH) : bitmapHeightCap())
                : (tip.offsetHeight || 120)
              const placement = computeTipPlacement(anchor, desiredH, Boolean(opts?.bitmap))
              /**
               * 位图槽**不再单独设 maxHeight**。
               *
               * 尺寸已由 contain 一次算定（canvas 的 style 宽高），外层
               * `tip.style.maxHeight = placement.height` 是唯一的约束。
               * 再加一层内层 maxHeight 会出现「双层限制」：内层被截一次、
               * 外层再截一次，既可能切掉内容，也会让滚动条行为难以预测。
               *
               * `.zr-tip-shot` 仍保留 overflow:auto —— contain 之后通常
               * 不需要滚动，但区域比可视区大时（外扩后仍溢出）要能滚。
               */
              /**
               * **横向定宽定位（首次弹出路径）。**
               *
               * 具体规则见 `placeHorizontal` 的说明：位图 0.9×页宽居中，
               * 文字按**栏宽**并以**链接中心**对齐 —— 后者是用户报
               * 「所有引用 x 都一样」的修法（旧代码把左侧的链接左对齐 + 视口
               * clamp，右侧引用全被压成同一个值）。
               */
              let top
              const horiz = placeHorizontal(tip, anchor, opts)
              /**
               * 位图浮窗拿不到 popupW 就不显示 —— 说明几何算错了，
               * 与其画一个尺寸不对的框，不如让它明显失败。
               */
              if (opts?.bitmap && !horiz) {
                reportDiag({ event: 'tip:skip', reason: 'no-popupW' })
                return
              }
              /** 首次定位的诊断，与 wasOn 回流共用同一个出口 */
              reportTipPlace(anchor, placement, opts, 'fresh', horiz, desiredH, tip)
              /**
               * **纵向直接用 placement.top。**
               *
               * 不能再用 computeTipTop 重算：那个版本的判据是「上方够不够
               * 放 h」，而 h 已被 placement 按该侧可用空间收窄过，
               * 重算会绕开「底边贴链接上沿」这个约束。
               * placement 已经把放哪边、多高、top 一次算定。
               */
              top = placement.top
              tip.style.top = `${Math.round(top)}px`
              /**
               * **整体高度夹住，但外层不做滚动容器。**
               *
               * `placement.height` 要同时约束浮窗本身：不然 padding 与文字行
               * 会让实际高度超过它、向下溢出去盖住链接（`cite.anderson1983`
               * 那条就是这样）。
               *
               * 但 `overflow` 必须是 **hidden，不能是 auto**：
               * 位图槽 `.zr-tip-shot` 自己已经是 `overflow:auto`，
               * 两层都 auto 就会出现**两条并排的滚动条**，而且滚轮
               * 被 `onTipWheel` 转给内层，外层那条只能靠鼠标拖 ——
               * 正是用户报的「怎么有两个进度条，而且滑动只能互动一部分」。
               *
               * 位图浮窗的唯一滚动面是内层 `.zr-tip-shot`；外层只负责
               * 把整体高度卡住（hidden 顺带裁掉圆角溢出）。
               * 文字浮窗内容高度就是它自己的高度，本来不需要滚动。
               */
              tip.style.maxHeight = `${Math.round(placement.height)}px`
              tip.style.overflow = 'hidden'
              tip.setAttribute('data-on', '1')
              /**
               * 显示出来就说明鼠标在链接上（或刚离开但在 0.3s 窗口内），
               * 此时不该有挂起的消失任务。
               */
              cancelHideTip()
              if (linkWarnTimer) { clearTimeout(linkWarnTimer); linkWarnTimer = 0 }
              if (autoHideMs > 0) linkWarnTimer = setTimeout(() => hideLinkTip(), autoHideMs)
            }
            const onPdfLinkClick = (event) => {
              const anchor = event.target?.closest?.('a[href]')
              if (!anchor || !host.contains(anchor)) return
              const href = anchor.getAttribute('href') || ''
              if (!href) return
              // 点到了哪条链接：这是判断「没反应」卡在哪一层的唯一现场证据
              reportDiag({ event: 'link:click', itemKey, href: href.slice(0, 300) })

              // ---- 内部跳转：-#page=N 或 -#<具名目标> ----
              if (href.startsWith('#')) {
                event.preventDefault()
                event.stopPropagation()
                const pageMatch = /^#page=(\d+)/i.exec(href)
                if (pageMatch) {
                  const n = Number(pageMatch[1])
                  if (Number.isFinite(n) && n > 0) {
                    /**
                     * **跳转前压栈**（PDF 内链接 → `#page=N`）。
                     * 同 jumpToNamedDest：必须早于 currentPageNumber 的改写，
                     * 否则记下的是目标位置而不是「原来的位置」。
                     */
                    pushHop()
                    try {
                      viewer.currentPageNumber = n
                      viewer.update?.()
                      setVisiblePage(n)
                      setJumpPage(n)
                    } catch { /* 页视图未建好时赋值会被丢弃，下面滚动兜住 */ }
                    scrollPageIntoView(host, n, 0)
                  }
                  return
                }
                /**
                 * 具名目标（PDF 里的命名 dest，LaTeX 的 \label 就落在这里）：
                 * 见上面 jumpToNamedDest 的说明 —— 不再走不存在的 linkService.navigateTo。
                 */
                void jumpToNamedDest(href.slice(1))
                return
              }

              // ---- 外部链接：开系统浏览器，绝不在这里导航 ----
              if (/^(https?|mailto|tel):/i.test(href)) {
                event.preventDefault()
                event.stopPropagation()
                try {
                  /**
                   * `_blank` + noopener：让宿主按 setWindowOpenHandler 处理。
                   *
                   * 宿主的实际规则（已从 app.asar 里确认）：
                   *   setWindowOpenHandler(({ url }) => {
                   *     if (destination.protocol === "https:" && !username && !password)
                   *       shell.openExternal(url)
                   *     return { action: "deny" }
                   *   })
                   *   will-navigate → 非本 origin 一律 preventDefault
                   *
                   * 两条都读过，结论是：
                   *   · https 链接 → 转交系统浏览器，正中预期
                   *   · http  / mailto / tel → 宿主直接 deny 且不转交，
                   *     点了仍然没反应（但至少不会把应用导航走）
                   *
                   * http 的情况无法在这里解决 —— 宿主只认 https，而我们没有
                   * shell 权限。悬停预览会显示完整地址，用户可手动复制打开。
                   * 实际 PDF 里的链接绝大多数是 https（DOI、期刊站），
                   * 老论文偶尔有 http，属于可接受的边界。
                   */
                  /**
                   * **不能带 `noopener` / `noreferrer`。**
                   *
                   * 按 HTML 规范，window.open 的 features 里出现这两个之一时，
                   * 实现必须返回 null（新窗口的 WindowProxy 不可暴露）。
                   * 原来那句 `'noopener,noreferrer'` 于是让返回值恒为 null，
                   * 下面 `blocked: !opened` 就成了永远为真的假信号 ——
                   * 日志里看着像「宿主每次都拦」，实际可能一次都没拦。
                   *
                   * 去掉之后拿到真实返回值，blocked 才有判读价值。
                   * 安全性在这里不受影响：打开的是用户主动点击的外部链接，
                   * 且宿主 setWindowOpenHandler 一律返回 { action: "deny" }
                   * （见上面那段规则），根本不会真的在当前页导航。
                   */
                  const opened = window.open(href, '_blank')
                  /**
                   * `blocked` 是关键判据：window.open 被拦时返回 null 而不抛错。
                   * 有这条日志就能分清「处理器没被调用」和「调用了但被宿主拒」。
                   */
                  const blocked = !opened
                  reportDiag({ event: 'link:open', href: href.slice(0, 300), blocked })
                  /**
                   * 真的被拒时要让用户看见。
                   *
                   * 宿主的规则是「https 才 shell.openExternal，其余一律 deny」，
                   * 所以 http / mailto / tel 必然走到这里。静默拒绝的观感
                   * 和「点了没反应」完全一样，而这正是用户此前报的现象。
                   * 提示里带上完整地址，方便手动复制。
                   */
                  if (blocked) {
                    showLinkTip(`打不开这个链接：${href}`, null, 4000, true)
                    /**
                     * 顺手复制地址，但**不要预先声称复制成功** ——
                     * 剪贴板可能被权限拒掉，谎报「已复制」比不提示更糟。
                     * 只在 promise 真的兑现时才改文案。
                     */
                    try {
                      navigator.clipboard?.writeText?.(href)?.then?.(
                        () => { if (linkTip) linkTip.textContent = `打不开这个链接（地址已复制）：${href}` },
                        () => { /* 复制失败就保留原提示 */ },
                      )
                    } catch { /* 剪贴板不可用就算了 */ }
                  }
                } catch (e) {
                  reportDiag({ event: 'link:open-error', href: href.slice(0, 300), message: String(e?.message ?? e) })
                }
                return
              }
              // 其余协议（如 zotero://）交给全局拦截器处理，这里不干预
            }

            /**
             * 悬停预览。
             *
             * 显示完整地址 —— 小标题里被省略的中段只有完整 URL 才看得见，
             * 这也是判断「这个链接值不值得点」最直接的信息。
             * 内部跳转则显示目标页号，不然用户只看到 "#page=12" 这种片段。
             *
             * 提示节点挂在 document.body 且 position:fixed：
             * 宿主的 .zr-pdfviewer-host 是 overflow:hidden，
             * 挂在里面贴边时会被裁掉。
             */

            /**
             * 悬停多久之后才显示浮窗。
             *
             * 原来每次 mouseover 立刻算矩形 —— 而 mouseover 会从 `<a>` 里的
             * 子元素反复冒泡上来，鼠标扫过一行字就是一串调用。性能日志里
             * `HTMLAnchorElement.patchedGBCR <- onPdfLinkOver` 18 次累计
             * 4751ms、单次最高 447ms，全是这一处的强制布局。
             *
             * 500ms 是用户定下的：**光标停留在超链接上超过 0.5 秒才显示**。
             * 位图预览要渲染一整页，成本远高于纯文字提示；而且手在正文上
             * 移动时不停弹出浮窗也很吵。快速扫过链接不触发任何计算。
             *
             * 注意别和另外两个时间混了（三个数字各管一段）：
             *   · 本常量 500ms —— 悬停多久**显示**
             *   · scheduleHideTip 里 300ms —— 移开后多久**消失**
             *   · 删 title 是为了挡原生提示（它约 500ms 后自己弹出），
             *     那个时机由浏览器决定，不归这里管
             */
            const HOVER_TIP_DELAY = 500

            const onPdfLinkOver = (event) => {
              const anchor = event.target?.closest?.('a[href]')
              if (!anchor || !host.contains(anchor)) return
              /**
               * **先删掉 pdf.js 自己挂的 `title`。**
               *
               * annotation_layer 给每个链接都写了 `link.title = overlaidText`，
               * 即「这条链接覆盖的那段正文」。浏览器会把它渲染成原生提示框，
               * 于是悬停时同时出现两个框：我们的地址框 + 原文文字框。
               *
               * 原生提示要等约 500ms 才弹，在 mouseover 这一拍删掉就弹不出来。
               * 这一步必须**立即**做，不能挪进下面的延时里 —— 延时 500ms 之后
               * 原生提示框可能已经排上队了。
               */
              if (anchor.hasAttribute('title')) anchor.removeAttribute('title')
              /**
               * 鼠标回到链接上 → 取消挂起的消失（与浮窗共用 0.3s 判定）。
               */
              cancelHideTip()
              // 同一条链接内部移动（冒泡）不算换目标，否则会不停重排延时
              if (anchor === linkTipAnchor) return
              if (linkTipTimer) clearTimeout(linkTipTimer)
              linkTipAnchor = anchor
              linkTipTimer = setTimeout(() => {
                linkTipTimer = 0
                // 延时期间可能已经滚走、重渲染或切文献
                if (!anchor.isConnected || !host.contains(anchor)) return
                const href = anchor.getAttribute('href') || ''
                if (!href) return
                /**
                 * `#page=N` 只是翻页：不弹任何浮窗。
                 *
                 * 用户的原话是「只有图、公式需要悬浮窗」，
                 * 翻页目标没有内容可预览，弹出来纯属噪音。
                 */
                if (/^#page=(\d+)/i.test(href)) return
                if (href.startsWith('#')) {
                  const rawName = href.slice(1)
                  const decName = (() => {
                    try { return decodeURIComponent(rawName) } catch { return rawName }
                  })()
                  /**
                   * **先判类型，再决定要不要渲染。**
                   *
                   * 用户的原话是「只有图、公式需要悬浮窗」。原来所有具名目标
                   * 都弹位图，`#cite.xxx` 这种纯文字目标也会白渲染一整页。
                   *
                   * 判定必须在 renderDestBitmap 之前 —— 渲染一页是几十到
                   * 几百毫秒的画布工作，为不该弹的目标付这个成本毫无意义。
                   * 所以这里要先解析 dest（getDestination 只读字典，很轻），
                   * 再用 isPreviewableDest 分流。
                   */
                  /**
                   * **按目标类型分流：图/公式走位图，其余具名目标走文字。**
                   *
                   * 用户的两次表态合起来是：
                   *   · 「只有图、公式需要悬浮窗」→ 位图浮窗只给这三类；
                   *   · 「参考文献要退回文字预览」→ 引用类不该完全没提示。
                   * 所以这里不是「弹/不弹」的二值判断，而是三级：
                   *   位图预览（fig/eq/table）> 文字预览（cite 等其他具名目标）
                   *   > 不弹（#page=N 已在上面 return）。
                   *
                   * 关键：文字这条路径**绝不调用 renderDestBitmap** ——
                   * 那是整页 canvas 渲染的重操作，只为取几行字不值得。
                   * 只用 extractDestPreview（读文本层，按页缓存）。
                   */
                  void (async () => {
                    try {
                      const pdfDocument = pdfRef.current?.doc
                      if (!pdfDocument) return
                      let dest = await pdfDocument.getDestination(decName)
                      if (typeof dest === 'string') dest = await pdfDocument.getDestination(dest)
                      if (!Array.isArray(dest) || dest.length === 0) return
                      const destRef = dest[0]
                      let pageIndex
                      if (Number.isInteger(destRef)) pageIndex = destRef
                      else {
                        const cached = pdfDocument.cachedPageNumber?.(destRef)
                        pageIndex = Number.isInteger(cached) && cached > 0
                          ? cached - 1
                          : await pdfDocument.getPageIndex(destRef)
                      }
                      if (!Number.isInteger(pageIndex) || pageIndex < 0) return
                      const pageNo = pageIndex + 1
                      /**
                       * ---- 非图/公式：文字预览 ----
                       *
                       * 先把 dest 解析出来拿到 pageNo（文字提取需要它），
                       * 但**不碰位图**。取不到文字时退回目标名，不留空窗。
                       */
                      if (!isPreviewableDest(decName, dest)) {
                        const preview = await extractDestPreview(dest, pageNo)
                        if (linkTipAnchor !== anchor || !anchor.isConnected) return
                        const caption = `第 ${pageNo} 页 · ${decName}`
                        showLinkTip(
                          preview
                            ? [
                              { kind: 'line', text: preview },
                              { kind: 'dim', text: caption },
                            ]
                            : [
                              { kind: 'dim', text: caption },
                            ],
                          anchor,
                        )
                        return
                      }
                      /**
                       * 类型确认之后才出浮窗骨架 —— 期间用户可能已经移开，
                       * 所以要先确认还是同一条链接，避免给旧链接弹窗。
                       */
                      if (linkTipAnchor !== anchor || !anchor.isConnected) return
                      /**
                       * 位图浮窗骨架：**只留位图，不带任何文字行**。
                       *
                       * 用户的原话：「下方的这个文字提醒可以不用，在超链接
                       * 对应是图和公式的时候」。位图本身已经把目标区域
                       * 画出来了，底下再压一行「第 N 页 · fig5」既占高度
                       * 又容易让浮窗长出去盖住链接。
                       *
                       * 文字预览（参考文献）那条仍保留页码信息 —— 那里
                       * 没有图，页码是唯一的位置线索。
                       */
                      /**
                       * **浮窗尺寸只算这一次（见 computePopupSize）。**
                       *
                       * 用户要的是「0.9 页面宽 × 0.3 页面高」：页面 700×991
                       * → 630×297。整页按这个宽度渲染、按这个高度滚动。
                       *
                       * 不再走 computeBitmapGeometry：那条路按「目标区域 ×
                       * contain 缩放」推尺寸，语义是「把图抠出来放大填满」，
                       * 正是用户否掉的方向（509×308pt 被渲成 1240×720px，
                       * 放大约 2.4 倍，图和字都巨大）。区域推导函数仍留在
                       * 文件里供跳转高亮等场景使用，浮窗不再依赖它们。
                       */
                      const size = computePopupSize(anchor)
                      if (!(size.popupW > 0) || !(size.popupH > 0)) {
                        reportDiag({ event: 'tip:skip', reason: 'no-popup-size' })
                        return
                      }
                      /**
                       * 先出骨架：带上 popupW 让 placeHorizontal 一次摆对，
                       * 不再出现「先按 630 摆、渲染完变 1240」的分叉。
                       */
                      showLinkTip([], anchor, 0, false, {
                        bitmap: true,
                        popupW: size.popupW,
                        popupH: size.popupH,
                      })
                      const canvas = await renderPagePreview(pageNo, size.popupW)
                      const preview = canvas ? null : await extractDestPreview(dest, pageNo)
                      // 鼠标已经移走 / 换到别的链接 / 卡片被清理：不要回写
                      if (linkTipAnchor !== anchor || !linkTip || !anchor.isConnected) return
                      const tip = ensureTip()
                      const caption = `第 ${pageNo} 页 · ${decName}`
                      if (canvas) {
                        /**
                         * 有图就以图为主体，**不附文字行**。
                         * 这里重发一次是为了让 wasOn 分支按 popupH 复核纵向。
                         */
                        showLinkTip([], anchor, 0, false, {
                          bitmap: true,
                          popupW: size.popupW,
                          popupH: size.popupH,
                        })
                        /**
                         * 锚点在页内的比例（0..1，从页顶算）。
                         *
                         * `destVOffset` 已经把 PDF 左下原点翻成「距页顶」，
                         * 并把原点型 dest 的 y 夹在 0..0.98 —— 这里直接复用，
                         * 不再另写一套 dest[3] / dest[2] 的取值分支。
                         */
                        const anchorRatio = await destVOffset(dest, pageNo)
                        putTipBitmap(tip, canvas, anchorRatio, size.popupH)
                        /**
                         * **canvas 实际尺寸诊断。**
                         *
                         * 用户反复报「图太小 / 高度不够」。要分清是
                         * 「图本身没放大」还是「放大了但被容器截断」，
                         * 必须同时看：canvas 的 CSS 尺寸、位图槽的可视高
                         * 与内容总高、本次渲染用的目标宽、以及裁切区域的
                         * PDF 点尺寸。这几个数凑在一起才能定性。
                         */
                        try {
                          const shotEl = tip.querySelector('.zr-tip-shot')
                          /**
                           * 浮窗矩形只读一次（强制布局有成本，诊断不该再添一次）。
                           */
                          const tipRect = tip.getBoundingClientRect()
                          /**
                           * 顺带捞锚点附近的文本层，用来判断能否按区域裁切。
                           * 只读，不影响渲染。
                           */
                          const probe = await probeDestText(dest, pageNo)
                          reportDiag({
                            event: 'tip:bitmap',
                            href: (anchor.getAttribute('href') || '').slice(0, 60),
                            canvasCssW: Number(canvas.dataset?.cssW ?? 0) || Math.round(canvas.getBoundingClientRect().width),
                            canvasCssH: Number(canvas.dataset?.cssH ?? 0) || Math.round(canvas.getBoundingClientRect().height),
                            shotClientH: shotEl ? Math.round(shotEl.clientHeight) : null,
                            shotScrollH: shotEl ? Math.round(shotEl.scrollHeight) : null,
                            /**
                             * 横向尺寸：槽的内容宽比浮窗窄多少，就是滚动条
                             * 吃掉的宽度。`shotClientH` 若比 popupH 少几像素，
                             * 只有这里能看出是不是被横向滚动条扣掉了。
                             */
                            shotClientW: shotEl ? Math.round(shotEl.clientWidth) : null,
                            shotScrollW: shotEl ? Math.round(shotEl.scrollWidth) : null,
                            /** 尺寸单一源：页面矩形 → popupW/popupH（目标值） */
                            pageRectW: size.pageRectW,
                            pageRectH: size.pageRectH,
                            popupW: size.popupW,
                            popupH: size.popupH,
                            /** 浮窗 DOM 实际尺寸：与目标值不一致说明被撑开/压扁 */
                            tipW: Math.round(tipRect.width),
                            tipH: Math.round(tipRect.height),
                            anchorRatio,
                            scrollTop: shotEl ? Math.round(shotEl.scrollTop) : null,
                            /**
                             * **几何自检：canvasCssW 必须等于目标 popupW。**
                             *
                             * 判据用**目标值**而不是 DOM 宽度：若浮窗本身
                             * 被内容撑成 1240，再拿 DOM 宽度去比永远相等，
                             * 恰好放跑「浮窗比用户要的宽一倍」这种故障。
                             */
                            geoConsistent: (() => {
                              const cw = Number(canvas.dataset?.cssW ?? 0)
                              return cw > 0 ? Math.abs(cw - size.popupW) <= 2 : null
                            })(),
                            pageWpt: Number(canvas.dataset?.pageWpt ?? 0) || null,
                            pageHpt: Number(canvas.dataset?.pageHpt ?? 0) || null,
                            viewportW: Math.round(window.innerWidth),
                            viewportH: Math.round(window.innerHeight),
                            dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
                            /** 文本层探测结果（destKind / anchorY / near / labels 等） */
                            probe,
                          })
                        } catch { /* 诊断失败不影响显示 */ }
                      } else if (preview) {
                        // 位图失败（少见）时退回文字预览，总比空窗好
                        showLinkTip([
                          { kind: 'line', text: preview },
                          { kind: 'dim', text: caption },
                        ], anchor)
                      } else {
                        showLinkTip([
                          { kind: 'title', text: '文档内跳转' },
                          { kind: 'line', text: `第 ${pageNo} 页` },
                          { kind: 'dim', text: decName },
                        ], anchor)
                      }
                    } catch { /* 渲染不出来就保持占位，不打扰用户 */ }
                  })()
                  return
                }
                showLinkTip([{ kind: 'link', text: href }], anchor)
              }, HOVER_TIP_DELAY)
            }
            const onPdfLinkOut = (event) => {
              const anchor = event.target?.closest?.('a[href]')
              if (!anchor) return
              // 指针在本链接的子元素之间移动时也会触发 mouseout，那不是离开
              if (event.relatedTarget && anchor.contains?.(event.relatedTarget)) return
              /**
               * **不立刻隐藏，改为 0.3s 后隐藏。**
               *
               * 鼠标要从链接移到浮窗上滚动，中途必然经过空隙；立即隐藏的话
               * 用户根本够不到浮窗。这 0.3s 里若鼠标进了浮窗或回到链接，
               * cancelHideTip 会把任务取消（见 ensureTip 里的 mouseenter）。
               */
              scheduleHideTip()
            }

            host.addEventListener('click', onPdfLinkClick, true)
            host.addEventListener('mouseover', onPdfLinkOver)
            host.addEventListener('mouseout', onPdfLinkOut)
            const disposeLinkHandlers = () => {
              try { host.removeEventListener('click', onPdfLinkClick, true) } catch { /* ignore */ }
              try { host.removeEventListener('mouseover', onPdfLinkOver) } catch { /* ignore */ }
              try { host.removeEventListener('mouseout', onPdfLinkOut) } catch { /* ignore */ }
              try { if (linkTipTimer) clearTimeout(linkTipTimer) } catch { /* ignore */ }
              try { if (linkWarnTimer) clearTimeout(linkWarnTimer) } catch { /* ignore */ }
              try { if (linkHideTimer) clearTimeout(linkHideTimer) } catch { /* ignore */ }
              linkTipTimer = 0
              linkWarnTimer = 0
              linkHideTimer = 0
              linkTipAnchor = null
              /**
               * 移除事件监听再摘节点。
               *
               * 节点被 remove() 后监听理论上会随它一起被回收，
               * 但这里显式摘掉更稳（且 wheel 是 passive:false 的，
               * 留着它对浏览器/扩展的清理更不友好）。
               */
              try {
                linkTip?.removeEventListener('wheel', onTipWheel, { passive: false })
              } catch { /* ignore */ }
              try { linkTip?.remove() } catch { /* ignore */ }
              linkTip = null
              /**
               * 文本层缓存**必须跟着文档一起清**。
               *
               * 缓存键是 pageNo，不带文档身份：换一篇 PDF 后第 3 页还是第 3 页，
               * 不清就会把上一篇第 3 页的文字当成新文档的预览显示出来 ——
               * 这种错看起来像「预览内容张冠李戴」，最难往缓存上想。
               */
              try { textLinesCache.clear() } catch { /* ignore */ }
              /**
               * 页位图缓存同理，而且更重：一张 1400px 宽的 canvas 约几 MB，
               * 不清既会串文档又会白占内存。
               */
              try { pageBitmapCache.clear() } catch { /* ignore */ }
              try { pageBitmapPending.clear() } catch { /* ignore */ }
              // 闪烁块是临时元素，清理时一并收掉（它可能还在淡出中）
              try { clearJumpFlash() } catch { /* ignore */ }
            }
            disposeLinkHandlersRef.current = disposeLinkHandlers

            // 官方 viewer 把页码/缩放变化通过 eventBus 广播，转成我们自己的 state
            eventBus.on('pagechanging', (e) => {
              if (disposed) return
              setVisiblePage(e.pageNumber)
              setJumpPage(e.pageNumber)
              /**
               * **恢复完成前不要记录位置。**
               *
               * 这里是「刷新后先回第一页」的根源，一个自我强化的循环：
               *   ① setDocument 之后 pdf.js 把 currentPageNumber 置为 1，
               *      并立刻抛一次 pagechanging(pageNumber=1)；
               *   ② 本回调把它记进 lastSavedPageRef 并 debounce 写盘，
               *      于是 localStorage 里那篇文献的位置被改成了 1；
               *   ③ 紧接着 resume-page 去读，读到的就是 1 —— 目标页变成第 1 页；
               *   ④ cleanup 再把 1 写回去，下次打开还是 1。
               *
               * 实测日志的规律正是如此：目标=1 的那些打开，
               * resume-applied 全是 attempts=25 ok=False
               * （第 1 页已在顶部，scrollPageIntoView 判不出位移）。
               *
               * 用 resumeDoneRef 卡住：恢复真正落地之前，pagechanging
               * 只用来更新界面显示，不参与持久化。
               */
              if (!resumeDoneRef.current) return
              /**
               * 记住读到哪儿 —— 记的是**位置**，不是页号。
               *
               * 用户常常停在两页之间（上一页尾部 + 下一页开头同时可见），
               * 只记页号会把视图吸到某一页顶部，视觉参照点就丢了。
               * 这里除了页号，还算出「视口顶部落在该页的百分之几」一起存，
               * 恢复时就能落回原来的位置而不是页首。
               *
               * 节流：debounce 400ms + 页号/偏移去重。一次滚动会连抛很多次。
               */
              const pageNo = e.pageNumber
              const off = currentScrollOffset()
              const samePos = pageNo === lastSavedPageRef.current
                && Math.abs(off - (lastSavedOffsetRef.current ?? 0)) < 0.01
              if (!samePos) {
                lastSavedPageRef.current = pageNo
                lastSavedOffsetRef.current = off
                if (savePageTimerRef.current) clearTimeout(savePageTimerRef.current)
                savePageTimerRef.current = setTimeout(() => {
                  savePageTimerRef.current = null
                  writeSavedPos(itemKey, lastSavedPageRef.current, lastSavedOffsetRef.current ?? 0)
                }, 400)
              }
            })
            eventBus.on('scalechanging', (e) => {
              if (disposed) return
              // 官方 scale 是相对 PDF 点位的 CSS 单位，和我们的 scale 语义一致
              const next = Number(e.scale.toFixed(3))
              /**
               * 记下「刚刚在缩放」。
               *
               * 这里是所有缩放的唯一汇聚点（+/-、Ctrl+滚轮、适应宽度、捏合都从
               * 官方抛出来）。缩放之后 pdf.js 要花若干帧重算每页 viewport，
               * 这段时间里任何按恢复目标做的滚动都会把用户刚放好的位置拽走 ——
               * 下面的 rAF 补滚据此判定要不要让路。
               */
              zoomAtRef.current = perf.now()
              lastAppliedScaleRef.current = next
              scaleRef.current = e.scale
              setScale(next)
              /**
               * 记住缩放值。
               *
               * 这里是所有缩放的**唯一汇聚点**：+/- 按钮走 setScale → 同步 effect
               * → viewer.currentScale，Ctrl+滚轮/捏合同样最终落到 viewer，
               * 官方统一从这里抛出来。所以挂这一处就覆盖全部入口，不必逐个按钮埋点。
               *
               * 存 'fit' 还是数字，取决于当前是不是自适应模式 —— 见 writeSavedScale 的注释。
               * 自适应模式下不能存当时的数字：侧栏一变宽那个数字就不贴边了。
               *
               * 节流：debounce 400ms + 值去重。拖一次滚动条会连抛几十次 scalechanging。
               */
              const payload = fitModeRef.current ? SCALE_FIT : next
              if (payload !== lastSavedScaleRef.current) {
                lastSavedScaleRef.current = payload
                if (saveScaleTimerRef.current) clearTimeout(saveScaleTimerRef.current)
                saveScaleTimerRef.current = setTimeout(() => {
                  saveScaleTimerRef.current = null
                  writeSavedScale(itemKey, lastSavedScaleRef.current)
                }, 400)
              }
            })
            eventBus.on('pagerendered', (e) => {
              if (disposed) return
              /**
               * **目标页画好的这一刻，才揭开恢复期的遮罩。**
               *
               * 判据必须是「目标页真的画出来」，不能是「跳转成功」：
               * applyResume 在 180ms 左右就报告 scrolled=true，
               * 但那时目标页的 canvas 还没画（要等到 1.2–1.6 秒）。
               * 提前揭开会让用户看到一片空白，反而更像坏了。
               *
               * 用 pagerendered 而不是定时器：它是 canvas 真正画完的锚点，
               * 不受主线程排队影响。
               */
              try {
                const want = resumeTargetRef.current
                if (want > 0 && host?.dataset?.restoring === '1' && e.pageNumber === want) {
                  delete host.dataset.restoring
                  resumeTargetRef.current = 0
                  reportDiag({ event: 'viewer:restore-mask', on: false, page: e.pageNumber })
                }
              } catch { /* 揭不开最多是多遮一会儿，由下面的兜底收尾 */ }
              /**
               * 性能锚点：pagerendered 在 canvas 真正画完时触发，
               * 不受 setTimeout 排队影响，是「这一页到底什么时候画好」的可信时刻。
               *
               * 这里同时数两个决定改法方向的事实：
               *   ① 一共画了多少页 —— 15 页文档若一次性全画，根因就是没有按需渲染；
               *   ② 有没有页被重复画 —— 重复渲染是纯浪费，通常来自缩放/重排抖动。
               */
              perf.phase('page-painted', e.pageNumber)
              perf.notePainted(e.pageNumber)
              /**
               * 逐页绘制的直接证据。三个字段合起来才能区分两种截然不同的成因：
               *   · 只画可见页但每页很慢   → 单页渲染太重
               *   · 一口气把 15 页全画了   → 根本没有按需渲染
               * 这两种改法完全相反，所以不能靠推断。
               */
              let visibleAtPaint = null
              let canvasCount = 0
              try {
                const pageEl = host.querySelector(`.page[data-page-number="${e.pageNumber}"]`)
                if (pageEl) {
                  const pr = pageEl.getBoundingClientRect()
                  const cr = container.getBoundingClientRect()
                  // 与本页可见区域有交集即算「在视口内」
                  visibleAtPaint = pr.bottom > cr.top && pr.top < cr.bottom && pr.height > 0
                }
                canvasCount = host.querySelectorAll('canvas').length
              } catch { /* 量不到就留空，不编数据 */ }
              reportDiag({
                event: 'perf:paint',
                page: e.pageNumber,
                /**
                 * 时间字段的语义必须写死，否则一定被误读。
                 *
                 * `relMs` = 距本轮计时起点的毫秒数（**单调递增的时长**，
                 *           用来算「第 1 页到第 2 页花了多久」）。
                 * `at`    = 标准 ISO 墙钟时间（**能和 pdf:start / perf:summary
                 *           这类事件按时间对齐**），不是 performance.now()。
                 *
                 * 这里的 `at` 曾被写成 `performance.now()` 的绝对值（如 724219），
                 * 看起来像 12 分钟，且与其他事件的 ISO `at` 完全对不上 ——
                 * 直接导致过一次「22 毫秒内重画 7 次」的错误推断。
                 * 绝对值和时长同单位，肉眼分不出，所以两个都给。
                 */
                relMs: Math.round(perf.now() - (perf.periodStart() || 0)),
                at: new Date().toISOString(),
                visibleAtPaint,
                canvasCount,
                /**
                 * 带上 itemKey，否则无法按文献分组对比。
                 *
                 * 之前排查「哪篇 PDF 渲染慢」时卡在这里：paint 事件里没有
                 * itemKey，跨文献的统计只能混在一起算，分不清是「某篇特别慢」
                 * 还是「所有篇都慢」——而这两者的改法完全不同。
                 */
                itemKey,
              })
              /**
               * **不要在 pagerendered 回调里同步写 DOM。**
               *
               * 这里原来直接调 decoratePage 与 paintSelect，两者都会改 DOM
               * （`layer.innerHTML = ''`＋逐个 append）。而这个回调的时刻恰好是
               * pdf.js 刚画完 canvas、正要进入下一帧 —— 此时改 DOM 会让它判定
               * 页面布局变了，于是**把同一页再渲染一遍**：
               *
               *   pagerendered → decoratePage 写 DOM → 布局脏 → pdf.js 重画
               *   → pagerendered 再次触发 → 又写一遍 …… 直到收敛
               *
               * 实测证据（E3TYCEMB 14 页）：滑动过程中 page 7 与 page 8
               * 各被画 2 次，且 canvas 计数不增长（重画的是同一个 canvas）。
               * 每翻一页额外多一次全页渲染，与文本层排序叠加就是那 2–8 秒。
               *
               * 挪到下一帧再画：那时 pdf.js 的渲染周期已结束，我们的写入
               * 只是贴着已完成的画面做叠加，不会反过来触发重渲染。
               */
              const pageNo = e.pageNumber
              /**
               * 量「画完一页之后，我们的装饰工作要占多久」。
               *
               * 滚动卡顿定位了很久，是因为只知道 annot:scale 显示 1.5 秒，
               * 而那条日志打在 decoratePage 中部，分不清是函数慢还是调用处慢。
               * 这里直接量整段（decorate + 选中框重绘），才是滚动时真正付出的成本。
               *
               * 只记 >8ms 的：滚动时每页都会触发一次，全记会把日志撑爆。
               */
              const decorateCost = (fn) => {
                const t0 = perf.now()
                try { fn() } finally {
                  const dt = perf.now() - t0
                  if (dt > 8) {
                    reportDiag({ event: 'decorate:slow', pageNo, ms: Math.round(dt) })
                  }
                }
              }
              const runDecorate = () => {
                /**
                 * **刚缩放过就别在下一帧补装饰。**
                 *
                 * 装饰只影响观感（批注块位置），它不参与 pdf.js 的布局决策；
                 * 而此刻 pdf.js 正在按新 scale 重排每一页，我们若在这一帧里
                 * 清空并重建某页的批注层，就是在它重排的过程中改 DOM。
                 * 让给缩放：缩放停下来后 pagerendered 还会再触发一次，
                 * 那一拍补画即可，形状由 decoratePage 按当前 scale 算。
                 */
                if (perf.now() - zoomAtRef.current < 240) return
                decoratePageRef.current?.(pageNo)
                // 页面重画会把层清空，外框一起没了 —— 补回来（无选中时是空操作）
                paintSelectRef.current?.(annotSelectedRef.current)
              }
              if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                  if (disposed) return
                  decorateCost(runDecorate)
                })
              } else {
                decorateCost(runDecorate)
              }
            })

            /**
             * 恢复缩放。
             *
             * 三种情况：
             *   ① 没有记录 / 记录是 'fit' → `page-width`，交给官方算（原因见下）
             *   ② 记录是具体数字 → 直接写回那个比例，用户上次调过就还是那个
             *   ③ 写数字失败（极端情况）→ 退回 page-width
             *
             * 为什么 `page-width` 必须交给官方而不是自己算：
             * 官方内部会乘一次换算系数（scale × PDF_TO_CSS_UNITS），
             * 而我们手上只有「PDF 点位宽」和「CSS 像素宽」，直接相除得到的数字
             * 会比正确值大 —— 表现为「点了适应宽度，页面反而比侧栏更宽，
             * 需要横向滚动」。交给官方算才和它的渲染完全一致。
             */
            const savedScale = readSavedScale(itemKey)
            if (typeof savedScale === 'number') {
              try {
                viewer.currentScale = savedScale
                /**
                 * 恢复的是**具体比例**，所以不是自适应模式。
                 * fitModeRef 必须为 false，否则下面那个「scale state → viewer」
                 * 的同步 effect 会在 fitModeRef 为真时直接 return，
                 * 之后用户再按 +/- 就写不进 viewer 了。
                 */
                fitModeRef.current = false
                lastAppliedScaleRef.current = Number(viewer.currentScale.toFixed(3))
                setScale(Number(viewer.currentScale.toFixed(3)))
                reportDiag({ event: 'viewer:resume-scale', itemKey, scale: savedScale, mode: 'number' })
              } catch (e) {
                reportDiag({ event: 'viewer:resume-scale-failed', itemKey, message: String(e?.message ?? e) })
                try {
                  viewer.currentScaleValue = 'page-width'
                  fitModeRef.current = true
                  lastAppliedScaleRef.current = Number(viewer.currentScale.toFixed(3))
                  setScale(Number(viewer.currentScale.toFixed(3)))
                } catch { /* 连 fit 都失败就保持默认 */ }
              }
            } else {
              try {
                viewer.currentScaleValue = 'page-width'
                fitModeRef.current = true
                lastAppliedScaleRef.current = Number(viewer.currentScale.toFixed(3))
                setScale(Number(viewer.currentScale.toFixed(3)))
                reportDiag({ event: 'viewer:resume-scale', itemKey, mode: savedScale === 'fit' ? 'fit' : 'default' })
              } catch (e) {
                reportDiag({ event: 'viewer:scale-fit-failed', message: String(e?.message ?? e) })
              }
            }

            /**
             * 首屏落到「上次读到的那一页」。
             *
             * 官方 viewer 依赖滚动事件与 ResizeObserver 决定渲染哪些页；
             * 在侧栏这种高度靠 flex 撑起来的容器里，首次布局可能发生在
             * viewer 订阅之后，导致它认为「没有页在视野内」而一页都不画
             * （实测现象：日志 viewer:ready，但区域一片空白）。
             * 显式设一次页码，让它至少把当前页渲染出来。
             *
             * 页码来源：localStorage 里这篇文献上次停的页；没有记录才用 1。
             * **必须在 setDocument 之后**设置 —— 文档没就绪时 currentPageNumber
             * 是空操作（不报错，静默失效），这个坑本项目已经踩过一次。
             */
            try {
              /**
               * 恢复阅读位置：**先设页号，再按偏移做像素级精调**。
               *
               * 之前是「先渲染第 1 页，120ms 后再跳到目标页」，用户能看到明显的
               * 「先停在第 1 页、等一下才跳过去」两段式闪烁。现在第一次赋值就用目标页，
               * 让 pdf.js 一开始就渲染正确的那一页。
               *
               * `viewer.currentPageNumber = n` 内部会读 `this._pages[i]`，
               * 页视图没建出来时赋值会被静默丢弃（不报错、不生效）——
               * 所以要重试并用读回值校验。
               */
              // resumePage / resumeOffset 已在 setDocument 之前算好（见 pagesinit 那段），
              // 这里直接复用 —— 重复声明会报 SyntaxError，而且两处算的值可能不一致。

              /**
               * **恢复期间先把画布遮起来（目标页不是第 1 页时）。**
               *
               * 这是「闪回第一页再回到当前页」的最终解法，原因在实测数据里：
               *   viewer:doc-set      目标=6
               *   +320ms  paint page=1    ← 用户此刻看到第 1 页
               *   +1522ms paint page=6    ← 这才到正确位置
               *
               * pdf.js 在 setDocument 之后**必定先渲染第 1 页**：那会儿页容器
               * 刚建出来、尺寸还没量准，滚不动；而目标页要等 1.2–1.6 秒才画好。
               * 中间这段窗口无法通过「更早地设页码」消掉 —— 页视图不存在时
               * 赋值会被静默丢弃（这个行为已经验证过两次）。
               *
               * 所以换个思路：不跟 pdf.js 的渲染顺序较劲，而是**不让用户看到
               * 中间态**。等目标页真正画好的那一刻再揭开（见 pagerendered）。
               *
               * 目标页是第 1 页时不遮 —— 那时本来就不用跳，遮一下反而多此一举。
               */
              try {
                if (resumePage > 1 && host) {
                  host.dataset.restoring = '1'
                  resumeTargetRef.current = resumePage
                  reportDiag({ event: 'viewer:restore-mask', on: true, target: resumePage })
                  /**
                   * 兜底：4 秒后无论目标页画没画出来都揭开。
                   *
                   * 目标页画不出来的情况是存在的（加密页、损坏页、或者 pdf.js
                   * 判定它不在视口所以不画）。一直遮着等于让阅读器变砖，
                   * 那比"看到第 1 页"严重得多。
                   */
                  setTimeout(() => {
                    try {
                      if (disposed) return
                      if (host?.dataset?.restoring === '1') {
                        delete host.dataset.restoring
                        resumeTargetRef.current = 0
                        reportDiag({ event: 'viewer:restore-mask', on: false, timeout: true })
                      }
                    } catch { /* ignore */ }
                  }, 4000)
                } else {
                  delete host?.dataset?.restoring
                  resumeTargetRef.current = 0
                }
              } catch { /* 遮罩失败不影响阅读，最多是能看到中间态 */ }

              /**
               * **立刻把页码告诉 viewer，但先别滚动。**
               *
               * 这里经历过两次矫枉过正，值得记下来：
               *
               *  ① 最初：setDocument 之后立刻 `currentPageNumber = resumePage`，
               *     同时立刻做几何滚动。但那一刻 domPages 还是 0，赋值被静默
               *     丢弃，滚动按第 1 页几何算了一次 —— 用户看到「闪到第 1 页
               *     再弹回目标页」。
               *
               *  ② 于是改成完全不设页码，等页视图建好再设。结果更糟：等待
               *     期间 pdf.js 按默认从第 1 页开始渲染，实测目标页是第 7 页时
               *     第 1 页先画出来（01:19:45.987），3 秒后才画第 7 页
               *     （01:19:49.080）—— 就是「先闪到第一页」。
               *
               * 两个极端都错。正解是**把「告诉 viewer 目标页」和「几何滚动」
               * 拆开**：页码立刻设（它便宜，且能让 pdf.js 朝目标页建视图、
               * 优先渲染那一页），滚动交给 applyResume 等页就绪后再做。
               *
               * 赋值在页视图未建好时可能被丢弃，所以 applyResume 里仍要重试，
               * 这里是「尽早给出方向」，不是「保证生效」。
               */
              try {
                viewer.currentPageNumber = resumePage
                viewer.update?.()
              } catch { /* 早期版本没有 update，忽略 */ }

              setVisiblePage(resumePage)
              setJumpPage(resumePage)
              lastSavedPageRef.current = resumePage
              lastSavedOffsetRef.current = resumeOffset
              reportDiag({
                event: 'viewer:resume-page',
                itemKey,
                page: resumePage,
                offset: resumeOffset,
                pages: pdf.doc.numPages,
              })

              const applyResume = (attempt) => {
                if (disposed) return
                try {
                  /**
                   * **页视图没就绪之前什么都不做。**
                   *
                   * 两个动作都依赖 `.page[data-page-number=N]` 真的存在：
                   * 设页码（pdf.js 内部按 _pages 索引）与几何滚动（要量元素矩形）。
                   * 在它存在之前动手，只会被静默丢弃或量到 0，
                   * 既浪费时间又会让视图先落到第 1 页再弹回来。
                   *
                   * 所以先探一次，没建好就等下一拍，别做无用功。
                   */
                  const ready = Boolean(
                    host.querySelector(`.page[data-page-number="${resumePage}"]`),
                  )
                  if (!ready && attempt < 24) {
                    setTimeout(() => applyResume(attempt + 1), 60)
                    return
                  }
                  if (viewer.currentPageNumber !== resumePage) {
                    viewer.currentPageNumber = resumePage
                    viewer.update?.()
                    setVisiblePage(resumePage)
                    setJumpPage(resumePage)
                  }
                  /**
                   * **必须真的滚。**
                   *
                   * 只设 currentPageNumber 时，pdf.js 自己那条滚动链在侧栏里是断的，
                   * 页码写对了、视图却纹丝不动 —— 用户看到「显示第 4 页、实际停在
                   * 第 1 页」。而旧判据只看 currentPageNumber 是否相等，于是
                   * 这种情况还会打出 ok:true，把问题藏起来。
                   *
                   * 所以这里改走和 gotoPage 同一条几何滚动路径，并把
                   * 「视图是否真的到位」纳入判据。
                   */
                  const scrolled = scrollPageIntoView(host, resumePage, resumeOffset)
                  const pageOk = viewer.currentPageNumber === resumePage
                  /**
                   * 判据必须诚实：**页码对 且 真的滚到了**才算成功。
                   *
                   * 早先写成 `pageOk && (scrolled || attempt >= 12)`，
                   * 那个 `attempt >= N` 会在重试用尽后无条件放行 ——
                   * 于是「页码对了、视图没动」也会被记成 ok:true，
                   * 把问题藏起来（踩过一次）。
                   * 现在超限就如实记 ok:false，日志里能一眼看出失败。
                   */
                  const ok = pageOk && scrolled
                  if (!ok && attempt < 24) {
                    setTimeout(() => applyResume(attempt + 1), 120)
                    return
                  }
                  /**
                   * 恢复落地（无论成败）——从这个时刻起才允许把页码写盘。
                   *
                   * 失败也要置位：如果一直不置位，用户后续的手动翻页都不会
                   * 被记住，那比「恢复到第一页」更糟。
                   */
                  /**
                   * **置位之前先把"当前页"校正成恢复目标。**
                   *
                   * 恢复期间的 pagechanging 都被守卫挡掉了，所以
                   * lastSavedPageRef 还停在旧值（可能是 0）。
                   * 如果直接置位，下一次 pagechanging 之前若发生 cleanup，
                   * 写进 localStorage 的就是那个旧值 —— 位置再次丢失。
                   *
                   * 这里主动对齐到 resumePage，等于把「我确实停在这一页」
                   * 这件事落定，之后的翻页再正常覆盖。
                   */
                  lastSavedPageRef.current = resumePage
                  lastSavedOffsetRef.current = resumeOffset
                  resumeDoneRef.current = true
                  reportDiag({
                    event: 'viewer:resume-applied',
                    itemKey,
                    want: resumePage,
                    got: viewer.currentPageNumber,
                    offset: resumeOffset,
                    scrolled,
                    attempts: attempt + 1,
                    ok,
                  })
                } catch { /* 忽略单次失败，下轮再试 */ }
              }
              /**
               * 保底闸：3 秒后如果恢复仍未落地，就放行写盘。
               *
               * 为什么需要：applyResume 内部整体包着 try/catch，
               * 万一因 dispose、异常或某条早期 return 没走到置位那一步，
               * resumeDoneRef 会一直是 false —— 用户之后翻页**全部不被记住**，
               * 那比「恢复到第一页」更糟。
               *
               * 但**不能无条件放行**：如果恢复还在重试中就把闸开了，
               * pdf.js 期间抛的 pagechanging(1) 会漏进来，位置又被写成第 1 页
               * （这正是「闪回第一页」复发的路径）。所以只在「还没落地」时兜底，
               * 而且兜底只做一次。
               */
              setTimeout(() => {
                if (disposed || resumeDoneRef.current) return
                reportDiag({ event: 'viewer:resume-timeout', itemKey })
                resumeDoneRef.current = true
              }, 3000)
              // 首帧之后开始补：给 pdf.js 建页视图留时间
              setTimeout(() => applyResume(0), 120)
            } catch { /* 早期版本没有 update，忽略 */ }

            /**
             * `viewer:ready` 必须带上**页元素数量**才算数。
             *
             * 之前它只打 `pages: pdf.doc.numPages`（文档里的总页数），
             * 哪怕 viewer 一页都没建出来也照打 14 —— 于是出现过「日志显示 ready
             * 但画布全黑」这种情况，排查时被这条假绿灯误导过。
             * 真正有意义的是 DOM 里实际存在的 `.page` 个数。
             */
            let domPages = 0
            try {
              domPages = host.querySelectorAll('.page[data-page-number]').length
            } catch { /* 量不到就报 0 */ }
            reportDiag({
              event: 'viewer:ready',
              itemKey,
              pages: pdf.doc.numPages,
              domPages,
              viewerScale: Number(viewer.currentScale?.toFixed?.(3) ?? 0),
            })

            /**
             * 再等一拍复查一次页元素数量。
             *
             * 首屏渲染是异步的（要取页、建 canvas、跑渲染队列），
             * 上面那句打的时候 `.page` 可能还没插进 DOM。
             * 这个复查才是「画布到底有没有画出来」的最终判据：
             *   domPages > 0 且 sawRender 为真 → 真的渲染了。
             */
            setTimeout(() => {
              if (disposed) return
              let after = 0
              try {
                after = host.querySelectorAll('.page[data-page-number]').length
              } catch { /* 忽略 */ }
              reportDiag({
                event: 'viewer:render-check',
                itemKey,
                domPages: after,
                rendered: after > 0,
              })
            }, 600)

            /**
             * ========== 性能探针：首屏汇总 ==========
             *
             * 判据用事件而不是固定延时 —— 这样汇总时刻不会因主线程堵塞而漂移，
             * 也只在真正画完首页时才出数据（不会在空白期打一条全 0 的假记录）。
             *
             * 这条 `perf:summary label=open` 就是「打开一篇 PDF 有多卡」的量化画像：
             * 长任务占比、帧间隔分位数、各阶段耗时、实际画了几页、有没有重复画。
             */
            const onFirstPaint = () => {
              try { eventBus.off?.('pagerendered', onFirstPaint) } catch { /* 老版本没有 off */ }
              setTimeout(() => {
                if (disposed) return
                let domP = 0
                try { domP = host.querySelectorAll('.page[data-page-number]').length } catch { /* 忽略 */ }
                perf.summary('open', {
                  itemKey,
                  numPages: pdf.doc.numPages,
                  domPages: domP,
                  viewerScale: Number(viewer.currentScale?.toFixed?.(3) ?? 0),
                })
              }, 1000)
            }
            eventBus.on('pagerendered', onFirstPaint)
          } catch (e) {
            if (disposed) return
            reportDiag({ event: 'viewer:error', itemKey, message: String(e?.message ?? e), stack: String(e?.stack ?? '').slice(0, 600) })
            setError(`官方阅读器加载失败：${e?.message ?? e}`)
            setStatus('error')
          }
        })()

        return () => {
          disposed = true
          /**
           * 先撤掉 PDF 内链接的监听与悬停提示。
           *
           * host 会被下一次加载复用（`host.innerHTML = ''` 只清子节点，
           * host 本身还在），监听器若不清就会**累积**：切三篇文献后
           * 一次点击会触发三遍，越用越慢。清理函数在 effect 里创建，
           * 通过 ref 传到这里。
           */
          try { disposeLinkHandlersRef.current?.() } catch { /* ignore */ }
          disposeLinkHandlersRef.current = null
          /**
           * **切走之前先把当前页同步落盘，再清定时器。**
           *
           * 之前这里只有 `clearTimeout`，理由是「防止组件切换后把上一篇的页码写进去」——
           * 但那个担心用错了方式解决：定时器被清掉，那次翻页就**彻底丢了**。
           * 用户翻到第 5 页、400ms debounce 还没到就切到别的界面，回来还是第 1 页。
           *
           * 正确做法：在销毁这一刻把当前页写下去（此时 itemKey 仍是这一篇，
           * 不会串号），然后才清定时器。这样「切走」和「停留」都不丢页。
           */
          try {
            if (lastSavedPageRef.current > 0) {
              writeSavedPos(itemKey, lastSavedPageRef.current, lastSavedOffsetRef.current ?? 0)
            }
          } catch { /* 写入失败不影响销毁 */ }
          /**
           * 缩放同理：把最后那个值落盘再清定时器。
           * 否则「调完缩放马上切走」会丢掉这次调整（debounce 还没到）。
           */
          try {
            if (lastSavedScaleRef.current !== null) writeSavedScale(itemKey, lastSavedScaleRef.current)
          } catch { /* 写入失败不影响销毁 */ }
          if (savePageTimerRef.current) {
            clearTimeout(savePageTimerRef.current)
            savePageTimerRef.current = null
          }
          if (saveScaleTimerRef.current) {
            clearTimeout(saveScaleTimerRef.current)
            saveScaleTimerRef.current = null
          }
          /**
           * 换文档/重载时把缩放补偿状态一起清掉。
           *
           * 不清的后果很具体：`zoomCompensationRef` 里挂的若是上一个 viewer
           * 的 settle 闭包，新文档的第一次缩放会被判成「已有链在跑」而全部
           * 走合并分支、一次都不补偿 —— 表现为「这篇文献怎么缩放都没反应」，
           * 且日志里一条 zoom:anchor 都没有，很难往这个方向想。
           */
          zoomCompensationRef.current = null
          zoomPendingRef.current = false
          pendingMergedRef.current = 0
          zoomAnchorRef.current = null
          zoomAnchorRecentRef.current = { capturedAt: 0, anchor: null }
          try { viewer?.destroy?.() } catch { /* 已销毁 */ }
          viewerRef.current = null
          eventBusRef.current = null
        }
      }, [status, itemKey, reloadToken, pushHop])

      /**
       * 缩放 state → 官方 viewer。
       *
       * 只在「用户显式改了缩放值」时把数字写回 viewer。
       * 两种情况下不写：
       *   1. 当前处于 page-width / page-fit 这类自适应模式 —— 写死数字会让它
       *      在侧栏宽度变化后不再跟手（这正是「适应按钮点了偏大」的另一半原因）。
       *   2. 这次 scale 就是 viewer 自己抛出来的（scalechanging），写回去是空转。
       */
      useEffect(() => {
        const viewer = viewerRef.current
        if (!viewer || status !== 'ready') return
        // 自适应模式下不覆盖官方算出来的比例
        if (fitModeRef.current) return
        if (Math.abs(viewer.currentScale - scale) < 0.001) {
          lastAppliedScaleRef.current = scale
          return
        }
        // 只有当这次 scale 不是 viewer 自己发出来的，才写回去
        if (Math.abs(lastAppliedScaleRef.current - scale) < 0.001) return
        /**
         * **以光标所在点为原点缩放。**
         *
         * 先澄清 pdf.js 的默认行为，它决定了我们要做什么、不做什么：
         * #setScaleUpdatePages 确实会保位，但保的是「页号 + 页内偏移」这个
         * **文档锚点**，它滚完之后页面顶部与视口顶部对齐 —— 也就是
         * 「当前页贴顶」。这不是用户要的：用户要的是指针下的那个文档坐标点
         * 在屏幕上原地不动（GeoGebra / 地图 / 图片查看器的标准行为）。
         * 两者只在「视口顶部正好压在页首」时才碰巧一致，其余时候差得很远。
         *
         * 上一轮曾按「页号 + 页内顶部比例」做回滚，那正是把它做成了页面锚点，
         * 所以修完的表现是「以当前页贴顶缩放」—— 方向错了，已整体替换。
         *
         * 正确做法：缩放前记下指针处的（页, nx, ny）与屏幕坐标，写完 scale、
         * 等 pdf.js 重排稳定后，把该点重新对回原屏幕坐标（见 applyZoomAnchor）。
         */
        /**
         * 锚点分两层（原因见 zoomAnchorRecentRef 的注释）：
         *   · 基准锚点 zoomAnchorRef —— 整段手势共用，不在补偿时清掉；
         *   · 待补偿标记 zoomPendingRef —— 只决定要不要跑补偿链。
         *
         * 这样连续滚轮时，无论 effect 被触发几次，基准点始终是用户最初
         * 注视的那个物理位置；每次补偿都用**当次 scale** 重算绝对目标，
         * 因此不存在「上次的残差叠上来」导致的振荡。
         */
        /**
         * 先把「这次要不要补、补哪个点」读出来，再动 scale。
         *
         * 读顺序有意义：写完 currentScale 之后页面几何立刻开始变，虽然
         * 这里读的是 ref（不受几何影响），但把判定放在写之前，能保证
         * 「判定依据 = 用户缩放前的那一刻」，也避免后来人误以为锚点是在
         * 新几何上取的。
         */
        if (!zoomPendingRef.current) return
        const zoomAnchor = zoomAnchorRef.current
        if (!zoomAnchor) return
        lastAppliedScaleRef.current = scale
        viewer.currentScale = scale
        /**
         * 补偿链是**单条链式重排**，不是「每次 effect 各排一个队列」：
         * 已经有链在跑时只更新标记，由链的下一拍读到最新 scale。
         * 被合并掉的那些轮次要留下计数，随下一次补偿写进诊断 ——
         * 否则用户看到 zoom:anchor 条数比 wheel 次数少，无法判断是合并还是漏了。
         */
        if (zoomCompensationRef.current != null) {
          pendingMergedRef.current += 1
          return
        }
        /**
         * 等 pdf.js 把重排走完再补偿，两跳 rAF：
         *   第一跳 —— pdf.js 的 pageView.update() 已排队但布局可能还没落定；
         *   第二跳 —— 此时的 getBoundingClientRect 才是新 scale 下的真几何。
         */
        const settle = (n) => {
          zoomCompensationRef.current = settle
          if (n > 0) {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => settle(n - 1))
            else setTimeout(() => settle(n - 1), 16)
            return
          }
          /**
           * **补偿改的是滚动位置，而滚动会让 pdf.js 的保位基准跟着变。**
           *
           * 补偿会改 scrollTop，pdf.js 的 watchScroll 随之把 `_staleLocation`
           * 置真，于是下一次 #setScaleUpdatePages 会先按 `_getVisiblePages()`
           * 重新取一次 `_location`。若那次保位恰好落在我们的两次补偿之间，
           * 它就会照着一个「刚被我们改过的位置」去滚 —— 两次补偿方向相反，
           * 正是日志里 dy 在 +1031/−1029 之间翻转的成因。
           *
           * 对策两条：
           *   ① 同一次补偿只做一次（上面已用单条链保证），不做无条件的
           *      「补到对为止」，避免和它来回抢；
           *   ② 手势仍在继续时才追一轮，且追的每一轮都按**最新 scale** 重算
           *      绝对目标（applyZoomAnchor 内部是 `want - client`，不是在上一轮
           *      结果上累加），所以既不会越过、也不会反向。
           */
          const host = hostRef.current
          if (!host) { zoomCompensationRef.current = null; return }
          const moved = applyZoomAnchor(host, zoomAnchor)
          const mergedCount = pendingMergedRef.current
          pendingMergedRef.current = 0
          if (moved) {
            zoomAtRef.current = perf.now()
            reportDiag({
              event: 'zoom:anchor',
              page: zoomAnchor.pageNo,
              nx: Number(zoomAnchor.nx.toFixed(4)),
              ny: Number(zoomAnchor.ny.toFixed(4)),
              dx: Number(moved.dx.toFixed(1)),
              dy: Number(moved.dy.toFixed(1)),
              merged: mergedCount,
            })
          }
          /**
           * **继续追还是收手，只看「还是不是同一个手势」。**
           *
           * 手势还在继续（最近一次捕获距现在不足 ZOOM_GESTURE_GAP_MS）时再排一轮，
           * 读到的就是最新 scale。手势结束后不再重排：pdf.js 自己的保位足够，
           * 多补反而会和它抢。
           */
          const gestureLive = perf.now() - zoomAnchorRecentRef.current.capturedAt < ZOOM_GESTURE_GAP_MS
          zoomPendingRef.current = false
          if (gestureLive && pendingMergedRef.current > 0) {
            settle(1)
            return
          }
          zoomCompensationRef.current = null
          // 手势彻底结束时释放基准锚点，下一次缩放重新捕获
          if (!gestureLive) {
            zoomAnchorRef.current = null
            zoomAnchorRecentRef.current = { capturedAt: 0, anchor: null }
          }
        }
        settle(2)
      }, [scale, status])

      /**
       * 给第 pageNo 页叠加 Zotero 批注与高亮。
       *
       * 官方 viewer 的页面结构是 .page[data-page-number]，里面有一个
       * .canvasWrapper 和一个 .textLayer。我们把浮层插进 .page，
       * 坐标用页面的 CSS 尺寸换算 —— 这样缩放由官方处理，我们只按当前比例重算。
       */
      const decoratePage = useCallback((pageNo) => {
        const host = hostRef.current
        if (!host) return
        const pageEl = host.querySelector(`.page[data-page-number="${pageNo}"]`)
        if (!pageEl) return

        const pw = pageEl.clientWidth || pageEl.offsetWidth || 0
        const ph = pageEl.clientHeight || pageEl.offsetHeight || 0
        if (pw <= 0 || ph <= 0) return

        /**
         * **内容没变就别重建 DOM。**
         *
         * 原本每次调用都是 `layer.innerHTML = ''` 再全量重建。可这个函数被调得
         * 很频繁（每页画完一次、批注数据到货一次、选中变化一次……），而
         * **绝大多数时候这一页的批注根本没变** —— 于是每次都在做
         * 「清空 + 重建 N 个 div」，白写一大堆 DOM。
         *
         * 写入的代价不只是创建节点：它会弄脏布局，紧跟着 pdf.js 或我们自己的
         * 几何读取就要付一次强制重排。这跟文本层排序叠加起来，就是滑动时
         * 每页卡好几秒的另一半原因。
         *
         * 用「页号 + 缩放 + 高亮 + 批注快照」做签名，相同就整体跳过。
         * 序号变化（新增/删除/改色）会改变签名，所以不会漏刷。
         *
         * **不要再把 pw/ph 放进签名。** 原来签名里有 Math.round(pw)、Math.round(ph)，
         * 而缩放过程中每页尺寸是连续变化的：滚轮一次能连抛十几条 scalechanging，
         * 每一帧的 clientWidth 都不一样，签名于是帧帧失效 —— 批注层被反复
         * `innerHTML = ''` 再全量重建，正是「缩放时又卡又闪」的直接来源。
         * 位置真正依赖的是**缩放比**（pageHeightPt * k 就还原出全部坐标），
         * 尺寸只是它的派生量，所以签名记缩放，不记尺寸。
         * 拿不到官方 viewport 时才退回按 pw 反算 —— 那是同一套语义的退路。
         */
        const pageScale = (() => {
          try {
            const pv = viewerRef.current?.getPageView?.(pageNo - 1)
            if (pv?.scale > 0) return Number(pv.scale.toFixed(4))
          } catch { /* 退回下面的估算 */ }
          const base = pageSizesRef.current.get(pageNo)
          return base?.w > 0 ? Number((pw / base.w).toFixed(4)) : 0
        })()
        const sig = [
          pageNo,
          pageScale,
          highlight && highlight.page === pageNo ? JSON.stringify(highlight.rects) : '',
          annotationsRef.current
            .filter((a) => a.pageIndex === pageNo - 1)
            .map((a) => `${a.key}:${a.color}:${a.type}:${(a.rects || []).length}`)
            .join('|'),
        ].join('#')
        if (decorateSigRef.current.get(pageNo) === sig) return

        let layer = pageEl.querySelector('.zr-annot-layer')
        if (!layer) {
          layer = document.createElement('div')
          layer.className = 'zr-annot-layer'
          pageEl.appendChild(layer)
        }
        decorateSigRef.current.set(pageNo, sig)
        layer.innerHTML = ''

        /**
         * 换算比例：**从官方 viewport 取**，不要自己用 clientWidth 算。
         *
         * 官方 viewer 的每个页面视图有 `viewport`（已含缩放与旋转）。
         * viewport 宽 / PDF 原始宽 = 精确的 CSS 每 pt 像素数，
         * 而 clientWidth 含 padding、不含边框，与真实可视区总有出入 ——
         * 那个出入就是「高亮块位置偏一点」的来源之一。
         *
         * 拿不到 viewport 时才退回 clientWidth 估算。
         */
        let scaleForAnnotations = 0
        let pageHeightPtFromViewport = 0
        try {
          const pv = viewerRef.current?.getPageView?.(pageNo - 1)
          const vp = pv?.viewport
          const base = pageSizesRef.current.get(pageNo)
          if (vp && base && base.w > 0) {
            scaleForAnnotations = vp.width / base.w
            pageHeightPtFromViewport = base.h
          }
        } catch { /* 退回下面的估算 */ }

        // 高亮（来自会话里的页码跳转）
        if (highlight && highlight.page === pageNo) {
          for (const r of highlight.rects ?? []) {
            const box = document.createElement('div')
            box.className = 'zr-hl'
            box.style.left = `${r.x}px`
            box.style.top = `${r.y}px`
            box.style.width = `${r.w}px`
            box.style.height = `${r.h}px`
            layer.appendChild(box)
          }
        }

        /**
         * Zotero 批注。
         *
         * rects 是 PDF 坐标（原点左下、单位 pt），页面是 CSS 像素（原点左上）。
         * 换算比例 = 当前页 CSS 宽 / PDF 页宽（pt）。
         * port 是 PDF 点位对应的 CSS 单位系数，官方 viewer 也用它。
         */
        const list = annotationsRef.current.filter((a) => a.pageIndex === pageNo - 1)
        if (list.length === 0) return
        const pdfPageWidthPt = pageNo && pageSizesRef.current.get(pageNo)?.w
        if (!pdfPageWidthPt) return
        /**
         * 用官方 viewport 算出的精确比例；拿不到才退回 clientWidth 估算。
         */
        const k = scaleForAnnotations > 0 ? scaleForAnnotations : (pw / pdfPageWidthPt)
        const pageHeightPt = pageHeightPtFromViewport > 0
          ? pageHeightPtFromViewport
          : (pageSizesRef.current.get(pageNo)?.h ?? 0)

        reportDiag({
          event: 'annot:scale',
          pageNo,
          scaleFromViewport: Number(scaleForAnnotations.toFixed(4)),
          scaleFromClientWidth: Number((pw / pdfPageWidthPt).toFixed(4)),
          k: Number(k.toFixed(4)),
          pageHeightPt: Number(pageHeightPt.toFixed(2)),
          count: list.length,
        })

        for (const a of list) {
          try {
            const color = a.color || '#ffd400'
            /**
             * 按批注类型选画法：
             *   highlight —— 半透明底色块（Zotero 里也是这个观感）
             *   underline —— 只画底边线，不铺底色
             *   note      —— 22pt 的方块角标（与 Zotero 阅读器里的便签同形）
             * 其它类型（image/ink/text）暂时仍按底色块降级显示。
             */
            const kind = a.type || 'highlight'
            for (const r of a.rects ?? []) {
              if (!Array.isArray(r) || r.length < 4) continue
              const [x1, y1, x2, y2] = r
              if (![x1, y1, x2, y2].every((n) => Number.isFinite(Number(n)))) continue
              const box = document.createElement('div')
              box.className = kind === 'underline'
                ? 'zr-annot-underline'
                : (kind === 'note' ? 'zr-annot-note' : 'zr-annot')
              const left = Math.min(x1, x2) * k
              const w = Math.abs(x2 - x1) * k
              const h = Math.abs(y2 - y1) * k
              const top = (pageHeightPt - Math.max(y1, y2)) * k
              box.style.left = `${left}px`
              box.style.top = `${top}px`
              box.style.width = `${w}px`
              box.style.height = `${h}px`
              /**
               * 身份标记：一个批注可能有多行 rect，每行一个 div，都带同一个 key。
               *
               * 交互层（选中 / 右键 / 删除）全部靠它反查批注，走事件委托，
               * 所以装饰层重画时不用重挂监听 —— 监听挂在 host 上，与 div 无关。
               * pageNo 一起记下来：删除后要按页重画，不必再从数据里推。
               */
              box.dataset.annotKey = a.key
              box.dataset.annotPage = String(pageNo)
              // 选中外框不画在每个 rect 上（多行会变成一串小框），
              // 统一由 paintAnnotSelection 在层里放一个包围盒
              if (kind === 'underline' || kind === 'note') {
                box.style.color = color
                /**
                 * 便签还要按批注颜色铺一层半透明底。
                 *
                 * 这条原来的填充写死在 CSS 里（一片黄），只改 border-color 的话
                 * 改色后「边框变了、底色还是黄的」，看着像没改干净。
                 * 这里用 color + 88（约 53% 透明）与高亮块保持同一套取值方式。
                 */
                if (kind === 'note') box.style.background = `${color}2e`
              } else {
                box.style.background = `${color}88`
              }
              layer.appendChild(box)
            }
          } catch (annotError) {
            reportDiag({
              event: 'annotations:single-failed',
              key: a?.key ?? null,
              message: String(annotError?.message ?? annotError),
            })
          }
        }
      }, [highlight])

      // 把最新的 decoratePage 挂到 ref 上，供前面声明过的 viewer effect 调用
      decoratePageRef.current = decoratePage

      /**
       * 批注数据到货后补画一次。
       *
       * 批注是独立请求，通常晚于页面渲染返回。官方 viewer 只在页面画完时抛
       * pagerendered，不会因为我们的数据更新而重画 —— 不补这一次，批注就不会出现。
       * 只处理 DOM 里已经存在的页（官方 viewer 是虚拟化的，没渲染的页不在 DOM 里）。
       */
      useEffect(() => {
        if (status !== 'ready') return
        const host = hostRef.current
        if (!host) return
        for (const el of host.querySelectorAll('.page[data-page-number]')) {
          const pageNo = Number(el.dataset.pageNumber)
          if (Number.isFinite(pageNo) && pageNo > 0) decoratePage(pageNo)
        }
        // 层被重建过，选中外框要补回来
        paintSelectRef.current?.(annotSelectedRef.current)
      }, [annotVersion, status, decoratePage])


      /* ---------- 批注选中 / 卡片 / 删除 ---------- */
      /**
       * 把「选中外框」刷成**一个**包围盒。
       *
       * 一条跨行批注在 DOM 里是多个 rect div（每行一个），逐个描边就会变成
       * 一串小方框 —— 用户要的是 Zotero 那种「整条一个长方形」。所以这里
       * 算出同一 key 的所有 div 的联合包围盒，在最外层 .zr-annot-layer 里
       * 放一个空 div 描边，原 div 本身不加任何装饰。
       *
       * 包围盒用 getBoundingClientRect 的视口坐标减去层自身的视口原点到
       * 层坐标，这样不受层在页面里的绝对位置影响；层是 position:absolute
       * 铺满整页的，所以层坐标 = 页面内坐标。
       */
      const paintAnnotSelection = useCallback((key) => {
        const host = hostRef.current
        if (!host) return
        // 先清掉上一轮的框（可能跨页、也可能在别的页上）
        for (const old of host.querySelectorAll('.zr-annot-select')) old.remove()
        if (!key) return
        for (const layer of host.querySelectorAll('.zr-annot-layer')) {
          const boxes = Array.from(layer.querySelectorAll('[data-annot-key]'))
            .filter((el) => el.dataset.annotKey === key)
          if (boxes.length === 0) continue
          const layerRect = layer.getBoundingClientRect()
          let left = Infinity
          let top = Infinity
          let right = -Infinity
          let bottom = -Infinity
          for (const el of boxes) {
            const r = el.getBoundingClientRect()
            if (!r.width && !r.height) continue
            left = Math.min(left, r.left)
            top = Math.min(top, r.top)
            right = Math.max(right, r.right)
            bottom = Math.max(bottom, r.bottom)
          }
          if (!Number.isFinite(left) || !Number.isFinite(top)) continue
          const outline = document.createElement('div')
          outline.className = 'zr-annot-select'
          outline.dataset.annotSelectFor = key
          outline.style.left = `${left - layerRect.left}px`
          outline.style.top = `${top - layerRect.top}px`
          outline.style.width = `${Math.max(0, right - left)}px`
          outline.style.height = `${Math.max(0, bottom - top)}px`
          layer.appendChild(outline)
          return
        }
      }, [])
      /*
       * decoratePage 每次 innerHTML='' 会把选中外框一起清掉，
       * 重画后必须补一个。它声明在 paintAnnotSelection 之前，只能走 ref 调用；
       * 这条赋值必须写在 paintAnnotSelection 声明**之后**，否则渲染期就是 TDZ。
       */
      paintSelectRef.current = paintAnnotSelection

      const selectAnnotation = useCallback((key) => {
        annotSelectedRef.current = key ?? null
        setAnnotSelected(key ?? null)
        paintAnnotSelection(key ?? null)
      }, [paintAnnotSelection])

      /**
       * 真正从 Zotero 里删一条批注。
       *
       * 成功静默：用户明确要求不要「已删除」这类回执，删掉就是删掉了。
       * 失败必须说话 —— 否则用户以为删了，下次打开又冒出来，只会更困惑。
       *
       * @param {string} key 批注 key
       * @param {number} pageNo 1-based 页码，用于立刻重画那一页；0 表示未知，整体重画
       */
      const deleteAnnotationByKey = useCallback(async (key, pageNo) => {
        if (!key) return false
        // 长按 Delete、连点菜单都会重复触发；ref 是同步的，能挡住同一 tick 的第二次
        if (annotDeletingRef.current) return false
        annotDeletingRef.current = key
        setAnnotDeleting(key)
        try {
          await fetchJson(`${API}/annotations?annotKey=${encodeURIComponent(key)}`, {
            method: 'DELETE',
          })
          // 先拉最新数据，再重画：只重画不拉数据的话，下一次自动重画会把它画回来
          await loadAnnotationsFromZotero()
          annotSelectedRef.current = null
          setAnnotSelected(null)
          /**
           * 卡片和三点菜单必须一起关掉。
           *
           * 它们锚在「某一条批注」上，批注被删掉之后卡片就没有宿主了 ——
           * 不关的话它会继续浮在原地，显示的是一条已经不存在的批注（用户实测到过）。
           * 顺便把菜单也清了：从菜单点删除时，菜单本身也该消失。
           */
          setAnnotPanel(null)
          setAnnotMenu(null)
          if (pageNo > 0) {
            decoratePage(pageNo)
          } else {
            const host = hostRef.current
            for (const el of host?.querySelectorAll('.page[data-page-number]') ?? []) {
              const n = Number(el.dataset.pageNumber)
              if (Number.isFinite(n) && n > 0) decoratePage(n)
            }
          }
          reportDiag({ event: 'annot:deleted', key, pageNo: pageNo || null })
          return true
        } catch (err) {
          setPop({
            x: 24, y: 24, loading: false, title: '删除失败',
            text: String(err?.message ?? err),
          })
          return false
        } finally {
          annotDeletingRef.current = null
          setAnnotDeleting(null)
        }
      }, [loadAnnotationsFromZotero, decoratePage])

      /**
       * 卡片（主面板）的开合。
       *
       * 从被点中的 rect div 反推包围盒，据此决定卡片贴在哪：
       *   优先放在批注右侧（Zotero 也是这个方向），右边的空间不够就翻到左侧；
       *   垂直方向让卡片的上沿对齐包围盒的上沿，再夹进视口。
       * 位置在打开那一刻算定 —— 卡片开着时批注不会移动，滚动则直接关闭。
       *
       * 页码取 `data-annot-page`（本地 1-based），和 Zotero 面板上的「页 N」一致。
       */
      const openAnnotPanel = useCallback((key, pageNo, hitEl) => {
        const CW = 300                       // 与 CSS .zr-annot-card 的 width 一致
        const CH = 240                       // 估算高度，只用于夹取和翻方向
        const GAP = 12                       // 卡片与包围盒之间的间距（留给小三角）
        const M = 8                          // 视口留白
        let left = M
        let top = M
        let place = 'right'
        let arrowY = 40                       // 三角在卡片内的纵向位置
        try {
          if (hitEl) {
            const layer = hitEl.closest('.zr-annot-layer')
            const boxes = layer
              ? Array.from(layer.querySelectorAll('[data-annot-key]'))
                .filter((el) => el.dataset.annotKey === key)
              : [hitEl]
            let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity
            for (const el of boxes) {
              const box = el.getBoundingClientRect()
              if (!box.width && !box.height) continue
              l = Math.min(l, box.left); t = Math.min(t, box.top)
              r = Math.max(r, box.right); b = Math.max(b, box.bottom)
            }
            if (Number.isFinite(l)) {
              const vw = window.innerWidth || 1280
              const vh = window.innerHeight || 800
              /**
               * **垂直优先：默认贴在批注下方，下方放不下才翻到上方。**
               *
               * 之前是「优先贴右侧」（照 Zotero 的桌面版），但在右栏这种窄容器里
               * 右侧根本没有 300px 的空间，等于每次都被迫翻到左侧 ——
               * 用户看到的就是「框跑到了左边」。改成上下排布更符合窄栏的实际。
               *
               * 水平仍以批注为中心对齐，再夹进视口。
               */
              const centeredX = (l + r) / 2 - CW / 2
              left = Math.max(M, Math.min(centeredX, vw - CW - M))

              place = 'below'
              if (b + GAP + CH <= vh - M) {
                top = b + GAP                              // ① 下方（默认）
              } else if (t - GAP - CH >= M) {
                top = t - GAP - CH                         // ② 下方放不下，翻到上方
                place = 'above'
              } else {
                top = Math.max(M, vh - CH - M)             // ③ 都放不下，贴底
              }
              // 三角对准包围盒水平中心（相对卡片左沿），夹在卡片内
              arrowY = Math.max(16, Math.min(CW - 16, (l + r) / 2 - left))
            }
          }
        } catch { /* 包围盒取不到就用默认位置 */ }
        setAnnotPanel({ key, pageNo: pageNo || 0, left, top, place, arrowY })
        setAnnotMenu(null)
        reportDiag({ event: 'annot:panel-open', key, pageNo: pageNo || 0, place })
      }, [])

      /**
       * 点击 / 右键的委托入口。
       *
       * 委托挂在 host 上而不是每条批注各挂一个：`decoratePage` 每次 `layer.innerHTML = ''`
       * 重建全部 div，逐元素绑定会跟着失效；委托一次就永远指向当前 DOM。
       *
       * 与划词链路互不干扰：批注元素 pointer-events:auto 只遮住它自己那一块，
       * 鼠标落不到下面的 textLayer，不会产生选区 —— mouseup 那条链读到空选区后自行退出。
       */
      useEffect(() => {
        const host = hostRef.current
        if (!host || status !== 'ready') return undefined

        const hitAnnotation = (event) => {
          const el = event.target?.closest?.('[data-annot-key]')
          if (!el || !host.contains(el)) return null
          return {
            key: el.dataset.annotKey,
            pageNo: Number(el.dataset.annotPage) || 0,
            el,
          }
        }

        /**
         * 左键点批注 = 选中 + 弹出卡片（Zotero 的主路径）。
         * 再点同一条 = 收起，和 Zotero 一样是开关。
         */
        const onClick = (event) => {
          // 便签工具激活时，这一次点击的语义是「落点」，不是「选批注」
          if (annotTool === 'note') return
          if (event.button !== 0) return
          const hit = hitAnnotation(event)
          if (!hit) {
            // 点空白处 = 取消选中并收起卡片（三点菜单由它自己的监听负责）
            if (annotSelectedRef.current) selectAnnotation(null)
            closeAnnotPanel()
            setAnnotMenu(null)
            return
          }
          event.preventDefault()
          event.stopPropagation()
          if (annotSelectedRef.current === hit.key) {
            selectAnnotation(null)
            closeAnnotPanel()
            setAnnotMenu(null)
            return
          }
          selectAnnotation(hit.key)
          openAnnotPanel(hit.key, hit.pageNo, hit.el)
        }

        /**
         * 右键保留为备选路径：直接开卡片（不再弹旧的右键小菜单）。
         * 用户的主路径是左键，但右键点在批注上给同一个面板更不容易让人困惑。
         */
        const onContextMenu = (event) => {
          if (annotTool === 'note') return
          const hit = hitAnnotation(event)
          if (!hit) {
            setAnnotMenu(null)
            closeAnnotPanel()
            return
          }
          event.preventDefault()
          selectAnnotation(hit.key)
          openAnnotPanel(hit.key, hit.pageNo, hit.el)
        }

        host.addEventListener('click', onClick)
        host.addEventListener('contextmenu', onContextMenu)
        return () => {
          host.removeEventListener('click', onClick)
          host.removeEventListener('contextmenu', onContextMenu)
        }
      }, [annotTool, selectAnnotation, openAnnotPanel, status])

      /**
       * Delete / Backspace 删除选中的批注。
       *
       * 挂 document（选中后焦点可能在任何地方），但必须避开输入框 ——
       * 页码框里按 Backspace 是删数字，不是删批注。
       */
      useEffect(() => {
        if (!annotSelected) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Delete' && event.key !== 'Backspace') return
          if (event.metaKey || event.ctrlKey || event.altKey) return
          const target = event.target
          if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
          const key = annotSelected
          if (!key) return
          event.preventDefault()
          event.stopPropagation()
          // 页码优先从数据里取：页面可能已被虚拟化移出 DOM，DOM 回溯会拿不到
          const annot = annotationsRef.current.find((a) => a.key === key)
          const pageNo = annot ? (annot.pageIndex ?? 0) + 1 : 0
          void deleteAnnotationByKey(key, pageNo)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [annotSelected, deleteAnnotationByKey])

      /**
       * 卡片 / 三点菜单的关闭方式：点外部、Esc、页面滚动。
       *
       * 点面板内部不关（要在输入框和菜单里操作），所以按 closest 判断；
       * 卡片和菜单是两个独立浮层，点击它们其中任何一个都不该关掉另一个，
       * 但点页面空白处要一起收起来。
       *
       * 滚动也要关：浮层是 fixed 定位，批注跟着内容滚走之后面板就指错了对象。
       */
      useEffect(() => {
        if (!annotMenu && !annotPanel) return undefined
        const onDown = (event) => {
          const inMenu = event.target?.closest?.('.zr-annot-menu')
          const inCard = event.target?.closest?.('.zr-annot-card')
          if (inMenu || inCard) return
          /*
           * 点在批注本身上时**不要**在这里关：
           * mousedown 先于 click，这里一关就会把 annotSelectedRef 清成 null，
           * 紧接着的 click 读到「当前没有选中」，把「再点一次收起」错判成
           * 「第一次选中」，于是点同一条永远收不起来。交给 click 的开关逻辑。
           */
          if (event.target?.closest?.('[data-annot-key]')) return
          if (annotMenu) setAnnotMenu(null)
          if (annotPanel) {
            closeAnnotPanel()
            selectAnnotation(null)
          }
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (annotMenu) setAnnotMenu(null)
          if (annotPanel) {
            closeAnnotPanel()
            selectAnnotation(null)
          }
        }
        const onScroll = () => {
          if (annotMenu) setAnnotMenu(null)
          if (annotPanel) {
            closeAnnotPanel()
            selectAnnotation(null)
          }
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        // capture：滚动发生在 .zr-pdfviewer-container 上，不冒泡到 document
        document.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('scroll', onScroll, true)
        }
      }, [annotMenu, annotPanel, selectAnnotation])

      /* ---------- 页码跳转 + 高亮 ---------- */
      /**
       * 取「阅读区视口中心」作为缩放锚点。
       *
       * +/- 按钮和「适应宽度」没有指针位置可用，但用户按下它们时眼睛盯的
       * 是阅读区中间那块内容。若不给锚点，这两条路径就会退回 pdf.js 的
       * 「当前页贴顶」保位 —— 那是本次要修掉的行为，所以按钮路径同样要锚定，
       * 只是锚点取视口中心而不是鼠标点。
       *
       * 取容器的 bounding rect 而不是 host：host 是 overflow:hidden 的外框，
       * 与真正可滚的 .zr-pdfviewer-container 通常重合，但以可滚层为准更稳。
       */
      const captureCenterZoomAnchor = useCallback(() => {
        const host = hostRef.current
        if (!host) return null
        const r = host.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return null
        return captureZoomAnchor(host, r.left + r.width / 2, r.top + r.height / 2)
      }, [])

      const gotoPage = useCallback((pageNo, rects) => {
        const target = Math.max(1, Math.min(pageNo, pageCount || pageNo))
        /**
         * **跳转前先记住当前在哪。**
         *
         * 缺口放在这里，而不是每个调用方各写一遍：页码输入框、上/下一页、
         * 大纲条目、批注列表、会话里的页码点击**全都**收敛到 gotoPage，
         * 在这里挂一次就全覆盖了；将来再加入口也自动带上历史。
         *
         * 只压「真的会移动」的跳转：target 等于当前页时（用户按了「»」到末尾页
         * 已经到底、或点大纲里就是当前页的那条）不值得占一格历史 ——
         * 否则「点了没动」也会让返回按钮亮起来，退一步还是在原地。
         */
        const fromPage = (() => {
          try { return viewerRef.current?.currentPageNumber ?? 0 } catch { return 0 }
        })()
        if (target !== fromPage) pushHop()
        setJumpPage(target)
        setHighlight(rects ? { page: target, rects } : null)

        const viewer = viewerRef.current
        if (!viewer) return

        /**
         * 跳页有两条路，缺一条就会静默失败。
         *
         * 1) 官方 viewer 的 currentPageNumber：更新内部页码、按需渲染周围页。
         *    它内部按自己的 container 与页元素的 offsetParent 链滚动；
         *    侧栏里外层容器 overflow:hidden、scrollHeight === clientHeight，
         *    那条链落在一个永远不滚的节点上，滚动被静默丢弃（不抛错、不生效）。
         *    实测日志：hasScroller 为真，但 scrollerTop 恒为 0、
         *    scrollHeight === clientHeight === 716，页面纹丝不动，
         *    用户看到的就是「输入页码回车没反应」。
         * 2) 自己把页元素滚到视野顶部：只依赖 DOM 几何，绕开上面那条链。
         */
        /**
         * 滚到目标页。实现已抽到模块级 `scrollPageIntoView()`，
         * 因为加载时恢复阅读位置也要走同一条几何路径 —— 之前两处各写一份，
         * 恢复那条漏了滚动，于是出现「页码显示第 4 页、视图停在第 1 页」。
         */
        const scrollToPage = () => scrollPageIntoView(hostRef.current, target, 0)

        try { viewer.currentPageNumber = target } catch { /* 非整数页码等，忽略 */ }
        scrollToPage()

        /**
         * 布局未落定时页元素刚建出来、位置还会变，一次写不进去就重试几次。
         * 带令牌停止：连按回车只有最后一次生效，成功即停，不和用户手动滚动抢位置。
         */
        const token = ++jumpSeqRef.current
        /**
         * 跳页探针：从点击到「新页真的画出来」花了多久。
         * 完成判据用 pagerendered（canvas 真画完时触发），不是定时器 ——
         * 定时器会被主线程堵塞推迟，正好把「卡」掩盖掉。
         */
        const jumpWin = perf.windowOpen()
        // 从 viewer 直接读当前页，避免把 visiblePage 加进 deps
        // （那会让 gotoPage 每次翻页重建，反而多一轮重渲染，污染测量）
        const jumpFrom = (() => {
          try { return viewerRef.current?.currentPageNumber ?? 0 } catch { return 0 }
        })()
        let jumpDone = false
        const onJumpPaint = (ev) => {
          if (jumpDone || ev.pageNumber !== target) return
          jumpDone = true
          try { eventBusRef.current?.off?.('pagerendered', onJumpPaint) } catch { /* 忽略 */ }
          perf.attribute('jump-page', jumpWin)
          perf.summary('jump', { from: jumpFrom, to: target })
        }
        try {
          if (target !== jumpFrom) eventBusRef.current?.on?.('pagerendered', onJumpPaint)
        } catch { /* 忽略 */ }

        let tries = 0
        const retry = () => {
          if (token !== jumpSeqRef.current) return
          if (tries++ >= 10) return
          try { if (viewer.currentPageNumber !== target) viewer.currentPageNumber = target } catch { /* 忽略 */ }
          if (!scrollToPage()) requestAnimationFrame(() => setTimeout(retry, 120))
        }
        requestAnimationFrame(() => setTimeout(retry, 60))
      }, [pageCount, pushHop])

      /* ---------- 滚动性能探针 ---------- */
      useEffect(() => {
        if (status !== 'ready') return undefined
        const host = hostRef.current
        if (!host) return undefined
        /**
         * 挂到真正吃滚动的那一层（.pdfViewer），按几何找，不写死 class。
         * 滚动本身不产生长任务，卡的是滚动过程中触发的重渲染/重排，
         * 所以这里用帧间隔 + 长任务来度量，滚动停止 400ms 后汇总一条。
         */
        const scroller = host.querySelector('.pdfViewer') ?? findScrollParent(host)
        if (!scroller) return undefined
        let timer = null
        let scrolls = 0
        const onScroll = () => {
          scrolls += 1
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            if (scrolls >= 3) perf.summary('scroll', { scrollEvents: scrolls, scrollerTop: Math.round(scroller.scrollTop) })
            scrolls = 0
          }, 400)
        }
        scroller.addEventListener('scroll', onScroll, { passive: true })
        return () => {
          scroller.removeEventListener('scroll', onScroll)
          if (timer) clearTimeout(timer)
        }
      }, [status])

      /* ---------- 全局跳转请求（来自会话里的页码点击） ---------- */      useEffect(() => {
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
            /**
             * 页面元素从官方 viewer 的 DOM 里取（`.page[data-page-number]`），
             * 不再有自建 pageElsRef。每页的 CSS 高度除以当前 scale
             * 就是该页在 PDF 里的 pt 高度，用它把 CSS 坐标换回 PDF 坐标。
             */
            const host = hostRef.current
            const pageEls = host
              ? Array.from(host.querySelectorAll('.page[data-page-number]'))
                .map((el) => ({
                  pageNo: Number(el.dataset.pageNumber),
                  el,
                  box: el.getBoundingClientRect(),
                }))
                .filter((p) => Number.isFinite(p.pageNo) && p.pageNo > 0)
              : []

            const rects = range.getClientRects()
            const byPage = new Map()
            for (const cr of rects) {
              // 找到这个矩形落在哪一页
              for (const p of pageEls) {
                const box = p.box
                if (cr.top >= box.top - 2 && cr.bottom <= box.bottom + 2
                  && cr.left >= box.left - 2 && cr.right <= box.right + 2) {
                  if (!byPage.has(p.pageNo)) byPage.set(p.pageNo, { box, list: [] })
                  byPage.get(p.pageNo).list.push(cr)
                  break
                }
              }
            }
            if (byPage.size > 0) {
              const firstPage = Math.min(...byPage.keys())
              const { box, list } = byPage.get(firstPage)
              /**
               * CSS 像素 → PDF 点位的除数。
               *
               * **不能直接用 scale**：官方 viewer 渲染时，CSS 尺寸是
               *   scale × PDF_TO_CSS_UNITS(96/72 ≈ 1.333)
               * 换算过的。只用 scale 去还原，坐标会被放大 1.333 倍 ——
               * 越靠页顶的文字偏得越多，正是「高亮比文字高一截」的表现。
               *
               * 优先用官方 viewport 反推真实系数：
               *   realScale = viewport.width / PDF 原始宽度
               * 拿不到时退回 scale × 96/72。
               */
              let units = 0
              try {
                const pv = viewerRef.current?.getPageView?.(firstPage - 1)
                const vp = pv?.viewport
                const base = pageSizesRef.current.get(firstPage)
                if (vp && base?.w > 0) units = vp.width / base.w
              } catch { /* 退回下面的估算 */ }
              if (!(units > 0)) units = scale * (96 / 72)
              if (!(units > 0)) units = scale

              const cssHeight = box.height
              // 该页在 CSS 下的高度对应 PDF 的多少 pt
              const heightPt = cssHeight / units
              const raw = []
              for (const cr of list) {
                /**
                 * 跳过退化矩形。
                 *
                 * `getClientRects()` 在换行处会返回宽度为 0 的矩形（把行末算成另一段），
                 * 它们变成 PDF 坐标后就是 [0, y1, 0, y2] 这种零宽条目。
                 * 实测写入 Zotero 后 rects 里混着 `[0,487.62,0,500.74]`，
                 * 而 Zotero 会按所有矩形的并集算包围盒 —— 零宽矩形把 X 拉到 0，
                 * 于是批注框从页面左边缘开始，看起来「起点位置特别高/特别偏」。
                 */
                if (cr.width < 0.5 || cr.height < 0.5) continue
                const x1 = (cr.left - box.left) / units
                const x2 = (cr.right - box.left) / units
                const topPt = (cr.top - box.top) / units
                const botPt = (cr.bottom - box.top) / units
                // CSS 上原点 → PDF 下原点
                const y1 = heightPt - botPt
                const y2 = heightPt - topPt
                if (!(x2 > x1) || !(y2 > y1)) continue
                raw.push([
                  Number(x1.toFixed(2)), Number(y1.toFixed(2)),
                  Number(x2.toFixed(2)), Number(y2.toFixed(2)),
                ])
              }

              /**
               * 同一行的多个片段合并成一条，并且**高度统一成行内最小的那个**。
               *
               * 为什么取最小而不是并集：
               * `getClientRects()` 对一行文字会给出两类矩形 ——
               * 「行框」（含行距，实测高 15.58pt）和「文字框」（贴字形，实测 10.96pt）。
               * 两者重叠，取并集只会得到更高的行框高度，写进 Zotero 后
               * 高亮块比字形明显高一截，而且相邻行还会叠在一起。
               *
               * Zotero 自己产生的批注高度是 9.1–9.3pt（实测库里 E3TYCEMB 等条目），
               * 也就是贴着字形本身。所以这里同一行内取**最小高度**并用它作为整行的
               * 上下界，矩形数量和形态也更接近 Zotero 的原生批注。
               */
              raw.sort((a, b) => (b[3] - a[3]) || (a[0] - b[0]))
              const merged = []
              for (const r of raw) {
                const last = merged[merged.length - 1]
                // 垂直区间重叠超过一半就算同一行
                if (last) {
                  const overlap = Math.min(last[3], r[3]) - Math.max(last[1], r[1])
                  const minH = Math.min(last[3] - last[1], r[3] - r[1])
                  if (minH > 0 && overlap > minH * 0.5) {
                    const lastH = last[3] - last[1]
                    const rH = r[3] - r[1]
                    last[0] = Math.min(last[0], r[0])
                    last[2] = Math.max(last[2], r[2])
                    /**
                     * 高度取较小的那个，并以该行顶部对齐：
                     * 行框的顶部与文字框顶部基本重合，差异主要在底部（行距）。
                     */
                    if (rH < lastH) {
                      const top = Math.max(last[3], r[3])
                      last[3] = top
                      last[1] = top - rH
                    }
                    continue
                  }
                }
                merged.push([...r])
              }

              /**
               * 高度统一成「一个字形的视觉高度」。
               *
               * 为什么需要它：多行选区时首行常常拿到比其它行更高的矩形
               * （实测 16.98 vs 10.99），显示出来就是首行高亮明显比其余行肥。
               * Zotero 自己的批注每行高度一致（9.1–9.3pt），所以必须归一。
               *
               * 基准怎么取（两条路，优先第一条）：
               *   ① 文字层的实际字号 —— 单行选区也能正确收敛，
               *      这是唯一能处理「只有一个矩形」情形的办法；
               *   ② 所有矩形里的最小高度 —— 文字层取不到时的兜底，
               *      只在多行、且确实有行框/字形框混合时才有效。
               */
              /**
               * `inkTopFrac` / `inkBotFrac`：矩形高度里，顶部占比多少才开始有墨迹、
               * 底部占比多少之后已经没墨迹。0 表示没量到。
               */
              let inkTopFrac = 0
              let inkBotFrac = 0

              let glyphH = 0
              try {
                const pageHost = hostRef.current
                const pageEl2 = pageHost?.querySelector(`.page[data-page-number="${firstPage}"]`)
                const spans = pageEl2?.querySelectorAll('.textLayer span') ?? []
                if (spans.length > 0 && merged.length > 0) {
                  /**
                   * 用选区首行的垂直中心去找最接近的 span（决定字号与字体，
                   * 这是 canvas 墨迹测量的取样对象），比用 top 更稳：
                   * 首行的 top 常常因为行框而不准。
                   */
                  const selCenterCss = (
                    (heightPt - (merged[0][1] + merged[0][3]) / 2) * units
                  ) + box.top
                  let bestSpan = null
                  let bestDist = Infinity
                  for (const sp of spans) {
                    const r = sp.getBoundingClientRect()
                    if (!(r.height > 0)) continue
                    const d = Math.abs(r.top + r.height / 2 - selCenterCss)
                    if (d < bestDist) { bestDist = d; bestSpan = sp }
                  }
                  if (bestSpan) {
                    /**
                     * **先取字号，再量墨迹比例。**
                     *
                     * `glyphH` 是 half-leading 收缩的基准（`extra = h - emPt`），
                     * 必须是**这一行文字的字号**，不能是矩形高度。
                     *
                     * 之前这里漏了赋值：全文件只有下面那个兜底会给 glyphH 赋值，
                     * 取的是「所有矩形里的最小高度」。于是：
                     *   · 多行里有一行是文字框 → glyphH = 10 左右，看着还行；
                     *   · 整段都是行框 → glyphH 变成 14.34（行框本身的高度）；
                     * 这就是日志里 glyphH 在 9 / 10 / 14.34 之间漂移的原因，
                     * 而 `extra = h - glyphH` 一旦把 `emPt` 算错，
                     * 「这一行是不是行框」就判反了 —— 首末行位置偏移的根因在这里。
                     */
                    try {
                      const fsPx = parseFloat(getComputedStyle(bestSpan).fontSize) || 0
                      // CSS px → PDF pt
                      if (fsPx > 0) glyphH = fsPx / units
                    } catch { /* 取不到就走下面的兜底 */ }
                    /**
                     * 用 canvas 实测字形墨迹，不再拿 fontSize 当高度基准。
                     *
                     * 之前失败的原因：fontSize 是 em 尺寸，而矩形高度是浏览器的
                     * 字体内容盒（fontBoundingBoxAscent + Descent）。内容盒的
                     * ascent 里含有 ascender 之上的头部余量（Times 系约 0.21em），
                     * 这部分根本没有墨迹 —— 所以框一定比字高一截。
                     * 实测写进 Zotero 的矩形恒为 10.96pt，而同一 PDF 行距只有 7.5pt，
                     * 高度 > 行距，行间必然叠压，正是用户截图的现象。
                     *
                     * 做法：用 span 的真实字体把一段有代表性的字符画到 canvas 上量：
                     *   fontBoundingBox* → 内容盒（就是矩形高度）的上下沿，
                     *   actualBoundingBox* → 真实墨迹的上下沿。
                     * 得到的是纯比例，与缩放倍率、DPI 无关，换字体自动适配。
                     */
                    try {
                      const cs2 = getComputedStyle(bestSpan)
                      const cv = document.createElement('canvas')
                      const ctx2 = cv.getContext('2d')
                      if (ctx2 && cs2.fontSize) {
                        /**
                         * font 简写里任何一段是 undefined 都会让整串非法，
                         * 此时浏览器**静默忽略**赋值、退回默认字体继续量 ——
                         * 度量就会悄悄用错字体。所以每段都要给可用兜底。
                         */
                        const fStyle = cs2.fontStyle || 'normal'
                        const fWeight = cs2.fontWeight || '400'
                        const fFamily = cs2.fontFamily || 'serif'
                        ctx2.font = `${fStyle} ${fWeight} ${cs2.fontSize} ${fFamily}`
                        // 赋值后回读一次，确认浏览器真的采纳了这个字体
                        const appliedFont = ctx2.font || ''
                        // 同时取到上伸部（l/H）与下伸部（g/p/q/y），
                        // 避免正好选到 "average" 这类无上伸的字时墨迹被量矮
                        const m = ctx2.measureText('Hdlxgpqy')
                        const fA = Math.abs(m.fontBoundingBoxAscent || 0)
                        const fD = Math.abs(m.fontBoundingBoxDescent || 0)
                        const a = m.actualBoundingBoxAscent || 0
                        const d = m.actualBoundingBoxDescent || 0
                        const em = fA + fD
                        if (em > 0 && a > 0 && a + d < em * 1.2 && appliedFont) {
                          // 内容盒顶到墨迹顶、内容盒底到墨迹底，各自占内容盒的比例
                          inkTopFrac = Math.max(0, (fA - a) / em)
                          inkBotFrac = Math.max(0, (fD - d) / em)
                        }
                      }
                    } catch { /* 量不出来就退回兜底比例 */ }
                  }
                }
              } catch { /* 退回最小高度 */ }

              if (!(glyphH > 0)) {
                const hs = merged.map((r) => r[3] - r[1]).filter((h) => h > 0)
                if (hs.length > 1) glyphH = Math.min(...hs)
              }

              /**
               * 把每行矩形收缩到字形墨迹的上下沿。
               *
               * 和旧做法的区别（旧做法是「高度赋成 glyphH，保持底边向上伸缩」）：
               *   ① 不再假设矩形高度等于某个字号，而是按比例从矩形自身的上下沿往里切，
               *      所以行框（高）、文字框（矮）都能得到一致的结果；
               *   ② 上下都切，不是整体上移 —— 旧的 `r[3] = r[1] + glyphH` 会把顶边
               *      拉到随机位置，多行时各行顶边参差不齐。
               */
              /**
               * 量不到墨迹时的兜底比例。
               *
               * 这个数不是拍的：库里 Zotero 自产批注高度 / 插件矩形高度处处约 0.80
               * —— 8.76/10.96、7.911/9.9、11.16/14.0、9.126/11.48 全部落在 0.79–0.80。
               * 且缺口几乎全在顶部（ascender 之上的头部余量），底部 descender 基本贴边。
               * 拿不到 canvas 度量时用它，总比什么都不切（等于没修）安全。
               */
              if (!(inkTopFrac > 0.02)) {
                inkTopFrac = 0.2
                inkBotFrac = 0
              }

              const beforeH = merged.map((r) => Number((r[3] - r[1]).toFixed(2)))
              // 裁剪前的上下沿快照：只用来算 shift / botShift，判断矩形是否整体下沉
              const origTop = merged.map((r) => r[3])
              const origBottom = merged.map((r) => r[1])

              for (let mi = 0; mi < merged.length; mi += 1) {
                const r = merged[mi]
                const h = r[3] - r[1]
                if (!(h > 0)) continue
                if (h < 1.5) continue // 极矮的碎片不动，避免切出负高度
                const hasInk = inkTopFrac > 0.02 && inkTopFrac + inkBotFrac < 0.95
                /**
                 * **空白是绝对量，不是比例。**
                 *
                 * `inkTopFrac` 的含义是「字体 em 的一个比例」（实测 0.211），
                 * 它该乘的基数是**字号**，不是这一行矩形自己的高度。
                 *
                 * 之前写的是 `h * topFrac`，于是：
                 *   · 中间行 h=10 → 切 2.11 → 剩 7.89（正确）
                 *   · 首尾行 h=14.33 → 切 3.02 → 剩 11.31（仍然偏胖）
                 * 首尾行偏大是因为 `getClientRects()` 对它们返回的是**行框**
                 * （含行距），不是文字框。行框越高、按比例切掉的越多，
                 * 结果永远收敛不到同一高度 —— 用户看到的就是「第一行和最后一行还是不对」。
                 *
                 * 改用绝对量：每行都切掉相同的点值，多行高度才会真正一致。
                 * 基准取 `glyphH`（该行字号，PDF 点），量不到时退回该行自身高度。
                 */
                const emPt = glyphH > 0 ? glyphH : h
                /**
                 * **多余行距全部从底边切，顶边固定不动。**
                 *
                 * 这段前后改过三次，用实测数据定位到正确做法：
                 *
                 * ① 最初：`r[3] = r[1] + glyphH`（保底边、向上收）
                 *    → 顶边被拉到随机位置，多行参差不齐。
                 * ② 后来：行距上下各切一半（half-leading 假设）
                 *    → 高度对了（7.92 vs 7.89），但**首末行仍然整体偏下**。
                 *       日志：before 14.34 → after 7.92，shift -4.27、botShift +2.16。
                 * ③ 现在：行距全在下方，只切底边。
                 *
                 * 为什么是③：②的假设是「行框的 leading 上下各一半」，那是浏览器
                 * 排版普通文本时的规则。但 pdf.js 的文本层 span 用绝对定位 +
                 * transform 摆放，行框多出来的高度是在**字形下方**（为下一行预留），
                 * 上方则紧贴字形顶部。所以按一半切，等于凭空把矩形往上抬了
                 * extra/2，净效果就是整体偏下 —— 与用户两次截图一致。
                 *
                 * 证据：中间行 h == emPt（文字框，extra = 0），所以一直是对的；
                 * 首末行 h = 14.34（行框），按一半切就偏 extra/2 ≈ 2.16pt。
                 * 现在把 extra 整块从底边去掉，顶边保持原样。
                 */
                const extra = h > emPt ? h - emPt : 0
                let top = r[3] - emPt * (hasInk ? inkTopFrac : 0)
                let bot = r[1] + extra + emPt * (hasInk ? inkBotFrac : 0)

                if (!(top > bot + 0.5)) continue

                if (!hasInk && glyphH > 0 && h > glyphH * 1.05) {
                  // 兜底：没有墨迹比例但明显偏高，按已知基准把顶部压下来
                  top = bot + glyphH
                }

                r[1] = bot
                r[3] = top
              }

              for (let i = 0; i < merged.length - 1; i += 1) {
                const upper = merged[i] // 屏上更靠上 = PDF 里 y 更大
                const lower = merged[i + 1]
                const gap = upper[1] - lower[3]
                if (gap >= 0) continue // 已经分开，不用管
                const overlap = -gap
                /**
                 * 默认两行各让一半，这样多行高度保持一致（用户要的是「每行一样高」）。
                 * 只有一行已经矮到让不动时，才把剩下的份额推给另一行。
                 * 下限 0.5pt，避免把矩形压成负高度。
                 */
                const roomU = Math.max(0, upper[3] - upper[1] - 0.5)
                const roomL = Math.max(0, lower[3] - lower[1] - 0.5)
                let takeUpper = Math.min(overlap / 2, roomU)
                let takeLower = Math.min(overlap - takeUpper, roomL)
                if (takeLower < overlap - takeUpper) {
                  // 下行让不动了，剩下的由上行补
                  takeUpper = Math.min(overlap - takeLower, roomU)
                }
                upper[1] += takeUpper
                lower[3] -= takeLower
              }

              reportDiag({
                event: 'annot:height-normalized',
                glyphH: Number(glyphH.toFixed(2)),
                inkTopFrac: Number(inkTopFrac.toFixed(3)),
                inkBotFrac: Number(inkBotFrac.toFixed(3)),
                before: beforeH,
                after: merged.map((r) => Number((r[3] - r[1]).toFixed(2))),
                /**
                 * 垂直位置诊断（这次修的是位置，不是高度，所以要单独能看出来）。
                 *
                 * shift    = 顶边相对裁剪前的位移（PDF 坐标，负值 = 顶边在屏幕上下移）
                 * botShift = 底边相对裁剪前的位移（PDF 坐标，正值 = 底边在屏幕上上移）
                 *
                 * 修好后首末行应当是 **顶边下移 ≈ 底边上移 ≈ 半个行距**，
                 * 也就是底边明确往上收（botShift > 0），矩形以文字为中心收缩。
                 * 旧写法底边纹丝不动（botShift = 0）、全部位移压在顶边，就是下沉。
                 * 中间行 extra = 0，两个值都应当是 0。
                 */
                shift: merged.map((r, i) => Number((r[3] - origTop[i]).toFixed(2))),
                botShift: merged.map((r, i) => Number((r[1] - origBottom[i]).toFixed(2))),
              })
              pdfRects.push(...merged)
              pageIndex = firstPage - 1
            }
          } catch { /* 换算失败就不带坐标，用户仍能只加备注 */ }

          /**
           * 只存**锚点**，不再在这里算坐标。
           *
           * 工具条的真实宽高只有渲染出来才知道（六个按钮、字体、语言都会变），
           * 这里硬编码「假设宽 120 高 40」正是之前两个 bug 的根源：
           *   · y 写死 rect.top - 40 → 永远在选区上方（用户要的是默认下方）
           *   · x 写死 -60 居中 + 夹在 innerWidth-140 → 窄侧栏里把工具条挤成两行
           * 现在把选区矩形的四边交给渲染层，由它量完尺寸再摆位。
           */
          setSelbar({
            anchor: {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              centerX: rect.left + rect.width / 2,
            },
            text,
            pageIndex,
            rects: pdfRects,
          })
        }
        document.addEventListener('mouseup', onUp)
        return () => document.removeEventListener('mouseup', onUp)
      }, [])


      /* ---------- 划词工具条摆位 ---------- */
      /**
       * 结果浮窗（`.zr-pop`）的落点。
       *
       * 工具条改成存锚点之后，`selbar.x` / `selbar.y` 就不存在了；
       * 这两个函数把锚点换算回浮窗用的坐标，语义与改动前保持一致
       * （x 取选区左边，y 取选区下方 42px，并夹在视口内），
       * 这样译文/解释浮窗的位置不会因为这次重构而变化。
       */
      const popXFromAnchor = (sel) => Math.max(8, sel?.anchor?.left ?? 8)
      const popYFromAnchor = (sel) => Math.max(8, (sel?.anchor?.bottom ?? 8) + 8)

      /**
       * 工具条尺寸（实测值）。
       *
       * 不能硬编码：六个按钮的文字长度随语言、字体、缩放而变，
       * 「假设宽 120 高 40」在中文界面下就不成立，正是之前被挤成两行的原因之一。
       */
      const [selbarSize, setSelbarSize] = useState({ w: 0, h: 0 })
      const selbarRef = useRef(null)

      /**
       * 量一次工具条的真实尺寸。
       *
       * useLayoutEffect：在浏览器 paint 之前执行，量到就同步 setState，
       * 浏览器会把「首次渲染」和「修正定位」合并进同一帧，用户看不到中间态。
       * 用普通 useEffect 的话会先按 (0,0) 画一帧再跳位，就是闪一下。
       */
      useLayoutEffect(() => {
        if (!selbar) return
        const el = selbarRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return
        setSelbarSize((prev) => (
          Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
            ? prev
            : { w: r.width, h: r.height }
        ))
      }, [selbar])

      /**
       * 算出工具条最终坐标。
       *
       * @param {{left:number,right:number,top:number,bottom:number,centerX:number}|null} anchor 选区矩形
       * @param {{w:number,h:number}} size 工具条实测尺寸；还为 {0,0} 时用估算值先占位
       * @returns {{left:number, top:number, placed:boolean}}
       *
       * 垂直判据（默认在下方，符合阅读时「往下看」的视线）：
       *   ① rect.bottom + GAP 放得下（不越过视口底部）→ 就放下方
       *   ② 否则试上方 rect.top - h - GAP，且不越过视口顶部 → 放上方
       *   ③ 两侧都放不下（选区本身就比视口高）→ 贴底部，至少保证可见
       *
       * 水平判据（**整体平移，绝不缩窄**）：
       *   以选区中心对齐，再夹紧到 [8, innerWidth - w - 8]。
       *   夹紧只改 left，不改宽 —— 宽度由内容决定，折行问题从根上消失。
       */
      const placeSelbar = useCallback((anchor, size) => {
        if (!anchor) return { left: 8, top: 8, placed: false }
        const GAP = 8
        const EDGE = 8
        const vw = window.innerWidth || document.documentElement.clientWidth || 0
        const vh = window.innerHeight || document.documentElement.clientHeight || 0

        // 尺寸还没量到（首帧）时用保守估算，够占位、不撑破视口
        const w = size?.w > 0 ? size.w : 240
        const h = size?.h > 0 ? size.h : 34

        /**
         * 垂直摆位：**默认在选区上方**，上方放不下才翻到下方。
         *
         * 曾经改成过默认下方，实测不行：读者划词时视线停在选区上沿，
         * 工具条压在下沿会盖住紧跟着的那一行正文，反而挡路；
         * 而且划完继续读时，下方正是下一个注视点。所以默认回到上方。
         */
        let top
        if (anchor.top - GAP - h >= EDGE) {
          top = anchor.top - GAP - h                   // ① 上方（默认）
        } else if (anchor.bottom + GAP + h <= vh - EDGE) {
          top = anchor.bottom + GAP                    // ② 上方放不下，翻到下方
        } else {
          top = Math.max(EDGE, vh - h - EDGE)          // ③ 都放不下，贴底
        }

        // 水平：中心对齐后再夹紧。必须先夹 upper 再夹 lower，
        // 否则窗口比工具条还窄 upper 会小于 EDGE，Math.max 会把结果顶到 EDGE 之外。
        const centered = anchor.centerX - w / 2
        const maxLeft = Math.max(EDGE, vw - w - EDGE)
        const left = Math.min(Math.max(EDGE, centered), maxLeft)

        return { left, top, placed: true }
      }, [])

      /* ---------- 划词动作（译 / 解 / 问）---------- */
      const doSelection = useCallback(async (kind) => {
        const text = selbar?.text
        if (!text) return
        setSelbar(null)
        const mode = kind === 'explain' ? 'explain' : 'translate'
        // 浮窗沿用原来的近似摆位（选区下方 42px），只是坐标改从锚点取
        setPop({ x: popXFromAnchor(selbar), y: popYFromAnchor(selbar), text: '', loading: true, title: kind === 'explain' ? t('explainSelection') : t('translateSelection') })
        /**
         * **三态诊断 + 超时兜底。**
         *
         * 「没有返回任何翻译内容」在界面上只剩一片空白，而空白有两种完全不同的
         * 成因：HTTP 200 但 `text` 是空串（模型没吐 text-delta），或者请求根本没
         * 回来（浮窗永远转圈）。两种改法相反，所以把开始 / 完成 / 失败都记进日志。
         *
         * 90 秒兜底同理：没有它，请求挂住时浮窗会无限转圈，看不出是"没返回"。
         */
        reportDiag({ event: 'selection:start', mode, chars: text.length })
        const ctrl = new AbortController()
        const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, 90000)
        try {
          const data = await fetchJson(`${API}/selection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, mode }),
            signal: ctrl.signal,
          })
          const out = typeof data.text === 'string' ? data.text : ''
          reportDiag({ event: 'selection:done', mode, chars: out.length, head: out.slice(0, 80) })
          setPop((prev) => (prev ? { ...prev, text: out || '模型没有返回内容', loading: false } : prev))
        } catch (e) {
          const message = e?.name === 'AbortError' ? '翻译超时：90 秒内没有返回' : (e.message || String(e))
          reportDiag({ event: 'selection:error', mode, message: String(message).slice(0, 300), aborted: e?.name === 'AbortError' })
          setPop((prev) => (prev ? { ...prev, text: message, loading: false } : prev))
        } finally {
          clearTimeout(timer)
        }
      }, [selbar, t])

      /**
       * 把一条批注写进 Zotero。
       *
       * 这是自建标注层的**唯一写入出口**：高亮 / 下划线 / 便签都汇到这里。
       *
       * 走本地 API 而不是直接改 sqlite —— 由 Zotero 自己完成校验、索引和同步，
       * 效果等同于用户在 Zotero 界面里手动标注。写入需要 Zotero 10+ 并弹一次授权框
       * （授权 key 在宿主侧落盘复用，不会每次弹）。
       *
       * @param {{kind:string, text:string, comment?:string, pageIndex:number, rects:number[][], pageHeightPt?:number, anchor:{x:number,y:number}}} spec
       */
      const writeAnnotation = useCallback(async (spec) => {
        const data = await fetchJson(`${API}/annotations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemKey,
            attachmentKey: attachmentKeyRef.current,
            annotationKind: spec.kind,
            text: spec.text ?? '',
            comment: spec.comment ?? '',
            color: editColor,
            pageIndex: spec.pageIndex,
            pageLabel: spec.pageIndex + 1,
            rects: spec.rects,
            // sortIndex 第三段要用「距页面顶部的距离」，前端拿得到 viewport 就传
            pageHeightPt: spec.pageHeightPt,
          }),
        })
        void data
        // 重新拉一次，新批注立刻出现在页面上
        await loadAnnotationsFromZotero()
        // 立刻把这一页的浮层重画一遍（数据已更新），不用等页面重渲染
        decoratePage(spec.pageIndex + 1)
      }, [itemKey, editColor, loadAnnotationsFromZotero, decoratePage])

      /**
       * 改一条**已有**批注的颜色。
       *
       * 和 writeAnnotation 的区别：那条是新建，这条只动颜色。
       * 后端走 PATCH，Zotero 那边同样只改 annotationColor，文字和坐标不受影响。
       *
       * 成功后**不弹提示**（与高亮/下划线一致，用户明确要求这类操作静默生效）；
       * 失败才弹，否则用户不知道颜色为什么没变。
       */
      const recolorAnnotation = useCallback(async (annotKey, pageNo, color) => {
        const key = String(annotKey ?? '')
        if (!key || !color) return
        // 连点保护：PATCH 本身幂等，这里只是避免叠着发一串相同请求
        if (annotRecoloring) return

        setAnnotRecoloring(key)
        try {
          await fetchJson(`${API}/annotations`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ annotKey: key, color }),
          })
          /**
           * 不用本地改色糊弄过去。
           * 重新拉一次 /annotations 拿到 Zotero 里的真实值再重画，
           * 这样「页面上看到的颜色」和「Zotero 里存的颜色」永远是同一份数据 ——
           * 本地先改会在写入失败时留下一个假的颜色。
           */
          await loadAnnotationsFromZotero()
          const page = Number(pageNo)
          if (Number.isFinite(page) && page > 0) decoratePage(page)
          // 重画把层清空了，选中外框要立刻补回来，不然改完色框会闪一下才回来
          paintSelectRef.current?.(annotSelectedRef.current)
        } catch (e) {
          setPop({ x: 24, y: 24, loading: false, title: t('annotRecolorFailed'), text: String(e?.message ?? e) })
        } finally {
          setAnnotRecoloring(null)
        }
      }, [annotRecoloring, loadAnnotationsFromZotero, decoratePage])

      /**
       * 三点菜单里的「颜色」一组：八个条目，每项是「色块 + 中文名 + 当前色对勾」。
       *
       * 与旧实现的区别：旧的是横排 8 个纯色块（.zr-color-chip 一行），
       * 看不出哪个是当前色、也没有名字；Zotero 是竖排带标签和对勾，
       * 照着截图改。`onDone` 由调用方传入（选完色收起菜单）。
       */
      /**
       * 把批注的**评论 / 标签**写回 Zotero。
       *
       * 和 recolorAnnotation 走同一条 PATCH，只是 body 换成 comment / tags。
       * 三个字段可以同时传，这里按需只传变化的那些 —— 没提到的字段 Zotero 不会动。
       *
       * 触发时机（都不发「每敲一个字一次」的请求）：
       *   · 评论：textarea 失焦，且内容与 Zotero 里存的**不一样**才发
       *   · 标签：回车添加 / 点 × 删除时才发
       *
       * 成功后**不弹提示**（用户明确要求静默生效），失败才弹。
       * 成功后不做本地乐观更新，而是重新拉一次 —— 页面显示永远等于 Zotero 里存的。
       */
      const saveAnnotationMeta = useCallback(async (annotKey, pageNo, patch, failTitle) => {
        const key = String(annotKey ?? '')
        if (!key) return
        if (!patch || Object.keys(patch).length === 0) return

        setAnnotMetaBusy(key)
        try {
          reportDiag({ event: 'annot:meta-patch', key, fields: Object.keys(patch) })
          await fetchJson(`${API}/annotations`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ annotKey: key, ...patch }),
          })
          reportDiag({ event: 'annot:meta-saved', key, fields: Object.keys(patch) })
          await loadAnnotationsFromZotero()
          const page = Number(pageNo)
          if (Number.isFinite(page) && page > 0) decoratePage(page)
          paintSelectRef.current?.(annotSelectedRef.current)
        } catch (e) {
          reportDiag({ event: 'annot:meta-failed', key, message: String(e?.message ?? e) })
          setPop({ x: 24, y: 24, loading: false, title: failTitle || t('annotMetaFailed'), text: String(e?.message ?? e) })
        } finally {
          setAnnotMetaBusy(null)
        }
      }, [loadAnnotationsFromZotero, decoratePage, t])

      /**
       * 关闭卡片 —— **关闭前把未落盘的评论刷进 Zotero**。
       *
       * 这是「评论写不进 Zotero」的根因修复。
       *
       * 原来关闭走的是裸 `setAnnotPanel(null)`，它会让 React 立刻卸载 textarea。
       * 元素一旦从 DOM 移除，浏览器**不再派发 blur 事件**，于是依赖 onBlur 的
       * 保存逻辑就永远等不到触发 —— 用户写的评论留在本地草稿里，一次 PATCH 都没发。
       *
       * 现在所有关闭入口都走这里：先比对草稿与已保存值，有差异就先发保存，
       * 再关面板。保存是 fire-and-forget（不 await），因为面板该立刻响应点击，
       * 而 PATCH 在后台完成即可 —— 关掉面板不该让人觉得卡了一下。
       */
      closeAnnotPanelRef.current = () => {
        const panel = annotPanelRef.current
        if (panel) {
          try {
            const annot = annotationsRef.current.find((a) => a.key === panel.key)
            const saved = asText(annot?.comment).replace(/🔤/g, '')
            const draftText = annotationsDraftRef.current[panel.key]
            if (draftText !== undefined && draftText !== saved) {
              const pageNo = panel.pageNo || ((annot?.pageIndex ?? 0) + 1)
              reportDiag({ event: 'annot:comment-flush', key: panel.key, len: String(draftText).length })
              void saveAnnotationMeta(panel.key, pageNo, { comment: draftText }, t('annotMetaFailed'))
            }
          } catch { /* 保存失败不该挡住关闭 */ }
        }
        setAnnotPanel(null)
      }

      const renderAnnotColorItem = (annotKey, pageNo, onDone) => {
        const key = String(annotKey ?? '')
        const current = String(
          annotationsRef.current.find((a) => a.key === key)?.color ?? '',
        ).toLowerCase()
        const busy = annotRecoloring === key

        return h('div', null,
          ...EDIT_COLORS.map((c) => h('button', {
            key: c.value,
            disabled: busy,
            title: c.label,
            style: { color: 'var(--dsh-text-primary,#e4e4e4)' },
            onClick: (event) => {
              /**
               * 三层拦截，缺一不可：
               *   preventDefault/stopPropagation —— 挡住 host 委托里的「点空白取消选中」
               *   先关菜单 —— 用户选了颜色，菜单就该消失（与删除项一致），
               *              不能等异步 PATCH 回来才关，否则点了色块菜单还杵在那儿
               *   颜色没变就直接返回 —— 不发一次没意义的 PATCH
               */
              event.preventDefault()
              event.stopPropagation()
              if (typeof onDone === 'function') onDone()
              if (current === c.value.toLowerCase()) return
              recolorAnnotation(key, pageNo, c.value)
            },
          },
          h('span', { className: 'zr-menu-swatch', style: { background: c.value } }),
          h('span', { className: 'zr-menu-label' }, c.label),
          h('span', { className: 'zr-menu-check' }, current === c.value.toLowerCase() ? '✓' : ''),
          )),
        )
      }

      /**
       * 高亮 ↔ 下划线互转。
       *
       * 走同一条 PATCH，只是 body 换成 `type`。后端已实测可写
       * （highlight → underline → highlight 双向 204）。
       *
       * 与 recolorAnnotation 的区别只在语义：颜色是「同一形态换个色」，
       * 这里是「换形态」。但流程完全一致 —— 成功后**不弹提示**（静默生效，
       * 与改色/删除一致），失败才弹，因为形态变了用户一眼就能看见，
       * 而失败时如果不弹，用户会以为点了没反应。
       */
      const convertAnnotationType = useCallback(async (annotKey, pageNo, nextType) => {
        const key = String(annotKey ?? '')
        const target = String(nextType ?? '').toLowerCase()
        if (!key || (target !== 'highlight' && target !== 'underline')) return
        if (annotRecoloring) return

        setAnnotRecoloring(key)
        try {
          await fetchJson(`${API}/annotations`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ annotKey: key, type: target }),
          })
          // 与改色一致：不本地糊弄，重新拉 Zotero 的真实值再重画
          await loadAnnotationsFromZotero()
          const page = Number(pageNo)
          if (Number.isFinite(page) && page > 0) decoratePage(page)
          paintSelectRef.current?.(annotSelectedRef.current)
        } catch (e) {
          setPop({ x: 24, y: 24, loading: false, title: t('annotConvertFailed'), text: String(e?.message ?? e) })
        } finally {
          setAnnotRecoloring(null)
        }
      }, [annotRecoloring, loadAnnotationsFromZotero, decoratePage])

      /**
       * 三点菜单（点击卡片右上角 ⋯ 后弹出）。
       *
       * 锚点是卡片右上角，不是鼠标：菜单贴着卡片右侧展开，空间不够就翻到卡片
       * 左上内侧。结构照 Zotero 截图 —— 分隔线把「颜色」和「删除」分开。
       *
       * 刻意**没有**照搬截图里的这些项：添加至笔记、编辑页码。
       * 它们需要宿主侧的本事（写笔记 / 改 annotationPosition.pageLabel），
       * 当前后端不支持，做成点了没反应的按钮就是假功能，所以不做。
       *
       * 「转换为高亮」当初也被划进这一类，理由是「读不到 annotationType
       * 的写权限」。2026-11-26 实测证明那个顾虑是错的 —— 本地 API 的
       * PATCH 可以改 annotationType（highlight ↔ underline 双向 204），
       * 所以这一项已经实现，见上面的 convertAnnotationType。
       */
      const renderAnnotMenu = () => {
        const menu = annotMenu
        if (!menu) return null
        const busy = annotDeleting === menu.key
        const MW = 186 // 与 CSS .zr-annot-menu 的 min-width 对齐，用于贴边翻转
        const MH = 372 // 八个颜色 + 分隔线 + 形态转换项 + 分隔线 + 删除项的估算高度
        const card = annotPanel
        const CW = 300
        let left
        let top
        if (card) {
          left = card.left + CW + 6
          top = card.top + 34
          if (left + MW > (window.innerWidth || 1280) - 8) left = Math.max(8, card.left - MW - 6)
        } else {
          left = Math.max(8, (window.innerWidth || 1280) / 2 - MW / 2)
          top = Math.max(8, (window.innerHeight || 800) / 2 - MH / 2)
        }
        left = Math.max(4, Math.min(left, (window.innerWidth || 1280) - MW - 4))
        top = Math.max(4, Math.min(top, (window.innerHeight || 800) - MH - 4))
        return h('div', {
          className: 'zr-annot-menu',
          style: { position: 'fixed', left, top },
          // 菜单自己的点击不要冒到 host 的委托里（那里会把空白点击当成「取消选中」）
          // 同样只阻断冒泡，不做 preventDefault —— 菜单里没有输入控件，但保持一致更安全
          onClick: (e) => e.stopPropagation(),
          onMouseDown: (e) => e.stopPropagation(),
          onContextMenu: (e) => e.preventDefault(),
        },
        renderAnnotColorItem(menu.key, menu.pageNo, () => setAnnotMenu(null)),
        h('div', { className: 'zr-menu-sep' }),
        /**
         * 形态互换：高亮 ↔ 下划线。
         *
         * 只对这两种形态显示 —— 其它类型（note / text / image / ink）
         * 与二者形态差太远，互换没有语义，后端也只放行这两个值。
         *
         * 按钮文案写「目标形态」而不是「当前形态」：用户看到的是
         * 「转为下划线」= 点下去会变成下划线，而不是「当前是下划线」。
         */
        (() => {
          const cur = String(
            annotationsRef.current.find((a) => a.key === menu.key)?.type ?? 'highlight',
          ).toLowerCase()
          if (cur !== 'highlight' && cur !== 'underline') return null
          const toUnderline = cur === 'highlight'
          return h('div', null,
            h('button', {
              className: 'zr-annot-menu-conv',
              disabled: busy,
              title: toUnderline ? t('annotToUnderlineHint') : t('annotToHighlightHint'),
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                const target = menu
                setAnnotMenu(null)
                convertAnnotationType(target.key, target.pageNo, toUnderline ? 'underline' : 'highlight')
              },
            }, toUnderline ? t('annotToUnderline') : t('annotToHighlight')),
          )
        })(),
        h('div', { className: 'zr-menu-sep' }),
        h('button', {
          className: 'zr-annot-menu-del',
          disabled: busy,
          title: t('annotMoreHint'),
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            const target = menu
            setAnnotMenu(null)
            closeAnnotPanel()
            selectAnnotation(null)
            void deleteAnnotationByKey(target.key, target.pageNo)
          },
        }, busy ? t('annotDeleting') : t('annotDelete')),
        )
      }

      /**
       * 批注主面板（Zotero 式卡片）：点一条批注后在它旁边弹出。
       *
       * 结构照截图 ①：顶部「类型色块 + 页 N + ⋯」，中间是选中文字与评论框，
       * 底部「添加标签...」。
       *
       * 关于评论：Zotero 里它是 annotationComment，写回要 PATCH 对应字段。
       * 本次只在本地草稿里保存、并在输入框里显示（切走后仍保留在内存里），
       * **不写回 Zotero** —— 所以输入框下有一行小字说明。不这么做的话，
       * 用户的评论会以为存进去了、其实关掉就没了，那才是更难接受的行为。
       * 输入框本身是真的可写可编辑，不是禁用控件。
       */
      const renderAnnotCard = () => {
        const panel = annotPanel
        if (!panel) return null
        const annot = annotationsRef.current.find((a) => a.key === panel.key)
        const color = String(annot?.color ?? '#ffd400')
        const kind = annot?.type ?? 'highlight'
        const quote = asText(annot?.text).slice(0, 400)
        const savedComment = asText(annot?.comment).replace(/🔤/g, '')
        const draft = annotDraft[panel.key]
        const commentText = draft !== undefined ? draft : savedComment
        /**
         * 已有标签：Zotero 里是 `tags: [{tag:'x'}]`，这里摊平成字符串数组。
         *
         * 每次都从 annotationsRef 现算，不单独保存一份 ——
         * 写回后 loadAnnotationsFromZotero 会刷新它，界面自动跟着变，
         * 不会出现「本地数组和 Zotero 不一致」的第二个真相。
         */
        const annotTags = (Array.isArray(annot?.tags) ? annot.tags : [])
          .map((x) => String(typeof x === 'string' ? x : (x?.tag ?? '')).trim())
          .filter(Boolean)
        const tagDraft = annotTagDraft[panel.key] ?? ''
        const pageNo = panel.pageNo || ((annot?.pageIndex ?? 0) + 1)
        // 三角对准批注的水平中心：卡片在下方时三角贴顶边，在上方时贴底边
        const arrowX = Math.max(16, Math.min(300, Number(panel.arrowY) || 40))

        return h('div', {
          className: 'zr-annot-card',
          'data-arrow': panel.place === 'above' ? 'bottom' : 'top',
          style: { left: panel.left, top: panel.top, '--zr-arrow-x': `${arrowX}px` },
          /*
           * 只 stopPropagation，**不要** preventDefault。
           *
           * 卡片里有点击就要 focus 的输入框（评论框、标签框）：在容器 onClick 上
           * 调 preventDefault 会把「点一下让 textarea 获得焦点」这个默认行为一起
           * 掐掉 —— 表现为输入框点不进去。这里只挡住事件冒泡到 host 的委托，
           * 默认行为（聚焦、选中文本）保持原样。
           */
          onClick: (e) => e.stopPropagation(),
          onMouseDown: (e) => e.stopPropagation(),
          onContextMenu: (e) => { e.preventDefault(); e.stopPropagation() },
        },
        h('div', { className: 'zr-annot-card-head' },
          /*
           * 顶部类型图标：Zotero 这里是「A」式的类型标记。
           * 高亮 = 实心色块，下划线 = 只剩底部一条线，便签 = 描边方块，
           * 用形状就能区分类型，不必额外读一列文字。
           */
          h('span', {
            className: 'zr-annot-card-kind',
            title: kind === 'underline' ? t('underlineSelection') : kind === 'note' ? t('noteTool') : t('highlightSelection'),
            style: kind === 'underline'
              ? { background: 'transparent', borderBottom: `3px solid ${color}` }
              : (kind === 'note'
                ? { background: `${color}33`, border: `2px solid ${color}` }
                : { background: color }),
          }),
          h('span', { className: 'zr-annot-card-page' }, t('annotPage', { page: pageNo })),
          h('button', {
            className: 'zr-annot-card-btn',
            'data-on': annotMenu?.key === panel.key ? '1' : '0',
            title: t('annotMore'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setAnnotMenu(annotMenu?.key === panel.key
                ? null
                : { key: panel.key, pageNo, kind })
            },
          }, '⋯'),
          h('button', {
            className: 'zr-annot-card-btn',
            title: t('close'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setAnnotMenu(null)
              closeAnnotPanel()
              selectAnnotation(null)
            },
          }, '×'),
        ),
        h('div', { className: 'zr-annot-card-body' },
          quote ? h('div', { className: 'zr-annot-card-quote' }, quote) : null,
          h('textarea', {
            className: 'zr-annot-card-input',
            placeholder: t('annotComment'),
            value: commentText,
            onChange: (event) => {
              const next = event.target.value
              setAnnotDraft((prev) => ({ ...prev, [panel.key]: next }))
            },
            /**
             * 评论在**失焦**时写回，不在每次按键时写。
             *
             * 每敲一个字发一次 PATCH 会把 Zotero 的版本号打满，
             * 也让 If-Unmodified-Since-Version 频繁撞车。
             * 内容没变就不发 —— 只是点进来又点出去，不该产生请求。
             */
            onBlur: (event) => {
              const next = event.target.value
              /**
               * 诊断：把「失焦时输入框的值」「已保存的值」「是否相同」都记下来。
               *
               * 用户反馈「评论没写进 Zotero」，但日志里一条 saveAnnotationMeta
               * 的记录都没有 —— 说明它压根没被调用，或者被上面的早退拦住了。
               * 这三种可能（没失焦 / 失焦但值相同 / 值不同却没发请求）
               * 光看现象分不清，所以在这里一次性记清楚。
               */
              reportDiag({
                event: 'annot:comment-blur',
                key: panel.key,
                nextLen: String(next ?? '').length,
                savedLen: String(savedComment ?? '').length,
                same: next === savedComment,
              })
              if (next === savedComment) return
              void saveAnnotationMeta(panel.key, pageNo, { comment: next }, t('annotMetaFailed'))
            },
            onKeyDown: (event) => {
              // Esc 永远关面板（哪怕焦点在输入框里）
              if (event.key === 'Escape') {
                event.stopPropagation()
                setAnnotMenu(null)
                closeAnnotPanel()
                selectAnnotation(null)
              }
            },
          }),
          h('div', { className: 'zr-annot-card-note' },
            annotMetaBusy === panel.key ? t('annotCommentDraft') : t('annotCommentNote')),
        ),
        h('div', { className: 'zr-annot-card-foot' },
          /**
           * 已有标签：每项一个 chip，点 × 删除。
           *
           * 标签在 Zotero 里是 item 级的 `tags: [{tag}]`，改它是**整体替换**，
           * 所以加/删都要把「完整的新数组」发上去，而不是发一个增量。
           */
          annotTags.length > 0
            ? h('div', { className: 'zr-annot-taglist' },
              ...annotTags.map((tag) => h('span', { key: tag, className: 'zr-annot-tag' },
                h('span', null, tag),
                h('button', {
                  className: 'zr-annot-tag-x',
                  title: t('annotTagRemove'),
                  disabled: annotMetaBusy === panel.key,
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const next = annotTags.filter((x) => x !== tag)
                    void saveAnnotationMeta(panel.key, pageNo, { tags: next }, t('annotMetaFailed'))
                  },
                }, '×'),
              )))
            : null,
          h('input', {
            className: 'zr-annot-card-tags',
            placeholder: t('annotTags'),
            value: tagDraft,
            disabled: annotMetaBusy === panel.key,
            onChange: (event) => {
              const next = event.target.value
              setAnnotTagDraft((prev) => ({ ...prev, [panel.key]: next }))
            },
            onKeyDown: (event) => {
              /**
               * 回车 → 添加标签。
               *
               * 必须 preventDefault：这个 input 在卡片里，
               * 不过滤的话回车会冒到 host 的委托上（那里可能触发别的行为）。
               * 空串和重复标签都直接忽略 —— 重复由后端也会再兜一次。
               */
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                const name = String(event.target.value ?? '').trim()
                if (!name) return
                if (annotTags.includes(name)) {
                  setAnnotTagDraft((prev) => ({ ...prev, [panel.key]: '' }))
                  return
                }
                setAnnotTagDraft((prev) => ({ ...prev, [panel.key]: '' }))
                void saveAnnotationMeta(panel.key, pageNo, { tags: [...annotTags, name] }, t('annotMetaFailed'))
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                setAnnotMenu(null)
                closeAnnotPanel()
                selectAnnotation(null)
              }
            },
          }),
        ),
        )
      }

      /**
       * 对**当前选区**加标注（高亮 / 下划线 / 以选中文字为内容的便签）。
       *
       * 坐标来自划词 effect 算好的 `selbar.rects`（PDF 原生坐标、原点左下），
       * 与 Zotero 的 annotationPosition.rects 同源同单位。
       */
      const doHighlight = useCallback(async (kind = 'highlight') => {
        const sel = selbar
        if (!sel?.text) return
        const titleFor = (k) => (k === 'underline' ? t('underlineSelection') : k === 'note' ? t('noteTool') : t('highlightSelection'))
        const title = titleFor(kind)
        if (!canWriteAnnot) {
          setPop({
            x: popXFromAnchor(sel),
            y: popYFromAnchor(sel),
            text: annotWriteReason || t('annotCannotWrite'),
            loading: false,
            title,
          })
          setSelbar(null)
          return
        }
        const rects = sel.rects ?? []
        if (rects.length === 0) {
          setPop({
            x: popXFromAnchor(sel),
            y: popYFromAnchor(sel),
            text: t('annotNeedSelection'),
            loading: false,
            title,
          })
          setSelbar(null)
          return
        }
        const pageIndex = sel.pageIndex ?? (visiblePage - 1)
        /**
         * 便签的矩形要单独算。
         *
         * Zotero 的 note 批注是**固定 22pt 的方块**，以点击点为中心；
         * 直接把「选区的长条矩形」塞进去，Zotero 里会显示成一个又长又扁的
         * 选中框，而不是便签角标（还会遮住一大片正文）。
         * 这里取选区首行的左上角作为锚点，生成一个 22pt 方块。
         */
        let noteRects = rects
        if (kind === 'note') {
          const r0 = rects[0] ?? [0, 0, 0, 0]
          const cx = (Number(r0[0]) + Number(r0[2])) / 2
          const cy = (Number(r0[1]) + Number(r0[3])) / 2
          const R = 11
          noteRects = [[
            Number((cx - R).toFixed(2)), Number((cy - R).toFixed(2)),
            Number((cx + R).toFixed(2)), Number((cy + R).toFixed(2)),
          ]]
        }
        setSelbar(null)
        setAnnotBusy(true)
        setPop({ x: popXFromAnchor(sel), y: popYFromAnchor(sel), text: '', loading: true, title })
        try {
          await writeAnnotation({
            kind,
            // 便签没有「原文」概念，把选中的文字放进备注，正文留空
            text: kind === 'note' ? '' : sel.text,
            comment: kind === 'note' ? sel.text : '',
            pageIndex,
            rects: noteRects,
            pageHeightPt: pageSizesRef.current.get(pageIndex + 1)?.h,
          })
          // 用户要求：标注成功后不要弹「已保存到 Zotero」的提示框，静默生效。
          // 失败分支（catch）保留提示，否则用户不知道为什么没反应。
          setPop(null)
        } catch (e) {
          setPop((prev) => (prev ? { ...prev, text: e.message || String(e), loading: false } : prev))
        } finally {
          setAnnotBusy(false)
        }
      }, [selbar, canWriteAnnot, annotWriteReason, visiblePage, t, writeAnnotation])

      /**
       * 便签工具：在页面上点一下，就在该点落一个便条。
       *
       * Zotero 阅读器的便签是**固定 22pt 的方块**，rect 以点击点为中心
       * （reader.js：PDF_NOTE_DIMENSIONS = 22，rects = [[cx-11, cy-11, cx+11, cy+11]]）。
       * 这里照抄同样的几何，Zotero 里打开才会是同一个形状和位置。
       *
       * 坐标换算与划词一致：用官方 viewport 反推「CSS 像素 / PDF 点」的系数，
       * 拿不到才退回 scale × 96/72（官方渲染缩放本身就含这个换算）。
       */
      const addNoteAtPoint = useCallback(async (event) => {
        const host = hostRef.current
        if (!host) return
        const pageEl = event.target?.closest?.('.page[data-page-number]')
        if (!pageEl) return
        const pageNo = Number(pageEl.dataset.pageNumber)
        if (!Number.isFinite(pageNo) || pageNo <= 0) return

        const box = pageEl.getBoundingClientRect()
        const pageIndex = pageNo - 1

        // 反推 CSS 像素 / PDF 点
        let units = 0
        let pageHeightPt = pageSizesRef.current.get(pageNo)?.h ?? 0
        try {
          const pv = viewerRef.current?.getPageView?.(pageIndex)
          const vp = pv?.viewport
          const base = pageSizesRef.current.get(pageNo)
          if (vp && base?.w > 0) {
            units = vp.width / base.w
            pageHeightPt = base.h
          }
        } catch { /* 退回下面的估算 */ }
        if (!(units > 0)) units = scale * (96 / 72)
        if (!(units > 0)) units = 1
        if (!(pageHeightPt > 0)) pageHeightPt = box.height / units

        const cssX = event.clientX - box.left
        const cssY = event.clientY - box.top
        // CSS 左上原点 → PDF 左下原点
        const cx = cssX / units
        const cy = pageHeightPt - cssY / units

        const R = 11 // PDF_NOTE_DIMENSIONS / 2
        const rect = [
          Number((cx - R).toFixed(2)), Number((cy - R).toFixed(2)),
          Number((cx + R).toFixed(2)), Number((cy + R).toFixed(2)),
        ]

        reportDiag({
          event: 'annot:note-place',
          pageIndex,
          css: { x: Math.round(cssX), y: Math.round(cssY) },
          units: Number(units.toFixed(4)),
          rect,
          pageHeightPt: Number(pageHeightPt.toFixed(2)),
        })

        // 落完就退出便签工具，避免用户以为还要再点一次
        setAnnotTool(null)
        setSelbar(null)
        setAnnotBusy(true)
        setPop({ x: Math.max(8, event.clientX - 40), y: Math.max(8, event.clientY - 48), text: '', loading: true, title: t('noteTool') })
        try {
          await writeAnnotation({
            kind: 'note',
            text: '',
            comment: '',
            pageIndex,
            rects: [rect],
            pageHeightPt,
          })
          // 用户要求：标注成功后不要弹「已保存到 Zotero」的提示框，静默生效。
          // 失败分支（catch）保留提示，否则用户不知道为什么没反应。
          setPop(null)
        } catch (e) {
          setPop((prev) => (prev ? { ...prev, text: e.message || String(e), loading: false } : prev))
        } finally {
          setAnnotBusy(false)
        }
      }, [scale, t, writeAnnotation])

      /**
       * 便签工具的落点监听。
       *
       * 只在 annotTool === 'note' 时挂上（否则会抢走正常的文字选择与点击）。
       * 用捕获阶段 + 只处理落在页元素上的点击；不 preventDefault，
       * 这样用户点空白处不会影响 viewer 自己的滚动/选择行为。
       */
      useEffect(() => {
        if (annotTool !== 'note') return undefined
        const onClick = (event) => {
          const host = hostRef.current
          if (!host?.contains(event.target)) return
          // 点在页面上才落便签；点工具条、批注列表等一律忽略
          if (!event.target?.closest?.('.page[data-page-number]')) return
          if (event.button !== 0) return
          addNoteAtPoint(event)
        }
        document.addEventListener('click', onClick, true)
        return () => document.removeEventListener('click', onClick, true)
      }, [annotTool, addNoteAtPoint])

      /**
       * 「问」：把选中片段直接写进当前会话的输入框，光标停在末尾，等用户接着问。
       *
       * 之前是派发一个自定义事件 + 剪贴板兜底，但宿主并不认 `dsh:composer-insert`
       * 这个事件，所以每次都退化成「已复制到剪贴板，请自己粘贴」—— 让用户多做一步，
       * 而这本来可以自动化。
       *
       * 现在走宿主的会话草稿接口（与 dsh-better-sidebar 的 @ 引用按钮同一条路）：
       *   ctx.sessions.scope(sessionId)      → 该会话的 Agent Context
       *   ctx.get('conversation').input.for(actx) → 输入框状态
       *   input.state.getSnapshot().draft / input.setDraft(next)
       * 用 ctx.get 而不是 inject：这个服务由 UI 包稍后 provide，写进 inject 会让
       * apply 一直等（这个坑本项目已经踩过一次）。
       */
      const doAsk = useCallback(() => {
        const text = selbar?.text
        if (!text) return
        const sel = selbar
        setSelbar(null)
        const quote = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
        const prompt = `关于《${info?.title ?? itemKey}》${visiblePage ? ` 第 ${visiblePage} 页` : ''}的这一段：\n\n> ${quote.replace(/\n+/g, ' ')}\n\n`

        const ok = insertIntoComposer(ctx, sessionId, prompt)
        if (ok) {
          setPop({ x: popXFromAnchor(sel), y: popYFromAnchor(sel), text: t('askInserted'), loading: false, title: t('askSelection') })
          return
        }

        // 真拿不到会话输入框（例如会话还没就绪）时才退化为剪贴板，并说明原因
        navigator.clipboard?.writeText(prompt).then(() => {
          setPop({ x: popXFromAnchor(sel), y: popYFromAnchor(sel), text: t('askCopied'), loading: false, title: t('askSelection') })
        }).catch(() => { /* 剪贴板也不可用就不打扰 */ })
      }, [selbar, info, visiblePage, itemKey, t, ctx, sessionId])

      /* ---------- 缩放：双指 / Ctrl+滚轮 ---------- */
      /**
       * 必须用原生 addEventListener，不能用 React 的 onWheel。
       *
       * React 17+ 在根节点上把 `wheel` 注册成 passive，`preventDefault()` 无效 ——
       * 结果是整个页面被浏览器缩放，而 PDF 本身没动。只有非 passive 的原生监听
       * 才能挡掉默认行为。
       *
       * 触控板双指捏合在 Chromium 里就表现为 `ctrlKey: true` 的 wheel，
       * 所以这一个监听同时覆盖「双指缩放」和「Ctrl+滚轮」；
       * 不带修饰键的滚轮仍然是滚动 —— 那是翻页的主要方式，不该被抢走。
       */
      useEffect(() => {
        const el = scrollRef.current
        if (!el) return undefined
        const onWheel = (event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          const step = event.deltaY > 0 ? -0.08 : 0.08
          // 手动缩放后退出「自适应宽度」模式，否则这个数字不会被写进 viewer
          fitModeRef.current = false
          /**
           * **在缩放前捕获锚点，且整段手势只捕获一次。**
           *
           * 时机：此刻页面还是旧尺寸，event.clientX/clientY 正是用户眼下盯着
           * 的那个点。等到 state 同步 effect 里再取，页面已按新 scale 重排，
           * 同一个屏幕点指向的文档位置已经变了 —— 锚点就取错了。
           *
           * 只捕获一次（手势锁定）：一次连续手势会连发 3–5 个 wheel 事件，
           * 若每个事件都重取锚点，第二次起取到的是「已经缩过一轮之后的页面」，
           * 基准点于是逐次漂移 —— 实测日志里同一段手势的锚点页从 12 跳到 11
           * 再到 12、dy 在 +1031 与 −1029 之间翻转，就是这么来的。
           * 现在同一手势沿用第一个锚点；指针真的移到另一页/另一处才换基准
           * （isSameAnchorPoint 判的就是「是不是同一个物理点」）。
           */
          const nowMs = perf.now()
          const candidate = captureZoomAnchor(hostRef.current, event.clientX, event.clientY)
          const prev = zoomAnchorRecentRef.current
          const sameGesture = (nowMs - prev.capturedAt) < ZOOM_GESTURE_GAP_MS
          if (!(sameGesture && isSameAnchorPoint(prev.anchor, candidate))) {
            zoomAnchorRef.current = candidate
          }
          zoomAnchorRecentRef.current = { capturedAt: nowMs, anchor: zoomAnchorRef.current }
          zoomPendingRef.current = true
          setScale((current) => Math.max(0.4, Math.min(3, Number((current + step).toFixed(3)))))
        }
        // 双指捏合在触摸屏上还有一套 touch 事件；阻止浏览器整页缩放
        const onTouchMove = (event) => { if (event.touches.length > 1) event.preventDefault() }
        el.addEventListener('wheel', onWheel, { passive: false })
        el.addEventListener('touchmove', onTouchMove, { passive: false })
        return () => {
          el.removeEventListener('wheel', onWheel)
          el.removeEventListener('touchmove', onTouchMove)
        }
      }, [])

      /* ---------- 渲染 ---------- */
      const sourceLabel = useMemo(() => {
        if (!info) return ''
        if (info.source === 'mineru-local') return t('sourceMineruLocal')
        if (info.source === 'mineru-cloud') return t('sourceMineruCloud')
        return t('sourceLocal')
      }, [info, t])

      /**
       * 只要 error 有值就显示错误页。
       *
       * 原来用 `status === 'error'` 门控，而渲染失败（renderPage）时 status 已经是 'ready'，
       * 错误文案就永远渲染不出来 —— 用户看到的是一片黑，没有任何线索。
       * 判定改成「有错就报」，任何路径产生的错误都能看见。
       */
      if (error) {
        return h('div', { className: 'zr-root' },
          h('div', { className: 'zr-bar' },
            h('button', { className: 'zr-btn', onClick: onBack }, '←'),
            h('span', { className: 'zr-title' }, t('loadFailed'))),
          h('div', { className: 'zr-err' }, error))
      }

      return h('div', { className: 'zr-root' },
        bare
          ? null
          : h('div', { className: 'zr-bar' },
            h('button', { className: 'zr-btn', onClick: onBack, title: t('browse') }, '←'),
            h('span', { className: 'zr-title', title: info?.title ?? '' }, info?.title ?? t('loading')),
            h('span', {
              style: { fontSize: 11, opacity: .7, whiteSpace: 'nowrap' },
              title: info?.approxPages ? t('approxPages') : '',
            }, sourceLabel + (info?.approxPages ? ' · ≈' : '')),
          ),

        // 工具条
        h('div', { className: 'zr-bar' },
          /**
           * **返回跳转前的位置**（消费式，点一次退一步）。
           *
           * 放在「上一页」左边：它和 ‹ › 都是「往回走」，但语义完全不同 ——
           * ‹ › 是按页号线性的翻，这个是在**跳转历史**上回退，所以单独一格。
           *
           * disabled 由 hopDepth 驱动（栈空即灰）：栈在 ref 里，
           * 只有镜像出来的 hopDepth 变化才会重渲染，光改栈按钮不会变灰。
           *
           * title 带剩余步数 —— 不做常驻的「还能退 N 步」标签，
           * 那会让工具条多一块永远在变的文字；悬停时才看的东西放 title 最省。
           */
          h('button', {
            className: 'zr-btn',
            onClick: () => { popHop() },
            disabled: hopDepth === 0,
            /**
             * 可回退时把层数塞进 title（悬停才知道，不占工具条空间）；
             * 栈空时回落到基础文案 —— 那时按钮已经是灰的，
             * 再说「没有可回退的跳转」只是同一件事的重复。
             */
            title: hopDepth > 0 ? t('backToPrevDepth', { depth: hopDepth }) : t('backToPrev'),
          }, '↩'),
          h('button', { className: 'zr-btn', onClick: () => gotoPage(jumpPage - 1), disabled: jumpPage <= 1, title: t('prevPage') }, '‹'),
          h('input', {
            type: 'number', min: 1, max: pageCount || 1,
            /**
             * 显示的是编辑缓冲；没在编辑时跟随 jumpPage。
             *
             * input 的 value 必须是字符串：传数字会让 React 在清空瞬间
             * 把值写回「1」，用户看到的就是删不掉。
             */
            value: pageDraft ?? String(jumpPage),
            onChange: (e) => {
              // 只更新缓冲，不解析、不跳转 —— 允许中间态为空
              setPageDraft(e.target.value)
            },
            onBlur: () => {
              // 失焦才提交：空输入视为放弃编辑，回到当前页
              const raw = String(pageDraft ?? '').trim()
              setPageDraft(null)
              if (!raw) return
              const n = Number(raw)
              if (!Number.isFinite(n)) return
              const target = Math.trunc(n)
              if (target < 1) { gotoPage(1); return }
              gotoPage(target)
            },
            onKeyDown: (e) => {
              if (e.key === 'Escape') { setPageDraft(null); e.target?.blur?.(); return }
              if (e.key !== 'Enter') return
              // 回车提交后结束编辑，让输入框回到跟随 jumpPage 的状态
              const raw = String(pageDraft ?? '').trim()
              setPageDraft(null)
              if (!raw) return
              const n = Number(raw)
              if (!Number.isFinite(n)) return
              gotoPage(Math.max(1, Math.trunc(n)))
            },
            style: { width: 52, background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-border,#3a3a3a)', borderRadius: 6, padding: '2px 4px', fontSize: 12 },
          }),
          h('span', { style: { fontSize: 11, opacity: .7, whiteSpace: 'nowrap' } }, '/ ' + (pageCount || '?')),
          h('button', { className: 'zr-btn', onClick: () => gotoPage(jumpPage + 1), disabled: pageCount > 0 && jumpPage >= pageCount, title: t('nextPage') }, '›'),
          h('button', { className: 'zr-btn', onClick: () => { fitModeRef.current = false; const a = captureCenterZoomAnchor(); zoomAnchorRef.current = a; zoomAnchorRecentRef.current = { capturedAt: perf.now(), anchor: a }; zoomPendingRef.current = true; setScale((s) => Math.min(3, +(s + 0.15).toFixed(2))) }, title: t('zoomIn') }, '+'),
          h('button', { className: 'zr-btn', onClick: () => { fitModeRef.current = false; const a = captureCenterZoomAnchor(); zoomAnchorRef.current = a; zoomAnchorRecentRef.current = { capturedAt: perf.now(), anchor: a }; zoomPendingRef.current = true; setScale((s) => Math.max(0.4, +(s - 0.15).toFixed(2))) }, title: t('zoomOut') }, '−'),
          h('button', {
            className: 'zr-btn', title: t('fitWidth'),
            onClick: () => {
              /**
               * 交给官方算「贴合宽度」。
               *
               * 原来这里是 `(侧栏宽 - 24) / PDF 点位宽`，但官方渲染时
               * 还会再乘一次 PDF→CSS 的换算系数，于是算出来的比例偏大，
               * 页面比侧栏宽一点、需要横向滚动 —— 正是你看到的现象。
               * `currentScaleValue = 'page-width'` 用官方自己的公式，结果精确贴合。
               */
              const viewer = viewerRef.current
              if (viewer) {
                /**
                 * 「适应宽度」不走 scale state 那条同步 effect（它直接改
                 * currentScaleValue，由官方用自己的公式算比例），所以锚点
                 * 补偿要在这里现场做一次，否则这条路径仍会贴顶。
                 * 同样两跳 rAF 等重排落定。
                 */
                const anchor = captureCenterZoomAnchor()
                viewer.currentScaleValue = 'page-width'
                fitModeRef.current = true
                lastAppliedScaleRef.current = Number(viewer.currentScale.toFixed(3))
                setScale(Number(viewer.currentScale.toFixed(3)))
                const settleFit = (n) => {
                  zoomCompensationRef.current = settleFit
                  if (n > 0) {
                    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => settleFit(n - 1))
                    else setTimeout(() => settleFit(n - 1), 16)
                    return
                  }
                  const host = hostRef.current
                  if (!host || !anchor) { zoomCompensationRef.current = null; return }
                  const moved = applyZoomAnchor(host, anchor)
                  zoomCompensationRef.current = null
                  if (!moved) return
                  zoomAtRef.current = perf.now()
                  reportDiag({
                    event: 'zoom:anchor',
                    page: anchor.pageNo,
                    nx: Number(anchor.nx.toFixed(4)),
                    ny: Number(anchor.ny.toFixed(4)),
                    dx: Number(moved.dx.toFixed(1)),
                    dy: Number(moved.dy.toFixed(1)),
                    via: 'fit-width',
                  })
                }
                settleFit(2)
              }
            },
          }, '⤢'),

          /*
           * 刷新当前 PDF。
           *
           * 自增 reloadToken 会重新触发两条 effect：加载链路（重取字节、重建文档）
           * 和官方 viewer 的创建链路。位置不用管 —— 它已经由 pagechanging 的节流
           * 写进 localStorage，重建时 setDocument 之后会读回来，所以刷新后仍在原位置。
           *
           * 顺序很重要：先同步写位置，再自增 token。
           * 否则用户刚翻到新页、debounce 的 400ms 还没到就点刷新，那次翻页会丢。
           */
          h('button', {
            className: 'zr-btn',
            title: t('reloadPdf'),
            onClick: () => {
              if (savePageTimerRef.current) {
                clearTimeout(savePageTimerRef.current)
                savePageTimerRef.current = null
              }
              // 先把当前位置同步落盘，再重载，否则这次翻页会丢
              try {
                const pageNo = visiblePageRef.current || 1
                const off = measureScrollOffset(scrollRef.current, hostRef.current, pageNo)
                writeSavedPos(itemKey, pageNo, off)
                lastSavedPageRef.current = pageNo
                lastSavedOffsetRef.current = off
              } catch { /* 取不到就沿用上一次的记录 */ }
              setReloadToken((v) => v + 1)
            },
          }, '⟳'),

          /*
           * 批注工具条（自建）。
           *
           * 这里只留一个「便签」粘性开关：高亮和下划线是**对选区**操作，
           * 放在划词工具条里更顺手（选完文字就在眼前点）。
           * 便签需要「先点一个落点」，只能做成工具模式：点亮后在页面任意位置
           * 点一下，就在那个位置落一个 22pt 的便条 —— 这正是 Zotero 阅读器里
           * 便签工具的行为（PDF_NOTE_DIMENSIONS = 22，rect 以点击点为中心）。
           */
          h('span', { className: 'zr-sep' }),
          h('button', {
            className: 'zr-btn',
            'data-on': annotTool === 'note' ? '1' : '0',
            title: t('noteTool'),
            onClick: () => setAnnotTool((v) => (v === 'note' ? null : 'note')),
          }, '🗨'),
          /*
           * 调色板常显。
           *
           * 之前它只在「进入编辑工具后」出现，那是 pdf.js 编辑器时代的设计：
           * 颜色通过 eventBus 传给编辑器。现在颜色由我们自己带进写入请求，
           * 用户往往是「先选颜色，再划词点高亮」，所以必须一直看得见。
           */
          h('span', { className: 'zr-palette' },
            ...EDIT_COLORS.map((c) => h('button', {
              key: c.value,
              className: 'zr-swatch',
              title: c.name,
              'data-on': editColor === c.value ? '1' : '0',
              style: { background: c.value },
              onClick: () => setEditColor(c.value),
            }))),

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
          /**
           * 官方 viewer 的挂载点。
           *
           * `.zr-pdfviewer-host` 负责「撑满剩余高度 + 相对定位」，
           * 真正的滚动容器由 viewer 的 effect 在里面创建（.pdfViewer）。
           */
          h('div', { className: 'zr-pdfviewer-host', ref: hostRef }),
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
                // 书签带层级：按 depth 缩进，和 Zotero 里看到的结构一致
                style: o.depth ? { paddingLeft: 12 + Math.min(6, o.depth) * 10 } : undefined,
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
                  /**
                   * 删除：真的从 Zotero 里删。
                   *
                   * 必须 stopPropagation —— 这一行本身绑了「跳到该页」，
                   * 不拦的话点删除会顺带跳页。
                   */
                  h('button', {
                    className: 'zr-annot-del',
                    title: '从 Zotero 删除这条批注',
                    onClick: async (e) => {
                      e.stopPropagation()
                      if (annotDeleting === a.key) return
                      setAnnotDeleting(a.key)
                      try {
                        await fetchJson(`${API}/annotations?annotKey=${encodeURIComponent(a.key)}`, {
                          method: 'DELETE',
                        })
                        await loadAnnotationsFromZotero()
                        // 页面上的色块也要跟着消失
                        decoratePage((a.pageIndex ?? 0) + 1)
                      } catch (err) {
                        setPop({
                          x: 24, y: 24, loading: false, title: '删除失败',
                          text: String(err?.message ?? err),
                        })
                      } finally {
                        setAnnotDeleting(null)
                      }
                    },
                  }, annotDeleting === a.key ? '…' : '×'),
                ),
                h('div', { className: 'zr-annot-text' }, asText(a.text).slice(0, 160)),
                asText(a.comment)
                  ? h('div', { className: 'zr-annot-comment' }, asText(a.comment).replace(/🔤/g, '').slice(0, 200))
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
        /*
         * 摆位流程：先按估算尺寸渲染（同一帧内），useLayoutEffect 量到真实宽高后
         * 立刻 setSelbarSize 触发一次重算 —— 浏览器的这两次渲染在同一帧内完成，
         * 用户看不到跳位。`visibility` 不在尺寸未知时隐藏，因为那会让
         * getBoundingClientRect 量到 0；用估算值占位既能量到、也不会跑到视口外。
         */
        selbar ? (() => {
          const pos = placeSelbar(selbar.anchor, selbarSize)
          return h('div', {
            className: 'zr-sel',
            ref: selbarRef,
            style: { left: `${pos.left}px`, top: `${pos.top}px` },
          },
          h('button', { onClick: () => doSelection('translate'), title: t('translateSelection') }, t('translateSelection')),
          h('button', { onClick: () => doSelection('explain'), title: t('explainSelection') }, t('explainSelection')),
          h('button', { onClick: doAsk, title: t('askSelection') }, t('askSelection')),
          /*
           * 标注动作（自建）。
           *
           * 三个都直接写 Zotero，走宿主侧的 POST /annotations —— 不经过 pdf.js
           * 的编辑器（那条路因为 annotationStorage 缺失必崩）。
           */
          h('button', {
            onClick: () => doHighlight('highlight'),
            disabled: annotBusy,
            title: canWriteAnnot ? t('highlightSelection') : (annotWriteReason || t('annotCannotWrite')),
            style: { borderLeft: '1px solid var(--dsh-border,#3a3a3a)' },
          }, h('span', { style: { color: editColor } }, '▮'), ' ', t('highlightSelection')),
          h('button', {
            onClick: () => doHighlight('underline'),
            disabled: annotBusy,
            title: canWriteAnnot ? t('underlineSelection') : (annotWriteReason || t('annotCannotWrite')),
          }, h('span', { style: { color: editColor } }, 'U̲'), ' ', t('underlineSelection')),
          h('button', {
            onClick: () => doHighlight('note'),
            disabled: annotBusy,
            title: canWriteAnnot ? t('noteSelection') : (annotWriteReason || t('annotCannotWrite')),
          }, '🗨 ', t('noteSelection')),
          )
        })() : null,

        // 批注主面板 + 三点菜单（Zotero 式：点击批注出卡片，卡片右上角⋯出菜单）
        renderAnnotCard(),
        renderAnnotMenu(),

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
        /**
         * 点击发生在会话面板的 DOM 里，但拦截器注册在 document 上，这里拿不到 sessionId
         * （宿主没有公开「当前会话 id」）。`openInReader` 的默认参数会取
         * 「当前可见的那个面板」的会话 —— 点击本来也只可能发生在可见的面板里。
         */
        openInReader(ctx, m[1].toUpperCase())
      }
      document.addEventListener('click', onClick, true)
      return () => document.removeEventListener('click', onClick, true)
    }

    /**
     * tab 标题渲染（chip 上那行字，以及浮动面板的头部）。
     * 打开的是具体某篇时就显示论文短标题，否则显示通用名。
     */
    /* ------------------------------------ 已打开的 PDF（右栏的独立一栏） */

    /**
     * 「已打开的 PDF」那一栏。
     *
     * 顶部一条切换条列出所有打开过的论文，下面渲染当前选中那篇。
     * 之所以能这样收在一栏里：宿主只认得已注册的 tab 类型，复合 key 开不出新 tab
     * （实测 `openTab('zotero-reader:ABCD')` 静默失败），所以「多篇」只能在栏内做。
     */
    function PapersView({ t, ctx, sessionId, paneActive = true }) {
      useStyle()
      const [, setTick] = useState(0)
      /**
       * 只订阅**自己这个会话**的桶。
       *
       * 依赖里有 sessionId：`keepMounted: true` 让面板在切走时不卸载，同一个组件
       * 实例会随着会话切换收到新的 sessionId（宿主通过 `inject(sessionId => ...)` 注入）。
       * 依赖漏掉它，订阅就会一直挂在旧会话上 —— 表现正是「切了会话却还是旧的列表」。
       */
      useEffect(() => openedSubscribe(sessionId, () => setTick((n) => n + 1)), [sessionId])
      useEffect(() => { openedLoad(sessionId) }, [sessionId])

      /**
       * 只读自己那个桶。两个会话的 PapersView 同时挂着时，各自读各自的，
       * 谁也不会把对方的列表渲染出来。取不到桶时给一份空的，不要新建 ——
       * 渲染期写 Map 会让「读」变成「写」，`openedLoad` 的 loaded 标记也就失去意义。
       */
      const bucket = openedBySession.get(openedSid(sessionId)) ?? { keys: [], active: null, titles: {}, loaded: false }
      const { keys, active, titles } = bucket

      const bar = keys.length > 0
        ? h('div', { className: 'zr-papers-bar' },
          keys.map((key) => h('button', {
            key,
            type: 'button',
            className: 'zr-papers-chip',
            'data-active': active === key ? '1' : '0',
            title: titles[key] ?? key,
            onClick: () => openedActivate(sessionId, key),
          },
          h('span', null, shorten(titles[key] ?? key, 26)),
          h('span', {
            className: 'zr-papers-x',
            title: t('closePaper'),
            onClick: (event) => { event.stopPropagation(); openedRemove(sessionId, key) },
          }, '✕'),
          )),
        )
        : null

      return h('div', {
        className: 'zr-root',
        // 记下这一栏的实际宽度：同栏里 PaperView 若还没显示（display:none 时 clientWidth 为 0），
        // 就用这个值算「按宽适配」，否则第一次显示出来会是横向溢出的。
        ref: (el) => { if (el && el.clientWidth) paneWidthHint = el.clientWidth },
      },
      keys.length > 0 ? bar : null,
      keys.length === 0
        ? h('div', { className: 'zr-papers-empty' }, t('papersEmpty'))
        : keys.map((key) => h('div', {
          key: `wrap:${key}`,
          /**
           * 每篇都保持挂载，只切显示 —— 这样切回来时 pdf.js 文档、页码、缩放、
           * 滚动位置全都还在，不会重新下载和重新解析一遍。
           */
          style: key === active
            ? { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }
            : { display: 'none' },
        }, h(PaperView, {
          key,
          itemKey: key,
          t,
          ctx,
          sessionId,
          /**
           * 只有「这是当前选中的那篇」且「整个 papers 栏可见」时才加载。
           * 两个条件缺一都会让容器是 0×0，pdf.js 建不出页、页码恢复失效。
           */
          active: key === active && paneActive,
          bare: true,
          onBack: () => openedRemove(sessionId, key),
          topError: null,
        }))),
      )
    }

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
     * 把任意值当文本用。
     *
     * Zotero 里 `comment` / `text` 并不总是字符串：实测有文献的 comment 是对象或
     * 数字，直接调 `.replace()` / `.slice()` 就抛「a.comment.replace is not a function」，
     * 而这会把整页渲染拖进错误页 —— 一条坏批注不该让整页看不见。
     */
    function asText(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      try { return String(value) } catch { return '' }
    }

    /**
     * 右栏控制器是稍后 provide 的，apply 阶段可能还取不到。
     * 声明放在靠前处并集中在一处：列表点选、会话链接都经它开新 tab，
     * 若在组件之后声明会踩 `let` 的暂时性死区。
     */
    let openTabImpl = null

    /* ---------------------------------------------- 已打开 PDF 的共享状态 */

    /**
     * 「打开了哪些 PDF、当前在看哪一篇」放在模块作用域，而不是某个组件的 state 里。
     *
     * 因为要跨两个右栏栏共享：文献库那一栏负责「打开」，已打开那一栏负责「展示与切换」。
     * 两栏是同一个模块实例，不必引入状态库。
     *
     * **按会话分桶，而不是共用一个对象。**
     *
     * 原来这里是 `const openedState = { keys, active, titles, listeners }` 加一个
     * `let openedSession`（「当前桶」），`openedLoad(sessionId)` 只在 sessionId 变化时
     * 重读 localStorage。这个结构有两个致命点：
     *
     *   ① 读写共用同一个对象 —— 谁后写谁赢。两个面板同时在跑时，A 的 `openedLoad`
     *      会把 B 的列表覆盖掉，而两边渲染的又都是这同一个对象，于是**看起来就像没刷新**。
     *   ② 「当前桶」是模块级可变状态 —— 它假定「同一时刻只有一个会话在使用这份状态」。
     *      而 tab 类型注册用了 `keepMounted: true`（切走不卸载，免得回来重载 PDF），
     *      所以切换会话时旧面板**仍然挂着**，两个会话同时持有这句话就是假的。
     *
     * 现在的结构：
     *   · `openedBySession`：sessionId → { keys, active, titles, loaded }。每个会话
     *     只可能是自己那个桶的读者和写者，不存在互相覆盖。
     *   · `openedListeners`：sessionId → 订阅者集合。通知只发给**同一个 sessionId**
     *     的订阅者，所以会话 A 的变更不会把会话 B 的面板重新渲染一遍。
     *
     * 为什么这样就能隔离（两个面板同时挂载时的推演）：
     *   设会话 A、B 的面板同时挂着，各自只调用 `openedXxx(A/B, ...)`：
     *   · 读：A 只读 `openedBySession.get(A)`，B 只读 `get(B)`，两个对象不同，
     *     任何一次 `openedPersist(A)` 都只写 `...:opened:<A>` 这把 localStorage 钥匙；
     *   · 写：`openedAdd(A, k)` 只动 A 的桶，`openedEmit(A)` 只遍历 `openedListeners.get(A)`；
     *   · 相互影响只剩「同一篇论文在两个会话里都被打开」这种**本来就该发生**的情形，
     *     以及 localStorage 总容量 —— 不构成串数据。
     *   因此「切会话后仍显示旧会话的 PDF」在结构上不再可能：旧面板即使还活着，
     *   它渲染的也永远是它自己那个桶。
     *
     * 空的 sessionId（宿主偶尔拿不到）统一落在 `''` 这个桶里，localStorage 钥匙
     * 仍映射成 `...:opened:default`，与历史数据兼容。
     */
    const openedBySession = new Map()    // sessionId -> { keys, active, titles, loaded }
    const openedListeners = new Map()    // sessionId -> Set<fn>

    /** 桶的键：空会话也归到一个确定的桶，不散成 undefined。 */
    function openedSid(sessionId) {
      return String(sessionId ?? '')
    }

    /**
     * 取（必要时新建）某个会话的桶。
     *
     * `loaded` 标记「localStorage 已经读过」，用来替代原来那个
     * `if (next === openedSession) return` —— 那是「当前会话变了才重读」，
     * 现在每个会话各自只读一次，之后以内存为准（内存里的每次改动都立刻落盘）。
     */
    function openedBucket(sessionId) {
      const sid = openedSid(sessionId)
      let bucket = openedBySession.get(sid)
      if (bucket === undefined) {
        bucket = { keys: [], active: null, titles: {}, loaded: false }
        openedBySession.set(sid, bucket)
      }
      return bucket
    }

    /** 只通知这个会话的订阅者；别的会话的面板不该被别人的改动牵着重渲染。 */
    function openedEmit(sessionId) {
      const set = openedListeners.get(openedSid(sessionId))
      if (set === undefined) return
      // 复制一份再遍历：订阅者在回调里退订是常事，直接遍历 Set 会漏掉后面的订阅者。
      for (const fn of [...set]) { try { fn() } catch { /* 单个订阅者出错不影响其它 */ } }
    }

    /**
     * 订阅某个会话的变更。必须带 sessionId —— 「订阅全局」正是老 bug 的一半：
     * 会话 B 的改动会把会话 A 的面板也唤醒，而 A 读到的还是共享对象。
     */
    function openedSubscribe(sessionId, fn) {
      const sid = openedSid(sessionId)
      let set = openedListeners.get(sid)
      if (set === undefined) {
        set = new Set()
        openedListeners.set(sid, set)
      }
      set.add(fn)
      return () => {
        set.delete(fn)
        // 空集合就删掉，别让 Map 随着会话切换一直长。
        if (set.size === 0) openedListeners.delete(sid)
      }
    }

    /** 按会话隔离：不同会话打开过的论文互不干扰。空会话沿用历史的 `default` 段。 */
    function openedStorageKey(sessionId) {
      return `dsh-zotero-reader:opened:${openedSid(sessionId) || 'default'}`
    }

    /**
     * 每篇 PDF 的阅读页码。
     *
     * 按 itemKey 隔离（不是按会话）：页码是「这篇文献读到哪」这个客观事实，
     * 换会话/换栏宽都该续上，所以不进 opened 那个按会话分的桶。
     */
    function pageStorageKey(itemKey) {
      return `dsh-zr-page:${itemKey}`
    }

    /** 读回上次停留的页。读不到、存的值坏了、超出页数范围都退回 1。 */
    /**
     * 记住「读到哪儿」：**页 + 页内偏移**，而不是只记页号。
     *
     * 只记页号的问题是：用户常常停在两页之间（第 2 页尾部 + 第 3 页开头同时可见），
     * 只记页号会把视图**吸到某一页的顶部**，原本的视觉参照点就丢了。
     * 记 `{ page, offset }`：
     *   · page   —— 视口顶部所在的页（1 基）
     *   · offset —— 该页顶部到视口顶部的距离，占该页高度的比例（0..1）
     * 恢复时先定位到 page，再按 offset 做一次像素级微调，落在原来的位置。
     *
     * 跨版本兼容：旧数据是纯数字字符串（只有页号），读到时按 offset=0 处理。
     */
    function readSavedPos(itemKey, pageCount) {
      try {
        const raw = window.localStorage.getItem(pageStorageKey(itemKey))
        if (!raw) return null
        let page = 1
        let offset = 0
        if (raw.startsWith('{')) {
          const parsed = JSON.parse(raw)
          page = Math.floor(Number(parsed?.page)) || 1
          offset = Number(parsed?.offset)
          if (!Number.isFinite(offset)) offset = 0
        } else {
          // 旧格式：纯页号
          page = Math.floor(Number(raw)) || 1
        }
        if (page < 1) page = 1
        if (pageCount > 0) page = Math.min(page, pageCount)
        if (offset < 0) offset = 0
        if (offset > 0.98) offset = 0.98
        return { page, offset }
      } catch {
        return null
      }
    }

    /** 写回阅读位置。localStorage 可能被禁用/写满，失败一律静默（不影响阅读）。 */
    function writeSavedPos(itemKey, page, offset) {
      try {
        const pageNo = Math.max(1, Math.floor(Number(page)) || 1)
        const off = Math.min(0.98, Math.max(0, Number(offset) || 0))
        window.localStorage.setItem(
          pageStorageKey(itemKey),
          JSON.stringify({ page: pageNo, offset: Number(off.toFixed(3)) }),
        )
      } catch { /* 存不下就只在本次会话里记着 */ }
    }

    /**
     * 每篇 PDF 的缩放值。
     *
     * 存两种形态：
     *   · 数字字符串（如 "1.35"）—— 用户手动缩放过的具体比例
     *   · "fit"             —— 用户上次停在「适应宽度」模式
     * 区分的原因：「适应宽度」不是一个固定数字，它要随侧栏宽度变化重算。
     * 把当时的数字存下来再恢复，侧栏一变宽就又不贴边了 —— 必须记住的是**模式**。
     */
    const SCALE_FIT = 'fit'

    function scaleStorageKey(itemKey) {
      return `dsh-zr-scale:${itemKey}`
    }

    /** 读回上次的缩放。返回数字或 'fit'；没有记录返回 null（由调用方决定默认）。 */
    function readSavedScale(itemKey) {
      try {
        const raw = window.localStorage.getItem(scaleStorageKey(itemKey))
        if (!raw) return null
        if (raw === SCALE_FIT) return SCALE_FIT
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0.4 || n > 3) return null
        return n
      } catch {
        return null
      }
    }

    function writeSavedScale(itemKey, value) {
      try {
        window.localStorage.setItem(scaleStorageKey(itemKey), String(value))
      } catch { /* 存不下就算了 */ }
    }

    function openedPersist(sessionId) {
      const bucket = openedBucket(sessionId)
      try {
        window.localStorage.setItem(openedStorageKey(sessionId), JSON.stringify({
          keys: bucket.keys,
          active: bucket.active,
          titles: bucket.titles,
        }))
      } catch { /* 存不下就只留在内存，不影响使用 */ }
    }

    /**
     * 把某个会话的「已打开」从 localStorage 读回它自己的桶。
     *
     * 每个会话只读一次（`loaded` 标记）。读完之后以内存为准：所有改动都经
     * `openedPersist(sessionId)` 立刻落盘，所以不存在「另一个会话写了盘、我这边不重读就落后」
     * —— 盘是按会话分钥匙的，别人写的是别人那把。
     *
     * 老代码里那段 `adoptMemory` 补丁可以整块去掉：它的存在是因为「当前桶」在会话确立前
     * 会被 `openInReader` 先写一遍，随后真正的 sessionId 到来时又要认领。现在 `openedAdd`
     * 必须显式带 sessionId，写进去的就是正确的桶，不需要「认领」这个动作。
     */
    function openedLoad(sessionId) {
      const bucket = openedBucket(sessionId)
      if (bucket.loaded) return
      bucket.loaded = true

      let data = null
      try {
        const raw = window.localStorage.getItem(openedStorageKey(sessionId))
        data = raw ? JSON.parse(raw) : null
      } catch { data = null }

      const keys = Array.isArray(data?.keys) ? data.keys.filter((k) => /^[A-Z0-9]{8}$/.test(k)) : []
      bucket.keys = keys
      bucket.active = keys.includes(data?.active) ? data.active : (keys[0] ?? null)
      bucket.titles = (data?.titles && typeof data.titles === 'object') ? data.titles : {}
      openedEmit(sessionId)
    }

    /**
     * 把一篇登记进某个会话的「已打开」。
     *
     * **sessionId 是必需参数。** 老签名 `openedAdd(itemKey)` 靠「当前桶」猜会话，
     * 而猜错的时机恰恰是最常见的：用户刚切到一个还没读过 localStorage 的会话就点开一篇。
     */
    function openedAdd(sessionId, itemKey) {
      const key = String(itemKey ?? '').toUpperCase()
      if (!/^[A-Z0-9]{8}$/.test(key)) return
      const bucket = openedBucket(sessionId)
      if (!bucket.keys.includes(key)) bucket.keys = [...bucket.keys, key]
      bucket.active = key
      openedPersist(sessionId)
      openedEmit(sessionId)
    }

    function openedActivate(sessionId, itemKey) {
      const key = String(itemKey ?? '').toUpperCase()
      const bucket = openedBucket(sessionId)
      if (!bucket.keys.includes(key)) return
      bucket.active = key
      openedPersist(sessionId)
      openedEmit(sessionId)
    }

    /**
     * 记下某篇的标题，供切换条显示。
     *
     * 只有真正打开过（PaperView 拉到 /doc）才知道标题；没打开过的只显示 key。
     * 不额外请求：切换条不该为一排标签去拖 8 个接口。
     */
    function openedTitle(sessionId, itemKey, title) {
      const key = String(itemKey ?? '').toUpperCase()
      const text = String(title ?? '').trim()
      if (!key || !text) return
      const bucket = openedBucket(sessionId)
      if (bucket.titles[key] === text) return
      bucket.titles[key] = text
      openedPersist(sessionId)
      openedEmit(sessionId)
    }

    /** 关掉一篇；若关的正是当前这篇，顺延到相邻的一篇。 */
    function openedRemove(sessionId, itemKey) {
      const key = String(itemKey ?? '').toUpperCase()
      const bucket = openedBucket(sessionId)
      const at = bucket.keys.indexOf(key)
      if (at < 0) return
      const rest = bucket.keys.filter((k) => k !== key)
      bucket.keys = rest
      if (bucket.active === key) {
        bucket.active = rest.length === 0 ? null : rest[Math.min(at, rest.length - 1)]
      }
      openedPersist(sessionId)
      openedEmit(sessionId)
    }

    /**
     * 「当前可见的那个 Reader 属于哪个会话」—— 只有点击 `zotero://` 链接时需要它。
     *
     * 为什么需要：宿主的右栏控制器按会话各存一棵 tab 树，但 tab 类型的
     * `keepMounted: true` 让切走的面板留在 DOM 里（`display:none`）。于是
     * 「点击发生在哪个会话」和「这个点击该记进哪个会话」是两件事：
     *   · 链接拦截器装在 document 上，click 冒泡到它时**不携带任何会话信息**；
     *   · 宿主也没有公开「当前会话 id」的服务（实测 sessions 服务只有按 id 取 scope）；
     *   · 所以由每个 Reader 在挂载时登记自己的根节点，取会话时**现场看 DOM**：
     *     `display:none` 子树里的元素 `getClientRects()` 长度为 0，正好把切走的旧面板排除掉。
     *
     * 不用「最后挂载者赢」这种顺序猜测：切回来时旧面板并不重新挂载，顺序早就没意义了。
     * 一个可见面板都没有（右栏关着）时返回空串，落到历史的 `default` 桶 —— 与老行为一致。
     */
    const readerRoots = new Map()    // sessionId -> 该会话 Reader 的根 DOM 节点

    /** 登记/注销某个会话的 Reader 根节点（传 null 表示卸载）。 */
    function registerReaderRoot(sessionId, el) {
      const sid = openedSid(sessionId)
      if (el) readerRoots.set(sid, el)
      else readerRoots.delete(sid)
    }

    function currentReaderSession() {
      for (const [sid, el] of readerRoots) {
        try {
          if (el && el.getClientRects().length > 0) return sid
        } catch { /* 拿不到布局就跳过，继续看下一个 */ }
      }
      return ''
    }

    /**
     * 打开一篇：登记进**该会话**的「已打开」，并让阅读器切到这篇。
     *
     * 不再开新的右栏标签页 —— 宿主只认已注册的 tab 类型，复合 key 会被静默丢弃
     * （实测点了完全没有反应）。「已打开的 PDF」现在是 Zotero 栏里的一个分段，
     * 所以这里只派发一个事件，由已挂载的 Reader 切换到阅读视图。
     *
     * 事件上带 sessionId：旧代码不带，所有面板都会响应 —— 包括那个 `display:none`
     * 里的旧会话面板，这既是「切过去还是旧的」的一部分，也是重复加载的由来。
     */
    function openInReader(ctx, itemKey, sessionId = currentReaderSession()) {
      const sid = String(sessionId ?? '')
      openedAdd(sid, itemKey)
      window.dispatchEvent(new CustomEvent('zotero-reader:open', {
        detail: { itemKey, sessionId: sid },
      }))
    }

    /**
     * 把文本写进指定会话的输入框（追加到现有草稿末尾）。
     *
     * 这是宿主自己的会话草稿通道，和 dsh-better-sidebar 的 @ 引用按钮同一条路：
     *   ctx.sessions.scope(sessionId)            取该会话的 Agent Context
     *   ctx.get('conversation').input.for(actx)  取输入框的 state / setDraft
     *
     * 为什么用 `ctx.get` 而不是 inject：conversation 由 UI 包稍后 provide，
     * 写进本插件顶层 inject 会让 apply 一直等下去（本项目踩过这个坑）。
     *
     * 拼接时补一个空格：用户可能已经在框里写了别的内容，直接粘上会变成
     * `…这一段：` + `我之前的输入` 这种连在一起的样子。
     *
     * @returns {boolean} 是否成功写入
     */
    function insertIntoComposer(ctx, sessionId, text) {
      if (!ctx || !text) return false
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        const scope = sessions?.scope?.(sessionId)
        if (!scope) return false

        const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
        if (!conversation?.input?.for) return false

        const input = conversation.input.for(scope)
        if (!input?.setDraft) return false

        const current = input.state?.getSnapshot?.().draft ?? ''
        const separator = current && !/\s$/.test(current) ? '\n\n' : ''
        input.setDraft(current + separator + text)
        return true
      } catch {
        return false
      }
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

    /**
     * 面板级错误边界。
     *
     * 「右侧整片黑、连工具栏都没有」说明子树在渲染期抛错，被宿主槽位的错误边界
     * 吞掉了 —— 用户看到的是空白，我们什么也拿不到。这一层把异常就地拦下来：
     * ① 在面板里显示可读的错误文字，不再是一片黑；② 顺手回报给宿主写盘。
     *
     * 边界本身必须用不到任何可能抛错的东西：不调 t()、不读 ctx、只用内联样式。
     */
    class PaneBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        reportDiag({
          event: 'react:crash',
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').slice(0, 1500),
          componentStack: String(info?.componentStack ?? '').slice(0, 1500),
        })
      }

      render() {
        const { error } = this.state
        if (!error) return this.props.children
        return h('div', {
          style: {
            height: '100%', overflow: 'auto', padding: '16px', boxSizing: 'border-box',
            fontSize: '12px', lineHeight: '1.6', color: '#ff9c9c', background: '#1b1b1b',
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '阅读器渲染失败'),
        h('pre', {
          style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, color: '#e6e6e6' },
        }, String(error?.message ?? error)),
        )
      }
    }

    /* -------------------------------------------------------- 插件体 */

    return {
      inject: ['slots', 'locale'],
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
            // sessionId 由宿主注入；ctx 也一并带进去 —— 「问」要写会话草稿时需要用 ctx.get
            inject: (sessionId) => ({ sessionId, ctx }),
          }, (props) => h(PaneBoundary, null, h(Reader, { ...props, bound })))))

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

        /**
         * 全局异常兜底。
         *
         * React 17+ 里渲染期的异常除了走错误边界，还会以 `error` 事件冒到 window，
         * 异步链路上没人 catch 的 rejection 走 `unhandledrejection`。两条都收到文件里。
         * 这一条是「黑屏排查拿不到任何证据」的正面解法，留着长期有用。
         */
        ctx.effect(() => {
          if (typeof window === 'undefined') return undefined
          const onError = (event) => reportDiag({
            event: 'window:error',
            message: String(event?.message ?? event?.error?.message ?? event),
            source: event?.filename ?? null,
            line: event?.lineno ?? null,
            column: event?.colno ?? null,
            stack: String(event?.error?.stack ?? '').slice(0, 1200),
          })
          const onRejection = (event) => reportDiag({
            event: 'window:unhandledrejection',
            message: String(event?.reason?.message ?? event?.reason ?? ''),
            stack: String(event?.reason?.stack ?? '').slice(0, 1200),
          })
          window.addEventListener('error', onError)
          window.addEventListener('unhandledrejection', onRejection)
          return () => {
            window.removeEventListener('error', onError)
            window.removeEventListener('unhandledrejection', onRejection)
          }
        })
      },
    }
  },
})

