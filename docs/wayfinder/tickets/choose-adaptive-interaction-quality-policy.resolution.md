# Resolution: Choose the Adaptive Interaction-Quality Policy

Resolved: 2026-08-13

- During panning and zooming, transform the SVG connection group only. Do not recompute individual Bézier paths; perform one exact full alignment within 120 ms of interaction settlement.
- During node dragging, update only paths connected to the dragged node or nodes. Verify and correct alignment after release.
- Enter performance-protection mode after two frames longer than 50 ms within one second. While active, freeze non-selected connection updates and disable flow arrows, SVG filters, and background-grid movement.
- Restore full visual quality after 500 ms without a long frame. Selection, running-node state, endpoint geometry, and the in-progress connection remain accurate throughout.

