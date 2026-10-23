# UI 设计手册

## 紧凑开关

以顶部工具栏开关为视觉基准，适用于 Agent 联网等即时生效的二态设置。

- 轨道 30 × 18px，圆形滑块 12px，左右移动 12px；使用 transform 水平移动并垂直居中。有边框时扣除边框宽度，避免偏位。
- 标签与开关同一行，整行可点击，高度至少 28px。标签 12px，辅助说明 11px、行高 1.45；不把说明放进轨道。
- 关闭使用主题控件表面色与次要文字色；开启使用主题强调色及白色滑块。使用平面样式，不加发光或浮雕。
- 位置与背景变化沿用全局 --transition。只声明 transform、background-color、border-color，不使用 transition: all。
- 开关滑动属于表示开关状态的功能动画，全局关闭装饰动画时仍保留；prefers-reduced-motion 下即时切换，不影响设置保存。状态切换动画不延迟业务值更新。
- 使用原生 checkbox 与 role="switch"，提供关联 label、说明和清晰的键盘焦点；Space 可切换。禁用状态必须有实际业务原因，不凭模型厂商猜测联网能力。
- 固定盒模型并清除输入默认 margin/padding，不能继承普通文本框的 min-height。不要依靠 !important 修补冲突。
- 回归检查七套主题、窄面板、开关两态、滑块居中、点击命中、键盘和减少动画偏好。

参考实现：css/modules/01-toolbar.css、css/modules/07-node-controls.css；Agent 适配位于 css/prompt-agent.css。

- 切换开关时必须保留已挂载的控件，不因摘要或提示文字变化重建父浮层，否则 CSS transition 会被打断。动画回归应检测切换过程中的滑块中间位置，不能只检查 transition 声明。

- Agent 联网开关复用工具栏的 `.toggle-switch > input + .toggle-slider` 结构；轨道和滑块分别由 `.toggle-slider` 与其伪元素绘制。不要重新用 checkbox 的伪元素绘制，以免与工具栏的过渡、主题规则分叉。
