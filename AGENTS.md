## Agent skills

### Issue tracker

Issues and specs use the local tracker under `.scratch/`. See `docs/agents/issue-tracker.md` before creating, reading, updating, or closing an issue.

### Triage labels

Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain documentation layout. See `docs/agents/domain.md`.

### Agent 与 MCP 画布能力

新增或修改画布读取、编辑与运行能力时，同步检查内置 Agent 和 Canvas MCP 的入口、公共字段投影、参数校验和定向测试。两端共用画布方案与执行逻辑。权限和交互以 [画布能力规范](docs/adr/0025-scoped-canvas-automation.md) 为准。

### Git commits

提交信息使用中文，并保留关联的本地 Issue ID。

### Test selection

测试按 [docs/testing.md](docs/testing.md) 选范围。小改动只跑相关测试，缺覆盖就补用例并登记。全量回归显式运行，聚焦发布和主要工作流。此规则优先于技能的默认测试范围。

### Release notes

发布或修改 GitHub Release 时，先阅读 `docs/releasing.md`；每个标签都要提交对应的更新说明文件。
