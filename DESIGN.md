---
name: CainFlow
description: 图片与节点关系居中的本地创作工作台
colors:
  light-primary: "#0f766e"
  light-canvas: "#edf3f9"
  light-node: "#ffffff"
  light-text: "#172033"
  light-secondary-text: "#526077"
  light-danger: "#dc2626"
  paper-primary: "#4e7669"
  paper-canvas: "#eeece7"
  paper-node: "#fbfaf7"
  paper-text: "#252823"
  dark-primary: "#0e7490"
  dark-canvas: "#1a1a2e"
  dark-node: "#1e1e34"
  dark-text: "#e8e8f0"
  pro-primary: "#5d7cff"
  pro-canvas: "#131722"
  pro-node: "#181f2e"
  pro-text: "#e5edf7"
  pink-primary: "#db2777"
  pink-canvas: "#fff4f8"
  pink-node: "#ffffff"
  pink-text: "#4a1d35"
typography:
  generation-action:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.25
  parameter-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
  parameter-prompt:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "14px"
    lineHeight: 1.65
  workflow-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "18px"
    fontWeight: 700
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "13px"
    lineHeight: 1.6
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "13px"
    fontWeight: 500
  mono:
    fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, "Courier New", monospace'
rounded:
  xs: "4px"
  sm: "6px"
  node: "12px"
spacing:
  compact: "4px"
  control-gap: "6px"
  toolbar-gap: "8px"
  section: "12px"
  viewport-inset: "16px"
components:
  canvas-navigation-icon:
    rounded: "{rounded.sm}"
    height: "34px"
    width: "34px"
  button-primary:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-node}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  parameter-panel:
    typography: "{typography.body}"
    rounded: "16px"
    width: "560px"
  parameter-panel-title:
    typography: "{typography.parameter-title}"
  parameter-panel-content:
    padding: "12px"
  parameter-panel-prompt:
    typography: "{typography.parameter-prompt}"
    padding: "6px 8px"
    rounded: "10px"
  parameter-panel-model-entry:
    width: "100%"
    padding: "0 10px"
    rounded: "8px"
  parameter-panel-footer:
    padding: "0 12px 12px"
---

# Design System: CainFlow

## Overview

**Creative North Star: "创作工作台"**

图片、结果与节点关系构成工作台主体；工具保持紧凑，参数和辅助创作按需展开。按钮与输入框的表达克制、明确，界面通过真实状态、清楚的操作层级和可恢复的编辑过程建立可信度。

七套主题共享语义角色和组件结构，同时保留各自的表面材质、配色与阴影。用户当前选择的主题是迭代依据，不能把某一主题的视觉语言推广为全部主题的要求。2026-11-05 的界面观察为纸色主题；应用默认主题仍由当前常量与用户设置决定。

**Key Characteristics:**

- 图片主体卡片与可平移、缩放的节点画布。
- 系统字体、紧凑控件、按需展开的节点参数浮层。
- 语义主题色、可辨识边框、随主题变化的表面与阴影。
- 画布、非模态编辑浮层、菜单和真实模态具有明确层级。

本文件按现有实现归档；描述用语已由用户确认。机器可读色值是命名主题的快照，组件示例通过 CSS 变量跟随当前主题。后续实现须核对 CSS 级联，不能用这些快照覆盖主题源文件。

## Colors

### Primary

明亮主题以青绿承载主要操作，纸色主题以灰绿点缀暖纸色，暗色主题使用青蓝，专业主题使用偏蓝的强调色，粉色主题使用玫红。对应快照分别见 frontmatter 的 `light-primary`、`paper-primary`、`dark-primary`、`pro-primary` 和 `pink-primary`。

玻璃明亮与玻璃暗色使用各自主题文件中的强调色及透明表面，保留背后画布对材质的影响；其颜色必须连同下层表面理解，不能简单替换为不透明色块。精确值以 `css/themes/glass-light.css` 和 `css/themes/glass-dark.css` 为准。

### Secondary

图像、文本、参数和通用端口各有语义颜色，随主题变化。它们表达输入输出类型，不能随装饰需要重新指派。成功、警告和危险也各有独立角色；可读的彩色文字使用共享前景映射，不直接假定强调色适合正文。

### Neutral

画布、节点、输入框、工具栏和浮层使用不同表面。各主题的 canvas、node、text 快照列在 frontmatter；更完整的 panel、border、hover、active 与 overlay 角色由主题 CSS 提供。纸色保留暖中性色，明亮主题保留冷浅色底，暗色与专业主题保留各自的深色层次。

**The Semantic Roles Rule.** 使用现有表面、文字、边框、焦点、危险和状态语义变量。主题提供色板，组件所属样式负责结构与状态；不得为单次迭代建立重复主题体系。依据 `docs/adr/0004-semantic-theme-skin.md`。

## Typography

**Body Font:** 使用 frontmatter 的系统无衬线字体栈，覆盖 Windows 与 macOS 的中文回退。

**Label/Mono Font:** 按钮和标签沿用系统字体；代码、协议与技术内容使用现有等宽栈。不新增展示字体或假定已加载网络字体。

### Hierarchy

- **Generation action:** 生图节点的生成按钮使用 generation-action 规格和主题正文色，在现有按钮内提高文字可读性。
- **Workflow title:** 顶部当前工作流名称使用 workflow-title 规格和可读强调文字色，复用现有 `text-link` 语义；单行超长截断，悬停保留完整名称。窄窗口限制占宽，保留字号与字重，给其他操作留出空间。
- **Title:** 节点选择器标题使用 frontmatter 的 title 规格；它不是全产品的统一标题尺寸。
- **Body:** 节点参数浮层采用 body 规格，较长提示词与回复允许选择和复制。
- **Label:** 基础按钮采用 label 规格；辅助信息在现有组件中另有较小字号。新界面须结合当前使用场景及 `docs/ui-handbook.md` 的关键入口可读性要求，不能把较小辅助字号扩展到主要操作。
- **Mono:** 仅用于适用的技术内容，不替代普通中文操作标签。

当前没有统一等比字体阶梯或营销展示字系统；不得从几个字号推导并强制推广一套新的比例。

## Layout

图片导入与图片生成节点的具体外观、参数顺序和验收标准见 [节点样式规范](docs/node-style-spec.md)。该规范记录最新确认的无边框节点与无标题栏节点参数浮层。

主区域为无限画布，顶部工具栏按品牌、工作流、运行、创作、工具与设置组织。工具栏支持自动收起与固定，空间不足时操作组换行。抽屉覆盖或占用相应可用空间，不沿用已移除的左侧工具栏留白。

画布节点取消装饰边框，保留当前主题底色；选中、运行和错误继续有明确的状态提示。图片类节点移除图像外侧留白，按真实媒体比例完整展示，保留轻圆角及缺失、恢复和空状态。图片导入与视角节点的画布内容以缩略图为主，文件选择、尺寸、角度和输入摘要放进其节点参数浮层；视角编辑沿用既有独立编辑器。文本、视频等其他节点保留原有内容与控件结构。

节点参数浮层在画布变换外定位，默认宽度由 frontmatter 的 parameter-panel 记录，并受视口宽度限制。全部图片类参数浮层省略标题栏及右上角放大、关闭按钮；内容直接开始，设置入口位于内容下方。编辑参数不改变节点或端口的画布坐标，不自动平移画布。

画布导航位于右下，使用 viewport-inset 的边缘留距。助手打开时导航避让其宽度；小窗口允许导航换行。间距条目是现有重复值的归档，并非新增的全局 CSS 变量或要求所有组件只能使用这些值。

现有响应规则按具体组件分布，包括窄导航窗口、节点参数上下文与主题菜单等；对应断点见 sidecar 与所属源码，不将它们误写为统一设备分类。

## Elevation & Depth

系统结合表面色、可见边框和随主题变化的阴影表达层级。节点有静止及悬停阴影，浮层使用面板层级；部分设置容器明确无阴影。玻璃主题的透明度和模糊是其材质特征，不应推广到其他主题。

阴影扩展记录在 `.impeccable/design.json` 中，并直接引用现有变量。菜单和弹窗使用共享层级角色，真实模态位于普通参数浮层和 Agent 之上；不能用不断增加的任意 z-index 修补交互。

**The Functional Depth Rule.** 层级首先服务遮挡关系、焦点和操作可达性。浮层置顶不能丢失另一窗口的草稿、附件与后台任务。

## Shapes

常用圆角为 frontmatter 的 xs、sm 和 node；节点、节点参数浮层和部分弹窗采用较大圆角，普通控件更紧凑。菜单和画布导航另有其现有圆角，不强制归并为一个形状。

控件与表面之间保留可辨边界。基础按钮边缘来自共享规则，工具栏主操作与较轻的次级操作有不同边框处理；按最终级联判断，不能只摘录早期基础规则。图像保留自身长宽比，交互圆点与其命中区域分别处理。

## Components

### Buttons

按钮明确表达动作与主次。基础间距和字号见 frontmatter；运行与主要操作使用所属主题的填充强调色，普通操作较轻，危险动作使用危险角色。工具栏有独立高度和边缘规则，参见 `css/features/button-edges.css`，不把基础按钮尺寸硬套到工具栏。

悬停、按下、键盘焦点与禁用状态由当前所属样式共同决定。禁用不可只通过标签文字说明；键盘焦点仍应可见。全局装饰动画关闭时，保留运行、进度和破坏性确认的功能反馈。

### Inputs / Fields

输入框使用主题输入表面、输入边框和正文色。节点参数、设置与菜单各有组件所属焦点映射，不能只靠轻微表面变化表示焦点。错误和禁用状态沿用各组件已有语义角色，保留原生文字编辑与撤销。

### Cards / Containers

节点、设置卡片与抽屉使用各自表面语义，避免为每个容器叠加独立装饰。图片卡片优先完整展示作品；无结果时使用真实空状态，不能把参考图当生成结果。

### Navigation

顶部工具栏将工作流与运行操作保持易达；更多工具收进分组菜单。画布缩放工具显示当前比例，并保留适应画布和节点查找。菜单支持键盘移动、Esc 与回焦，低高度窗口内部滚动。

画布导航同排控件统一高度，图标按钮尺寸见 frontmatter，图标本身保持现有大小。只读比例文字保留其输出语义，鼠标命中交给外层展开入口，不能阻断菜单的原生点击。生图主操作沿用共享焦点颜色与可见焦点环。

### Reference Groups

参考图按真实来源与批次保留身份，视觉上用 64px 方形缩略图网格紧凑排列并限高滚动；序号叠在右下角，不另占一行。名称与张数只保留为悬停和读屏信息，拖拽与断开均操作整组来源，不能将正在浏览的一张图呈现为完整输出。右上角断开按钮在悬停/键盘聚焦时出现，触摸设备保持可达；断开不删除来源节点或原图，并支持撤销。

### Image Parameter Panel

全部九种现有图片类参数浮层沿用七主题语义表面；原本内嵌的文本和视频参数继续内嵌。浮层默认宽 560px、圆角 16px，无标题栏和右上角工具按钮，底栏不随中段内容滚动；普通控件与标签 13px，提示词 14px/1.65。生图节点的提示词在前并使用全宽，底部单行提供尺寸、模型、独立“更多设置”、次数与生成入口；底栏尺寸入口只设置宽高比与分辨率，模型入口只设置模型与供应商，三个入口的弹层内均无分类切换；共享内容间距 12px、字段网格间距 10px 12px，普通输入控件最小高度 34px。内容区和底栏的常规内距见 frontmatter；视口高度不超过 540px 或宽度不超过 480px 时收紧内距，视角控制保留所属紧凑规则。提示词默认 2 行，随内容自动增长至最多 6 行；超过后框内滚动，删短后缩回。禁用手动拖高，旧保存高度不覆盖自动限制。生图浮层不显示“设置待生成”提示行，底层参数修订状态继续保存。次数与主操作留在右下底栏；缩放节点的模式、滑轨和滑块使用主题输入、选中与强调语义。

节点参数浮层与 Agent 可共存，必要时通过置顶入口找回。普通模式锚定当前节点，展开、输入和组切换保持稳定；放大模式仍使用同一组控件并保留拖动与尺寸调整。全部浮层不显示标题条、放大与关闭按钮；导入浮层的上传/URL 模式切换居中，其原始文件按钮和尺寸信息在内容区。窄内容区（不超过 340px）字段网格改单列。参数保存与生成执行分开，不为视觉简化重新实现一份脱离真实节点状态的表单。

## Do's and Don'ts

### Do:

- **Do** 先读取当前主题、组件所属样式与最终级联，再沿用其颜色和结构。
- **Do** 让图片、连线关系和当前操作目标保持清晰，工具按需展开。
- **Do** 同时保留 hover、focus-visible、active、disabled 和实际运行状态。
- **Do** 核对适用主题与实际窗口尺寸，按 `docs/testing.md` 选择验证范围。

### Don't:

- **Don't** 将纸色、明亮、暗色、专业、粉色或玻璃主题中的任意一种固定为全产品唯一视觉。
- **Don't** 从基础 CSS 中截取旧值覆盖后续共享皮肤和按钮边缘规则。
- **Don't** 为界面迭代新增事实文案、假进度、虚构结果或默认付费请求。
- **Don't** 留下临时 variant wrapper、预览 CSS、重复 ID 或脱离真实行为的交互控件。

文本节点沿用图片卡片的无装饰边框与无阴影主题表面，编辑区取消内框并使用 14px/1.65 的产品字体，保留 12px 文本内距及键盘焦点。标题仅在选中时浮于卡片上方；多条文本导航、输入输出端口和原始文本控件继续工作。


生图参数浮层采用“上方全宽文本框、底部一行”布局：不显示提示词标题，移除让助手优化入口；底栏依次为尺寸、模型、更多设置、次数、生成。尺寸仅设置比例与分辨率，模型仅设置模型与供应商；更多设置不提供分类跳转，宽度上限 400px 并贴近更多入口。参考图采用无名称行的方形缩略图网格，序号叠加、按来源拖拽排序、悬停显示断开按钮。质量、背景、内容审核同排等宽；不支持的字段隐藏后，其余短控件平分一行。系统提示词全宽、两行起步、最多六行，保留浅边框和 12px 分组间距；支持的思考设置在底部原位折叠。原表单控件及保存语义保留。
