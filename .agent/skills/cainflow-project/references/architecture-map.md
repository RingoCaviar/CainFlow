# CainFlow 架构速查表

当你需要判断代码该放哪里，或者应该先看哪些文件时，使用这份速查表。

> 当前版本：v2.7.5.2

## 前端结构

### 启动 & 核心

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 启动入口 | `js/main.js`, `index.js` | 应用启动、总装配、跨模块编排 |
| 页面骨架 | `index.html` | 页面结构、面板容器、弹窗结构、脚本与样式入口 |
| 应用启动控制 | `js/features/app/startup-controller.js` | 应用初始化流程、模块装载编排 |
| 共享常量 | `js/core/constants.js` | APP_VERSION、GITHUB_REPO、STORAGE_KEY、DB_VERSION 等前端共享常量 |
| DOM 引用 | `js/core/elements.js` | 跨模块共用的顶层 DOM 元素查找 |
| 全局状态 | `js/core/state.js` | 前端运行时共享状态与初始值 |
| 通用工具 | `js/core/common-utils.js` | 多模块共用的纯函数工具集 |

### Services（服务层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 代理请求 | `js/services/api-client.js` | 上游 API 代理请求封装、User-Agent 注入 |
| 本地存储 | `js/services/storage-idb.js` | IndexedDB 历史记录持久化 |
| 工作流文件 API | `js/services/workflow-api.js` | 工作流文件列表、加载、保存等后端接口调用 |

### Canvas（画布层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 画布交互总线 | `js/canvas/canvas-interactions.js` | 鼠标事件总线、拖拽与交互调度 |
| 连线绘制 | `js/canvas/connections.js` | 节点连线绘制、连线可见性裁剪、选中态流动箭头动画；流动箭头受全局动画开关控制 |
| 几何计算 | `js/canvas/geometry.js` | 贝塞尔曲线、直角圆角连线、剪线采样、坐标相关几何工具 |
| 框选 | `js/canvas/selection.js` | 矩形框选逻辑与选中状态 |
| 视口 | `js/canvas/viewport.js` | 缩放、平移、视口坐标变换 |

### Features（功能面板层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| **执行引擎** | | |
| 执行核心 | `js/features/execution/execution-core.js` | 单节点执行处理、API 请求发起、图片类节点输出分发、ImageGenerate 多次生成成功计数 |
| 提供商请求工具 | `js/features/execution/provider-request-utils.js` | 针对不同 API 提供商的请求拼装、协议判断、OpenAI/Gemini 图片分辨率预设、OpenAI 图片接口路径选择 |
| 工作流运行器 | `js/features/execution/workflow-runner.js` | 整体工作流执行流程编排、自动重试、节点运行态重置 |
| **帮助** | | |
| 帮助面板 | `js/features/help/help-panel.js` | 帮助文档面板 UI 与交互 |
| **历史记录** | | |
| 历史面板 | `js/features/history/history-panel.js` | 历史面板 UI 与列表交互；历史图片拖拽应携带 `item.image` 原图而不是缩略图 |
| 历史预览 | `js/features/history/history-preview.js` | 历史记录条目预览渲染 |
| **日志** | | |
| 日志面板 | `js/features/logs/log-panel.js` | 日志面板 UI、日志渲染、错误详情入口 |
| **媒体** | | |
| 图片绘制 | `js/features/media/image-painter.js` | Canvas 图片绘制与合成 |
| 媒体控制 | `js/features/media/media-controller.js` | 媒体资源生命周期管理、图片预览/保存/缩放/对比节点的运行态同步与交互；提供文件导入与 data URL 直接写入入口 |
| 媒体工具 | `js/features/media/media-utils.js` | 图片格式转换、Blob 处理等工具函数 |
| **持久化** | | |
| 项目导入导出 | `js/features/persistence/project-io.js` | 工作流 JSON 文件导入导出 |
| 会话管理 | `js/features/persistence/session-manager.js` | 自动保存、页面关闭前恢复等会话持久化 |
| **设置** | | |
| 设置控制器 | `js/features/settings/settings-controller.js` | 设置数据逻辑、持久化、代理检测、版本更新、画布连线设置 |
| 设置弹窗 | `js/features/settings/settings-modal.js` | 设置弹窗开关与标签页 UI 行为 |
| **UI 控制器** | | |
| 剪贴板 | `js/features/ui/clipboard-controller.js` | 节点复制粘贴、剪贴板操作、节点配置字段复制 |
| 右键菜单 | `js/features/ui/context-menu-controller.js` | 右键菜单渲染与事件分发 |
| 错误弹窗 | `js/features/ui/error-modal-controller.js` | 错误详情弹窗 UI |
| 全局交互 | `js/features/ui/global-interactions.js` | 键盘快捷键、全局点击、粘贴、全局图片拖拽/drop 等顶层事件 |
| 面板管理 | `js/features/ui/panel-manager.js` | 侧边栏面板展开收起管理 |
| 运行状态 | `js/features/ui/runtime-controller.js` | 运行按钮状态、执行进度反馈 |
| 主题切换 | `js/features/ui/theme-controller.js` | 明暗主题切换与持久化 |
| 全局动画 | `js/features/ui/animation-controller.js` | 将 `globalAnimationEnabled` 应用到根节点 CSS 类，并同步旧的连线动画兼容字段 |
| Toast 通知 | `js/features/ui/toast-controller.js` | Toast 消息弹出与自动消失 |
| 工具栏 | `js/features/ui/toolbar-controller.js` | 顶部工具栏按钮绑定与状态同步 |
| UI 总控 | `js/features/ui/ui-controller.js` | UI 层模块统一初始化与依赖注入 |
| UI 工具 | `js/features/ui/ui-utils.js` | UI 层通用辅助函数 |
| **更新** | | |
| 更新检查 | `js/features/update/update-manager.js` | GitHub Release 版本对比与更新提示 |
| **工作流** | | |
| 工作流管理 | `js/features/workflow/workflow-manager.js` | 工作流列表、保存、加载、删除、重命名编排 |

### Nodes（节点层）

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 节点注册中心 | `js/nodes/registry.js` | 节点类型定义注册中心 |
| 节点 DOM 绑定 | `js/nodes/node-dom-bindings.js` | 节点 DOM 事件绑定与输入监听、节点内控件值归一化 |
| 节点生命周期 | `js/nodes/node-lifecycle.js` | 节点创建、销毁、状态更新 |
| 序列化 | `js/nodes/node-serializer.js` | 工作流导入导出结构与节点序列化，含 ImageGenerate `generationCount` |
| 节点视图工厂 | `js/nodes/node-view-factory.js` | 节点 HTML 模板生成，含 ImageGenerate 分辨率与生成次数控件 |
| 图片生成节点 | `js/nodes/types/image-generate.js` | ImageGenerate 节点定义、端口与默认尺寸 |
| 图片导入节点 | `js/nodes/types/image-import.js` | ImageImport 节点定义 |
| 图片对比节点 | `js/nodes/types/image-compare.js` | ImageCompare 节点定义，包含 A/B 图片输入与 B 图片输出 |
| 图片预览节点 | `js/nodes/types/image-preview.js` | ImagePreview 节点定义 |
| 图片缩放节点 | `js/nodes/types/image-resize.js` | ImageResize 节点定义 |
| 图片保存节点 | `js/nodes/types/image-save.js` | ImageSave 节点定义 |
| 对话节点 | `js/nodes/types/text-chat.js` | TextChat 节点定义 |
| 文本显示节点 | `js/nodes/types/text-display.js` | TextDisplay 节点定义 |
| 文本输入节点 | `js/nodes/types/text-input.js` | TextInput 节点定义 |

---

## 后端结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 兼容入口 | `server.py` | 兼容性启动壳，转调 backend 主入口 |
| 服务启动 | `backend/main.py` | 端口检查、Banner 打印、浏览器打开、服务启动 |
| 请求分发 | `backend/handler.py` | 静态资源服务、路由分发、`/proxy` 入口 |
| 运行时配置 | `backend/config.py` | 端口、路径、运行时目录等配置项 |
| 运行时状态 | `backend/state.py` | 共享运行时状态与噪音请求过滤 |
| 设置路由 | `backend/routes/settings_routes.py` | 设置相关 HTTP 请求处理 |
| 工作流路由 | `backend/routes/workflow_routes.py` | 工作流 CRUD 接口 |
| HTTP 工具 | `backend/services/http_helpers.py` | JSON 请求体解析与 JSON / 错误响应 |
| 日志服务 | `backend/services/log_service.py` | 服务端日志收集与管理 |
| 代理服务 | `backend/services/proxy_service.py` | 上游代理与请求转发 |
| 安全服务 | `backend/services/security_service.py` | 允许主机列表、代理检测、安全路径与 URL 校验 |
| 工作流服务 | `backend/services/workflow_service.py` | 工作流列表、读取、保存、重命名、删除 |

---

## CSS 结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 样式入口 | `index.css` | 分层样式入口，@import 各子目录 |
| Base | `css/base/variables.css` | 主题变量与全局令牌 |
| Layout | `css/layout/layout.css` | 应用整体布局与面板排布 |
| Components | `css/components/nodes.css` | 可复用的节点与组件样式 |
| Features | `css/features/panels.css` | 功能区或面板专属样式 |
| Themes | `css/themes.css` | 主题切换相关样式（明暗模式等） |
| Legacy | `css/legacy.css` | 兼容层与遗留样式承接 |

---

## 常见需求落点

| 需求 | 优先检查这些文件 |
| --- | --- |
| 修复工作流保存、加载、列表、重命名、删除 | `js/features/workflow/workflow-manager.js`, `js/services/workflow-api.js`, `backend/routes/workflow_routes.py`, `backend/services/workflow_service.py` |
| 修复工作流执行、节点调度 | `js/features/execution/workflow-runner.js`, `js/features/execution/execution-core.js`, `js/features/execution/provider-request-utils.js` |
| 修复代理请求拼装或 API 调用 | `js/services/api-client.js`, `backend/handler.py`, `backend/services/proxy_service.py` |
| 修改 OpenAI 兼容生图请求路径、参考图上传或请求体格式 | `js/features/execution/provider-request-utils.js`, `js/features/execution/execution-core.js`, `js/services/api-client.js`, `backend/services/proxy_service.py` |
| 修改生图节点分辨率菜单、OpenAI 自定义分辨率输入 | `js/features/execution/provider-request-utils.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js` |
| 修改生图节点生成次数、成功计数或失败重试语义 | `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `js/features/execution/execution-core.js`, `js/features/execution/workflow-runner.js` |
| 修复设置面板或代理设置交互 | `js/features/settings/settings-modal.js`, `js/features/settings/settings-controller.js`, `backend/routes/settings_routes.py`, `backend/services/security_service.py` |
| 修复历史记录面板 | `js/features/history/history-panel.js`, `js/features/history/history-preview.js`, `js/services/storage-idb.js` |
| 修复历史记录图片拖拽到画布/节点 | `js/features/history/history-panel.js`, `js/features/ui/global-interactions.js`, `js/features/media/media-controller.js`, `js/core/state.js` |
| 修复日志面板或错误详情 | `js/features/logs/log-panel.js`, `backend/services/log_service.py` |
| 新增或修改节点类型 | `js/nodes/types/*.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js`, `js/nodes/node-serializer.js`, `js/features/ui/clipboard-controller.js`, `css/components/nodes.css` |
| 新增或修改图片对比/预览/缩放/保存类节点 | `js/nodes/types/*.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `js/nodes/node-dom-bindings.js`, `js/features/media/media-controller.js`, `js/features/execution/execution-core.js`, `css/components/nodes.css` |
| 修复节点 DOM 绑定或事件 | `js/nodes/node-dom-bindings.js`, `js/nodes/node-lifecycle.js` |
| 修复画布拖拽、框选、缩放、几何绘制 | `js/canvas/canvas-interactions.js`, `js/canvas/selection.js`, `js/canvas/viewport.js`, `js/canvas/geometry.js` |
| 修复连线绘制 | `js/canvas/connections.js` |
| 修改共享常量或默认值 | `js/core/constants.js`, `js/core/state.js` |
| 修改连线类型 | `js/features/settings/settings-controller.js`, `js/core/state.js`, `js/canvas/connections.js`, `js/canvas/geometry.js`, `js/features/ui/ui-controller.js`, `js/features/persistence/project-io.js`, `js/nodes/node-serializer.js` |
| 修改全局动画开关或禁用动画性能模式 | `js/features/settings/settings-controller.js`, `js/features/ui/animation-controller.js`, `js/core/state.js`, `js/canvas/connections.js`, `css/legacy.css`, `js/features/ui/ui-controller.js`, `js/features/persistence/project-io.js`, `js/nodes/node-serializer.js`, `index.html` |
| 修改 DOM 获取或顶层元素引用 | `js/core/elements.js`, `index.html` |
| 添加通用工具函数 | `js/core/common-utils.js` |
| 媒体/图片处理 | `js/features/media/image-painter.js`, `js/features/media/media-controller.js`, `js/features/media/media-utils.js` |
| 图片节点的运行态预览、对比、下游级联刷新 | `js/features/media/media-controller.js`, `js/features/execution/execution-core.js`, `js/nodes/node-dom-bindings.js` |
| 项目文件导入导出 | `js/features/persistence/project-io.js` |
| 自动保存 / 会话恢复 | `js/features/persistence/session-manager.js` |
| 主题切换 | `js/features/ui/theme-controller.js`, `css/themes.css` |
| Toast 通知 | `js/features/ui/toast-controller.js` |
| 键盘快捷键 / 全局事件 | `js/features/ui/global-interactions.js` |
| 剪贴板操作 | `js/features/ui/clipboard-controller.js` |
| 右键菜单 | `js/features/ui/context-menu-controller.js` |
| 版本更新检查 | `js/features/update/update-manager.js`, `js/features/settings/settings-controller.js` |
| 升级应用版本号 | `package.json`, `js/core/constants.js`, `index.html`, `css/base/variables.css`, `backend/main.py`, `backend/services/proxy_service.py`, `README.md` |
| 应用启动流程 | `js/features/app/startup-controller.js`, `js/main.js`, `index.js` |
| 修复静态资源加载或路由兜底问题 | `index.html`, `backend/handler.py`, `backend/state.py` |
| 修改服务启动或本地运行行为 | `server.py`, `backend/main.py`, `backend/config.py` |
| 添加功能专属样式 | `css/features/panels.css` 或 `css/features/` 下新增文件，并接入 `index.css` |
| 添加共享视觉变量 | `css/base/variables.css` |
| 服务端日志 | `backend/services/log_service.py`, `backend/routes/` |

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
- `js/main.js` 保持极简，只负责引导 `index.js`。
- 先判断现有模块是否已经负责这类行为；如果职责仍然清晰，就继续在现有模块中扩展，不要为了“新功能”机械拆文件。
- 如果一个新能力会被多个画布/设置/持久化流程复用，或继续塞进现有文件会让职责变混乱，再提炼成 `js/canvas/*`、`js/core/*` 或 `js/features/<feature>/*` 下的新模块，而不是继续堆进 `index.js` 或单个控制器。
- 执行逻辑放 `js/features/execution/`，不要混入 UI 控制器。
- 供应商协议、模型能力、OpenAI/Gemini 生图请求路径、请求体和分辨率预设优先放 `js/features/execution/provider-request-utils.js`；实际执行时的取 DOM 值、选择 JSON 或 multipart、调用 `/proxy` 放 `js/features/execution/execution-core.js`。
- OpenAI 兼容生图无参考图走 `/v1/images/generations`；有 `image_1` 到 `image_5` 任意参考图走 `/v1/images/edits`。`/images/edits` 必须发送 `multipart/form-data`，图片作为文件字段上传；不要用 JSON `reference_images` 代替 multipart。
- OpenAI 兼容生图分辨率菜单由 `provider-request-utils.js` 的选项驱动：`自动` 使用空值且不发送 `size`，固定项使用 OpenAI `WxH` size，自定义项由节点 UI 的“宽度输入框 x 高度输入框”拼成 `宽x高`。相关 UI 在 `js/nodes/node-view-factory.js` / `js/nodes/node-dom-bindings.js`，序列化同步更新 `js/nodes/node-serializer.js` 和 `js/features/ui/clipboard-controller.js`。
- ImageGenerate 生成次数使用 `generationCount`：模板在 `js/nodes/node-view-factory.js`，最小值归一化和 +/- 事件在 `js/nodes/node-dom-bindings.js`，保存/导出在 `js/nodes/node-serializer.js`，复制粘贴在 `js/features/ui/clipboard-controller.js`，执行循环在 `js/features/execution/execution-core.js`。失败不计入次数；自动重试时通过运行时字段 `generationCompletedCount` 保留本轮已成功次数，`js/features/execution/workflow-runner.js` 负责新一轮运行前重置。
- 媒体处理放 `js/features/media/`，不要堆回节点类型文件。
- 图片类节点的定义、模板、DOM 绑定、媒体同步和执行输出要分层处理：`js/nodes/types/*.js` 只放元数据和端口；`js/nodes/node-view-factory.js` 只生成结构；`js/nodes/node-dom-bindings.js` 只接入节点事件；`js/features/media/media-controller.js` 负责图片显示状态、交互与依赖刷新；`js/features/execution/execution-core.js` 负责运行时输入校验、输出写入和向下游分发。
- 历史记录面板显示可以使用 `item.thumb` 缩略图，但拖拽导入必须使用 `item.image` 原图。拖拽源在 `js/features/history/history-panel.js`，画布 drop 与现有 ImageImport 节点更新在 `js/features/ui/global-interactions.js`，直接写入 data URL 的能力放 `js/features/media/media-controller.js`。
- 全局动画开关以 `globalAnimationEnabled` 为准，旧的 `connectionFlowAnimationEnabled` 只做兼容读写。应用根节点类名与兼容字段同步放 `js/features/ui/animation-controller.js`；具体动画执行点仍在各自模块中读取全局状态或依赖 CSS 禁用规则。
- 持久化逻辑放 `js/features/persistence/`，不要散落在各 feature 中。
- 后端按 route 与 service 分责，不要混写。
- 版本号升级必须同时覆盖前端常量、页面展示、静态资源缓存参数、CSS 版本变量、后端启动提示、代理 User-Agent、包元数据和 README，避免界面、请求标识与发布文档不一致。
- 优先使用分层后的 `css/` 目录，不要继续扩张 `index.css` 或 `css/legacy.css`。
- 保留当前启动流程中已经对外暴露的兼容钩子。
