# Feature: SKILL.md Comprehensive Update

**Date:** 2026-02-02

**Author:** Claude with Joshua Levy

**Status:** Implemented

## Overview

Update the tbd SKILL.md to fully represent the scope of tbd and all its capabilities.
As tbd grows in scope, the skill file must accurately cover all behavior so agents can
rapidly determine whether tbd can help with a given task.
The skill is triggered by keywords in the description, so comprehensive trigger coverage
is critical.

## Goals

- Ensure agents recognize tbd should be invoked for all relevant user requests
- Prominently feature key trigger words: **beads**, **shortcuts**, **issues**,
  **specs**, **code review**
- Cover all tbd capabilities including recent additions (cleanup, handoffs, checkout)
- Expand the User Request → Agent Action table for better agent guidance
- Add missing commands to the reference section

## Non-Goals

- Changing tbd CLI functionality
- Restructuring the skill file format
- Adding new shortcuts or guidelines

## Background

Users often say things like “use beads” or “use the shortcut” and agents need to
immediately recognize this skill applies.
The current SKILL.md is good but has gaps compared to the README and doesn’t cover all
capabilities.

The generated `.claude/skills/tbd/SKILL.md` comes from two source files:
- `packages/tbd/docs/install/claude-header.md` - frontmatter (name, description,
  allowed-tools)
- `packages/tbd/docs/shortcuts/system/skill.md` - main content

Plus the shortcut/guideline directory is auto-appended during `tbd setup`.

## Gap Analysis

### Current Description (claude-header.md)

```
Git-native issue tracking (beads), coding guidelines, and spec-driven planning for AI agents.
Use for tracking issues with dependencies, creating and closing bugs, features, and tasks,
planning specs for new features, implementing features from specs, code reviews, committing code,
creating PRs, research briefs, and architecture docs. Invoke when user mentions: tbd, shortcuts, beads,
issues, bugs, tasks, todo, tracking, specs, planning, implementation, validation, guidelines,
shortcuts, templates, commit, PR workflows, code review, testing best practices, or monorepo patterns.
```

### Missing Capabilities

| Capability | README Emphasis |
| --- | --- |
| **Knowledge injection** | One of the 4 pillars - "self-injected context for agents to get smarter" |
| **bd/Beads replacement** | Drop-in replacement, simpler architecture, no daemon/SQLite issues |
| **Code cleanup workflows** | `code-cleanup-all`, `code-cleanup-tests`, `code-cleanup-docstrings` |
| **Agent handoffs** | `agent-handoff` shortcut for session continuity |
| **Third-party source checkout** | `checkout-third-party-repo` - unique capability for library review |
| **Labels and search** | `tbd label`, `tbd search` commands |
| **Custom docs from URLs** | `--add` for external guidelines/shortcuts/templates |

### Missing Trigger Keywords

Current triggers are missing these important terms:
- `bd` (the original Beads CLI name)
- `features`, `epics` (issue types)
- `TDD`, `test-driven`
- `golden testing`, `snapshot testing`
- `TypeScript`, `Python`, `Convex` (specific guideline topics)
- `cleanup`, `dead code`, `refactor`
- `handoff`
- `research`, `architecture`
- `labels`, `search`
- `checkout library`, `source code review`
- `pull request` (in addition to PR)

### Missing Commands in Skill Reference

| Command | Purpose |
| --- | --- |
| `tbd search <query>` | Search issues by text |
| `tbd label add/remove <id> <label>` | Manage labels |
| `tbd label list` | List all labels in use |
| `tbd stale` | List issues not updated recently |
| `tbd doctor --fix` | Auto-fix repository problems |

### Missing User Request → Agent Action Mappings

| User Says | Should Run |
| --- | --- |
| "Clean up this code" / "Remove dead code" | `tbd shortcut code-cleanup-all` |
| "Hand off to another agent" | `tbd shortcut agent-handoff` |
| "Check out / review this library's source" | `tbd shortcut checkout-third-party-repo` |
| "Merge main into my branch" | `tbd shortcut merge-upstream` |
| "Search issues for X" | `tbd search "X"` |
| "Add label X to issue Y" | `tbd label add <id> <label>` |
| "What issues are stale?" | `tbd stale` |
| "Fix repository problems" | `tbd doctor --fix` |

## Design

### Approach

Update both source files to comprehensively cover tbd’s capabilities while keeping the
content concise and scannable for agents.

### Components

1. **claude-header.md** - Update description field with expanded capabilities and
   trigger keywords
2. **skill.md** - Update intro, action table, and commands section

## Implementation Plan

### Phase 1: Update Source Files

#### Task 1: Update claude-header.md description

**New description:**

```yaml
---
name: tbd
description: >-
  Git-native issue tracking (beads), coding guidelines, knowledge injection, and spec-driven
  planning for AI agents. Drop-in replacement for bd/Beads with simpler architecture.

  Use for: tracking issues/beads with dependencies, creating bugs/features/tasks, planning specs,
  implementing features from specs, code reviews, committing code, creating PRs, loading coding
  guidelines (TypeScript, Python, TDD, golden testing, Convex, monorepo patterns), code cleanup,
  research briefs, architecture docs, agent handoffs, and checking out third-party library source code.

  Invoke when user mentions: tbd, beads, bd, shortcuts, issues, bugs, tasks, features, epics, todo,
  tracking, specs, planning, implementation, validation, guidelines, templates, commit, PR, pull request,
  code review, testing, TDD, test-driven, golden testing, snapshot testing, TypeScript, Python, Convex,
  monorepo, cleanup, dead code, refactor, handoff, research, architecture, labels, search, checkout library,
  source code review, or any workflow shortcut.
allowed-tools: Bash(tbd:*), Read, Write
---
```

#### Task 2: Update skill.md intro (4 pillars)

**New intro:**

```markdown
**`tbd` helps humans and agents ship code with greater speed, quality, and discipline.**

1. **Beads**: Git-native issue tracking (tasks, bugs, features).
   Never lose work across sessions. Drop-in replacement for `bd`.
2. **Spec-Driven Workflows**: Plan features → break into beads → implement
   systematically.
3. **Knowledge Injection**: 17+ engineering guidelines (TypeScript, Python, TDD,
   testing, Convex, monorepos) available on demand.
4. **Shortcuts**: Reusable instruction templates for common workflows (code review,
   commits, PRs, cleanup, handoffs).
```

#### Task 3: Expand User Request → Agent Action table in skill.md

Replace current table with categorized, expanded version:

```markdown
## User Request → Agent Action

| User Says | You (the Agent) Run |
| --- | --- |
| **Issues/Beads** | |
| "There's a bug where ..." | `tbd create "..." --type=bug` |
| "Create a task/feature for ..." | `tbd create "..." --type=task` or `--type=feature` |
| "Let's work on issues/beads" | `tbd ready` |
| "Show me issue X" | `tbd show <id>` |
| "Close this issue" | `tbd close <id>` |
| "Search issues for X" | `tbd search "X"` |
| "Add label X to issue" | `tbd label add <id> <label>` |
| "What issues are stale?" | `tbd stale` |
| **Planning & Specs** | |
| "Plan a new feature" / "Create a spec" | `tbd shortcut new-plan-spec` |
| "Break spec into beads" | `tbd shortcut plan-implementation-with-beads` |
| "Implement these beads" | `tbd shortcut implement-beads` |
| **Code Review & Commits** | |
| "Review this code" / "Code review" | `tbd shortcut review-code` |
| "Review this PR" | `tbd shortcut review-github-pr` |
| "Commit this" / "Use the commit shortcut" | `tbd shortcut code-review-and-commit` |
| "Create a PR" / "File a PR" | `tbd shortcut create-or-update-pr-simple` |
| "Merge main into my branch" | `tbd shortcut merge-upstream` |
| **Guidelines & Knowledge** | |
| "Use TypeScript best practices" | `tbd guidelines typescript-rules` |
| "Use Python best practices" | `tbd guidelines python-rules` |
| "Build a TypeScript CLI" | `tbd guidelines typescript-cli-tool-rules` |
| "Improve monorepo setup" | `tbd guidelines typescript-monorepo-patterns` |
| "Add golden/e2e testing" | `tbd guidelines golden-testing-guidelines` |
| "Use TDD" / "Test-driven development" | `tbd guidelines general-tdd-guidelines` |
| "Convex best practices" | `tbd guidelines convex-rules` |
| **Documentation** | |
| "Research this topic" | `tbd shortcut new-research-brief` |
| "Document architecture" | `tbd shortcut new-architecture-doc` |
| **Cleanup & Maintenance** | |
| "Clean up this code" / "Remove dead code" | `tbd shortcut code-cleanup-all` |
| "Fix repository problems" | `tbd doctor --fix` |
| **Sessions & Handoffs** | |
| "Hand off to another agent" | `tbd shortcut agent-handoff` |
| "Check out this library's source" | `tbd shortcut checkout-third-party-repo` |
| *(your choice whenever appropriate)* | `tbd list`, `tbd dep add`, `tbd close`, `tbd sync`, etc. |
```

#### Task 4: Add Labels & Search commands section to skill.md

Add new section after “Dependencies & Sync”:

```markdown
### Labels & Search

| Command | Purpose |
| --- | --- |
| `tbd search <query>` | Search issues by text |
| `tbd label add <id> <label>` | Add label to issue |
| `tbd label remove <id> <label>` | Remove label from issue |
| `tbd label list` | List all labels in use |
| `tbd stale` | List issues not updated recently |
```

#### Task 5: Update Dependencies & Sync section

Add `tbd doctor --fix` to existing table.

### Phase 2: Regenerate and Verify

- [x] Run `tbd setup --auto` to regenerate SKILL.md
- [x] Verify all changes appear in generated file
- [x] Verify budget constraints met:
  - Description: ~1,019 chars (within 1,024 limit)
  - Total skill footprint: ~1,128 chars (well within 15K cumulative budget)
  - SKILL.md lines: 247 (within 500 guideline)
- [ ] Test that skill triggers correctly on key phrases

### Phase 3: YAML Consistency Cleanup (tbd-roc3)

During verification, discovered that multiline YAML descriptions are not being generated
consistently.
The source uses `>-` block scalar syntax, but generated files have separate
lines that may be parsed as separate YAML keys.

- [ ] Investigate skill file generation code in tbd setup
- [ ] Ensure generated YAML frontmatter uses consistent multiline syntax
- [ ] Add tests for YAML frontmatter parsing/generation

## Detailed Comparison: Old vs New Description

| Aspect | OLD | NEW | Status |
| --- | --- | --- | --- |
| **Core capabilities** |  |  |  |
| Git-native issue tracking (beads) | Yes | Yes | Kept |
| Coding guidelines | Yes | Yes | Kept |
| Spec-driven planning | Yes | Yes | Kept |
| Knowledge injection | No | Yes | **Added** |
| bd/Beads replacement | No | Yes | **Added** |
| **Use cases** |  |  |  |
| Tracking issues with dependencies | Yes | Yes | Kept |
| Creating/closing bugs, features, tasks | Yes | Yes | Kept |
| Planning specs | Yes | Yes | Kept |
| Implementing from specs | Yes | Yes | Kept |
| Code reviews | Yes | Yes | Kept |
| Committing code | Yes | Yes | Kept |
| Creating PRs | Yes | Yes | Kept |
| Research briefs | Yes | Yes | Kept |
| Architecture docs | Yes | Yes | Kept |
| Loading coding guidelines (with specifics) | No | Yes | **Added** |
| Code cleanup | No | Yes | **Added** |
| Agent handoffs | No | Yes | **Added** |
| Checkout third-party source | No | Yes | **Added** |
| **Trigger keywords** |  |  |  |
| tbd | Yes | Yes | Kept |
| beads | Yes | Yes | Kept |
| bd | No | Yes | **Added** |
| shortcuts | Yes (2x) | Yes | Kept (fixed dup) |
| issues | Yes | Yes | Kept |
| bugs | Yes | Yes | Kept |
| tasks | Yes | Yes | Kept |
| features | No | Yes | **Added** |
| epics | No | Yes | **Added** |
| todo | Yes | Yes | Kept |
| tracking | Yes | Yes | Kept |
| specs | Yes | Yes | Kept |
| planning | Yes | Yes | Kept |
| implementation | Yes | Yes | Kept |
| validation | Yes | Yes | Kept |
| guidelines | Yes | Yes | Kept |
| templates | Yes | Yes | Kept |
| commit | Yes | Yes | Kept |
| PR workflows | Yes | Yes (PR, pull request) | Kept/improved |
| code review | Yes | Yes | Kept |
| testing best practices | Yes | Yes (testing) | Kept |
| monorepo patterns | Yes | Yes (monorepo) | Kept |
| TDD, test-driven | No | Yes | **Added** |
| golden testing, snapshot testing | No | Yes | **Added** |
| TypeScript | No | Yes | **Added** |
| Python | No | Yes | **Added** |
| Convex | No | Yes | **Added** |
| cleanup, dead code, refactor | No | Yes | **Added** |
| handoff | No | Yes | **Added** |
| research | No | Yes | **Added** |
| architecture | No | Yes | **Added** |
| labels | No | Yes | **Added** |
| search | No | Yes | **Added** |
| checkout library, source code review | No | Yes | **Added** |
| any workflow shortcut | No | Yes | **Added** |

## Testing Strategy

1. After changes, run `tbd setup --auto` to regenerate SKILL.md
2. Verify the generated file contains all updates
3. Manually test agent recognition with phrases like:
   - “use beads”
   - “use the shortcut to commit”
   - “clean up this code”
   - “hand off to another agent”
   - “check out the source for library X”

## Open Questions

- Should we add even more specific guideline names as triggers (e.g., “error handling”,
  “backward compatibility”)?
- Should we include a brief “When to Use tbd” summary section?

## References

- [README.md](../../../../README.md) - Main project documentation
- [claude-header.md](../../../../packages/tbd/docs/install/claude-header.md) - Source
  for skill frontmatter
- [skill.md](../../../../packages/tbd/docs/shortcuts/system/skill.md) - Source for skill
  content
