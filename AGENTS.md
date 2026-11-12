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

测试按 [docs/testing.md](docs/testing.md) 选范围。小改动只跑相关测试，缺覆盖就补用例并登记。全量回归显式运行，聚焦发布和主要工作流。此规则优先于技能的默认测试范围。

### Release notes

发布或修改 GitHub Release 时，先阅读 `docs/releasing.md`；每个标签都要提交对应的更新说明文件。
