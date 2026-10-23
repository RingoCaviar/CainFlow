# Agent 面板文字层级与空间 QA（prompt-agent#054）

Agent 面板正文和输入为 14px；方案标题、模型名及主操作为 13px；步骤、状态与错误提示至少为 12px；次要说明为 11px。正文段落间距由 8px 降至 5px，方案列表间距由 4px 降至 2px。图片尺寸和按钮最小高度未缩减。

受控浏览器回归检查七套主题的 300px 面板，另检查 480px 面板及 620px 窄窗口。覆盖长模型名截断、长方案参数换行、可见按钮高度、面板横向溢出、菜单键盘操作、滚动到底部和历史图片预览。

执行：`node --test --test-concurrency=1 tests/prompt-agent-conversation-design-browser.test.mjs tests/prompt-agent-compact-browser.test.mjs tests/prompt-agent-menu-theme-browser.test.mjs tests/prompt-agent-scroll-browser.test.mjs tests/prompt-agent-result-preview-browser.test.mjs tests/prompt-agent-layout.test.mjs`。结果：7 项通过。
