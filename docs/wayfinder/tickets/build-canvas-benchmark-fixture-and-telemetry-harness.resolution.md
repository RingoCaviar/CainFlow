# Resolution: Build the Canvas Benchmark Fixture and Telemetry Harness

Resolved: 2026-08-13

Implemented a development-only benchmark harness. With `?stressTest=1&perf=1`, use the development panel buttons:

- `Build 200/400 fixture` creates the deterministic mixed-node topology and SVG connections.
- `Start 10s sample` collects a 10-second sample and displays FPS, p95 frame time, 50 ms long-frame count, and accumulated time in render projection and full connection refresh.
- `Clear fixture` removes the test fixture and restores the pre-test canvas.

2026-10-09: Removed the redundant global console commands; the panel and module-level test interfaces remain available.

Release mode neither registers these helpers nor renders the panel. The render-projection and full-connection-refresh measurements are intentionally limited to development mode.

