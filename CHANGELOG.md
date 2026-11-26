# 更新日志（Changelog）

本文档记录「想法画布」每个版本的**更新内容（What）**、**更新原因（Why）**与**具体实现（How）**，并对应仓库 Git 标签与 `dist/releases/` 本地版本备份。

> 桌面版与本地数据目录的日常内容备份由 `DiskWorkspace.swift` 写入 `~/Library/Application Support/想法画布/`；代码与分发产物的版本归档由 Git Tag 与 `dist/releases/vX.Y.Z-bN/` 共同维护。

---

## [2.2.0] (Build 18) - 2026-11-26

围绕数百张卡片规模的大画布阅读体验，完成六项视图与布局优化，并在全量自动化测试与真实画布浏览器对比中验证通过。

### 更新清单（更新了什么 / 为什么更新 / 具体做了什么）

1. **树形叶子多列网格与绕行连线（[src/scripts/04-layout.js](src/scripts/04-layout.js)、[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/09-export.js](src/scripts/09-export.js)、[tools/canvas-logic.test.mjs](tools/canvas-logic.test.mjs)）**
   - **为什么**：水平树形布局下，一个节点下挂 5 到 16 张叶子卡片时会排成一根很长的竖条，纵向翻找成本高。
   - **做了什么**：在 `CanvasLayout.layers` 新增 `leafGrid` 与 `gridMetrics`，向右与双侧树形模式下将 5 至 9 张纯叶子子节点排为 2 列、10 张及以上排为 3 列，且不挤占更深子树的全局层级列宽；新增 `routedBranchCurve` 与 `branchEdgeCurve` 供渲染与 SVG/PNG 导出共用，让第 2、3 列连线绕行卡片行缝和列缝而不穿过同级卡片。
2. **按层级区分卡片视觉、去除冗余类型行与右上角状态圆点（[src/styles/03-cards.css](src/styles/03-cards.css)、[src/styles/05-panels.css](src/styles/05-panels.css)、[src/styles/06-editing-and-menus.css](src/styles/06-editing-and-menus.css)、[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/scripts/09-export.js](src/scripts/09-export.js)）**
   - **为什么**：旧版全树主题卡共用重色底，顶部重复出现「主题」「素材」字样，底部反复挂出状态标签，整屏视觉重量接近。
   - **做了什么**：卡片写入 `data-depth`，第 0 至第 2 层主题卡保持深色实底，第 3 层及更深卡片切换为浅底加左侧 3px 强调色条；移除顶部 `.card-type` 行；状态标签改为右上角彩色圆点，采用右对齐反向布局使悬停或选中时向左展开完整名称且圆点位置固定，同步对齐导出坐标。
3. **按缩放切换标题速览（[src/scripts/07-render.js](src/scripts/07-render.js)、[src/styles/03-cards.css](src/styles/03-cards.css)）**
   - **为什么**：拉远看全图时正文和标题过小，看不清大结构。
   - **做了什么**：缩放低于 60% 进入 `is-overview` 后隐藏正文并在卡片内居中放大显示加粗标题；低于 30% 进入 `is-far` 后淡化并隐藏第 3 层及以下卡片的文字，突出上层主干。
4. **单分支钻入视图与可点击路径（[src/scripts/06-views.js](src/scripts/06-views.js)、[src/index.html](src/index.html)、[src/styles/05-panels.css](src/styles/05-panels.css)）**
   - **为什么**：旧版聚焦分支仅淡化其余卡片，大画布上干扰仍强，且无法沿层级逐级返回。
   - **做了什么**：`CanvasViews.focus` 改为隐藏分支外卡片并在目标折叠时自动展开；顶部路径条渲染最多 4 级可点击祖先面包屑和「看全部 Esc」按钮；切换焦点或退出前自动收口原位编辑。
5. **避让浮动工具栏与浮岛自动让位（[src/scripts/03-workspace-sync.js](src/scripts/03-workspace-sync.js)、[src/scripts/07-render.js](src/scripts/07-render.js)、[src/styles/04-dock-and-dialogs.css](src/styles/04-dock-and-dialogs.css)）**
   - **为什么**：定位、聚焦或弹出卡片悬浮操作条时容易压住顶栏、底栏或路径条。
   - **做了什么**：`chromeTopLimit` 统一计入可见的路径条和筛选条底边，新增 `canvasSafeInsets` 供 `reveal` 与 `fitNodes` 使用；`paintChromeCover` 检测卡片位于浮岛下方时自动降低浮岛透明度，悬停或聚焦恢复不透明。
6. **已完成待办默认收起（[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)、[src/styles/05-panels.css](src/styles/05-panels.css)、[src/styles/06-editing-and-menus.css](src/styles/06-editing-and-menus.css)、[src/scripts/09-export.js](src/scripts/09-export.js)）**
   - **为什么**：深色卡片上带删除线的已完成待办对比度偏低且拉长卡片高度。
   - **做了什么**：非编辑状态下默认隐藏已完成待办条目并去除删除线，在 `.card-copy` 中增加独立 `.done-toggle` 按钮按需展开或收起，标题模式与导出自动跳过隐藏条目。

- **验证与回归测试**
  - `bun test` 扩至 **23 条用例、18,251 次断言**，全部通过；并在真实 907 卡画布浏览器环境下完成新旧对比与边界回归。
- **版本标记与备份**
  - Git 提交及标签：`v2.2.0`
  - 备份归档目录：`dist/releases/v2.2.0-b18/`

---

## [2.1.4] (Build 17) - 2026-11-26

一次性根治前后端深度审计发现的全部 17 项缺陷，并引入「JS / Swift / MCP 三端统一数据契约测试」「真实 Swift 回环服务协议测试」与「200 步随机状态压测」作为长期结构性防回归护栏。

### 修复与加固清单（更新了什么 / 为什么更新 / 具体做了什么）

1. **跨画布撤销安全与 Unicode 码点安全截断（[src/scripts/01-rich-text.js](src/scripts/01-rich-text.js)、[src/scripts/02-data.js](src/scripts/02-data.js)、[src/scripts/03-workspace-sync.js](src/scripts/03-workspace-sync.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)）**
   - **为什么**：在画布 A 执行「提取为子画布」写入整库快照后，再到其他画布编辑或新建/导入画布，切回按 `⌘Z` 会静默覆盖整个 `workspace.boards`；按 UTF-16 码元 `.slice()` 截断长标题或图片 `alt` 会拆分 Emoji 留下孤立代理码点，导致 Swift `JSONDecoder` 拒收保存或下次无法启动。
   - **做了什么**：新增 `invalidateCrossBoardUndo`，在跨画布编辑、新建、删除、导入及同步合并时自动清理过期的整库快照与他表主题快照；新增 `sanitizeUnicode` 与按 Unicode 码点切分的 `sliceChars`，统一收口剪贴板粘贴、图片 `alt` 及 `CanvasData.parse` 解析，彻底杜绝孤立代理码点。
2. **统一快捷键与焦点路由、原生退出与弹窗 Sheet 防护（[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)、[src/scripts/05-inspector.js](src/scripts/05-inspector.js)、[macos/CanvasApp.swift](macos/CanvasApp.swift)）**
   - **为什么**：焦点留在浮条按钮或属性面板时 `Delete`/`E`/`Tab`/`⌘S`/`⌘Z` 失效；`⌘K` 未关闭右键与子浮层；桌面版 `applicationShouldTerminate` 返回 `.terminateCancel` 会中断 macOS 重启/关机及 AppleScript 退出；布局预览与非输入弹窗中按 `⌘A` 会全选顶部栏文字污染后续复制，按 `⌘Z` 会误撤销历史；原生保存面板打开时菜单栏仍可在背后叠弹 sheet。
   - **做了什么**：统一 `isTextInputEl` 与 `hasSelectedText` 状态判定，把修饰键命令提前至按钮过滤前执行并放行属性面板内 `⌘Z`/`⌘Y`/`⌘S`，快捷色点/固定按钮/浮层 `Esc` 后自动归还画布焦点，浏览器 `⌘C`/`⌘X` 不再窃取文本选区、`⌘A` 兼容聚焦卡片、`paste` 使用可选链防 Safari `Text` 节点报错；`CanvasApp.swift` 改用标准 `.terminateLater` + `sender.reply(toApplicationShouldTerminate:)` 并为所有原生 Sheet 命令加防叠加保护。
3. **正文链接保真、待办清单编辑、主题删除按钮与布局/分区/模式细节修复（[src/scripts/04-layout.js](src/scripts/04-layout.js)、[src/scripts/05-inspector.js](src/scripts/05-inspector.js)、[src/styles/05-panels.css](src/styles/05-panels.css)、[src/scripts/06-views.js](src/scripts/06-views.js)、[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)、[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)）**
   - 新增 `linkifyRichElement` 在渲染 `richBody` 时保留并自动识别文本中的 URL 链接；修复待办编辑中 `Shift+Enter` 删前一行、加粗开头重复前缀、普通空段落被吸回待办、空图待办按回车删图以及中间行回车分割问题。
   - 为自定义主题容器补加 `.inspector-theme-wrap` 修复悬停删除按钮 `×` 透明不可见；矩阵/时间轴/鱼骨图统一过滤折叠隐藏节点且局部范围布局不再污染整表辅助线；连线/平移模式下屏蔽复选框、链接与图片灯箱误触并重置触控惯性速度；修复分区拖拽缩回与窄卡空分区下限（`120×90`）、剪切粘贴子画布入口 `parentId`/失效引用同步、大纲 `↑`/`↓` 树形重排、树形折叠避让内部固定卡，以及图片粘贴文件名 DOM 转义。
4. **Swift 回环服务协议边界、MCP 契约对齐与打包脚本加固（[macos/DiskWorkspace.swift](macos/DiskWorkspace.swift)、[macos/CanvasLoopback.swift](macos/CanvasLoopback.swift)、[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)、[tools/bundle.sh](tools/bundle.sh)、[build.sh](build.sh)）**
   - `DiskWorkspace.swift` 拆分 `CanvasValidationError` 使 `PUT /api/state` 校验与版本降级错误准确返回 `400 invalid_snapshot`；`CanvasLoopback.swift` 放行跨端口 UTF-8 Cookie 且关闭 MCP 接入时对 Bearer 写入返回 `401 unauthorized`。
   - MCP `validateWorkspace` 补全孤立代理字符与 5 个强类型卡片字段校验；`offlineRead`/`offlineWrite` 补齐缺失主文件备份防覆盖保护，并将读旧文件与历史备份写入全量收进 `flock` + `dir_fd` + `O_NOFOLLOW` + `fsync` 原子区；`saveWorkspace` 实时重检 `local-api.disabled`；修复无 `order` 卡片 `beforeSiblingId`/`afterSiblingId` 排序、128 字符长 ID 连线越界、`resolveBoard` 精确名称优先、`httpCall` 线性缓冲与 RST 截断防护，以及 `startStdioServer` 通用头识别和 `EOF` 收尾。
   - `tools/bundle.sh` 改用同目录临时文件原子替换、信号清理与段末换行保护；`build.sh` 从同一构建快照复制独立 HTML 归档。
5. **三端统一契约测试、真实 Swift 回环测试与 200 步随机压测（[tools/contract-and-fuzz.test.mjs](tools/contract-and-fuzz.test.mjs)、[mcp/idea-canvas-mcp.test.mjs](mcp/idea-canvas-mcp.test.mjs)）**
   - 新增自动编译运行真实 Swift `DiskWorkspace` 与 `CanvasLoopback` 的跨端契约与压测套件，`bun test` 扩至 **20 条用例、5,819 次断言**，全部通过。

- **版本标记与备份**
  - Git 提交及标签：`v2.1.4`
  - 备份归档目录：`dist/releases/v2.1.4-b17/`

---

## [2.1.3] (Build 16) - 2026-11-26

集中修复桌面版与离线 HTML 剪贴板及编辑菜单路由、矩阵/时间轴/鱼骨图辅助线导出、MCP 无长度头 HTTP/1.1 响应分包解析，以及原位空卡切换类型后展开大窗丢类型等 4 处缺陷。

### 修复清单（更新了什么 / 为什么更新 / 具体做了什么）

1. **桌面版、离线 HTML 剪贴板写入与 macOS「编辑」菜单路由修复（[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)、[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)、[src/scripts/03-workspace-sync.js](src/scripts/03-workspace-sync.js)、[macos/CanvasApp.swift](macos/CanvasApp.swift)）**
   - **为什么**：桌面版 `WKWebView` 与双击打开的离线 HTML 均运行在非安全 `file://` 源，直接调用 `navigator.clipboard.writeText` 会报错或静默失败，导致「复制为 Markdown」「复制来源地址」不可用，且 `⌘C` 未同步系统剪贴板使后续 `⌘V` 误粘贴旧文本；同时 macOS 菜单栏的剪切/复制/全选直接绑定 `NSText`，页面未监听 `copy`/`cut` 事件导致桌面端操作画布卡片不生效。
   - **做了什么**：在 `CanvasApp.swift` 新增 `clipboard-write` 消息通道写入 `NSPasteboard.general`，并将菜单栏「剪切 / 复制 / 全选」接入 `window.ideaCanvasCommand`（在输入框、弹窗、文本选区及原生保存/打开面板 sheet 中自动回退原生 `NSText`）；前端新增统一 `writeClipboardText`（按事件 `clipboardData` → 桌面端 IPC → 安全上下文 `navigator.clipboard` → `file://` 同步离屏 `textarea` `execCommand('copy')` 降级并恢复焦点），并补齐画布 `copy`/`cut` 事件监听。
2. **分类矩阵、时间轴与鱼骨图导出补齐布局辅助结构（[src/scripts/09-export.js](src/scripts/09-export.js)）**
   - **为什么**：`CanvasExport.scene` 此前仅导出分区、连线与卡片，未绘制 `displayedLayout().guides`，导致三种结构化布局导出的 PNG / SVG 丢失网格线、行列标题、时间轴序号与鱼骨主轴。
   - **做了什么**：整图导出时一并绘制矩阵交替行底纹、辅助线、带底色描边的行列标题、时间轴主轴与编号、鱼骨脊柱与分支骨，将其边界纳入导出画幅计算防裁切，并在矩阵导出中保持与画布一致的淡化连线与连线标签；单卡/局部子树导出保持紧凑裁切不混入整表网格。
3. **MCP 底层 HTTP/1.1 无 `Content-Length` 非分块响应完整性修复（[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)）**
   - **为什么**：`parseHttpResponse` 在 `data` 事件到达首个 TCP 包时，对既无 `Content-Length` 又非 `chunked` 的响应会直接结算导致多包响应被截断。
   - **做了什么**：为 `parseHttpResponse` 增加 `eof` 参数，非 `204`/`304` 且无长度头与分块编码的响应等待连接 `end` 后再解析。
4. **原位新建空卡切换类型后展开大窗或粘贴图片保留卡片类型（[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)）**
   - **为什么**：新建空卡未输入文字前点击原位工具栏切换类型，再点「大窗」或直接粘贴图片时，`syncInline` 因空新卡提前返回导致已选 `tone` 未写回节点，打开大窗后回退为默认「想法」。
   - **做了什么**：在展开大窗与粘贴图片收口前同步写入 `targetNode.tone = inlineEdit.tone`，并在 `finishInline`/`cancelInline` 主动清理 `triggerKey` 抑制监听。
5. **回归测试扩容（[tools/canvas-logic.test.mjs](tools/canvas-logic.test.mjs)、[mcp/idea-canvas-mcp.test.mjs](mcp/idea-canvas-mcp.test.mjs)）**
   - 新增剪贴板多环境降级路由、矩阵/时间轴/鱼骨图 SVG 引导层导出，以及 MCP 无长度头分包 HTTP 响应测试（共 16 条测试、185 次断言全部通过）。

- **版本标记与备份**
  - Git 提交及标签：`v2.1.3`
  - 备份归档目录：`dist/releases/v2.1.3-b16/`

---

## [2.1.2] (Build 15) - 2026-11-26

围绕多轮代码审计与浏览器端到端压测，集中修复原位编辑生命周期、快捷键防串键、折叠子树与分区联动、多图导出、macOS 隐藏窗口弹窗与路径校验，以及 MCP 本地回环和协议边界问题。

### 修复清单（更新了什么 / 为什么更新 / 具体做了什么）

1. **原位编辑完整卡片 DOM、未提交清理与确定性快捷键防串键（[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)）**
   - **为什么**：原位新建卡片此前挂载精简 DOM，缺失连线桩、宽调抓手、折叠按钮与 `ResizeObserver` 监听；在空新卡上按 `Shift+Enter` 后按 `Tab` 会产生悬挂连线；`rAF` 延时聚焦会与 Chromium `char` 事件竞态导致 `N`/`E` 首字符偶发写入输入框；`e.stopPropagation()` 阻断编辑与面板内 `⌘K`。
   - **做了什么**：抽出完整卡片构建函数 `createCardView` 供新建与渲染共用；在 `finishInline`、`cancelInline` 解除 `ResizeObserver` 观察并移除未提交临时 DOM；校验 `Tab` 创建子卡前父节点已真实写入画布；为 `N`/`E` 触发的 `openInline` 与 `openText` 增加 `triggerKey` 的 `beforeinput`/`input` 一次性抑制并保持同步聚焦；允许 `⌘K`/`Ctrl+K` 从原位编辑、[属性面板](src/scripts/05-inspector.js) 与分区改名框冒泡；在 `runAction` 与 `openNote` 执行前自动收口 `inlineEdit`；修复点击底部「来源 · 备注」胶囊无法二次关闭浮层的问题。
2. **折叠分支建子卡、拖拽改挂、分区移动与多图导出修复（[src/scripts/06-views.js](src/scripts/06-views.js)、[src/scripts/07-render.js](src/scripts/07-render.js)、[src/scripts/09-export.js](src/scripts/09-export.js)、[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)、[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)）**
   - **为什么**：向已折叠父卡新增子卡会立即被隐藏；把折叠节点拖拽改挂或整组拖动时会把已折叠后代留在旧坐标；无 `box` 分区先改坐标后计算边界导致无法拖出分区；多图无文卡片会隐藏第 2 张起图片；正文插图导出时文字与图片重叠；提取折叠子树为子画布后残留父卡折叠标记。
   - **做了什么**：新建子卡写入时自动展开父卡；`extractToSubBoard` 改用 `!movedSet.has(id)` 清理折叠记录，保留下级 `subBoardId` 并重绑孙子画布 `parentId` 与 `layout.rootId`；拖拽与 `adoptAsChildren` 同步平移未固定隐藏子孙；拖拽前预先记录 `preDragBoxes` 并过滤隐藏成员；`renderCards` 在插入富文本后判断正文显隐；`CanvasExport.cardShapes` 遇到正文内插图时按元素区块分别定位文字与图片，`scene` 传 `visibility.hidden` 计算分区范围，`exportScopeIds`/`exportBoard` 过滤隐藏节点。
3. **来源备注 UTF-8 上限对齐、中文路径、撤销清理与冲突副本保护（[src/scripts/01-rich-text.js](src/scripts/01-rich-text.js)、[src/scripts/02-data.js](src/scripts/02-data.js)、[src/scripts/03-workspace-sync.js](src/scripts/03-workspace-sync.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)、[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)）**
   - 新增按码点不截断的 `utf8Slice` 与支持非 ASCII 相对路径的 `cleanSourceUrl`，统一 `note`（16KB UTF-8）与 `sources`（64 条、600B 标题、4096B 路径）前后端上限；允许 `richBody: null` 兼容桌面端解码；`parseMarkdownTree` 支持围栏代码块保护与 `[✓]` 待办；`deleteBoard` 清理其他画布撤销栈中的整库快照防止已删画布被还原；`saveConflictCopy` 空基线不再抛出 `JSON.parse('')` 异常；`pullShared` 跳过分区原位重命名期，对齐指令坐标做画布范围钳位（[src/scripts/04-layout.js](src/scripts/04-layout.js)）。
4. **macOS 桌面端窗口弹窗与导出目录防护（[macos/CanvasApp.swift](macos/CanvasApp.swift)）**
   - **为什么**：窗口经 `Cmd+W` 隐藏后若存在未保存草稿直接退出或点击同步链接菜单，表单式提示卡附着在不可见窗口上导致无法操作与退出卡死；APFS 默认大小写不敏感使 `画布数据.JSON` 绕过原有覆盖保护。
   - **做了什么**：在 `applicationShouldTerminate`、`copySyncLink` 与 `toggleLocalAPI` 弹出 sheet 前唤起窗口前置；导出目标检查改用不区分大小写路径校验并屏蔽整个 `store.root` 本地数据目录。
5. **MCP 回环传输、LSP 分帧、离线写入与参数校验加固（[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)）**
   - `httpCall` 改用 `node:net` 直连 `127.0.0.1` 彻底绕开系统 `HTTP_PROXY`，支持 `ECONNRESET` 前已到达 HTTP 4xx 响应解析（如 413 体积超限）、`Content-Length` 与 chunked 完整性校验；`startStdioServer` 支持分块首包与 `Content-Type` 先行的 LSP 头并用 `.catch()` 防异步链挂死；`offlineRead`/`offlineWrite` 增加 `O_NOFOLLOW`、`fstat`、全量写入循环与 `.tmp` 异常清理；拒绝 `NaN`/`Infinity` 数值、不支持的 `board.view` 缺省与不存在的同级参考节点，`canvas_status` 无密钥锁定时正确回报状态，`canvas_get_cards` 支持 `limit <= 0`，`canvas_upsert_cards` 支持 `parentId: null` 与 `priority: 'none'`，`canvas_sync_mirror` 校验文件存在/JSON 合法并保留镜像 `themes`。
6. **构建脚本输出权限与回归测试扩容（[tools/bundle.sh](tools/bundle.sh)、[build.sh](build.sh)、[tools/canvas-logic.test.mjs](tools/canvas-logic.test.mjs)、[mcp/idea-canvas-mcp.test.mjs](mcp/idea-canvas-mcp.test.mjs)）**
   - 修正 `mktemp` `0600` 产物权限未重设为 `0644` 的问题（兼容 macOS BSD `chmod` 语法）；测试覆盖增至 13 条用例、153 次断言，全部通过。

- **版本标记与备份**
  - Git 提交及标签：`v2.1.2`
  - 备份归档目录：`dist/releases/v2.1.2-b15/`

---

## [2.1.1] (Build 14) - 2026-11-26

集中修复前端画布、剪贴板、大纲树、导出渲染与 MCP 服务的 13 处边界缺陷，并补充核心逻辑回归测试。

### 修复清单（更新了什么 / 为什么 / 做了什么）

1. **MCP 保真富文本与插图（[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)）**
   - **为什么**：此前 AI 通过 `canvas_upsert_cards` 更新正文时会直接清空不含内联链接的 `richBody`，导致用户粘贴的截图和格式丢失。
   - **做了什么**：正文文本未变化时原样保留 `richBody`；正文变更且原有 `<img>` 时提取保留所有图片再拼接新段落 HTML。
2. **MCP 离线写入对齐桌面端字节上限（[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)）**
   - **为什么**：桌面端关闭期间离线写入超长 `note` 或过量 `sources` 会导致下次启动被 `DiskWorkspace.swift` 拒载整库。
   - **做了什么**：在 `validateWorkspace` 强制校验 `note <= 16KB`、`sources <= 64`、标题与 URL UTF-8 字节上限。
3. **MCP 删卡清理、同批排序、星标与镜像口径统一（[mcp/idea-canvas-mcp.mjs](mcp/idea-canvas-mcp.mjs)）**
   - `canvas_delete_cards` 同步清理 `settings.folded`、`frames[].members` 及失效 `layout.rootId`。
   - `canvas_upsert_cards` 放弃 `Number.MAX_SAFE_INTEGER` 占位（修复 `-0.5` 浮点精度失效），改为按每张卡增量重算顺序。
   - `VALID_PRIORITIES` 与 Schema 补全 `star`；新建画布默认配置对齐 v2.1 配色；`canvas_get_outline` 采用 `buildOutlineTree`（两阶段 `branch`/`link` 无环树）与前端大纲保持一致。
4. **单卡带子节点复制粘贴保真与「复制卡片」深拷贝（[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)）**
   - **为什么**：单选父卡按 `⌘C` 时内部仅复制单卡而剪贴板写入整棵子树 Markdown，粘贴因文本比对不匹配退回纯文本解析；「复制卡片」浅拷贝共享对象数组与 `subBoardId`。
   - **做了什么**：粘贴比对直接核对内部载荷生成的 `clipboardText`，粘贴跨画布重复 `subBoardId` 时清理重复入口；`duplicateSelected` 改用 `structuredClone` 并清除 `subBoardId`。
5. **导入 JSON 与冲突副本重建父子画布引用（[src/scripts/10-clipboard.js](src/scripts/10-clipboard.js)、[src/scripts/03-workspace-sync.js](src/scripts/03-workspace-sync.js)）**
   - `importFile` 与 `saveConflictCopy` 统一先生成旧→新画布 ID 映射表，再同步更新 `settings.parentId` 与卡片 `subBoardId`。
6. **退出应用 / 切走标签前刷新原位编辑（[src/scripts/11-input-and-startup.js](src/scripts/11-input-and-startup.js)）**
   - 在 `ideaCanvasBeforeQuit`、`pagehide`、`visibilitychange`、`beforeunload` 均优先执行 `syncInline()` 提交未落盘文字。
7. **原位编辑隐藏重复封面图与延后聚焦防串键（[src/styles/06-editing-and-menus.css](src/styles/06-editing-and-menus.css)、[src/scripts/08-editing-and-search.js](src/scripts/08-editing-and-search.js)）**
   - 原位编辑隐藏只读 `.card-cover` 改为单份 `.inline-body img` 显示；初始聚焦延后至下一 `requestAnimationFrame`，消除 `E` / `N` 键进入编辑偶发写入字母的问题；空白处右键「展开全部折叠分支」改为直接调用 `CanvasViews.expandAll()`；`Enter` 同步支持编辑选中连线；大纲 `setParentEdge` 与 `addBranch` 兼容仅有普通关系线的节点。
8. **导出细节与小地图边界修正（[src/scripts/09-export.js](src/scripts/09-export.js)、[src/scripts/06-views.js](src/scripts/06-views.js)、[src/scripts/07-render.js](src/scripts/07-render.js)）**
   - PNG/SVG 导出时临时移除概览/缩略字体放大类、为待办清单项补全 `☑`/`☐` 符号、为类型胶囊绘制色点；小地图计算分区框时过滤隐藏节点。
9. **自动化测试扩容（[mcp/idea-canvas-mcp.test.mjs](mcp/idea-canvas-mcp.test.mjs)、[tools/canvas-logic.test.mjs](tools/canvas-logic.test.mjs)）**
   - 新增 MCP 富文本保真/字节上限/同批排序/删卡清理测试，以及前端 `CanvasData` 与 `CanvasLayout` 核心逻辑单元测试。

- **版本标记与备份**
  - Git 提交及标签：`v2.1.1`
  - 备份归档目录：`dist/releases/v2.1.1-b14/`

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
