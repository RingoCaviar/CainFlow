# Resolution: Build the Canvas Benchmark Fixture and Telemetry Harness

Resolved: 2026-08-13

Implemented a development-only benchmark harness. With `?stressTest=1&perf=1`, the console exposes:

- `createCanvasStressTestNodes({ total: 200, imageImportCount: 50, connectionCount: 400 })` to create the deterministic mixed-node topology and SVG connections.
- `sampleCanvasPerformance()` to collect a 10-second sample and display FPS, p95 frame time, 50 ms long-frame count, and accumulated time in render projection and full connection refresh.

Release mode neither registers these helpers nor renders the panel. The render-projection and full-connection-refresh measurements are intentionally limited to development mode.

