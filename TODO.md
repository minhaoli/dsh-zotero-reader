# 待办

## 当前状态快照（2026-11-26 01:30）

上一轮与用户逐项确认后的口径。历史流水账保留在下面，本节是需要先看的结论。

### 需要用户操作

- 重启 DSH。host 侧改动（配置页、凭据环境变量化、云端 Web API、全文搜索）都要重启才生效；`client.js` 的改动刷新页面即可。两者混在一起，很容易把「进程跑的还是三天前的代码」误判成「功能没做」。
- 重启后打开侧栏「插件」→ dsh-zotero-reader →「配置」，确认能打开，并保存一次 —— 保存后旧的 `settings.json` 会自动改名归档，不再作为回退值参与。

### 用户已确认不用做

| 项 | 口径 |
|---|---|
| pdf.js worker 起不来 | 现在 PDF 已经很顺畅，不再追 |
| 表格浮窗观感（整页缩到 630 宽后表体偏小） | 没问题 |
| `check-pdf-links.mjs` 锚点脆弱 | 没问题 |
| `ResizeObserver loop` 噪声 | 没问题 |
| 参考文献定位只在单篇双栏 PDF 上验证 | 没问题 |
| 批注错位埋点缺 `pageEl.clientWidth/clientHeight` | 没问题 |

### 还没开工

1. Embedding + 语义检索。用户点名要，设置页还要「推荐」用硅基流动 bge-m3（见文末需求补丁）。索引可复用 `%APPDATA%\zoteus\search-index.sqlite` 里 4572 条向量，embedder 同为 `BAAI/bge-m3`、1024 维。
2. 四色主题（亮 / 暗 / 暖 / 跟随系统）。`client.js` 里 `data-theme` 仍零命中。
3. 推送 GitHub。11 个提交压在本地，上次三次都是 `Connection was reset` 类失败，待确认 VPN。
4. 31 个 Zotero MCP 工具搬迁。用户说工具先不管，只留清单。

### 在办

- 首次打开文章整篇文字被全选（关掉重开就正常）。
- 一键中文版后端删除。

---


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
---

## 浮窗与高亮的修正（2026-11-24 晚，已完成）

### TDZ：一个错误造成三个症状（`5f0b66d`）

`ensureTip()` 里 `addEventListener('wheel', onTipWheel)`，而 `const onTipWheel` 声明在其后 12 行。首次调用就抛 `ReferenceError: Cannot access 'onTipWheel' before initialization`，**静默中断了它之后的 mouseenter / mouseleave / appendChild**。于是同时表现为：滚轮穿透到 PDF、浮窗不再消失。

`const` 箭头函数没有提升。这份 9000 行单文件里必须严格先定义后使用。

现有测试抓不到这类错误的三个原因：`node --check` 只看语法（先使用后声明语法合法）；`harness-render` 用 React stub 不执行那条真实注册路径；`check-*.mjs` 全是正则匹配源码文本，看不出执行顺序。

试过写 TDZ 静态检查器，两版都误报严重（`'...right now'` 里的 `now`、函数参数 `pageNo` 被当成引用），已删除——留着误报的检查器比没有更糟。`check-pdf-links.mjs` 里只保留了一条窄断言：`onTipWheel` 的定义必须在 `ensureTip` 注册 wheel 之前。

### 参考文献退回文字预览（`7deb5c3`）

用户原话「只有图、公式需要悬浮窗」，据此把 `#cite.*` 全挡掉后发现用户仍要提示，确认后改为三级分流：

| 目标 | 行为 |
|---|---|
| `isPreviewableDest` 为真（fig/equation/table） | 位图浮窗 |
| 为假但仍具名（`#xxx` 非 `#page=N`） | 文字预览（不渲染位图） |
| `#page=N` | 不弹 |
| 外链 | 显示 URL |

改法要点：`dest`/`pageNo` 解析提前到两条路径共用、删掉位图分支的重复解析，使「先解析、再分流、只有位图路径才渲染」成为代码结构本身的性质，而非靠注释约束。

### 落点高亮的真因（`7deb5c3`）

不是 TDZ 连带、不是 `mix-blend-mode` 配色。真因是**调用时机**：`jumpToNamedDest` 里刚调完 `scrollPageIntoView` 就同步调 `flashJumpTarget`，而 pdf.js 的目标页懒渲染，页元素要等滚过去之后才创建，于是 `if (!pageEl) return` 静默返回，整链还包在 `try/catch` 里连报错都没有。

日志佐证：`link:dest` 有 6 条、`preview` 都有内容，但从未有过闪烁记录。

修法：页元素不存在时挂 `pagerendered` 等一次 + 400ms 兜底，`once` 语义摘监听。诊断三态：`no-page-el` / `zero-size` / 成功时记几何。

### 迟到的 retry 会清掉新高亮（`d0763f0`）

审查时发现的竞态：`retry` 延迟执行、最后会再次调 `flashJumpTarget`，而它开头调 `clearJumpFlash()`。连续快速跳转两次时，第一次的 retry 迟到跑，会清掉第二次刚建立的高亮——症状与原 bug 相同但更偶发。

修法是代际标记 `jumpFlashSeq`：顶层调用自增开启新一代，retry 递归传同一代，入口判 `seq !== jumpFlashSeq` 即作废。

**关键细节**：`clearJumpFlash()` 必须放在代际判据**之后**。原顺序是它开头就清，那样即使加了 stale 判据也无效——过期 retry 会先清掉新高亮再走到判据返回。先判后清才对。

`clearJumpFlash` 本身不推进代际（它既被 cleanup 调、也被新一代开始调，若推进会让 seq 与 jumpFlashSeq 永远差一位）。

日志判读：`jump:flash-skip` 的 `reason` 分 `stale`（被新跳转取代）/ `no-page-el`（页未渲染）/ `zero-size`（尺寸为 0），都带 `seq`；成功路径的 `jump:flash` 也带 `seq`，一次跳转的完整生命周期能串起来看。
---

# 2026-11-24 夜间：浮窗改造与参考文献定位

## 已完成（本轮）

### 浮窗尺寸与内容（`8d1371e` / `415cd1c` / `3e112df` / `6bd8603`）

用户否定了「裁剪目标区域再放大」的方向（原话「放这么大是什么意思」），改为整页显示：

| 项 | 旧 | 新 |
|---|---|---|
| 尺寸来源 | 区域 contain 放大 | `pageRect.width*0.9 × pageRect.height*0.3` |
| 实测尺寸 | 1240×720 | 630×297 |
| 内容 | 裁剪区域 | 整页，可滚动，打开时定位到目标 |

- `computePopupSize` 是尺寸唯一来源，`renderPagePreview` 复用 `renderPageBitmap` 渲染整页
- 废弃但保留 `computeBitmapGeometry` / `destRegionPts` / `inferDestRegion`（跳转高亮仍在用，只解除浮窗依赖）
- 顺带修掉隐藏崩溃：旧 `renderDestBitmap` 里 `scale`/`availW` 未定义，整个函数被 `catch` 吞成 `null`，`node --check` 查不出
- 5px 裁切：`shotClientW=706` vs `shotScrollW=711`，纵向滚动条占位导致 canvas 横向溢出。canvas 入槽后量 `shot.clientWidth` 重设宽度

### 参考文献条目完整（`54bde1c`）

- `linkPreviewChars` 从 120 提到 600 兜底，但主判据改为**条目边界**
- 判停用正向证据：见到「年份 (19xx)/(20xx)」+「页码范围或 DOI」即条目完整
- `best` 命中 `References` 章节标题时跳到下一个条目起始
- 实测不可用的两个判据（别再试）：悬挂缩进（首行续行 `x0` 都是 49）、行距（条目内外都约 8pt）

### 表格区域（`189527a`）

- 图和表结构相反，判据必须分开：图找连续空白带（向上扫），表找连续多列行（向下扫）
- `#tab3` 的 `regionH` 从 64 修到 211

---

## 待办（按优先级）

### 1. 参考文献预览张冠李戴 —— 根因已查明，算法已验证，**未实现**

`cite.anderson1983` 显示的是 Anderson 2004 / 1998 的内容。调查报告（真实 PDF `G5I7K9DR/actrembed2026.pdf`，649562 字节与日志 `pdf:bytes:649562` 吻合）查明：

**根因是分栏，不是打分公式。**

第 14 页左右栏在同一基线上都有文字，拆行条件 `gap > 100` 而实测栏间隙仅 14.2pt，**永不触发**，左右栏被拼成一行 `x0=49.4 x1=546.0`。再按行中点判栏：该行中点 `297.7049`，页面中线 `297.6300`，**只差 0.0749pt** 被判成右栏；而 `destX=44` 判左栏，目标行被整行剔除。

若未被剔除，原打分本会赢：`6.58` vs `13.09`。

**已验证的算法（54/54 正确，现有 30/54）**：

```js
// 1) 按列起点分栏，不用 gap 阈值
const starts = dominantItemXClusters(page);        // p14 -> [49, 305]
const colOf = x => lastIndexWhere(starts[i] <= x);
// 2) 目标列 = 距 dest.left 最近的列起点
const tcol = nearestStart(starts, dest.left);
// 3) 目标行 = 该列中 y <= dest.top 里 y 最大的行（不是最近的！）
const target = lines.filter(l => l.col === tcol && l.y <= dest.top + 0.6)
                    .reduce((m,l) => l.y > m.y ? l : m);
// 4) 可选自校验：dest 名形如 cite.<surname><year>，与文本互证
```

**为什么 `max y ≤ top` 而不是最近距离**：`dest.top` 是行框**顶边**，基线在其下方。实测 `top - baseline` 中位数 3.96pt，参考文献条目稳定在 3.4~4.3pt。而 `References` 基线 315.4 在 `top=305` **上方** 10.4pt，序关系下不可能胜出——不需要任何 magic 阈值。

不变式：`0 < dest.top - baseline <= 该行字号`，96 个去重目标成立 83/96，13 个反例全是图/公式/标题（`top` 是块顶边而非行顶）。

**另有 8 个目标是反向错**（右栏 dest 命中左栏同基线文字，`y` 相同所以不报错只内容错）：`cite.neely1977`→Dunn(1971)、`cite.devlin2018bert`、`cite.behnamghader2024llm2vec`→Anderson(1983)、`cite.daily2001`、`cite.skrjanec2023`、`cite.plaut1995`、`cite.pennington2014glove`、`cite.penedo2024*`。

**局限**：只在单篇 PDF（Frontiers 双栏 15 页）验证过。单栏版 `starts` 只有 1 个值，规则退化为纯 `max y ≤ top`，逻辑仍成立但未验证。

### 2. 推送 GitHub —— **网络不通，未完成**

53 个提交未推送。`git push origin main` 三次失败：`Recv failure: Connection was reset` / `Empty reply from server` / `Could not connect to github.com:443 after 21113 ms`。

需要用户确认是否挂 VPN。

### 3. 表格观感待确认

新尺寸下表格也是「整页缩到 630 宽」，表体会比旧的裁剪放大版小很多。若表格需要例外（放大到可读），需要单独调。

### 4. `check-pdf-links.mjs` 的锚点脆弱

用 `src.indexOf('if (canvas) {')` 定位位图分支。本轮新增代码里出现同样的字符串，把锚点带偏，导致「位图浮窗不再带底部文字行」误报失败。当前靠改代码写法绕开，未修测试本身。

建议改成更具体的锚点（如 `indexOf('有图就以图为主体')` 或按函数边界切分）。

### 5. 沿用旧 TODO 的未完成项

- 四色主题（亮/暗/暖/跟随系统）
- 按功能分别配置 LLM（翻译/解释/提问/文档翻译）
- Zotero 云端 Web API（不启动 Zotero）
- 全文搜索
- 设置页面扩展（模型/apikey/主题）
- pdf.js worker 起不来（性能最大项，用户说不着急）
- `ResizeObserver loop` 噪声

---

## 本轮踩到的坑

**测试锚点脆弱**：`check-pdf-links.mjs` 用源码字符串 `indexOf` 定位分支，新增同名代码就会撞。修改 `client.js` 时如果加了测试里用到的字符串，先跑测试。

**`node --check` 查不出未定义变量**：`renderDestBitmap` 里 `scale`/`availW` 未定义，语法合法，被 `catch` 吞成返回 `null`。表现为「有时不显示」，无任何报错。这类问题只能靠真实运行日志发现。
---

# 待办：把 Zotero 的全部工具搬进插件（2026-11-26 用户提出）

用户原话：「我们还要把 zotero 的所有工具搬迁过来，合并到插件里面」

## 现状

插件只有 3 个工具（`host/tools.js`）：

| 工具 | 说明 |
|---|---|
| `search_zotero_library` | 按关键词搜本地库 |
| `read_zotero_paper` | 读 PDF 正文（带页码） |
| `ask_zotero_paper` | 在论文里做带页码的检索问答 |

MCP `zotero` 服务器有 31 个工具要搬（`search_tools` 是元工具，不搬）。

## 分层（按依赖从易到难，建议按此顺序实现）

### 第 1 层：本地 SQLite 直读，无外部依赖

现有 `host/zotero.js` 已经在读 `zotero.sqlite` 快照，这批最省事：

- `search_items`（现有 `search_zotero_library` 可扩展成完整版：q / qmode / itemType / tag / collectionKey / since / sort / start / limit）
- `get_item`（单条全字段 + creators/tags/collections/relations/version，含 `include_children`）
- `list_collections`（`zotero_list_collections`）
- `list_tags`（`zotero_list_tags`）
- `groups`（群组库列表 —— 注意需要 `libraries` 支持，当前只查个人库）
- `whoami`（身份 + 默认库 + 后端可用性）
- `saved_searches`（list / create / delete）

### 第 2 层：全文与语义

- `fulltext`（`zotero_fulltext`：get / set / since，读写附件已抽取文本）
- `get_fulltext`（`zotero_get_fulltext`：query 定位段落 + page_range + outline + ocr）
- `semantic_search`（`zotero_semantic_search`）+ `index`（`zotero_index`：build/update/refresh/status/stop/pause/resume/libraries）
  - 依赖：需要一个本地向量索引。当前 `host/fulltext.js` 已走 Zotero 的 FTS5，语义搜索要另建
  - 优先级：低（BM25 全文搜索已可用，语义是增强）

### 第 3 层：写入（依赖本地 API key）

现有 `host/annotations.js` 已有 `ensureApiKey` + `updateAnnotation` + `createAnnotation`，这批可复用：

- `annotate`（`zotero_annotate`：add / delete，highlight/underline/note/image）
- `create_items`（`zotero_create_items`：批量创建/更新，含 schema 校验、自动分块 50）
- `update_item`（`zotero_update_item`：PATCH 语义 + dry_run + 版本冲突重试）
- `delete_items`（`zotero_delete_items`：永久删除，需 `confirm:true`，默认禁用）
- `trash_items`（`zotero_trash_items`：回收站 + restore，比 delete 安全，优先实现这个）
- `manage_collections`（create / rename / reparent / delete / add_items / remove_items）
- `manage_tags`（list / add / remove）
- `tag_audit`（按受控词表审计）
- `merge_items`（合并重复条目，含 dry_run + 版本前置条件）
- `attach_file` / `attachment`（附件上传/下载/info，含 `find_oa` 走 OpenAlex）

### 第 4 层：云端（依赖 cloudApiKey）

- `import`（by_identifier / by_url / by_file / by_pdf，含 DOI/ISBN/PMID/arXiv 解析）
- `export`（bibtex / biblatex / ris / csljson / csv 等 15 种格式）
- `sync`（since 增量同步）
- 云端版的 items / annotations 读（`/cloud/*` 路由已就绪）

### 第 5 层：纯计算 / 外部服务

- `bibliography` / `format_bibliography`（CSL 渲染，需要 citeproc-js）
- `styles`（CSL 样式名解析）
- `schema`（Zotero 数据模型）
- `evidence_table`（把检索到的证据渲染成 Markdown/CSV 表格）
- `scholar`（OpenAlex / Crossref 引用图：lookup / references / citations / related / notices）
- `pdf_images`（PDF 页面/图片渲染，可复用插件已有的 pdfjs）
- `word_document`（写带 Zotero 活字段的 .docx）

## 关键设计问题（动手前要先定）

1. **工具名前缀**：搬过来叫 `zotero_*` 还是 `search_zotero_library` 这种？现有 3 个工具已经在用，改名会破坏已有会话的习惯。建议保留现有 3 个的名字，新增的用 `zotero_*`。

2. **库的寻址**：MCP 版区分 `library_type`（user/group）+ `library_id`。插件的 SQLite 快照现在只查个人库。`groups` 和群组库操作要先确认快照里有没有群组数据。

3. **语义索引放哪**：MCP 版有自己的 index 存储（sqlite）。插件要建的话放 `dataDir/cache/` 下，且要处理"换 embedding 模型要重建"。

4. **能力分级暴露**：31 个工具全暴露会让工具列表爆炸，模型选择困难。建议：
   - 高频只读（search / get / collections / tags / fulltext）默认开启
   - 写入类默认关闭，由用户在设置里显式开启
   - 危险操作（`delete_items` 永久删除）默认禁用

5. **与现有 MCP 的关系**：搬完之后 MCP `zotero` 服务器是否还要保留？两个都开着会导致同名工具冲突、模型二选一犯难。建议搬完后在 profile 里停用 MCP。

## 实施建议

不要一次搬 31 个。按层推进，每层完成后让用户实测一轮：

1. 先做第 1 层（本地只读 7 个）—— 无外部依赖，风险最低，覆盖日常大部分需求
2. 再做第 3 层的 trash/update/create（写入是第二大需求）
3. 第 2 层语义搜索优先级最低
4. 第 4/5 层按用户实际用到的再补

每层都要有对应 `test/check-*.mjs`，断言「工具已注册 + schema 正确 + 参数校验 + 错误分类」，不依赖真实 Zotero。
## 用户已确认的决策（2026-11-26）

上面「关键设计问题」里的几条，用户已拍板。**后续实现以本节为准，与上节冲突时以本节为优先。**

### 1. 工具名：现有 3 个也消灭，统一命名

用户原话：「现在已有的 3 个工具也可以消灭掉，和其它的合并。」

所以不保留 `search_zotero_library` / `read_zotero_paper` / `ask_zotero_paper` 这三个名字，全部并入统一命名体系（建议 `zotero_*`）。迁移时要同步改：`host/tools.js`、README、以及任何调用了旧工具名的地方。

### 2. MCP 搬完后卸载

用户原话：「搞定之后我会卸载 mcp 的。」

所以不需要处理「两边都开着」的冲突——用户会卸载 MCP `zotero` 服务器。插件这边只管把工具做全。

### 3. 群组库：先不管

用户原话：「群组库我不理解，先不管他。」

`groups` 以及所有带 `library_type` / `library_id` 的群组库寻址**跳过**，只做个人库。等用户后续需要再说。

### 4. 语义索引：位置可选 + 这台电脑先定默认

用户原话：「语义索引位置要求可选择。然后我这台电脑就默认配置对应位置了。」

- 设置页要有「语义索引位置」输入框（默认 `dataDir/semantic-index`，可改成任意路径）
- 这台电脑的默认值就用插件数据目录下的位置：
  `C:\Users\30759\.dsh-zotero-reader\semantic-index`
- 换位置后旧索引怎么办：提示「已存在的索引在旧路径，需要重建」而不是静默丢失

### 5. Embedding 必须做，用硅基流动 bge-m3

用户原话：「zotero embedded 的功能应该也要，api 可以建议用硅基流动的 bge-m3，是免费模型。反正也要在设置页可以配置就是了」

这就是 MCP 版的 `zotero_semantic_search` + `zotero_index` 能力，插件要自己实现。

**配置项**（都进设置页，走 config.js schema）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `embeddingProvider` | `siliconflow` | 目前只支持这一家，留接口 |
| `embeddingApiKey` | 空 | 密码框，只回 `Set` 布尔 |
| `embeddingModel` | `BAAI/bge-m3` | 硅基流动的免费 embedding 模型 |
| `embeddingBaseUrl` | `https://api.siliconflow.cn/v1` | 可改（兼容 OpenAI 协议的自建服务） |
| `embeddingBatchSize` | 32 | 批量 embedding 的条数 |
| `semanticIndexDir` | `dataDir/semantic-index` | 索引落盘位置，可配置 |
| `semanticIndexFulltext` | `false` | 是否把 PDF 正文也纳入索引（索引体积会涨很多） |

**技术要点**：
- 硅基流动 API 兼容 OpenAI 协议：`POST /v1/embeddings`，body `{model, input: [...]}`，返回 `{data: [{embedding: [...]}]}`
- bge-m3 输出 1024 维；批量请求注意单次 input 总量上限
- 索引存储：SQLite（向量存 BLOB + 元数据），或先用 JSON + 内存暴力检索，规模大了再换
- 检索：召回 top-K 后可与现有 BM25（`host/fulltext.js` 走的 FTS5）做 RRF 融合，这也是 MCP 版的做法
- 换模型/换维度要强制重建索引：把模型名和维度写进索引元数据，不匹配就拒绝查询并提示重建
- 免费模型有速率限制，要处理 429 退避

## 实施优先级（用户明确「工具先不管」）

用户原话：「工具先不管咯，列个 list 放到 todo 里面。也不知道什么时候才会真的内置进来hhhh」

所以**当前不实现**，只留清单。等用户主动提起再做。

真要开工时的建议顺序（不变）：
1. 第 1 层本地只读（无外部依赖，风险最低）
2. Embedding + 语义检索（用户明确点名要）
3. 第 3 层写入
4. 其余按需

## 完整工具清单（供日后核对）

已搬/已有 3 个（将被合并改名）：
- `search_zotero_library` → `zotero_search_items`
- `read_zotero_paper` → `zotero_get_fulltext`（部分）
- `ask_zotero_paper` → 保留为插件特色能力（带页码问答），不在 MCP 版里

待搬 31 个，按 MCP 服务器现有工具名：

只读查询类（9）
`search_items` `get_item` `list_collections` `list_tags` `groups`(跳过) `whoami` `saved_searches` `sync` `schema`

全文与语义（5）
`fulltext` `get_fulltext` `semantic_search` `index` `pdf_images`

写入类（10）
`annotate` `create_items` `update_item` `delete_items` `trash_items` `merge_items` `manage_collections` `manage_tags` `tag_audit` `attach_file`/`attachment`

导入导出与格式（6）
`import` `export` `bibliography` `format_bibliography` `styles` `word_document`

外部服务（4）
`scholar` `evidence_table` `tag_audit`(已计入写入) `note`(无)

> 注：上面分类有交叉，实际以 MCP 服务器当前暴露的为准；`search_tools` 是元工具不搬。
## 重要发现：现有 Zoteus 索引可直接复用（2026-11-26 实测）

用户问「我现在 zotero 的 embedded 的存储在哪里」——查清了，**和插件路径无关**，在 Zoteus 自己的数据目录。

### 实际位置

```
C:\Users\30759\AppData\Roaming\zoteus\search-index.sqlite    27.16 MB   ← 真数据
C:\Users\30759\AppData\Roaming\zoteus\search-index.json      47 B       ← 8 月的空壳，忽略
C:\Users\30759\AppData\Roaming\zoteus\local-api-key.json               ← Zotero 本地 key
C:\Users\30759\AppData\Roaming\zoteus\pdf-images\                      ← PDF 渲染缓存
```

注意：`zotero_index action:"libraries"` 报的 path 是那个空 json，实际数据在 sqlite —— 后端是 sqlite（`ZOTEUS_INDEX_BACKEND`），json 是旧格式残留。

### 索引内容与结构

```
meta: embedderId=openai:BAAI/bge-m3, codeDim=1024, schemaVersion=2,
      library=user, libraryBackend=local, libraryVersion=1305,
      itemsTotal=666, fulltextVersion=31442

passages      4572 行  pid, id, item_key, title, text, source, vector(BLOB 4096B = 1024×float32)
passages_fts 4572 行  FTS5 全文索引（BM25）
vector_codes 4572 行  pid, code(BLOB)  ← 量化码，两阶段向量检索
items         545 行   item_key, title
accent_variants 170    folded, term, df
meta           18 行   key, value
```

### 为什么可以复用

用户的 embedding 选型（硅基流动 bge-m3）与现有索引的 embedder（`BAAI/bge-m3`）**是同一个模型**，向量空间一致。所以：

- **不需要重建 4572 个向量**（省掉全部 embedding 调用）
- 只读访问即可，不怕损坏原文件
- MCP 卸载后文件仍在 `%APPDATA%\zoteus\`，继续可用

### 实现要点

1. `semanticIndexPath` 配置项默认值，本机填 `C:\Users\30759\AppData\Roaming\zoteus\search-index.sqlite`
2. 打开时用 `readOnly: true`，绝不写
3. 校验 `meta.embedderId` 与当前配置的 `embeddingModel` 是否兼容（都应是 `BAAI/bge-m3`），不匹配时**不报错**，提示「现有索引由 <embedderId> 建立，与当前模型不同，语义检索将退回 BM25」
4. 校验 `meta.codeDim`（1024）与模型输出维度一致
5. 查询流程：query → `/v1/embeddings` → 1024 维 → 与 `passages.vector` 做余弦 → top-K
6. 与 FTS5（`passages_fts`）做 RRF 融合，和 Zoteus 的做法一致
7. 若用户想自建索引（换位置/换模型），仍要支持全量 build，写入自己的 sqlite；两种模式共存，用配置区分

### 待确认

- Zoteus 用的 embedding API key 存在哪（环境变量 / DSH 配置 / Zoteus 自己的配置文件），新插件要独立配置，不复用它的 key
- `source` 字段全为 null，含义未知（可能是 note/annotation 来源标记，当前未启用）
## 凭据存储：一律走环境变量，配置文件只存变量名（2026-11-26 用户要求）

用户原话：「注意我这个插件所有 api 也要是弄成环境变量的方式存储，避免明文哦」

### 现有凭据分布（实测）

| 凭据 | 当前存放 | 状态 |
|---|---|---|
| `SILICONFLOW_API_KEY` | `C:\Users\30759\.dsh\.env`（51 字符） | 已存在，Zoteus 的 embedding 在用 |
| `ZOTERO_API_KEY` | `C:\Users\30759\.dsh\.env`（24 字符） | 已存在，zotero.org 云端用 |
| `mineruCloudToken` | `~/.dsh-zotero-reader/settings.json` **明文** | 要迁移 |
| Zotero 本地授权 key | `~/.dsh-zotero-reader/zotero-api-key.json` | 运行时申请的一次性 key，不是用户填的，可保留 |

DSH 启动时把 `.env` 加载进 `process.env`，插件（跑在 host 进程里）可以直接读。证据：`cordis.patch.yml` 的 `mcp-zotero` 段里写 `OPENAI_API_KEY: !!js process.env.SILICONFLOW_API_KEY`，且语义搜索实测可用（`embedderActive: true`）。

### 设计

`config.js` 里**存变量名，不存值**：

| 配置字段 | 默认值 | 说明 |
|---|---|---|
| `mineruTokenEnv` | `MINERU_API_TOKEN` | 指向环境变量名 |
| `cloudApiKeyEnv` | `ZOTERO_API_KEY` | 默认复用已有变量 |
| `embeddingApiKeyEnv` | `SILICONFLOW_API_KEY` | 默认复用已有变量 |

运行时 `process.env[settings.mineruTokenEnv]` 取值。变量名本身不是秘密，可以明文存在 `cordis.patch.yml` 里，`.role('secret')` 的用法随之取消。

### 具体改动

1. `config.js`：把 `mineruCloudToken` / `cloudApiKey` / `embeddingApiKey` 三个 `secret` 字段换成对应的 `*Env` 字段（纯字符串，变量名）
2. `index.js` 的 `normalizeConfig`：新增 `resolveSecret(envName)` 辅助，读不到时返回空串并记一条诊断（不要抛错，插件照常起动）
3. 插件页表单：不显示密码框，改成「环境变量名」输入框 + 状态行「已读到（长度 N）/ 未设置，请在 `.env` 里添加 `XXX=...`」
4. `settings.json` 里已有的 `mineruCloudToken` 明文：迁移时**写进 `.env`**（若变量已存在则跳过），然后把 settings.json 里的该字段清空并提示已迁移
5. 文档（README）说明凭据一律放 `.env`，给出样例变量名

### 安全要点

- 任何 HTTP 响应都不得回传 key 值，只回「已读到 / 未读到」
- 日志（`client-log.jsonl`、`exec-debug.log`）里不得出现 key 明文，诊断只记变量名和长度
- `.env` 的读取只在 host 侧，不下发到浏览器
- 如果变量名指向的变量不存在，功能降级而不是崩溃：MinerU 报「未配置 token」、云端 API 报「未配置 key」、embedding 退回纯 BM25

## 2026-11-26 凌晨：本轮变更

### 已完成：凭据全部走环境变量（`c5ee24e`）

- `config.js` 三个字段改为存变量名：`mineruTokenEnv`（默认 `MINERU_API_TOKEN`）、`cloudApiKeyEnv`（默认 `ZOTERO_API_KEY`）、`embeddingApiKeyEnv`（默认 `SILICONFLOW_API_KEY`）。`.role('secret')` 全部移除。
- `index.js:554` 的 `resolveSecret` 在运行时解析；`normalizeConfig` 只存变量名，解析值不写回、不进任何 HTTP 响应。
- 三个旧明文字段（`mineruCloudToken` / `cloudApiKey` / `embeddingApiKey`）在 `applyLegacySettings` 被显式跳过，`writeConfig` 写回前 `delete`，因此再保存也不会把 key 写进 profile YAML。
- 配置页不再有密码框，改为「环境变量名」输入 + 状态行「已读到 `XXX`（长度 N）」/「未设置 —— 请在 ~/.dsh/.env 里添加」。
- `.env` 迁移：追加 `MINERU_API_TOKEN`（51 字符），文件 983 → 1053 字节（正好 +70 = 键名 + 值 + 换行），原内容零改动，备份 `.env.bak-20261125170604`。`settings.json` 的 `mineruCloudToken` 清空为空串、键保留（不删键，避免旧代码读到 `undefined`）。
- 守卫：35/35 `check-*.mjs` 通过（`check-settings-contract` 129 项）、`node --check` 四文件、`harness-render` exit 0 且 effect 期无异常、仓库与提交内容 `sk-` 明文零命中、CRLF 未破（client.js 11721/0、index.js 1817/0，config.js 与 host 保持 LF）。

### 需求补丁：语义检索设置页要「推荐」硅基流动 bge-m3

用户原话：「这里是可以在设置页面推荐使用这个」。

不是只要能配置，还要有引导：默认值就是 `BAAI/bge-m3` + `https://api.siliconflow.cn/v1`，字段旁标注免费，并提供一键填入推荐配置的入口；换模型或换维度时提示必须重建索引，不能静默返回错结果。

### 新缺陷：首次打开文章整篇文字被全选

用户描述：整篇 PDF 文字铺满蓝色选区，像按了 Ctrl+A；关掉重开同一篇就正常，只有首次打开才有。

已排除的方向，下次别重查：

- 插件自身不产生选区。`client.js` 里 `selectAll` / `createRange` / `addRange` / `selectNodeContents` / `execCommand` / `.select()` 全部零命中，唯一的 `window.getSelection()` 在 L9207 的 mouseup 链里，只读不写。
- 没有 `::selection` 自定义样式，没有 `focus()` / `autoFocus` / `contentEditable` / `tabIndex` 写入。
- 不是遮罩误判。`viewer:restore-mask` 的遮罩是半透明层，用户明确区分了「蓝色选区」与「半透明色块」。

「首次才有、重开就好」指向一次性初始化路径（首次没有 `resumePage`，走 `pagesinit` 的 refresh + `scrollPageIntoView`），需要在首次打开后的短窗口内监听 `selectionchange`，抓 anchor/focus 指向的元素与最近的 pointer/key 事件。

### 待做：删除一键中文版后端

前端入口早已移除（`translateAll` / `exportChinese` / `modeChinese` 零引用，`/translate` 字符串在 `client.js` 零命中），host 侧仍在空转：`index.js` 的 `POST /translate`（L1721）、`/translate/progress`（L1767）、缓存读取（L1803）、缓存目录（L1811），加 `host/translate.js` 的 `translateDocument`、`config.js` 的 `translateConcurrency` / `translateChunkChars`、`features.docTranslate`。

保留 `POST /translate/selection` 与 `translateSelection` / `pickSelection`（划词翻译与解释），保留 `translateEfforts`。磁盘上已有的 `dataDir/translate/` 缓存不删，只是不再读写。
