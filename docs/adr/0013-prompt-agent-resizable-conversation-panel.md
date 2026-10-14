# Use a resizable conversation panel for the Prompt Agent

CainFlow will expose the Prompt Agent from the top toolbar as a resizable right-side conversation panel. The panel keeps the selected image-generation node in context, supports text plus pasted or dropped reference images, renders each result as a chat response with an automatically collapsed Agent Work Summary, and keeps the actions “apply to node” and “apply and generate” attached to that response. The panel remains open after applying a plan, reports generation progress and failures in the same conversation, and stores its conversation with the current workflow; it remembers the user's panel width but does not reopen automatically.

## Consequences

- The canvas remains visible while the assistant is used, and users can tune the panel width to their workspace.
- A missing selected image-generation node does not prevent conversation, but application actions remain unavailable until the user selects one.
- The UI shows observable work stages rather than private model reasoning, preserving a lightweight Codex-like interaction without exposing chain-of-thought.
- The first version intentionally avoids a global Agent history, an always-visible memory inspector, and a separate modal progress flow.
