---
type: wayfinder-map
status: open
labels: [wayfinder:map]
---

## Destination

Produce an implementation-ready, verified plan for a more responsive CainFlow Canvas at larger workflow sizes, with reliable canvas context-menu copy/paste and History-image drag-and-drop reuse.

## Notes

Canvas vocabulary is maintained in `CONTEXT.md`. Consult the `cainflow-project`, `grilling`, and `domain-modeling` skills while resolving this map. This map plans the work; implementation follows once its decision frontier is cleared.

## Decisions so far

- [Canvas copy/paste and History-image drop contract](tickets/canvas-copy-paste-and-history-drop-contract.md) — Canvas whitespace pastes at the pointer; node menus expose copy, paste, and delete; dropping a History image creates an Image import node at the release point and retains the History image.
- [Canvas performance acceptance profile](tickets/canvas-performance-acceptance-profile.md) — Judge responsiveness with comparable representative stress workflows and interaction long-frame measurements, not a fixed node-count promise.
- [Canvas rendering hot-path strategy](tickets/canvas-rendering-hot-path-strategy.md) — Reduce Offscreen-node rendering, settle global connections after viewport movement, and update only dragged-node connections continuously.
- [Canvas render-projection safety](tickets/canvas-render-projection-safety.md) — Virtualization and LOD are reversible render projections with persistent node shells, immutable source images, always-rendered connections, Dense-mode effect reduction, and release-blocking data-integrity tests.

## Not yet specified

- Concrete LOD, Dense-mode, and viewport-buffer thresholds will be calibrated from the baseline performance profile.

## Out of scope

- General workflow execution throughput and server-side image-generation performance.
- Video-history drag-and-drop reuse.
