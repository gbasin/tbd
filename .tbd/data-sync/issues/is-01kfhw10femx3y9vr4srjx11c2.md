---
created_at: 2026-01-22T03:30:02.861Z
dependencies:
  - target: is-01kfhw2g8t8jq841n2q51msy77
    type: blocks
id: is-01kfhw10femx3y9vr4srjx11c2
kind: task
labels: []
priority: 1
status: open
title: Implement shortcut query matching
type: is
updated_at: 2026-01-22T21:11:35.211Z
version: 3
---
Implement query handling in shortcut command: try exact match with get(), then fuzzy with search(). Use SCORE_MIN_THRESHOLD constant for low-confidence detection. Show suggestions if score < threshold, otherwise output matched document content. Support --json output mode.
