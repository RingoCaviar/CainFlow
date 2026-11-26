# Canvas FPS Optimization Map

Status: open  
Label: `wayfinder:map`

## Destination

Define an evidence-backed implementation plan that makes CainFlow's canvas interaction smooth with 200 realistic nodes and 400 connections: at least 60 FPS during pan and zoom, and a 100 FPS target for the current 100 Hz display. The plan covers panning, zooming, node dragging, and connection drawing.

## Notes

- The current renderer is a DOM node layer plus an SVG connection layer.
- First exhaust safe optimizations in the existing DOM/SVG pipeline. Canvas or WebGL may be introduced incrementally only if measured evidence shows that pipeline cannot meet the target.
- During interaction, non-essential visuals may degrade: shadows, background-grid updates, offscreen node content, and unselected connection effects. Geometry, selection, running nodes, and the in-progress connection must remain accurate. Full quality returns on the next settled frame.
- The benchmark must use realistic mixed nodes, including image previews, controls, running state, and long connections.
- Each implementation phase must be measured through a development-only performance panel that reports frame time, node count, connection count, and long-frame causes.

## Decisions so far

- [Define the Canvas Performance Contract](tickets/define-canvas-performance-contract.md) — Use a zero-dependency, development-only 10-second benchmark with FPS, p95 frame time, and attributed 50 ms long frames against a deterministic 200-node/400-connection realistic fixture; target p95 ≤ 10.0 ms for the current 100 Hz display.
- [Build the Canvas Benchmark Fixture and Telemetry Harness](tickets/build-canvas-benchmark-fixture-and-telemetry-harness.md) — Development flags now expose a mixed-node/connection fixture and 10-second FPS, p95, long-frame, render-projection, and full-connection-refresh telemetry.
- [Locate the Current Canvas Frame Bottlenecks](tickets/locate-current-canvas-frame-bottlenecks.md) — The isolated 200/400 baseline reaches 92.9 FPS and p95 10.10 ms; full SVG connection refresh dominates (2217.2 ms versus 47.3 ms for node projection), so retain DOM nodes and prioritize connection-refresh fast paths.
- [Choose the Adaptive Interaction-Quality Policy](tickets/choose-adaptive-interaction-quality-policy.md) — Pan/zoom transform the connection group without path recomputation, dragging updates only connected paths, and a reversible long-frame guard temporarily disables non-essential connection and grid effects.
- [Set Evidence Gates for a Canvas or WebGL Migration](tickets/set-renderer-migration-evidence-gates.md) — Only migrate non-interactive connections to Canvas after two failed 200/400 DOM/SVG runs; reserve WebGL for a failed Canvas path or a 500/1000-at-100-FPS requirement, while preserving DOM editing and an SVG fallback.

## 静态连线缓存优化方案

以 `f938be26` 为起点，先在 Windows WebView2 上重新测量现有 SVG 路径。按既有门槛决定是否试验静态连线位图缓存。节点继续走 DOM，工作流模型提供拓扑，`ConnectionProjection` 统一处理连线几何、刷新和手势收尾。依据 [ADR-0001](../adr/0001-centralize-connection-projection.md)。

### 为什么先看连线

- Atelier 1.3 的内嵌前端将普通静态连线合成 Canvas 2D 位图。平移主要移动已绘制的位图，缩放先变换位图，比例变化达到阈值时才补画。正在拖动、选中或运行的连线可独立更新。两款应用在 Windows 上都使用系统 WebView2，因此有直接借鉴价值的是连线层的绘制和失效策略。
- CainFlow 的历史记录已在一个 7 节点、5 连线、5 图片的真实工作流中定位到 SVG 重锚定尖峰。旧路径重锚定帧间隔 p95 约 52 ms，隐藏连线层后 5 次测量均无尖峰。改为按视口计算余量后，该工作流整体 p95 约 10.1 ms。该记录来自有头 Chrome，适合定位问题。当前版本的桌面 WebView2 基线需要重新采样。
- 当前分支已实现节点外壳虚拟化和视口运动期间延迟测量。现有 Canvas 2D 实验默认关闭，并在变换时清空和重画。试验的核心工作是补齐位图复用和失效管理。参见 [视口变换](../../js/canvas/viewport.js)、[节点渲染投影](../../js/canvas/render-projection-manager.js) 和 [实验连线渲染器](../../js/canvas/canvas-connection-renderer.js)。

### 实施顺序

| 阶段 | 改动 | 进入下一阶段的条件 |
| --- | --- | --- |
| 0 回测现有 SVG | 用开发面板复用 200 节点／400 连线夹具，补充脱敏的 7／5／5 工作流或同结构复刻，以及图片较多的副本。分别记录平移、缩放、节点拖动、绘制连线。将长帧和 SVG 重锚定、几何刷新、光栅化以及图片解码事件对齐。 | 200／400 场景同一手势连续两次超过 100 Hz 下 p95 ≤ 10.0 ms 的目标，且追踪仍指向连线绘制，才进入 Canvas 验证。通过时保留现有 SVG 路径。 |
| 1 开发开关下验证平移 | 从已有连线投影消费世界坐标曲线。普通静态贝塞尔线按样式批量画入带余量的 Canvas 2D 位图。保留现有 SVG 交互路径，只隐藏已由位图覆盖的静态描边。视口范围在缓存内时只变换画布层。 | 短距离平移没有静态重绘和额外端口布局读取。长距离平移穿过缓存边界时，连线无空白、重影或跳位。同一手势的长帧减少。 |
| 2 补齐缩放、手势收尾和生命周期 | 缩放先复用位图，达到重画阈值或手势停止后恢复清晰度。将节点移动影响的连线交给动态 SVG，结束后重新合入静态层。接入拓扑、样式、工作流切换和资源回收。 | 达到下面的性能及交互验收，能用开发开关即时退回 SVG。 |
| 3 按追踪结果优化节点或媒体 | 静态连线达标后，如果密集画布仍受节点绘制或图片解码限制，再分别验证缩小时简化控件、按可见性和选区加载缩略图，以及限制解码并发。保留屏内图片和选中节点可用。 | 每项独立对照，优化对应的长帧来源。达到已定目标即收敛。 |

阶段 0 使用 `?stressTest=1&perf=1` 的开发面板。现有采样可用来跑固定混合序列。另用实际输入在有头 WebView2 上做每种手势各 10 秒的采样，避免夹具每帧额外触发的投影工作掩盖正常输入路径。现有夹具以轻量图片为主，图片解码用额外的图片密集场景测量。依据 [基准夹具和采样入口](tickets/build-canvas-benchmark-fixture-and-telemetry-harness.resolution.md) 和 [渲染器迁移门槛](tickets/set-renderer-migration-evidence-gates.resolution.md)。

### 缓存和交互规则

- **谁管理缓存**。由 `ConnectionProjection` 根据现有几何、可见性、样式、拓扑和手势意图更新渲染器。普通调用方沿用现有入口。Canvas 2D 渲染器管理位图覆盖范围、分辨率、绘制与释放。采用现有端口测量和贝塞尔几何。首轮保留正交线走 SVG，单独验证线宽、主题色和同一端口多连线的偏移。
- **何时重画**。平移使用世界坐标缓存和视口余量。缓存不再覆盖视口、端点/路由或样式失效、视口尺寸或设备像素比变化时才重新绘制静态层。初轮以缓存缩放比例变化约 15% 作为重画阈值起点，用 A/B 决定最终值。将 DPR、位图尺寸和总像素数设为有上限的预算。记录画布缓冲区像素数，并测高 DPI 下的内存和光栅化成本。
- **怎么保持交互准确**。选中、悬停/检查、追踪、运行、临时连线以及被拖节点关联的连线继续使用动态 SVG 表现。复用现有 SVG 命中及几何索引，验证透明静态线的点击、双击、剪线和插线。先完成新投影再切换其可见性，避免同一连线重复显示。若透明命中路径仍反复光栅化，先由追踪确认成本，再评估将静态命中迁入现有几何索引。
- **怎样收尾和回退**。接入已有的画布几何稳定信号，重新确认端口位置和清晰度。合并同一帧内的失效，丢弃来自旧工作流或旧缓存版本的延迟更新。检查工作流切换、删除、撤销和重做。位图尚未就绪、超出预算、Canvas 2D 初始化失败，或关掉开发开关时，直接让 SVG 恢复完整显示及命中。
- **保持模型和自动化一致**。缓存从画布渲染投影读取数据。实现时检查内置 Agent 和 Canvas MCP 的入口、公共字段投影和参数校验，并覆盖编辑、保存、撤销和运行状态在两种后端下的等价行为。依据 [ADR-0025](../adr/0025-scoped-canvas-automation.md)。

### 验收和发布决定

- **测量方法**。同一机器、屏幕刷新率、WebView2、窗口尺寸、DPR、主题和工作流，交替测当前 SVG 与实验路径。预热后每场景至少取 3 组，保存每组数据。冷启动和首次出现图片另外记录。比较 FPS、p95/p99 帧间隔、超过 50 ms 的帧数、静态层重绘次数、重绘耗时/像素量和手势结束后的恢复时间。用 Chromium 追踪区分主线程布局与光栅化/合成。
- **性能通过条件**。200／400 基准中的平移和缩放达到 100 Hz 的 p95 ≤ 10.0 ms 目标，或在 60 Hz 环境达到 p95 ≤ 16.7 ms。7／5／5 小工作流的平移 p95 和长帧数维持当前 SVG 基线水平。触发缓存重建和手势收尾时计入长帧报告。节点拖动和连线绘制的 p95、长帧数均不回退，稳定后清晰的线条和端口最多 120 ms 内对齐。
- **行为通过条件**。检查缩放锚点、长距离往返平移、快速切换手势、密集交叉线和互相重叠的命中顺序。验证选中样式、运行态、键鼠端口、连线编辑、节点拖动、撤销以及工作流恢复。用现有连线投影、视口和画布合成用例做定向回归，新增的缓存复用、失效和回退用例登记到 `scripts/test-groups.json`。测试范围按 [测试分层与执行](../testing.md) 选择。
- **发布决定**。功能和桌面性能达标后再决定默认开启。收益不足或行为有回归时维持当前 SVG 默认路径。Canvas 2D 仍达不到目标，或 500 节点／1000 连线须达到 100 FPS 时，再按既有门槛评估 WebGL。

### 首轮 WebView2 实施记录

2026-11-26，使用隔离的 Windows 桌面实例，WebView2 158.0.4370.33、1364 × 861 CSS 像素、DPR 1。每轮输入持续 10 秒，帧间隔以 `requestAnimationFrame` 采集。

| 200 节点／400 连线场景 | p95 帧间隔 | 超过 50 ms 的帧 |
| --- | ---: | ---: |
| 原视口连续缩放，现有 SVG | 60.1、70.2 ms | 67、100 |
| 原视口连续缩放，隐藏整个 SVG 连线层 | 10.1 ms | 0 |
| 适配全部节点后，现有 SVG 连续缩放，完成的一轮 | 40.1 ms | 1 |
| 同一适配视口，实验位图连续缩放 | 40.1 ms | 1 |
| 同一适配视口，实验位图平移 | 10.1 ms | 5 |

隐藏整个 SVG 层的对照包含坐标轴和动态线。原视口没有位图候选连线，因此这组结果用于定位渲染层，不能量化静态位图收益。适配全部节点后，实验中有 320 条连线可进入位图，平移 971 个活动帧中启用 969 帧，缩放 302 个活动帧中启用 301 帧。同场景 SVG 对照的另一次输入调用超时，现有数据还不足以确认稳定收益。SVG 继续作为默认渲染路径。

给开发 URL 增加 `?perf=1&canvasConnections=1` 可试用。用实际中键拖动和滚轮输入观察位图切换。开发面板的固定脚本序列仍用于原有混合投影采样。实验将在常规贝塞尔线已完成投影时使用位图，停止手势后恢复 SVG。长距离平移穿过尚未投影的区域、真实图片解码压力和高 DPI 下的收益仍需测量。

#### 默认 SVG 坐标轴修复

在原视口单独隐藏 `#origin-axes`，或缩短两条虚线并保留可见坐标轴，两种隔离对照的缩放 p95 都是 10.1 ms，超过 50 ms 的帧均为零。默认 SVG 改为绘制有余量的轴段。视口移动出余量或大幅放大时重建轴段，尺寸和滚动变化由对应事件更新范围。正常平移继续复用现有 SVG 锚点。见 [视口投影实现](../../js/canvas/viewport.js)。

在原视口复测默认 SVG 的两轮 10 秒连续缩放，p95 由原来的 60.1／70.2 ms 降为 10.1／10.1 ms，长帧由 67／100 降为 0／0，平均 99.3／100.0 FPS。这个结果与 100 Hz 刷新间隔接近，比 p95 ≤ 10.0 ms 的目标高 0.1 ms。两轮平移的 p95 均为 10.1 ms，其中一轮仍有一次 110 ms 尖峰。

另用 7 节点／5 连线／5 图片和 60 节点／100 连线／28 图片的合成工作流各采样一轮，作为后续图片压力对照。小型场景平移／缩放 p95 为 10.1／30.1 ms，图片密集场景为 20.1／10.1 ms。这两组是单轮样本，不能用于判断位图缓存收益。

#### 重复平移首帧

在 200 节点／400 连线的适配视口中，通过重复中键短拖复现约 30–40 ms 的 p95。隔离对照发现，隐藏整个 SVG 层后仍有松手附近的长帧。跳过连线收尾校验的样本 p95 为 40 ms，和两组正常样本的 30.1／40.0 ms 重叠。两组短时保留 SVG 合成层的试验也未见稳定收益，继续沿用原来的手势结束释放方式。

平移首帧计算 SVG 余量时复用现有 `ResizeObserver` 已观测的画布宽高。改动前，15 次手势为这个计算同步读取了 30 次宽高，单次最长约 0.3 ms。改动后的 14 次手势中，这项计算没有再同步读取宽高，窗口变化后的下一次手势按最新尺寸计算余量。该样本 p95 仍为 40.0 ms，首轮保留的长帧最大 120 ms，剩余瓶颈仍需单独定位。见 [视口投影实现](../../js/canvas/viewport.js)。

同一 WebView2 窗口的 200／400 对照中，连续 4.5 秒的重复平移和滚轮缩放曾分别排队 78 和 45 个空连线投影回调。现在只为待处理的连线、节点或全量投影排队，复测两项均为零。相同测量中平移 p95 为 39.9 → 40.0 ms，缩放 p95 均为 40.1 ms。定向回归覆盖视口运动期间无空投影，以及手势结束仍做连线校验。见 [连线投影实现](../../js/canvas/connection-projection.js)。

#### 运行中连线的流动箭头

WebView2 CPU 采样将缩放收尾的大量时间归到刷新连线时执行的 `getTotalLength()`，将重复平移期间的热点归到箭头动画的 `getPointAtLength()`。原代码边读取 SVG 路径边写入箭头变换。现将长度测量移出连线路径投影，每个动画帧先集中读所有运行中路径，再集中写箭头变换和透明度。路径数据相同时复用长度，变更后重测。短线仍不显示箭头。

同配置 200 节点／400 连线的独立桌面窗口中，两个 5 秒重复平移样本的 Chromium 布局次数从 6,885／12,493 降到 195／153。两边聚焦窗口的第二轮滚轮缩放从 87,921 降到 136，帧间隔 p95 从 40.1 降到 30.0 ms。平移 p95 由 40.0／40.0 ms 变为 49.9／40.1 ms，超过 50 ms 的帧由 3／4 变为 8／8。聚焦缩放对照的超过 50 ms 帧由 2 变为 5。布局工作有明显下降，长帧仍有波动。 [流动箭头实现](../../js/canvas/connections.js)

随后在同一个聚焦的 WebView2 窗口中，以 200 节点／400 连线适配视口运行 4.5 秒的交替缩放对照。常规更新频率下，两轮的 `getPointAtLength()` 调用为 190,400／187,040 次，帧间隔 p95 均为 30.1 ms。手势期间将箭头更新频率限制到 15 FPS 后，两轮调用均为 72,800 次，p95 均为 20.0 ms。四轮各有一帧超过 50 ms。重复平移样本波动较大，尚无稳定的帧间隔收益。

沿用现有密集画布模式，仅在平移和缩放期间降低箭头更新频率。箭头持续显示并按实际时间计算位置，手势结束后自动恢复常规更新频率。 [流动箭头实现](../../js/canvas/connections.js)

#### 缩小全图时的运行状态

聚焦窗口内的 CPU 采样仍将重复平移的主要脚本时间归到 `getPointAtLength()`。使用独立 SVG 路径采样和缓存节点投影的视口尺寸，两种隔离对照的平移 p95 仍约 60 ms。适配 200 节点／400 连线后，缩放比例约 11.4%，八个世界像素高的箭头投影后小于一个 CSS 像素。

缩放低于 12.5% 时，普通运行中连线改用静态运行色，跳过箭头的路径采样和变换写入。悬停、选中、追踪和运行路径标示继续按原有优先级显示。放大到阈值时，按当前时间恢复箭头位置。聚焦 WebView2 的两组 4.5 秒重复平移对照中，p95 从 50.0／50.0 ms 降至 10.1／19.9 ms，超过 50 ms 的帧从 8／8 降至 0／0。最终代码两轮复跑的 p95 为 20.0／10.2 ms，超过 50 ms 的帧为 1／0。连续缩放跨过阈值时，p95 仍约 20 ms。 [流动箭头实现](../../js/canvas/connections.js)

## Out of scope

- Redesigning the editor's node UI or changing workflow semantics solely for benchmark performance.

## Open child tickets

- [Define the Canvas Performance Contract](tickets/define-canvas-performance-contract.md)
- [Build the Canvas Benchmark Fixture and Telemetry Harness](tickets/build-canvas-benchmark-fixture-and-telemetry-harness.md)
- [Locate the Current Canvas Frame Bottlenecks](tickets/locate-current-canvas-frame-bottlenecks.md)
- [Choose the Adaptive Interaction-Quality Policy](tickets/choose-adaptive-interaction-quality-policy.md)
- [Set Evidence Gates for a Canvas or WebGL Migration](tickets/set-renderer-migration-evidence-gates.md)
