---
created_at: 2026-01-18T10:48:12.313Z
dependencies: []
id: is-01kf8bgdrt65hkjwne8mh5ssh0
kind: task
labels: []
priority: 3
status: open
title: Remove unused index_enabled config and index.json references
type: is
updated_at: 2026-01-18T10:48:12.313Z
version: 1
---
The index.json query cache is not implemented. Remove:
- index_enabled from ConfigSchema in schemas.ts
- index_enabled from default config in file/config.ts  
- index_enabled display in cli/commands/config.ts
- index.json references from docs
- Update tests that reference index_enabled
Note: May need migration logic for existing config files that have index_enabled.
