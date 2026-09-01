# Issue tracker: local Markdown files

Issues and specs live under `.scratch/<feature>/issues/`. The tracker is local working data and is excluded from Git.

## Issue identity and layout

Each feature owns one directory. Each issue is one Markdown file whose three-digit ID is unique inside that feature:

```text
.scratch/<feature>/issues/
├── 001-short-title.md
├── 002-short-title.md
└── 003-short-title.md
```

Refer to an issue as `<feature>#<id>`, for example `model-settings#002`. Use that full ID in commit messages and cross-feature dependencies.

Choose the next ID by listing the feature's issue files and incrementing the highest ID. Start at `001` when the directory is empty. Never reuse an ID.

## Issue format

Create every issue from this template:

```markdown
---
id: <feature>#<id>
status: open
labels:
  - ready-for-agent
blocked_by: []
assignee:
---

# <Title>

## Context

<Why this work exists and the relevant constraints.>

## Acceptance criteria

- [ ] <Observable completion criterion>

## Activity

- <YYYY-MM-DD>: Created.

## Resolution
```

Allowed statuses are `open` and `closed`. Labels use the mappings in `triage-labels.md`. `blocked_by` contains full issue IDs; an empty list means the issue has no dependencies. `assignee` is empty until the issue is claimed.

## Operations

- **Create**: create the feature directory if needed, allocate the next ID, and write a file from the template.
- **Read**: open the matching file. Treat its frontmatter, body, activity, and resolution as the complete issue record.
- **List**: enumerate `.scratch/*/issues/*.md`, then filter the frontmatter by status, label, assignee, or dependency as needed.
- **Comment**: append a dated entry to `## Activity`. Preserve earlier entries.
- **Label**: edit `labels` in the frontmatter, keeping only labels relevant to the current state.
- **Claim**: set `assignee` to the acting agent or developer name and append a dated activity entry. Claiming is the first write of an implementation session.
- **Close**: verify every acceptance criterion, set `status: closed`, check the satisfied criteria, write the outcome under `## Resolution`, and append a dated activity entry.

Use `rg` and filesystem reads for tracker queries. Tracker operations never call GitHub or `gh`.

## Publishing and fetching

When a skill says **publish to the issue tracker**, create a local issue file.

When a skill says **fetch the relevant ticket**, resolve its full local ID to `.scratch/<feature>/issues/<id>-*.md` and read the entire file.

## Dependencies and frontier

An open issue is blocked when any ID in `blocked_by` resolves to an issue whose status is `open`. It is ready when all blockers are closed and `assignee` is empty.

For blockers-first work, list all open issues in the feature, exclude blocked or assigned issues, and choose the lowest remaining numeric ID unless the feature map specifies another order.

## Wayfinding operations

Wayfinding uses the same local files:

- **Map**: `.scratch/<feature>/map.md`, containing `Notes`, `Decisions so far`, `Fog`, and an ordered list of child issue IDs.
- **Child**: a normal issue file listed in the map. Add one `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task` label.
- **Blocking**: record full IDs in the child's `blocked_by` frontmatter.
- **Frontier**: scan the map's children in map order and select the first open, unblocked, unassigned issue.
- **Claim**: set the child's `assignee` and append an activity entry.
- **Resolve**: close the child, record its answer in `## Resolution`, then add a pointer and concise decision summary to the map's `Decisions so far` section.

The operation is complete when both the child issue and the map reflect the decision.
