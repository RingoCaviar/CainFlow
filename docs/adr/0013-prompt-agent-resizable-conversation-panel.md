# Use a resizable conversation panel for the Prompt Agent

The selected-node requirement below is superseded by [ADR-0015](0015-create-prompt-agent-generation-targets.md). The panel layout, plan preview, and explicit application and generation actions remain in effect.

CainFlow will expose the Prompt Agent from the top toolbar as a resizable right-side conversation panel. The panel keeps the selected image-generation node in context, supports text plus pasted or dropped reference images, renders each result as a chat response with an automatically collapsed Agent Work Summary, and keeps the actions “apply to node” and “apply and generate” attached to that response. The panel remains open after applying a plan, reports generation progress and failures in the same conversation, and stores its conversation with the current workflow; it remembers the user's panel width but does not reopen automatically.

## Compact layout and global width preference (2026-10-21, prompt-agent#024)

The panel no longer has a top title bar. Both model selectors and the close action occupy a compact row above the composer. Visible labels are shortened while accessible names remain explicit. Image-model selection remains manual and workflow-scoped.

Width is a global UI preference stored through diskStorage under `cainflow_prompt_agent_panel_width`, independently of workflow conversation saves. The left-edge separator supports pointer capture and keyboard adjustment. Only deliberate adjustments persist width; hidden-panel measurements and viewport constraints never replace the preferred width. Existing workflow `panelWidth` is consumed only from the first restored workflow when no valid global preference exists. New conversation snapshots omit it. The panel still does not reopen automatically.

## Automatic dismissal and model menus (2026-10-21, prompt-agent#025)

Agent's toolbar button retains its active and expanded accessibility state but is excluded from chrome expansion and safe-inset checks. The ordinary hover, focus, peek and pin rules still apply. Opening via the toolbar transfers focus to the composer. Agent's visible surface suppresses incidental top-edge peek while reading it.

A primary blank-canvas click closes only the panel presentation. Pointer displacement exceeding 5px is latched until release, so drags returning to their origin do not dismiss it. Node, connection and navigation controls are excluded. Conversations and running operations remain untouched.

Agent model triggers adapt the existing node-select structure and native select input/change contract without changing node select code. Body-level themed listboxes avoid panel clipping and support keyboard navigation, viewport-aware placement and dynamic model invalidation. Only one is open at a time; closing the Agent removes its menu. Missing image models remain explicitly unselected or invalid rather than falling back.

## Shared panel and window coordination (2026-10-21, prompt-agent#043)

Agent, history, workflow, cache, statistics, logs and help are mutually exclusive primary panels. The panel manager invokes each feature's existing close lifecycle, preserving conversations, selected items, width preferences and background operations. The sticky 5px blank-click guard also applies to primary-panel dismissal.

Transient model, search, reference, command, theme, canvas and Provider menus register their owner and optional parent with the surface coordinator. Sibling menus are exclusive; children remain with their parent. Outside pointer dismissal consumes that gesture, while the next independent click or keyboard activation remains usable. Closing the owner removes its menus.

Existing modal, confirmation, protocol editor, preview and painter lifecycles retain ownership of their own cleanup. The coordinator orders visible windows above the shared modal layer, masks unrelated content with `inert`, keeps focus inside the top window, and routes Escape to only its top menu/window. Closing returns focus to a still-valid control. Preview Escape first dismisses a ratio/context menu or exits crop mode before closing the preview. Canvas transforms do not trigger window rescans. Ordinary menus use the shared menu layer and Agent uses the drawer layer; menus no longer borrow modal priority.

Ordinary menus sit above transient notifications but below immersive and modal windows. Agent menu surfaces composite the theme's surface color over the canvas color, preventing text from underlying notifications bleeding through glass themes. Both top notices and bottom notifications constrain their width to the space beside the Agent, following deliberate width changes immediately.

## Original consequences (historical)

- The canvas remains visible while the assistant is used, and users can tune the panel width to their workspace.
- A missing selected image-generation node does not prevent conversation, but application actions remain unavailable until the user selects one.
- The UI shows observable work stages rather than private model reasoning, preserving a lightweight Codex-like interaction without exposing chain-of-thought.
- The first version intentionally avoids a global Agent history, an always-visible memory inspector, and a separate modal progress flow.
