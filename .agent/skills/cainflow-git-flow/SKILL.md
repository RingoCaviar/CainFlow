---
name: cainflow-git-flow
description: CainFlow 项目的本地开发、提交、推送到 fork、以及向原作者仓库发起 PR 的完整流程。用于需要在 CainFlow 仓库内完成代码修改、验证、git commit、推送到 `origin`，再同步到 `upstream` 并创建 PR 的场景。
---

# CainFlow Git Flow

## Overview

Use this skill when working inside the CainFlow repository and the task ends with a git commit, push, or pull request to the original upstream repository.

## Workflow
### Recommended command path

Use this sequence for the common case:

`ash
git status --short --branch
git remote -v
git branch -vv
git checkout -b feature/<topic>
# make changes
git diff --stat
git add -- <files>
git commit -m \"Fix <topic>\"
git push -u origin feature/<topic>
gh pr create --repo RingoCaviar/CainFlow --base main --head <your-branch>
`

If the task is a direct upstream sync:

`ash
git fetch upstream
git checkout <branch>
git reset --hard upstream/main
git push --force-with-lease origin <branch>
`

### 1. Identify remotes and branch state

- Check `git status --short --branch`.
- Check `git remote -v`.
- Check `git branch -vv`.
- Confirm:
  - `origin` points to the user's fork.
  - `upstream` points to `https://github.com/RingoCaviar/CainFlow`.
  - The current branch is the one to update.

### 1.1 Branch naming

- Use a short, task-oriented branch name.
- Prefer `feature/<topic>`, `fix/<topic>`, or `chore/<topic>` when creating a new branch.
- If the task is a direct sync from upstream, keep the existing branch only when the user wants that branch overwritten.

### 2. Make the code change

- Inspect only the files needed for the task.
- Edit files directly in the workspace.
- Keep changes minimal and aligned with existing project conventions.
- Do not overwrite unrelated user changes.

### 3. Verify before commit

- Run the narrowest useful checks first.
- If the task is UI or CSS related, inspect the affected screens or selectors.
- If the task affects runtime behavior, run the relevant build or test command before committing.

### 4. Commit locally

- Review `git diff --stat` and `git diff` if needed.
- Stage only the intended files.
- Write a commit message that describes the user-visible change.
- Prefer concise imperative messages in the project style, e.g.:
  - `Fix workflow sidebar theme coverage`
  - `Update upstream sync workflow`
  - `Document git flow for CainFlow`

### 5. Push to the fork

- Push the branch to origin.
- If the branch has not been published yet, use git push -u origin <branch>.
- Use `--force-with-lease` only when the task explicitly requires rewriting history or syncing a branch to upstream content.
- Prefer normal pushes when possible.

### 6. Sync with upstream when requested

- Fetch `upstream`.
- Reset or merge only when the user explicitly wants the branch overwritten with the original author version.
- If the goal is to mirror upstream exactly, reset the branch to `upstream/main` and force-push to `origin` only after confirming the user wants the fork overwritten.

### 7. Open the PR to the original repository

- Create the PR against https://github.com/RingoCaviar/CainFlow.
- If GitHub CLI is available, prefer gh pr create --repo RingoCaviar/CainFlow --base main --head <branch>.
- Use the current branch as the head branch.
- Include a short summary of the change, verification status, and any caveats.
- Prefer a PR body with:
  - What changed
  - Why it changed
  - How it was verified
  - Any follow-up notes
- Keep the title short and specific, matching the commit tone.

## Rules

- Treat `origin` as the fork and `upstream` as the original author repository.
- Never delete or rewrite user work outside the task scope.
- If the branch state is ambiguous, re-check remotes before pushing.
- If a push or PR may overwrite remote history, confirm the intent first.



