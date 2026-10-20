# Prompt Agent 意图评估

对应本地 Issue：`prompt-agent#014`、`prompt-agent#015`、`prompt-agent#016`、`prompt-agent#017`、`prompt-agent#018`。

本次规则参考 Codex 内置 `imagegen/SKILL.md` 的意图决策、图片角色、具体程度策略和编辑不变量，按 CainFlow 的能力改写。运行时规则集中在 `js/features/prompt-agent/prompt-agent-instructions.js`。CainFlow 仍由用户检查 Prompt Plan，再应用到明确选中的 Image-Generation Node；对话附件不会自动连入生图节点。

## 自动回归

```powershell
node --test tests/prompt-agent-model.test.mjs tests/prompt-agent-panel.test.mjs tests/prompt-agent-conversation-store.test.mjs tests/prompt-agent-compaction.test.mjs tests/prompt-agent-node-adapter.test.mjs tests/prompt-agent-execution-adapter.test.mjs tests/prompt-agent-runtime-completion.test.mjs tests/prompt-agent-workflow-persistence.test.mjs tests/prompt-agent-browser.test.mjs tests/prompt-agent-commands-browser.test.mjs tests/prompt-agent-reference-picker.test.mjs tests/prompt-agent-layout.test.mjs tests/chat-request-plan.test.mjs tests/application-module-parse.test.mjs tests/image-generation-size.test.mjs
```

测试通过受控的 Provider 回复检查请求中实际存在的对话角色、完整草稿、媒体与图片标识、能力限制，以及回复校验和节点应用。它们不衡量真实模型的语义准确率。

场景参考图选择器直接从 `index.html` 读取生产页面结构进行浏览器回归，覆盖多选、取消、编号、焦点、关闭、空列表、历史恢复，以及三种主题和 300px / 612px 面板宽度。节点读取回归覆盖缓存原图、URL 转换、源图片变化和工作流切换。勾选顺序决定当前消息的参考图序号，取消后自动连续编号；相同像素的多次引用保留序号映射，模型媒体无需重复传输。

生成状态回归组合实际 Workflow Runtime Manager 与 Agent Execution Adapter，保持模拟生成过程未结束时，Agent 必须持续等待；最终状态、节点错误和本次运行的完整图片批次才可结束等待。覆盖失败、超时、停止、生成结果落盘等待、原图内存释放、切换工作流与上下文清理，避免把后台启动确认误当作执行完成。

## 上下文命令

输入 `/` 显示菜单，继续输入可筛选；上下键选择，Enter 或点击执行，Escape 关闭。Shift+Enter 保持换行，中文输入法确认不会执行命令。

- `/clear`：清除当前场景的聊天、摘要、历史方案与参考图，同时移除输入中的待发送参考图。无需配置模型；画布、面板宽度和开关状态保持。
- `/compact`：调用当前对话模型整理目标、最新纠正、硬约束、精确文字、参数与待办。历史聊天仍可查看，完整最新 Prompt Plan 和参考图身份单独保存，后续请求使用摘要与新对话。

行为参考 [Codex 命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 中以简洁摘要替换早期轮次的 `/compact`。CainFlow 的实现兼容现有 OpenAI 与 Google 对话协议，使用可读语义摘要；[Responses 原生 compaction](https://developers.openai.com/api/docs/guides/compaction) 则返回需要原样复用的不透明压缩项，两者的请求格式与实现不同。

存储保持 version 1，新增可选 `contextSummary`、`archivedMessages` 和 `compactedMessageCount`。归档仅供展示；边界之前的原文已由摘要覆盖，不再发送。自动裁切后尚未被语义摘要覆盖的原文仍会参加下一次手动压缩，避免只总结已丢失早期约束的尾部记忆。摘要后新增消息进入 `messages`，自动记忆进入 `memory`，不会裁切既有摘要。

压缩服务仅发送文字与图片身份、名称、原消息序号，长输入按序分批，每批记录 JSON 不超过 12000 字符，前批摘要参与下一批，最终摘要不超过 3000 字符。只有全部批次成功且上下文未变化，才写入摘要并推进边界。失败、取消、清空和切换场景时丢弃过期结果；运行中的生成卡片保留。

回归覆盖重复压缩、跨保存恢复、旧原文不重复进入后续请求、历史参考图序号、超长完整草稿、压缩期间新增消息、迟到响应和取消。2026-10-20 共 121 项相关测试通过，包含生产面板的浏览器测试及三种主题的 300px / 612px 布局。使用受控模型响应验证状态流转；真实摘要质量依赖所选模型，可用下表继续评估。

## 缓存面板与入口

缓存面板单独显示 Agent 缓存：已打开场景合计、当前场景占用、消息数、参考图数，以及当前有效上下文、归档和摘要数量。占用是 Agent 快照的 UTF-8 JSON 大小估算，包含未保存修改和实际重复保存的图片文本；它不等于去重媒体文件空间，也不扫描已关闭的工作流存档。实时当前快照覆盖同一 Workflow identity 的旧状态，清空后旧快照不会被重复统计。

打开面板、更新对话、压缩、清空和场景切换时刷新本地统计，不等待磁盘媒体审计。面板打开期间沿用定时刷新；关闭其他场景后，也可重开面板立即更新合计。压缩保留归档，不能把模型上下文缩短误报为清理历史存储。

Agent 按钮使用共享主题调色盘的渐变描边和底色；悬停光晕、展开高光和键盘焦点区分状态，不加常驻动画。light / dark / pink 的按钮及 320px / 360px 缓存卡片已完成浏览器检查。

```powershell
node --test tests/prompt-agent-cache-usage.test.mjs tests/cache-usage-media-distribution.test.mjs tests/prompt-agent-cache-browser.test.mjs tests/prompt-agent-browser.test.mjs tests/prompt-agent-layout.test.mjs tests/settings-theme-surface-browser.test.mjs tests/node-asset-cache-cleanup.test.mjs tests/application-module-parse.test.mjs
```

以上 31 项测试通过，统计和浏览器夹具均不调用真实模型。

## 真实模型评估

在 Agent 面板选择待评估的对话模型，记录模型 ID、协议、是否支持图片输入和回复。每组独立场景使用新工作流；多轮场景保留同一工作流。无需点击“应用并生成”。每次更改规则或对话模型后重跑，按下表记录通过/失败及原始回复。

| 场景与准备 | 用户输入 | 通过条件 |
| --- | --- | --- |
| 选中已有生图节点 | 电影感和胶片感有什么区别？先别写提示词。 | 直接解释，无 Prompt Plan 和应用按钮。 |
| 没有选中节点 | 帮我画一只橘猫在窗边晒太阳。 | 直接起草，不要求先选节点或回答尺寸、风格问卷；应用按钮不可用。 |
| 详细新需求 | 一只白猫，背景纯黑，文字必须是“晚安。”，其他不要加。 | 保留数量、颜色和逐字文字，不增加道具、口号或冲突的“无文字”限制。 |
| 节点已有城市夜景 | 重新开始，给我一张极简陶瓷杯产品图。 | 新画面不混入旧城市、夜景或旧主题限制。 |
| 上传含红色建筑的图片 | 只参考这张的配色，画一只全新的猫。 | 新建意图；图片为参考，画面不强制保留建筑和原构图。 |
| 上传人物照片 | 只把背景换成雪山，人脸、衣服、姿势都别动。 | 图片为编辑目标；完整提示词明确保留人物，未连接时提示接入目标节点。 |
| 没有图片、节点或既有对象 | 把这张图的背景改成雪山。 | 只询问必要目标图片，无伪造编辑方案。 |
| 单独上传图片，无此前任务 | 无文字 | 询问希望如何使用图片，不自动假设保留主体生图。 |
| 两张输入图片 | 保留第一张的人物，只参考第二张的笔触，别带入第二张背景。 | 两个输入角色明确，人物身份与参考风格分开，不互换图片。 |
| 点击加号，先勾选场景中靠后的图，再勾选靠前的图 | 参考图 1 的配色和参考图 2 的主体。 | 按缩略图上显示的勾选序号理解，不能按画布节点或选择器排列顺序取图。 |
| 上一轮发送两张参考图，本轮重新勾选且顺序相反 | 这次参考图 2 的构图。 | 使用本轮序号；如明确说“上一轮的第 2 张”，则使用上一条消息的序号映射。 |
| 先要求红车海报、标题“出发！”，不应用；节点仍是城市图 | 车换成蓝色，标题不变。 | 使用上一版草稿，保留完整标题，返回完整蓝车提示词。 |
| 先要求 16:9、两张同主题变体，不应用 | 再暖一点，其他不变。 | 保留仍未应用的比例、次数及其他约束；只改光线/色调。 |
| 上轮发过照片，这轮不发图片 | 还是刚才的人，把背景改成室内。 | 沿用历史图片；不会因本轮无附件假装没图或猜测人物。 |
| 先给出主体、精确标题与禁止事项，多轮修订后执行 `/compact` | 改为黄昏，其他不变。 | 延续最新方案，保留主体、逐字标题、禁止事项与参数；不得退回节点旧提示词。 |
| 先发送两张图并明确角色，执行 `/compact` 后保存并重新打开工作流 | 继续用之前第 2 张的配色。 | 通过旧消息序号映射找到相同图片，沿用其参考角色；聊天历史可查看。 |
| 节点旧负面提示词为“文字、水印” | 海报上加标题“夏日”。 | 消除与标题冲突的负面限制，同时保留仍适用的水印限制。 |
| 节点不支持透明背景参数 | 给这张产品图抠出透明背景。 | 说明当前节点能力限制，不伪造参数、不换模型、不把棋盘格当透明。 |
| 对话模型明确不支持视觉 | 上传照片并要求描述图中内容 | 如实说明无法看图，不编造人物、颜色、构图等细节。 |
| 同一构图的多个变体 | 同一只杯子给我三张变体。 | 使用节点支持的 count=3，不声称已生成；与三个不同主题区分。 |
| 多个不同画面 | 分别给我猫、山、水杯三张图。 | 说明每幅需独立方案及当前覆盖内容，不把三者拼成一张或声称全部完成。 |

长历史使用 16,000 字符的普通消息预算，图片二进制不进入文字预算。超出预算的普通历史整条省略并标注；Workflow Memory 仅作有损背景。最新完整 Prompt Plan 始终保留，即使单条超过普通历史预算；它随工作流保存和清空。
