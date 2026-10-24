# Retain each Prompt Agent generation result independently

Prompt Agent retains each generation attempt on its originating plan message. A run has a stable `runId`, target node, execution state and complete ordered `mediaAssetKeys`. Later generation or removal of the target cannot rewrite a previous batch. Both current and archived messages participate in persistence; compaction retains them and explicit clearing removes them. Old documents without run records remain valid and do not infer historical results from a node's current output.

## Media ownership and recovery

- Each completed run is a `prompt-agent-result` Media asset owner scoped by Workflow identity and run ID. A run shares existing content-addressed Media assets with its source node instead of embedding image payloads or keeping a transient URL as durable identity.
- Before the execution context is disposed, the result consumer acquires its own temporary `workflow-operation` protection. The complete run is written to the original workflow, then persisted before temporary protection is released. Failure retains the original images and exposes a save retry that does not generate again.
- Session documents establish their Agent references in the same storage transaction as the session update, so a workflow need not be explicitly saved to a file for its results to survive restart. Session references and explicitly saved workflow-owner references are independent durable consumers. Clearing an open conversation does not release a reference still required by its saved workflow file.
- File commits, session updates, integrity evidence, recovery, workflow copies and deletion all collect current and archived result records. Copying creates independent owners and drops source-workflow temporary markers. Media actual usage continues to count shared physical assets once.
- Completion updates only an existing run in its original Workflow identity using the latest conversation document. Clearing or deleting the workflow prevents late completion from recreating it. Missing local files retain their positions and are not silently replaced by remote downloads.

## Presentation and automatic save nodes

- Fresh and restored run records share the same renderer. Clicking or pressing Enter/Space on a generated image opens its immutable batch in the existing fullscreen viewer, without changing a node's current preview or editing state.
- Automatic ImageSave creation happens on the editable workflow before taking a run snapshot. For each enabled image/video generator in the original execution range, no direct media-output connection to an existing enabled target means an enabled ImageSave is added and connected. Disabled targets stay disabled.
- The `autoAddedForGeneration` marker survives serialization. Bounded runs include connected, enabled automatic save nodes through validated `includedAutoSaveNodeIds`; retries reuse them without executing unrelated downstream branches. Running-node conflicts are checked before graph mutation, and the runtime receives the completed graph from the start.

Local issue: `prompt-agent#021`.

For `prompt-agent#033`, Agent's durable-save barrier confirms the queued session document revision, rather than the disk facade's global error flag. An unrelated preference failure remains visible to the storage notifier but cannot mark an already committed Agent result as unsaved. Genuine session failure preserves temporary media protection and includes the document/HTTP error in the retry message. Document writes account for aggregate in-flight keepalive bytes and retry transport rejection without keepalive; batches settle completely before scheduling retries, and only failed documents are requeued so older writes cannot outlive their batch.

## Result persistence module (2026-10-24, prompt-agent#060)

One deep result persistence module owns completion capture, durable result writes, ownership handoff, save retries, and durable conversation clearing for both legacy Prompt Plans and Canvas action plans. Its interface accepts Workflow identity, run ID and the first result; retries accept identity only and read the latest conversation document. The existing Agent Conversation remains the only durable authority. The module retains only in-flight tasks, temporary result images and outstanding cleanup obligations; generation scheduling and DOM presentation remain outside its seam. Media retention and release remain an internal adapter, preserving the existing Media asset ownership protocol.

Duplicate saves of one workflow/run share the same awaitable task; other runs proceed independently. Clear removes the conversation immediately while preserving its existing model, size, Provider, thinking and search preferences. Late retained results wait for the durable clear barrier before releasing protection, and a failed clear keeps cleanup obligations for a subsequent clear attempt. Once a result has been durably committed and its temporary protection released, failure of the final status-marker save cannot turn it into a fresh retention attempt. Tests cross this same module interface for persistence behavior, with separate media adapter contracts and a small number of controller and complete-application wiring tests.
