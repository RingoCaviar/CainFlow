# OpenAI 模型参数

以下是 CainFlow 当前对话节点、Prompt Agent 与生图节点使用的参数。模型未登记或使用中转服务时，实际能力以该供应商为准。

## 对话

CainFlow 的普通对话使用 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。内置模型能力只对 OpenAI 官方端点自动启用。`max_tokens` 和 `max_output_tokens` 会归一为 `max_completion_tokens`；已填写 `max_completion_tokens` 时以它为准。对话使用 `reasoning_effort`，Prompt Agent 的原生搜索使用 Responses API 的 `reasoning.effort`。

| 模型 | 推理档位 | 省略时 |
| --- | --- | --- |
| GPT-4、GPT-4 Turbo、GPT-4o、GPT-4.1、GPT-3.5 Turbo 及已登记小型号 | 不发送推理档位 | — |
| o1、o3、o3-mini、o4-mini | `low` / `medium` / `high` | `medium` |
| GPT-5、GPT-5 mini / nano | `minimal` / `low` / `medium` / `high` | `medium` |
| GPT-5.1 | `none` / `low` / `medium` / `high` | `none` |
| GPT-5.2、GPT-5.4（含 mini / nano）、GPT-5.5 | `none` / `low` / `medium` / `high` / `xhigh` | GPT-5.5 为 `medium`，其余为 `none` |
| GPT-5.6（含 Sol / Terra / Luna）、GPT-6 Sol / Luna、GPT-6.1 Terra | `none` / `low` / `medium` / `high` / `xhigh` / `max` | `medium` |
| GPT-6 Astra、GPT-6.1 Sol | `low` / `medium` / `high` / `xhigh` / `max` | `medium` |

对支持关闭推理的模型，实际档位为 `none` 时才保留 `temperature`、`top_p`、`logprobs` 和 `top_logprobs`；无推理的普通模型也保留采样字段。`verbosity` 仅保留给已登记支持的模型。o3 和 o4-mini 不发送 `stop`。指定模型只支持 Responses，或工具调用组合不受 Chat Completions 支持时，会在发送前说明原因。详见 [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[GPT-5.4 指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4)和 [Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

## 生图

核验日期为 2026-11-13。纯提示词使用 Images generations，带参考图使用 Images edits。GPT Image 的编辑请求最多接收 16 张参考图。已知模型按下表使用各自的上限。未知模型和第三方中转的实际能力以供应商为准。 [生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate) · [编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)

| 模型 ID | 参考图上限 | 静态尺寸 | 质量 | 编辑保真度 | 官方 API 状态 |
| --- | ---: | --- | --- | --- | --- |
| `gpt-image-2.6-sunburst`、`gpt-image-2.6-flare` | 16 | 同 2.5 | 同 2.5，另有 `complexity` 规划档位 | 省略 | 可用 |
| `gpt-image-2.5-sunburst`、`gpt-image-2.5-sunburst-2026-09-08`、`gpt-image-2.5-flare`、`gpt-image-2.5-flare-2026-09-08` | 16 | 档位、比例、自定义像素尺寸或自动 | `auto` / `low` / `medium` / `high` / `xhigh` / `max` | 省略 | 可用 |
| `gpt-image-2`、`gpt-image-2-2026-04-21` | 16 | 同 2.5 | `auto` / `low` / `medium` / `high` | 固定为高保真，省略参数 | 已弃用，计划 2027-02-10 下线 |
| `gpt-image-1.5`、`gpt-image-1.5-2025-12-16` | 16 | 标准尺寸或自动 | `auto` / `low` / `medium` / `high` | `low` / `high` | 已弃用，计划 2026-12-01 下线 |
| `gpt-image-1-mini` | 16 | 标准尺寸或自动 | 同 1.5 | 仅 `low`，界面省略单一选项 | 已弃用，计划 2026-12-01 下线 |
| `chatgpt-image-latest` | 16 | 标准尺寸或自动 | 同 1.5 | 省略 | 已弃用，计划 2026-12-01 下线 |
| `gpt-image-1` | 16（历史） | 标准尺寸或自动 | 同 1.5 | `low` / `high` | 2026-10-23 已下线 |
| `dall-e-2` | 1（历史） | `256x256`、`512x512`、`1024x1024` | 标准 | — | 2026-05-12 已下线 |
| `dall-e-3` | 0 | `1024x1024`、`1792x1024`、`1024x1792` | `standard` / `hd` | — | 2026-05-12 已下线 |

标准尺寸为 `1024x1024`、`1536x1024`、`1024x1536`。GPT Image 2 和 2.5 的自定义宽高必须是 16 的倍数，长短边之比不超过 3:1，最长边不超过 3840 像素，总像素为 655,360 至 8,294,400。通用接口参数说明只在 2 和 2.5 的条目中列出自定义尺寸，2.6 专用指南明确确认自定义尺寸并举例 `1536x864`。2.6 专用指南给出 16 像素步长和 3:1 比例约束，CainFlow 对最长边和总像素沿用 2.5 的校验范围。2.6 的 `complexity` 支持 `low`、`medium`、`high`。 [图像生成指南](https://developers.openai.com/api/docs/guides/image-generation) · [GPT Image 2.6 参数](https://developers.openai.com/api/docs/guides/image-prompting#model-parameters) · [生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate)

下线模型的规则用于兼容旧工作流和仍提供这些模型的中转。 [模型下线公告](https://developers.openai.com/api/docs/deprecations) · [GPT Image 1.5 快照](https://developers.openai.com/api/docs/models/gpt-image-1.5)

GPT Image 的 multipart 参考文件支持 PNG、JPEG 和 WebP，单文件小于 50 MB。编辑遮罩独立上传并应用于第一张参考图。静态输出同样支持 PNG、JPEG 和 WebP。JPEG 和 WebP 可以发送 `output_compression`（0–100），透明背景使用 PNG 或 WebP。DALL·E 的 URL / Base64 选择使用 `response_format`，DALL·E 3 另有 `vivid` / `natural` 风格。 [编辑参数](https://developers.openai.com/api/reference/resources/images/methods/edit) · [生成参数](https://developers.openai.com/api/reference/resources/images/methods/generate)

CainFlow 调度“生成次数”，每个上游请求生成一张图。SVG、动画 GIF、流式部分图片和标注层是 OpenAI 的独立能力，当前生图节点使用静态图片流程。Responses API 的图像工具在会话上下文中接收图片，公开文档未列出该工具独立的参考图上限。表中的 16 张适用于 Images edits。 [图像生成指南](https://developers.openai.com/api/docs/guides/image-generation) · [Responses 图像工具](https://developers.openai.com/api/docs/guides/tools-image-generation)
