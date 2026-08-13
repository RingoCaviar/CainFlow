# Resolution: Locate the Current Canvas Frame Bottlenecks

Resolved: 2026-08-13

Using the isolated 200-node/400-connection fixture in the Codex browser, a 10-second mixed interaction run produced:

- 92.9 FPS, with p95 frame time of 10.10 ms.
- Seven frames above 50 ms.
- 47.3 ms cumulative render-projection time.
- 2217.2 ms cumulative full SVG connection-refresh time.

The 60 Hz p95 requirement passes, but the current 100 Hz target (p95 ≤ 10.0 ms) narrowly fails by 0.10 ms. Full connection refresh is the dominant measured cost by a wide margin; node DOM projection is not currently a priority. The first implementation route should avoid full SVG path recomputation during panning and zooming, then restrict node dragging to connected paths only. Reassess Canvas/WebGL only after those DOM/SVG fast paths are measured.
