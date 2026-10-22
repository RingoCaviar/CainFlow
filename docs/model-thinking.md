# 模型思考参数（prompt-agent#047）

## 能力依据

核验日期：2026-10-22。能力登记在 `js/features/execution/thinking-config.js`，按任务、协议、精确模型身份和 Provider 判断。模型显示名称不参与识别；未知中转默认不传。手动兼容模板是用户对接口能力的声明，不是在线能力检测。

| 模板 | 请求字段 | 边界与官方来源 |
| --- | --- | --- |
| OpenAI 对话 | Chat 的 `reasoning_effort`；Responses 的 `reasoning.effort` | [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)。o 系列 low/medium/high；GPT-5 增加 minimal；5.1 支持 none；登记的 5.2/5.4/5.5 支持 none/low/medium/high/xhigh。[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)使用 low/medium/high/xhigh/max。 |
| Gemini 对话等级 | `generationConfig.thinkingConfig.thinkingLevel` | [Thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking?hl=en)。按登记模型区分 low/high、minimal/low/medium/high 或 low/medium/high。 |
| Gemini 2.5 预算 | `generationConfig.thinkingConfig.thinkingBudget` | 同上。Pro 128–32768，不能关闭；Flash 允许关闭及 1–24576；Flash-Lite 允许关闭及 512–24576。动态预算发送 -1。等级与预算不同时发送。 |
| Gemini 生图 | 同等级字段 | [Image generation](https://ai.google.dev/gemini-api/docs/image-generation)。3.1 Flash Image / Flash-Lite Image 登记 minimal/high。固定或未确认可调整模型显示“由接口控制”。 |
| OpenAI 生图 | 无新增思考字段 | [Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)。画质参数保留原义。 |
| DeepSeek | `thinking.type` 和 `reasoning_effort` | [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)。登记 Flash / V4 Pro 的 enabled/disabled 与 low/high/max；关闭不发送启用档位。 |
| Qwen | `enable_thinking`、`thinking_budget` | [Deep thinking](https://help.aliyun.com/en/model-studio/deep-thinking)。自动识别登记的商业版非流式模型；预算模板采用文档列出的 1–32768 范围。固定思考模板不提供关闭。未登记、仅流式模型不自动开放；更高预算不自行猜测。 |
| TTAPI | 保留 `thinking_level` | 旧协议字段和大小写继续保留；手动模板仅 Minimal/High。公开资料未确认完整适用范围，因此不自动识别或推广。 |

接口会更新；新增模型或档位需要官方依据、更新登记日期及受控测试。自定义端点是否接受模板须由用户按渠道文档确认，拒绝后不删字段重试或换模型。

## 状态与继承

- 模型：`thinking = {profile, default, providers}`；Provider 项仅覆盖兼容方式。标准化入口保留该字段，配置导入导出沿用既有模型归档。
- 选择值：`{mode:'default'}`、`{mode:'level',value}`、`{mode:'budget',value}`、`off`、`on`、`dynamic`；不设值表示继承。接口默认只是不额外传参，不代表关闭思考。
- Agent：`thinkingSettings.chat[modelId]` / `image[modelId]` 随工作流保存；清空、压缩保留；模型切换不搬用设置。
- 节点：`node.data.thinking`，序列化为节点 `thinking`；恢复、运行前重置和执行快照必须保留。后台无窗口的运行文档不挂载界面控件。
- 方案：`thinkingOverrides[stepId][modelId]` 优先于 `agentThinking[modelId]`，再到模型默认。显式接口默认停止继承。应用写入节点，变更清单显示前后值，沿用批量撤销。
- 对话配置在请求开始时复制，压缩及检索后整理沿用这份配置；专用搜索模型仍用自身默认。运行中的节点拒绝修改，新设置仅影响下一次操作。

`resolveThinking` 负责继承和校验；`applyThinking` 仅构造登记字段，合并 Gemini 图片配置。显式非默认设置与已有自定义思考字段冲突时停止请求；接口默认保留原请求字段，包括旧 TTAPI 参数。未知/失效设置保留以便修正，不自动降档。

## 界面和输出

共享控件用于模型设置、节点、Agent 和方案步骤。Agent 底部为紧凑图标入口，保留完整无障碍名称和提示。菜单沿用现有主题、浮层协调及键盘操作；普通主题使用不透明表面，按钮无发光和浮雕。

只显示最终回答和图片。Gemini `thought: true` 的文本及图片被过滤；OpenAI 兼容回复只读取最终 content，不读取 reasoning_content。本次没有新增思维链展示、流式传输或 Responses 生图。
