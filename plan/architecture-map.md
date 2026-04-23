# CainFlow 架构速查表

当你需要判断代码该放哪里，或者应该先看哪些文件时，使用这份速查表。

## 前端结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 启动入口 | `js/main.js`, `index.js` | 应用启动、总装配、跨模块编排 |
| 页面骨架 | `index.html` | 页面结构、面板容器、弹窗结构、脚本与样式入口 |
| Core | `js/core/constants.js`, `js/core/elements.js`, `js/core/state.js` | 共享常量、DOM 引用、初始状态 |
| Services | `js/services/api-client.js`, `js/services/storage-idb.js`, `js/services/workflow-api.js` | 代理请求头、IndexedDB、工作流文件 API |
| Canvas | `js/canvas/geometry.js`, `js/canvas/selection.js`, `js/canvas/viewport.js` | 贝塞尔几何、框选、缩放和平移 |
| 历史记录 | `js/features/history/history-panel.js` | 历史面板 UI 与相关交互 |
| 日志 | `js/features/logs/log-panel.js` | 日志面板 UI、日志渲染、错误详情入口 |
| 设置 | `js/features/settings/settings-controller.js`, `js/features/settings/settings-modal.js` | 设置数据加载、API配置与弹窗行为 |
| 执行 | `js/features/execution/execution-core.js` | 工作流拓扑排序、各类型节点底层通信与执行逻辑 |
| 工作流 | `js/features/workflow/workflow-manager.js` | 工作流列表、保存、加载、删除、重命名编排 |
| 媒体控制 | `js/features/media/media-controller.js` | 图片导入、预览、保存、缩放与下游节点同步逻辑 |
| 图片编辑 | `js/features/media/image-painter.js` | 内置图片编辑器 UI、绘制逻辑与结果回写 |
| 节点注册中心 | `js/nodes/registry.js` | 节点定义注册中心 |
| 节点 UI 渲染 | `js/nodes/node-view-factory.js` | 节点 HTML 骨架渲染函数工厂 |
| 节点类型 | `js/nodes/types/*.js` | 单个节点的元数据、默认值、图标、端口定义 |
| 节点交互绑定 | `js/nodes/node-dom-bindings.js` | 将 DOM 事件（拖拽、输入等）与 API 逻辑绑定 |
| 序列化 | `js/nodes/node-serializer.js` | 工作流导入导出结构与节点序列化 |

## 后端结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 兼容入口 | `server.py` | 兼容性启动壳，转调 backend 主入口 |
| 服务启动 | `backend/main.py` | 端口检查、启动流程、浏览器打开、服务启动 |
| 请求分发 | `backend/handler.py` | 静态资源服务、路由分发、`/proxy` 入口 |
| 运行时状态 | `backend/state.py` | 共享运行时状态与噪音请求过滤 |
| 设置路由 | `backend/routes/settings_routes.py` | 设置相关 HTTP 请求处理 |
| 工作流路由 | `backend/routes/workflow_routes.py` | 工作流 CRUD 接口 |
| 代理服务 | `backend/services/proxy_service.py` | 上游代理与请求转发 |
| 安全服务 | `backend/services/security_service.py` | 允许主机列表、代理检测、安全路径与 URL 校验 |
| 工作流服务 | `backend/services/workflow_service.py` | 工作流列表、读取、保存、重命名、删除 |
| HTTP 工具 | `backend/services/http_helpers.py` | JSON 请求体解析与 JSON / 错误响应 |
| CI/CD | `.github/workflows/release.yml` | 基于 PyInstaller 的 GitHub Actions 自动打包发布流程 |

## CSS 结构

| 区域 | 主要文件 | 作用 |
| --- | --- | --- |
| 样式入口 | `index.css` | 分层样式入口 |
| Base | `css/base/variables.css` | 主题变量与全局令牌 |
| Layout | `css/layout/layout.css` | 应用整体布局与面板排布 |
| Components | `css/components/nodes.css` | 可复用的节点与组件样式 |
| Features | `css/features/panels.css` | 功能区或面板专属样式 |
| Legacy | `css/legacy.css` | 兼容层与遗留样式承接 |

## 全局 UI 模式与规约 (Global UI Patterns & Conventions)

| 模式名称 | DOM/CSS 标识 | 适用场景与规约 |
| --- | --- | --- |
| **通知类型1 (Notice Type 1)** | `#floating-notices-container`, `.floating-notice` | 画布左上角全局悬浮通知（如更新提醒、空配置警告）。必须追加到 Flex 容器内，由容器负责堆叠。 |

## 常见需求落点

| 需求 | 优先检查这些文件 |
| --- | --- |
| 修复工作流保存、加载、列表、重命名、删除 | `js/features/workflow/workflow-manager.js`, `js/services/workflow-api.js`, `backend/routes/workflow_routes.py`, `backend/services/workflow_service.py` |
| 修复工作流执行反馈或逻辑 | `js/features/execution/execution-core.js`, `index.js`, `backend/services/proxy_service.py` |
| 修复设置面板或配置交互 | `js/features/settings/settings-controller.js`, `js/features/settings/settings-modal.js`, `backend/routes/settings_routes.py`, `backend/services/security_service.py` |
| 修复历史记录面板 | `js/features/history/history-panel.js`, `js/services/storage-idb.js`, `index.js` |
| 修复日志面板或错误详情 | `js/features/logs/log-panel.js`, `index.js` |
| 新增或修改节点类型 | `js/nodes/types/*.js`, `js/nodes/registry.js`, `js/nodes/node-view-factory.js`, `index.html` (右键菜单), `js/features/execution/execution-core.js` (执行逻辑) |
| 修复节点交互行为 | `js/nodes/node-dom-bindings.js`, `js/features/media/media-controller.js` (针对媒体类节点) |
| 修复画布拖拽、框选、缩放、几何绘制 | `js/canvas/selection.js`, `js/canvas/viewport.js`, `js/canvas/geometry.js`, `index.js` |
| 修改共享常量或默认值 | `js/core/constants.js`, `js/core/state.js` |
| 修改 DOM 获取或顶层元素引用 | `js/core/elements.js`, `index.html`, `index.js` |
| 修复静态资源加载或路由兜底问题 | `js/main.js`, `index.html`, `backend/handler.py`, `backend/state.py` |
| 修改服务启动或本地运行行为 | `server.py`, `backend/main.py`, `backend/config.py` |
| 优化或修复打包流程 | `.github/workflows/release.yml` |
| 修复节点间实时状态同步 | `js/features/media/media-controller.js` (`notifyDownstreamNodes`), `index.js`, `js/features/execution/execution-core.js` |
| 添加功能专属样式 | `css/features/panels.css` 或 `css/features/` 下新增文件，并接入 `index.css` |
| 添加共享视觉变量 | `css/base/variables.css` |

## 常用检索命令

```powershell
rg --files js backend css
rg "workflow|history|settings|proxy|log" js backend index.js index.html
rg "create.*Api|export function|export const" js -g "*.js"
rg "handle_get|handle_post|handle_delete|def " backend -g "*.py"
```

## 模块化约束

- `index.js` 是集成层，不是新的逻辑堆放场。
- `js/main.js` 保持极简。
- 行为是 feature 级别的，就新增到 `js/features/<feature>/`。
- 后端按 route 与 service 分责，不要混写。
- 优先使用分层后的 `css/` 目录，不要继续扩张 `index.css` 或 `css/legacy.css`。
- 保留当前启动流程中已经对外暴露的兼容钩子。
