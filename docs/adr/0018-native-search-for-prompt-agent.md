# Keep Agent search evidence separate from conversation and image generation

Local issue: `prompt-agent#042`.

Prompt Agent uses one explicit search round between the conversation model's intent response and its final reply. Gemini supplies native Google Search grounding; OpenAI supplies Responses `web_search`, including structured image results where supported. The conversation model continues to own the final reply and Prompt Plan. Keeping a separate search adapter preserves ordinary chat-node request formats and allows a dedicated search model without changing the conversation model.

## Configuration and execution

The compact composer has a “联网” menu with automatic/off mode and an optional dedicated search model. `searchSettings: { mode, modelId }` belongs to the workflow conversation, survives clear/compact, and defaults to automatic with no dedicated selection. A model declares `agentSearch: none | web | images`: legacy Google chat configurations default to web; legacy OpenAI configurations require explicit opt-in to Responses. The current conversation model wins when it supports the requested type; otherwise only the selected dedicated model may run. Missing capability, model, provider or literal Responses endpoint produces an error instead of choosing another model.

An operation captures model definitions, provider order/addresses/credentials and search settings before any asynchronous work. The intent reply may contain `searchRequest: { kind: web | images, query }`; synthesis receives `searchAllowed: false`. Native provider tools can perform multiple internal lookups, but another application search request is rejected for that user turn. Existing cancellation and workflow/conversation fences discard late callbacks.

Responses requests use their own URL/body through the existing proxy transport. Automatic URL completion derives `/v1/responses` (or the configured version base); literal endpoints require `responsesEndpoint`. Google uses the existing generateContent search tool. Search-model cumulative usage never calibrates the context ring; the conversation model's actual input usage and the full evidence supplied to it do.

## Configuration recovery and guidance (2026-10-21, prompt-agent#043)

Model normalization retains the explicit `agentSearch` enum and positive integer `autoCompactTokenLimit` during startup and configuration import. An absent search declaration remains absent, preserving the legacy Google default; explicit `none` is never replaced by a default. Configuration ZIP import/export also retains a Provider's independent `responsesEndpoint`.

The model editor labels search declarations as “未启用搜索”, “网页搜索”, and “网页及图片搜索”, exposing only capabilities implemented for the selected compatible format. Changing format retains an incompatible stored declaration as unavailable instead of silently substituting another capability. Declaring a capability does not add server support.

The Agent menu and execution share one availability resolver for each search type. It selects the current conversation model when capable, otherwise only the explicitly chosen dedicated model, and validates the resolved Provider/address without falling back to another model. Menu actions navigate to the precise model field or Provider address; returning from settings refreshes availability and reopens the menu only in the same still-visible workflow conversation. Newly added models remain unselected. Execution continues to capture its immutable configuration before awaiting any response.

## Durable evidence

Each reply can store a normalized `search` record containing verified search status, query/type, retrieved text, registered source IDs, up to 12 structured image candidates, notices, and Google's suggestion HTML. Only native tool records/grounding metadata establish search status; generated prose and guessed image URLs do not. Replies use `[[source:ID]]` markers checked against registered sources. The renderer creates links from those records, and suggestion HTML is confined to a sandboxed iframe with no scripts or same-origin access.

Message/archive persistence retains full evidence. Compaction asks the model to preserve relevant conclusions with their exact source IDs, and subsequent requests project only sources cited by the summary plus active-turn evidence. Unrelated archived search text stays outside the effective context. Failed synthesis retains retrieved evidence so a successful search is not lost with a malformed plan.

## Network pictures and Media assets

Search image candidates remain metadata until preview or manual selection. Preview uses the shared fullscreen viewer without nodes. “加入参考图” downloads the original and uses the existing reference-source adapter, ImageImport lifecycle, undo and Media asset persistence. A node records the original URL, source page and local asset through `agentReferenceSource`; reuse requires the same URL and unchanged canonical asset. Imported pictures remain usable offline. Unselected candidates never enter the image-role catalog or generation inputs.

The public-image reader is separate from the general model proxy, which intentionally permits user-configured private servers. It accepts only public HTTP(S) addresses, validates every DNS answer and redirect, pins the validated IP while preserving Host/TLS identity, forwards no provider/browser credentials, and bounds redirects, time, bytes and raster dimensions. Browser decoding must succeed before import. Missing originals never fall back to thumbnails. Clearing, removing a loading reference or changing workflows invalidates pending imports; removing an Agent reference retains its canvas node, while deleting that node removes its Agent references.

Provider contracts: [Gemini Google Search](https://ai.google.dev/gemini-api/docs/generate-content/google-search), [OpenAI Responses web/image search](https://developers.openai.com/api/docs/guides/tools-web-search). Tests use controlled responses and images; native support still depends on the selected model and provider actually implementing the configured capability.


## Current-model search switch (2026-10-23, prompt-agent#055)

This supersedes the dedicated-model fallback and search-menu guidance above. Agent presents one search switch in the conversation model settings. Declared unsupported models show an unchecked disabled switch; supported models permit toggling. Legacy dedicated model IDs remain readable but are never used for routing. Requests use the captured conversation model and Provider. No capability probing request is sent; upstream rejection is surfaced with its reason and no fallback. Responses without tool metadata retain their text, but do not claim verified search or invent sources. Existing workflow on/off preferences remain durable.


### User-controlled search (2026-10-23)

The switch is always editable and reads only the workflow on/off preference. Agent request permission and request construction ignore `agentSearch`, including absent or `none` values. No Google/OpenAI capability default controls Agent requests. Existing transport encoding still selects Google Search or OpenAI Responses by protocol; this is request formatting, not a model-support assertion. Upstream errors report unsupported search without probing or fallback. Legacy capability declarations remain stored for compatibility.

### Model editor simplification (2026-10-23, model-settings#003)

The model editor no longer exposes `agentSearch`, per-model `autoCompactTokenLimit`, or thinking compatibility/default controls. Agent and canvas nodes own their search switches; upstream responses determine whether the selected request supports search. The Agent compaction threshold is a single disk-backed application preference under General Settings, shared across models and workflows. On first upgrade, a valid threshold from the selected conversation model seeds that preference once; subsequent model changes cannot change it. Old model records retain their fields for archive compatibility, but their compaction threshold no longer drives the meter. Existing thinking selections and legacy saved model defaults remain readable; removing the editor controls does not rewrite prior request behavior.
