# 渲染内核对比：参考项目 vs 本项目

2026-11-23 补记。上轮只读了 PdfViewer 的骨架，这次把渲染调度完整看完。

## 参考项目的内核（`src/client/viewer/PdfViewer.tsx`，612 行）

自写，不用官方 `PDFViewer`。四条设计写在文件头注释里，代码确实兑现了：

### 一、虚拟化：只渲染可见页

```tsx
const [visible, setVisible] = useState<Set<number>>(() => new Set([1, 2]))
...
const io = new IntersectionObserver((entries) => {
  setVisible((prev) => {
    const next = new Set(prev)
    for (const entry of entries) {
      const pageNo = Number(entry.target.dataset.page)
      if (entry.isIntersecting && !next.has(pageNo)) next.add(pageNo)
      else if (!entry.isIntersecting && next.size > 4 && next.has(pageNo)) next.delete(pageNo)
    }
    return next
  })
}, { root, rootMargin: '900px', threshold: 0 })
```

`rootMargin: '900px'` 提前一屏开始渲染；`next.size > 4` 保证回滚时不闪（至少留 4 页）。未渲染的页只有 `.zr-page-box` 占位，**没有 canvas**。

### 二、尺寸先行：先量完所有页再排版

```tsx
const sizes: PageSlot[] = new Array(document.numPages)
const worker = async () => {
  for (;;) {
    const n = queue.shift()
    if (n === undefined) return
    const page = await document.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    sizes[n - 1] = { width: vp.width, height: vp.height }
  }
}
await Promise.all([worker(), worker(), worker(), worker()])
setSlots(sizes); setDoc(document)
```

四路并发，**全量**（不截断到 120 页），量完后一次性把占位盒挂出来。注释写得很明白：先给尺寸再报 doc，顺序反了会让渲染 effect 对着没有 canvas 的 DOM 空跑一趟。

我们这边也做了预取（`client.js:2883-2902`，16 路并发、限 120 页），但**多了一步**：预取前先 `pageSizesRef.current = new Map()` 全清，然后页盒尺寸由 pdf.js 官方 viewer 自己维护，两套尺寸来源并存。

### 三、单渲染队列：`${page}@${scale}` 去重

```tsx
const renderedRef = useRef(new Set<string>())
const renderingRef = useRef(new Set<number>())
...
const key = `${pageNo}@${scale}`
if (renderedRef.current.has(key) || renderingRef.current.has(pageNo)) return
```

同一页同一比例只画一次，正在画的也不重入。渲染中目标变了不重跑，而是 `setRenderTick(n => n + 1)` 触发一轮带新 scale 的：

```tsx
} finally {
  renderingRef.current.delete(pageNo)
  if (scaleRef.current !== renderScale) setRenderTick((n) => n + 1)
}
```

### 四、canvas 按 DPR 放大，上限 2

```tsx
const dpr = Math.min(window.devicePixelRatio || 1, 2)
canvas.width = Math.floor(viewport.width * dpr)
canvas.height = Math.floor(viewport.height * dpr)
await page.render({ canvas, canvasContext: ctx, viewport,
  transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise
```

`Math.min(dpr, 2)` 是关键——高分屏下 3x、4x 会让 canvas 像素量翻几倍，主线程光栅化直接爆炸。

### 五、滚动测当前页用 rAF 节流

```tsx
const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure) }
root.addEventListener('scroll', onScroll, { passive: true })
```

`passive: true` 加上 rAF 合并，一帧最多量一次。

---

## 我们的现状

用官方 `PDFViewer`（`client.js:2971` 起），它内部**也有**虚拟化（`PDFRenderingQueue` + `IntersectionObserver`）、单渲染队列、DPR 处理。所以这四条我们在原理上都有，是 pdf.js 帮我们做的。

我们的额外负担在别处：

### 1. 批注层跟着尺寸签名重建（`client.js:4234`）

```js
const sig = [pageNo, Math.round(pw), Math.round(ph), highlight..., annotations...].join('#')
if (decorateSigRef.current.get(pageNo) === sig) return
```

`Math.round(pw)` 让尺寸一像素的变化就触发整体重建，缩放时每页连续变尺寸，签名一直在变 → DOM 反复销毁重建。参考项目的 `HighlightLayer` 是纯 React 组件，随 render 走，没有这套手写签名。

### 2. `pagesinit` 抢跑 + 恢复阅读位置

`client.js:3395` 起的 handler 每次 `refresh()` 都无条件 `scrollPageIntoView(host, resumePage, resumeOffset)`，且带 3 次重试与 rAF 补滚。参考项目根本没有这套——它没有「先渲染第 1 页再跳」的问题，因为 `jumpTo` 是自己 `scrollTo`。

这既是缩放跳回第一页的根因，也是打开时卡顿的一部分。

### 3. 每页重绘触发多次 `decoratePage`

`page-painted` 事件里重画批注，一次打开 10+ 页就是 10+ 次 `decoratePage`，每次都要读 `pageEl.clientWidth/clientHeight`、`viewerRef.current.getPageView()`。日志里 `decorate:slow` 有 23 次，最慢 112 ms。

---

## 性能数据对比

我们最近三次 `perf:summary`（label=open）：

| spanMs | longTaskMs | 占比 | jank | freeze | longTaskMax | layoutMs | layoutReads |
|---|---|---|---|---|---|---|---|
| 3601 | 3324 | 92% | 4 | 3 | — | 482 | 63 |
| 3210 | 2297 | 72% | 7 | 3 | — | 230 | 29 |
| 6143 | 5114 | 83% | 6 | 4 | 1498 | 1132 | 43 |

最后一轮的阶段拆解：

```
load-pdfjs-module    819.4ms   ← 解析 pdf.mjs，一次性成本
fetch-bytes          834.3ms   ← 取 PDF 字节
getDocument           16.1ms
prefetch-page-sizes    1.1ms
load-viewer-module    250ms  (blockedMs 222)
construct-viewer      465.8ms (blockedMs 222)
setDocument-total    1567.1ms  ← 大头
page-painted           12ms
```

结论：**长任务占 72–92%，布局只占几百毫秒**。所以卡顿不是「布局读取太多」，而是主线程被长任务整段占住。`setDocument-total` 1.5 秒、`load-pdfjs-module` 819 毫秒这两项是主要矛盾，而它们都发生在 worker 缺失的主线程上。

## 最该抄的不是虚拟化，是这几条

虚拟化官方已给了，抄不来也不用抄。真正能降卡顿的是：

1. **worker 缺失是根因**。日志里 `pdfjs:worker-mode` 有 196 条，`pdfjs:worker-probe` 30 条 `reason=import-failed`。主线程跑 pdf.js，光解析 `pdf.mjs` 就 819 ms。参考项目 `openPdf` 走的也是同一套 pdfjs-dist，但它用 Vite 打包，worker 能正常加载。**先解决 worker，收益最大。**
2. **`Math.min(dpr, 2)`**。我们目前没有这个夹断，高分屏下 canvas 像素量可能翻倍。改动一行。
3. **`pagesinit` handler 只执行一次**。这条同时修掉缩放跳页和打开时的一部分抖动。
4. **`decoratePage` 签名去掉 `Math.round(pw/ph)`**，改用 `scale` 值本身做签名，缩放时不重建。
5. **`decorate:slow` 已有的埋点保留**，改成批量：`pagerendered` 收进队列，rAF 合并成一次批量 decorate。

`rootMargin: '900px'` 和 `next.size > 4` 这两个数值可以借鉴到 pdf.js 的 `PDFViewer` 配置（`PDFViewer` 构造参数里有 `removePageBorders`、`textLayerMode` 等，虚拟化参数由内部 `PDFRenderingQueue` 控制，可调但有限）。

---

## 附：不动渲染内核也能验证的实验

按改动成本从低到高：

- 给 `PDFViewer` 加 `minScale`/`maxScale` 夹断，避免异常缩放值
- `canvas` 的 DPR 夹到 2
- `decoratePage` 签名换掉 `Math.round`
- `pagesinit` handler 加一次性 flag
- 探针统计 worker 是否能起来（已有 `pdfjs:worker-probe`）

这些都不动架构，可以逐条上，每上一条看一次 `perf:summary` 的 `longTaskMs` 变化。
