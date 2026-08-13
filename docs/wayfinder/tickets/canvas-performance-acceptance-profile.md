---
type: wayfinder-ticket
status: closed
parent: ../canvas-scale-and-reuse-map.md
labels: [wayfinder:grilling]
assignee: codex
---

## Question

Which representative workflow profile and observable interaction criteria define “more fluid” Canvas behavior when a fixed node-count target is intentionally not set?

## Resolution

The user intentionally does not want a fixed node-count commitment. Performance acceptance will therefore use representative Canvas stress workflows and observable interaction quality: measure long-frame frequency and latency during pan, zoom, node drag, and marquee selection; compare before and after on the same environment; and reject changes that visibly regress selection, editing, or connection correctness. The profile should include both ordinary nodes and image-import nodes, because their DOM/media costs differ.

The user's primary symptom is global sluggishness once the Canvas becomes node-dense, rather than a single slow interaction. Optimizations must therefore improve the shared hot paths before isolated interaction tuning.
