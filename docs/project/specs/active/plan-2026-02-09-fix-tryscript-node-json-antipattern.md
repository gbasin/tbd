# Feature: Fix Tryscript Node JSON-Parsing Antipattern

**Date:** 2026-02-09

**Author:** Agent (jlevy/tbd)

**Status:** Draft

## Overview

Systematically remove the `node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"`
antipattern from all tryscript golden tests and replace with idiomatic golden test
patterns that expose full CLI output for diff-based validation.

## Goals

- Remove all 130 instances of the `node -e` JSON-parsing antipattern across 18 test
  files
- Replace with idiomatic tryscript golden test patterns: full `--json` output with
  elision patterns, and `jq` + `tee` for ID capture
- Improve test coverage by exposing complete JSON output rather than surgically
  extracting single fields
- Align all tryscript tests with the golden testing guidelines

## Non-Goals

- Rewriting tests that don't use `--json` output (e.g., tests that use `grep -c` on
  human-readable output)
- Adding new test scenarios beyond what currently exists
- Changing the CLI's `--json` output format

## Background

### The Antipattern

Many tryscript tests pipe `--json` CLI output through Node.js to parse JSON and extract
specific fields:

```bash
tbd show $(cat id.txt) --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('spec:', d.spec_path)"
```

This defeats the core purpose of golden testing. From the golden testing guidelines:

> **The discipline**: Expose concise but broad pieces of application and environment
> state. Avoid surgical checks that narrow output to specific values.

The antipattern manifests in three sub-patterns:

**Sub-pattern A: ID capture with output suppression** (~40 instances)

```bash
# ANTIPATTERN: Hides entire JSON output, only prints "Created"
$ tbd create "Issue" --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); require('fs').writeFileSync('id.txt', d.id); console.log('Created')"
Created
```

**Sub-pattern B: Single-field extraction** (~50 instances)

```bash
# ANTIPATTERN: Hides all fields except one
$ tbd show $(cat id.txt) --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('spec:', d.spec_path)"
spec: docs/specs/my-feature.md
```

**Sub-pattern C: Computed assertions** (~40 instances)

```bash
# ANTIPATTERN: Reimplements assertion logic in JavaScript, hides actual data
$ tbd list --status closed --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.filter(i => i.status === 'closed').length)"
2
```

### The Correct Patterns

The project already has examples of the correct approach:

**For ID capture** (from `cli-child-order.tryscript.md`):

```bash
# CORRECT: Shows the ID in golden output AND saves to file
$ tbd create "Parent Epic" --type=epic --json | jq -r '.id' | tee parent_id.txt
test-[SHORTID]
```

**For full JSON validation** (from `cli-crud.tryscript.md` line 140):

```bash
# CORRECT: Full JSON output with pattern matching for unstable fields
$ tbd create "JSON test" --type=task --json
{
  "id": "test-[SHORTID]",
  "internalId": "is-[ULID]",
  "title": "JSON test"
}
```

**For showing detailed state**:

```bash
# CORRECT: Show full JSON output, let golden diff validate everything
$ tbd show $(cat id.txt) --json
{
  "id": "test-[SHORTID]",
  "internalId": "is-[ULID]",
  "title": "Issue to show",
  "kind": "bug",
  "status": "open",
  "priority": 1,
  "spec_path": "docs/specs/my-feature.md",
  ...
}
```

### Fix Strategy Per Sub-Pattern

**Sub-pattern A (ID capture)** — Replace `node -e ... writeFileSync` with
`jq -r '.id' | tee id.txt` so the ID is both visible in golden output and saved.
Alternatively, show full JSON via `tee output.json` and extract the ID in a
follow-up step.

**Sub-pattern B (single-field extraction)** — Remove the `| node -e ...` pipe entirely.
Show the full `--json` output with `[..]` / `[SHORTID]` / `[ULID]` / `[TIMESTAMP]`
patterns for unstable fields. The golden diff validates all fields, not just one.

**Sub-pattern C (computed assertions)** — Remove the `| node -e ...` pipe. Show the
full `--json` output. The golden file implicitly validates counts, field values, and
filtering by showing the complete data. If a count is truly needed, `jq 'length'` is
acceptable but full output is preferred.

## Implementation Plan

Each item below is one test file. All tests within each file must be updated, then the
golden output re-captured via `npx tryscript run --update <file>`. After updating each
file, run `npx tryscript run <file>` to verify the golden output passes.

The files are ordered by instance count (most antipattern occurrences first) to
prioritize the highest-impact files.

### Phase 1: Highest-Impact Files (10+ instances each)

- [ ] **cli-spec-inherit.tryscript.md** (23 instances) — Heavy use of sub-patterns A
  and B for parent/child spec inheritance. Replace all `node -e` with `jq` + `tee` for
  ID capture and full `--json` output for show commands.

- [ ] **cli-workflow.tryscript.md** (18 instances) — Uses sub-patterns A, B, and C for
  ready/blocked/label/dep workflows. Many instances write to `/tmp/` files. Replace with
  `jq` + `tee` for ID capture and full JSON output for assertions.

- [ ] **cli-spec-linking.tryscript.md** (16 instances) — Sub-patterns A and B for spec
  linking CRUD. Replace `node -e` ID capture with `jq` + `tee`, replace show field
  extraction with full JSON output.

- [ ] **cli-crud.tryscript.md** (12 instances) — Sub-patterns A and B for core CRUD
  operations. Note: this file already has some correct patterns (line 140). Bring the
  remaining 12 instances into alignment.

- [ ] **cli-advanced.tryscript.md** (10 instances) — Sub-patterns B and C for search,
  stats, and doctor commands. Replace computed assertions with full JSON output.

### Phase 2: Medium-Impact Files (6-9 instances each)

- [ ] **cli-edge-cases.tryscript.md** (9 instances) — Mix of sub-patterns A, B, and C
  for unicode, self-referential deps, and JSON validity checks. The JSON validity
  checks (sub-pattern C) that just verify `JSON.parse` succeeds can be replaced with
  showing the full output.

- [ ] **cli-list-pretty.tryscript.md** (8 instances) — Sub-patterns A and C for
  hierarchical list display. Replace ID capture and count assertions.

- [ ] **cli-list-status-filter.tryscript.md** (6 instances) — Sub-patterns A and C for
  status filtering. Replace ID capture and count/filter assertions with full output.

- [ ] **cli-list-specs.tryscript.md** (6 instances) — Sub-patterns A and B for spec
  listing. Replace ID capture and field extraction.

- [ ] **cli-import-status.tryscript.md** (6 instances) — Sub-pattern C for verifying
  imported issue statuses. Replace found/not-found assertions with full JSON output.

### Phase 3: Low-Impact Files (1-3 instances each)

- [ ] **cli-id-format.tryscript.md** (3 instances) — Sub-patterns B and C for ID
  format validation. Replace computed format checks with full JSON showing actual IDs.

- [ ] **cli-import.tryscript.md** (3 instances) — Sub-patterns B and C for import
  verification. Replace count/ID assertions with full JSON output.

- [ ] **cli-import-autoinit.tryscript.md** (3 instances) — Sub-patterns B and C for
  auto-init import. Replace count assertions with full JSON.

- [ ] **cli-beads.tryscript.md** (2 instances) — Sub-pattern C for import count and ID
  listing. Replace with full JSON output.

- [ ] **cli-sync.tryscript.md** (2 instances) — Sub-patterns B and C for sync status.
  Replace with full JSON output.

- [ ] **cli-sync-remote.tryscript.md** (1 instance) — Sub-pattern B for sync status
  check. Replace with full JSON output.

- [ ] **cli-import-e2e.tryscript.md** (1 instance) — Sub-pattern B for stats total.
  Replace with full JSON output.

- [ ] **cli-help-all.tryscript.md** (1 instance) — Sub-pattern C for docs list check.
  Replace with full JSON output.

### Phase 4: Verification

- [ ] Run full tryscript test suite: `npx tryscript run packages/tbd/tests/*.tryscript.md`
  to verify all tests pass with updated golden output
- [ ] Review diffs to confirm all `node -e` instances are removed
- [ ] Verify no regressions in test coverage

## Testing Strategy

Each file should be updated and verified individually:

1. Replace all `node -e` patterns in the file
2. Run `npx tryscript run --update <file>` to capture new golden output
3. Review the captured output to ensure it exposes the full state
4. Run `npx tryscript run <file>` to verify the golden output matches
5. Repeat for each file

After all files are updated, run the full test suite to confirm no regressions.

## Open Questions

- For list/search commands that return many items, should we show the full JSON array
  or is `jq 'length'` acceptable for count checks? Recommendation: show full output
  when the list is small (under ~20 items), use `jq 'length'` only when the full
  output would be unwieldy.
- Some tests use `$(cat /tmp/file.txt)` for ID capture. Should these also move to
  sandbox-local files (e.g., `id.txt` instead of `/tmp/id.txt`)? Recommendation: yes,
  sandbox-local files are cleaner and avoid /tmp pollution.

## References

- `tbd guidelines golden-testing-guidelines` — Golden testing philosophy and patterns
- `npx tryscript@latest docs` — Tryscript syntax reference
- `cli-child-order.tryscript.md` — Exemplar of correct pattern (uses `jq` + `tee`)
- `cli-crud.tryscript.md:140-147` — Exemplar of correct full JSON golden output
