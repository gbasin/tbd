---
sandbox: true
env:
  NO_COLOR: '1'
  FORCE_COLOR: '0'
timeout: 30000
patterns:
  ULID: '[0-9a-z]{26}'
  SHORTID: '[0-9a-z]{4,5}'
  TIMESTAMP: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z"
before: |
  # Set up a test git repository
  git init --initial-branch=main
  git config user.email "test@example.com"
  git config user.name "Test User"
  echo "# Test repo" > README.md
  git add README.md
  git commit -m "Initial commit"
  # Initialize tbd
  node $TRYSCRIPT_TEST_DIR/../dist/bin.mjs init
---

# TBD CLI: Filesystem and Storage Tests

Validates that tbd stores files in the correct locations according to the
architecture specification.

## Reference: Directory Structure

Per the design spec, tbd uses this directory structure:

**On main branch:**
- `.tbd/config.yml` - Project configuration (tracked)
- `.tbd/.gitignore` - Ignores cache/, data-sync-worktree/, data-sync/
- `.tbd/cache/` - Local state (gitignored)
- `.tbd/data-sync-worktree/` - Hidden worktree for tbd-sync branch (gitignored)

**Via worktree:**
- `.tbd/data-sync-worktree/.tbd/data-sync/issues/` - Issue files
- `.tbd/data-sync-worktree/.tbd/data-sync/mappings/` - ID mappings
- `.tbd/data-sync-worktree/.tbd/data-sync/attic/` - Conflict archive

---

## Config File Location

# Test: Config file exists at .tbd/config.yml

```console
$ test -f .tbd/config.yml && echo "config exists"
config exists
? 0
```

# Test: Config file contains required fields

```console
$ grep -E "^(sync|display|tbd_version):" .tbd/config.yml
display:
sync:
tbd_version: [..]
? 0
```

---

## Issue Storage Location (Worktree Architecture)

# Test: Create issue stores file in worktree data-sync directory

```console
$ node $TRYSCRIPT_TEST_DIR/../dist/bin.mjs create "Test issue for location" --json | head -1
{
? 0
```

# Test: Issue files exist in worktree path

After creating an issue, verify the file is stored in the worktree directory.

```console
$ ls .tbd/data-sync-worktree/.tbd/data-sync/issues/*.md 2>/dev/null | wc -l | tr -d ' '
1
? 0
```

# Test: Issue file has correct format (YAML frontmatter + markdown)

Issue files have YAML frontmatter with keys in alphabetical order.

```console
$ cat .tbd/data-sync-worktree/.tbd/data-sync/issues/*.md | head -15
---
created_at: [TIMESTAMP]
dependencies: []
id: is-[ULID]
kind: task
labels: []
priority: 2
status: open
title: Test issue for location
type: is
updated_at: [TIMESTAMP]
version: 1
---
? 0
```

---

## Mappings Directory

# Test: Mappings directory exists in worktree

```console
$ test -d .tbd/data-sync-worktree/.tbd/data-sync/mappings && echo "mappings dir exists"
mappings dir exists
? 0
```

# Test: Mappings has gitkeep placeholder

```console
$ test -f .tbd/data-sync-worktree/.tbd/data-sync/mappings/.gitkeep && echo "gitkeep exists"
gitkeep exists
? 0
```

---

## Multiple Issues

# Test: Create multiple issues

Note: Create command shows full ULID in success message.

```console
$ node $TRYSCRIPT_TEST_DIR/../dist/bin.mjs create "Second issue"
✓ Created bd-[SHORTID]: Second issue
? 0
```

```console
$ node $TRYSCRIPT_TEST_DIR/../dist/bin.mjs create "Third issue"
✓ Created bd-[SHORTID]: Third issue
? 0
```

# Test: Multiple issue files exist in worktree

```console
$ ls .tbd/data-sync-worktree/.tbd/data-sync/issues/*.md 2>/dev/null | wc -l | tr -d ' '
3
? 0
```

---

## Gitignore Verification

# Test: .tbd/.gitignore exists

```console
$ test -f .tbd/.gitignore && echo "gitignore exists"
gitignore exists
? 0
```

# Test: .tbd/.gitignore contains worktree and data-sync entries

```console
$ grep -E "^(cache|data-sync)" .tbd/.gitignore
cache/
data-sync-worktree/
data-sync/
? 0
```

---

## File Content Integrity

# Test: Issue files use proper YAML frontmatter delimiters

Each issue file should have exactly 2 `---` delimiters (opening and closing).

```console
$ ls .tbd/data-sync-worktree/.tbd/data-sync/issues/*.md | wc -l | tr -d ' '
3
? 0
```

```console
$ cat .tbd/data-sync-worktree/.tbd/data-sync/issues/*.md | grep -c "^---$"
6
? 0
```

Note: 6 = 2 delimiters (open/close) x 3 issues.

---

## Data Isolation from Main Branch

# Test: data-sync-worktree directory should be gitignored

Files in `.tbd/data-sync-worktree/` should not appear as untracked in git status.

```console
$ git status --porcelain | grep "data-sync-worktree" || echo "worktree is properly gitignored"
worktree is properly gitignored
? 0
```

# Test: Only .tbd/ directory shows as untracked (not worktree contents)

```console
$ git status --porcelain | grep "^??" | head -5
?? .tbd/
? 0
```

---

## Meta File

# Test: Meta file exists in worktree

```console
$ test -f .tbd/data-sync-worktree/.tbd/data-sync/meta.yml && echo "meta exists"
meta exists
? 0
```

# Test: Meta file contains schema version

```console
$ grep "schema_version" .tbd/data-sync-worktree/.tbd/data-sync/meta.yml
schema_version: 1
? 0
```
