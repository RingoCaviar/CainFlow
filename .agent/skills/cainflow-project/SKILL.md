---
name: cainflow-project
description: CainFlow 项目导航 Skill。用于修改功能、重构或排查问题时，帮助 AI 快速定位正确的前端、后端、样式与工作流模块，避免继续把逻辑堆进入口文件。
---

# CainFlow 项目导航

> 当前适配版本：v2.8.2.x

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
- 节点模板、绑定、生命周期、序列化：`js/nodes/*`
- 执行引擎、请求拼装、工作流运行：`js/features/execution/*`
- 媒体处理、图片预览、图片对比、图片保存：`js/features/media/*`
- 工作流导入导出、会话恢复：`js/features/persistence/*`
- 历史记录、设置、日志、帮助、更新、工作流面板等 UI 功能：`js/features/*`
- 后端路由：`backend/routes/*`
- 后端业务逻辑：`backend/services/*`
- 后端启动与运行配置：`backend/main.py`、`backend/config.py`、`server.py`
- 发布打包与本地构建：`.github/workflows/release.yml`、`scripts/build-release-local.ps1`
- 样式入口与分层样式：`index.css`、`css/*`

## 开发规则

1. 优先扩展已有模块，不要继续增肥 `index.js`、`index.html` 或 `css/legacy.css`。
2. 功能专属逻辑放 `js/features/<feature>/`；共享能力放 `js/core/`、`js/services/`、`js/canvas/`。
3. 节点类型定义放 `js/nodes/types/*.js`；模板放 `js/nodes/node-view-factory.js`；DOM 交互放 `js/nodes/node-dom-bindings.js`；序列化放 `js/nodes/node-serializer.js`。
4. 后端保持“routes 收请求，services 放逻辑”的边界。
5. 新样式优先放到对应的 `css/features/`、`css/components/`、`css/layout/`；`css/legacy.css` 只承接遗留样式。

## 当前项目里的关键约定

### 入口与模块边界

- 前端真实入口是 `index.js`；不要再新增无意义的二次转发入口。
- `index.js` 负责装配与依赖注入，不适合继续堆具体业务逻辑。
- `index.html` 只放结构、容器和必要的启动脚本，不把业务逻辑直接写回页面。

### 执行与数据流

- 执行相关逻辑集中在 `js/features/execution/`，不要混入 UI 控制器。
- 图片数组通常走 `data.images` / `imageDataList` / `generatedImages`；文本数组通常走 `data.texts`。
- 普通节点接到数组输入时，默认按组合批量执行；展示类/收集类节点如 `ImagePreview`、`ImageSave`、`Text`、`ImageMerge`、`TextMerge` 通常一次性接收整组数据。
- 代理错误、SSRF/白名单拦截提示统一收口到 `js/services/api-client.js`，不要在各调用点散落不同文案。

### 节点与画布

- 节点尺寸测量、最小尺寸、恢复后的兜底修正集中在 `js/nodes/node-lifecycle.js`。
- 节点内部控件交互与动态端口重建集中在 `js/nodes/node-dom-bindings.js`。
- 连线逻辑在 `js/canvas/connections.js`，缩放/拖拽/改线交互在 `js/canvas/canvas-interactions.js`；仅改端口显示位置时不要误改连线取点逻辑。
- `TextInput`、`TextDisplay` 仍是旧工作流兼容类型，正式文本节点看 `Text` 和 `TextSplit`。

### 设置、更新与启动

- 设置页 UI 与数据逻辑集中在 `js/features/settings/settings-controller.js` 与 `js/features/settings/settings-modal.js`。
- 在线更新能力集中在 `js/features/update/update-manager.js`、`backend/routes/update_routes.py`、`backend/services/update_service.py`。
- 版本号单一来源是 `js/core/constants.js` 的 `APP_VERSION_NUMBER`。
- 源码启动链路主要看 `start_cainflow.bat`、`server.py`、`backend/main.py`。
- 发布包构建链路同时看 `.github/workflows/release.yml` 与 `scripts/build-release-local.ps1`；PyInstaller 入口是 `server.py`，`backend` 作为 Python 模块被自动收集，不要再用 `--add-data "backend;backend"` 重复打包。

## 高风险改动前先停一下

遇到这些点时，先确认整条链路再改：

- 修改 `index.html` 的关键 DOM id/class，或 `index.js` 的模块注入关系
- 修改工作流序列化结构、默认工作流模板、导入导出契约
- 修改节点端口布局、动态端口、节点最小尺寸、缩放测量链
- 修改 `ImageGenerate`、`TextChat`、`Text`、`TextSplit` 的运行态数据结构或批处理语义
- 修改 `/proxy`、代理设置、允许域名、安全校验链路
- 修改更新下载、启动冲突检测、端口占用提示链路
- 修改 GitHub Actions 发布包、本地打包脚本、PyInstaller 参数或 Release ZIP 内容

## 修改前后的建议动作

- 修改前先用关键词检索责任文件，只读“责任文件 + 直接调用方”。
- 修改后至少做受影响文件的语法检查。
- 如果启动过本地服务做验证，结束前确认不要留下本轮调试进程和临时文件。

## 参考文件

需要更完整的职责表、目录地图和常见需求落点时，打开：

- `references/architecture-map.md`
