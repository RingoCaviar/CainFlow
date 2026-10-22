# Agent 自动压缩等待与阈值诊断

默认自动压缩阈值是 12000 Token，不是供应商最大上下文；系统指令、画布结构、实际请求历史和图片都会占用输入。未知模型图片仍保留估算，不声称等于供应商计数。圆环显示文本和图片占用分项；模型设置提示按实际容量设置并预留输出空间。本次不任意提高阈值，不截断文本或删除历史图片。

## 状态与保护

手动及自动压缩共用等待控制：显示批次、已等待秒数，保留停止按钮；当前批次超过 120 秒未完成则取消并显示失败原因，原上下文和未发送草稿保留。每批开始重新计时。即使服务忽略取消，晚到摘要也不能提交。取消、清空和工作流切换沿用原隔离规则。

一次用户请求最多自动压缩一次，发送前压缩的结果在正常回复完成后仍可见。已经压缩但保留方案/素材仍占用高时，新增内容低于 min(2000 Token, 阈值的20%) 暂不重复摘要，提示调整阈值；圆环仍显示实际估算，不伪造下降。新增内容积累后或用户手动 /compact 仍可压缩。

## 受控验证

`node --test --test-concurrency=2 tests/prompt-agent-panel.test.mjs tests/prompt-agent-compaction.test.mjs tests/prompt-agent-token-budget.test.mjs tests/prompt-agent-provider-selection.test.mjs tests/prompt-agent-conversation-store.test.mjs tests/prompt-agent-workflow-persistence.test.mjs`

119 项通过。新增回归先复现：挂起服务不能解除等待、同轮发生两次压缩。修复后验证自动/手动超时、批次进度、原稿保留、迟到结果丢弃、少量新增内容不重复压缩及成功提示保留。原有工作流切换、清空、取消、Token 分词和接口校准、统计及历史持久化回归通过。测试使用隔离状态和受控响应，不调用付费生成。

浏览器及设置专项 6 项通过，覆盖现有 Agent 对话、紧凑面板、七套主题菜单和搜索设置恢复；`git diff --check` 通过。本地 Default.json 未修改，尚未提交或发布。
