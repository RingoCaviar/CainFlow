---
type: wayfinder-ticket
status: closed
parent: ../canvas-scale-and-reuse-map.md
blocked_by: [canvas-performance-acceptance-profile.md]
labels: [wayfinder:task]
assignee: codex
---

## Question

After profiling the representative Canvas workflow, which rendering and connection-refresh strategy improves responsiveness while preserving node editing, selection, and connection correctness?

## Decision constraints so far

The user permits Offscreen nodes to use reduced rendering in favor of overall Canvas responsiveness. Reduced rendering must not discard workflow data, selection state, or connection semantics, and a node must regain its full presentation when it re-enters the viewport.

During Canvas pan and zoom, connections move with the Canvas transform and defer precise endpoint/path recalculation until the interaction settles.

During a node drag, only connections incident to the dragged Nodes update continuously; unrelated connections are corrected after the drag ends.

## Resolution

Use viewport-aware reduced rendering for Offscreen nodes while preserving all model and interaction semantics. Defer global connection geometry calculation during pan and zoom until Connection settle, and use drag-local connection updates while moving nodes. Validate this strategy against the dense Canvas performance profile before and after implementation.
