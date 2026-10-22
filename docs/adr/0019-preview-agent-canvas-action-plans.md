# Preview and atomically apply Agent canvas action plans

Local issue: `prompt-agent#044`.

The Prompt Agent can inspect the active workflow and propose a versioned Canvas action plan. Reading is distinct from authorization: selected nodes provide context, while an existing mutation target requires an explicit stable `@node` mention or an unambiguous name quoted from the current user request. References and model-generated text cannot authorize arbitrary scripts or node fields.

## Context and plan contract

The canvas context projects registered node types, stable identities, names, positions, public parameters, enabled/running state, port definitions, connection topology and local Media asset identities. Provider credentials and arbitrary node data never enter this projection. The initial summary includes a bounded page; the read-only `canvasRead` response contract supports node, connection, asset and long-text continuation offsets. Omitted content remains explicitly marked. A detail request may name up to four node/image indices to read local original pixels; those images enter the existing multimodal catalog. Missing assets fail explicitly, and cancellation is checked after every read. At most six detail reads are allowed per user turn, additionally bounded by the configured conversation token threshold.

`canvasPlan.version = 1` contains named steps, typed connections, explicit input disconnections and execution flags. The application validates it and adds the plan identity, workflow identity, relevant-node baseline, model overrides, concrete bindings and execution attempts. Supported mutations are ImageImport, ImageGenerate, ImageResize, ImageMerge, ImagePreview, ImageCompare, ImageSave and Text. Other registered nodes remain readable and may provide existing outputs, but are not implicitly executed. No deletion or global rearrangement is exposed. ImageResize is ordinary resizing; ImageMerge retains its existing multiple-image output semantics.

New replies using the legacy `promptPlan` contract are adapted into a single generation step plus required inputs and saves. Historical legacy cards retain their existing actions. Image imports can reference an application-provided image identity; the application resolves it to the fixed original Media asset. Existing latest-result edit-target checks also gate multi-step edit replies. Sources missing their original assets cannot be substituted by previews or remote downloads.

## Preview, apply and execution

The card displays steps, models, field changes and connection changes before any graph mutation. Automatic generation-save nodes are included in that preview. The user manually chooses the panel image model, optionally overriding individual generation steps. Capability, Provider and parameter failures stop application; there is no model fallback. Invalidated dependencies require a refreshed preview or a new plan. Unrelated graph edits and automatic node size settlement do not invalidate the plan.

The canvas adapter prepares local assets, rechecks workflow/conversation identity and relevant dependencies, then uses the session manager's batch interface. Intermediate history and autosave are suspended. Normal node construction, model-switch controls, connection projection and persistence are reused. Failure rolls the graph back without consuming undo/redo entries. Successful application saves the bindings with the graph and adds exactly one undo entry. An unchanged repeated application reuses those bindings. Undo follows stack order; redo restores the graph and never starts generation. The existing session-only history lifetime still applies.

Execution starts only after the graph save succeeds. The public run entry accepts an internal sequential flag and an immutable configuration snapshot. It rechecks the preview immediately before preparing the run snapshot. The selected plan nodes run in dependency order, with no automatic retry; an error or cancellation stops subsequent steps. External inputs must already exist. Explicit retry includes unfinished steps only. Other downstream branches are not added to the execution scope.

Each attempt records per-step status and actual model/Provider identities. Image generation and image-processing outputs use ordinary message `runs`, preserving the existing `prompt-agent-result` Media asset owners, result preview, source ordering and save-retry path. Results survive graph undo. Successful results are captured even when a later step fails. Completion updates only a still-existing plan/run in its original workflow; clearing a conversation cannot resurrect it. Interrupted attempts do not resume on restart. Costs already incurred and exported files are not undone.

## Validation and limits

Pure contract tests cover projection, paging, authorization, baselines, manual model choices, fixed result assets and persistence. Session-manager tests cover atomic rollback, durable-save failure and one-step undo/redo. Isolated complete-application browser tests use controlled chat/image responses to exercise actual node construction, sequential execution, media saving, restart, seven themes, narrow layout and keyboard mentions. They do not assert real-provider intent accuracy or promise reconstruction of a deleted asset.
