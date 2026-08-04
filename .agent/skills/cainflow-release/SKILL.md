---
name: cainflow-release
description: 发布 CainFlow 正式新版本。用于用户要求“发布新版本”“自动升级版本号”“新建版本 tag”“等待 Release 并补充更新说明”等场景；按十进制逐级进位规则更新版本、验证、中文提交、推送标签、等待 GitHub Actions，并维护中文 Release 说明。
---

# CainFlow 发布新版本

完整执行发布流程，不要只创建标签后提前结束。发布属于高风险外部操作；仅在用户明确要求发布时执行。

## 版本规则

- 从 `js/core/constants.js` 的 `APP_VERSION_NUMBER` 读取唯一当前版本。
- 运行 `python .agent/skills/cainflow-release/scripts/bump_version.py` 预览下一版本。
- 按十进制逐级进位：`3.3.2 → 3.3.3`、`3.3.9 → 3.4.0`、`3.9.9 → 4.0.0`。
- 每个次版本和补丁版本段只允许 `0..9`。发现格式异常、版本段超限、目标标签已存在时停止并报告，不猜测版本。
- 标签固定为 `v<版本号>`；使用带中文说明的 annotated tag。

## 发布流程

1. 确认位于 CainFlow 仓库，读取当前分支、工作区、远端、最新标签和待发布差异。保护用户的无关改动；无法判断某项改动是否应发布时先询问。
2. 根据“上一个正式标签到当前工作区”的提交和差异整理本次中文更新摘要。不得编造功能，不把测试实现细节当成主要用户更新。
3. 运行版本脚本的预览模式，检查远端不存在目标 tag，再以 `--write` 更新版本唯一来源。
4. 运行完整发布检查：
   - `git diff --check`
   - `node --test tests/*.test.mjs`
   - `python -m unittest discover -s tests -p 'test_*.py'`
   - `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-release-readiness.ps1 -ResolvedTagName v<版本号>`
5. 只暂存确认属于本次发布的文件。提交标题和正文统一使用中文；发布提交标题使用 `发布 <版本号> 版本`，正文概述主要改动。
6. 推送当前分支后创建 annotated tag：`git tag -a v<版本号> -m "发布 <版本号> 版本"`，再单独推送该标签。任何一步失败都停止，不删除或强推远端历史。
7. 每 20–30 秒检查由标签触发的 `Build and Release Packages` 工作流，并在持续等待期间至少每 60 秒告知用户状态。工作流失败时提供运行链接和失败结论，不创建伪成功说明。
8. 工作流成功后确认正式 Release 已存在、非草稿、非预发布，并验证 Windows 与 macOS 资产均已上传且各自小于 20 MiB。
9. 用真实更新摘要替换自动占位说明。Release 正文至少包含：
   - `<版本号> 更新内容`
   - 面向用户的主要新增/修复
   - 必要的兼容性或升级提醒
   - Windows/macOS 下载文件名
10. 重新读取公开 Release，核对标签、标题、正文、资产名称和大小；最后报告提交、标签、Release 链接与工作区状态。

## GitHub 操作

- 优先使用已认证的 `gh` CLI 查询工作流和编辑 Release。
- `gh` 不可用时，公开状态使用 GitHub REST API；编辑 Release 可从 Git 凭据管理器读取凭据并直接调用 API，但不得输出、记录或写入令牌。
- 等待 Release 是流程的一部分。除非工作流明确失败或用户中止，不要在 Release 尚未生成时结束任务。
- Release 更新说明必须使用中文；代码标识、文件名和专有名词可保留英文。

## 安全约束

- 发布前必须确认目标 tag 本地和远端均不存在。
- 不使用 `git reset --hard`、普通 `--force` 或删除标签来覆盖冲突版本。
- 不自动提交构建产物、数据目录、日志、导出文件或临时文件。
- 如果测试或发布就绪检查失败，不提交版本、不创建 tag。
- 如果分支推送成功但标签或工作流失败，准确报告已完成与未完成状态，不伪造回滚。

## 资源

- 版本预览与写入：`scripts/bump_version.py`
