---
created_at: 2026-01-26T17:13:57.071Z
dependencies:
  - target: is-01kfxms7r482jq06yy7hdrpfcn
    type: blocks
id: is-01kfxmrg2g1x27f5nwfzv1bnba
kind: bug
labels: []
priority: 3
status: open
title: Fix .tbd/.gitignore messaging to distinguish created vs updated vs no-op
type: is
updated_at: 2026-01-26T17:14:25.478Z
version: 3
---
In setup.ts:1159, we always print 'Created .tbd/.gitignore' but ensureGitignorePatterns returns { added, skipped, created } which tells us exactly what happened. Should show: Created (new file), Updated (patterns added), or nothing (already up to date). Location: packages/tbd/src/cli/commands/setup.ts#L1142-1159
