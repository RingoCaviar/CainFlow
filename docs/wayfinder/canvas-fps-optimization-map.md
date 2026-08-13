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

## Not yet specified

<!-- No remaining in-scope decisions. The route is ready for implementation. -->

## Out of scope

- Redesigning the editor's node UI or changing workflow semantics solely for benchmark performance.

## Open child tickets

- [Define the Canvas Performance Contract](tickets/define-canvas-performance-contract.md)
- [Build the Canvas Benchmark Fixture and Telemetry Harness](tickets/build-canvas-benchmark-fixture-and-telemetry-harness.md)
- [Locate the Current Canvas Frame Bottlenecks](tickets/locate-current-canvas-frame-bottlenecks.md)
- [Choose the Adaptive Interaction-Quality Policy](tickets/choose-adaptive-interaction-quality-policy.md)
- [Set Evidence Gates for a Canvas or WebGL Migration](tickets/set-renderer-migration-evidence-gates.md)
