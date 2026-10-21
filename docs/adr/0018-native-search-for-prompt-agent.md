# Keep Agent search evidence separate from conversation and image generation

Local issue: `prompt-agent#042`.

Prompt Agent uses one explicit search round between the conversation model's intent response and its final reply. Gemini supplies native Google Search grounding; OpenAI supplies Responses `web_search`, including structured image results where supported. The conversation model continues to own the final reply and Prompt Plan. Keeping a separate search adapter preserves ordinary chat-node request formats and allows a dedicated search model without changing the conversation model.

## Configuration and execution

The compact composer has a “联网” menu with automatic/off mode and an optional dedicated search model. `searchSettings: { mode, modelId }` belongs to the workflow conversation, survives clear/compact, and defaults to automatic with no dedicated selection. A model declares `agentSearch: none | web | images`: legacy Google chat configurations default to web; legacy OpenAI configurations require explicit opt-in to Responses. The current conversation model wins when it supports the requested type; otherwise only the selected dedicated model may run. Missing capability, model, provider or literal Responses endpoint produces an error instead of choosing another model.

An operation captures model definitions, provider order/addresses/credentials and search settings before any asynchronous work. The intent reply may contain `searchRequest: { kind: web | images, query }`; synthesis receives `searchAllowed: false`. Native provider tools can perform multiple internal lookups, but another application search request is rejected for that user turn. Existing cancellation and workflow/conversation fences discard late callbacks.

Responses requests use their own URL/body through the existing proxy transport. Automatic URL completion derives `/v1/responses` (or the configured version base); literal endpoints require `responsesEndpoint`. Google uses the existing generateContent search tool. Search-model cumulative usage never calibrates the context ring; the conversation model's actual input usage and the full evidence supplied to it do.

## Durable evidence

Each reply can store a normalized `search` record containing verified search status, query/type, retrieved text, registered source IDs, up to 12 structured image candidates, notices, and Google's suggestion HTML. Only native tool records/grounding metadata establish search status; generated prose and guessed image URLs do not. Replies use `[[source:ID]]` markers checked against registered sources. The renderer creates links from those records, and suggestion HTML is confined to a sandboxed iframe with no scripts or same-origin access.

Message/archive persistence retains full evidence. Compaction asks the model to preserve relevant conclusions with their exact source IDs, and subsequent requests project only sources cited by the summary plus active-turn evidence. Unrelated archived search text stays outside the effective context. Failed synthesis retains retrieved evidence so a successful search is not lost with a malformed plan.

## Network pictures and Media assets

Search image candidates remain metadata until preview or manual selection. Preview uses the shared fullscreen viewer without nodes. “加入参考图” downloads the original and uses the existing reference-source adapter, ImageImport lifecycle, undo and Media asset persistence. A node records the original URL, source page and local asset through `agentReferenceSource`; reuse requires the same URL and unchanged canonical asset. Imported pictures remain usable offline. Unselected candidates never enter the image-role catalog or generation inputs.

The public-image reader is separate from the general model proxy, which intentionally permits user-configured private servers. It accepts only public HTTP(S) addresses, validates every DNS answer and redirect, pins the validated IP while preserving Host/TLS identity, forwards no provider/browser credentials, and bounds redirects, time, bytes and raster dimensions. Browser decoding must succeed before import. Missing originals never fall back to thumbnails. Clearing, removing a loading reference or changing workflows invalidates pending imports; removing an Agent reference retains its canvas node, while deleting that node removes its Agent references.

Provider contracts: [Gemini Google Search](https://ai.google.dev/gemini-api/docs/generate-content/google-search), [OpenAI Responses web/image search](https://developers.openai.com/api/docs/guides/tools-web-search). Tests use controlled responses and images; native support still depends on the selected model and provider actually implementing the configured capability.
