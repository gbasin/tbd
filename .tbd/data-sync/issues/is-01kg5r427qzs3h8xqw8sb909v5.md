---
close_reason: "Fixed: tbd sync now auto-creates worktree when missing (fresh clone scenario) without requiring --fix. The --fix flag is only needed for corrupted/prunable states."
closed_at: 2026-01-29T21:12:42.178Z
created_at: 2026-01-29T20:46:37.302Z
dependencies: []
id: is-01kg5r427qzs3h8xqw8sb909v5
kind: bug
labels: []
priority: 1
status: closed
title: Auto-create worktree on fresh clones without requiring --fix
type: is
updated_at: 2026-01-29T21:12:42.179Z
version: 4
---
## Problem

On a fresh clone of a repo with tbd, the following user experience issue occurs:

1. `tbd doctor` warns about missing local sync branch:
   ```
   ⚠ Local sync branch - tbd-sync not found (remote exists)
       Run: tbd sync to create from remote
   ```

2. User runs `tbd sync` as suggested, but it **fails**:
   ```
   Error: Worktree not found. Run 'tbd sync --fix' or 'tbd doctor --fix' to create it.
   ```

3. Only `tbd sync --fix` actually works.

**The doctor's suggestion is misleading** - it tells users to run `tbd sync` but that command fails.

## Root Cause

In `sync.ts` (lines 71-105), the sync command checks worktree health before any operations:
- If worktree status is `missing`, it throws `WorktreeMissingError` unless `--fix` is provided
- There's no distinction between "never created" (fresh clone - normal) vs "was deleted" (corrupted state - abnormal)

## Suggested Fix

1. **In `sync.ts`**: When worktree status is `missing` (not `prunable` or `corrupted`), auto-create it without requiring `--fix`. This is the expected state for fresh clones.

2. **Reserve `--fix` flag** for actually broken states:
   - `prunable`: Directory was deleted but git still tracks it
   - `corrupted`: Worktree exists but is invalid

3. **Update doctor message** (optional): If we make sync auto-create, the doctor suggestion becomes correct. Alternatively, doctor could just show "ok" with "will be created on first sync" message.

## Files to Modify

- `packages/tbd/src/cli/commands/sync.ts`: Auto-create worktree when status is `missing`
- `packages/tbd/src/cli/commands/doctor.ts`: Optionally update messaging
