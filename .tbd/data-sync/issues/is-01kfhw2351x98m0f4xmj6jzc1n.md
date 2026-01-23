---
created_at: 2026-01-22T03:30:38.368Z
dependencies:
  - target: is-01kfhvzn1vbsam9xckr0njfbqg
    type: blocks
id: is-01kfhw2351x98m0f4xmj6jzc1n
kind: task
labels: []
parent_id: is-01kfhvzn1vbsam9xckr0njfbqg
priority: 1
status: open
title: Update tbd setup to copy built-in docs
type: is
updated_at: 2026-01-23T03:38:31.936Z
version: 5
---
Update tbd setup to: 1) Copy built-in system and standard docs to .tbd/docs/shortcuts/{system,standard}/, 2) Use atomically library for safe file writes, 3) Add version comment (<!-- tbd-version: X.Y.Z -->) for upgrade detection.
