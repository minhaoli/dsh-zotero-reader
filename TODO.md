# 待办

2026-11-14 记下的四项，顺序按用户原话。每项附上已经查到的代码落点和证据，免得下次从头摸。

## 1. 阅读模式主题：亮色 / 暗色 / 暖色 / 跟随系统

现状：client.js 里没有任何颜色模式逻辑，样式全部直接用宿主的 `--dsh-*` 变量（`--dsh-bg-primary`、`--dsh-text-primary` 等），所以现在只有"跟随宿主"一种行为。

落点：给 `.zr-root` 加 `data-theme`，四套 `--zr-*` 局部变量覆盖。暖色宿主没有，要自建。两个"跟随"语义不同，得分开：

- 跟随 DSH：直接不覆盖，继承 `--dsh-*`
- 跟随系统：`matchMedia('(prefers-color-scheme: dark)')`，与宿主设置无关

PDF 页本身是 canvas，底色由 pdf.js 决定，换主题只影响栏内 UI 和页面留白。选择用 localStorage 持久化。

## 2. 超链接跳转与悬停预览仍失效

三类链接分开看。`client-log.jsonl` 已确认 (a)(b) 都实际失败，(c) 是从性能日志里掉出来的。

### (a) 文档内命名目标 `#eq1` / `#cite.hutchison2013semantic`

有 `link:click` 记录但屏幕没动。代码走 `client.js:3481` 的 `linkService.navigateTo(href.slice(1))`，异常被空 `catch` 吞掉，所以失败无痕。

先验证 `await pdfDocument.getDestination('eq1')` 到底返回什么。更可控的走法是不再依赖 navigateTo：自己 `getDestination` → `getPageIndex` → `scrollPageIntoView`。LaTeX 论文的 `#eq1`、`#cite.xxx` 全是这种具名 dest，覆盖面不小。

### (b) 外部 https 链接

`window.open(href, '_blank', 'noopener,noreferrer')` 恒返回 null：`noopener` 和 `noreferrer` 都强制返回 null，这是规范行为。所以日志里那条 `blocked: true` 是误判，证明不了宿主有没有真的调起系统浏览器。

要拿真信号得先去掉这两个 feature 再点一次。如果宿主 `setWindowOpenHandler` 确实 deny，就得在 host 侧找可用的 openExternal 通道（DSH 宿主是否暴露，未查），否则退化为"悬停预览出完整地址 + 复制链接"。

### (c) 悬停预览把主线程压死

`perf:summary` 的 `layoutStacks` 里：`HTMLAnchorElement.patchedGBCR <- onPdfLinkOver` 调用 18 次、累计 4751 ms、单次最大 447 ms；整轮 open 阶段强制布局 21 s、布局读取 28433 次。光标扫过链接就卡，观感上等同于"没反应"。

修复方向：hover 延迟 120–200 ms 再计算、矩形只取一次并缓存、别在 mousemove 上反复读布局。

## 3. 按功能分别配置 LLM

现状：`index.js:463 normalizeConfig` 只有一对 `selectionProvider` / `selectionModel`，经 `index.js:591 selectionOverride` 被所有功能共用，缺省落到会话模型。

要拆的功能：划词翻译、划词解释、划词提问（往草稿里写那条）、文档整体翻译（`translateOnce`）、以后可能有的伴读问答。

落点：settings.json 增 `features: { translate, explain, ask, docTranslate }`，每项 `{ provider, model, reasoningEffort }`，空表示跟随会话；`selectionOverride` 改成 `featureOverride(settings, name)`。面板下拉的模型列表要确认宿主暴露了什么——`agentDefaultModel` 只给默认值，列全部模型得遍历 provider 目录。

注意 `TRANSLATE_EFFORTS` 那条 off → low → 默认 的三级回退是"档位"策略，与这里"哪个模型"是两回事，别混在一起。

## 4. 切换会话时 PDF 列表不刷新

现象：会话 1 打开 pdf1-2-3，切到会话 2 仍显示 pdf1-2-3，而不是会话 2 自己打开的那些。

现状：`openedState`（`client.js:6681`）是模块级单例，`openedLoad`（`client.js:6804`）用 `let openedSession`（`client.js:6682`）记"当前桶"；tab 类型注册时写了 `keepMounted: true`（`client.js:7032`），切会话和切 tab 都不卸载组件。

推断：会话 A 与会话 B 的面板同时活着，两个面板共写同一份 `openedState`，谁后写谁赢；A 被覆盖后还可能因重新激活再回写自己的桶，于是 UI 停在旧列表。

修法：`openedState` 改成按会话分桶（`bucket(sessionId).keys`），面板只读自己那一桶，消灭"当前桶"这个全局状态；`openedAdd` 必须显式带 sessionId。

这个和之前那次"openInReader 把记录写进 default 桶"是同一个根因（`client.js:6811` 的注释记过），当时只补了 `adoptMemory`，没换数据结构。

## 顺带记下的

- 日志里反复出现 `window:error: ResizeObserver loop completed with undelivered notifications.`，来自 reader 的 zero-size ResizeObserver。属噪声，在回调里包一层 `requestAnimationFrame` 即可消除。
- 「一键中文版」入口在 client.js 里已被移除（`translateAll` / `exportChinese` / `modeChinese` 零引用），host 的 `/translate` + 磁盘缓存还在。要恢复的话得重接前端。
## 已排查：批注错位（2026-11-14，自愈，留证据备复发）

现象：`IPMZW2RH`（Webb 等 2025, Nat Commun）里高亮与下划线错位，其他文章正常；用户复测后自愈。

已经排除掉的方向，下次别重查：

- 坐标换算本身是对的。用 `pdfjs-dist` 6.5.438（与插件同版本）取该 PDF 第 1 页文字真值：页面 595.276×790.866，无 `/Rotate`、MediaBox 原点归零、UserUnit=1。库里存的两笔批注 `FXFIMP47`（highlight, 2 rects）、`DSAR64IX`（underline, 3 rects）换算成行盒后与文字基线吻合到 0.02pt。
- 页高串条目也排除。该页 790.866 不是标准 Letter（792），若沿用了上一篇文章的页高，误差只有约 1.8px，不够叫错位；只有从 A4（841.89）串过来才会是 ~80px。

剩下最可能的是绘制时机：`decoratePage` 的签名用 `Math.round(pw/ph)` + 缩放，缩放进行中或页面还没定尺寸时画下去，就会停在旧比例；缩放结束后若没有再触发一次 decorate，就一直错着，刷新重画才对——与「复测已经好了」一致。

复发时的埋点：`annot:scale` 现在只记了 `scaleFromViewport`、`scaleFromClientWidth`、`k`、`pageHeightPt`，缺 `pageEl.clientWidth/clientHeight` 这两个实测值。补上就能一眼看出是「比例算错」还是「画在旧比例上」。

一个尚未解释的不一致：库里存的高度是行盒高 9.96，而 `annot:height-normalized` 算出的结果是 4.09，两者不同步，不确定是设计如此（只影响显示）还是归一化未落库。
## 新增两项（2026-11-23 诊断，详见 DIAGNOSIS.md）

- 缩放会跳回第一页。根因不是 pdf.js：它的 `#setScaleUpdatePages` 自带保位（`pdf_viewer.mjs:8978-8994`）。是我们 `client.js:3395` 的 `pagesinit` 抢跑 handler 每次 `refresh()` 都无条件把视图滚到 `resumePage`（上次存的阅读位置），缩放触发的 refresh 一跑就被拽回去。
- Zotero 云端 Web API（不启动 Zotero）。读写端点同本地，批注是普通 item。关键限制：PDF 必须已同步到云端才能 `GET /items/<key>/file`；直连需代理；写入要带版本号。现有 `zotero-api-key.json` 里是**本地** API key（Zotero 10+ 运行时授权），与 zotero.org 的 key 无关，不能混用。
## 设置页面（2026-11-23 新增需求）

现状：`client.js:2281` 的 `SettingsPanel` 已有完整骨架（浮层、`/settings` GET/POST、MinerU 三模式单选、token 输入、连通性测试按钮、dataDir 只读展示）。但内容只覆盖 MinerU：

| 项 | 设置面板 | 后端 `/settings` |
|---|---|---|
| mineruMode | 有 | 有 |
| mineruLocalUrl | 有 | 有 |
| mineruCloudToken | 有（密码框，不回显） | 有（只回 `Set` 布尔） |
| mineruAutoOnScanned | 有 | 有 |
| zoteroDataDir | 只读展示 | 可写 |
| selectionProvider / selectionModel | 无 | 无 |
| zotero.org API key / userID | 无 | 无 |
| 主题（四色） | 无 | 无 |
| 翻译档位 | 无 | 无 |

要补的：

1. LLM 配置区。至少三组「provider + model + 可选 reasoningEffort」：划词翻译、划词解释、划词提问。对应 TODO 第 3 项「按功能分别配 LLM」。
2. Zotero 云端 API 区。apiKey（密码框 + `Set` 布尔）、userID、一个「测试连接」按钮打 `api.zotero.org/keys/current`。
3. 主题选择（四色）。这个更适合放在阅读器工具栏而不是设置面板，因为是高频切换。
4. 翻译档位（off / low / 默认），现在是硬编码在 `host/translate.js` 的 `TRANSLATE_EFFORTS`。
5. 模型的候选项从哪来——`agentDefaultModel` 只给默认值，要列全部模型得遍历 provider 目录。需先确认宿主暴露了什么接口。

安全：apiKey 一律走密码框 + `Set` 布尔回显，绝不明文回传前端。现有 `mineruCloudToken` 已经是这个模式，照抄即可。

## 卡顿：参考项目的渲染内核（详见 RENDER-NOTES.md）

参考项目自写渲染内核，五条设计：IntersectionObserver 虚拟化（rootMargin 900px，保留 ≥4 页）、尺寸先行（4 路并发量完全部页再排版）、`${page}@${scale}` 单渲染队列、canvas DPR 夹到 2、scroll 用 rAF + passive 节流。

我们的性能数据：`longTaskMs` 占 `spanMs` 的 72–92%，布局只占几百毫秒。所以卡顿来自长任务，不是布局读写。最该先解决的是 **pdf.js worker 起不来**（日志 `pdfjs:worker-probe` 30 条 `reason=import-failed`）——主线程跑 pdf.js，光解析 `pdf.mjs` 就 819ms。

暂不实现，只记方向。低风险可先试：DPR 夹断到 2、`decoratePage` 签名去掉 `Math.round(pw/ph)`、`pagesinit` handler 加一次性 flag。

> 第 8 项「恢复文档翻译前端入口」已按用户指示搁置，不做。

---

## 三项已完成（2026-11-23 深夜）

分支合并情况：`ff0d429`（links）、`805e590`（zoom）、`3ff8ae4`（session），均已 `--no-ff` 合入 main，无冲突。合并后全量测试 30/30 绿，`harness-render` 无 effect 期异常。

### 第 2 项 超链接 —— 完成（`add96c4`）

根因比原诊断更具体：`pdf_viewer.mjs` 里**根本没有 `navigateTo` 方法**（全文 0 处），原代码每点一次就抛 `TypeError` 再被空 catch 吞掉。

修法：`getDestination` → `getPageIndex` → 复用 `scrollPageIntoView`。兼容间接目标（字符串要再查一层）、`dest[0]` 是 page ref 或页号、URL 编码（LaTeX 锚点常含 `%28`/`%20`）。失败分 `no-document`/`no-dest`/`bad-page`/`throw` 四类记 `link:dest-fail`。

外部链接去掉 `noopener,noreferrer` 取真实返回值（带这两个必然返回 null，原 `blocked` 是恒真假信号）。被拒时弹提示带完整地址，复制成功才改文案。

悬停改 150ms 延时 + 冒泡去重 + `relatedTarget` 排除子元素移动。`removeAttribute('title')` 保留在 mouseover 当拍立即执行——挪进延时会复发双框。

遗留两点：
- `http`/`mailto`/`tel` 被宿主 deny 是硬限制（`setWindowOpenHandler` 只认 `https:` 才 `shell.openExternal`），只能做到可见反馈。
- `destArray` 的纵向坐标未消费，`#eq1` 跳对页但停在页首。要精确定位需按 `dest[1].name` 分支取 y（`XYZ` 取 `dest[3]`，`FitH`/`FitBH` 取 `dest[2]`，`FitV`/`FitBV` 无 top），并做 PDF 左下原点 → 页首比例的方向翻转：`offset = (viewportHeight - y) / viewportHeight`。

### 第 4 项 会话隔离 —— 完成（`06c1a23`）

`openedState` 单例 + `let openedSession` 改为 `openedBySession: Map` + `openedListeners: Map`。所有 `openedXxx` 首位加 sessionId。删掉 `adoptMemory` 补丁——它只是在给错误结构打补丁。

额外发现：`zotero://` 拦截器挂在 `document` 上，click 事件不带会话信息，宿主也没公开「当前会话 id」（asar 里 `sessions` 服务只能按 id 取 scope）。改为每个 Reader 登记根节点，取会话时看 DOM 可见性（`getClientRects().length`）排除切走的面板。

`keepMounted: true` 保留（切 tab 不重载 PDF 有价值）。测试做了负向验证：改回旧签名会红，`keepMounted` 改 false 也会红。

### 第 5 项 缩放保位 —— 完成（`34aae42`）

原诊断的根因（pagesinit 每次 refresh 重发）错了，详见 DIAGNOSIS.md 的更正段。实际三处：pagesinit 清理与滚页拆分、`_location` 静默失效的几何兜底、`measureScrollOffset` 判据失灵另写几何版。

新增埋点（写进 `client-log.jsonl`）：

| 事件 | 何时记 | 字段 |
|---|---|---|
| `pagesinit` | 每次触发，每文档最多一条 | `willScroll` / `already` / `resumePage` / `currentPage` |
| `zoom:reanchor` | 仅当缩放后真漂、我们补滚时 | `from` / `to` / `offset` |
| `viewer:restore-mask` | 复用旧事件名，新增 `by:'pagesinit'` | `on` / `by` |

判读：连续几条 `pagesinit` 若出现 `already=true 且 willScroll=true`，说明守卫失效；`zoom:reanchor` 频繁出现说明 pdf.js 保位确实在失效、靠兜底救回来。

需要真实环境确认：实际缩放是否停住、`already=true 且 willScroll=true` 是否出现、`zoom:reanchor` 频率。
---

## 位图预览浮窗 —— 已完成（`06a5655`，合入 main `108a583`）

悬停预览从文字卡片改为渲染目标页位图，figure/公式/表格现在能看见真实画面。

只渲染目标那一页，不预取邻页。scale = 浮窗显示宽 520 × dpr / 页宽，dpr 夹 2、总宽夹 1400px。离屏 canvas 先铺白底（PDF 透明区在深色浮窗里会变灰块）再 render。

裁切要纵向翻转：`topInCanvas = (heightPt - y - h) * scale`。显示尺寸按 CSS 像素给（`/scale`），否则 dpr=2 时显示成两倍大。

裁切区域按 dest 类型分支：`FitR` 用矩形外扩 8pt，`XYZ` 取 `dest[3]`、`FitH` 取 `dest[2]` 作锚点 y，无坐标则整页。块高取页高 42%、下限 120pt，**以锚点为中心对称取**——实测 `fig8` 往下取对、`eq1` 上下都有内容、`cite.*` 落在跨行条目上，对称是唯一能覆盖三种情况的策略。横向默认整页宽，按 `dest.x` 裁会把居中图裁掉半边。

0.5s 消失：共用定时器 + `cancelHideTip`/`scheduleHideTip`，链接 mouseout/浮窗 mouseleave 排隐藏，链接 mouseover/浮窗 mouseenter 取消。浮窗 `pointer-events` 从 none 改 auto（否则收不到 mouseenter 也滚不动），位图放 `.zr-tip-shot`（overflow auto + max-height）。

缓存两层：`pageBitmapCache` 按 pageNo 存整页位图，同页不同目标复用只换裁切；`pageBitmapPending` 记在途渲染——pdf.js 禁止同 canvas 双 render，鼠标扫过同页多链接时第二次会赶在第一次完成前进来，缓存只挡已完成。

已知局限：浮窗会挡住其下方的 PDF 交互（pointer-events:auto 的代价）；首次悬停某页有几十到几百毫秒渲染延迟，期间显示 data-loading 占位；位图缓存不设 LRU 上限，长文档连续悬停多页会累积 canvas，单页约几 MB。

## 行尾踩坑（2026-11-24）

仓库 `client.js` 的 blob 是 CRLF，但子代理 worktree 里写出来是 LF，导致 git 把整文件当重写：8700 行里真实差异只有约 300 行，冲突块一度达 87 个。

诊断方法：`git diff --stat` 与 `git diff --stat --ignore-cr-at-eol` 对比，两者差异巨大就是行尾问题。

解决：所有 worktree 统一转 CRLF（先转 LF 再整体转 CRLF，避免 CRCRLF）。history-agent 用三方合并（base/ours/theirs 先统一 LF，`git merge-file`，完成后转回 CRLF），把 29 个冲突降到 1 处真冲突。

合并策略：main 与 rebase 后的分支各带一份等价的历史功能、git 无法自动识别，最终用 `git reset --hard 108a583` 让 main 指向包含全部成果的 commit（`git diff 5645ec8 108a583` 证实差异是纯粹的 preview 增量）。

**以后派子代理改 client.js，必须在指令里强调保持 CRLF。**
---

## 悬停浮窗四条修正（2026-11-24，进行中）

用户实测位图预览后提的四点：

1. **只对图和公式显示浮窗**。现在所有内链都弹（`#cite.*`、`#page=N`、`#eq1`、`#fig8` 全弹），用户只要 figure 和 equation。判定不能只靠名字前缀猜，要结合 dest 类型与坐标（如 `FitR` 给矩形通常意味着图）。不弹的类型要在渲染位图之前分流，避免白渲染一页。
2. **浮窗横向与正文页面对齐**，不跟随链接左右移动。现在 `left` 跟着链接 x 走，链接在左在右会让浮窗左右跳。改用页面元素的 `getBoundingClientRect` 取横向边界。纵向仍按链接算（上方优先，空间不够放下方）。
3. **光标移进浮窗后不能滚动它**。`pointer-events:auto` + `overflow:auto` 的代价是鼠标进去能滚。改回 `none` 并去掉 overflow，但要注意这会破坏 0.5s 消失依赖的 `mouseenter`/`mouseleave`——需简化成「链接 mouseout 排消失、mouseover 取消」。
4. **去掉外圈黑框**。`.zr-link-tip` 的 `border` + `box-shadow`、`.zr-tip-shot` 的 `border` 都去掉，观感改成「位图直接浮在页面上」，不要容器感。

由 links-agent 在 `fix-popup` 分支实现。