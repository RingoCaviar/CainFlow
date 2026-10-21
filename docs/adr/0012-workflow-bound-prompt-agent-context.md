# Bind Prompt Agent context to the current workflow

The selected-node requirement below is superseded by [ADR-0015](0015-create-prompt-agent-generation-targets.md). Workflow-bound context and explicit user execution remain in effect.

CainFlow will make the first Prompt Agent a lightweight image-generation assistant whose implicit context is bound to the current workflow. It may update that context from each user message, compress it when it exceeds the configured size, and use it to produce a Prompt Plan for the explicitly selected Image-Generation Node; users choose whether to apply the plan or apply it and generate. New workflows start with empty context, reopened workflows restore their context, and the agent never guesses a target node when none is selected. This keeps the interaction as minimal as Codex-like agents while preventing context from leaking across workflows or requiring a separate global memory system.

## Consequences

- The context is intentionally implicit and is not exposed as a separate canvas node or cross-workflow user profile.
- Prompt generation and image execution remain separate actions, so a user can inspect or edit a plan before spending a generation request.
- Automatic summarization can introduce drift; future work must keep compression bounded and ensure only relevant creative context is used when constructing a Prompt Plan.
