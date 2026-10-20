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

**Node execution failure**:
The durable visible state of the specific node whose execution ended with a non-cancellation error. It remains visible until that node next executes successfully, exposes a concise cause on the node, and links to the complete error details.
_Avoid_: Workflow error, global error

**Workflow identity**:
The stable identity of a workflow across saving, renaming, folder moves, workflow activation, and background workflow runs. A workflow name or path is a mutable label, not its identity. Copying or saving a workflow as a new workflow creates a new Workflow identity.
_Avoid_: Workflow name as identity, workflow path as identity

**Open Workflow record**:
The authoritative current-session record of an open workflow's Workflow identity, mutable label, running state, pending explicit-save state, and whether it is active. Presentation details, folder placement, dirty state, run result, and the editable workflow document are not part of this record.
_Avoid_: Workflow tab as authority, duplicate open-workflow state

**Conversation**:
A durable multi-turn exchange with configured models that may exist independently or be linked to one Workflow identity. Its messages may contain text and references to shared Media assets.
_Avoid_: Enlarged TextChat node, workflow chat log

**Workflow-linked conversation**:
A Conversation associated with one Workflow identity so it can use that workflow's node outputs and offer explicit canvas actions. Renaming or moving the workflow does not change the association.
_Avoid_: Workflow-name-linked chat, conversation owned by a workflow tab

**Workspace mode**:
The active CainFlow interaction surface, either the canvas editor or the conversation workspace. Changing Workspace mode preserves the active workflow and does not constitute Workflow activation.
_Avoid_: Page navigation, workflow switch, iframe mode

**Conversation context projection**:
The execution-time selection of conversation history, workflow summary, and explicitly attached node or Media asset references that fit the selected model's input capacity. The durable Conversation remains complete when earlier content is summarized or omitted from a request.
_Avoid_: Truncated conversation, complete-history request

**Conversation branch**:
An alternative continuation retained when an earlier user message is edited or an assistant response is regenerated. Selecting a branch changes the visible continuation without overwriting another result.
_Avoid_: Overwritten reply, duplicate conversation

**Background conversation run**:
A Conversation request that continues while another Conversation or the canvas editor is visible. One Conversation has at most one active request, while separate Conversations may run concurrently.
_Avoid_: Hidden chat request, parallel replies in one conversation

**Canvas action plan**:
The complete preview of AI-proposed changes to one workflow, confirmed by the user and applied atomically as one undoable action. A rejected or failed plan leaves the workflow unchanged.
_Avoid_: Direct AI canvas mutation, sequence of unrelated undo steps

**Staged conversation context**:
The removable set of local files, clipboard content, history Media assets, and workflow node outputs prepared for the next user message. Only the items visible in this set become explicit inputs when that message is sent.
_Avoid_: Implicit open-media context, automatic canvas attachment

**Conversation source snapshot**:
The content and Media asset references captured from a workflow node when a user message is sent, together with the source Workflow identity and node ID. Later node changes do not rewrite the snapshot; obtaining newer content is an explicit action.
_Avoid_: Live node message, mutable conversation attachment

**Conversation execution record**:
The immutable account of the model, Provider, system-prompt version, and request outcome used to produce one assistant response. Changing a Conversation's current defaults does not rewrite earlier execution records.
_Avoid_: Conversation-wide model history, current-model attribution

**Conversation request attempt**:
One provider request made while producing an assistant response, including a failed or automatically retried request. Retrying retains earlier attempts while presenting them under the same response position.
_Avoid_: Duplicate user message, overwritten request failure

**Partial assistant response**:
The retained incomplete output from a Conversation request stopped by the user. It is visibly distinguished from a completed response and may be continued, regenerated, or removed.
_Avoid_: Failed response, completed truncated reply

**Conversation package**:
A portable export containing Conversation documents, an identity and reference manifest, and only the Media assets the user explicitly chooses to include. Import reconstructs local references without trusting source-device file paths.
_Avoid_: Chat text dump, implicit media backup

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

**Media asset**:
One locally persisted image or video result, identified independently of any node or history record. A node's declared media capabilities are the authority for whether its image result is transient or persistently recoverable. Image and video generation nodes are Persistent media sources and retain their complete generated batch through persistent Media asset references. Nodes that retain displayed, saved, or derived results and history records may hold persistent references to the same Media asset, which remains until its last persistent reference is removed.
_Avoid_: Node-owned media copy, history-owned media copy

**Persistent media source**:
A node whose current retained content remains available from its output ports without new upstream input. It retains the complete ordered media batch; a current single-item view does not replace that batch. Background projection does not change its media ownership or turn a transient producer into a persistent owner.
_Avoid_: Latest-item-only source, projection-owned media

**Media asset owner**:
The durable consumer identity that keeps one or more Media assets alive. A workflow-node owner is the pair of Workflow identity and node ID; an image import, history record, and history thumbnail use their own owner kinds.
_Avoid_: Asset owner, node asset key

**Media asset ownership transition**:
The durable replacement of one Media asset owner's reference list. New references become durable before superseded references are released; an interrupted transition may temporarily retain extra references but never makes an owned Media asset collectible.
_Avoid_: Cache key swap, release-then-store

**Media asset transition record**:
The durable coordination record for one logical Media asset ownership transition. It binds the operation identity, expected owner revision, Workflow document revision, storage epoch, complete old and new reference lists, and recoverable commit stage so retries cannot reinterpret an older intent as a new change.
_Avoid_: In-memory save state, retry flag

**Media asset garbage collection**:
The backend-owned reclamation of Media assets with no Media asset owner references. A client-provided snapshot of visible or open nodes never determines whether a Media asset is collectible.
_Avoid_: Node cache cleanup, keep-key cleanup

**Media asset integrity report**:
A versioned, time-stamped diagnostic snapshot comparing durable consumer documents, Media asset owner references, asset metadata, and physical media files. It records repairable and user-actionable inconsistencies but never determines Media asset liveness.
_Avoid_: Media asset index, cache authority, live reference list

**Unregistered Media file**:
A regular file in the managed Media asset directory whose normalized physical path has no matching asset metadata record. This describes a disk-to-database mismatch, not the absence of a known producer.
_Avoid_: Unowned Media asset, zero-reference Media asset

**Missing Media asset**:
A Media asset identity retained by a durable consumer when either its asset metadata or physical media file is absent. The retained position in a Media asset reference list remains explicit until the user recovers or removes it.
_Avoid_: Cache miss, silently omitted media

**Unassociated Media asset owner**:
A Media asset owner reference for which no durable consumer can be established. It is quarantined before collection so an interrupted ownership transition can be reconciled without data loss.
_Avoid_: Orphaned cache key, stale node

**Media asset quarantine**:
The recoverable holding state for a Media asset whose ownership cannot yet be established or whose garbage collection has been approved but not finalized. Quarantine preserves the asset identity, content hash, provenance, and recovery record until its retention conditions are satisfied.
_Avoid_: Trash cache, immediate deletion

**Media asset storage epoch**:
The durable generation of the Media asset store that every writer must match before committing an ownership transition. A migration advances the epoch so a process holding an older view cannot mutate upgraded storage.
_Avoid_: Cache version, client version

**Media asset migration backup**:
A verified, immutable recovery point that binds the database, workflow documents, and a hashed physical-media inventory under one identity before a Media asset schema migration begins.
_Avoid_: Best-effort cache copy, database-only backup

**Media asset reference list**:
The ordered list of Media asset identities displayed by one workflow node. It represents both a single image and a multi-image result without embedding image data in the workflow document.
_Avoid_: Image asset key, image import asset key, persisted image list

**Media asset lazy migration**:
The on-read replacement of legacy embedded or node-owned image data with a Media asset reference list. It writes the new durable form before releasing the legacy copy, so a failed migration remains retryable without data loss.
_Avoid_: Destructive cache conversion, eager cache rewrite

**Media asset actual usage**:
The disk space occupied by unique local Media asset files, counted once even when several consumers reference the same original.
_Avoid_: Sum of cache categories, per-reference usage

**Media asset reference distribution**:
The overlapping breakdown of unique Media assets referenced by each consumer category. Its categories describe ownership and are not additive disk usage.
_Avoid_: Cache size breakdown, additive category total

**Media asset recovery**:
A user-confirmed download of a missing locally referenced Media asset from its retained remote result URL. CainFlow never starts recovery automatically; it reports the transfer's progress, completion, cancellation, or failure on the requesting node.
_Avoid_: Automatic cache refill, silent remote fallback

**History video thumbnail hydration**:
The view-triggered generation of a missing history-video thumbnail from its locally persisted Media asset. It never recovers the video from a remote URL. A successful thumbnail becomes durable; a failed attempt remains eligible for a future view session.
_Avoid_: Automatic Media asset recovery, permanently failed thumbnail

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

**6789 relay video compatibility format**:
The built-in compatibility format for the supplied 6789 relay video API. It creates an asynchronous task and later queries its status and result; its display name identifies the documented relay interface rather than implying support for every asynchronous video API.
_Avoid_: Generic asynchronous video API format

**Protocol constraint**:
A declared limit on values or connected media that a Protocol variant accepts. CainFlow prevents invalid values in the node UI and rejects any invalid execution without silently discarding inputs or coercing values.
_Avoid_: Best-effort fallback, silent normalization

**Protocol schema version**:
The version of the persisted Declarative protocol configuration shape. CainFlow migrates known older versions during loading, while a configuration from an unknown newer version is preserved but not executed or edited.
_Avoid_: Unversioned protocol format

**Built-in protocol configuration**:
A versioned, immutable Declarative protocol baseline supplied and maintained by CainFlow. A user may save a stable-ID override in a separate user-owned layer; the shipped baseline remains unchanged, and resetting the override restores the current baseline.
_Avoid_: Mutating the shipped protocol module, replacing the baseline with an override

**User-owned protocol configuration**:
A Declarative protocol configuration created by a user, copied from a Built-in protocol configuration, or stored as a Built-in protocol override. CainFlow preserves the user-owned layer across upgrades, merges it over the matching baseline, and exposes an unknown future baseline as read-only until supported.
_Avoid_: Silently discarding an override during an upgrade

**Protocol validation**:
The two-layer verification of a Declarative protocol configuration: offline schema and constraint validation with a redacted request preview, plus an explicitly user-initiated network test. Saving or importing a configuration never initiates a provider request.
_Avoid_: Save-time provider test

**Request plan**:
The complete, validated snapshot of one generation request derived from the current node controls, connected inputs, selected Model compatibility format, and Protocol variant. CainFlow uses the same Request plan for request preview and execution; a preview redacts credentials and never sends the request.
_Avoid_: Separate preview request body, preview-only request builder

**Protocol variant selector**:
The model ID used to select a Protocol variant. A Declarative protocol configuration may explicitly make this comparison case-insensitive and use the declared variant ID as the canonical request value; CainFlow does not infer variants through punctuation changes, wildcards, or regular-expression matching.
_Avoid_: Variant pattern, guessed model variant, global model-ID normalization

**Unmatched protocol variant**:
A model assigned a Declarative protocol configuration but lacking a Protocol variant after applying that protocol's declared selector comparison. CainFlow rejects its execution before a provider request is sent.
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

**Protocol-driven generation card**:
The request-parameter controls and input ports on a generation node, rendered only from the selected model's Declarative protocol configuration and exact Protocol variant. Provider selection, run count, execution state, recovery, result presentation, and download remain CainFlow controls. Parameter drafts belong to their model and Protocol variant, so an unsupported draft is retained but neither shown nor sent after a model switch.
_Avoid_: Hard-coded generation request fields, shared parameter values across incompatible model variants

**Generation input projection**:
The authoritative resolved input information for one generation node, derived from its selected Declarative protocol configuration and exact Protocol variant. It identifies the supported text and media inputs, their labels, constraints, connection behavior, and any inactive input that blocks execution. Provider selection does not change this information.
_Avoid_: Separate UI, connection, and execution input rules

**Video execution input record**:
The immutable, execution-ready video input derived at run time from the current generation input projection, node controls, and explicitly ordered connected media. It carries structured diagnostics when execution is blocked. Request encoding, task polling, and Media asset persistence are not part of this record.
_Avoid_: Cached node projection, provider request body, execution-time DOM contract

**Protocol-driven video card rollout**:
The first Protocol-driven generation card delivery covers video only. Every supported built-in video format must declare its equivalent parameters before it uses the shared renderer; a user-owned protocol without declared editable parameters shows an explicit safe state rather than falling back to legacy request controls. Protocol declaration order and `layout` hints determine parameter presentation.
_Avoid_: Parallel video and image-card migration, legacy UI fallback for incomplete protocols

**Inactive protocol draft**:
A saved parameter value or connection that belongs to a previously selected model variant or a removed protocol declaration. CainFlow preserves it without rendering or sending it; switching back to a compatible declaration can restore it. If an inactive connection exceeds the selected variant's limits, CainFlow identifies it and blocks execution instead of deleting or silently omitting it.
_Avoid_: Destructive model switching, silently ignored incompatible connection

**Video card validation state**:
The aggregated, pre-request validity of the selected model's Protocol variant, declared parameters, and input connections. CainFlow shows actionable summary and field-level feedback, disables execution while invalid, and never sends a partial request. A card also shows a concise read-only identity and constraint summary for its selected compatibility format and model variant; provider changes alone do not change that contract.
_Avoid_: Provider-dependent same-model semantics, request-time-only validation

**Protocol variant draft initialization**:
The first selection of a model's Protocol variant fills only its missing fields from declared defaults. Subsequent selections restore that variant's saved draft. A protocol upgrade may initialize newly declared missing fields but must never overwrite a user-supplied value.
_Avoid_: Resetting values on every model switch, protocol upgrades overwriting user input

**Protocol vertical slice**:
The first delivery of a new Declarative protocol capability together with one production protocol that exercises it. CainFlow will use the 6789 video protocol as the first slice and migrate existing protocols separately.
_Avoid_: Big-bang protocol migration, hard-coded pilot
