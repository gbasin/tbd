---
created_at: 2026-01-22T03:30:20.710Z
dependencies:
  - target: is-01kfhw1ynx7qg6d5bfzsx8g557
    type: blocks
id: is-01kfhw1hx7z3whwe5tp210ed2r
kind: task
labels: []
priority: 1
status: open
title: Implement path resolution utility
type: is
updated_at: 2026-01-22T21:11:35.469Z
version: 3
---
Implement resolveDocPath() utility in paths.ts for consistent path handling: relative paths resolved from tbd root (parent of .tbd/), absolute paths used as-is, ~/ paths expanded to user home directory.
