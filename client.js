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
        function noteStack(d) {
          try {
            const st = new Error().stack
            if (!st) return
            const frames = st.split('\n').slice(2, 4).map((s) => s.trim().replace(/^at\s+/, ''))
            const key = frames.join(' <- ').slice(0, 160)
            if (!key) return
            let g = stacks.get(key)
            if (!g) { g = { n: 0, ms: 0, max: 0 }; stacks.set(key, g) }
            g.n += 1
            g.ms += d
            if (d > g.max) g.max = d
          } catch { /* 取不到栈就算了，不影响主功能 */ }
        }
        function topStacks(limit = 5) {
          return [...stacks.entries()]
            .map(([k, g]) => ({ at: k, n: g.n, ms: Math.round(g.ms), max: round1(g.max) }))
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
                 * 归因只在慢调用上做。快调用占绝大多数（98%），
                 * 逐次分组会把这份开销本身变成可观测的噪声。
                 * 栈也只在这类慢调用上取。
                 */
                if (d > 1) { note(this, d, 'rect'); noteStack(d) }
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
            layoutStacks: topStacks(5),
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
             * 主线程模式（pdf.js 的 fake worker），不创建真 Worker。
             *
             * 为什么：页面基址是自定义 scheme（`dsh-app://app/`）。在这种页面里
             * `new Worker(blobUrl, { type: 'module' })` 能创建，但 worker 不会回执，
             * 于是 `getDocument` 永远挂着 —— 客户端日志里只有 `pdf:start` 和 `pdf:bytes`，
             * 30 秒后报「解析 PDF 超时」，连一个错误都没有。
             *
             * pdf.js 支持不碰 Worker API：`PDFWorker.#mainThreadWorkerMessageHandler`
             * 读的就是 `globalThis.pdfjsWorker.WorkerMessageHandler`，存在时它会用
             * LoopbackPort 在主线程跑 worker 代码。代价是大文件解析时界面会顿一下。
             */
            const workerUrl = await importFromSource(`${API}/vendor/pdf.worker.mjs`)
            const workerLib = await import(/* @vite-ignore */ workerUrl)
            const Handler = workerLib?.WorkerMessageHandler ?? workerLib?.default?.WorkerMessageHandler
            if (!Handler) throw new Error('worker 模块里没有 WorkerMessageHandler')
            globalThis.pdfjsWorker = { WorkerMessageHandler: Handler }
            lib.GlobalWorkerOptions.workerPort = null
            reportDiag({ event: 'pdfjs:worker-mode', mode: 'main-thread' })
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
        const target = pageTop - 8 + pageH * Math.min(0.98, Math.max(0, offset))
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
       * 挂载即上报一次。
       * 「面板纯黑、连工具栏都没有」这种情况，三态（loading/ready/error）都渲染不出来，
       * 说明组件可能压根没挂上。有了这条记录就能直接区分「没挂载」和「挂载了但渲染失败」。
       */
      useEffect(() => {
        reportDiag({
          event: 'reader:mount',
          tabKey,
          hasSessionId: Boolean(props.sessionId),
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
      useEffect(() => { openedLoad(props.sessionId) }, [props.sessionId])
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

      // 监听「打开某一篇」的全局请求（会话里点 zotero:// 链接、或列表里点条目）
      useEffect(() => {
        const onOpen = (event) => {
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
      }, [])

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
            style: mode === 'read'
              ? { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }
              : { display: 'none' },
          }, h(PaperView, {
            itemKey,
            t,
            ctx: props.ctx,
            sessionId: props.sessionId,
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
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      },
      readPane,
      h(LibraryView, {
        t,
        sessionId: props.sessionId,
        ctx: props.ctx,
        tab: segment,
        setTab: setSegment,
        onPick: (key) => {
          /**
           * 点条目 → 另起一个 tab 打开这篇 PDF。
           *
           * 不再在本 tab 内切换内容：那样看两篇就会互相顶掉，回不到上一篇。
           * 同一个 key 再点只是一次「显示已有 tab」，所以重复点不会开重复 tab。
           */
          openInReader(props.ctx, key)
        },
      }))
    }

    /* ---------------------------------------------------- 文献库列表 */

    function LibraryView({ t, onPick, sessionId, ctx, tab, setTab }) {
      /**
       * 一开始就确立会话身份，早于任何一次「打开某篇」。
       * 否则 openedAdd 会先写进 default 桶，又被「已打开」按真实 sessionId 的读取覆盖。
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
      /**
       * 因「容器零尺寸」而自动重来的次数。
       *
       * 为什么需要它：零尺寸时我们会退回 loading 并自增 reloadToken 重来，
       * 但如果容器始终拿不到尺寸（例如这篇确实被隐藏着），就会无限自旋。
       * 所以限次；用完后不再自动重试，等 active 变化或用户手动刷新。
       */
      const zeroSizeRetryRef = useRef(0)

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
            openedTitle(itemKey, doc.title)
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
         */
        if (!active) return undefined
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
        ;(async () => {
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
            // 两处都套超时：任何一个 await 不 settle 都会让界面永久停在「加载中」
            const pdfjs = await withTimeout(getPdfjs(), 15000, '加载 pdf.js')

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
            const doc = await withTimeout(pdfjs.getDocument({ data: bytes }).promise, 30000, '解析 PDF')
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
      }, [itemKey, reloadToken, active])

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
            const { PDFViewer, EventBus, PDFLinkService } = viewerMod
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
                attempt: zeroSizeRetryRef.current,
              })
              // 限次自旋：容器始终拿不到尺寸时不要无限重来
              if (zeroSizeRetryRef.current < 8) {
                zeroSizeRetryRef.current += 1
                requestAnimationFrame(() => {
                  if (!disposed) setReloadToken((v) => v + 1)
                })
              }
              return
            }
            // 拿到真实尺寸了，计数归零，下次零尺寸重新从头允许
            zeroSizeRetryRef.current = 0
            viewer.setDocument(pdf.doc)
            linkService.setDocument(pdf.doc, null)
            reportDiag({ event: 'viewer:doc-set', pages: pdf.doc.numPages })
            perf.attribute('setDocument-total', openWinRef.current)

            // 官方 viewer 把页码/缩放变化通过 eventBus 广播，转成我们自己的 state
            eventBus.on('pagechanging', (e) => {
              if (disposed) return
              setVisiblePage(e.pageNumber)
              setJumpPage(e.pageNumber)
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
              if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                  if (disposed) return
                  decoratePageRef.current?.(pageNo)
                  // 页面重画会把层清空，外框一起没了 —— 补回来（无选中时是空操作）
                  paintSelectRef.current?.(annotSelectedRef.current)
                })
              } else {
                decoratePageRef.current?.(pageNo)
                paintSelectRef.current?.(annotSelectedRef.current)
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
              const savedPos = readSavedPos(itemKey, pdf.doc.numPages)
              const resumePage = savedPos?.page ?? 1
              const resumeOffset = savedPos?.offset ?? 0

              viewer.currentPageNumber = resumePage
              viewer.update?.()
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
                  const ok = pageOk && (scrolled || attempt >= 12)
                  if (!ok && attempt < 12) {
                    setTimeout(() => applyResume(attempt + 1), 120)
                    return
                  }
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
          try { viewer?.destroy?.() } catch { /* 已销毁 */ }
          viewerRef.current = null
          eventBusRef.current = null
        }
      }, [status, itemKey, reloadToken])

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
        lastAppliedScaleRef.current = scale
        viewer.currentScale = scale
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
         * 用「页号 + 尺寸 + 缩放 + 高亮 + 批注快照」做签名，相同就整体跳过。
         * 序号变化（新增/删除/改色）会改变签名，所以不会漏刷。
         */
        const sig = [
          pageNo,
          Math.round(pw),
          Math.round(ph),
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
      const gotoPage = useCallback((pageNo, rects) => {
        const target = Math.max(1, Math.min(pageNo, pageCount || pageNo))
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
      }, [pageCount])

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
        // 浮窗沿用原来的近似摆位（选区下方 42px），只是坐标改从锚点取
        setPop({ x: popXFromAnchor(selbar), y: popYFromAnchor(selbar), text: '', loading: true, title: kind === 'explain' ? t('explainSelection') : t('translateSelection') })
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
       * 三点菜单（点击卡片右上角 ⋯ 后弹出）。
       *
       * 锚点是卡片右上角，不是鼠标：菜单贴着卡片右侧展开，空间不够就翻到卡片
       * 左上内侧。结构照 Zotero 截图 —— 分隔线把「颜色」和「删除」分开。
       *
       * 刻意**没有**照搬截图里的这些项：添加至笔记、编辑页码、转换为高亮。
       * 它们需要宿主侧的本事（写笔记 / 改 annotationPosition.pageLabel /
       * 读 annotationType 的写权限），当前后端不支持，做成点了没反应的按钮
       * 就是假功能，所以不做 —— 见交付说明里的「没做的部分」。
       */
      const renderAnnotMenu = () => {
        const menu = annotMenu
        if (!menu) return null
        const busy = annotDeleting === menu.key
        const MW = 186 // 与 CSS .zr-annot-menu 的 min-width 对齐，用于贴边翻转
        const MH = 330 // 八个颜色 + 分隔线 + 删除项的估算高度
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
          h('button', { className: 'zr-btn', onClick: () => { fitModeRef.current = false; setScale((s) => Math.min(3, +(s + 0.15).toFixed(2))) }, title: t('zoomIn') }, '+'),
          h('button', { className: 'zr-btn', onClick: () => { fitModeRef.current = false; setScale((s) => Math.max(0.4, +(s - 0.15).toFixed(2))) }, title: t('zoomOut') }, '−'),
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
                viewer.currentScaleValue = 'page-width'
                fitModeRef.current = true
                lastAppliedScaleRef.current = Number(viewer.currentScale.toFixed(3))
                setScale(Number(viewer.currentScale.toFixed(3)))
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
      useEffect(() => openedSubscribe(() => setTick((n) => n + 1)), [])
      useEffect(() => { openedLoad(sessionId) }, [sessionId])

      const { keys, active, titles } = openedState

      const bar = keys.length > 0
        ? h('div', { className: 'zr-papers-bar' },
          keys.map((key) => h('button', {
            key,
            type: 'button',
            className: 'zr-papers-chip',
            'data-active': active === key ? '1' : '0',
            title: titles[key] ?? key,
            onClick: () => openedActivate(key),
          },
          h('span', null, shorten(titles[key] ?? key, 26)),
          h('span', {
            className: 'zr-papers-x',
            title: t('closePaper'),
            onClick: (event) => { event.stopPropagation(); openedRemove(key) },
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
          onBack: () => openedRemove(key),
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
     * 两栏是同一个模块实例，一张订阅表就够，不必引入状态库。
     */
    const openedState = { keys: [], active: null, titles: {}, listeners: new Set() }
    let openedSession = ''


    function openedEmit() {
      for (const fn of openedState.listeners) { try { fn() } catch { /* 单个订阅者出错不影响其它 */ } }
    }

    function openedSubscribe(fn) {
      openedState.listeners.add(fn)
      return () => openedState.listeners.delete(fn)
    }

    /** 按会话隔离：不同会话打开过的论文互不干扰。 */
    function openedStorageKey() {
      return `dsh-zotero-reader:opened:${openedSession || 'default'}`
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

    function openedPersist() {
      try {
        window.localStorage.setItem(openedStorageKey(), JSON.stringify({
          keys: openedState.keys,
          active: openedState.active,
          titles: openedState.titles,
        }))
      } catch { /* 存不下就只留在内存，不影响使用 */ }
    }

    function openedLoad(sessionId) {
      const next = String(sessionId ?? '')
      if (next === openedSession) return

      /**
       * 「还没确立会话就先点了文章」要认领而不是清空。
       *
       * 实测踩过：文献库那栏没调用本函数，openInReader 在 `openedSession === ''`
       * 时把记录写进了 `default` 桶；随后「已打开」那栏首次挂载才确立真实 sessionId，
       * 于是按新 key 读到空记录，把刚加进去的那篇覆盖掉了 —— 表现为「打开了，但列表是空的」。
       * 这里把内存里已有的这几篇当成属于这个会话，写进正确的桶。
       */
      const adoptMemory = openedSession === '' && openedState.keys.length > 0
      openedSession = next

      let data = null
      try {
        const raw = window.localStorage.getItem(openedStorageKey())
        data = raw ? JSON.parse(raw) : null
      } catch { data = null }

      if (!data && adoptMemory) {
        openedPersist()
        openedEmit()
        return
      }

      const keys = Array.isArray(data?.keys) ? data.keys.filter((k) => /^[A-Z0-9]{8}$/.test(k)) : []
      openedState.keys = keys
      openedState.active = keys.includes(data?.active) ? data.active : (keys[0] ?? null)
      openedState.titles = (data?.titles && typeof data.titles === 'object') ? data.titles : {}
      openedEmit()
    }

    function openedAdd(itemKey) {
      const key = String(itemKey ?? '').toUpperCase()
      if (!/^[A-Z0-9]{8}$/.test(key)) return
      if (!openedState.keys.includes(key)) openedState.keys = [...openedState.keys, key]
      openedState.active = key
      openedPersist()
      openedEmit()
    }

    function openedActivate(itemKey) {
      const key = String(itemKey ?? '').toUpperCase()
      if (!openedState.keys.includes(key)) return
      openedState.active = key
      openedPersist()
      openedEmit()
    }

    /**
     * 记下某篇的标题，供切换条显示。
     *
     * 只有真正打开过（PaperView 拉到 /doc）才知道标题；没打开过的只显示 key。
     * 不额外请求：切换条不该为一排标签去拖 8 个接口。
     */
    function openedTitle(itemKey, title) {
      const key = String(itemKey ?? '').toUpperCase()
      const text = String(title ?? '').trim()
      if (!key || !text || openedState.titles[key] === text) return
      openedState.titles[key] = text
      openedPersist()
      openedEmit()
    }

    /** 关掉一篇；若关的正是当前这篇，顺延到相邻的一篇。 */
    function openedRemove(itemKey) {
      const key = String(itemKey ?? '').toUpperCase()
      const at = openedState.keys.indexOf(key)
      if (at < 0) return
      const rest = openedState.keys.filter((k) => k !== key)
      openedState.keys = rest
      if (openedState.active === key) {
        openedState.active = rest.length === 0 ? null : rest[Math.min(at, rest.length - 1)]
      }
      openedPersist()
      openedEmit()
    }

    /**
     * 打开一篇：登记进「已打开」，并让阅读器切到这篇。
     *
     * 不再开新的右栏标签页 —— 宿主只认已注册的 tab 类型，复合 key 会被静默丢弃
     * （实测点了完全没有反应）。「已打开的 PDF」现在是 Zotero 栏里的一个分段，
     * 所以这里只派发一个事件，由已挂载的 Reader 切换到阅读视图。
     */
    function openInReader(ctx, itemKey) {
      openedAdd(itemKey)
      window.dispatchEvent(new CustomEvent('zotero-reader:open', { detail: { itemKey } }))
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
