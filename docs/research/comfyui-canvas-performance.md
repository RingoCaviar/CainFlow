# ComfyUI 画布性能调查

调查日期：2026-08-13。来源仅限 ComfyUI 官方前端及其内置 LiteGraph 源码；以下链接固定到提交 `108425af1a254d6116306823d63a453444264ac2`，避免 `main` 变动后行号漂移。

## 结论

ComfyUI 的画布体验好，核心不是“平移时截一张位图快照”。其传统画布把节点、连线和背景绘制在 Canvas 2D 上；平移只更新一个相机 offset，并让 Canvas 在下一帧重绘。这样避开了大量节点 DOM 与 SVG path 在每次视图变换时的样式计算、布局、绘制和合成开销。

它也并非零成本：平移会同时标记前景和背景为 dirty，因此重画节点和连线。性能优势主要来自 Canvas 的批量绘制、可见节点裁剪、前/背景分层及可降质量渲染，而不是单纯不重绘。

## 源码证据

| 机制 | 源码事实 | 对性能的意义 |
| --- | --- | --- |
| Canvas 2D 主路径 | 应用创建 `LGraphCanvas(canvasEl, graph)`；该类负责 graph 的渲染与交互。[初始化](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/scripts/app.ts)；[类说明](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L281-L283) | 大量节点外观和常规连线不是独立 DOM/SVG 元素。 |
| rAF + dirty flags | `startRendering` 用 `requestAnimationFrame` 调用 `draw`；`draw` 仅在前景或背景 dirty 时重绘对应层。[循环](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L2161-L2185)；[dirty 分支](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5063-L5104) | 静止时不会无意义重画；更新合并到浏览器帧节奏。 |
| 相机平移是单一 offset | `processMouseMove` 在平移状态只按鼠标 delta 更新 `ds.offset`，随后 `_dirty()`；`DragAndScale.toCanvasContext` 对 2D context 做 scale/translate。[平移](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L3277-L3355)；[变换](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/DragAndScale.ts#L123-L126) | 不会逐节点改坐标；视图变化集中于渲染上下文。 |
| 两层 Canvas | 源码明确将“背景网格和连接线”与“节点”放在两个分离画布；前景先 `drawImage(bgcanvas)`，再画节点。[说明和调度](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5060-L5104)；[前景合成及节点循环](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5109-L5193)；[背景/连线](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5514-L5653) | 分离绘制职责；无需为每条连线维护 SVG DOM。 |
| 视口节点裁剪 | 每次需画前景时计算 `visible_nodes`：更新节点区域、仅保留与 `visible_area` 相交的节点；随后只遍历这份列表。[裁剪](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5035-L5048)；[使用](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5072-L5088) | 视口外的节点不参与前景绘制。 |
| 缩小时降质量 | 缩放低于阈值会进入 `low_quality`；节点渲染会跳过阴影、徽章并使用更简单的形状/绘制分支。[阈值](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L529-L535)；[节点分支](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5668-L5784) | 在大图缩小时主动削减高成本细节。 |
| 连线仍有成本，但在 Canvas | `drawConnections` 遍历节点输入和 links；每段连线先用包围盒与可视区域相交判断后才绘制。[连线循环](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L6041-L6126)；[段裁剪](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L6310-L6342) | 不是“连线免费”，但避开大量 SVG path 的 DOM/合成负担。 |

## 新版 Vue Nodes 的补充

ComfyUI 也在使用 Vue 节点，但不是把所有图形都迁移到 DOM/SVG：`GraphCanvas` 同时保留基础 Canvas、Vue 节点及 `LinkOverlayCanvas`。[组件结构](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/components/graph/GraphCanvas.vue#L58-L114)。Overlay 是绝对定位且 `pointer-events-none` 的 Canvas。[Overlay](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/components/graph/LinkOverlayCanvas.vue#L1-L42)

单个 Vue 节点使用绝对定位、`contain-layout contain-style` 和自身的 CSS `translate(...)`。[节点容器](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/renderer/extensions/vueNodes/components/LGraphNode.vue#L12-L37)。这说明它对必须使用 DOM 的部分也尽量限制布局影响；活动拖拽连线仍由 Canvas overlay 绘制。[overlay 连线分支](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/lib/litegraph/src/LGraphCanvas.ts#L5208-L5217)

图片路径也有特定 Chromium 规避：源码注释记录了高 DPR + GPU 下同帧 `drawImage(canvas)` 与 `drawImage(img)` 会导致严重掉帧，因此以 `queueMicrotask` 拆开两次绘制。[实现](https://github.com/Comfy-Org/ComfyUI_frontend/blob/108425af1a254d6116306823d63a453444264ac2/src/renderer/extensions/vueNodes/widgets/composables/useImagePreviewWidget.ts#L16-L40)

## 对 CainFlow 的建议

当前测量已排除“仅隐藏图片”和“仅隐藏 SVG 连线”两种临时降级。与其优先投入原生截图桥接，最接近 ComfyUI 已验证架构的后续验证顺序是：

1. 保证平移只更新节点层和连线层各自的一个视图 transform，绝不逐节点/逐线更新位置。
2. 将静态连线从 SVG 迁移至 Canvas 2D；拖拽中的单条交互连线可放在独立 Canvas overlay。
3. 对仍需 DOM 的节点使用 `contain: layout style paint`，并以 transform/translate 定位；加入视口外节点的 DOM 裁剪或轻量占位。
4. 用现有 `pan-*-interval-ms` 指标逐项复测。若这些架构性调整后仍被 WebView2 合成阻塞，再把“平移快照”作为兜底方案验证。

位图快照平移可以作为交互降级，但不是 ComfyUI 的常规平移路径，也会带来截图时机、清晰度、视频/动画节点与恢复一致性的额外复杂度。
