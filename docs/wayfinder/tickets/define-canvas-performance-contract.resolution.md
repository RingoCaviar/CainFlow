# Resolution: Define the Canvas Performance Contract

Resolved: 2026-08-13

The development-only performance contract is:

- Measure each interaction as a continuous 10-second sampling run.
- Report instantaneous FPS, p95 frame time, node count, connection count, and the count plus attributed cause of frames exceeding 50 ms.
- Treat p95 frame time of 16.7 ms or less as passing on a 60 Hz display; target 10.0 ms or less on the current 100 Hz display.
- Enable the zero-dependency panel only through a development URL flag such as `?perf=1` or a developer shortcut. It must neither persist in settings nor appear in the release UI by default.
- Supply a deterministic mixed-node fixture with 200 nodes and 400 connections, including image previews, controls, running state, and long connections.
- Run a fixed manual sequence covering pan, zoom, node drag, and connection drag before recording each sample. Do not introduce browser automation yet, because the first measurements must include the real WebView2/GPU compositor path.
