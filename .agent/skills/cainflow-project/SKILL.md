---
name: cainflow-project
description: CainFlow 项目导航 Skill。用于修改功能、重构或排查问题时，帮助 AI 快速定位正确的前端、后端、样式与工作流模块，避免继续把逻辑堆进入口文件。
---

# CainFlow 项目导航

> 当前适配版本：以 `js/core/constants.js` 中的 `APP_VERSION_NUMBER` 为准，不在 Skill 中维护固定版本号。

这个 skill 的目标只有两件事：

1. 帮助快速判断“改动应该落在哪个模块”。
2. 提醒少数高风险链路，避免改一处炸一片。

如果需要更细的目录表、文件职责或常见需求落点，打开 `references/architecture-map.md`。

## 快速落点

- 页面结构与静态挂载点：`index.html`
- 前端总装配与模块注入：`index.js`
- 共享状态、常量、DOM、工具：`js/core/*`
- API / 代理 / IndexedDB / 工作流接口：`js/services/*`
- 画布缩放、框选、连线、自动整理：`js/canvas/*`
- 批量连线、输入端口改线、连线候选与剪线采样：`js/canvas/*` + `js/nodes/node-dom-bindings.js`
- 节点模板、绑定、生命周期、序列化：`js/nodes/*`
- 执行引擎、请求拼装、异步媒体任务、工作流运行：`js/features/execution/*`
- 媒体处理、图片/视频预览、图片对比、裁剪、涂鸦、图片保存：`js/features/media/*`
- 工作流导入导出、会话恢复：`js/features/persistence/*`
- 历史记录、设置、日志、帮助面板、更新、请求统计、提示词库、工作流面板等 UI 功能：`js/features/*`
- 左上角悬浮通知：`js/features/ui/floating-notices-controller.js`，调用方通常在 `index.js`、`js/features/update/update-manager.js`、`js/features/settings/settings-controller.js`、`js/canvas/batch-connection-mode.js`
- 后端路由：`backend/routes/*`
- 后端业务逻辑：`backend/services/*`
- 后端启动与运行配置：`backend/main.py`、`backend/config.py`、`server.py`
- 发布打包、本地构建与清理维护：`.github/workflows/release.yml`、`.github/workflows/cleanup-releases.yml`、`.github/workflows/cleanup-workflow-runs.yml`、`scripts/build-release-local.ps1`
- 样式入口与分层样式：`index.css`、`css/*`

## 开发规则

1. 优先扩展已有模块，不要继续增肥 `index.js`、`index.html` 或 `css/legacy.css`。
2. 功能专属逻辑放 `js/features/<feature>/`；共享能力放 `js/core/`、`js/services/`、`js/canvas/`。
3. 节点类型定义放 `js/nodes/types/*.js`；模板放 `js/nodes/node-view-factory.js`；DOM 交互放 `js/nodes/node-dom-bindings.js`；序列化放 `js/nodes/node-serializer.js`。
4. 后端保持“routes 收请求，services 放逻辑”的边界。
5. 新样式优先放到对应的 `css/features/`、`css/components/`、`css/layout/`；`css/legacy.css` 只承接遗留样式。
6. 新增可复用弹窗时优先看 `js/features/ui/dialog-style-1.js`；只属于设置面板上下文的帮助或浮层放 `js/features/settings/settings-controller.js` 与 `css/features/settings.css`，不要混进全局帮助面板。
7. 新增面板入口时同步检查 `index.html` 的 DOM、`js/features/ui/panel-manager.js` 的面板注册、`js/features/ui/ui-controller.js` 的按钮绑定，以及对应 CSS token。

## 当前项目里的关键约定

### 入口与模块边界

- 前端真实入口是 `index.js`；不要再新增无意义的二次转发入口。
- `index.js` 负责装配与依赖注入，不适合继续堆具体业务逻辑。
- `index.html` 只放结构、容器和必要的启动脚本，不把业务逻辑直接写回页面。
- 左侧工具栏的帮助入口和浮层帮助内容是两层东西：入口 DOM 在 `index.html`，操作帮助文案和打开关闭交互在 `js/features/help/help-panel.js`，样式在 `css/legacy.css`。改帮助面板时要同步校对当前左侧栏按钮、运行快捷键和画布交互，而不是只换标题。

### 主题与样式分层

- 主题状态已经从固定明暗切换升级为多主题结构：前端运行态字段使用 `themeId`，主题切换 UI 由 `js/features/ui/theme-controller.js` 管理，并通过 `data-app-theme` 驱动整站样式。
- 主题样式入口是 `css/themes.css`，它只负责聚合各主题文件；公共主题菜单/按钮样式放 `css/themes/shared.css`；每个主题独立放在 `css/themes/*.css`，当前已有 `dark.css`、`light.css`、`pro.css`、`pink.css`、`glass-light.css`、`glass-dark.css`。
- 主题注册表在 `js/features/ui/theme-controller.js` 的 `THEMES` / `THEME_IDS`；新增主题时必须同时改注册表、`css/themes.css` import、`index.html` 早期恢复脚本里的浅色主题列表（如果是浅色主题），以及主题按钮/菜单图标样式。
- 主题适配现在优先走“共享语义 token + 少量主题特化覆盖”模式：`css/legacy.css` 承接抽屉、帮助面板、工作流列表、缓存面板、左上角悬浮通知等共享 token；`css/features/panels.css` 承接提示词库、提示词导入、全屏历史、历史预览等功能面板 token；主题文件首先在 `:root[data-app-theme="..."]` 里赋值，再只保留必要的个性化细节覆盖。
- 新增主题时，优先先补 token，不要先写大段选择器覆盖。尤其先检查 `--panel-*`、`--workflow-card-*`、`--cache-*`、`--notice-*`、`--prompt-*`、`--history-*` 这几组变量是否齐全；大多数面板应该通过这些变量自动完成换肤。
- `glass-light` / `glass-dark` 主题包含更强的玻璃态节点和面板覆盖；改这两个主题时要额外检查 `.node-glass-bg`、工具栏 hover/固定态、面板毛玻璃透明度和性能，不要把玻璃态规则误扩散到非 glass 主题。
- 新增或修改任意主题时，默认都要补齐到设置面板、提示词库、历史全屏、缓存抽屉、主题菜单、相机编辑器、Toast、弹窗等细节面板，不要只改主画布和工具栏。
- 新增或修改任意主题时，设置面板配色也必须与主页主题保持一致：不仅要补齐控件可用性，还要统一设置弹窗表面层级、卡片 hover、tab、工具栏主按钮、供应商类型 badge、更新状态与版本摘要的主色体系。不要只修单个输入框或按钮，而要把整个设置面板当成独立子界面统一看。
- 新增主题或修改主题时，不要只改主页或工具栏。必须把主页、侧边栏、抽屉、弹窗、右键菜单、Toast、历史面板、设置面板、帮助面板、更新面板、节点内部控件、全屏预览等整条 UI 链路一起检查，避免出现“主页主题改了，但某些面板还是旧主题”的不完整状态。
- 主题切换入口当前是工具栏主题下拉菜单：结构在 `index.html`，交互和主题注册表在 `js/features/ui/theme-controller.js`，公共样式在 `css/themes/shared.css`。如果后续继续扩展主题菜单，不要把主题选择逻辑散回 `index.js` 或 `index.html` 内联脚本。
- `pink` 属于浅色主题链路：启动阶段在 `index.html` 的早期主题恢复脚本里，`color-scheme` 需要和 `light` 一样按浅色处理；如果后续新增新的浅色主题，同步检查这段启动脚本，不要只补 CSS。

### 执行与数据流

- 执行相关逻辑集中在 `js/features/execution/`，不要混入 UI 控制器。
- 执行链路的图片/文本输入归一化统一走 `js/features/execution/execution-data-utils.js`；图片输入用 `normalizeImageList` / `getPrimaryImageInput`，文本输入用 `getTextInputList` / `getPrimaryTextInput`，不要在 `execution-core.js` 和 `workflow-runner.js` 里各写一套。
- 模型兼容格式、用途、协议选项和 UI 展示文案统一看 `js/features/execution/model-protocol-registry.js`；供应商请求拼装和模型协议归一化看 `js/features/execution/provider-request-utils.js`。新增厂家或协议时不要把兼容格式硬编码回模型卡片。
- 图片/视频异步任务创建、轮询、恢复任务 ID、结果提取等通用流程集中在 `js/features/execution/async-media-execution.js`，`execution-core.js` 只保留节点 handler 接入和同步执行胶水。
- API 响应不是可解析 JSON、但响应体疑似包含图片数据时，前端只在 `execution-core.js` 触发 `/api/media/recover-image` 兜底；后端解析逻辑放 `backend/services/media_recovery_service.py`，路由只放 `backend/routes/media_routes.py`。兜底失败也要在前端日志说明“媒体恢复模块已尝试解析但未发现可用数据”，不要静默吞掉。
- 图片数组通常走 `data.images` / `imageDataList` / `generatedImages`；文本数组通常走 `data.texts`。
- 视频结果通常走 `data.video` / `data.videos` / `videoUrl`，保存节点和媒体预览逻辑需要同时兼容图片与视频输出。
- 普通节点接到数组输入时，默认按组合批量执行；展示类/收集类节点如 `ImagePreview`、`ImageSave`、`Text`、`ImageMerge`、`TextMerge` 通常一次性接收整组数据。
- 代理错误、SSRF/白名单拦截提示统一收口到 `js/services/api-client.js`，不要在各调用点散落不同文案。
- 请求统计只统计节点发起的 provider 请求，入口和侧边栏结构在 `index.html`，数据记录与渲染在 `js/features/statistics/request-statistics.js`，按钮/日期/保留天数事件由 `js/features/ui/ui-controller.js` 接入；不要用后端结构化日志反推前端请求统计。
- 并发请求模式的全局开关字段是 `concurrentRequestMode`，设置页、状态、导入导出、序列化、运行器和 `index.js` 注入链都要同步；批量并发提交前不要提前写共享节点输出。

### 节点与画布

- 节点尺寸测量、最小尺寸、恢复后的兜底修正集中在 `js/nodes/node-lifecycle.js`。
- 节点内部控件交互与动态端口重建集中在 `js/nodes/node-dom-bindings.js`。
- 连线逻辑在 `js/canvas/connections.js`，缩放/拖拽/改线交互在 `js/canvas/canvas-interactions.js`；仅改端口显示位置时不要误改连线取点逻辑。
- 画布平移/滚轮缩放属于高频交互：只更新 `nodes-layer` / `connections-group` / 网格的整体 transform；不要在每帧调用完整 `updateAllConnections()` 重算所有端口和 SVG path，节点移动/尺寸变化/连线结构变化时才做完整重算。
- 批量连线模式在 `js/canvas/batch-connection-mode.js`，入口来自右键菜单 `context-menu-batch-connection-mode`；它会用左上角悬浮通知提示当前状态，并按可见端口、类型匹配和输入口空闲状态自动连接。改批量连线时同步检查 `context-menu-controller.js`、`state.batchConnectionMode`、节点 running 禁止规则、端口样式刷新和历史记录。
- 参考图数量、克隆节点数量、节点重命名和请求体预览这些右键菜单小弹窗当前集中在 `js/features/ui/context-menu-controller.js`，复用 `.reference-image-count-dialog` 一套结构样式；新增右键小弹窗前先评估能否复用 `dialog-style-1.js` 或现有右键弹窗样式。
- `TextInput`、`TextDisplay` 只在旧工作流载入阶段做兼容迁移，运行态正式文本节点只看 `Text` 和 `TextSplit`。

### 设置、更新与启动

- 设置页 UI 与数据逻辑集中在 `js/features/settings/settings-controller.js` 与 `js/features/settings/settings-modal.js`。
- 左上角“请注意网络设置”提醒由前端 `settings-controller.js` 编排目标列表和“三个都通才提醒”的判断；实际单个 URL 探测通过后端 `backend/routes/settings_routes.py` 的 `/api/probe_network_target` 调用 `backend/services/security_service.py::probe_network_target` 代发请求。不要恢复旧的后端整体 `/api/detect_network_path` 判断链路。
- 在线更新能力集中在 `js/features/update/update-manager.js`、`backend/routes/update_routes.py`、`backend/services/update_service.py`。
- 版本号单一来源是 `js/core/constants.js` 的 `APP_VERSION_NUMBER`。
- 自动更新检查总开关是 `AUTO_UPDATE_CHECK_DISABLED`；开启禁用后，`index.js` 不排队自动检查，`settings-controller.js` 不渲染更新卡片。手动检查与下载逻辑是否保留，要按当前常量链一起确认。
- API 供应商锁定开关是 `API_PROVIDERS_LOCKED`；它不仅影响新增/删除按钮，也影响配置导入、会话恢复、供应商 endpoint 只读态和默认模型绑定。现在还要额外区分“首次打开项目”和“恢复已有本地状态”：锁定开启且本地还没有 `nodeflow_ai_state` 时，启动阶段不会默认注入 6789 / GXP 供应商，这条判断收口在 `js/app/create-app-context.js` 与 `js/core/state.js`，不要误改到 `project-io.js` 的恢复链路里。
- 前端 ES module import 不要手写 `?v=...` 查询串；静态资源缓存版本由 `APP_ASSET_VERSION` 派生，临时查询串很容易绕过单一版本源。
- 源码启动链路主要看 `start_cainflow.bat`、`server.py`、`backend/main.py`。
- 后端启动后如果终端持续刷一串静态资源或 200/304 访问记录，优先看 `backend/handler.py` 的 `ProxyHTTPRequestHandler.log_message()`；这通常是 `http.server.SimpleHTTPRequestHandler` 的默认控制台访问日志，不是 `backend/main.py` 的启动 banner。
- 后端请求排查优先看 `backend/services/log_service.py` 生成的 `log/backend-YYYY-MM-DD.jsonl` 结构化日志，不要把控制台访问日志当成唯一排查入口。
- 发布包构建链路同时看 `.github/workflows/release.yml` 与 `scripts/build-release-local.ps1`；PyInstaller 入口是 `server.py`，`backend` 作为 Python 模块被自动收集，不要再用 `--add-data "backend;backend"` 重复打包。当前仓库 Actions 策略限制外部 action，workflow 默认不能使用 `actions/checkout`、`actions/setup-python`、`actions/upload-artifact` 或第三方 `uses:`。

## 高风险改动前先停一下

遇到这些点时，先确认整条链路再改：

- 修改 `index.html` 的关键 DOM id/class，或 `index.js` 的模块注入关系
- 修改主题切换入口、`themeId` 持久化字段、`data-app-theme` DOM 属性、主题菜单结构或 `css/themes/*` 文件组织
- 修改 `glass-light` / `glass-dark` 玻璃态主题、`.node-glass-bg`、主题早期恢复脚本或 `color-scheme` 判定
- 修改工作流序列化结构、默认工作流模板、导入导出契约
- 修改工作流列表分组/排序时，要保持 `workflows/` 下真实子目录结构；文件夹不是前端假分组，后端路径安全、列表递归、重命名移动和前端拖拽都要同步检查。
- 修改节点端口布局、动态端口、节点最小尺寸、缩放测量链
- 修改批量连线模式、输入端口改线、拖线到空白处创建候选节点、剪刀切线或连线采样参数
- 修改 `ImageGenerate`、`TextChat`、`Text`、`TextSplit` 的运行态数据结构或批处理语义
- 修改请求统计、并发请求模式或 provider 请求记录注入点
- 修改 `/proxy`、代理设置、允许域名、安全校验链路
- 修改左上角网络设置提醒、`/api/probe_network_target`、本地代理自动检测或透明代理判断链路
- 修改更新下载、启动冲突检测、端口占用提示链路
- 修改 GitHub Actions 发布包、Release/Workflow 清理脚本、本地打包脚本、PyInstaller 参数或 Release ZIP 内容

## 修改前后的建议动作

- 修改前先用关键词检索责任文件，只读“责任文件 + 直接调用方”。
- 如果改的是主题，修改前先定位主题入口、主题注册表、当前主题文件和浅色/深色/其他主题覆盖范围；修改后至少手动检查主页、菜单、抽屉、弹窗、设置页、历史页、帮助页、右键菜单和节点内部控件，不要只看首页。
- 如果改的是左侧帮助面板，优先看 `index.html`、`js/features/help/help-panel.js` 和 `css/legacy.css`；帮助面板内容要跟当前工具栏、画布快捷键和节点交互保持一致，避免只改文案没改行为说明。
- 如果改的是主题相关结构，而不是单个颜色，额外检查 `index.html` 里是否还有会泄漏主题的内联样式；像缓存抽屉这类面板应优先改成 class + 共享 token，不要再依赖 `style*=` 选择器补漏。
- 修改后至少做受影响文件的语法检查。
- 如果启动过本地服务做验证，结束前确认不要留下本轮调试进程和临时文件。

## 参考文件

需要更完整的职责表、目录地图和常见需求落点时，打开：

- `references/architecture-map.md`

## 最近经验补充

- 优化“后端启动后全是无用日志”时，先分清两类输出：`backend/main.py` 负责启动成功/失败、端口冲突等少量关键信息；真正容易刷屏的是 `backend/handler.py` 继承自 `SimpleHTTPRequestHandler` 的默认访问日志。这个项目已经有 `backend/services/log_service.py` 负责写结构化请求日志，通常应优先收敛控制台访问日志，而不是去删启动 banner。
- 修改 `js/features/execution/execution-core.js` 时，要特别小心节点 handler 对象里的 `},` 分隔符；少一个或多一个都可能让整个前端模块加载失败，表现为“右键菜单失效、画布不显示任何节点、应用看起来像没初始化”。
- 只要改了 `execution-core.js`、`index.js` 这类启动链关键文件，提交前至少做一次语法检查；当前项目可直接运行 `node --check js/features/execution/execution-core.js` 和 `node --check index.js`。
- 如果图片类节点已经有 `js/features/media/media-controller.js` 的统一同步函数，优先复用它，不要在 `execution-core.js` 再手写第二套 DOM 更新逻辑，否则很容易出现状态双写、局部修好但启动链或预览链被带坏。
- 工作流停止日志必须区分停止原因：只有 `abortReason === 'manual'` 时才显示“用户手动停止/工作流停止”；超时走超时提示，自然完成或错误收尾不要默认写“用户终止了工作流”。相关判断优先看 `js/features/execution/workflow-runner.js` 和 `js/services/api-client.js::getAbortMessage()`。
- 后端媒体恢复只是异常响应兜底，不是常规解析链路。新增识别规则时先扩展 `backend/services/media_recovery_service.py`，前端只负责触发、展示恢复成功/失败日志，并继续沿用原错误流程。
- 历史记录和高级图片对比要默认走元数据/缩略图优先：列表或选择器不要调用 `getHistory()` 一次性 hydrate 全部原图，只有预览、下载、拖拽导入、设置 A/B 这类真正需要原图的动作才调用 `getHistoryEntry(id)`。
- 长时间使用会增长的前端缓存必须有上限或清理点；例如图片分辨率缓存不能用无限 Map 保存每个 data URL。
- 处理节点输入输出兼容时，优先统一走 helper：图片输入用 `normalizeImageList` / `getPrimaryImageInput`，文本输入用 `getTextInputList` / `getPrimaryTextInput`；不要在各节点里继续直接假设 `inputs.image` 一定是单字符串，或 `inputs.text` 一定不是数组。
- `normalizeImageList`、`normalizeTextList`、`getPrimaryImageInput`、`getLastImageInput`、`getPrimaryTextInput`、`getTextInputList` 当前在 `js/features/execution/execution-data-utils.js`，`execution-core.js` 与 `workflow-runner.js` 都应从这里导入，避免同一套“单值/数组”约定分叉。
- `getCachedOutputValue()`、`workflow-runner` 聚合输出、`media-controller` 下游级联同步，这三层必须保持同一套“单值/数组”约定；如果只修其中一层，最容易出现运行看似成功、但下游节点偶发空白的隐形兼容问题。
- 异步图片和视频任务不要继续增肥 `execution-core.js`；新增 NEW API 异步、VEO、豆包、Sora、Seedance 等任务恢复/轮询逻辑时，优先扩展 `async-media-execution.js` 和 `model-protocol-registry.js` / `provider-request-utils.js` 的协议映射。
- VEO/豆包等视频节点的首帧、尾帧、参考图端口和请求体字段必须按兼容格式走协议映射，不要在节点 UI、执行核心、模型卡片里各写一份字段名。
- 优化节点连线时，优先改 `js/canvas/geometry.js` 的路径生成和 `js/canvas/connections.js` 的轻量 lane 分流，不要通过给输入端硬塞上拐折线来避让节点；这类局部硬拐通常很丑，也会让剪刀切线、插入预览和实际显示路径不一致。
- 连线算法需要保持“绘制路径、采样路径、插入预览、剪刀切线”同一套参数；如果给真实连线加了 `outputTransition`、`inputTransition` 或 `laneOffset`，同步检查 `getConnectionSamplePoints()` 的调用方，避免看起来的线和可交互的线错位。
- 在 Windows PowerShell 5.1 里，不要直接相信默认 `Get-Content` 看到的中文；当前环境默认编码可能是 `gb2312`，而仓库里的节点相关文件很多是 UTF-8（尤其是无 BOM 文件），会把正常中文误读成 `鍥剧墖`、`鑺傜偣...` 这类假乱码。
- 需要判断“文件内容真的坏了”还是“PowerShell 显示误判”时，优先用 `Get-Content -Encoding UTF8`，或直接用 Node `fs.readFileSync(path, 'utf8')` 复核；不要只因为 PowerShell 默认输出看起来像乱码，就立刻批量修文案。
- 遇到中文乱码排查时，先区分三种情况：1）文件本身是正常 UTF-8，只是 PowerShell 误读；2）文件内容里真的已经写进了乱码串；3）终端显示编码和文件读取编码同时混乱。只有在 UTF-8 复核后仍然显示 `寰幆杩炴帴`、`璇峰厛閫夋嫨...` 这类串时，才应当修改源码。
- GitHub Actions 维护脚本当前走纯 `run` + `gh` CLI，不使用外部 `uses:`。发布脚本支持手动运行和 `v*` tag 自动发布；Release 清理脚本删除旧 Release 并同步删 tag；Workflow Runs 清理脚本删除旧 Actions 运行记录，默认 dry-run。
- 发布包是白名单结构：外层 ZIP 只放 `CainFlow.exe`、`LICENSE` / `NOTICE` 和 `workflows/`；`API_DOC`、`.agent`、`.github`、`scripts`、临时 Apifox 文件、构建目录和源码文档不应进入发布包。`notification-sw.js`、`css`、`js`、`sounds` 等运行时静态资源随 PyInstaller 内置进 exe。
