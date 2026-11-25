# 诊断报告（2026-11-23）

参考项目：`C:\Users\30759\Desktop\dsh-zotero-reader-main`（TS 重写版，13 个 `dist/*.js`、`src/client/viewer/PdfViewer.tsx` 612 行）。本项目：`D:\文档\dsh临时工作区\dsh-zotero-reader`（`client.js` 347KB / `index.js` 49KB）。

只做诊断，未改任何代码。

---

## 1. 缩放跳回第一页

### 结论

不是 pdf.js 的锅。pdf.js 官方 `PDFViewer` 有自己的保位逻辑：

```js
// node_modules/pdfjs-dist/web/pdf_viewer.mjs:8978-8994
const previousScale = this._currentScale
this._currentScale = newScale
if (!noScroll) {
  this.#refreshLocation()
  let page = this._currentPageNumber, dest
  if (this._location && ...) {
    page = this._location.pageNumber
    dest = [null, { name: 'XYZ' }, this._location.left, this._location.top, null]
  }
  this.scrollPageIntoView({ pageNumber: page, destArray: dest, allowNegativeOffset: true })
```

它靠 `this._location` 记住「哪一页、页内左上角在哪个坐标」，缩放后按新比例反推。我们的问题是写 `viewer.currentScale` 的路径。

### 证据链

缩放按钮在 `client.js:6215-6216` 直接改 React state：

```js
h('button', { onClick: () => { fitModeRef.current = false; setScale((s) => Math.min(3, +(s + 0.15).toFixed(2))) } }, '+')
```

再经 `client.js:4206-4219` 的 effect 写回 viewer：

```js
useEffect(() => {
  if (!viewer || status !== 'ready') return
  if (fitModeRef.current) return
  if (Math.abs(viewer.currentScale - scale) < 0.001) { lastAppliedScaleRef.current = scale; return }
  if (Math.abs(lastAppliedScaleRef.current - scale) < 0.001) return
  lastAppliedScaleRef.current = scale
  viewer.currentScale = scale          // ← 这里是 setter，走 #setScaleUpdatePages
}, [scale, status])
```

单看这条路径，pdf.js 会保位。会丢掉位置的是另一条：**`client.js:3395` 起的 `pagesinit` 抢跑 + `client.js:4005` 的 `scrollPageIntoView(host, resumePage, resumeOffset)`**。

`pagesinit` 是每次 `refresh()` 都会重发的事件（`PDFViewer.setDocument` 尾部 `this.refresh()` 触发），而我们的 handler 里无条件把视图滚到 `resumePage`——那个值是**上次打开时存的阅读位置**，不是「当前位置」。于是缩放的 refresh 一跑，页面被拽回旧页；如果旧记录还是第 1 页，看到的就是「从第一页重排」。

次要因素：`client.js:4234` 的 `decoratePage` 用 `Math.round(pw/ph)` 做签名，缩放中每页尺寸连续变，签名总在变，于是批注层跟着重建，观感上更像「整篇重排」。

### 更正（2026-11-23 深夜，动手时推翻）

上文的根因**是错的**。我把「缩放跳页」归因于 `pagesinit` 每次 `refresh()` 重发，实测 pdf.js 源码后确认前提不成立：

- `pagesinit` 全文只有两处命中：`pdf_viewer.mjs:3812`（EventBus 分类数组）与 `8660`（`setDocument` 的 `firstPagePromise` 链尾，唯一派发点）
- `PDFViewer.refresh()`（L9814-9825）函数体只有三行：`pageView.update()` / `#cleanupTimeouts()` / 按需 `this.update()`，**不派发 pagesinit**
- `#setScaleUpdatePages` 走的正是 `refresh(true, {scale})`

所以「缩放 → refresh → pagesinit → 拽回旧页」这条链不存在。真正原因有三处，已在 `34aae42` 修掉：

1. `pagesinit` handler 在 `resumePage <= 1` 时直接 return，把「揭遮罩」清理也跳过了。上一轮装载若挂着遮罩没等到 `pagerendered`，阅读区会一直停在「正在恢复阅读位置…」。清理与滚页已拆开。
2. pdf.js 的 `_location` 保位会**静默失效**：`_location` 只在 `update()` 里写、`refreshLocation()` 里读，后者仅当 `#staleLocation` 为真才跑。只要有一拍 `update()` 拿到的可见页不对（页视图刚建、或滚动落在不滚的祖先上），`_location` 就是错的，保位照着错位置滚。已加几何兜底：写 `currentScale` 前记锚点，下一帧验漂移，漂了才补滚。
3. `measureScrollOffset` 的第一个参数是 `scrollRef.current`，而那个 ref 挂在 `.zr-page` 上，不是真正吃滚动的节点，用它算偏移恒得 0 —— 判据本身失灵。已另写 `measureScrollOffsetByGeometry`，滚动祖先由 `findScrollParent` 现找。

原「修法方向」一段保留在下面，仅作历史对照，**不要照它实施**。

### 修法方向（原始推断，已被推翻，仅存档）

不改 pdf.js，改我们自己：

- `pagesinit` 的滚页只在「首次 setDocument」时执行一次，用 `resumeAppliedRef` 一次性标记，代替现在的无条件执行。
- 缩放改用 `viewer.currentScaleValue` 或先记 `this._location` 再设 `currentScale`，让官方保位生效。
- 或者更彻底：缩放前记 `(page, 页内偏移比例)`，设完 `currentScale` 后自己 `scrollPageIntoView` 回去——我们已经有 `measureScrollOffset`（`client.js:3244`）和 `scrollPageIntoView`（`client.js:1593`）这两个现成件。

### 参考项目为什么没这问题

它根本不用官方 viewer。自写渲染内核（`PdfViewer.tsx` 612 行），页面尺寸完全由 props 的 `scale` 决定并同步 set 到每个 `.zr-page-box` 的 `style.width/height`：

```tsx
const scaled = useMemo(() => slots.map((s) => ({ width: s.width * scale, height: s.height * scale })), [slots, scale])
```

所有页盒同时改尺寸，浏览器按内容高度比例自动调整 `scrollTop`，滚轮位置天然保持。它也没有「恢复阅读位置」这套抢跑逻辑，因为没有 `setDocument` 之后自动滚第 1 页的问题。

这条路我们不走——重写渲染内核的代价远大于修 4 行。

---

## 2. 超链接跳转与预览

### 参考项目几乎没做这件事

全仓库 grep `getDestination|navigateTo|linkService` 只命中一处，在 `src/client/viewer/Outline.tsx:18`：

```ts
if (typeof target === 'string') target = await doc.getDestination(target)
```

那是**大纲**跳转，不是 PDF 内嵌链接。`PdfViewer.tsx` 里没有任何 annotation layer 或 link service——它甚至没有渲染 PDF 的链接层。所以这个问题上没有可抄的答案。

### 我们的三类链接现状

| 类型 | 例子 | 现状 | 位置 |
|---|---|---|---|
| 文档内命名目标 | `#eq1`、`#cite.hutchison2013semantic` | 点了不动，异常被空 catch 吞掉 | `client.js:3481` |
| `#page=N` | `#page=12` | 工作 | `client.js:3462-3474` |
| 外部 https | `https://github.com/...` | `window.open` 恒返回 null，真伪不明 | `client.js:3511` |

`window.open(url, '_blank', 'noopener,noreferrer')` 按规范必返回 `null`，所以日志里的 `blocked: true` 是假信号，不能用来判断宿主有没有真的调起浏览器。

### 悬停预览的性能账

`perf:summary` 的 `layoutStacks` 记录：`HTMLAnchorElement.patchedGBCR <- onPdfLinkOver` 调用 18 次、累计 4751 ms、单次最大 447 ms；整轮 open 阶段强制布局 21 s、布局读取 28433 次。光标扫过链接就卡住主线程——观感上等同于「预览失效」。

### 更正（2026-11-23 深夜，动手时推翻）

上文的根因**是错的**。我把「缩放跳页」归因于 `pagesinit` 每次 `refresh()` 重发，实测 pdf.js 源码后确认前提不成立：

- `pagesinit` 全文只有两处命中：`pdf_viewer.mjs:3812`（EventBus 分类数组）与 `8660`（`setDocument` 的 `firstPagePromise` 链尾，唯一派发点）
- `PDFViewer.refresh()`（L9814-9825）函数体只有三行：`pageView.update()` / `#cleanupTimeouts()` / 按需 `this.update()`，**不派发 pagesinit**
- `#setScaleUpdatePages` 走的正是 `refresh(true, {scale})`

所以「缩放 → refresh → pagesinit → 拽回旧页」这条链不存在。真正原因有三处，已在 `34aae42` 修掉：

1. `pagesinit` handler 在 `resumePage <= 1` 时直接 return，把「揭遮罩」清理也跳过了。上一轮装载若挂着遮罩没等到 `pagerendered`，阅读区会一直停在「正在恢复阅读位置…」。清理与滚页已拆开。
2. pdf.js 的 `_location` 保位会**静默失效**：`_location` 只在 `update()` 里写、`refreshLocation()` 里读，后者仅当 `#staleLocation` 为真才跑。只要有一拍 `update()` 拿到的可见页不对（页视图刚建、或滚动落在不滚的祖先上），`_location` 就是错的，保位照着错位置滚。已加几何兜底：写 `currentScale` 前记锚点，下一帧验漂移，漂了才补滚。
3. `measureScrollOffset` 的第一个参数是 `scrollRef.current`，而那个 ref 挂在 `.zr-page` 上，不是真正吃滚动的节点，用它算偏移恒得 0 —— 判据本身失灵。已另写 `measureScrollOffsetByGeometry`，滚动祖先由 `findScrollParent` 现找。

原「修法方向」一段保留在下面，仅作历史对照，**不要照它实施**。

### 修法方向（原始推断，已被推翻，仅存档）

- 文档内具名目标：绕开 `linkService.navigateTo`，自己 `doc.getDestination(name)` → `doc.getPageIndex(dest[0])` → `scrollPageIntoView`。LaTeX 论文的 `#eq1`/`#cite.*` 占绝大多数，这条通了就能解决大半。
- 外部链接：去掉 `noopener,noreferrer` 拿真实信号；若宿主确实 deny，找 host 侧的 openExternal 通道，或退化为「显示完整地址 + 复制按钮」。
- 悬停：延迟 120–200 ms 再算，矩形只取一次并缓存，不在 mousemove 上反复读布局。

---

## 3. Zotero 云端 API（不启动 Zotero）

### 能做到

Zotero 官方 Web API（`https://api.zotero.org`）读写端点与本地 API 是同一套：

- 读：`/users/<id>/items`、`/items/<key>`、`/items/<key>/children`、`/items/top`，支持 `since` 增量与 `If-Modified-Since-Version` 条件请求
- 写：`POST /items` 创建批注，批注就是普通 item，带 `annotationType`、`annotationText`、`annotationComment`、`annotationPageLabel`、`annotationPosition`（JSON 字符串）、`parentItem`
- 删：`DELETE /items/<key>`，带 `If-Unmodified-Since-Version`
- 文件：`GET /users/<id>/items/<key>/file` 下载 PDF 原始字节

认证用 API key，三种传法都行，官方推荐 `Zotero-API-Key` 头。key 在 https://www.zotero.org/settings/keys 创建，权限分 read / write / files 三档。

### 做不到或会踩坑

- 文件下载要求附件已经同步到 Zotero 云端。本地 `linkMode: linked_file` 或从未同步的 PDF 拿不到。
- 直连 `api.zotero.org` 在国内常需要代理，`https_proxy` 得让 Node `fetch` 认（`undici` 默认不读环境变量，要显式装 `ProxyAgent`）。
- 写入必须带版本号，`412 Precondition Failed` 表示数据在本地改过；离线改完再同步容易冲突。
- 本地库的 `version` 与云端 `version` 是两套编号（Zotero 10+ 起明确分开），不能混用缓存。

### 因此的架构建议（未实施）

不要用云端 API「替换」本地，而是双后端：

```
数据源选择 = 本地 sqlite（Zotero 在跑） → 云端 API（Zotero 没跑，且有 key）
```

判断「Zotero 在跑」很便宜：`fetch http://127.0.0.1:23119/api/users/0/items?limit=1` 超时 300ms。本地优先，失败才走云端。

真正麻烦的不是取数据，而是**写批注的幂等**：本地写完云端会同步下来；若同时用云端写，可能写出两条重复批注。要么只在「本地不可达」时才允许云端写，要么写完立刻用 `since` 拉一次增量对齐。

### 当前已有的半成品

- `host/annotations.js` 用本地 API key 写批注（`ensureApiKey` / `persistApiKey`），存在 `~/.dsh-zotero-reader/zotero-api-key.json`。注意这是**本地** API key（Zotero 10+ 的机制，运行时授权），与 zotero.org 的 API key 完全无关，不能拿去调 `api.zotero.org`。
- 配置项里没有地方填 zotero.org 的 key 和 userID，需要新增。

---

## 4. 参考项目有而我们没有的功能

按「值不值得抄」排序：

| 功能 | 参考项目实现 | 我们的状态 | 判断 |
|---|---|---|---|
| 大纲导航 | `Outline.tsx` | 有（33 处引用） | 已有 |
| 缩略图栏 | `Thumbs.tsx` | 无 | 中等价值，侧栏窄，收益有限 |
| 全文搜索 | `PdfViewer.search()` 返回 `{page,count}` | 无 | 高价值，pdf.js 有现成 `PDFFindController` |
| 文本视图（重排阅读） | `TextViewer.tsx` 38.8KB + `markdown.ts` | 无 | 高成本，`markdown.ts` 10.8KB 是一整套 md 渲染 |
| 页面翻译 | `page-translation.ts` + `pdf2zh.ts` | 前后端均已删除（前端入口先移除，host 后端随后清理） | 中等，需从零实现 |
| 论文摘要 | `paper-summary.ts` + `PaperSummary.tsx` | 有 summary 相关（20 处） | 需确认完整度 |
| 参考文献抽取 | `references.ts` | 无 | 低，Zotero 本身能做 |
| 图片抓取送 LLM | `CaptureToolbar.tsx` / `TextCapture.tsx` | 无 | 中等，vlm 场景有用 |
| 图片/公式区域选择 | `MediaMenu.tsx` | 无 | 低 |

`theme.ts` 38.3KB 值得单独提：参考项目把主题做得极重（四套配色的完整 token 表）。这正好对上你 TODO 里的第 1 项。

---

## 5. 待办总清单

来自 `TODO.md` 与本次诊断：

1. 阅读模式四色主题（亮 / 暗 / 暖 / 跟随系统）——参考项目 `theme.ts` 可借鉴
2. 超链接跳转与悬停预览——见上文第 2 节，参考项目无答案
3. 按功能分别配置 LLM——`index.js:463` / `591`
4. 切换会话不刷新 PDF 列表——`openedState` 单例 + `keepMounted: true`
5. **缩放跳回第一页**——本次新增，根因见第 1 节
6. **Zotero 云端 API**——本次新增，架构建议见第 3 节
7. 全文搜索（可选，参考项目有）
8. 恢复文档翻译前端入口（后端还在）
