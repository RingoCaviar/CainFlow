# CainFlow 架构速查表

当你需要判断代码该放哪里，或者应该先看哪些文件时，使用这份速查表。

> 当前版本：v2.8.2.x

## 近期约定

### 多主题系统约定

- 主题系统已从固定 `dark/light` 切换升级为多主题架构。运行态状态字段使用 `themeId`，启动时 `index.html` 会优先从本地状态恢复 `themeId`，并兼容旧 `themeMode`；主题应用和主题菜单交互统一收口在 `js/features/ui/theme-controller.js`。
- 主题样式文件采用“入口 + 共享层 + 单主题文件”结构：`css/themes.css` 只负责聚合，`css/themes/shared.css` 放主题菜单和公共主题壳子，单个主题分别放在 `css/themes/dark.css`、`css/themes/light.css`、`css/themes/pro.css`。后续新增主题时，优先新增 `css/themes/<theme>.css` 并在 `css/themes.css` 中接入，不要把新主题规则重新堆回 `css/legacy.css` 或一个巨大的总主题文件。
- 工具栏主题入口已改为下拉菜单而不是循环切换按钮：结构在 `index.html`，样式在 `css/themes/shared.css`，主题注册表、菜单渲染、打开/关闭、主题切换和持久化触发都在 `js/features/ui/theme-controller.js`。
- 新增主题或修改主题时，一定要做全链路检查，不允许只改主页或工具栏颜色。至少同时覆盖和验证：主页、工具栏、侧边栏、抽屉、弹窗、右键菜单、Toast、设置页、历史记录面板、帮助面板、更新面板、节点内部控件、全屏预览、主题菜单本身。凡是已有 `html[data-app-theme="..."]` 覆盖的区域，都要一起考虑，避免出现“主页主题改了，但某些面板没改”的遗漏。
- 主题验收时，主界面之外的细节面板也应默认纳入最小检查集，包括设置页、提示词库、历史全屏、缓存抽屉、主题菜单、相机编辑器、Toast、弹窗和相关按钮态。
- 设置面板主题适配不是单纯“控件变暗”即可：设置弹窗表面、设置卡片、tab、toolbar 强调按钮、供应商类型 badge、更新状态、版本摘要等都需要和主页保持同一套主色体系与高亮节奏。如果主题看起来“能用但不像同一套皮肤”，优先检查对应 `css/themes/<theme>.css` 里的设置面板专属覆盖是否仍缺少这一层整体对齐。

### 右键菜单分类子菜单约定

- 画布右键添加节点菜单采用“一级分类 + 二级节点列表”，不要把所有节点直接堆在根菜单，也不要退化成根菜单只有一个“添加节点”入口。分类入口结构放 `index.html`，通过 `data-submenu-target` 指向对应二级菜单；二级菜单加 `data-context-submenu`，具体节点项继续用 `data-type` 交给 `js/features/ui/context-menu-controller.js` 创建节点。
- `js/features/ui/context-menu-controller.js` 负责分类子菜单的打开/关闭、同级互斥、悬停延迟关闭、点击分发和视口边缘避让。新增分类时应复用通用 `data-submenu-target` / `data-context-submenu` 机制，不要为单个分类再写一套硬编码控制逻辑。
- 右键菜单视觉仍沿用现有 `.context-menu` / `.context-menu-item` 风格；子菜单箭头、打开态和层级样式放 `css/legacy.css`，浅色主题打开态覆盖放 `css/themes.css`。

### 多值数据与备用输入口约定

- 图片数组的规范载体是 `data.images`、`imageDataList`、`generatedImages`，文本数组的规范载体是 `data.texts`，动态文本端口也可以在 `data.part_N` 等端口字段上保存数组。`js/features/execution/execution-core.js` 负责节点 handler、数组输出写入与 `getCachedOutputValue` 的多值读取，`js/features/execution/workflow-runner.js` 负责把数组输入识别为批处理信号。
- 普通节点接到数组输入时，下游应按所有数组输入的笛卡尔组合批量执行，而不是按索引拉链式配对；例如 2 张图片 × 3 段文本必须运行 6 次。批量执行后的图片结果聚合回 `data.images`，文本结果按真实输出端口分别聚合，主文本口同步到 `data.texts`。`TextChat` 接收多图数组或多文本数组时也属于普通批处理节点，应按组合逐次运行，而不是只运行一次或漏掉组合。
- `TextChat` 勾选“固定结果”且已有缓存结果时，不再属于普通批处理节点：执行计划遇到它应停止向上追溯输入依赖，批量调度不得因上游数组展开它，缓存输出只返回 `node.data.text` 单条结果，不继续透出旧 `data.texts`。固定缓存命中时不检查模型/供应商/API Key，不发起请求。
- `ImageMerge`、`TextMerge`、`ImagePreview`、`ImageSave`、`Text` 是收集/展示/保存/数组预览类节点，接到数组时一次性接收整组数据，不按数组拆批。`ImagePreview` / `ImageSave` 通过左右箭头和计数器切换多图；`Text` 节点接收 `data.texts` 后通过左右箭头切换多文本，并用 `textPreviewIndex` 记录当前项。
- 备用输入口（Spare Input Port）指动态输入端口始终保持“已连接端口最大序号 + 1”，保证末尾总有 1 个空输入口可继续连接。`ImageMerge` / `TextMerge` 使用该端口规则：端口同步和失效连线清理在 `js/nodes/node-dom-bindings.js`，初始端口恢复在 `js/nodes/node-view-factory.js`，`inputCount` 保存/复制在 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`。

### 并发请求模式约定

- 并发请求模式是通用设置里的全局开关，状态字段为 `concurrentRequestMode`，默认开启。修改该能力时同步 `js/core/state.js`、`js/features/settings/settings-controller.js`、`js/features/ui/ui-controller.js`、`js/features/persistence/project-io.js`、`js/nodes/node-serializer.js` 与 `index.js` 注入链，避免刷新、导入导出或会话恢复后设置丢失。
- 开关打开后，`workflow-runner.js` 负责识别 `ImageGenerate` / `TextChat` 因数组输入即将运行多次的场景，用 `executeConcurrentBatchRequest` 并发发起各组请求；失败项按自动重试次数独立重试，只有所有 batch 成功后才用 `commitConcurrentBatchResults` 一次性提交到节点输出并运行下游。
- `ImageGenerate` 的单节点 `generationCount > 1` 也在 `execution-core.js` 内部并发执行。内部并发只用局部数组收集结果；普通运行失败时先提交已成功图片和 `generationCompletedCount`，自动重试只补剩余；批量并发运行时不得提前写共享 `node.data.image` / `node.data.images`，避免多个 batch 互相覆盖。

### 错误提示中文化

- 用户可见的代理/安全拦截提示优先统一走 `js/services/api-client.js`，不要在各个调用点手写不同版本的错误文案。
- `Target URL is not allowed` 这类后端安全拦截，需要翻译成中文，并明确提示用户去“设置 > 通用设置 > 安全”关闭过滤或调整允许列表。
- 更新检查 `js/features/update/update-manager.js` 等复用 `/proxy` 的功能，也应调用同一套错误格式化逻辑，避免一处中文、一处英文、一处只有状态码。

### 在线更新约定

- 直接下载更新入口统一在 `js/features/update/update-manager.js`，设置页只通过 `js/features/settings/settings-controller.js` 调用该能力；下载前要提示 GitHub 网络环境可能导致速度不稳定，下载中要显示进度、百分比和速度，并支持用户取消。
- 下载进度必须在右下角 `#toast-container` 常驻显示，通知卡片由 `update-manager.js` 创建和更新，样式在 `css/legacy.css` / `css/themes.css`；更新完成、取消或失败前不要让进度卡片自动消失。
- 后端下载能力分为 `backend/routes/update_routes.py` 与 `backend/services/update_service.py`：只从最新 GitHub Release ZIP 中提取 `CainFlow.exe`，覆盖 `backend/config.py` 的 `MAIN_EXE_PATH`，不要整包解压，避免误覆盖工作流、配置或其他文件；进度总量优先使用 GitHub Release asset 的 `size`，完成态必须回传顶层 `downloadedBytes` / `totalBytes` / `percent=100`。
- 下载取消、窗口关闭取消、失败和完成后都要清理 `.download`、提取中间文件与 Release ZIP；如果 Windows 锁住正在运行的主程序，应留下待替换文件和重试替换脚本，并提示用户重启 CainFlow 主程序。
- 前端收到完成态后要先把右下角进度条渲染到 100%，再延迟弹出重启提示；不要让 `alert()` 或同步弹窗阻塞 100% 进度帧的绘制。

### 发布打包约定

- GitHub Release 构建入口是 `.github/workflows/release.yml`，本地等价构建入口是 `scripts/build-release-local.ps1`；修改 PyInstaller 参数、随包资源或 ZIP 结构时要同步检查这两处，避免本地包和 Actions 包不一致。
- PyInstaller 的程序入口保持为 `server.py`，它会导入 `backend.main` 并让 PyInstaller 自动收集 `backend` Python 模块；不要再额外使用 `--add-data "backend;backend"`，否则会把后端源码和 `__pycache__` 作为静态资源重复塞进 exe。
- Release ZIP 只应外置运行时会被用户改写或在线更新需要保留的内容，例如 `CainFlow.exe`、`allowed_hosts.json`、`workflows/`；前端静态资源、图标、声音和后端模块随 exe 内置，避免整包更新时误覆盖运行时配置。
- Windows Actions 中涉及 PowerShell 续行、文件清理和压缩的步骤要显式使用 `shell: pwsh`；构建前清理 `build`、`dist`、`release_staging` 和生成的 `.spec`，并保留 PyInstaller 版本输出，方便排查卡在打包阶段的问题。

### 代理设置与版本号约定

- 代理设置的“自动检测代理端口”属于设置面板数据逻辑：按钮、自动填充和自动保存放 `js/features/settings/settings-controller.js`，检测接口在 `backend/routes/settings_routes.py`，常见本地代理端口探测和连通性校验放 `backend/services/security_service.py`。检测成功后再自动勾选代理并填入端口；不要把批量端口探测散到前端。
- 代理配置是前端本地状态与后端全局代理状态的双端同步能力。设置页保存代理时立即同步到 `/api/proxy`；应用启动时 `js/features/app/startup-controller.js` 在 `loadState()` 结束后无论是否恢复出节点，都要调用 `syncProxyToServer()`，避免空画布启动后更新下载继续使用后端默认代理。
- `/proxy` 的错误归类属于 `backend/services/proxy_service.py` 的职责边界：真正的浏览器断连（如 `BrokenPipeError`、`ConnectionResetError`）才记为 `client_disconnect`；`http.client.RemoteDisconnected` 代表上游在返回响应前关闭连接，应继续走上游断连分支并把错误回给前端，避免执行节点只得到 `Failed to fetch` 这种不可排查的表象。
- 应用版本号的单一来源是 `js/core/constants.js` 的 `APP_VERSION_NUMBER`。前端展示、`APP_VERSION`、`APP_ASSET_VERSION` 和静态资源缓存参数由它派生；后端启动提示和 User-Agent 通过 `backend/services/version_service.py` 运行时读取同一值。不要再恢复 `package.json` 或 `css/base/variables.css` 这类第二份版本号。

### 设置页视觉规范

- 通用设置布局、卡片留白、字号、开关样式统一收口在 `js/features/settings/settings-controller.js` 与 `css/features/settings.css`。
- 优先复用 `general-settings-grid` / `general-settings-card` 和 `toggle-switch` / `toggle-slider`，不要把设置页继续做成内联样式拼装区。
- 新增按钮、图标按钮或按钮组时，要把按钮周围留白也当成正式需求：避免贴着文字、标签、端口、输入框或其他控件；如果按钮位置异常，先检查是否被全局定位或通用样式误伤。
- API 供应商标题旁的新手帮助入口属于设置面板上下文帮助：入口结构在 `index.html`，帮助弹窗 DOM 创建、文案渲染与关闭事件在 `js/features/settings/settings-controller.js`，视觉样式在 `css/features/settings.css`。它不是全局“操作帮助”面板，不要改到 `js/features/help/help-panel.js` 或 `css/legacy.css`。
- 安全相关开关应放在独立安全卡片中展示，新增高风险选项时同步检查状态默认值与持久化链路。
- 如果要锁定 API 供应商，开关常量放 `js/core/constants.js`，设置页的新增/删除入口隐藏与 `endpoint` 只读态放 `js/features/settings/settings-controller.js`；不要只做按钮隐藏而漏掉导入配置、会话恢复等旁路。

### 固定结构节点缩放约定

- `CameraControl` 这类“预览区 + 多组控件 + 文本框”的固定结构节点，最小尺寸和内容显示兜底统一放在 `js/nodes/node-lifecycle.js`，不要在节点私有逻辑里各写一套裁剪补丁。
- 用户拖拽缩小节点时，如果宽度变化会进一步抬高所需最小高度，就不能只沿用缩放开始时的最小值；应在 `js/canvas/canvas-interactions.js` 中按当前宽度动态重算共享最小尺寸，避免文本框和上方滑块、标签等发生重叠。
- 节点内部的纵向间距要保持统一节奏：标签到控件、控件到控件、最后一组控件到结果区之间都按同一套 spacing 走，不要只对某个字段单独加一截特殊 margin。
- 对浏览器原生滑块、文本框、预览区这类容易出现“视觉高度大于测量高度”的元素，要优先使用稳定块尺寸和明确的 `minHeight`；必要时直接提高节点定义里的 `defaultHeight` / `minHeight`，不要允许缩到必然冲突的尺寸。
- TextChat 回复区、TextSplit 预览区、文本显示框这类可滚动长内容区，只应按容器可用高度参与最小尺寸测量；`js/nodes/node-lifecycle.js` 中包含 `.chat-response-area`、`.text-display-box`、`.text-split-preview` 的容器不要再用完整内容 `scrollHeight` 兜底，否则拖拽 resize 会强制显示全文。
- 节点类型里的 `defaultHeight` 表示创建/恢复时的默认尺寸，不应天然等同于用户手动缩小时的硬下限；如果需要默认较高但允许缩小，应在 `js/nodes/types/*.js` 中单独配置 `minHeight`，由 `js/nodes/node-lifecycle.js` 的共享测量链读取。
- 新增 3D 预览、媒体舞台、结果画布等 media-like 区域时，要确认它们纳入共享节点测量链，而不是只靠局部 CSS 高度撑住。
- `CameraControl` 的编辑器只是一层临时壳：点击“编辑视角”时才显示 3D 界面，关闭后要把缩略图和相机参数留在 `node.data` 里；运行态重置不应把 `pitch` / `yaw` / `distance` / `fov` / `roll`、摄影提示词或预览图清空。
- `ImageSave` 如果接到 `ImageGenerate` 的多图结果，节点内预览不再只看最后一张：多图批量保存与预览切换都视为固定结构节点的一部分，增减按钮、计数器或预览层时要同步复查默认高度、最小尺寸测量和节点内滚动条是否重新出现。
- `CameraControl` 编辑器里的滑块、数值输入框、单位标记、重置视角按钮和浅色主题覆盖也属于固定结构 UI；调整其中任一项时，要连同顶部操作区、舞台、提示词框和共享测量链一起检查，避免缩小节点或切换主题后重新出现重叠、颜色失衡或点击热区异常。
- `CameraControl` 编辑器的第一人称/第三人称视图切换属于 3D 预览逻辑，不属于节点模板层。第一人称渲染受控相机；第三人称用独立观察相机渲染，并显示世界中的受控摄像机模型和视锥。第三人称下鼠标左键、滚轮和右键重置只调整观察相机，右侧参数才控制受控摄像机。

### 输入端口改线约定

- 从未连接输入端口拖拽时，仍按普通端口拖线处理；从已连接输入端口拖拽时，应先摘除该输入口的旧 incoming connection，并以旧连接的输出端作为临时连线起点继续拖拽，用于把 A -> B.input 改接到其他输入口。
- 这条交互的责任链是：`js/nodes/node-dom-bindings.js` 在端口 `mousedown` 识别已连接输入口、执行断开、设置 `state.connecting.rewiredFromConnection` / `historyPushed`；`js/canvas/canvas-interactions.js` 负责移动和松手判定，尤其是改线拖到空白处只保留断开结果，不弹“创建并自动连接节点”候选；`js/canvas/connections.js` 负责最终提交新连接、替换目标输入口和避免同一次改线产生两段撤销历史。
- 不要把已连接输入口拖拽伪装成普通输出端拖线来复用创建候选逻辑；普通输出端拖到空白处可以弹创建节点候选，但改线拖拽到空白处的语义是取消该连接线。

### 工作流重命名约定

- 工作流重命名的交互入口统一收口在 `js/features/workflow/workflow-manager.js`：列表按钮和右键菜单共用同一套重命名逻辑，不要各写一份。
- 前端重命名前先做名称校验：空名、同名、非法文件名字符、目标名已存在都应直接提示，避免把无效请求交给后端再兜底。
- `js/services/workflow-api.js` 负责重命名请求封装；名称通过请求头传递时要做编码，避免中文或特殊字符在链路中出问题。
- 后端冲突处理放在 `backend/routes/workflow_routes.py` 与 `backend/services/workflow_service.py`：目标工作流已存在时应明确返回冲突，而不是静默覆盖。

### 启动冲突提示约定

- 源码双击启动的第一层逻辑在 `start_cainflow.bat`，后端统一启动逻辑在 `backend/main.py`，`server.py` 只保留兼容转发；修改本地启动、端口检测、黑色窗口停留或打包直启体验时要同时检查这三处。
- 端口 `8767` 冲突时不要自动关闭占用进程，也不要让窗口一闪而过。提示需要停留在黑色窗口中，并明确区分“CainFlow 已在运行”和“端口被其他程序占用”，同时显示 PID、进程名和可用的命令行，交给用户自己关闭窗口或处理进程。
- `.bat` 调后端时可用环境变量避免重复等待；后端打包直启时仍应自行等待用户确认。自动化测试可设置跳过等待的环境变量，并在验证后确认 `127.0.0.1:8767` 没有残留监听、清理 `__pycache__` 等临时文件。

## 前端结构

### 启动 & 核心

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 启动入口 | `index.js` | 前端真实入口与总装配层，负责模块初始化与依赖注入 |
| 页面骨架 | `index.html` | 页面结构、面板容器、弹窗结构、脚本与样式入口 |
| 应用启动控制 | `js/features/app/startup-controller.js` | 应用初始化流程、模块装载编排；`loadState()` 后始终同步代理到后端 |
| 共享常量 | `js/core/constants.js` | `APP_VERSION_NUMBER`、`APP_VERSION`、`APP_ASSET_VERSION`、GITHUB_REPO、STORAGE_KEY、DB_VERSION、默认供应商/默认模型，以及 `API_PROVIDERS_LOCKED` 这类前端共享策略常量 |
| DOM 引用 | `js/core/elements.js` | 跨模块共用的顶层 DOM 元素查找 |
| 全局状态 | `js/core/state.js` | 前端运行时共享状态与初始值 |
| 通用工具 | `js/core/common-utils.js` | 多模块共用的纯函数工具集 |

### Services（服务层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 代理请求 | `js/services/api-client.js` | 上游 API 代理请求封装、User-Agent 注入、`x-allow-private-network-targets` 安全开关透传、代理错误统一中文格式化 |
| 本地存储 | `js/services/storage-idb.js` | IndexedDB 历史记录与图片资产持久化；历史列表优先读元数据，原图按 id 按需读取；历史原图资产使用 `history:` 前缀存入 `STORE_ASSETS` |
| 工作流文件 API | `js/services/workflow-api.js` | 工作流文件列表、加载、保存、重命名等后端接口调用；重命名目标名通过请求头编码传递 |

### Canvas（画布层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 画布交互总线 | `js/canvas/canvas-interactions.js` | 鼠标事件总线、拖拽与交互调度；拖拽时节点晃动摘取连线的识别入口；已连接输入端口改线拖拽松到空白处只断开、不弹创建候选的判定；滚轮缩放结束后的 settle delay 也在这里 |
| 连线绘制 | `js/canvas/connections.js` | 节点连线绘制、连线可见性裁剪、选中态流动箭头动画、孤立节点拖入兼容连线的插入预览与提交，以及从端口拖到空白处松手后的“创建并自动连接节点”候选匹配；流动箭头受全局动画开关控制。像 `ImageGenerate` 这类多同型输入口节点，候选创建时不要机械使用第一个兼容端口：`CameraControl` 文本输出默认接 `camera_prompt`，其他文本输出默认接 `prompt` |
| 节点自动整理 | `js/canvas/node-auto-layout.js` | 自动整理选中节点或全画布节点；只改变节点坐标，负责连通组件拆分、拓扑分层、按上下游端口顺序排序、按依赖中心线松弛、无连线节点网格排列，并保留运行中节点跳过、历史、连线刷新和保存链路 |
| 几何计算 | `js/canvas/geometry.js` | 贝塞尔曲线、直角圆角连线、剪线采样、坐标相关几何工具 |
| 框选 | `js/canvas/selection.js` | 矩形框选逻辑与选中状态 |
| 视口 | `js/canvas/viewport.js` | 缩放、平移、视口坐标变换；节点文字清晰化重绘入口 `refreshNodeTextRendering()` 在这里 |

### Features（功能面板层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| **执行引擎** | | |
| 执行核心 | `js/features/execution/execution-core.js` | 单节点执行处理、API 请求发起、图片类节点输出分发、ImageGenerate 多次生成成功计数与并发生成请求；TextChat 固定结果缓存命中时直接返回缓存，`getCachedOutputValue` 必须把禁用节点视为没有输出，并在固定 TextChat 下只返回单条缓存文本；Text 节点运行时同步单文本/多文本输入输出，不自动改变节点尺寸；处理 ImageMerge/TextMerge 数组输出并读取图片/文本数组缓存 |
| 提供商请求工具 | `js/features/execution/provider-request-utils.js` | 针对不同 API 提供商的请求拼装、协议判断、模型用途/协议归一化、OpenAI/Gemini 图片分辨率预设、OpenAI 图片接口路径选择 |
| 工作流运行器 | `js/features/execution/workflow-runner.js` | 整体工作流执行流程编排、自动重试、节点运行态重置；维护 `state.runningNodeIds`、并发运行会话和停止全部当前运行的 abort controller 集合；维护 `state.runningNodeCancelHandlers` 与单节点 abort controller，用于只取消某个运行中节点并跳过其本次计划内下游，不影响其他并发运行节点；收集下游输入和提示词预检查时必须过滤禁用上游输出，固定且有缓存的 TextChat 不向上追溯依赖、不按数组拆批；普通节点接到数组输入时按笛卡尔组合批量运行并聚合输出，动态文本输出按真实端口聚合，ImageMerge/TextMerge/ImagePreview/ImageSave/Text 不拆批；并发请求模式下并发执行 ImageGenerate/TextChat 的 batch 并在全部成功后统一提交 |
| **帮助** | | |
| 帮助面板 | `js/features/help/help-panel.js` | 操作帮助文档内容、帮助面板打开关闭与交互；新增画布/节点交互时同步补充对应说明 |
| **历史记录** | | |
| 历史面板 | `js/features/history/history-panel.js` | 侧边历史列表 UI 与列表交互；只读最近有限条元数据并空闲补缩略图；拖拽时按需读取原图或传递 `imagePromise`，不要从卡片 `<img>` 取缩略图 |
| 历史预览 | `js/features/history/history-preview.js` | 历史记录条目预览渲染；先显示缩略图/加载态，再异步加载原图、计算分辨率、处理下载和删除 |
| 全屏历史 | `js/features/history/history-fullscreen.js` | 面向超大量历史记录的全屏纵向浏览、按天分组、右侧日期标尺定位、批量操作和虚拟滚动窗口化渲染 |
| 历史工具 | `js/features/history/history-utils.js` | 历史卡片渲染、按天分组、时间标签、缺失缩略图占位与通用转义工具 |
| **提示词库** | | |
| 提示词库管理 | `js/features/prompts/prompt-library.js` | 提示词预设的全屏管理界面行为、本地 `localStorage` 持久化、多选删除、导入/导出、导入前格式校验、导入项选择，以及导入画布时创建不重叠的 Text 节点 |
| **日志** | | |
| 日志面板 | `js/features/logs/log-panel.js` | 日志面板 UI、日志渲染、错误详情入口 |
| **媒体** | | |
| 图片绘制 | `js/features/media/image-painter.js` | Canvas 图片绘制与合成 |
| 媒体控制 | `js/features/media/media-controller.js` | 媒体资源生命周期管理、图片预览/保存/缩放/对比节点的运行态同步与交互；`ImageSave` 多图预览切换、当前预览图全屏、手动/自动批量保存与编号文件名；图片对比高级模式的全屏界面、A/B 选图、历史图片汇总、缩略图选择区展开、鼠标切割、滚轮缩放与左键平移；提供文件导入与 data URL 直接写入入口；图片预览源和下游级联刷新必须跳过禁用节点并向下游传递空输入 |
| 媒体工具 | `js/features/media/media-utils.js` | 图片格式转换、Blob 处理等工具函数 |
| **相机** | | |
| 视角控制 | `js/features/camera/camera-control-node.js` | `CameraControl` 节点的编辑器壳、3D 预览初始化、世界中心坐标轴、第一人称/第三人称预览切换、受控相机与观察相机交互、重置为正视视角、滑块与手动数值输入的统一状态链，以及相机参数到英文摄影提示词的映射 |
| **持久化** | | |
| 项目导入导出 | `js/features/persistence/project-io.js` | 工作流 JSON 文件导入导出；导出不写入 API 供应商/模型配置，导入时保留当前 API 设置；供应商锁定开启时，会话恢复也不能覆盖被锁定的默认供应商 URL |
| 工作流模型引用解析 | `js/features/persistence/workflow-model-resolver.js` | 旧工作流模型 ID 到当前模型配置的自动匹配；缺失模型或供应商引用提示 |
| 会话管理 | `js/features/persistence/session-manager.js` | 自动保存、页面关闭前恢复等会话持久化 |
| **设置** | | |
| 设置控制器 | `js/features/settings/settings-controller.js` | 设置数据逻辑、API 供应商与模型管理、供应商模型列表获取弹窗、API 设置帮助弹窗、搜索与添加模型、持久化、代理检测、自动检测本地代理端口、版本更新、画布连线设置、通用设置卡片布局、安全开关与并发请求模式开关；供应商锁定时负责隐藏新增/删除入口并把供应商 URL 渲染为只读 |
| 设置弹窗 | `js/features/settings/settings-modal.js` | 设置弹窗开关与标签页 UI 行为 |
| **UI 控制器** | | |
| 剪贴板 | `js/features/ui/clipboard-controller.js` | 节点复制粘贴、剪贴板操作、节点配置字段复制 |
| 右键菜单 | `index.html`, `js/features/ui/context-menu-controller.js`, `css/legacy.css`, `css/themes.css` | 画布/节点右键菜单结构、分类二级菜单、节点项事件分发、视口避让、悬停延迟关闭与主题样式；分类入口用 `data-submenu-target`，二级菜单用 `data-context-submenu`，具体节点创建项仍用 `data-type` |
| 错误弹窗 | `js/features/ui/error-modal-controller.js` | 错误详情弹窗 UI |
| 全局交互 | `js/features/ui/global-interactions.js` | 键盘快捷键、全局点击、粘贴、全局图片拖拽/drop 等顶层事件 |
| 面板管理 | `js/features/ui/panel-manager.js` | 侧边栏面板展开收起管理 |
| 运行状态 | `js/features/ui/runtime-controller.js` | 运行按钮状态、执行进度反馈 |
| 主题切换 | `js/features/ui/theme-controller.js` | 明暗主题切换与持久化 |
| 全局动画 | `js/features/ui/animation-controller.js` | 将 `globalAnimationEnabled` 应用到根节点 CSS 类，并同步旧的连线动画兼容字段 |
| Toast 通知 | `js/features/ui/toast-controller.js` | Toast 消息弹出与自动消失 |
| 左上角悬浮通知 | `js/features/ui/floating-notices-controller.js`, `index.js`, `js/features/update/update-manager.js` | 画布左上角通知条；固定启动通知在 `index.js` 的 `initFloatingNotices()`，更新提醒在 `showUpdateCanvasNotice()` |
| 工具栏 | `js/features/ui/toolbar-controller.js` | 顶部工具栏按钮绑定与状态同步 |
| UI 总控 | `js/features/ui/ui-controller.js` | UI 层模块统一初始化与依赖注入；配置导入时如果启用了供应商锁定，需要保留锁定的默认供应商并把导入模型重新绑定到当前可用供应商 |
| UI 工具 | `js/features/ui/ui-utils.js` | UI 层通用辅助函数 |
| **更新** | | |
| 在线更新 | `js/core/constants.js`, `index.js`, `js/features/update/update-manager.js`, `js/features/settings/settings-controller.js` | GitHub Release 版本对比、启动自动检测开关、设置页更新模块显隐、更新提示、直接下载更新、右下角常驻下载进度/速度/百分比通知、取消下载、窗口关闭取消、100% 后重启提示 |
| 版本读取 | `js/core/constants.js`, `backend/services/version_service.py` | 以 `APP_VERSION_NUMBER` 作为唯一来源；前端展示、静态资源版本、后端启动提示与 User-Agent 都从这条链路读取 |
| **工作流** | | |
| 工作流管理 | `js/features/workflow/workflow-manager.js` | 工作流列表、保存、加载、删除、重命名编排；列表按钮与右键菜单共用重命名逻辑，前端负责空名/同名/非法字符/重名校验；保存时只写画布、节点、连线和版本号 |

### Nodes（节点层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 节点注册中心 | `js/nodes/registry.js` | 节点类型定义注册中心 |
| 节点 DOM 绑定 | `js/nodes/node-dom-bindings.js` | 节点 DOM 事件绑定与输入监听、节点内控件值归一化；端口 `mousedown` 也在这里区分未连接输入口普通拖线和已连接输入口改线/断线；Text / TextSplit 节点编辑和右下角快速缩放时只同步数据与保存，不接入 textarea ResizeObserver shrink；Text 多文本切换与当前项编辑、可输入 textarea 的手动高度在这里通过 `textareaHeights` 记录并触发保存；TextSplit 节点在这里绑定“输出数量”步进控件、限制数字输入、处理 `0 = 自动生成端口`、处理“多合一输出”开关、动态重建输出端口、渲染可滚动节点内预览并清理失效连线；ImageMerge/TextMerge 的备用输入口同步和失效连线清理也在这里；TextChat 回复区滚动与复制按钮事件也在这里接入；ImageGenerate 等可扩展 textarea 只能在真实尺寸变化时触发 fit，点击/聚焦提示词框不得触发 shrink；运行中节点浮动取消按钮的 2 秒长按、拖动阈值取消长按、事件阻止冒泡也在这里绑定；节点内自定义下拉（用于画布缩放场景）也在这里绑定 |
| 节点生命周期 | `js/nodes/node-lifecycle.js` | 节点创建、销毁、状态更新；旧 TextInput/TextDisplay 创建时映射为 Text；Text 节点尺寸测量、非文本内容显示不全兜底、Alt 删除保留上下游连接、拖拽晃动摘取节点后的连线保留逻辑在这里；TextSplit 预览区、TextChat 回复区和文本显示框这类可滚动长内容不得按完整内容 `scrollHeight` 撑高最小尺寸；节点类型的 `defaultHeight` 与 `minHeight` 在这里分开使用，支持默认较高但手动缩小到独立最小高度；删除、摘取、启用/禁用必须跳过运行中节点；启用/禁用后要刷新连线、端口状态与依赖预览 |
| 序列化 | `js/nodes/node-serializer.js` | 节点序列化、会话状态 payload、workflow 导出结构；workflow 导出只含画布、节点、连线和版本号；TextSplit 的 `delimiter` / `outputCount` / `removeEmptyLines` / `previewEnabled` / `mergeOutputEnabled` / `parts`、Text 的 `texts` / `textPreviewIndex`、ImageMerge/TextMerge 的 `inputCount` 以及输入框手动高度缓存 `textareaHeights` 也在这里保存 |
| 节点视图工厂 | `js/nodes/node-view-factory.js` | 节点 HTML 模板生成，含 Text 文本框和多文本切换控件、TextSplit 分隔符、输出数量步进控件、删除空行、多合一输出与节点内预览控件、TextChat 回复框内部左上角小复制按钮、ImageGenerate 分辨率与生成次数控件、ImageCompare 高级对比入口按钮，以及运行中节点卡片外浮动取消按钮结构；TextSplit 不再渲染内部长文本输入框，输出数量为 `0` 时按分割结果自动生成端口并显示提示，开启 `mergeOutputEnabled` 时只生成单个 `text` 输出端口；ImageMerge/TextMerge 初始端口数量从 `inputCount` 恢复并遵守备用输入口；ImageGenerate 当前在节点内只显示 `xx/xx` 生成进度，不再显示结果预览；textarea 初始高度从 `textareaHeights` 恢复；节点端口区当前由顶部并排的 `.node-ports-row` 统一生成，输入/输出两列顶部对齐 |
| 视角控制节点 | `js/nodes/types/camera-control.js` | CameraControl 节点定义、端口、默认尺寸与最小尺寸；固定结构节点不要把最小尺寸散落到私有逻辑里 |
| 图片生成节点 | `js/nodes/types/image-generate.js` | ImageGenerate 节点定义、端口与默认尺寸 |
| 图片导入节点 | `js/nodes/types/image-import.js` | ImageImport 节点定义 |
| 图片对比节点 | `js/nodes/types/image-compare.js` | ImageCompare 节点定义，包含 A/B 图片输入与 B 图片输出 |
| 多图合一节点 | `js/nodes/types/image-merge.js` | ImageMerge 节点定义，多个 `image_N` 输入按端口顺序展平成一个图片数组，由单个 `image` 输出口输出；输入端口遵守备用输入口规则 |
| 图片预览节点 | `js/nodes/types/image-preview.js` | ImagePreview 节点定义 |
| 图片缩放节点 | `js/nodes/types/image-resize.js` | ImageResize 节点定义 |
| 图片保存节点 | `js/nodes/types/image-save.js` | ImageSave 节点定义、默认尺寸与固定结构节点的基础高度约束 |
| 对话节点 | `js/nodes/types/text-chat.js` | TextChat 节点定义；回复文本框内部左上角放小复制按钮，长回复在框内滚动，不应撑高节点；默认高度可保持便于阅读，手动缩小时通过独立 `minHeight` 控制下限 |
| 文本节点 | `js/nodes/types/text.js` | Text 节点正式定义，包含 1 个文本输入口和 1 个文本输出口 |
| 多文本合一节点 | `js/nodes/types/text-merge.js` | TextMerge 节点定义，多个 `text_N` 输入按端口顺序展平成一个文本数组，由单个 `text` 输出口输出；输入端口遵守备用输入口规则 |
| 文本分割节点 | `js/nodes/types/text-split.js` | TextSplit 节点定义，按自定义分隔字符串把上游文本切成多段；输出口数量可由 `outputCount` 固定控制，`0` 表示根据分割结果自动生成 `part_N` 端口；开启 `mergeOutputEnabled` 时收敛为单个 `text` 输出端口并输出多文本数组；可开启删除空行和节点内预览，预览区滚动展示且不锁定节点高度 |
| 文本显示兼容节点 | `js/nodes/types/text-display.js` | TextDisplay 旧缓存/旧工作流兼容 shim，不在注册表中作为新节点注册 |
| 文本输入兼容节点 | `js/nodes/types/text-input.js` | TextInput 旧缓存/旧工作流兼容 shim，不在注册表中作为新节点注册 |

---

## 后端结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 批处理启动入口 | `start_cainflow.bat` | 源码双击启动、Python 探测、端口预检查、黑色窗口停留提示；端口冲突时只提示 PID / 进程名 / 命令行，不自动关闭占用进程 |
| 兼容入口 | `server.py` | 兼容性启动壳，转调 backend 主入口 |
| 服务启动 | `backend/main.py` | 端口检查、冲突进程识别、启动失败停留提示、Banner 打印、浏览器打开、服务启动；启动时清理上次遗留的更新临时文件 |
| 请求分发 | `backend/handler.py` | 静态资源服务、路由分发、`/proxy` 与 `/api/update/*` 入口 |
| 运行时配置 | `backend/config.py` | 端口、路径、运行时目录、GitHub 仓库与 `MAIN_EXE_PATH` 等配置项 |
| 运行时状态 | `backend/state.py` | 共享运行时状态与噪音请求过滤 |
| 设置路由 | `backend/routes/settings_routes.py` | 设置相关 HTTP 请求处理 |
| 工作流路由 | `backend/routes/workflow_routes.py` | 工作流 CRUD 接口；处理重命名请求与目标已存在冲突返回 |
| 更新路由 | `backend/routes/update_routes.py` | 在线更新下载启动、状态查询与取消接口 |
| HTTP 工具 | `backend/services/http_helpers.py` | JSON 请求体解析与 JSON / 错误响应 |
| 日志服务 | `backend/services/log_service.py` | 服务端日志收集与管理 |
| 代理服务 | `backend/services/proxy_service.py` | 上游代理与请求转发 |
| 安全服务 | `backend/services/security_service.py` | 允许主机列表、代理检测、安全路径与 URL 校验 |
| 工作流服务 | `backend/services/workflow_service.py` | 工作流列表、读取、保存、重命名、删除；重命名时禁止静默覆盖已有工作流 |
| 更新服务 | `backend/services/update_service.py` | GitHub Release ZIP 下载任务、进度/速度/百分比、Release asset size 总量、完成态 100%、取消清理、只提取 `CainFlow.exe`、覆盖 `MAIN_EXE_PATH`、Windows 待替换脚本 |

---

## CSS 结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 样式入口 | `index.css` | 分层样式入口，@import 各子目录 |
| Layout | `css/layout/layout.css` | 应用整体布局与面板排布 |
| Components | `css/components/nodes.css` | 可复用的节点与组件样式；图片对比节点、高级全屏对比、A/B 互斥裁切、缩略图选择网格、展开选图态和对比舞台缩放/平移光标样式 |
| Features | `css/features/panels.css`, `css/features/settings.css` | 功能区或面板专属样式；设置面板新增交互（如供应商模型列表弹窗、API 设置帮助弹窗、获取模型列表按钮、通用设置卡片 grid、统一滑动开关样式）放 `settings.css` |
| Themes | `css/themes.css` | 主题切换相关样式（明暗模式等） |
| Legacy | `css/legacy.css` | 兼容层与遗留样式承接 |

---

## 常见需求落点

| 需求 | 优先检查这些文件 |
| --- | --- |
| 修复工作流保存、加载、列表、重命名、删除 | `js/features/workflow/workflow-manager.js`, `js/features/persistence/workflow-model-resolver.js`, `js/services/workflow-api.js`, `backend/routes/workflow_routes.py`, `backend/services/workflow_service.py` |
| 修改 workflow JSON 契约、导入旧工作流模型匹配或缺失模型提示 | `js/nodes/node-serializer.js`, `js/features/workflow/workflow-manager.js`, `js/features/persistence/project-io.js`, `js/features/persistence/workflow-model-resolver.js`, `workflows/Default.json` |
| 修复工作流执行、节点调度 | `js/features/execution/workflow-runner.js`, `js/features/execution/execution-core.js`, `js/features/execution/provider-request-utils.js` |
| 修改运行中节点取消、下游跳过或单节点 abort 行为 | `js/features/execution/workflow-runner.js`, `js/core/state.js`, `index.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `css/components/nodes.css`, `css/themes.css`, `js/features/help/help-panel.js` |
| 修复代理请求拼装或 API 调用 | `js/services/api-client.js`, `backend/handler.py`, `backend/services/proxy_service.py` |
| 修改 OpenAI 兼容生图请求路径、参考图上传或请求体格式 | `js/features/execution/provider-request-utils.js`, `js/features/execution/execution-core.js`, `js/services/api-client.js`, `backend/services/proxy_service.py` |
| 修改生图节点分辨率菜单、OpenAI 自定义分辨率输入 | `js/features/execution/provider-request-utils.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js` |
| 修改生图节点生成次数、成功计数或失败重试语义 | `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `js/features/execution/execution-core.js`, `js/features/execution/workflow-runner.js` |
| 修复禁用节点仍影响下游、缓存输出穿透或禁用后预览未断流 | `js/features/execution/workflow-runner.js`, `js/features/execution/execution-core.js`, `js/features/media/media-controller.js`, `js/nodes/node-lifecycle.js` |
| 修改多图/多文本数组批处理、下游逐项运行或数组输出聚合 | `js/features/execution/workflow-runner.js`, `js/features/execution/execution-core.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js` |
| 修改并发请求模式、API 节点批量并发、失败项重试或并发结果提交 | `js/core/state.js`, `js/features/settings/settings-controller.js`, `js/features/ui/ui-controller.js`, `js/features/persistence/project-io.js`, `js/nodes/node-serializer.js`, `index.js`, `js/features/execution/workflow-runner.js`, `js/features/execution/execution-core.js` |
| 修改 TextChat 固定结果缓存、忽略上游依赖或固定缓存输出语义 | `js/features/execution/execution-core.js`, `js/features/execution/workflow-runner.js`, `js/nodes/node-serializer.js`, `js/nodes/node-view-factory.js` |
| 修改节点端口位置、输入/输出端口顶部对齐或端口行结构 | `js/nodes/node-view-factory.js`, `css/legacy.css`, `js/canvas/connections.js` |
| 修改 ImageMerge/TextMerge 合一节点或备用输入口动态端口 | `js/nodes/types/image-merge.js`, `js/nodes/types/text-merge.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `js/features/execution/execution-core.js`, `index.html` |
| 修复设置面板或代理设置交互 | `js/features/settings/settings-modal.js`, `js/features/settings/settings-controller.js`, `backend/routes/settings_routes.py`, `backend/services/security_service.py` |
| 修改 API 供应商卡片、API 设置帮助入口、获取模型列表弹窗、模型搜索或添加模型到模型管理 | `index.html`, `js/features/settings/settings-controller.js`, `js/services/api-client.js`, `js/features/execution/provider-request-utils.js`, `css/features/settings.css`, `index.css` |
| 调整通用设置卡片布局、字号、留白、对齐或统一开关样式 | `js/features/settings/settings-controller.js`, `css/features/settings.css`, `css/themes.css` |
| 调整代理白名单、私网访问开关、`Target URL is not allowed` 类提示 | `backend/services/security_service.py`, `backend/services/proxy_service.py`, `js/services/api-client.js`, `js/features/settings/settings-controller.js`, `js/features/update/update-manager.js` |
| 修复历史记录面板 | `js/features/history/history-panel.js`, `js/features/history/history-preview.js`, `js/features/history/history-fullscreen.js`, `js/features/history/history-utils.js`, `js/services/storage-idb.js`, `css/features/panels.css`, `css/legacy.css` |
| 修复历史记录图片拖拽到画布/节点 | `js/features/history/history-panel.js`, `js/features/history/history-fullscreen.js`, `js/features/ui/global-interactions.js`, `js/features/media/media-controller.js`, `js/core/state.js`, `js/services/storage-idb.js` |
| 新增或修改提示词库管理、预设卡片、多选删除、复制、导入画布、提示词 JSON 导入导出 | `js/features/prompts/prompt-library.js`, `index.html`, `index.js`, `css/features/panels.css`, `css/themes.css` |
| 修复日志面板或错误详情 | `js/features/logs/log-panel.js`, `backend/services/log_service.py` |
| 新增或修改节点类型 | `js/nodes/types/*.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `css/components/nodes.css` |
| 修复固定结构节点缩放后内容裁剪、文本框显示不全或控件重叠 | `js/nodes/types/*.js`, `js/nodes/node-lifecycle.js`, `js/canvas/canvas-interactions.js`, `js/nodes/node-view-factory.js`, `css/components/nodes.css` |
| 新增或修改 `CameraControl` 视角控制节点 | `js/nodes/types/camera-control.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/features/camera/camera-control-node.js`, `js/nodes/node-lifecycle.js`, `js/canvas/canvas-interactions.js`, `css/components/nodes.css`, `css/themes.css`, `js/features/execution/execution-core.js`, `js/features/ui/clipboard-controller.js`, `js/features/persistence/project-io.js` |
| 修改 `ImagePreview` / `ImageSave` 多图预览、批量保存或自动保存编号文件名 | `js/features/execution/execution-core.js`, `js/features/execution/workflow-runner.js`, `js/features/media/media-controller.js`, `js/nodes/node-view-factory.js`, `js/nodes/types/image-preview.js`, `js/nodes/types/image-save.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `css/legacy.css` |
| 修改文本节点输入/输出/尺寸行为 | `js/nodes/types/text.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `js/features/execution/execution-core.js`, `js/features/ui/global-interactions.js`, `index.html`, `css/legacy.css` |
| 修改 TextSplit 输出数量、自动端口、多合一输出、节点内预览或输出字段序列化 | `js/nodes/types/text-split.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `js/features/execution/execution-core.js`, `css/legacy.css` |
| 修改文本框高度缓存、TextSplit 预览区滚动或 TextChat 回复框布局 | `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `css/legacy.css` |
| 新增或修改图片对比/预览/缩放/保存类节点 | `js/nodes/types/*.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/features/media/media-controller.js`, `js/features/execution/execution-core.js`, `css/components/nodes.css` |
| 修改节点内下拉菜单与画布缩放的交互方式 | `js/nodes/node-dom-bindings.js`, `js/nodes/node-view-factory.js`, `css/legacy.css`, `css/themes.css`, `js/canvas/canvas-interactions.js` |
| 修改图片对比高级模式（全屏对比、A/B 选图、历史图片、展开选择、滚轮缩放、左键平移） | `js/nodes/node-view-factory.js`, `js/features/media/media-controller.js`, `index.js`, `js/services/storage-idb.js`, `css/components/nodes.css` |
| 修改 `ImageGenerate` 节点内进度区 / 结果区显示 | `js/nodes/node-view-factory.js`, `js/features/execution/execution-core.js`, `js/nodes/node-dom-bindings.js`, `css/legacy.css` |
| 修复节点 DOM 绑定或事件 | `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js` |
| 修复画布拖拽、框选、缩放、几何绘制、晃动摘取节点交互 | `js/canvas/canvas-interactions.js`, `js/canvas/selection.js`, `js/canvas/viewport.js`, `js/canvas/geometry.js` |
| 修复连线绘制、孤立节点拖入连线插入预览、拖线到空白处创建候选节点后的默认接线 | `js/canvas/connections.js` |
| 修复已连接输入端口拖拽改线、拖到空白处断开连接 | `js/nodes/node-dom-bindings.js`, `js/canvas/canvas-interactions.js`, `js/canvas/connections.js` |
| 调整滚轮缩放结束后的文字锐化延迟或缩放手感 | `js/canvas/canvas-interactions.js`, `js/canvas/viewport.js`, `js/features/ui/toolbar-controller.js` |
| 修复节点删除、摘取节点、节点尺寸显示不全兜底 | `js/nodes/node-lifecycle.js`, `js/nodes/node-dom-bindings.js` |
| 更新操作帮助面板内容或帮助字体 | `js/features/help/help-panel.js`, `css/legacy.css` |
| 修改共享常量或默认值 | `js/core/constants.js`, `js/core/state.js` |
| 修改默认 API 供应商或默认模型 | `js/core/constants.js`, `js/features/settings/settings-controller.js`, `js/features/execution/provider-request-utils.js` |
| 新增或调整“锁定 API 供应商”能力 | `js/core/constants.js`, `js/features/settings/settings-controller.js`, `js/features/ui/ui-controller.js`, `js/features/persistence/project-io.js` |
| 修改连线类型 | `js/features/settings/settings-controller.js`, `js/core/state.js`, `js/canvas/connections.js`, `js/canvas/geometry.js`, `js/features/ui/ui-controller.js`, `js/features/persistence/project-io.js`, `js/nodes/node-serializer.js` |
| 修改全局动画开关或禁用动画性能模式 | `js/features/settings/settings-controller.js`, `js/features/ui/animation-controller.js`, `js/core/state.js`, `js/canvas/connections.js`, `css/legacy.css`, `js/features/ui/ui-controller.js`, `js/features/persistence/project-io.js`, `js/nodes/node-serializer.js`, `index.html` |
| 修改 DOM 获取或顶层元素引用 | `js/core/elements.js`, `index.html` |
| 添加通用工具函数 | `js/core/common-utils.js` |
| 媒体/图片处理 | `js/features/media/image-painter.js`, `js/features/media/media-controller.js`, `js/features/media/media-utils.js` |
| 图片节点的运行态预览、对比、下游级联刷新 | `js/features/media/media-controller.js`, `js/features/execution/execution-core.js`, `js/nodes/node-dom-bindings.js` |
| 项目文件导入导出 | `js/features/persistence/project-io.js`, `js/features/persistence/workflow-model-resolver.js`, `js/nodes/node-serializer.js` |
| 自动保存 / 会话恢复 | `js/features/persistence/session-manager.js` |
| 主题切换 | `js/features/ui/theme-controller.js`, `css/themes.css` |
| Toast 通知 | `js/features/ui/toast-controller.js` |
| 画布左上角悬浮通知 | `index.js` 的 `initFloatingNotices()`, `js/features/ui/floating-notices-controller.js`, `js/features/update/update-manager.js`, `css/legacy.css`, `css/themes.css` |
| 键盘快捷键 / 全局事件 | `js/features/ui/global-interactions.js` |
| 剪贴板操作 | `js/features/ui/clipboard-controller.js` |
| 右键菜单 / 添加节点分类二级菜单 | `index.html`, `js/features/ui/context-menu-controller.js`, `css/legacy.css`, `css/themes.css` |
| 版本更新检查、更新模块显隐与直接下载更新 | `js/core/constants.js`, `index.js`, `js/features/update/update-manager.js`, `js/features/settings/settings-controller.js`, `backend/routes/update_routes.py`, `backend/services/update_service.py`, `backend/config.py`, `backend/main.py`, `backend/handler.py`, `index.html`, `css/legacy.css`, `css/themes.css` |
| 修改代理自动检测端口或检测顺序 | `js/features/settings/settings-controller.js`, `backend/routes/settings_routes.py`, `backend/services/security_service.py` |
| 升级应用版本号 | `js/core/constants.js`, `index.html`, `index.js`, `backend/services/version_service.py`, `backend/main.py`, `backend/services/proxy_service.py`, `backend/routes/settings_routes.py`, `backend/services/update_service.py`, `README.md` |
| 应用启动流程 | `js/features/app/startup-controller.js`, `index.js` |
| 修复静态资源加载或路由兜底问题 | `index.html`, `backend/handler.py`, `backend/state.py` |
| 修改服务启动或本地运行行为 | `start_cainflow.bat`, `server.py`, `backend/main.py`, `backend/config.py` |
| 添加功能专属样式 | `css/features/panels.css` 或 `css/features/` 下新增文件，并接入 `index.css` |
| 服务端日志 | `backend/services/log_service.py`, `backend/routes/` |
| 修改 GitHub Actions 发布打包或 Release ZIP 内容 | `.github/workflows/release.yml`, `scripts/build-release-local.ps1`, `server.py`, `backend/config.py` |

---

## 常用检索命令

```powershell
# 浏览前端模块树
Get-ChildItem js -Recurse -Filter *.js | Select FullName

# 关键词定位责任文件
grep -r "workflow|history|settings|proxy|log" js backend --include="*.js" --include="*.py" -l

# 追踪模块导出
grep -r "^export " js --include="*.js"

# 后端路由/服务定位
grep -r "handle_get\|handle_post\|handle_delete\|def " backend --include="*.py"
```

---

## 模块化约束

- `index.js` 是集成层，不是新的逻辑堆放场。
- 前端入口直接使用 `index.js`，不要再增加无意义的二次转发入口。
- 先判断现有模块是否已经负责这类行为；如果职责仍然清晰，就继续在现有模块中扩展，不要为了“新功能”机械拆文件。
- 如果一个新能力会被多个画布/设置/持久化流程复用，或继续塞进现有文件会让职责变混乱，再提炼成 `js/canvas/*`、`js/core/*` 或 `js/features/<feature>/*` 下的新模块，而不是继续堆进 `index.js` 或单个控制器。
- 执行逻辑放 `js/features/execution/`，不要混入 UI 控制器。
- 运行中节点锁定由 `state.runningNodeIds` 驱动：正在运行的节点不能编辑、移动、缩放、删除、禁用或改连线，但允许复制/克隆；右键运行其他未运行节点时只阻止运行范围与 `runningNodeIds` 重叠，不再用全局 `state.isRunning` 阻止所有运行入口。
- 运行中单节点取消和顶部停止工作流是两条不同链路：顶部停止按钮继续 abort `state.runAbortControllers` 里的所有 active sessions；节点底部浮动取消按钮只调用当前节点在 `state.runningNodeCancelHandlers` 中注册的 handler。执行器必须只 abort 该节点自己的 signal，并把本次 execution plan 内从该节点可达的下游加入跳过集合，不得影响其他已在运行或即将调度的无关分支。按钮结构在 `node-view-factory.js`，长按 2 秒和拖动阈值判断在 `node-dom-bindings.js`，样式在 `css/components/nodes.css` / `css/themes.css`，新增交互要同步 `help-panel.js`。
- 供应商协议、模型能力、模型用途/协议归一化、OpenAI/Gemini 生图请求路径、请求体和分辨率预设优先放 `js/features/execution/provider-request-utils.js`；实际执行时的取 DOM 值、选择 JSON 或 multipart、调用 `/proxy` 放 `js/features/execution/execution-core.js`。
- 设置面板里的 API 供应商/模型管理继续放 `js/features/settings/settings-controller.js`：供应商卡片操作、获取模型列表按钮、模型列表弹窗、搜索、滚动位置保留、调用 `/proxy` 获取 OpenAI 兼容 `/v1/models` 或 Google `/v1beta/models`、添加条目到 `state.models` 都属于这里。调用代理请求头时复用 `js/services/api-client.js`；添加模型时要同步遵守 `provider-request-utils.js` 的用途与协议归一化，GPT/DALL-E/OpenAI 类模型用 OpenAI 兼容格式，Gemini 用 Google 格式，banana/imagen/image 类模型归为生图。
- API 设置帮助属于设置面板内的轻量弹窗能力：标题旁入口只在 `index.html` 放静态按钮，弹窗内容和事件由 `settings-controller.js` 渲染管理，关闭按钮、遮罩关闭和设置弹窗关闭时的清理都应在同一控制器中处理；样式集中到 `css/features/settings.css` 并补浅色主题覆盖。
- 通用设置是设置面板里的独立视觉区域：卡片结构继续由 `js/features/settings/settings-controller.js` 渲染，布局和视觉收敛到 `css/features/settings.css`。优先使用统一 grid（例如 `general-settings-grid` / `general-settings-card`）和统一的滑动开关 `toggle-switch` / `toggle-slider`，不要在通用设置里继续堆内联布局、混用 checkbox 外观或把样式加回 `css/legacy.css`。
- 并发请求模式属于通用设置中的“自动化与重试”能力，状态字段是 `concurrentRequestMode`，默认开启。该开关影响执行调度和 API 节点结果提交，新增或迁移时必须同步状态默认值、设置页 UI、导入导出、会话恢复、节点序列化和 `index.js` 依赖注入。
- 供应商锁定属于“共享常量 + 设置页 + 持久化”的联合约束：`API_PROVIDERS_LOCKED` 放 `js/core/constants.js`，设置页按钮显隐和供应商 `endpoint` 只读在 `js/features/settings/settings-controller.js`，配置导入旁路保护在 `js/features/ui/ui-controller.js`，会话恢复旁路保护在 `js/features/persistence/project-io.js`。锁定后模型管理仍可用，但不能让导入配置或本地恢复替换默认供应商 URL。
- 代理安全策略的职责边界要固定：允许域名、内置默认放行域名、私网/本机阻断、`allowPrivateNetworkTargets` 逻辑都收在 `backend/services/security_service.py`；`backend/services/proxy_service.py` 只负责读取请求头并调用校验；前端安全开关与允许域名维护入口在 `js/features/settings/settings-controller.js`；统一中文错误提示在 `js/services/api-client.js`；更新检查如需复用这套提示，走 `js/features/update/update-manager.js`。
- 项目内建功能依赖的官方域名也属于默认允许名单的一部分，而不只是第三方 API 供应商域名。当前更新检查依赖 `api.github.com` / `github.com`，调整 SSRF 默认策略时要把这些项目自用域名一起纳入考虑，避免误拦截。
- 启动冲突提示需要同时照顾源码运行和打包运行：`start_cainflow.bat` 是源码双击入口，`backend/main.py` 是后端真实启动入口。端口占用时不要自动 `taskkill`，应识别占用进程并在黑色窗口中停留提示，区分 CainFlow 已运行和其他程序占用；测试冲突分支时可临时监听 `0.0.0.0:8767` 或模拟 CainFlow 命令行，结束后必须释放端口并清理临时缓存。
- 在线更新的前端状态、通知、下载进度/速度/百分比、取消按钮、关闭窗口确认和关闭后自动取消都收在 `js/features/update/update-manager.js`；设置页只展示入口和状态，不另写下载逻辑。右下角常驻下载进度通知挂到 `#toast-container`，样式在 `css/legacy.css` / `css/themes.css`，普通 Toast 可以自动消失，但更新下载进度卡片在完成、取消或失败前必须常驻。后端更新路由只做接口分发，下载、取消、临时文件清理、Release ZIP 选择、`CainFlow.exe` 提取和主程序替换都放 `backend/services/update_service.py`。更新服务必须只提取并校验 Windows 主程序文件，不允许整包解压；目标路径使用 `backend/config.py` 的 `MAIN_EXE_PATH`，打包后应指向 `sys.executable`。下载进度总量优先用 GitHub Release asset 的 `size`，完成态要在顶层状态写入 `downloadedBytes`、`totalBytes` 和 `percent=100`；前端收到完成态后先渲染 100% 进度，再延迟弹出重启提示，避免 `alert()` 阻塞 100% 进度帧。取消、失败、完成和下次启动都要清理未完成下载与 ZIP 临时文件；运行中的 EXE 被锁住时，使用待替换文件加重试脚本完成覆盖，并提示用户重启 CainFlow 主程序。
- 更新能力的全局关闭参数是 `js/core/constants.js` 的 `AUTO_UPDATE_CHECK_DISABLED`。为 `true` 时，`index.js` 把 `autoUpdateCheckDisabled` 注入 `js/features/update/update-manager.js`，启动自动检测不再排队、不显示倒计时、不请求 GitHub；`js/features/settings/settings-controller.js` 也不渲染“系统版本与更新”卡片。调整自动检测、手动检查按钮或设置页更新模块显隐时，要同步检查这条常量链，避免只关一半。
- 发布包构建链路分为 GitHub Actions 与本地脚本两份入口：`.github/workflows/release.yml` 负责 tag/manual 触发的 Release ZIP，`scripts/build-release-local.ps1` 负责本地复现。两者的 PyInstaller 资源列表要保持一致；`server.py` 导入的 `backend` 会作为 Python 模块自动进入 exe，不要再把 `backend` 当 `--add-data` 静态目录重复打包，尤其不要把 `__pycache__` 带进发布包。
- OpenAI 兼容生图无参考图走 `/v1/images/generations`；有 `image_1` 到 `image_5` 任意参考图走 `/v1/images/edits`。`/images/edits` 必须发送 `multipart/form-data`，图片作为文件字段上传；不要用 JSON `reference_images` 代替 multipart。
- OpenAI 兼容生图分辨率菜单由 `provider-request-utils.js` 的选项驱动：`自动` 使用空值且不发送 `size`，固定项使用 OpenAI `WxH` size，自定义项由节点 UI 的“宽度输入框 x 高度输入框”拼成 `宽x高`。相关 UI 在 `js/nodes/node-view-factory.js` / `js/nodes/node-dom-bindings.js`，序列化同步更新 `js/nodes/node-serializer.js` 和 `js/features/ui/clipboard-controller.js`。
- ImageGenerate 生成次数使用 `generationCount`：模板在 `js/nodes/node-view-factory.js`，最小值归一化和 +/- 事件在 `js/nodes/node-dom-bindings.js`，保存/导出在 `js/nodes/node-serializer.js`，复制粘贴在 `js/features/ui/clipboard-controller.js`，执行循环在 `js/features/execution/execution-core.js`。失败不计入次数；自动重试时通过运行时字段 `generationCompletedCount` 保留本轮已成功次数，`js/features/execution/workflow-runner.js` 负责新一轮运行前重置。
- 并发请求模式下的 ImageGenerate 既可能由 `workflow-runner.js` 对多组上游输入并发运行，也可能由 `execution-core.js` 对同一节点的 `generationCount` 内部并发运行。内部并发成功前优先保持局部结果，失败时普通运行可提交已成功图片供重试续跑；批量并发运行只能返回 `{ image, images }` 给运行器统一提交，不要在每个 batch 内写共享节点输出。
- 媒体处理放 `js/features/media/`，不要堆回节点类型文件。
- 图片类节点的定义、模板、DOM 绑定、媒体同步和执行输出要分层处理：`js/nodes/types/*.js` 只放元数据和端口；`js/nodes/node-view-factory.js` 只生成结构；`js/nodes/node-dom-bindings.js` 只接入节点事件；`js/features/media/media-controller.js` 负责图片显示状态、交互与依赖刷新；`js/features/execution/execution-core.js` 负责运行时输入校验、输出写入和向下游分发。
- 节点端口位置先看 `js/nodes/node-view-factory.js` 与 `css/legacy.css`：当前输入/输出端口在顶部同一行并排展开，最上方端口需要左右对齐。`js/canvas/connections.js` 只负责按端口圆点实际 DOM 坐标取点，除非连线命中或路径本身有问题，不要为端口视觉位置改连线几何。
- 文本节点统一使用 `Text`。`TextInput` / `TextDisplay` 只保留兼容 shim 和创建时映射，不要重新暴露为新建节点。Text 节点运行后不要自动设置大小；编辑文本时也不要自动缩放节点。若要改尺寸策略，先同时检查 `node-dom-bindings.js`、`node-lifecycle.js`、`execution-core.js` 和 `css/legacy.css`。
- 文本输入框的手动高度持久化统一走 `textareaHeights`：节点模板恢复、输入监听后的保存、工作流序列化和复制粘贴都要同步更新；`ResizeObserver` 只记录高度变化并触发保存，不负责 shrink fit。
- ImageGenerate / TextChat / Text 等带 textarea 的节点若出现“点击输入框后节点变小”，优先检查 `js/nodes/node-dom-bindings.js` 里的可扩展元素尺寸监听。只允许 `ResizeObserver` 等真实尺寸变化触发 fit，不要把 `mouseup`、`touchend`、focus/click 这类交互事件接到 shrink fit。
- TextSplit 输出数量控件是节点内步进控件：左右按钮增减，中间输入框只能输入数字；`outputCount > 0` 时固定生成对应数量 `part_N` 端口，`outputCount = 0` 时按分割结果自动生成 `part_N` 端口。开启“多合一输出”时保存 `mergeOutputEnabled`，端口收敛为单个 `text` 输出口，输出值是分割片段组成的多文本数组，并应通过 `node.data.texts` / `getCachedOutputValue(node, 'text')` 向下游传递。保存、复制、恢复和运行都要保留 `outputCount` 与 `mergeOutputEnabled`，旧工作流缺少这些字段时应从 `parts` 或分割结果推导普通端口数量，避免已有 `part_N` 连线失效。
- TextSplit 预览区、TextChat 回复区这类节点内长内容必须在节点内部滚动展示，不能把完整内容高度纳入最小尺寸测量；复制按钮等覆盖控件应收在结果框内部，不要额外占用一列布局。共享测量链遇到可滚动结果区时只测稳定容器高度，避免 `body.scrollHeight` 或父容器 `offsetHeight` 把长回复全文重新算进 resize 最小高度。
- TextChat 的“固定结果”是缓存输出语义，不是普通复用请求语义：已有缓存时执行计划不再收集它的上游依赖，批量调度不按上游数组拆批，handler 不检查 API 配置也不发请求；下游读取文本输出时只拿 `node.data.text`，避免旧 `node.data.texts` 把缓存结果重新变成多组输入。
- `CameraControl` 这类固定结构工具节点遵循统一责任链：节点定义在 `js/nodes/types/camera-control.js`，模板在 `js/nodes/node-view-factory.js`，DOM 绑定在 `js/nodes/node-dom-bindings.js`，3D 逻辑和 prompt 映射在 `js/features/camera/camera-control-node.js`，共享最小尺寸/显示兜底在 `js/nodes/node-lifecycle.js`，拖拽缩放期的动态最小尺寸约束在 `js/canvas/canvas-interactions.js`，样式在 `css/components/nodes.css`。
- `CameraControl` 节点的编辑器只在用户点击“编辑视角”时出现；退出编辑后不应继续显示 3D 窗口，以免白白占用渲染压力。缩略图、参数和提示词要保存在 `node.data` 里，并在运行、复制、导出和恢复时保持一致。
- `CameraControl` 编辑器里的正视重置、世界中心坐标轴、手动数值输入、单位显示和浅色主题覆盖继续分别收口在 `js/features/camera/camera-control-node.js`、`css/components/nodes.css` 与 `css/themes.css`；不要把浅色专属规则或运行态逻辑散回模板层。
- `CameraControl` 第三人称预览有两套相机：受控相机用于生成/提示词参数，观察相机只用于编辑器观察。切换模式、重置视角或渲染前要同步辅助摄像机显隐、`CameraHelper` 和摄像机模型，并在更新受控相机姿态后调用 `updateMatrixWorld(true)`，避免首帧摄像机缺失、辅助物残留或 helper 旋转读旧矩阵。
- `CameraControl` 编辑器遮罩关闭要区分真实空白点击和控件交互副作用。提示词 textarea 原生 resize 后的 mouseup/click 可能落在 overlay 上，只应拦截同一次 resize 产生的下一次 overlay click；不要用固定时间窗口，否则用户快速调整高度后会无法立刻点空白关闭。
- `ImageSave` 如果要处理 `ImageGenerate` 的多图结果，运行态图片列表累积与对保存节点的专门输入分发放 `js/features/execution/execution-core.js` / `js/features/execution/workflow-runner.js`，节点内预览切换、当前图全屏和批量保存交互放 `js/features/media/media-controller.js`；不要在 `js/nodes/types/image-save.js` 或模板层直接拼运行态逻辑。
- 固定结构节点不要只在“开始拖拽缩放”时记录一次最小尺寸。只要节点宽度变化会影响内部换行、滑块占位或文本框可见高度，就要在缩放过程中重新读取共享测量值，避免缩小后出现滑块和文本、文本和文本框互相压住的回归。
- 节点内部 spacing 也是共享体验的一部分：标签到控件、控件到控件、最后一组控件到结果区之间的留白需要一致；不要通过给某个字段单独补 margin 的方式修局部问题。
- 新增 3D 预览区、媒体舞台或其他 media-like 容器时，先确认它们参与节点最小尺寸测量链，再决定节点默认高度和最小高度；不要只在 CSS 里写一个固定高度然后指望共享缩放逻辑自动兼容。
- 节点里若需要“下拉开着继续缩放画布”的体验，不要继续指望浏览器原生 `select` 弹层；优先改成节点内部的自定义下拉 DOM（trigger + panel），原生 `select` 只保留为隐藏值源或兼容层。相关绑定在 `js/nodes/node-dom-bindings.js`，样式收口在 `css/legacy.css` / `css/themes.css`。
- 节点内自定义下拉的滚轮必须优先滚动下拉面板本身，而不是触发画布缩放；面板应拦截 `wheel` 并设置 `overscroll-behavior: contain`，避免滚动链传给外层画布。
- 画布滚轮缩放“停下来后再变清晰”的体验由多处共同决定：滚轮结束延迟主要在 `js/canvas/canvas-interactions.js`，节点文字强制重绘在 `js/canvas/viewport.js` 的 `refreshNodeTextRendering()`，工具栏按钮缩放的收尾在 `js/features/ui/toolbar-controller.js`。要统一缩放手感时，这三处要一起看。
- 优化缩放性能时，优先先调结束延迟、缩放曲线或文字重绘范围；不要轻易把 `viewport.js` 的视口更新和 `connections.js` 的 `updateAllConnections()` 拆开。现有连线渲染、初始化和工作流恢复流程依赖这条同步链路，拆错很容易造成已有连线不显示。
- 自动整理节点只属于 `js/canvas/node-auto-layout.js`：算法可在内部做连通组件拆分、拓扑分层、重心排序、按依赖中心线松弛和无连线节点网格排列，但不应修改节点结构、端口结构或连线契约。排序时要考虑连接端口的上下顺序：例如 `A -> B.input_1`、`C -> B.input_2` 时，若 `input_1` 在 `input_2` 上方，A 应排在 C 上方；同一上游节点多个输出口连接到不同下游节点时，也尽量按输出口顺序传递给下游排序。端口顺序优先从节点 DOM 的 `.node-port[data-direction]` 读取，动态端口也要自然生效。
- `ImageGenerate` 当前节点内结果区是纯进度读数，只显示 `xx/xx`，不再显示节点内图片预览；运行态进度数字由 `js/features/execution/execution-core.js` 更新，生成图片数据仍保留给下游节点、历史记录和持久化链路使用。若后续再把节点内图片预览加回来，需要同步复查 `node-view-factory.js`、`node-dom-bindings.js`、`execution-core.js` 与媒体 helper 是否仍匹配。
- ImageCompare 高级模式继续沿用图片类节点分层：入口按钮和节点内结构放 `js/nodes/node-view-factory.js`；全屏高级对比界面、A/B 选择状态、从当前输入/画布图片节点/历史记录汇总图片、鼠标位置切割、滚轮缩放、左键平移和缩略图选择区展开放 `js/features/media/media-controller.js`；历史图片读取通过 `index.js` 注入 `getHistory`，来源在 `js/services/storage-idb.js`；样式集中在 `css/components/nodes.css`。高级模式选图显示可用缩略图，但设置 A/B 必须使用原图数据。
- 节点或卡片里新增按钮时，除了交互功能本身，还要检查对齐、留白和与邻近文字/端口/控件的距离；优先让按钮留在所属容器的正常布局流里，避免被全局 `.preview-controls`、绝对定位或通用按钮样式挤到不合理的位置。
- 历史记录面板显示可以使用 `item.thumb` 缩略图，但列表/全屏渲染必须优先走 `js/services/storage-idb.js` 的 `getHistoryMetadata` / `getHistoryCount`，不要用 `getHistory()` 一次性读取所有原图。需要原图时再通过 `getHistoryEntry(id)` 按需读取，典型场景包括预览、下载、拖拽导入和高级图片对比。
- 历史原图存储分层在 `js/services/storage-idb.js`：新记录把原图放进 `STORE_ASSETS`，键名前缀为 `history:`，历史表只保留元数据、缩略图和 `imageAssetKey`；旧记录如果还内联 `image`，只做后台逐条迁移。清理节点资产时必须保留 `history:` 前缀资产，清空历史记录时才同时删除这些历史原图资产。
- 历史拖拽源在 `js/features/history/history-panel.js` 和 `js/features/history/history-fullscreen.js`，画布 drop 与现有 ImageImport 节点更新在 `js/features/ui/global-interactions.js`，直接写入 data URL 的能力放 `js/features/media/media-controller.js`。当卡片只有元数据/缩略图时，可通过 `state.draggedHistoryImage.imagePromise` 延迟取原图；绝不能从卡片 `<img src>` 导入。
- 超大量历史记录 UI 必须窗口化：侧栏保持有限条目，缺失缩略图在空闲时间补齐；全屏历史由 `history-fullscreen.js` 做虚拟滚动，只渲染视口附近卡片；预览由 `history-preview.js` 先显示缩略图/加载态，再异步解码原图和读取分辨率，避免 200+ 图片后闪屏、卡顿或黑屏。
- 提示词库是独立功能域：全屏管理、预设卡片、多选删除、复制、JSON 导入/导出、导入文件校验和导入选择窗口放 `js/features/prompts/prompt-library.js`；左侧栏入口和面板骨架放 `index.html`；总装配只在 `index.js` 注入依赖并初始化。提示词预设当前使用 `localStorage` 键 `cainflow_prompt_library`，不是工作流文件、后端文件或 IndexedDB。导出 JSON 使用 `type: "cainflow-prompt-library"`、`version`、`prompts`；导入必须先校验格式，确认规范后再默认全选并允许用户选择导入项。导入画布时创建正式 `Text` 节点，位置查找应避免与现有节点重叠。
- 全局动画开关以 `globalAnimationEnabled` 为准，旧的 `connectionFlowAnimationEnabled` 只做兼容读写。应用根节点类名与兼容字段同步放 `js/features/ui/animation-controller.js`；具体动画执行点仍在各自模块中读取全局状态或依赖 CSS 禁用规则。
- 持久化逻辑放 `js/features/persistence/`，不要散落在各 feature 中。
- Workflow JSON 是画布文件，不是 API 配置快照：保存、导出和 `workflows/Default.json` 只包含 `canvas`、`nodes`、`connections`、`version`，节点通过 `apiConfigId` 保存所选模型 ID。默认供应商/默认模型只维护在 `js/core/constants.js`。导入旧 workflow 时可读取旧 `models/providers` 作为匹配线索，但不得把它们合并进当前 API 设置；缺失模型或供应商引用由 `js/features/persistence/workflow-model-resolver.js` 提示。
- 后端按 route 与 service 分责，不要混写。
- 版本号升级必须以 `js/core/constants.js` 的 `APP_VERSION_NUMBER` 为唯一来源：页面展示、静态资源缓存参数、后端启动提示、代理 User-Agent 与版本同步脚本都应从这条链路派生；不要再引入 `package.json`、`css/base/variables.css` 这类第二份版本号。若当前任务显式要求更新 skill 文档，也要同步改 `.agent/skills/cainflow-project/SKILL.md` 与本架构图中的版本标记和经验说明。
- 优先使用分层后的 `css/` 目录，不要继续扩张 `index.css` 或 `css/legacy.css`。设置面板专属新增样式放 `css/features/settings.css`，只在 `index.css` 中接入入口。
- 主题相关改动优先落在 `css/themes/*` 与 `js/features/ui/theme-controller.js`。如果主题变更影响面板、节点、弹窗、菜单或预览区的视觉，必须同步补对应主题文件里的覆盖，而不是只改基础样式后假设所有区域都会自动正确继承。
- 保留当前启动流程中已经对外暴露的兼容钩子。
