# CainFlow Context

## Language

**Canvas interaction**:
One of panning, zooming, node dragging, or drawing a connection in the workflow editor.

**Performance sampling run**:
A continuous 10-second execution of a fixed canvas-interaction sequence, used to collect performance metrics.

**Long frame**:
A rendered frame whose duration exceeds 50 ms.

**Functional animation**:
Motion that communicates elapsed time, progress, running state, or confirmation of a destructive action. It remains available when CainFlow's global decorative-animation setting is disabled.
_Avoid_: Critical animation, mandatory animation

**Decorative animation**:
Motion used only for visual polish, such as fades, scaling, glow, and connection-flow decoration. The global animation setting controls this category.
_Avoid_: Global animation, all animation

**Mixed-node benchmark fixture**:
The deterministic 200-node, 400-connection workflow used for performance sampling; it includes image previews, controls, running state, and long connections.

**Workflow activation**:
The transition that makes one workflow the active workflow shown in the editor. Only the latest requested transition may take effect, and a failed transition leaves the previous active workflow unchanged.
_Avoid_: Workflow opening, tab switching

**Background workflow run**:
A workflow run that continues while another workflow is active in the editor. Returning to it restores its current visible run state without restarting the run.
_Avoid_: Hidden run, inactive run

**Workflow identity**:
The stable identity of a workflow across saving, renaming, folder moves, workflow activation, and background workflow runs. A workflow name or path is a mutable label, not its identity. Copying or saving a workflow as a new workflow creates a new Workflow identity.
_Avoid_: Workflow name as identity, workflow path as identity

**Multi-connection input**:
An input port that retains distinct connections from multiple source ports in an explicit order. Reconnecting the same source is rejected, while disconnecting one source leaves the others and their order intact.
_Avoid_: Repeated input ports, array port

**Model compatibility format**:
The request format automatically assigned when a fetched model is added. It is inferred only from keywords in the model ID or display name, independently of the provider type, model-list transport format, or endpoint metadata.

**Grok model family**:
Models whose ID or display name contains `grok`, case-insensitively. They use the OpenAI Model compatibility format unless an explicit transport-family keyword requires manual selection.

**Unrecognized model compatibility format**:
The empty compatibility format assigned when a fetched model matches no known format keyword. The model cannot be used until the user explicitly selects a compatibility format; the application must surface that requirement rather than silently choosing a default.

**Incomplete model compatibility configuration**:
A model configuration without an explicitly selected, currently registered Model compatibility format. Empty values and obsolete or otherwise unknown format values are incomplete. It must be completed before the user can leave model settings.

**Built-in provider configuration**:
A provider or model configuration supplied, recommended, restored, or specially handled by CainFlow rather than created by the user. A neutral installation has no Built-in provider configuration.

**User-owned provider configuration**:
A provider or model configuration explicitly created or retained by the user. Product changes do not silently delete it, even when CainFlow stops supplying or specially supporting the same service.

**Provider order**:
The user-controlled ordering of provider configurations. The same order is shown consistently anywhere CainFlow presents providers for selection and determines the default provider for a newly created model. It does not change the Model provider priority of an existing model. Newly added providers appear last.

**Model order**:
The user-controlled ordering of model configurations. The same order is shown consistently in settings and anywhere CainFlow presents models for selection, and determines the fallback model when a previous selection is no longer available. Newly added models appear last.

**Model provider priority**:
The ordered provider bindings of one model, used to choose its default request target. Reordering Provider configurations does not alter this priority.
_Avoid_: Provider order

**Bounded diagnostic record**:
A locally stored record used to investigate CainFlow requests, failures, and runtime behavior within a hard total disk budget. Errors have retention priority, while successful requests may be sampled.
_Avoid_: Unbounded log, complete request archive

**Diagnostic level**:
The user's choice of how much successful runtime activity CainFlow records for diagnosis; it does not weaken the hard disk budget. It expresses diagnostic intent rather than a retention duration.
_Avoid_: Log retention days, log storage quota
