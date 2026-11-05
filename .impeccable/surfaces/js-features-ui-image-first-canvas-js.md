---
version: 1
slug: "js-features-ui-image-first-canvas-js"
primary_target: "js/features/ui/image-first-canvas.js"
related_targets: ["css/features/image-first-canvas.css"]
---

# 节点参数浮层

Mode: Operate。范围：全部图片类节点共享浮层；生图节点为重点样板。用户已确认沿用七主题，提示词更舒适，其余参数紧凑；不迁移原本内嵌的文本/视频节点为浮层。

## Direction contract

THESIS: 内容优先的创作属性编辑器，以稳定头尾和有序字段替代零散按钮堆叠。

OWN-WORLD: 继承 CainFlow 七主题语义表面、系统字体、12px 浮层圆角。标题15px，正文14px，标签13px；强调色服务焦点与主操作。

STORY: 确认目标节点与模型，编辑提示词，按需展开参考、尺寸和高级设置，明确执行；参数编辑不触发生成。

FIRST VIEWPORT: 480px 默认宽；无标题栏与右上角工具；提示词编辑区在前，默认5行；全宽模型入口和紧凑设置行在下；固定底栏包含次数与主操作。中段滚动；窄面单列，低高度仍能编辑及执行，Esc 收起。

FORM: 用户确认的结构，无概念抽签（精确局部优化）；seed: none (not applicable)。标志交互为输入和展开时保持锚点、底部操作稳定；复用原控件，无新增装饰动画。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints and verification

保留原控件身份、已保存手动高度、节点几何、来源与批次、单组展开、主题、放大拖动、Agent共存。所有图片节点采用共享排版，其他内嵌节点不改变交互机制。全量测试覆盖共享浮层改动；真实浏览器验证七主题、窄低窗口、长内容、参数切换、缩放和回焦。无新位图资产。

## Finish evidence

2026-11-05：独立 finish reviewer 最终 disposition 为 ship，原三项视觉问题均 resolved；DESIGN.md 与 design.json 已同步。七主题、九节点、窄低窗口实测；最终影响范围 26 项复测通过。全量初轮及复测差异见 docs/qa/node-parameter-layout.md；不宣称最终全量绿灯。无新增发布位图。

## Live refinements

用户追加：生成结果移除白色外框；视角节点只保留无框缩略图，角度和输入摘要进入参数浮层，编辑入口沿用原独立编辑器。已在真实页面刷新验证；5项生成/批次综合检查及10项相机/紧凑编辑器检查通过。详细复测边界见 docs/qa/node-parameter-layout.md。

### Live 最终定位与背景约束

图片卡片保留主题底色，去掉装饰边框和内边距；禁止把节点背景改为透明。普通参数浮层按实际宽度与节点水平居中，触边时限制在视口内。垂直方向始终以下方锚点为目标，到达底部边界后停住，不自动翻到节点上方。图片导入省略标题条，上传 / URL 居中；全部参数浮层无标题栏和右上角工具，保留原始交互。

### Live 最新用户覆盖（所有参数浮层）

统一取消标题栏与右上角放大、关闭按钮；提示词编辑居前，模型与其他配置入口集中在下方。此决定覆盖先前独立标题栏、模型在提示词之前和导入关闭按钮的规范。浮层的语义名称仍保留，原控件和运行状态沿用真实节点。
