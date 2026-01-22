---
created_at: 2026-01-22T03:29:29.436Z
dependencies:
  - target: is-01kfhw050qe2egpxfzhec80ddg
    type: blocks
id: is-01kfhvzztx2sjcps7mymgykvsc
kind: task
labels: []
priority: 1
status: open
title: Create DocCache class with load() method
type: is
updated_at: 2026-01-22T21:11:12.884Z
version: 3
---
Create packages/tbd/src/file/doc-cache.ts (in file/ not lib/ because it uses fs/promises). Define DocCache class, scoring constants (SCORE_EXACT_MATCH=1.0, SCORE_PREFIX_MATCH=0.9, SCORE_CONTAINS_ALL=0.8, SCORE_PARTIAL_BASE=0.7, SCORE_MIN_THRESHOLD=0.5) with docstrings, DocFrontmatter interface, and CachedDoc/DocMatch interfaces.
