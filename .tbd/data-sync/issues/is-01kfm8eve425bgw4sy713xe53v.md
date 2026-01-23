---
created_at: 2026-01-23T01:45:48.227Z
dependencies: []
id: is-01kfm8eve425bgw4sy713xe53v
kind: task
labels:
  - docs-review
  - internal
priority: 3
status: open
title: Verify skill command (internal) docs consistency
type: is
updated_at: 2026-01-23T01:45:48.227Z
version: 1
---
The skill command is a new internal command not exposed in main CLI help. Verify:
- Internal documentation/comments are accurate
- If it should be documented publicly in tbd-docs.md
- Options work as documented (--brief)
- Integration with bundled docs system (SKILL.md, skill-brief.md)
