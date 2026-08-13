---
type: wayfinder-ticket
status: closed
parent: ../canvas-scale-and-reuse-map.md
labels: [wayfinder:task]
assignee: codex
---

## Question

How should Canvas virtualization, LOD, display MIPmaps, and dense-mode visual effects be implemented so that rendering is a reversible projection and cannot lose or corrupt node data, connections, form state, or source images?

## Decision constraints so far

- Virtualizing Offscreen nodes is allowed, but workflow data must never be lost.
- Multiple zoom-dependent LODs are allowed, but changing LOD must never lose or corrupt node data.
- Source images must not be released or changed. Display MIPmaps may be explored only as derived rendering assets.
- Dense-mode CSS-effect reduction is allowed.
- Offscreen virtualization retains a Node shell with identity, geometry, ports, and selection state. Only complex inner presentation is mounted or unmounted, and it is restored from the existing Node model.
- Dense mode enables automatically from zoom and node-density thresholds, uses hysteresis to avoid visual flapping, and supports a user override.
- All persisted connections remain rendered even when both endpoints are outside the viewport. Performance work must improve path computation, SVG updates, or animation cost without hiding or clipping connections.
- Display MIPmaps are generated on demand in the background and are discardable caches. Source images remain authoritative and can rebuild any missing MIPmap; importing, generating, and Canvas interaction must not wait on MIPmap creation.
- Compact LOD preserves node title, status color, ports, and selection state; it omits form controls, long text, media previews, shadows, and complex actions.
- LOD transitions switch directly rather than animate. Threshold hysteresis prevents repeated switching near a boundary.
- In Compact LOD, one click selects a Node; double-click focuses it and temporarily restores its full Render projection for editing without changing workflow data or the global zoom.
- Offscreen virtualization uses a viewport buffer so Nodes must move beyond the buffered boundary before their complex inner presentation unmounts, avoiding mount/unmount thrash during pan.
- Before release, automated regressions must prove that repeated pan, zoom, LOD switching, virtualization recovery, and focused editing preserve node configuration, form values, source-image references, connections, selection, undo/redo, and import/export results. Source-image references, connections, and import/export receive explicit automated assertions.

## Resolution

Render optimization is constrained to a reversible Render projection. Retain a persistent Node shell and authoritative Node model; virtualize only complex inner presentation beyond a buffered viewport boundary. Use direct, hysteretic LOD changes; Compact LOD keeps title, status color, ports, and selection, and double-click temporarily restores a node for editing. Keep every persisted connection rendered, optimize its calculation and updates instead. Generate display-only MIPmaps lazily in the background from immutable source images. Enable Dense mode automatically from zoom and density with a manual override; it reduces expensive CSS effects. These guarantees are release-blocking regression coverage.

## Implementation note

Implemented with a soft virtualization layer: the existing node DOM, port geometry, and Node model are retained. `content-visibility` skips complex node-body rendering while a persistent node shell remains, avoiding form-state serialization or DOM recreation during a projection change. Dense-mode preference is persisted in workflow and configuration state. Display MIPmaps now use a cache key that includes their maximum edge, so independently generated derived sizes cannot overwrite one another.
