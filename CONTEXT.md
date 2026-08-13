# CainFlow Context

## Glossary

- **Canvas**: The workflow editing surface that presents nodes, connections, and the current viewport.
- **Node**: A positioned workflow operation on the Canvas, with typed input and output ports.
- **History image**: A persisted generated-image record that can be previewed or reused without deleting the record.
- **Image import node**: The node that owns an image supplied from a file, clipboard, or History image and exposes it to the workflow.
- **Canvas performance profile**: A representative dense Canvas whose pan, zoom, node drag, and marquee-selection responsiveness is measured as a whole; it is not defined by a fixed node count.
- **Offscreen node**: A Node outside the current Canvas viewport. It may use reduced rendering while retaining its workflow data, selection state, and connections.
- **Connection settle**: The deferred precise recalculation of connection endpoints and paths after a Canvas pan or zoom interaction ends; during the interaction, connections move with the Canvas transform.
- **Drag-local connection update**: During node dragging, only connections incident to the dragged Nodes update continuously; unrelated connections are corrected after the drag ends.
- **Render projection**: The ephemeral visual representation of a Node. It may be virtualized or use a level of detail, but it never owns or mutates the Node's persisted workflow data, port schema, connections, media references, or form values.
- **Level of detail (LOD)**: A zoom-dependent Render projection of a Node. Switching LOD changes visual complexity only and must be reversible without changing workflow semantics.
- **Display MIPmap**: A derived lower-resolution image used only for rendering at an appropriate zoom level. Its source image remains intact and authoritative.
- **Node shell**: The persistent lightweight DOM representation of a Node that retains identity, geometry, ports, and selection state while its complex Render projection is virtualized.
- **Dense mode**: A reversible Canvas render mode that reduces expensive CSS visual effects according to zoom and node density, with a user override.
- **Connection visibility invariant**: Every persisted connection remains rendered regardless of whether either endpoint is currently within the Canvas viewport.
- **On-demand display MIPmap**: A non-blocking, discardable Display MIPmap generated only when its zoom level needs it, which can always be rebuilt from the authoritative source image.
- **Compact LOD**: The reduced Node Render projection that preserves title, status color, ports, and selection while omitting form controls, long text, media previews, shadows, and complex actions.
