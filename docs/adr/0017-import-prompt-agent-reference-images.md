# Import Agent references through ordinary image nodes

Local issue: `prompt-agent#026`.

Pasted, dropped and uploaded files, and selected or dropped history images, create ordinary ImageImport nodes before becoming usable pending Agent references. Existing scene imports are referenced directly. Each batch reserves attachment positions immediately and serializes imports so asynchronous reads cannot reorder nodes or reference numbers. Agent consumes its own drop and paste events, preserving mixed clipboard text and preventing duplicate global imports.

A reference source adapter owns history metadata, original reads and import/reuse decisions. History browsing loads metadata with local thumbnail URLs; originals are read only for selection or explicit preview. The picker separates scene and history tabs, searches names and history prompts, renders 60 candidates at a time, and separates preview from selection. Previews use the shared fullscreen API without creating nodes.

An imported history node stores `agentReferenceSource: { historyId, assetKey }`. Reuse requires the same history identity, upload mode and unchanged canonical asset. The marker round-trips through node serialization and restoration; the ordinary ImageImport owner protects the image asset. File and history imports use the existing node creation, image persistence and undo lifecycle. Retrying a failed import retains its node identity instead of creating another node.

Removing a pending reference retains any already-created canvas node. Every asynchronous selection is fenced by the original workflow/conversation revision and pending selection identity; cancelled reads cannot create nodes or restore references. Clearing or changing workflows starts a fresh queue. Already-sent references retain the existing self-contained conversation image format, so this change does not migrate old conversation attachments or depend on the source node remaining present. Importing references does not automatically connect them to generation nodes.
