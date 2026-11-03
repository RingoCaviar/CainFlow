## Agent skills

### Issue tracker

Issues and specs use the local tracker under `.scratch/`. See `docs/agents/issue-tracker.md` before creating, reading, updating, or closing an issue.

### Triage labels

Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain documentation layout. See `docs/agents/domain.md`.

### Git commits

提交信息使用中文，并保留关联的本地 Issue ID。

### Test selection

实现或修复后、提交前按 `docs/testing.md` 选择日常检查或全量回归。日常入口按改动追加模块测试；共享机制、测试基础设施、未知影响范围和发布必须全量。该仓库策略替代通用技能中“每次实现结束跑全套”的默认要求。

### Release notes

发布或修改 GitHub Release 时，先阅读 `docs/releasing.md`；每个标签都要提交对应的更新说明文件。
