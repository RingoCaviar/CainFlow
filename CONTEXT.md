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

**Open Workflow record**:
The authoritative current-session record of an open workflow's Workflow identity, mutable label, running state, pending explicit-save state, and whether it is active. Presentation details, folder placement, dirty state, run result, and the editable workflow document are not part of this record.
_Avoid_: Workflow tab as authority, duplicate open-workflow state

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

**Declarative protocol configuration**:
A user-editable protocol definition that expresses common provider behavior such as endpoint paths, authentication, parameters, media-field mapping, asynchronous task polling, and response extraction, without executable code.
_Avoid_: Scripted protocol, arbitrary protocol code

**Transport adapter**:
A CainFlow-supplied implementation that turns a Declarative protocol configuration into a correctly encoded provider request or handles transport behavior not safely expressible in configuration, such as multipart file upload.
_Avoid_: Provider-specific branch, protocol script

**Protocol variant**:
A model-ID-selected specialization within one Declarative protocol configuration. It supplies model-specific request encoding, media rules, parameter constraints, and overrides without becoming a separate compatibility format or a node-level mode.
_Avoid_: Separate model protocol, node mode

**Asynchronous video API compatibility format**:
The compatibility format for declarative video APIs that create an asynchronous video task and later query its status and result. It is named for this stable request contract, not for a provider's deployment topology or commercial routing.
_Avoid_: Relay video format, provider-specific video format

**Protocol constraint**:
A declared limit on values or connected media that a Protocol variant accepts. CainFlow prevents invalid values in the node UI and rejects any invalid execution without silently discarding inputs or coercing values.
_Avoid_: Best-effort fallback, silent normalization

**Protocol schema version**:
The version of the persisted Declarative protocol configuration shape. CainFlow migrates known older versions during loading, while a configuration from an unknown newer version is preserved but not executed or edited.
_Avoid_: Unversioned protocol format

**Built-in protocol configuration**:
A read-only Declarative protocol configuration supplied and maintained by CainFlow. A user may copy it into a User-owned protocol configuration but cannot modify the supplied original.
_Avoid_: Editable built-in protocol

**User-owned protocol configuration**:
A Declarative protocol configuration created by a user or copied from a Built-in protocol configuration. CainFlow preserves it across upgrades and does not overwrite it with the corresponding built-in configuration.
_Avoid_: Overridable built-in protocol

**Protocol validation**:
The two-layer verification of a Declarative protocol configuration: offline schema and constraint validation with a redacted request preview, plus an explicitly user-initiated network test. Saving or importing a configuration never initiates a provider request.
_Avoid_: Save-time provider test

**Protocol variant selector**:
The exact model ID used to select a Protocol variant. CainFlow does not infer variants from wildcard or regular-expression matching.
_Avoid_: Variant pattern, guessed model variant

**Unmatched protocol variant**:
A model assigned a Declarative protocol configuration but lacking a Protocol variant selected by its exact model ID. CainFlow rejects its execution before a provider request is sent.
_Avoid_: Default guessed variant, nearest-match variant

**Async task mapping**:
The declared provider-specific mapping from an asynchronous task response to task ID, state, terminal outcome, and result media. CainFlow owns polling cadence, timeout, cancellation, recovery, and diagnostic behavior.
_Avoid_: Per-protocol polling policy

**Protocol authentication rule**:
The non-secret declaration of where and how CainFlow places a provider's API key in a request. The key itself belongs only to the linked provider configuration and is excluded from protocol persistence, export, and previews.
_Avoid_: Embedded protocol key, model key

**Protocol-driven video controls**:
The variable video-node controls and input ports derived from a selected Declarative protocol configuration and its Protocol variant. Prompt entry, execution state, task recovery, and result presentation remain stable video-node behavior.
_Avoid_: Per-protocol video node UI, request-only protocol editor

**Protocol vertical slice**:
The first delivery of a new Declarative protocol capability together with one production protocol that exercises it. CainFlow will use the 6789 video protocol as the first slice and migrate existing protocols separately.
_Avoid_: Big-bang protocol migration, hard-coded pilot
