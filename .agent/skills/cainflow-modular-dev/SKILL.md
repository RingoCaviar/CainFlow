---
name: cainflow-modular-dev
description: CainFlow 模块化开发指引。用于新增功能、重构功能、修复问题或定位代码时，帮助 AI 按当前项目架构选择正确的前端、后端与样式模块，避免继续把逻辑堆进入口文件，并快速找到工作流、设置、历史记录、日志、节点、画布、代理、持久化和静态资源相关代码。
---

# CainFlow 模块化开发

在开始修改 CainFlow 代码前，优先使用这个 skill 作为项目导航图。

当你需要快速判断“代码应该放哪里”或“应该先看哪些文件”时，打开 `references/architecture-map.md`。

## 使用流程

1. 在动手前先给需求分类。
   - 页面骨架或静态结构 -> `index.html`
   - 前端总装配、跨模块编排 -> `index.js`
   - 入口引导 -> `js/main.js`
   - 可复用的前端状态、常量、DOM 引用 -> `js/core/*`
   - API、存储、服务通信 -> `js/services/*`
   - 画布数学、框选、缩放、拖拽 -> `js/canvas/*`
   - 某个功能面板的行为 -> `js/features/<feature>/*`
   - 节点定义或序列化 -> `js/nodes/*`
   - 后端路由分发 -> `backend/routes/*`
   - 后端业务逻辑 -> `backend/services/*`
   - 服务启动、请求处理总入口 -> `backend/main.py`、`backend/handler.py`、`server.py`
   - 样式 -> `css/base/*`、`css/layout/*`、`css/components/*`、`css/features/*`

2. 优先扩展已有模块，不要继续增肥入口文件。
   - `index.js` 负责组合、编排和兼容性桥接。
   - `js/main.js` 尽量保持很小，目前只负责引导 `index.js`。
   - `index.css` 作为样式入口即可，实际规则优先放入分层后的 `css/` 子目录。
   - 不要把新的业务逻辑直接堆到 `index.html`。

3. 保持模块边界清晰。
   - 某个功能专属的 UI 逻辑，放到 `js/features/<feature>/`。
   - 多个功能共用的基础能力，放到 `js/core/`、`js/services/` 或 `js/canvas/`。
   - 节点类型专属逻辑，放到 `js/nodes/types/*.js`。
   - 后端的 HTTP 解析放在 routes，真正的逻辑放在 services。

4. 修改前先做小范围检索。
   - 用 `rg --files js backend css` 浏览模块树。
   - 用 `rg "关键词" js backend index.js index.html` 找真正的责任文件。
   - 追踪模块边界时，用 `rg "^export |^import " js -g "*.js"`。
   - 只读“拥有该行为的文件”和它的直接调用方，不要一上来全量扫仓库。

5. 在最小责任模块中改动。
   - 如果只影响一个功能面板，就只改那个 feature 目录。
   - 如果多个功能都要用同一能力，再上提成共享模块。
   - 如果是新功能域，优先新建 `js/features/<name>/`，不要再往 `index.js` 塞一大段。

6. 按改动边界做验证。
   - 前端语法：`node --check index.js`
   - 全量前端检查：`Get-ChildItem js -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`
   - 后端语法：`python -m py_compile backend\\main.py backend\\handler.py backend\\routes\\*.py backend\\services\\*.py`
   - 运行验证：启动 `python server.py`，再在浏览器里验证受影响流程。

## 代码落点规则

- 新节点类型放到 `js/nodes/types/`，并通过 `js/nodes/registry.js` 注册。
- 工作流持久化、工作流列表操作，优先落到 `js/services/workflow-api.js` 以及后端 workflow 的 route/service 模块。
- 设置面板行为放到 `js/features/settings/settings-modal.js`；设置持久化、代理检查放到后端 settings/security 相关模块。
- 历史记录和日志面板的行为放在各自 feature 模块，不要回流到 `index.js`。
- 画布几何、框选、缩放、视口相关逻辑放到 `js/canvas/*`。
- 多功能共享的常量放到 `js/core/constants.js`。
- 只有在多个模块都需要时，才把 DOM 查找能力放到 `js/core/elements.js`。
- 新样式放到对应 feature 或对应层级目录；`css/legacy.css` 只用于兼容性或暂时未拆解的遗留样式。

## 高风险改动前先停一下

遇到下面这些情况，先重新判断影响范围，再继续：

- 修改 `index.html` 或 `index.js` 正在使用的 DOM id / class
- 在仍有 `window` 兼容暴露依赖时，把逻辑从 `index.js` 中强行迁出
- 修改 `js/nodes/node-serializer.js` 的工作流序列化结构
- 修改 `backend/routes/*` 或 `backend/services/*` 的请求/响应契约
- 本应放入分层样式目录，却继续把内容堆进 `css/legacy.css`

## 参考文件用途

需要以下信息时，打开 `references/architecture-map.md`：

- 目录职责划分
- 常见需求对应文件位置
- 常用检索命令
- 本仓库的模块化开发约束
