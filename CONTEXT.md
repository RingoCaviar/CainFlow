# CainFlow Context

## Language

**Canvas interaction**:
One of panning, zooming, node dragging, or drawing a connection in the workflow editor.

**Performance sampling run**:
A continuous 10-second execution of a fixed canvas-interaction sequence, used to collect performance metrics.

**Long frame**:
A rendered frame whose duration exceeds 50 ms.

**Mixed-node benchmark fixture**:
The deterministic 200-node, 400-connection workflow used for performance sampling; it includes image previews, controls, running state, and long connections.

**Workflow activation**:
The transition that makes one workflow the active workflow shown in the editor. Only the latest requested transition may take effect, and a failed transition leaves the previous active workflow unchanged.
_Avoid_: Workflow opening, tab switching

**Background workflow run**:
A workflow run that continues while another workflow is active in the editor. Returning to it restores its current visible run state without restarting the run.
_Avoid_: Hidden run, inactive run

**Workflow identity**:
The stable identity of a workflow across renaming, folder moves, workflow activation, and background workflow runs. A workflow name or path is a mutable label, not its identity.
_Avoid_: Workflow name as identity, workflow path as identity
