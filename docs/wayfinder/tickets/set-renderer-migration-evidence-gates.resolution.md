# Resolution: Set Evidence Gates for a Canvas or WebGL Migration

Resolved: 2026-08-13

- First implement and measure the agreed DOM/SVG fast paths: transform-only pan/zoom, connected-path-only node dragging, and reversible performance protection.
- If the 200-node/400-connection benchmark still fails p95 ≤ 10.0 ms in two consecutive runs, Canvas may incrementally render non-interactive connections. DOM nodes remain authoritative.
- Consider WebGL only if the Canvas connection path also fails the target, or if a 500-node/1000-connection benchmark must sustain 100 FPS.
- Every renderer retains DOM nodes, keyboard and mouse reachable ports, connection click/double-click editing, and accurate selection/running states. A development switch must return rendering to SVG.

