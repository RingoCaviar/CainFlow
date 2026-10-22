# 思考设置 QA（prompt-agent#047）

验证使用隔离数据、受控 `/proxy` 响应，未调用付费生成。能力依据见 [设计及能力表](../model-thinking.md)。

2026-10-22：最终合并运行 102 项通过，0 失败。日志保存在本地 `.scratch/prompt-agent/thinking-complete.log`；`git diff --check` 通过。

## 自动回归

- `thinking-config.test.mjs`：Chat/Responses、Gemini 等级/预算、DeepSeek、Qwen、旧 TTAPI 字段；默认、继承、关闭、边界、非法 Provider/协议、未知中转、冲突、拒绝不重试、思考输出过滤及压缩请求。
- `thinking-controls-browser.test.mjs`：Agent 两种覆盖→方案→应用执行→实际 Google 请求→磁盘恢复；最终图片只有一张；七主题 300px 浮层边界；模型及 Provider 模板在设置中修改后重建恢复。
- 原有 canvas-app-browser：实际建图执行、批量撤销重做及媒体保护；失败步骤重试不重复建节点。
- 同跑 canvas-plan、canvas-batch、compaction、search、agent-search-settings、chat-request-plan、menu-theme-browser、provider-label-browser。

## 发现并修复的回归

1. 给后台无 defaultView 的运行文档挂载菜单会阻断生图节点恢复。现在只在可见文档挂载思考界面，后台只使用已保存数据。
2. 节点执行前清空输出会丢失新增思考覆盖。ImageGenerate/TextChat 的参数保留名单已补齐，实际请求断言覆盖该路径。
3. 300px 面板文字思考入口挤占模型名称，改用 28px 图标入口及完整提示。
4. 发布全量检查补充：思考控件放在提示词之前，保持生成进度贴近节点底部；设置的非浏览器测试文档不挂载交互菜单。窄面板为新增入口保留空间，模型触发器至少 40px，完整模型和供应商通过提示及展开菜单读取。
5. 协议编辑器同色渐变改为等价实体背景，使主题实际合成色与对比度检查一致。

代表截图位于本地 `.scratch/prompt-agent/047-screenshots/thinking-{theme}.png`；不纳入产品资源。检查普通主题不透明表面、玻璃主题、平面样式、窄面板及设置恢复。官方账户真实请求、中转实际支持情况未使用付费调用验证，不将受控测试表述为供应商联调通过。
