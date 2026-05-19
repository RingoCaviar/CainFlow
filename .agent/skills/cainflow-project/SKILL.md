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

### 主题与样式分层

- 主题状态已经从固定明暗切换升级为多主题结构：前端运行态字段使用 `themeId`，主题切换 UI 由 `js/features/ui/theme-controller.js` 管理，并通过 `data-app-theme` 驱动整站样式。
- 主题样式入口是 `css/themes.css`，它只负责聚合各主题文件；公共主题菜单/按钮样式放 `css/themes/shared.css`；每个主题独立放在 `css/themes/*.css`，当前已有 `dark.css`、`light.css`、`pro.css`、`pink.css`。
- 主题适配现在优先走“共享语义 token + 少量主题特化覆盖”模式：`css/legacy.css` 承接抽屉、帮助面板、工作流列表、缓存面板、左上角悬浮通知等共享 token；`css/features/panels.css` 承接提示词库、提示词导入、全屏历史、历史预览等功能面板 token；主题文件首先在 `:root[data-app-theme="..."]` 里赋值，再只保留必要的个性化细节覆盖。
- 新增主题时，优先先补 token，不要先写大段选择器覆盖。尤其先检查 `--panel-*`、`--workflow-card-*`、`--cache-*`、`--notice-*`、`--prompt-*`、`--history-*` 这几组变量是否齐全；大多数面板应该通过这些变量自动完成换肤。
- 新增或修改任意主题时，默认都要补齐到设置面板、提示词库、历史全屏、缓存抽屉、主题菜单、相机编辑器、Toast、弹窗等细节面板，不要只改主画布和工具栏。
- 新增或修改任意主题时，设置面板配色也必须与主页主题保持一致：不仅要补齐控件可用性，还要统一设置弹窗表面层级、卡片 hover、tab、工具栏主按钮、供应商类型 badge、更新状态与版本摘要的主色体系。不要只修单个输入框或按钮，而要把整个设置面板当成独立子界面统一看。
- 新增主题或修改主题时，不要只改主页或工具栏。必须把主页、侧边栏、抽屉、弹窗、右键菜单、Toast、历史面板、设置面板、帮助面板、更新面板、节点内部控件、全屏预览等整条 UI 链路一起检查，避免出现“主页主题改了，但某些面板还是旧主题”的不完整状态。
- 主题切换入口当前是工具栏主题下拉菜单：结构在 `index.html`，交互和主题注册表在 `js/features/ui/theme-controller.js`，公共样式在 `css/themes/shared.css`。如果后续继续扩展主题菜单，不要把主题选择逻辑散回 `index.js` 或 `index.html` 内联脚本。
- `pink` 属于浅色主题链路：启动阶段在 `index.html` 的早期主题恢复脚本里，`color-scheme` 需要和 `light` 一样按浅色处理；如果后续新增新的浅色主题，同步检查这段启动脚本，不要只补 CSS。

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
- 修改主题切换入口、`themeId` 持久化字段、`data-app-theme` DOM 属性、主题菜单结构或 `css/themes/*` 文件组织
- 修改工作流序列化结构、默认工作流模板、导入导出契约
- 修改节点端口布局、动态端口、节点最小尺寸、缩放测量链
- 修改 `ImageGenerate`、`TextChat`、`Text`、`TextSplit` 的运行态数据结构或批处理语义
- 修改 `/proxy`、代理设置、允许域名、安全校验链路
- 修改更新下载、启动冲突检测、端口占用提示链路
- 修改 GitHub Actions 发布包、本地打包脚本、PyInstaller 参数或 Release ZIP 内容

## 修改前后的建议动作

- 修改前先用关键词检索责任文件，只读“责任文件 + 直接调用方”。
- 如果改的是主题，修改前先定位主题入口、主题注册表、当前主题文件和浅色/深色/其他主题覆盖范围；修改后至少手动检查主页、菜单、抽屉、弹窗、设置页、历史页、帮助页、右键菜单和节点内部控件，不要只看首页。
- 如果改的是主题相关结构，而不是单个颜色，额外检查 `index.html` 里是否还有会泄漏主题的内联样式；像缓存抽屉这类面板应优先改成 class + 共享 token，不要再依赖 `style*=` 选择器补漏。
- 修改后至少做受影响文件的语法检查。
- 如果启动过本地服务做验证，结束前确认不要留下本轮调试进程和临时文件。

## 参考文件

需要更完整的职责表、目录地图和常见需求落点时，打开：

- `references/architecture-map.md`

## 最近经验补充

- 修改 `js/features/execution/execution-core.js` 时，要特别小心节点 handler 对象里的 `},` 分隔符；少一个或多一个都可能让整个前端模块加载失败，表现为“右键菜单失效、画布不显示任何节点、应用看起来像没初始化”。
- 只要改了 `execution-core.js`、`index.js` 这类启动链关键文件，提交前至少做一次语法检查；当前项目可直接运行 `node --check js/features/execution/execution-core.js` 和 `node --check index.js`。
- 如果图片类节点已经有 `js/features/media/media-controller.js` 的统一同步函数，优先复用它，不要在 `execution-core.js` 再手写第二套 DOM 更新逻辑，否则很容易出现状态双写、局部修好但启动链或预览链被带坏。
- 处理节点输入输出兼容时，优先统一走 helper：图片输入用 `normalizeImageList` / `getPrimaryImageInput`，文本输入用 `getTextInputList` / `getPrimaryTextInput`；不要在各节点里继续直接假设 `inputs.image` 一定是单字符串，或 `inputs.text` 一定不是数组。
- `getCachedOutputValue()`、`workflow-runner` 聚合输出、`media-controller` 下游级联同步，这三层必须保持同一套“单值/数组”约定；如果只修其中一层，最容易出现运行看似成功、但下游节点偶发空白的隐形兼容问题。
- 优化节点连线时，优先改 `js/canvas/geometry.js` 的路径生成和 `js/canvas/connections.js` 的轻量 lane 分流，不要通过给输入端硬塞上拐折线来避让节点；这类局部硬拐通常很丑，也会让剪刀切线、插入预览和实际显示路径不一致。
- 连线算法需要保持“绘制路径、采样路径、插入预览、剪刀切线”同一套参数；如果给真实连线加了 `outputTransition`、`inputTransition` 或 `laneOffset`，同步检查 `getConnectionSamplePoints()` 的调用方，避免看起来的线和可交互的线错位。
- 在 Windows PowerShell 5.1 里，不要直接相信默认 `Get-Content` 看到的中文；当前环境默认编码可能是 `gb2312`，而仓库里的节点相关文件很多是 UTF-8（尤其是无 BOM 文件），会把正常中文误读成 `鍥剧墖`、`鑺傜偣...` 这类假乱码。
- 需要判断“文件内容真的坏了”还是“PowerShell 显示误判”时，优先用 `Get-Content -Encoding UTF8`，或直接用 Node `fs.readFileSync(path, 'utf8')` 复核；不要只因为 PowerShell 默认输出看起来像乱码，就立刻批量修文案。
- 遇到中文乱码排查时，先区分三种情况：1）文件本身是正常 UTF-8，只是 PowerShell 误读；2）文件内容里真的已经写进了乱码串；3）终端显示编码和文件读取编码同时混乱。只有在 UTF-8 复核后仍然显示 `寰幆杩炴帴`、`璇峰厛閫夋嫨...` 这类串时，才应当修改源码。
