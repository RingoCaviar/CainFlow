# Create Prompt Agent generation targets when the user executes a plan

This decision supersedes ADR-0012 and ADR-0013 only for target-node selection. Prompt Agent still presents a Prompt Plan before execution, but an unbound plan creates and binds an image-generation node when the user applies or generates it; a bound plan uses its existing target without requiring that node to remain selected. This removes manual canvas setup while preserving the user's choice to review a draft before spending a generation request.

## Consequences

- Conversation alone does not create nodes or start image generation. The user explicitly selects the generation model in the Agent panel; selection starts empty even when only one model is configured. At each application or generation, both new and existing targets use that selection and its resolved Provider. Missing or invalid selections block the action without falling back to another model, while the draft remains available.
- The selected image model belongs to the workflow's Agent state. Saving and restoring the workflow retain it; new workflows and older documents without the selection start empty. Clearing or compacting the conversation preserves the selection, and canvas selection or global preferences never supply an implicit replacement.
- Target binding is part of the workflow's stored Prompt Plan. Repeated generation, retries, and restored plans reuse that target; a later canvas selection never silently retargets an existing plan. A removed target produces an error instead of modifying another node.
- Changing the selected model does not immediately mutate a bound node. The next explicit action applies the selection and validates the plan against the model's actual controls; incompatible parameters prevent generation and preserve the draft. A running target cannot be modified by another action.
- New targets use the existing node lifecycle and workflow execution paths, retaining their undo, persistence, generation status, and Media asset behavior. Workflow activation cannot redirect a pending Agent response or action into a different workflow.
- Reference-image attachments retain their existing meaning. Using an image in the conversation does not automatically connect it to the generation node; plans that require an unconnected image still identify that preparation step.

Local issues: `prompt-agent#019`, `prompt-agent#020`.
