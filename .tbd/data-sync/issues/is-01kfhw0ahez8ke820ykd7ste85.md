---
created_at: 2026-01-22T03:29:40.397Z
dependencies: []
id: is-01kfhw0ahez8ke820ykd7ste85
kind: task
labels: []
priority: 1
status: open
title: Add unit tests for DocCache
type: is
updated_at: 2026-01-22T21:11:45.209Z
version: 2
---
Create tests/file/doc-cache.test.ts with unit tests: get() exact matching with/without .md extension, search() scoring algorithm with various queries, list() with and without shadowed docs, path ordering (earlier paths take precedence), error handling (missing dirs, invalid markdown).
