---
created_at: 2026-01-26T17:47:12.591Z
dependencies: []
id: is-01kfxpnctge6yktmfndca9z88e
kind: bug
labels: []
parent_id: is-01kfxpq9c0j5wdsqy6vsqc3d1g
priority: 2
status: open
title: Fix stats command output alignment - right-align all counts in consistent column
type: is
updated_at: 2026-01-26T17:48:18.328Z
version: 4
---
The `tbd stats` output has poor visual formatting:

**Current problems:**
- Numbers are not right-aligned
- Columns have inconsistent widths across sections
- Priority labels have extra padding (e.g., 'High    )' instead of 'High)')
- Counts don't align to a consistent right column
- Colors not used consistently with other commands
- Missing status icons (○ ◐ ● ✓) that are used in list output

**Expected format:**
All counts should be right-aligned to the same column across all sections, with icons and colors:

```
Summary:
  Ready:          24
  In progress:     0
  Blocked:        14
  Open:           38
  Total:         572

By status:
  ○ open          38
  ✓ closed       534

By kind:
  bug             46
  feature         27
  task           454
  epic            39
  chore            6

By priority:
  P0 (Critical)   12
  P1 (High)      235
  P2 (Medium)    271
  P3 (Low)        52
  P4 (Lowest)      2
```

**Implementation:**
- Calculate max count width across ALL sections (not per-section)
- Right-align all counts to that width
- Remove extra padding from priority labels
- Use consistent left column width
- Apply appropriate colors: priority colors for P0-P4, status colors for open/closed/blocked
- Add status icons using getStatusIcon() from status.ts
- Follow patterns from issue-format.ts

**File:** packages/tbd/src/cli/commands/stats.ts
