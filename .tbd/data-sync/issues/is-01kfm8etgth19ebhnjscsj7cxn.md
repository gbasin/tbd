---
created_at: 2026-01-23T01:45:47.289Z
dependencies: []
id: is-01kfm8etgth19ebhnjscsj7cxn
kind: task
labels:
  - docs-review
priority: 2
status: open
title: Verify prime command docs consistency
type: is
updated_at: 2026-01-23T01:45:47.289Z
version: 1
---
Check tbd-docs.md, tbd-design.md, and CLI --help for the prime command. Ensure all sources are consistent and accurate for:
- Command description and purpose
- All options (--export, --brief)
- Behavior when not in tbd project (silent exit)
- Custom PRIME.md override behavior
- Hook integration (SessionStart, Compaction)
