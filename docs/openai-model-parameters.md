# OpenAI 模型参数

核验日期：2026-11-11。以下是 CainFlow 当前对话节点、Prompt Agent 与生图节点使用的参数；模型未登记或使用中转服务时，实际能力以该供应商为准。

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

没有参考图时使用 [Images generations](https://developers.openai.com/api/reference/resources/images/methods/generate)，带参考图时使用 [Images edits](https://developers.openai.com/api/reference/resources/images/methods/edit)。下表记录 OpenAI 兼容格式在 CainFlow 静态生图流程中的选项。未知模型 ID 保留原有兼容行为。

| 模型 | 尺寸 | 质量 | 编辑保真度 |
| --- | --- | --- | --- |
| GPT Image 1、1.5 | `1024x1024`、`1536x1024`、`1024x1536` 或自动 | `auto` / `low` / `medium` / `high` | `low` / `high` |
| GPT Image 1 mini | 同上 | 同上 | 仅 `low`，界面不额外显示单一选项 |
| `chatgpt-image-latest` | 同上 | 同上 | 省略 |
| GPT Image 2 | 支持档位、比例和自定义像素尺寸 | `auto` / `low` / `medium` / `high` | 省略 |
| GPT Image 2.5 Sunburst / Flare | 同上 | 另支持 `xhigh` / `max` | 省略 |
| GPT Image 2.6 Sunburst / Flare | CainFlow 提供文档确认的标准静态尺寸和自动 | 同 2.5，另有 `complexity` 规划档位 | 省略 |
| DALL·E 2 | `256x256`、`512x512`、`1024x1024` | 标准 | 单张参考图 |
| DALL·E 3 | `1024x1024`、`1792x1024`、`1024x1792` | `standard` / `hd` | 仅生成；另有 `vivid` / `natural` 风格 |

GPT Image 可设 PNG、JPEG 或 WebP。仅 JPEG、WebP 发送 `output_compression`（0–100）；透明背景须使用 PNG 或 WebP。GPT Image 的结果是 Base64，CainFlow 根据返回格式或请求格式标记实际图片类型。DALL·E 的 URL / Base64 返回格式走旧字段 `response_format`。DALL·E 与 GPT Image 1 已从 OpenAI 官方 API 下线；表中保留其参数规则以读取旧工作流和兼容仍提供这些模型的中转。

CainFlow 的“生成次数”继续由应用调度，每个上游请求生成一张图。SVG、动画 GIF、流式部分图片和标注层需要不同的输出或输入流程；这里的参数表只覆盖现有静态图片流程。尺寸和格式限制见 [Image generation 指南](https://developers.openai.com/api/docs/guides/image-generation)。
