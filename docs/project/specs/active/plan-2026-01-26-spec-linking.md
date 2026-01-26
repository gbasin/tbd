# Plan Spec: Bead Spec Linking

**Date:** 2026-01-26 **Author:** Claude **Status:** Draft

## Overview

Add support for linking beads (issues/tasks) to specification documents and other
relevant docs (guidelines, research briefs, etc.)
via a `spec_path` field.
This enables a structured workflow where specs are created first, beads are linked to
them, then implementation proceeds with clear traceability.

## Goals

- Add `spec_path` field to the bead schema for linking beads to spec/doc files
- Support gradual path matching for spec lookups (filename → partial path → full path)
- Enable filtering beads by spec path in `tbd list` and other lookup commands
- Encourage (but not require) spec linking when creating beads via `--spec` flag
- Document the spec → beads → implementation workflow

## Non-Goals

- Required spec linking (it should remain optional)
- Automatic spec validation (checking if the linked file exists)
- Multiple spec paths per bead (single path is sufficient)
- Bidirectional linking from specs to beads (specs don’t need metadata)

## Background

**Current State:**

Beads have rich metadata (title, description, priority, status, labels, parent_id, etc.)
but no way to link to planning documents like:
- Feature specs (`docs/project/specs/active/*.md`)
- Research briefs (`docs/project/research/*.md`)
- Architecture docs (`docs/project/architecture/*.md`)
- Guidelines (`docs/general/agent-guidelines/*.md`)

**Problem:**

When working on features, the spec-first workflow is:
1. Create a planning spec document
2. Break down into implementation tasks (beads)
3. Implement each bead
4. Mark spec as done

Currently, there’s no structured way to:
- Link beads to their originating spec
- List all beads for a given spec
- Track spec completion via linked beads

**Desired Workflow:**

```bash
# 1. Create a spec
tbd shortcut new-plan-spec
# → Creates docs/project/specs/active/plan-2026-01-26-my-feature.md

# 2. Create beads linked to the spec
tbd create "Add schema field" --spec docs/project/specs/active/plan-2026-01-26-my-feature.md
tbd create "Update CLI commands" --spec plan-2026-01-26-my-feature.md
tbd create "Add tests" --spec my-feature.md

# 3. List beads for the spec (all paths resolve to same spec)
tbd list --spec my-feature.md
tbd list --spec plan-2026-01-26-my-feature.md
tbd list --spec docs/project/specs/active/plan-2026-01-26-my-feature.md

# 4. Work through beads, mark spec as done when complete
```

## Design

### Approach

1. **Schema Addition**: Add optional `spec_path` string field to the Issue schema
2. **Gradual Path Matching**: Implement suffix-based path matching for flexible lookups
3. **CLI Integration**: Add `--spec` flag to create and list commands
4. **Documentation**: Update shortcuts, guidelines, and design docs

### Schema Changes

Add to `packages/tbd/src/lib/schemas.ts`:

```typescript
// In IssueSchema
spec_path: z.string().optional(),  // Path to related spec/doc (relative to repo root)
```

**Field Semantics:**
- Optional string field
- Stores relative path from repository root (e.g.,
  `docs/project/specs/active/plan-2026-01-26-my-feature.md`)
- No validation that file exists (paths may be created later or reference external docs)
- Case-sensitive matching

### Gradual Path Matching Algorithm

For a stored `spec_path` of `docs/project/specs/active/plan-2026-01-26-my-feature.md`,
all these queries should match:

| Query | Match Type |
| --- | --- |
| `my-feature.md` | Filename suffix |
| `plan-2026-01-26-my-feature.md` | Full filename |
| `active/plan-2026-01-26-my-feature.md` | Partial path |
| `specs/active/plan-2026-01-26-my-feature.md` | Longer partial path |
| `docs/project/specs/active/plan-2026-01-26-my-feature.md` | Full path |

**Algorithm:**
```typescript
function matchesSpecPath(storedPath: string, queryPath: string): boolean {
  // Normalize: remove leading ./ and trailing /
  const normalizedStored = storedPath.replace(/^\.\//, '').replace(/\/$/, '');
  const normalizedQuery = queryPath.replace(/^\.\//, '').replace(/\/$/, '');

  // Exact match
  if (normalizedStored === normalizedQuery) return true;

  // Suffix match: stored path ends with query path
  if (normalizedStored.endsWith('/' + normalizedQuery)) return true;
  if (normalizedStored.endsWith(normalizedQuery) &&
      normalizedStored[normalizedStored.length - normalizedQuery.length - 1] === '/') {
    return true;
  }

  // Filename-only match
  const storedFilename = path.basename(normalizedStored);
  const queryFilename = path.basename(normalizedQuery);
  if (storedFilename === normalizedQuery || storedFilename === queryFilename) {
    return true;
  }

  return false;
}
```

### CLI Changes

#### `tbd create` Command

Add `--spec <path>` option:

```bash
tbd create "Implement feature X" --spec docs/project/specs/active/plan-2026-01-26-feature-x.md
tbd create "Add tests for X" --spec plan-2026-01-26-feature-x.md  # Stored as-is
```

**Behavior:**
- Stores the provided path as-is in `spec_path` field
- Does not validate file existence
- Shown in create confirmation output

#### `tbd list` Command

Add `--spec <path>` filter option:

```bash
tbd list --spec my-feature.md           # All beads linked to this spec
tbd list --spec my-feature.md --status open  # Open beads for this spec
tbd list --spec my-feature.md --pretty  # Tree view of spec's beads
```

**Behavior:**
- Uses gradual path matching algorithm
- Combines with other filters (status, priority, assignee, etc.)
- Shows spec_path in long/detail views

#### `tbd show` Command

Display `spec_path` in issue details when present.

#### `tbd edit` Command

Support `--spec <path>` to set/change the spec path:

```bash
tbd edit bd-a1b2 --spec plan-2026-01-26-new-spec.md
tbd edit bd-a1b2 --spec ""  # Clear spec path
```

### File Format Changes

Example bead file with spec_path:

```yaml
---
type: is
id: is-01hx5zzkbkactav9wevgemmvrz
title: Add spec_path field to schema
kind: task
priority: 2
status: open
spec_path: docs/project/specs/active/plan-2026-01-26-spec-linking.md
created_at: 2026-01-26T10:00:00Z
updated_at: 2026-01-26T10:00:00Z
---
Add the spec_path optional field to the Issue schema...
```

### Affected Files

| File | Changes |
| --- | --- |
| `src/lib/schemas.ts` | Add `spec_path` field to IssueSchema |
| `src/lib/types.ts` | TypeScript type updated automatically via Zod inference |
| `src/file/parser.ts` | May need format handling (should work automatically) |
| `src/file/storage.ts` | No changes needed (generic field handling) |
| `src/cli/commands/create.ts` | Add `--spec` option |
| `src/cli/commands/list.ts` | Add `--spec` filter with gradual matching |
| `src/cli/commands/show.ts` | Display spec_path in output |
| `src/cli/commands/edit.ts` | Add `--spec` option |
| `src/cli/lib/filters.ts` or similar | Add spec path matching utility |
| `docs/tbd-design.md` | Document spec_path field and workflow |
| `docs/tbd-docs.md` | Document --spec CLI options |
| `.tbd/docs/shortcuts/new-plan-spec.md` | Mention bead linking workflow |
| `.tbd/docs/guidelines/*.md` | Update relevant guidelines |

## Implementation Plan

### Phase 1: Schema and Core Implementation

- [ ] Add `spec_path` field to `IssueSchema` in `schemas.ts`
- [ ] Add spec path matching utility function in new file `src/lib/spec-matching.ts`
- [ ] Add `--spec` option to `create.ts` command
- [ ] Add `--spec` filter to `list.ts` command with gradual matching
- [ ] Update `show.ts` to display spec_path when present
- [ ] Add `--spec` option to `edit.ts` command
- [ ] Write unit tests for spec path matching algorithm (`spec-matching.test.ts`)
- [ ] Add spec_path tests to `schemas.test.ts`
- [ ] Create golden tryscript test file `tests/cli-spec-linking.tryscript.md` covering:
  - Non-spec workflows (backward compatibility)
  - Spec-linked workflows (new feature)
  - Mixed workflows (both together)

### Phase 2: Documentation Updates

- [ ] Update `docs/tbd-design.md` with spec_path field documentation
- [ ] Update `docs/tbd-docs.md` with --spec CLI option documentation
- [ ] Update `.tbd/docs/shortcuts/new-plan-spec.md` with bead linking workflow
- [ ] Update `.tbd/docs/shortcuts/create-bead.md` or similar to mention --spec
- [ ] Review and update any guidelines that reference bead creation workflows

## Testing Strategy

### Unit Tests

1. **Spec Path Matching** (`src/lib/spec-matching.test.ts`)
   - Exact path match
   - Filename-only match
   - Partial path suffix match
   - Case sensitivity
   - Edge cases (empty string, leading dots, trailing slashes)

2. **Schema Validation** (add to `schemas.test.ts`)
   - spec_path accepts valid strings
   - spec_path accepts undefined/missing
   - spec_path serialization in YAML

### Golden Tryscript Tests

Create new tryscript file: `tests/cli-spec-linking.tryscript.md`

This test file MUST cover both spec-linked and non-spec workflows to ensure backward
compatibility and complete feature coverage:

#### Non-Spec Workflows (Backward Compatibility)

```markdown
# Test: Create without --spec (existing workflow unchanged)
$ tbd create "Task without spec"
✓ Created test-[SHORTID]: Task without spec
? 0

# Test: List shows issues without spec_path
$ tbd list
...
? 0

# Test: Show issue without spec_path (no spec_path in output)
$ tbd show $(cat id.txt) --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('has_spec:', 'spec_path' in d && d.spec_path !== undefined)"
has_spec: false
? 0
```

#### Spec-Linked Workflows (New Feature)

```markdown
# Test: Create with --spec (full path)
$ tbd create "Schema changes" --spec docs/project/specs/active/plan-2026-01-26-my-feature.md
✓ Created test-[SHORTID]: Schema changes
? 0

# Test: Create with --spec (filename only)
$ tbd create "CLI updates" --spec plan-2026-01-26-my-feature.md
✓ Created test-[SHORTID]: CLI updates
? 0

# Test: Show displays spec_path
$ tbd show $(cat id.txt) --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('spec:', d.spec_path)"
spec: plan-2026-01-26-my-feature.md
? 0

# Test: List --spec with exact path match
$ tbd list --spec docs/project/specs/active/plan-2026-01-26-my-feature.md --count
1
? 0

# Test: List --spec with filename-only match (gradual matching)
$ tbd list --spec my-feature.md --count
2
? 0

# Test: List --spec with partial path match
$ tbd list --spec active/plan-2026-01-26-my-feature.md --count
1
? 0

# Test: List --spec combined with other filters
$ tbd list --spec my-feature.md --status open --count
2
? 0

# Test: Edit to set spec_path
$ tbd edit $(cat id.txt) --spec new-spec.md
✓ Updated [..]
? 0

# Test: Edit to clear spec_path
$ tbd edit $(cat id.txt) --spec ""
✓ Updated [..]
? 0

# Test: Verify spec_path cleared
$ tbd show $(cat id.txt) --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('has_spec:', !!d.spec_path)"
has_spec: false
? 0
```

#### Mixed Workflows

```markdown
# Test: List returns both spec-linked and unlinked issues by default
$ tbd list --count
[total count including both]
? 0

# Test: List --spec only returns spec-linked issues
$ tbd list --spec my-feature.md --count
[only spec-linked count]
? 0

# Test: JSON output includes spec_path when present
$ tbd list --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const withSpec = d.filter(i => i.spec_path); console.log('with_spec:', withSpec.length)"
with_spec: [count]
? 0
```

### Integration Tests

1. **Create with --spec**
   - Verify spec_path stored in file
   - Verify shown in confirmation output

2. **List with --spec**
   - Filter by exact path
   - Filter by filename only
   - Filter by partial path
   - Combine with other filters

3. **Show with spec_path**
   - Verify spec_path displayed

4. **Edit with --spec**
   - Set spec_path
   - Clear spec_path

## Rollout Plan

1. Implement schema change (backward compatible - field is optional)
2. Implement CLI commands
3. Update documentation
4. Release with minor version bump

## Open Questions

1. **Should we auto-complete spec paths?**
   - Could offer tab completion for existing spec files
   - Adds complexity, may defer to future enhancement

2. **Should we validate spec file exists?**
   - Current design: No validation (flexibility)
   - Could add `--validate-spec` flag for strict mode

3. **Should `tbd list --spec` show beads with no spec if query is empty?**
   - Could add `--no-spec` filter to find unlinked beads

## References

- `packages/tbd/src/lib/schemas.ts` - Current schema definition
- `packages/tbd/src/cli/commands/list.ts` - Current list implementation
- `docs/tbd-design.md` - Overall design document
- `docs/project/specs/active/` - Example spec documents
