# 更新日志（Changelog）

本文档记录「想法画布」每个版本的**更新内容（What）**、**更新原因（Why）**与**具体实现（How）**，并对应仓库 Git 标签与 `dist/releases/` 本地版本备份。

> 桌面版与本地数据目录的日常内容备份由 `DiskWorkspace.swift` 写入 `~/Library/Application Support/想法画布/`；代码与分发产物的版本归档由 Git Tag 与 `dist/releases/vX.Y.Z-bN/` 共同维护。

---

## [2.1.0] (Build 13) - 2026-11-26

本次版本涵盖四个阶段的连续迭代：卡片来源与 MCP 增强、渲染与沉浸窗口重构（Wave 1）、高频交互与工程化拆分（Wave 2），以及全站深浅色闭环与视觉精修（Wave 3）。

### 1. 卡片来源与补充说明（Provenance）及 MCP 增强

- **更新了什么**
  - 为每张卡片新增可选 `note`（补充说明 / 边界备注）与 `sources`（来源链接列表），并在卡片底部胶囊栏提供一键浮层查看（`#card-source-popover`）。
  - MCP 服务新增对 `note` / `sources` 的读写校验、内联链接自动转富文本及估算卡高适配。
- **为什么更新**
  - 调研类或资料整理类画布需要追溯观点出处与适用边界，直接把长链接和采样备注塞进正文会导致画布卡片臃肿。
- **具体做了什么**
  - [macos/DiskWorkspace.swift](macos/DiskWorkspace.swift) 与 [src/scripts/02-data.js](src/scripts/02-data.js) 扩展 `Card` 结构，对 `note` 长度（2000 / 16KB 字节上限）和 `sources` 数量、标题、URL 协议做边界校验。
  - [src/scripts/07-render.js](src/scripts/07-render.js) 与 [src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js) 在卡片底部渲染「来源 · 备注」按钮、定位浮层与编辑弹窗折叠区 `#note-provenance`。
  - [mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs) 与 [mcp/idea-canvas-mcp.test.mjs](mcp/idea-canvas-mcp.test.mjs) 补齐 `renderInlineLinksHtml`、`makeRichBody`、`estimateCardHeight` 和 `sources`/`note` schema 验证与单测。

### 2. Wave 1：渲染性能、macOS 全沉浸窗口与卡片视觉重塑

- **更新了什么**
  - macOS 桌面端升级为隐藏原生标题栏的全画布无界窗口，自适应深浅外观与背景色。
  - 卡片定位、连线重绘、相机缩放平移、语义缩略视图、浮动工具条与检视器控件全面重构。
- **为什么更新**
  - 旧版依赖 `left`/`top` 布局、全量重建 SVG 连线、缩放时靠 `display: none` 折叠卡片高度引起重排卡顿，同时顶部占位栏与 3px 左侧彩条导致界面观感偏重、不够通透。
- **具体做了什么**
  - **macOS 原生窗口（[macos/CanvasApp.swift](macos/CanvasApp.swift)）**：启用 `.fullSizeContentView`、`titleVisibility = .hidden`、`titlebarAppearsTransparent = true`，通过 `window-chrome` JS 桥接同步 `NSAppearance`（`.aqua` / `.darkAqua`）与窗口/WebView 底色，监听全屏切换设置 `--chrome-top: 30px`。
  - **渲染管线（[src/scripts/07-render.js](src/scripts/07-render.js)）**：卡片和分区改用 `transform: translate(...)` 定位；引入 `ResizeObserver` 缓存 `cardRect`；SVG 连线改为 `edgeIndex` 增量复用并在拖拽期间只更新关联边；补充 `animateCamera` 与平移惯性滑行；布局、折叠、对齐、撤销切换改为逐帧同步的 `animatePositions`。
  - **编辑与语义缩放（[src/styles/06-editing-and-menus.css](src/styles/06-editing-and-menus.css)）**：原位编辑保留类型徽标、封面与元信息胶囊，并把按键提示条移出卡外；缩放低于 `48%` 时仅通过 `opacity` 淡出正文，消除卡片跳动。
  - **视觉降噪（[src/styles/01-tokens.css](src/styles/01-tokens.css)、[src/styles/02-chrome.css](src/styles/02-chrome.css)、[src/styles/03-cards.css](src/styles/03-cards.css)、[src/styles/04-dock-and-dialogs.css](src/styles/04-dock-and-dialogs.css)）**：补全缺失的 `--surface`、加入高光内描边 `--glass-highlight`；去除重色卡片底色与 3px 左彩条，统一纯净底色配顶部 5% 微洗渐变与圆角徽标；选中态改用柔光外环；静默状态指示条 `#storage-status` 在 1.8 秒后自动收窄为圆点；移除左下角版本浮窗，选区栏 `.selection-tools` 精简为自定义 `#align-popover` 与 `#selection-more-popover`。
  - **连线与控件（[src/scripts/05-inspector.js](src/scripts/05-inspector.js)）**：四边新增 `.card-port` 圆形连线桩（避让 `.card-fold` 自动偏置到 26%）；折线改用圆角二次贝塞尔 `Q` 拐角、空心折角箭头与圆角标签胶囊；主题同步圆角小地图；属性面板接入预设色板与分段控制器。

### 3. Wave 2：高频交互补齐、多格式导出、桌面端原生集成与源码模块化

- **更新了什么**
  - 新增拖动磁吸对齐、方向键空间导航、拖放改挂父分支、`⌘K` 命令面板、非破坏性远端同步合并、PNG/SVG/Markdown 导出、macOS 原生菜单与窗口记忆。
  - 把约万行的单文件 HTML 拆分为 `src/` 模块目录与 `tools/bundle.sh` 构建脚本，并修复若干旧布局边界缺陷。
- **为什么更新**
  - 原先的参考线仅做绘制没有真吸附、键盘无法直接选卡、AI/同步写回会重置视野和撤销栈、导出缺乏图片和 Markdown 载体、单文件难以维护与定位问题。
- **具体做了什么**
  - **交互效率（[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)、[src/scripts/06-views.js](src/scripts/06-views.js)）**：实现 `7 / camera.scale` 阈值 `alignmentSnap`（按住 `Option` 禁用）；方向键按空间方位跳转选卡、`Shift+方向键` 加选、`⌥+方向键` 像素微调；拖动卡片悬停目标卡片 `350ms` 显示 `.is-drop-parent` 并通过 `CanvasViews.adoptAsChildren` 改挂分支与局部重排。
  - **命令面板与同步体验（[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/scripts/03-workspace-sync.js](src/scripts/03-workspace-sync.js)）**：`#search-panel` 合并 `paletteCommands`（支持 `>` 仅命令与跨动作 `runAction` 预览退出保护）；`adoptShared` 合并远端变更时保留当前选区、镜头视野、筛选及未变动画布的撤销历史，并为更新卡片触发 `1.8s` `.is-remote-updated` 高亮闪烁；`inlineEdit` 期间暂停 `pullShared`。
  - **多格式导出与桌面集成（[src/scripts/09-export.js](src/scripts/09-export.js)、[macos/CanvasApp.swift](macos/CanvasApp.swift)）**：新增 `CanvasExport`（`scene`、`toSVG`、最高 2x 分辨率 `toPNG`）与 `exportBoard`，支持按整图或单分支导出 PNG / SVG / Markdown，扩展 macOS `NSSavePanel` 支持 `png` base64；新增 `IdeaCanvasMainWindow` 窗口位置记忆与「文件 / 编辑 / 显示 / 窗口」原生菜单（WebKit 文本框 `⌘Z`/`⇧⌘Z` 通过 `'native'` 返回值委托给 `NSApp.sendAction`）。
  - **工程拆分与缺陷修复（[tools/bundle.sh](tools/bundle.sh)、[tools/bundle.test.mjs](tools/bundle.test.mjs)、[src/scripts/04-layout.js](src/scripts/04-layout.js)）**：拆分为 18 个 `src/` 文件并接入 `build.sh` 与 `bun test` 校验；补导出 `CanvasLayout.project` 与 `avoidFixed`，修复单卡复制 Markdown、树形折叠避障与自由布局改挂重叠问题。

### 4. Wave 3：整体 UI 精修、深色模式闭环与控件质感升级

- **更新了什么**
  - 修复冷灰蓝等主题切换时的主题色割裂和深色模式穿帮；降低画布常驻控件视觉噪点；新增分支层级线宽与「一键多彩分支」；升级主题可视化缩略卡、筛选顶部提示条、`⌘K` 高亮遮罩、编辑/帮助弹窗排版及增强型小地图。
- **为什么更新**
  - 第二轮完成后，画布仍存在若干细碎穿帮：深色下系统控件与提示条对比度异常、冷灰蓝主题中心卡和品牌标依然发绿、已展开 `−` 按钮常驻压线、分支线缺少主次层级、主题下拉框无法所见即所得、弹窗表单感偏重。
- **具体做了什么**
  - **主色贯通与深色闭环（[src/scripts/07-render.js](src/scripts/07-render.js)、[src/styles/01-tokens.css](src/styles/01-tokens.css)、[src/styles/03-cards.css](src/styles/03-cards.css)、[src/styles/04-dock-and-dialogs.css](src/styles/04-dock-and-dialogs.css)）**：`paintAppearance` 联动 `<meta name="color-scheme">`、太阳/月亮图标切换，并用 `mixHex` 派生主题卡深色渐变（同时保持 `cardDefaultsFor` 不覆盖 `topic` 卡底色以保留主题渐变）；`.toast`、`#sync-alert`、代码块、色板边框补全深色适配；移除顶栏「布局」按钮伪激活态；收紧 740px 搜索折叠断点；统一抽屉关闭钮为 SVG 图标。
  - **画布克制感与分支表达（[src/styles/05-panels.css](src/styles/05-panels.css)、[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)、[src/scripts/06-views.js](src/scripts/06-views.js)）**：已展开 `−` 折叠钮默认隐藏、悬停或选中显现，已折叠 `+N` 常驻以强调色高亮；分支线条按树深逐级减细并默认隐藏箭头；右侧 `.card-size` 改为细长竖条抓手；悬停聚焦加 160ms 防抖并柔化淡出比例；关闭视图抽屉后画布顶部保留 `#view-filter-strip` 筛选条。
  - **控件、命令面板、弹窗与小地图（[src/scripts/05-inspector.js](src/scripts/05-inspector.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/index.html](src/index.html)）**：主题列表改用 2 列实时缩略卡片；新增「一键多彩分支」与「还原默认色」；卡片类型与文字色/分区色均换成可视化胶囊或预设圆点，滑块定制细轨道；`⌘K` 面板增加虚化遮罩、类型圆点、`<mark>` 命中高亮与底部快捷键栏；画布切换清单显示父子缩进与卡片数；`#note-dialog` 改用无边框文档标题、`#help-dialog` 重排为四分组双栏网格；小地图去掉顶栏改为悬浮关闭钮并绘制分区色块与选卡高亮框；修复原位编辑启动时 `renderSelection()` 未隐藏旧选区栏的遮挡。

- **版本标记与备份**
  - Git 提交及标签：`v2.1.0`
  - 备份归档目录：`dist/releases/v2.1.0-b13/`（含签名桌面包、单文件离线 HTML、`RELEASE-NOTES.md`、`manifest.json` SHA-256 清单）

---

## [2.0.0] (Build 12) - 2026-11-25

- **更新了什么**
  - 全屏浮动工具岛重构、画布原位快速编辑、待办清单与进度胶囊、子画布下钻与面包屑导航、跨画布搜索、本机 AI/MCP 服务（[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)）及自动迁移旧版默认配色。
- **为什么更新**
  - 将画布从早期的传统侧边栏工具栏升级为全屏无限画布工作台，并打通本机 AI 工具直接读写与桌面/浏览器实时同步能力。
- **具体做了什么**
  - 对应提交：`68cd739`、`7d10e4c`（Git 标签 `v2.0.0`），升级桌面端至 `2.0.0 (12)` 并补充「关于想法画布」菜单与 `v2.0` 指南。
  - 基线归档：`dist/releases/v2.0.0-b12/`

---

## [1.3.4] - 2026-11-25

- **更新了什么**
  - 新增多布局排版引擎（向右逻辑图、中心双侧、上下树形、时间轴、分类矩阵、鱼骨图、自由摆放）、主题样式管理、卡片状态/标签/优先级筛选及分区框架功能。
- **为什么更新**
  - 支持从单纯自由连线过渡到结构化思维导图、项目分类矩阵和专题整理视图。
- **具体做了什么**
  - 对应提交：`1830b3b`（Git 标签 `v1.3.4`），扩展 `DiskWorkspace.swift` 数据校验、`build.sh` 与离线 HTML 排版引擎。

---

## [1.0.0] - 2026-11-24

- **更新了什么**
  - 初始化独立「想法画布」离线单文件 HTML 项目与 macOS `WKWebView` 桌面壳，建立 `build.sh` 独立签名打包脚本。
- **为什么更新**
  - 让离线 HTML 画布具备原生 Mac 应用窗口、本机持久化与浏览器回环同步能力。
- **具体做了什么**
  - 对应提交：`6c01c9a`、`4b851d4`。
