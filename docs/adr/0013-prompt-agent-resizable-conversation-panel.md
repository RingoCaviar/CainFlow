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

## Image parameter windows and Agent coexistence (2026-10-28, image-first-canvas#016)

The image parameter editor is a modeless window. It can coexist and overlap with
Agent, including at narrow viewport widths. Clicking either visible surface brings
it to the front; explicit parameter and assistant controls recover a fully covered
surface without closing the other or changing conversation drafts and tasks.
Other primary panels retain their mutual exclusion and dismiss the parameter
presentation when opened. This is a narrow exception to the primary-panel rule
above, not a second modal stack.

The shared surface coordinator owns the ordering of these modeless windows and
their portal menus below real modal windows. Real modals continue to mask unrelated
content with `inert` and constrain focus. Escape dismisses the top menu, then the
top modal, then the front modeless window; explicit closing restores a still-valid
opener without scrolling the canvas. Node or workflow changes do not steal focus.

Normal parameters remain anchored below their node in screen coordinates. Opening,
resizing, or bringing them forward never pans the canvas or flips the anchor. Only
deliberate ordinary width changes update the global width preference. The enlarged
mode starts centered and has an ephemeral, draggable and resizable rectangle;
switching nodes retains that mode for the current open session. Restoring returns
to the current node, and closing ends the enlarged session. The original control
DOM remains the sole editor, including while the window is moved or resized.

## Small-window editing context (2026-11-05, ux-ui-improvements#001)

The coexistence policy above is refined for smaller desktops: at 801–1200px,
Agent reserves horizontal canvas space instead of overlaying that canvas area.
The parameter window shows its target name, an already displayed result thumbnail
when available, and an explicit locate action. At narrower widths the existing
window front/back controls remain available and parameters can use the viewport
instead of being squeezed into the sliver beside Agent. Neither opening nor
resizing these surfaces pans the canvas, changes node coordinates, discards drafts,
or changes the persisted panel-width preference. Locating a node is an explicit
user action. Larger windows retain the existing overlap policy.

## Independent workflow conversations (2026-11-10, workflow-agent-isolation#001)

Each workflow owns its Agent transcript, creative context and summaries, unsent
draft and loaded draft attachments, chat and image model selections, and the
conversation's provider, thinking, search and size preferences. Draft content is
persisted with that workflow but excluded from model and compaction context until
sent. The configured model/Provider catalog and panel width remain application
preferences.

Switching workflows does not cancel an accepted Agent reply or compaction request.
Each request captures its workflow identity, model configuration and canvas inputs
before waiting. Background replies and summaries update only their original
workflow through the workflow-identity mutation interface, merging against its
latest document rather than replacing newer graph or generation-result changes.
Only the visible workflow projects processing controls and progress into the
shared panel. Legacy callers without a stable workflow identity retain cancellation
on restoration because a background result cannot be routed safely.

Stop and `/clear` affect only the visible workflow's Agent request. Closing a
workflow cancels its outstanding Agent request; application exit stops all Agent
requests. Late replies after cancellation or closure cannot recreate conversation
content or change another workflow's busy state. Closing only the Agent panel
continues to dismiss its presentation without cancelling its request.

## Repeatable proposal batches (2026-11-10, agent-plan-batches#001)

Canvas proposals expose Run and Apply only directly. Each activation creates an
independent batch with its own node bindings, connections, model configuration,
execution attempts and results. Proposals that target existing nodes create
editable copies; the original nodes remain unchanged. Nonexecuting generated-image
sources retain their complete cached output batch on a separate generated-image
node; their old inputs are not copied or executed.

Run executes only its newly created batch; Apply only creates and saves that batch.
An earlier batch may continue running while a new batch is created. Retry retains
the failed batch identity rather than creating another batch. Conversation writes
merge one instance by identity so late completions cannot replace newer batches.

Only verified additions may use the history transaction's additive rollback path
while other nodes run. Failure removes those additions instead of restoring the
whole graph and overwriting another run's updates. Transactions that mutate existing
nodes retain the original running-state exclusion and complete rollback policy.

## Original consequences (historical)

- The canvas remains visible while the assistant is used, and users can tune the panel width to their workspace.
- A missing selected image-generation node does not prevent conversation, but application actions remain unavailable until the user selects one.
- The UI shows observable work stages rather than private model reasoning, preserving a lightweight Codex-like interaction without exposing chain-of-thought.
- The first version intentionally avoids a global Agent history, an always-visible memory inspector, and a separate modal progress flow.
