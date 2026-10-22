# Agent 尺寸设置 QA

Issue：`prompt-agent#050`。使用隔离工作流、临时数据库及受控模型／图片结果，无付费请求。

## 复现与修复依据

执行 `node --test --test-name-pattern="ratio-only|aspect spelling" tests/prompt-agent-size.test.mjs tests/prompt-agent-node-adapter.test.mjs`，修复前两个失败：`aspect` 返回“当前节点不支持参数 aspect”；仅指定比例自动补 1K，未询问分辨率。修复后通过。

统一边界别名及目标组合校验，取消自动补档；校验放在目标创建与素材准备前。浏览器验证旧 Prompt Plan 的 aspect 转换为画布方案后仍使用所需比例。

## 最终回归

以下 13 个测试文件合计 **182 项通过，0 失败**：

```powershell
node --test tests/prompt-agent-size.test.mjs tests/prompt-agent-size-browser.test.mjs tests/prompt-agent-provider-selection-browser.test.mjs tests/prompt-agent-node-adapter.test.mjs tests/prompt-agent-panel.test.mjs tests/prompt-agent-canvas-plan.test.mjs tests/image-generation-size.test.mjs tests/prompt-agent-conversation-store.test.mjs tests/prompt-agent-workflow-persistence.test.mjs tests/prompt-agent-token-budget.test.mjs tests/prompt-agent-model.test.mjs tests/prompt-agent-menu-theme-browser.test.mjs tests/prompt-agent-canvas-app-browser.test.mjs
```

结果日志：`.scratch/agent-050-final.log`。

- 自动分辨率＋16:9：出现明确询问，应用不可用，画布节点为零，仅发生原对话请求。
- 回复“用2K”：同一方案保留16:9，无新增模型请求；确认执行的请求为 `size=2048x1152`，节点为2K／16:9。
- 面板偏好保存后重建应用恢复；后来改为4K不会覆盖已执行方案的2K记录。
- 多步骤缺省补齐和明确字段优先、Google 默认分辨率＋比例、自定义尺寸匹配和缺失、非法档位／比例／宽高、节点写入顺序、旧单步澄清与工作流隔离。
- 仅应用后再生成复用同一批节点和撤销步骤；撤销后Agent结果仍保留。修复新旧节点空宽高表示差异导致的重复应用签名。
- 手动供应商选择、现有方案执行／失败重试、会话压缩保存及上下文计数继续通过。部分旧测试仍假设优先级供应商，已按 `prompt-agent#049` 改为显式选择的受控夹具。

## 浏览器与截图

七主题（dark/pro/paper/light/glass-light/glass-dark/pink）、300px Agent 面板：尺寸菜单、子菜单边界、主题背景与 Esc 返回父层通过；点击生成验证实际请求。现有菜单回归同时覆盖焦点、键盘、主题对比度及销毁。

代表性截图：`.scratch/agent-050-screens/size-dark.png`、`size-light.png`；同目录包含七套主题。设置菜单沿面板一侧向上展开，避免覆盖左侧导航和通知。

生成截图：设置 `CAINFLOW_QA_SCREENSHOT_DIR=.scratch/agent-050-screens` 后运行 `tests/prompt-agent-size-browser.test.mjs`。

`git diff --check` 通过。保留用户原有 `workflows/Default.json` 修改（1行新增／183行删除），未提交、推送或发布。


## v3.8.1 发布验证（2026-10-22）

在暂存快照的隔离目录运行完整发布门禁，保留本地 `workflows/Default.json`，包内使用仓库版本。Node 1189 项中 1187 通过、2 跳过、0 失败；Python 275 项通过；桌面及 SQLite 初始化 148 项通过，媒体资产安全门禁、工作流夹具、语法检查和源码启动冒烟通过。

取消自动供应商选择后，旧测试夹具改为明确选择供应商；对话展示夹具设置显式高压缩阈值，使其不依赖未提供的压缩服务。浏览器恢复断言等待实际设置恢复，临时配置目录清理重试文件锁并始终关闭测试服务。本机完整门禁通过 Node 包装入口限制测试并发为 2，测试范围不变，未调用付费生成。
