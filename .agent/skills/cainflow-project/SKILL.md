---
name: cainflow-project
description: CainFlow 项目整体架构与代码定位 Skill。用于新增功能、重构功能、修复问题或定位代码时，帮助 AI 按当前项目架构选择正确的前端、后端与样式模块，避免继续把逻辑堆进入口文件，并快速找到工作流、提示词库、设置、在线更新、历史记录、日志、节点、画布、执行引擎、媒体处理、持久化和静态资源相关代码。
---

# CainFlow 模块化开发

在开始修改 CainFlow 代码前，优先使用这个 skill 作为项目导航图。

> 当前适配版本：v2.8.1

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
   - 版本更新检查、更新通知与直接下载更新 -> `js/features/update/update-manager.js`、`js/features/settings/settings-controller.js`、`backend/routes/update_routes.py`、`backend/services/update_service.py`、`backend/config.py`
   - 节点定义或序列化 -> `js/nodes/*`
   - 后端路由分发 -> `backend/routes/*`
   - 后端业务逻辑 -> `backend/services/*`
   - 服务启动、运行时配置 -> `start_cainflow.bat`、`backend/main.py`、`backend/config.py`、`server.py`
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
   - 供应商协议、模型能力、模型用途/协议推断、请求路径、请求体与图片分辨率预设集中在 `js/features/execution/provider-request-utils.js`。
   - 媒体/图片处理集中在 `js/features/media/`，不要散落进节点文件。
   - 工作流文件 I/O、工作流模型引用解析和会话持久化集中在 `js/features/persistence/`。
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

## 错误提示中文化

- 面向用户的错误提示优先给出中文结论，不直接把后端英文原文、代理层原始报错或第三方接口原文直接透出。
- 与代理、白名单、SSRF 拦截相关的提示统一收口到 `js/services/api-client.js`，优先复用 `classifyProviderError` / `formatProxyErrorMessage`，不要在每个调用点各自拼接一套文案。
- 像 `Target URL is not allowed` 这类安全拦截，除了说明“目标地址不被允许”，还要明确告诉用户去“设置 > 通用设置 > 安全”关闭过滤或调整允许列表，避免用户只看到拦截结果却不知道下一步怎么处理。
- 其他会复用代理能力的功能，例如更新检查 `js/features/update/update-manager.js`，应直接走同一套错误格式化逻辑，保证提示口径一致。
- 只有在保留原始错误码对排查有帮助时，才把 HTTP 状态码或简短技术细节附在中文主提示后面；主语义仍应先让普通用户看懂。

## 设置页视觉规范

- 通用设置（General Settings）继续收口在 `js/features/settings/settings-controller.js` 与 `css/features/settings.css`，不要把布局和样式细节散回 `index.html` 或 `css/legacy.css`。
- 卡片布局优先使用统一响应式 grid，例如 `general-settings-grid` / `general-settings-card`；避免在模板里继续堆内联样式、重复 `flex` 包裹或制造大块无意义留白。
- 设置卡片里的字号、行高、控件高度和说明文字要以“清晰可读、不拥挤、不压缩”为准；新增内容时先检查窄宽度下是否换行正常、是否遮挡、是否被状态标签挤压。
- 新增按钮、图标按钮或按钮组时，必须同时检查它与周围文字、端口、标签、输入框和其他控件的距离是否充足；默认保持清晰留白，不要让按钮贴着相邻元素，也不要让按钮因为复用全局样式而挤进不属于它的位置。
- API 设置页里的新手引导入口属于设置面板上下文帮助：入口骨架放 `index.html` 的 API 供应商标题区域，弹窗创建、打开、关闭和文案放 `js/features/settings/settings-controller.js`，样式放 `css/features/settings.css`。不要混入全局操作帮助面板 `js/features/help/help-panel.js`，也不要把弹窗样式塞回 `css/legacy.css`。
- 所有二元开关统一使用现代滑动开关样式 `toggle-switch` / `toggle-slider`，不要在设置页混用原生 checkbox 外观；只有多选列表这类非二元语义才继续使用 checkbox。
- 安全类能力开关要有独立卡片承载，语义说明要直白，避免把高风险选项埋进供应商配置或其他杂项区域。
- 新增“危险能力”设置项时，不只改界面显示；还要同步检查 `js/core/state.js`、`js/features/ui/ui-controller.js`、`js/features/persistence/project-io.js`、`js/nodes/node-serializer.js` 等持久化链路，保证刷新、导入导出和会话恢复后一致。

## 代码落点规则

- 新节点类型放到 `js/nodes/types/`，并通过 `js/nodes/registry.js` 注册；视图模板放 `js/nodes/node-view-factory.js`；DOM 事件绑定放 `js/nodes/node-dom-bindings.js`。
- 节点端口布局当前由 `js/nodes/node-view-factory.js` 与 `css/legacy.css` 共同维护：输入/输出端口放在同一个顶部端口行 `.node-ports-row`，左右两列从同一条顶部水平线开始对齐。仅调整端口显示位置时优先改模板和样式，不要误改 `js/canvas/connections.js` 的端口取点逻辑。
- 文本节点当前分为 `Text` 与 `TextSplit`：`Text` 正式定义在 `js/nodes/types/text.js`，`TextSplit` 定义在 `js/nodes/types/text-split.js`。右键菜单分别使用 `data-type="Text"`、`data-type="TextSplit"`；`text-input.js` 与 `text-display.js` 仅作为旧缓存/旧工作流兼容 shim 保留，不要重新注册成菜单节点。
- `Text` 节点有 1 个文本输入口和 1 个文本输出口。执行时在 `js/features/execution/execution-core.js` 只负责把上游输入写入文本框、同步 `node.data.text` 并刷新连线输出；不要在运行 handler 中调用 `requestNodeFit` / `fitNodeToContent`，运行后不应自动改变节点尺寸。
- `TextSplit` 节点有 1 个文本输入口，不再提供节点内部长文本输入框；输入文本来自上游连接或旧工作流恢复数据，输出口数量由分割结果动态决定。端口模板、节点内预览与动态重建放 `js/nodes/node-view-factory.js`、`js/nodes/node-dom-bindings.js`，执行输出分发与动态端口取值放 `js/features/execution/execution-core.js`，保存/复制时同步 `delimiter`、`removeEmptyLines`、`previewEnabled`、`parts` 等字段到 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`。开启节点内预览后，预览区应在节点内部 flex/滚动展示，不得把完整预览内容计入节点最小高度或阻止用户手动缩小节点。
- 文本类节点（`Text` / `TextSplit`）编辑行为放 `js/nodes/node-dom-bindings.js`：输入/change 只同步数据与触发保存，不要因为点击编辑、输入文字、textarea ResizeObserver 或快速拖拽右下角缩放而自动 shrink。文本节点尺寸测量、旧类型映射和内容测量兜底放 `js/nodes/node-lifecycle.js`；样式当前在 `css/legacy.css` 的 Text 节点区，迁移前不要分散到其他样式文件。可输入文本框的手动高度缓存使用 `textareaHeights`，序列化/复制放 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`，恢复内联高度放 `js/nodes/node-view-factory.js`，`ResizeObserver` 只负责记录高度并触发保存，不得借此触发 shrink fit。
- `TextChat` 回复框结构由 `js/nodes/node-view-factory.js` 与 `css/legacy.css` 维护：复制按钮是小按钮，放在回复文本框内部左上角；回复内容在框内滚动展示，不得强制完整撑开节点。回复内容和 TextSplit 预览这类可滚动结果区的最小高度测量放 `js/nodes/node-lifecycle.js` / `js/nodes/node-dom-bindings.js`，测量时应忽略实际长内容高度，只保留可用的最小容器尺寸。
- 节点里的模型/供应商/分辨率这类下拉，在画布可缩放场景下不要继续依赖原生 `select` 弹层做复杂交互；当用户需要“开着下拉继续缩放画布”时，优先改成节点内部的自定义下拉 DOM（trigger + panel），原生 `select` 退到隐藏同步值层。具体交互绑定放 `js/nodes/node-dom-bindings.js`，结构仍由 `js/nodes/node-view-factory.js` 输出，样式收口在 `css/legacy.css` / `css/themes.css`。
- 节点内自定义下拉的滚轮事件要优先消费面板自己的滚动，不要冒泡成画布缩放；下拉面板应显式拦截 `wheel`，并用 `overscroll-behavior: contain` 防止滚到边缘后把滚动链传给画布。
- ImageGenerate 等带可扩展 textarea 的节点，尺寸联动入口也在 `js/nodes/node-dom-bindings.js`：只允许真实的元素尺寸变化触发 `fitNodeToContent`；点击、聚焦、`mouseup`、`touchend` 不得触发 shrink fit，避免点提示词框后节点自动变小。节点最小尺寸测量与最终应用仍放 `js/nodes/node-lifecycle.js`。
- 节点尺寸显示不全兜底放 `js/nodes/node-lifecycle.js`：刷新恢复、异步图片恢复和图片 load 后应校正非文本框内容所需尺寸；不要把长 textarea 内容纳入通用自动撑高策略。
- 节点 resize 的底线是“内容不能被裁切，控件不能重叠”。用户拖拽右下角缩小节点时，`js/canvas/canvas-interactions.js` 必须通过 `getNodeMinimumSize(node, { width })` 按当前目标宽度动态测量最小尺寸；松手时还要再按最终宽度校正一次，不能只相信拖拽开始时记录的 `minWidth` / `minHeight`。
- 节点最小尺寸测量统一收口在 `js/nodes/node-lifecycle.js`。测量时不能只靠手写递归估算 DOM 子元素高度；要结合浏览器真实布局的 `offsetHeight` / `scrollHeight` 做高度兜底，尤其是窄宽度换行、grid/flex 重排、预览区、按钮组、原生控件和文本框。
- `index.js` 作为模块装配层给 `canvas-interactions.js` 注入 `getNodeMinimumSize` 时，必须透传第二个参数 `options`。如果丢掉 `{ width }`，缩放期动态测量会退化，容易重新出现缩小节点后元素裁切或重叠。
- 节点内容最小高度优先级高于 `maxHeight`。如果某个节点配置的 `maxHeight` 小于当前真实内容最小高度，resize 逻辑不能继续用这个上限硬压节点，否则会把内容裁掉；应让内容可见性优先。
- 新增或修改节点内部固定 UI 块时，要把该块纳入共享测量链：可视媒体区加入 media-like 测量选择器，滚动结果区使用稳定 `minHeight`，长内容区域只测容器可用高度，不按完整文本撑开。不要用局部 CSS `overflow: hidden` 或临时增大默认高度掩盖测量缺口。
- `ImageSave` 这类固定结构、非长内容型节点（警告文案、预览区、输入框、按钮）创建后不应默认出现节点内纵向滚动条；如果一创建就出现右侧滚动条，优先判断为 `js/nodes/types/image-save.js` 等节点定义里的 `defaultHeight` 偏小，而不是把滚动当成正常状态。后续若增减这类节点的固定 UI 块，也要同步复查默认高度与 `js/nodes/node-lifecycle.js` 的最小尺寸测量是否仍匹配。
- `ImageSave` 如果上游是 `ImageGenerate` 且本轮生成了多张图，保存节点不能只保留最后一张。多图结果的累积与对 `ImageSave` 的专门结果分发放 `js/features/execution/execution-core.js` / `js/features/execution/workflow-runner.js`，节点内多图预览切换、当前预览图全屏、手动/自动批量保存与编号文件名放 `js/features/media/media-controller.js`；节点静态结构仍由 `js/nodes/node-view-factory.js` 输出，样式收口在 `css/legacy.css`。
- `CameraControl` 这类“预览区 + 多组滑块 + 文本框”的固定结构工具节点，最小尺寸、内容显示兜底和共享测量规则统一收口在 `js/nodes/node-lifecycle.js`；不要在节点私有逻辑里临时拼一套 shrink/resize 规则来兜裁剪或重叠。
- 固定结构节点在用户拖拽缩放时，如果宽度变窄会导致文本换行、原生滑块占位变化或文本框所需高度上升，不能只使用“开始缩放时记录一次”的最小尺寸；要在 `js/canvas/canvas-interactions.js` 的缩放过程中结合 `js/nodes/node-lifecycle.js` 的共享测量结果动态重算最小高度，避免缩小后出现控件重叠。
- 节点内部的纵向节奏要统一：标题与控件、控件与控件、控件组与结果区之间的上下间距保持一致。不要只给某个字段单独塞一个看起来“差不多”的 margin，导致像提示词文本与上方滑块这类局部距离失衡。
- 固定结构节点里如果同时存在浏览器原生控件（例如 `input[type="range"]`）、预览区和文本框，优先给这些块稳定的布局约束与显式 `minHeight`，必要时直接在节点类型定义（如 `js/nodes/types/camera-control.js`）提高 `defaultHeight` / `minHeight`，不要允许用户缩到注定会重叠的尺寸。
- 新增类似 3D 预览区、媒体舞台、结果画布这类可视区域时，要确认它能被共享的节点尺寸测量链识别；如果它本质上属于可缩放媒体区，就要像其他 media-like 容器一样接入 `js/nodes/node-lifecycle.js` 的内容测量，而不是只靠 CSS 高度硬撑。
- `CameraControl` 的责任链固定为：节点定义 `js/nodes/types/camera-control.js`，模板 `js/nodes/node-view-factory.js`，DOM 绑定 `js/nodes/node-dom-bindings.js`，3D 预览与摄影提示词映射 `js/features/camera/camera-control-node.js`，共享尺寸/内容显示兜底 `js/nodes/node-lifecycle.js`，缩放期最小尺寸约束 `js/canvas/canvas-interactions.js`，样式 `css/components/nodes.css`。
- `CameraControl` 的编辑器只是一层临时交互壳：点“编辑视角”时才显示 3D 界面，关闭后要把缩略图和参数留在 `node.data` 里，`generation` 式的运行重置也不能把 `pitch` / `yaw` / `distance` / `fov` / `roll`、摄影提示词或预览图清掉。
- `CameraControl` 的 3D 预览坐标轴应锚定在世界中心/主体中心参考点，不要再把轴辅助器偏移到角落当屏幕装饰；当前中心参考与 `camera.lookAt(...)`、主体 group 的中心点保持一致，具体逻辑放 `js/features/camera/camera-control-node.js`。
- `CameraControl` 的“重置视角”属于编辑器头部操作区能力，重置后应回到正视视角，并同步相机、滑块、数值输入框和英文摄影提示词；不要只改某一个显示层。
- `CameraControl` 的 `pitch` / `yaw` / `distance` / `fov` / `roll` 除滑块外还支持用户手动输入，输入归一化、范围限制和回填统一走 `js/features/camera/camera-control-node.js` 的共享状态链；样式在 `css/components/nodes.css` 中保持紧凑、统一宽度，并把单位显示在输入框右侧而不是塞进输入框值里。
- `CameraControl` 编辑器的浅色主题适配放 `css/themes.css`，不要把浅色覆盖继续塞回 `css/components/nodes.css`。面板、遮罩、舞台、按钮、输入框、滑块、提示词框和节点内缩略预览都要一起检查，不要只改其中一两块导致明暗对比失衡。
- `CameraControl` 的第一人称/第三人称切换仍然由 `js/features/camera/camera-control-node.js` 统一管理。第一人称渲染受控相机本身；第三人称应使用独立观察相机渲染，并在 3D 世界中显示受控摄像机模型和视锥。第三人称下鼠标左键拖拽、滚轮和右键重置只能调整观察相机，不得改写 `pitch` / `yaw` / `distance` / `fov` / `roll`；受控摄像机位置只由右侧参数控制。
- `CameraControl` 第三人称辅助摄像机、`CameraHelper` 或摄像机模型的显隐切换要在模式切换和每次渲染前同步；修改受控相机姿态后要及时 `updateMatrixWorld(true)` 再更新 helper/模型，避免切换第一帧摄像机不出现、切回第一人称残留蓝色辅助物，或点“重置视角”第一下显示旧旋转。
- `CameraControl` 编辑器关闭遮罩只应响应真实的空白点击。提示词 textarea 右下角原生 resize 时，如果鼠标松开落到旧面板外侧，不应触发“点击空白处关闭窗口”；优先按同一次 resize 产生的 overlay click 做一次性拦截，不要用固定时间窗口保护，避免用户快速 resize 后无法立刻点空白关闭。
- 节点删除、摘取与连接保留逻辑放 `js/nodes/node-lifecycle.js`：Alt 删除保留上下游、拖拽晃动摘取节点后的连接重写都应复用同一套按端口类型匹配、避免自连、避免覆盖已有输入连接的规则；删除按钮事件入口放 `js/nodes/node-dom-bindings.js`。
- 运行态节点锁定语义：`js/features/execution/workflow-runner.js` 维护 `state.runningNodeIds` 与并发运行会话；正在运行的节点不能编辑、移动、缩放、删除、禁用或改连线，但仍允许复制/克隆。右键运行其他未运行节点时不要再用全局 `state.isRunning` 做互斥，只能阻止与当前运行节点重叠的运行范围。
- 节点禁用语义是“本节点没有输出”，不能只是跳过执行。工作流输入收集和提示词预检查必须在 `js/features/execution/workflow-runner.js` 过滤 `enabled === false` 的上游；`js/features/execution/execution-core.js` 的 `getCachedOutputValue` 也要把禁用节点视为 `undefined`，避免 CameraControl、Text、TextSplit、TextChat、ImageImport、ImageResize、ImagePreview、ImageSave/ImageCompare 等缓存输出继续影响下游。
- 启用/禁用节点后要立即刷新画布和依赖预览：入口在 `js/nodes/node-lifecycle.js` 的 `toggleNodesEnabled`，除了改 `node.enabled` 和 `.disabled` class，还应调用 `updateAllConnections()`、`updatePortStyles()` 与 `onConnectionsChanged()`，保证下游图片预览、CameraControl 缩略预览和连线状态马上断流/恢复。
- 图片类展示/处理节点（预览、缩放、保存、对比等）除节点定义外，还要同步检查 `js/features/media/media-controller.js` 的运行态图片同步、级联刷新和节点内交互；需要参与工作流执行或向下游输出图片时，检查 `js/features/execution/execution-core.js` 的节点 handler 与 `getCachedOutputValue`。
- 图片类节点的即时预览链也必须遵守禁用语义：`js/features/media/media-controller.js` 的 `getNodePreviewSourceData` 不能从禁用节点读取 `imageData` / `resizePreviewData` / `data.image`；`refreshDependentImageResizePreviews` 遇到禁用中间节点时应继续向下游级联空输入，避免禁用的图片节点或 CameraControl 上游预览缓存继续影响后面的节点。
- 复用 `js/features/media/media-controller.js` 里的图片预览交互（如 `setupImagePreview`）给其他节点时，先确认该 helper 依赖的 DOM 结构是否完整；像缩放、重置、全屏这类按钮如果不是每个节点都存在，helper 必须做可选判空，不能默认直接 `querySelector(...).addEventListener(...)`，否则会在 `js/nodes/node-dom-bindings.js` 初始化节点时把整个节点创建打断。
- 新增右键菜单中的静态节点入口时只改 `index.html` 的菜单项；真正的创建逻辑仍依赖 `js/features/ui/context-menu-controller.js` 读取 `data-type`，不要把节点创建逻辑写进 `index.html`。
- 工作流持久化、工作流列表操作，优先落到 `js/features/workflow/workflow-manager.js`、`js/services/workflow-api.js` 以及后端 workflow 的 route/service 模块。
- 工作流重命名属于工作流管理职责：列表按钮、右键菜单与前端名称校验统一放 `js/features/workflow/workflow-manager.js`；接口封装放 `js/services/workflow-api.js`；后端冲突/重命名落盘规则放 `backend/routes/workflow_routes.py` 与 `backend/services/workflow_service.py`。如果新增或调整重命名能力，前后端都要同步检查空名、同名、非法文件名字符、目标已存在以及中文/特殊字符编码。
- 工作流 JSON 只存画布、节点、连线、节点选择的模型 ID（`apiConfigId`）和版本号；不要把 `providers` / `models` 写入工作流保存、导出或 `workflows/Default.json`。
- 工作流/项目文件导入导出 -> `js/features/persistence/project-io.js`；旧工作流中模型 ID 与当前设置的自动匹配、缺失模型/供应商提示 -> `js/features/persistence/workflow-model-resolver.js`；自动保存/会话恢复 -> `js/features/persistence/session-manager.js`。
- 设置面板 UI 行为放到 `js/features/settings/settings-modal.js`；数据逻辑、API 供应商与模型管理、供应商卡片“获取模型列表”按钮、模型列表弹窗、API 设置帮助弹窗、搜索与添加模型、代理检测、版本检查、画布连线设置以及全局动画开关放到 `js/features/settings/settings-controller.js`；后端放 settings/security 相关模块。
- 通用设置（General Settings）继续收口在 `js/features/settings/settings-controller.js` + `css/features/settings.css`：卡片布局优先用统一响应式 grid（如 `general-settings-grid` / `general-settings-card`），避免在模板里混用多段 `flex` 和大量内联样式；通用设置的排版、字号放大、卡片留白压缩、按钮/输入高度、目录徽标换行、更新卡片状态区防挤压等都优先落在 `css/features/settings.css`，不要把这些细节散回 `index.html` 或 `css/legacy.css`。
- 设置页里的二元开/关项统一使用可滑动的现代开关 UI：复用 `toggle-switch` / `toggle-slider`，不要在设置面板里混用原生勾选框和另一套 `switch/slider` 标记；只有“多选列表”这类非二元语义（例如模型绑定多个供应商）才继续使用 checkbox。
- 设置页如果新增“是否允许某类危险能力”的显式用户开关，除了状态默认值放 `js/core/state.js`，还要同步更新 `js/nodes/node-serializer.js`、`js/features/persistence/project-io.js`、`js/features/ui/ui-controller.js`，保证项目导入导出和会话恢复后行为一致。
- 默认 API 供应商和默认模型只来自 `js/core/constants.js`。修改默认供应商/模型时不要同步写入 workflow JSON；恢复出厂后加载的默认工作流也应从当前默认状态读取可用模型。
- 历史记录面板行为放 `js/features/history/`。侧边历史列表逻辑放 `history-panel.js`，历史预览放 `history-preview.js`，面向超大量记录的全屏浏览、按天分组和日期定位标尺放 `history-fullscreen.js`，历史卡片渲染与按天分组等通用能力放 `history-utils.js`。历史列表和全屏面板应优先读取 `storage-idb.js` 的轻量元数据（如 `getHistoryMetadata` / `getHistoryCount`），只在预览、拖拽、下载、对比等确实需要原图时按 id 调 `getHistoryEntry` 取原图；不要在列表渲染链路里用 `getHistory()` 一次性搬出所有原图。
- 历史原图存储分层由 `js/services/storage-idb.js` 维护：新历史记录的原图放 `STORE_ASSETS`，键名前缀为 `history:`，`STORE_HISTORY` 只保留元数据、缩略图和 `imageAssetKey`；旧历史记录若仍把 `image` 放在历史表里，应后台逐条迁移，不要启动时同步全量迁移。清理节点图片资产时必须保留 `history:` 前缀资产；清空历史时才同时删除历史元数据和历史原图资产。
- 历史记录拖拽导入必须使用原图。列表项只有元数据/缩略图时，`history-panel.js` / `history-fullscreen.js` 可把按需读取原图的 `imagePromise` 放入 `state.draggedHistoryImage`，`global-interactions.js` 在 drop 时等待原图后再写入画布或现有 ImageImport 节点；不要依赖历史卡片 `<img src="item.thumb">`，避免导入缩略图。
- 超大量历史记录性能规则：侧边栏只展示最近有限条目并按空闲时间补缺失缩略图；全屏历史使用虚拟滚动/窗口化渲染，DOM 中只保留视口附近的卡片；预览弹窗先显示缩略图或加载态，再异步解码原图和读取分辨率，避免打开大图时黑屏或阻塞主线程。相关样式放 `css/features/panels.css` 与必要的历史卡片基础样式处。
- 提示词库面板行为放 `js/features/prompts/prompt-library.js`。左侧栏按钮和全屏管理面板骨架放 `index.html`，入口装配放 `index.js`，面板深色/通用样式放 `css/features/panels.css`，浅色主题覆盖放 `css/themes.css`。提示词预设当前使用浏览器 `localStorage` 键 `cainflow_prompt_library` 持久化；导入/导出使用 `type: "cainflow-prompt-library"`、`version`、`prompts` 的 JSON 文件结构。导入前必须校验 JSON 与预设字段，校验通过后再让用户选择导入项；导入画布时创建 `Text` 节点并查找不与现有节点重叠的位置。
- 日志面板行为放 `js/features/logs/log-panel.js`；服务端日志放 `backend/services/log_service.py`。
- 执行引擎逻辑（调度、节点遍历、API 请求）放 `js/features/execution/`，不要混入 UI 控制器。
- 涉及运行中节点可编辑性、删除、拖拽克隆、连线剪切、自动整理、撤销、清空画布、工作流加载、图片导入等入口时，需要同步检查 `state.runningNodeIds`；新增会修改节点本体或连接关系的入口也必须遵守运行态节点锁。
- 获取供应商模型列表属于设置面板数据逻辑：按钮、弹窗状态、搜索、调用 `/proxy` 拉取 `/models`、把条目添加到 `state.models` 放 `js/features/settings/settings-controller.js`；代理请求头复用 `js/services/api-client.js` 的 `createProxyHeadersGetter`；模型用途/协议归一化同步检查 `js/features/execution/provider-request-utils.js`，特别是 GPT/DALL-E/OpenAI 类模型必须使用 OpenAI 兼容格式，Gemini 使用 Google 格式，banana/imagen/image 类模型应归为生图。
- 后端代理 SSRF/允许域名策略集中在 `backend/services/security_service.py`，请求入口只在 `backend/services/proxy_service.py` 调用 `is_safe_url(...)` 做拦截。默认允许列表除了项目内置供应商外，还要覆盖项目自己明确依赖的官方域名（当前包含 GitHub 更新检查使用的 `api.github.com` / `github.com`），不要让正常内建功能被“误伤式拦截”。
- 服务启动冲突处理同时覆盖源码运行和打包直启：`start_cainflow.bat` 负责源码双击启动时的预检查和黑色窗口停留；`backend/main.py` 负责 `server.py` / 打包 `CainFlow.exe` 进入后端后的端口检查、进程识别和启动失败提示。端口冲突时不要自动 `taskkill` 用户进程，应在窗口中明确区分“CainFlow 已在运行”和“端口被其他程序占用”，显示 PID、进程名、必要时显示命令行，并让用户自己关闭窗口或处理占用进程。通过 `.bat` 调用后端时可用环境变量避免后端和批处理重复等待；测试可用跳过等待的环境变量，但不要影响正式启动体验。
- 直接下载更新能力的责任链固定为：前端入口与用户提示、下载速度显示、取消下载交互、下载中关闭窗口的拦截与自动取消放 `js/features/update/update-manager.js`，设置页按钮只调用该能力；右下角常驻下载进度通知也放在 `update-manager.js`，挂到 `#toast-container`，样式在 `css/legacy.css` 和 `css/themes.css`，下载完成、取消或失败前不要自动消失。后端路由放 `backend/routes/update_routes.py`，下载任务、进度状态、取消清理、选择 Release ZIP、只提取 `CainFlow.exe` 并覆盖当前主程序路径放 `backend/services/update_service.py`，当前主程序路径由 `backend/config.py` 的 `MAIN_EXE_PATH` 提供，打包后应指向 `sys.executable`。不要对 Release ZIP 调用整包解压，避免 `workflows`、`allowed_hosts.json` 或其他文件被错误覆盖；提取出的主程序必须校验为 Windows 可执行文件；未下载完的 `.download`、提取中间文件、下载完成后的 ZIP，以及上次异常退出遗留的下载临时文件都应清理。下载前必须提示用户 GitHub 网络环境可能导致速度不稳定；下载中关闭窗口要先触发浏览器离开确认，真正离开时用 `/api/update/cancel` 取消后台任务；后端下载进度优先使用 GitHub Release asset 的 `size` 作为总量，完成态必须把 `downloadedBytes` / `totalBytes` / `percent=100` 写回顶层状态；前端收到完成态后要先把进度条渲染到 100%，再延迟弹出重启提示，避免 `alert()` 阻塞浏览器绘制。Windows 锁住运行中的主程序时要生成待替换文件和重试式替换脚本，更新完成或准备好替换后必须提示用户重启 CainFlow 主程序。
- 用户如果需要访问局域网、本机或内网 API，不是直接放宽默认校验，而是通过设置页里的显式安全开关 `allowPrivateNetworkTargets` 控制；前端通过 `x-allow-private-network-targets` 头传给 `/proxy`，调用链涉及 `js/core/state.js`、`js/services/api-client.js`、`backend/services/proxy_service.py`、`backend/services/security_service.py`，新增或调整时要整链同步检查。
- 与代理/白名单相关的错误提示优先统一沉到 `js/services/api-client.js`：像 “Target URL is not allowed” 这类后端安全拦截，要在 `classifyProviderError` / `formatProxyErrorMessage` 中翻译成中文用户提示，并明确告知用户去“设置 > 通用设置 > 安全”关闭过滤或调整允许列表；不要把英文原文直接透给用户，也不要在每个调用点各自拼一套不一致文案。
- OpenAI 兼容生图逻辑按职责拆分：协议/URL/请求体/分辨率预设放 `js/features/execution/provider-request-utils.js`；执行时读取节点输入、选择 JSON 或 multipart、发起 `/proxy` 请求放 `js/features/execution/execution-core.js`；代理错误归类与用户提示放 `js/services/api-client.js`。
- OpenAI 兼容生图有参考图输入时，请求路径应自动走 `/v1/images/edits`；无参考图时走 `/v1/images/generations`。`/images/edits` 需要 `multipart/form-data`，参考图应作为文件字段上传，不要继续用 JSON 传参考图。
- 生图节点的模型相关 UI（模型切换后分辨率菜单、OpenAI 自定义分辨率输入框显隐）放 `js/nodes/node-view-factory.js` 和 `js/nodes/node-dom-bindings.js`；保存/复制新增字段时同步更新 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`。
- 生图节点的生成次数字段使用 `generationCount`；控件模板放 `js/nodes/node-view-factory.js`，最小值归一化与 +/- 事件放 `js/nodes/node-dom-bindings.js`，保存/复制同步更新 `js/nodes/node-serializer.js` 与 `js/features/ui/clipboard-controller.js`，执行时的成功次数循环放 `js/features/execution/execution-core.js`。失败不计入次数；自动重试时已成功次数通过运行时字段 `generationCompletedCount` 保留，只补剩余次数。
- `ImageGenerate` 当前节点内结果区已经改成“纯进度显示”，只展示 `xx/xx` 生成进度，不再显示节点内图片预览。静态结构与文案样式放 `js/nodes/node-view-factory.js` / `css/legacy.css`，运行态进度数字更新放 `js/features/execution/execution-core.js`；生成图片数据仍保留在 `node.data.image` / `node.imageData` 供下游节点、历史记录和持久化使用。
- 给 `ImageGenerate` 再新增节点内结果区、生成进度或预览交互时，要把责任链一起补齐：静态结构放 `js/nodes/node-view-factory.js`，运行态文案/图片切换放 `js/features/execution/execution-core.js`，节点恢复显示放 `js/nodes/node-lifecycle.js`，交互绑定放 `js/nodes/node-dom-bindings.js` 与 `js/features/media/media-controller.js`。如果当前节点结构不再包含预览容器，就不要继续调用依赖该容器的媒体预览 helper。
- OpenAI 兼容生图分辨率下拉由 `provider-request-utils.js` 中的选项驱动。当前保留“自动”（空值，不发送 `size`）、`1024x1024`、`2048x2048`、`custom`；自定义分辨率 UI 使用“宽度输入框 x 高度输入框”，执行时拼成 `宽x高` 作为 `size`。
- 媒体处理（图片合成、Blob 转换、格式处理）放 `js/features/media/`。
- 图片对比这类交互式媒体节点：端口和默认尺寸放 `js/nodes/types/image-*.js`；节点内容模板和高级模式入口按钮放 `js/nodes/node-view-factory.js`；鼠标交互入口放 `js/nodes/node-dom-bindings.js` 并委托到 `js/features/media/media-controller.js`；执行输出与下游刷新放 `js/features/execution/execution-core.js`；节点样式放 `css/components/nodes.css`。
- 图片对比高级模式属于媒体控制器职责：全屏对比界面、A/B 选择、历史记录图片汇总、缩略图选择区展开、鼠标切割对比、滚轮缩放与左键平移放 `js/features/media/media-controller.js`；相关全屏布局、互斥 A/B 裁切、缩略图网格和按钮样式放 `css/components/nodes.css`。历史图片缩略图可用 `item.thumb` 展示，但设置 A/B 对比时必须使用 `item.image` 原图。
- 节点内新增按钮时，不只看按钮自身能不能点；还要一起检查所在卡片/节点里的对齐、停靠位置、上下留白和与端口文字的关系。优先让按钮回到所属容器的正常布局流，避免被全局 `position`、通用控件样式或其他继承规则挤到角落、贴住标签，或与相邻元素显得过于拥挤。
- 画布几何、连线、框选、缩放、视口相关逻辑放到 `js/canvas/*`。
- 画布拖拽过程中的交互判定放 `js/canvas/canvas-interactions.js`：例如拖拽晃动超过阈值后摘取节点；连线命中、插入预览和提交放 `js/canvas/connections.js`，几何采样工具优先复用 `js/canvas/geometry.js`。
- 画布滚轮缩放“停止后再变清晰”的收尾时机当前主要由 `js/canvas/canvas-interactions.js` 控制；节点文字的强制重绘入口在 `js/canvas/viewport.js` 的 `refreshNodeTextRendering()`；工具栏按钮缩放的同类收尾在 `js/features/ui/toolbar-controller.js`。如果要调缩放清晰化延迟或让滚轮/按钮缩放手感一致，优先同步检查这三处。
- 优化画布滚轮缩放手感时，优先先调缩放结束延迟、文字重绘范围或缩放曲线；不要轻易把 `js/canvas/viewport.js` 的视口 transform 更新与 `js/canvas/connections.js` 的 `updateAllConnections()` 拆开。当前连线渲染、工作流恢复后的连线显示和部分初始化链路依赖这条同步更新关系，贸然拆分容易出现“已有连线不显示”这类回归。
- 节点自动整理/自动布局这类只改变画布节点坐标的能力放到 `js/canvas/node-auto-layout.js`；入口装配仍在 `index.js`，按钮绑定放 `js/features/ui/toolbar-controller.js`，左侧栏静态按钮放 `index.html`，样式优先收敛到侧栏所属样式区域。
- 自动整理算法应保持“只改坐标、不改连线契约”的边界：在 `js/canvas/node-auto-layout.js` 内处理连通组件、拓扑分层、重心排序、按依赖中心线松弛和无连线节点网格排列。排序时要读取连接的 `from.port` / `to.port` 与节点 DOM 里的 `.node-port[data-direction]` 顺序；同一下游节点的输入口越靠上，连接到该输入口的上游节点也应越靠上，同一上游节点的输出口顺序也应尽量传递给下游节点，以减少连线穿插。保持运行中节点跳过、`pushHistory()`、`updateAllConnections()`、`scheduleSave()` 和 Toast 反馈链路不变。
- 连线类型、全局动画开关、连线可见性之类的画布/全局表现设置，状态默认值放 `js/core/state.js`，设置面板交互放 `js/features/settings/settings-controller.js`，配置导入导出/会话持久化同步更新 `js/features/ui/ui-controller.js`、`js/features/persistence/project-io.js`、`js/nodes/node-serializer.js`。
- 全局动画开关使用 `globalAnimationEnabled` 作为正式状态；`connectionFlowAnimationEnabled` 只作为旧配置兼容字段。根节点 CSS 类与旧字段对齐放 `js/features/ui/animation-controller.js`，连线 RAF 流动箭头在 `js/canvas/connections.js` 读取全局状态，CSS animation/transition 兜底禁用规则放现有样式层（当前在 `css/legacy.css`）。
- 画布左上角悬浮通知条（非 Toast）统一走 `js/features/ui/floating-notices-controller.js` 的 `upsertNotice` / `hideNotice` / `removeNotice`。固定启动通知在 `index.js` 的 `initFloatingNotices()` 里增删改；版本更新类动态通知在 `js/features/update/update-manager.js` 的 `showUpdateCanvasNotice()` 里改；通知容器仍是 `index.html` 的 `#floating-notices-container`，样式当前在 `css/legacy.css` 的 Floating Refresh / Update Notices 区域，浅色主题覆盖在 `css/themes.css`。
- 版本号升级需要同步 `package.json`、`js/core/constants.js`、`index.html` 展示与静态资源缓存参数、`css/base/variables.css`、`backend/main.py` 启动提示、`backend/services/proxy_service.py` User-Agent，以及 README 当前版本说明；如果当前会话显式要求更新 skill/架构图，也要同步更新 `.agent/skills/cainflow-project/SKILL.md` 和 `references/architecture-map.md` 里的版本信息与相关经验规则。
- 连线路径形状、直角圆角折线、剪线采样等几何能力优先收敛到 `js/canvas/geometry.js`，不要把几何计算散落回交互控制器。
- 不要为了“新功能”机械地新建文件；先判断现有文件是否本来就负责这类行为，只有在继续塞进去会让模块职责变模糊时再拆分。
- 多功能共享的常量放到 `js/core/constants.js`；通用纯函数放 `js/core/common-utils.js`。
- 只有在多个模块都需要时，才把 DOM 查找能力放到 `js/core/elements.js`。
- 主题切换逻辑放 `js/features/ui/theme-controller.js`，样式放 `css/themes.css`。
- 操作帮助面板内容放 `js/features/help/help-panel.js`；帮助面板样式当前在 `css/legacy.css` 的 Help Panel 区域，字体应显式使用无衬线字体，更新新交互时同步补齐帮助文案。
- 新样式放到对应 feature 或对应层级目录；设置面板专属新增样式优先放 `css/features/settings.css` 并接入 `index.css`；`css/legacy.css` 只用于兼容性或暂时未拆解的遗留样式。

## 高风险改动前先停一下

遇到下面这些情况，先重新判断影响范围，再继续：

- 修改 `index.html` 或 `index.js` 正在使用的 DOM id / class
- 在仍有 `window` 兼容暴露依赖时，把逻辑从 `index.js` 中强行迁出
- 修改 `js/nodes/node-serializer.js` 的工作流序列化结构
- 修改 workflow JSON 契约、默认工作流模板或工作流模型引用解析逻辑
- 修改文本节点的输入/输出、旧 TextInput/TextDisplay 兼容、运行后尺寸策略或编辑时尺寸策略
- 修改节点端口的顶部对齐布局、输入/输出端口顺序或端口行结构
- 修改节点 resize、最小尺寸测量、`getNodeMinimumSize(node, { width })` 透传链路或 `maxHeight` 与内容最小高度的约束关系
- 修改 ImageGenerate 的请求协议、OpenAI 兼容路径、multipart 表单字段或分辨率字段序列化
- 把节点里的原生 `select` 改成自定义下拉，或修改节点内下拉与画布缩放的交互方式
- 修改 ImageGenerate / TextChat / Text 等节点的 textarea 尺寸联动或 shrink 策略
- 修改 `ImageGenerate` 节点内结果区形态（预览图 / 进度文案 / 纯计数器）及其运行态显示链路
- 修改画布缩放结束后的清晰化/重绘时机（例如 wheel debounce、`refreshNodeTextRendering()` 或工具栏缩放收尾延迟）
- 修改 ImageGenerate 的多次生成、成功次数计数或自动重试衔接逻辑
- 修改 `backend/routes/*` 或 `backend/services/*` 的请求/响应契约
- 修改 `start_cainflow.bat`、`server.py` 或 `backend/main.py` 的启动冲突、端口检查、窗口停留和进程识别逻辑
- 本应放入分层样式目录，却继续把内容堆进 `css/legacy.css`
- 修改 `js/features/execution/execution-core.js` 的节点遍历或结果分发逻辑

## 参考文件用途

需要以下信息时，打开 `references/architecture-map.md`：

- 目录职责划分（含全部已有文件）
- 常见需求对应文件位置
- 常用检索命令
- 本仓库的模块化开发约束
