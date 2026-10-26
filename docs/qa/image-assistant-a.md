# 原始 A 生图节点与创作助手验收

实施基点：`93312eb891d7b49923f09af2933595a78a272c41`。对应本地规格 `image-assistant-prototype#005`，按 #006—#014 顺序交付。供应商响应受控，工作流和媒体存储隔离，不调用真实计费模型。

## #006 节点编辑与尺寸保留

- 红：完整应用测试确认提示词排列在模型之后；旧工作流的 476px 节点宽度和 241px 提示词高度恢复成 410px 和默认高度。
- 绿：提示词和参考区域优先；自定义 1536×1024、质量 high、生成次数 2 与实际两次请求一致，保存重开保留设置。切换不支持质量的模型会隐藏该控件。
- 旧工作流保留节点坐标、宽度和文本框尺寸；自动卡片高度仍由内容计算。
- 验证：`node --test --test-concurrency=1 tests/image-assistant-app-browser.test.mjs tests/image-compact-card-browser.test.mjs tests/node-card-layout-contract.test.mjs tests/node-resize-height-feedback.test.mjs tests/image-generation-size.test.mjs tests/application-module-parse.test.mjs`。
- 本项目为原生 JavaScript，沿用模块解析与语法检查；没有新增 TypeScript 构建或类型检查配置。

## #007 高级设置

- 红：两个节点一开一收，保存重开后原先展开状态丢失。
- 绿：高级展开状态按节点保存，旧数据默认折叠；图像附加项、协议参数、适用思考与搜索进入高级区，摘要显示自定义设置。
- 完整应用验证背景设置在模型切换、折叠、保存重开以及展开/折叠两次实际运行中保持一致。复用七主题卡片、思考能力/请求和应用模块解析回归。
- 旧卡片回归改为检查不适用的具体图像选项被隐藏；Google 的搜索设置使高级区继续有内容，这是本次确认的分组行为。
