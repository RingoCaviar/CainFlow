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

核验日期为 2026-11-23。纯提示词使用 Images generations，带参考图使用 Images edits。GPT Image 的编辑请求最多接收 16 张参考图。已知模型按下表使用各自的上限。未知模型和第三方中转的实际能力以供应商为准。 [生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate) · [编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)

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

标准尺寸为 `1024x1024`、`1536x1024`、`1024x1536`。GPT Image 2、2.5 和 2.6 的自定义宽高必须是 16 的倍数，长短边之比不超过 3:1，最长边不超过 3840 像素，总像素为 655,360 至 8,294,400。2.6 的 `complexity` 支持 `low`、`medium`、`high`。 [图像生成指南](https://developers.openai.com/api/docs/guides/image-generation#size-and-quality-options) · [GPT Image 2.6 参数](https://developers.openai.com/api/docs/guides/image-prompting#model-parameters)

下线模型的规则用于兼容旧工作流和仍提供这些模型的中转。 [模型下线公告](https://developers.openai.com/api/docs/deprecations) · [GPT Image 1.5 快照](https://developers.openai.com/api/docs/models/gpt-image-1.5)

GPT Image 的 multipart 参考文件支持 PNG、JPEG 和 WebP，单文件小于 50 MB。编辑遮罩独立上传并应用于第一张参考图。静态输出同样支持 PNG、JPEG 和 WebP。JPEG 和 WebP 可以发送 `output_compression`（0–100），透明背景使用 PNG 或 WebP。DALL·E 的 URL / Base64 选择使用 `response_format`，DALL·E 3 另有 `vivid` / `natural` 风格。 [编辑参数](https://developers.openai.com/api/reference/resources/images/methods/edit) · [生成参数](https://developers.openai.com/api/reference/resources/images/methods/generate)

### 动画 GIF、SVG 与标注图层

- GPT Image 2.6 Sunburst 和 Flare 可在「更多设置」中选择 GIF 或 SVG。官方 GIF API 需要项目具备预览权限，支持提示词生成和参考图编辑。帧数 `frame_count` 为 2–16，留空时由服务使用 9 帧。每帧时长 `frame_duration_ms` 为 20–2000 毫秒，留空时为 200 毫秒，服务按 10 毫秒取整。尺寸针对单帧，整次请求还受供应商的总像素预算限制。GIF 编辑可使用普通参考图，遮罩输入需要选用其他输出格式。 [动画 GIF](https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output) · [生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate) · [编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)
- SVG 用于纯提示词生成，每次请求生成一份矢量文件。GIF 和 SVG 都采用完整结果返回，压缩字段仅适用于 JPEG 与 WebP。CainFlow 的「生成次数」仍决定独立请求的数量。 [SVG 输出](https://developers.openai.com/api/docs/guides/image-generation#generate-svg-output)
- 已开通 SVG 创作模型选择的项目，可以通过「自定义参数」节点传入 `svg.model` 和可选的 `svg.reasoning.effort`。例如 `{"svg":{"model":"项目可用的创作模型 ID","reasoning":{"effort":"low"}}}`。可选推理档位取决于创作模型，画布上的图像模型仍负责生成参考图。普通项目留空即可。 [生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate)
- GPT Image 2.5 与 2.6 支持标注引导编辑。在「更多设置」将编辑引导切换为「标注图层」，再把一张含透明像素的 PNG 连到对应图片输入。标注图层要和第一张参考图的显示尺寸一致，文件最大 50 MB。标注图层与第一张参考图各自最多为 16,777,216 像素。CainFlow 在上传前检查标注 PNG 的文件头、大小和像素数，Images API 校验实际透明像素及参考图的方向与尺寸。没有更改编辑引导的旧工作流仍使用遮罩。 [标注引导编辑](https://developers.openai.com/api/docs/guides/image-generation#guide-an-edit-with-markup) · [编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)

Responses API 的图像工具在会话上下文中接收图片。表中的 16 张适用于 Images edits。 [Responses 图像工具](https://developers.openai.com/api/docs/guides/tools-image-generation)
