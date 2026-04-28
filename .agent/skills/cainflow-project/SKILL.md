---
name: cainflow-project
description: CainFlow 项目整体架构与代码定位 Skill。用于新增功能、重构功能、修复问题或定位代码时，帮助 AI 按当前项目架构选择正确的前端、后端与样式模块，避免继续把逻辑堆进入口文件，并快速找到工作流、提示词库、设置、历史记录、日志、节点、画布、执行引擎、媒体处理、持久化和静态资源相关代码。
---

# CainFlow 模块化开发

在开始修改 CainFlow 代码前，优先使用这个 skill 作为项目导航图。

当你需要快速判断"代码应该放哪里"或"应该先看哪些文件"时，打开 `references/architecture-map.md`。

## 使用流程

1. 在动手前先给需求分类。
   - 页面骨架或静态结构 -> `index.html`
   - 前端总装配、跨模块编排 -> `index.js`
   - 入口引导 -> `js/main.js`
   - 应用启动初始化流程 -> `js/features/app/startup-controller.js`
   - 可复用的前端状态、常量、DOM 引用、通用工具 -> `js/core/*`
   - API、存储、服务通信 -> `js/services/*`
   - 画布数学、框选、缩放、拖拽、连线 -> `js/canvas/*`
   - 节点图执行、调度、API 请求拼装 -> `js/features/execution/*`
   - 媒体处理、图片合成、格式转换 -> `js/features/media/*`
   - 工作流/项目文件导入导出、会话自动保存 -> `js/features/persistence/*`
   - 某个功能面板的行为 -> `js/features/<feature>/*`
   - 节点定义或序列化 -> `js/nodes/*`
   - 后端路由分发 -> `backend/routes/*`
   - 后端业务逻辑 -> `backend/services/*`
   - 服务启动、运行时配置 -> `backend/main.py`、`backend/config.py`、`server.py`
   - 请求处理总入口 -> `backend/handler.py`
   - 样式 -> `css/base/*`、`css/layout/*`、`css/components/*`、`css/features/*`、`css/themes.css`

2. 优先扩展已有模块，不要继续增肥入口文件。
   - `index.js` 负责组合、编排和兼容性桥接。
   - `js/main.js` 尽量保持很小，目前只负责引导 `index.js`。
   - `index.css` 作为样式入口即可，实际规则优先放入分层后的 `css/` 子目录。
   - 不要把新的业务逻辑直接堆到 `index.html`。

3. 保持模块边界清晰。
   - 某个功能专属的 UI 逻辑，放到 `js/features/<feature>/`。
   - 多个功能共用的基础能力，放到 `js/core/`、`js/services/` 或 `js/canvas/`。
   - 执行引擎相关逻辑集中在 `js/features/execution/`，不要混入 UI 控制器。
   - 供应商协议、模型能力、请求路径、请求体与图片分辨率预设集中在 `js/features/execution/provider-request-utils.js`。
   - 媒体/图片处理集中在 `js/features/media/`，不要散落进节点文件。
   - 工作流文件 I/O 和会话持久化集中在 `js/features/persistence/`。
   - 节点类型专属逻辑，放到 `js/nodes/types/*.js`；节点 DOM 绑定放到 `js/nodes/node-dom-bindings.js`。
   - 后端的 HTTP 解析放在 routes，真正的逻辑放在 services。

4. 修改前先做小范围检索。
   - 用 `Get-ChildItem js backend css -Recurse -File` 浏览模块树。
   - 用关键词 grep 找真正的责任文件（见 `references/architecture-map.md` 中的检索命令）。
   - 追踪模块边界时，用 `grep -r "^export " js --include="*.js"`。
   - 只读"拥有该行为的文件"和它的直接调用方，不要一上来全量扫仓库。

5. 在最小责任模块中改动。
   - 如果只影响一个功能面板，就只改那个 feature 目录。
   - 如果多个功能都要用同一能力，再上提成共享模块。
   - 如果现有模块已经清晰承载这类职责，就继续放在现有模块里；只有当职责边界已经不清晰、形成新的功能域，或会明显增加耦合时，再新建 `js/features/<name>/` 或新的共享模块。

6. 按改动边界做验证。
   - 前端语法：`node --check index.js`
   - 全量前端检查：`Get-ChildItem js -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`
   - 后端语法：`python -m py_compile backend\\main.py backend\\handler.py backend\\routes\\*.py backend\\services\\*.py`
   - 运行验证：启动 `python server.py`，再在浏览器里验证受影响流程。

7. 每次调试结束后做收尾清理。
   - 如果本轮为了验证启动了 `python server.py` 或等价的 CainFlow 本地 server 进程，结束前必须关闭该进程，并确认 `127.0.0.1:8767` 不再监听。
   - 只关闭本轮由 AI 创建或能确认属于 CainFlow 调试服务的进程；不要误关用户已有的其他 Python / pythonw 进程。
   - 删除项目目录中本轮调试产生且不需要保留的临时缓存文件，例如 `.codex-server.out`、`.codex-server.err`、`__pycache__/`、`.pytest_cache/` 等；删除前确认路径位于当前仓库内。
   - 不要删除用户工作文件、导出的工作流、历史记录、图片资产、配置文件或任何无法确认来源的文件。

## 代码落点规则

- 新节点类型放到 `js/nodes/types/`，并通过 `js/nodes/registry.js` 注册；视图模板放 `js/nodes/node-view-factory.js`；DOM 事件绑定放 `js/nodes/node-dom-bindings.js`。
- 文本节点当前统一为 `Text`：正式定义在 `js/nodes/types/text.js`，右键菜单使用 `data-type="Text"`，注册表只注册 `Text`。`text-input.js` 与 `text-display.js` 仅作为旧缓存/旧工作流兼容 shim 保留，不要重新注册成菜单节点。
- 文本节点有 1 个文本输入口和 1 个文本输出口。执行时在 `js/features/execution/execution-core.js` 只负责把上游输入写入文本框、同步 `node.data.text` 并刷新连线输出；不要在运行 handler 中调用 `requestNodeFit` / `fitNodeToContent`，运行后不应自动改变节点尺寸。
- 文本节点编辑行为放 `js/nodes/node-dom-bindings.js`：输入/change 只同步数据与触发保存，不要因为点击编辑或输入文字自动调整节点大小。文本节点尺寸测量、旧类型映射和内容测量兜底放 `js/nodes/node-lifecycle.js`；样式当前在 `css/legacy.css` 的 Text 节点区，迁移前不要分散到其他样式文件。
- 图片类展示/处理节点（预览、缩放、保存、对比等）除节点定义外，还要同步检查 `js/features/media/media-controller.js` 的运行态图片同步、级联刷新和节点内交互；需要参与工作流执行或向下游输出图片时，检查 `js/features/execution/execution-core.js` 的节点 handler 与 `getCachedOutputValue`。
- 新增右键菜单中的静态节点入口时只改 `index.html` 的菜单项；真正的创建逻辑仍依赖 `js/features/ui/context-menu-controller.js` 读取 `data-type`，不要把节点创建逻辑写进 `index.html`。
- 工作流持久化、工作流列表操作，优先落到 `js/services/workflow-api.js` 以及后端 workflow 的 route/service 模块。
- 工作流/项目文件导入导出 -> `js/features/persistence/project-io.js`；自动保存/会话恢复 -> `js/features/persistence/session-manager.js`。
- 设置面板 UI 行为放到 `js/features/settings/settings-modal.js`；数据逻辑、代理检测、版本检查、画布连线设置以及全局动画开关放到 `js/features/settings/settings-controller.js`；后端放 settings/security 相关模块。
- 历史记录面板行为放 `js/features/history/`。从历史记录拖拽图片到画布时，`history-panel.js` 应显式携带 `item.image` 原图数据，`global-interactions.js` 负责 drop 到画布或现有 ImageImport 节点，`media-controller.js` 负责直接写入 data URL；不要依赖历史卡片 `<img src="item.thumb">`，避免导入缩略图。
- 提示词库面板行为放 `js/features/prompts/prompt-library.js`。左侧栏按钮和全屏管理面板骨架放 `index.html`，入口装配放 `index.js`，面板深色/通用样式放 `css/features/panels.css`，浅色主题覆盖放 `css/themes.css`。提示词预设当前使用浏览器 `localStorage` 键 `cainflow_prompt_library` 持久化；导入/导出使用 `type: "cainflow-prompt-library"`、`version`、`prompts` 的 JSON 文件结构。导入前必须校验 JSON 与预设字段，校验通过后再让用户选择导入项；导入画布时创建 `Text` 节点并查找不与现有节点重叠的位置。
- 日志面板行为放 `js/features/logs/log-panel.js`；服务端日志放 `backend/services/log_service.py`。
- 执行引擎逻辑（调度、节点遍历、API 请求）放 `js/features/execution/`，不要混入 UI 控制器。
- OpenAI 兼容生图逻辑按职责拆分：协议/URL/请求体/分辨率预设放 `js/features/execution/provider-request-utils.js`；执行时读取节点输入、选择 JSON 或 multipart、发起 `/proxy` 请求放 `js/features/execution/execution-core.js`；代理错误归类与用户提示放 `js/services/api-client.js`。
- OpenAI 兼容生图有参考图输入时，请求路径应自动走 `/v1/images/edits`；无参考图时走 `/v1/images/generations`。`/images/edits` 需要 `multipart/form-data`，参考图应作为文件字段上传，不要继续用 JSON 传参考图。
- 生图节点的模型相关 UI（模型切换后分辨率菜单、OpenAI 自定义分辨率输入框显隐）放 `js/nodes/node-view-factory.js` 和 `js/nodes/node-dom-bindings.js`；保存/复制新增字段时同步更新 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`。
- 生图节点的生成次数字段使用 `generationCount`；控件模板放 `js/nodes/node-view-factory.js`，最小值归一化与 +/- 事件放 `js/nodes/node-dom-bindings.js`，保存/复制同步更新 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`，执行时的成功次数循环放 `js/features/execution/execution-core.js`。失败不计入次数；自动重试时已成功次数通过运行时字段 `generationCompletedCount` 保留，只补剩余次数。
- OpenAI 兼容生图分辨率下拉由 `provider-request-utils.js` 中的选项驱动。当前保留“自动”（空值，不发送 `size`）、`1024x1024`、`2048x2048`、`custom`；自定义分辨率 UI 使用“宽度输入框 x 高度输入框”，执行时拼成 `宽x高` 作为 `size`。
- 媒体处理（图片合成、Blob 转换、格式处理）放 `js/features/media/`。
- 图片对比这类交互式媒体节点：端口和默认尺寸放 `js/nodes/types/image-*.js`；节点内容模板和高级模式入口按钮放 `js/nodes/node-view-factory.js`；鼠标交互入口放 `js/nodes/node-dom-bindings.js` 并委托到 `js/features/media/media-controller.js`；执行输出与下游刷新放 `js/features/execution/execution-core.js`；节点样式放 `css/components/nodes.css`。
- 图片对比高级模式属于媒体控制器职责：全屏对比界面、A/B 选择、历史记录图片汇总、缩略图选择区展开、鼠标切割对比、滚轮缩放与左键平移放 `js/features/media/media-controller.js`；相关全屏布局、互斥 A/B 裁切、缩略图网格和按钮样式放 `css/components/nodes.css`。历史图片缩略图可用 `item.thumb` 展示，但设置 A/B 对比时必须使用 `item.image` 原图。
- 画布几何、连线、框选、缩放、视口相关逻辑放到 `js/canvas/*`。
- 节点自动整理/自动布局这类只改变画布节点坐标的能力放到 `js/canvas/node-auto-layout.js`；入口装配仍在 `index.js`，按钮绑定放 `js/features/ui/toolbar-controller.js`，左侧栏静态按钮放 `index.html`，样式优先收敛到侧栏所属样式区域。
- 连线类型、全局动画开关、连线可见性之类的画布/全局表现设置，状态默认值放 `js/core/state.js`，设置面板交互放 `js/features/settings/settings-controller.js`，配置导入导出/会话持久化同步更新 `js/features/ui/ui-controller.js`、`js/features/persistence/project-io.js`、`js/nodes/node-serializer.js`。
- 全局动画开关使用 `globalAnimationEnabled` 作为正式状态；`connectionFlowAnimationEnabled` 只作为旧配置兼容字段。根节点 CSS 类与旧字段对齐放 `js/features/ui/animation-controller.js`，连线 RAF 流动箭头在 `js/canvas/connections.js` 读取全局状态，CSS animation/transition 兜底禁用规则放现有样式层（当前在 `css/legacy.css`）。
- 版本号升级需要同步 `package.json`、`js/core/constants.js`、`index.html` 展示与静态资源缓存参数、`css/base/variables.css`、`backend/main.py` 启动提示、`backend/services/proxy_service.py` User-Agent，以及 README 当前版本说明。
- 连线路径形状、直角圆角折线、剪线采样等几何能力优先收敛到 `js/canvas/geometry.js`，不要把几何计算散落回交互控制器。
- 不要为了“新功能”机械地新建文件；先判断现有文件是否本来就负责这类行为，只有在继续塞进去会让模块职责变模糊时再拆分。
- 多功能共享的常量放到 `js/core/constants.js`；通用纯函数放 `js/core/common-utils.js`。
- 只有在多个模块都需要时，才把 DOM 查找能力放到 `js/core/elements.js`。
- 主题切换逻辑放 `js/features/ui/theme-controller.js`，样式放 `css/themes.css`。
- 新样式放到对应 feature 或对应层级目录；`css/legacy.css` 只用于兼容性或暂时未拆解的遗留样式。

## 高风险改动前先停一下

遇到下面这些情况，先重新判断影响范围，再继续：

- 修改 `index.html` 或 `index.js` 正在使用的 DOM id / class
- 在仍有 `window` 兼容暴露依赖时，把逻辑从 `index.js` 中强行迁出
- 修改 `js/nodes/node-serializer.js` 的工作流序列化结构
- 修改文本节点的输入/输出、旧 TextInput/TextDisplay 兼容、运行后尺寸策略或编辑时尺寸策略
- 修改 ImageGenerate 的请求协议、OpenAI 兼容路径、multipart 表单字段或分辨率字段序列化
- 修改 ImageGenerate 的多次生成、成功次数计数或自动重试衔接逻辑
- 修改 `backend/routes/*` 或 `backend/services/*` 的请求/响应契约
- 本应放入分层样式目录，却继续把内容堆进 `css/legacy.css`
- 修改 `js/features/execution/execution-core.js` 的节点遍历或结果分发逻辑

## 参考文件用途

需要以下信息时，打开 `references/architecture-map.md`：

- 目录职责划分（含全部已有文件）
- 常见需求对应文件位置
- 常用检索命令
- 本仓库的模块化开发约束
