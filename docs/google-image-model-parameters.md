# Google 生图模型参数

核验日期为 2026-11-13。CainFlow 的 Google / Gemini 生图协议使用 Gemini API 的 `generateContent`。参考图上限按请求中的图片总张数计算，一条连线可以提供多张图。下表列出当前官方生图型号。[Google 生图指南](https://aistudio.google.com/docs/image-generation?generate-content=true#model-selection)

| 模型 ID | 参考图上限 | 输出分辨率档位 | 宽高比 | 可选思考档位 | 网页搜索 |
| --- | ---: | --- | --- | --- | --- |
| `gemini-nano-banana-2.1` | 14 | 1K、2K、4K | 14 种 | `minimal`、`medium`、`high` | 支持 |
| `gemini-3.1-flash-image` | 14 | 512、1K、2K、4K | 14 种 | `minimal`、`high` | 支持 |
| `gemini-3.1-flash-lite-image` | 14 | 固定 1K 档 | 14 种 | `minimal`、`high` | — |
| `gemini-3-pro-image` | 14 | 1K、2K、4K | 10 种 | 模型内置 | 支持 |
| `gemini-2.5-flash-image` | 3 | 固定约 1K | 10 种 | — | — |

10 种标准比例为 `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9`。14 种比例再加 `1:4`、`4:1`、`1:8`、`8:1`。省略比例时由接口决定，固定尺寸型号省略 `imageSize`。Google 3 Pro 的 14 张总上限包含高保真参考图，官方给出的高保真数量为 5 张。Flash Lite 的 14 张上限来自同型号 Google Cloud 规格，Google AI Studio 将它定位为轻量编辑模型。2.5 Flash 的 3 张上限也有 Google Cloud 规格确认。[参考图说明](https://aistudio.google.com/docs/image-generation?generate-content=true#use-14-images) · [比例与尺寸](https://aistudio.google.com/docs/image-generation?generate-content=true#aspect-ratios-and-image-size) · [Flash Lite 规格](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite-image#specifications) · [2.5 Flash 规格](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-image#specifications)

网页搜索沿用节点的搜索开关。图片搜索是 Nano Banana 2.1 和 3.1 Flash 的独立能力，Google 要求展示来源网页链接，当前静态生图节点没有该展示流程。生成次数由 CainFlow 调度，每次请求读取一张生成结果。连接的参考图按原有顺序以 `inlineData` 发送，整包仍受 `generateContent` 内嵌请求体大小限制。[思考档位](https://aistudio.google.com/docs/image-generation?generate-content=true#thinking-levels) · [搜索](https://aistudio.google.com/docs/image-generation?generate-content=true#use-with-grounding) · [图片搜索展示要求](https://aistudio.google.com/docs/image-generation?generate-content=true#image-search) · [内嵌图片](https://aistudio.google.com/docs/image-understanding?generate-content=true#inline-image)

历史 Gemini 预览 ID 保留已登记的能力，是否可调用取决于实际渠道。Gemini API 已下线的 Imagen 文生图型号使用独立的 Predict 接口，参考图数量为 0。未登记的 Google 兼容模型继续使用协议默认值，协议中显式配置的更低上限继续生效。[下线时间](https://aistudio.google.com/docs/deprecations#nano-banana-models) · [Imagen 历史接口与下线时间](https://aistudio.google.com/docs/deprecations#imagen-models)
