# Feature: Orchestrator Harness (`tbd run`)

**Date:** 2026-02-12

**Author:** Gary Basin (with Claude)

**Status:** Draft

## Overview

Add an orchestrator harness to tbd that drives a fully automated spec-to-code loop.
The harness replaces the chat-based human-in-the-loop with a deterministic pipeline:
freeze a spec, decompose into beads, fan out to coding agents, run maintenance,
judge against the spec, and loop until done.

The core thesis: **chatting with coding agents while they're coding is an anti-pattern.**
A detailed spec should be created upfront, broken into atomic tasks with dependencies,
and agents should work in a loop until done. If the result isn't what you want, you
messed up by not structuring the feedback loop properly.

## Goals

- **G1**: One command (`tbd run`) drives the full spec → code → judge loop
- **G2**: Agents work on single beads in isolation — no inter-agent chat
- **G3**: Agent judge QA runs in a separate, firewalled evaluation that coding agents
  cannot see or influence
- **G4**: Agents handle their own merging, build, typecheck, lint, and relevant tests
- **G5**: The harness is agent-backend agnostic (Claude Code, Codex, subprocess, API)
- **G6**: Checkpoint/resume — crashes don't lose progress
- **G7**: Observable — clear log of what happened, which beads passed/failed, judge
  verdicts

## Non-Goals

- Real-time inter-agent messaging (use Agent Mail / Gas Town for that)
- Arbitrary DAG orchestration (this is a fixed pipeline with a feedback loop, not
  Attractor)
- Replacing `tbd` interactive mode — the harness is an additional module, not a
  replacement
- Supporting agents that need persistent conversations — agents are stateless per bead

## Background

### Current State

tbd provides the building blocks: specs, beads (task queue), guidelines (context
injection), shortcuts (workflow templates), and sync. But the outer loop — spawning
agents, judging results, creating remediation beads — is manual. The human is the
orchestrator.

### The Problem

Running 6-8 agents on beads currently requires:
1. Manually assigning beads to agents
2. Manually checking results
3. Manually creating remediation beads
4. Manually running maintenance (test fixes, merge conflicts)
5. Manually judging spec drift

This doesn't scale and reintroduces the human bottleneck that agents are supposed to
eliminate.

### Reference: Attractor

[Attractor](https://github.com/strongdm/attractor/blob/main/attractor-spec.md) is a
DOT-based DAG orchestrator for AI workflows. Key ideas borrowed:
- **Checkpointing** after each phase for crash recovery
- **Event stream** for observability
- **Context fidelity modes** (fresh context per task vs. shared)
- **Goal gates** that must pass before pipeline exits

Key ideas NOT borrowed (too complex for our fixed pipeline):
- Arbitrary graph topology (DOT DSL)
- Edge conditions and weights
- Handler registry for arbitrary node types

## Design

### Pipeline Architecture

The harness implements a fixed pipeline with a feedback loop:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  PHASE 1: SPEC FREEZE                                      │
│  ┌──────────┐    ┌───────────┐    ┌──────────────┐         │
│  │ Load spec│───▸│ AI review │───▸│ Freeze + gen │         │
│  │          │    │ (optional)│    │ acceptance   │         │
│  └──────────┘    └───────────┘    └──────┬───────┘         │
│                                          │                  │
│  PHASE 2: DECOMPOSE                      ▼                  │
│  ┌──────────────────────────────────────────┐               │
│  │ Generate beads from spec (or use existing)│              │
│  └──────────────────┬───────────────────────┘               │
│                     │                                       │
│  PHASE 3: IMPLEMENT │  (fan out, up to N concurrent)        │
│  ┌──────────────────▼───────────────────────┐               │
│  │ For each ready bead:                      │              │
│  │   1. Claim bead + sync                    │              │
│  │   2. Spawn agent with scoped prompt       │              │
│  │   3. Agent: code → test → build → merge   │              │
│  │   4. Agent: close bead + push             │              │
│  └──────────────────┬───────────────────────┘               │
│                     │                                       │
│  PHASE 4: MAINTAIN  │                                       │
│  ┌──────────────────▼───────────────────────┐               │
│  │ Fix broken tests, resolve conflicts,      │              │
│  │ ensure build + typecheck + lint pass       │              │
│  └──────────────────┬───────────────────────┘               │
│                     │                                       │
│  PHASE 5: JUDGE     ▼                                       │
│  ┌──────────────────────────────────────────┐               │
│  │ Spec drift check (frozen spec vs code)    │              │
│  │ Acceptance criteria eval (external)       │              │
│  │ Agent judge QA (firewalled)               │              │
│  └───────┬──────────────────────┬───────────┘               │
│          │                      │                           │
│       FAIL                    PASS                          │
│          │                      │                           │
│  ┌───────▼───────┐      ┌──────▼──────┐                    │
│  │ Create fix     │      │   DONE      │                    │
│  │ beads → loop  │      │             │                    │
│  └───────┬───────┘      └─────────────┘                    │
│          │                                                  │
│          └──────────────────▸ PHASE 3 (loop)                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Spec Freeze

**Input**: Path to a spec markdown file.

**Steps**:
1. Load the spec file
2. (Optional) Run AI review — a separate LLM call that critiques the spec for
   completeness, ambiguity, and missing edge cases
3. Freeze: copy the spec to `.tbd/harness/frozen-spec.md` (immutable reference)
4. Generate acceptance criteria (see §Acceptance Criteria below)

**Human gate**: If `human_review: true` in config, the harness pauses here and waits
for explicit approval before proceeding. Otherwise, auto-proceeds.

### Phase 2: Decompose

**Input**: Frozen spec.

**Steps**:
1. If beads already exist (e.g., from a previous `tbd shortcut
   plan-implementation-with-beads`), use them
2. If no beads exist, spawn a decomposition agent that reads the spec and creates
   beads with dependencies via `tbd create` and `tbd dep add`
3. `tbd sync` to publish beads
4. Log: number of beads created, dependency graph

**Output**: A set of beads in the task queue, with dependencies.

### Phase 3: Implement (Fan Out)

**Input**: Ready beads from `tbd ready --json`.

**Concurrency**: Up to `max_concurrency` agents in parallel.

**Per-bead flow**:

```
Harness                              Agent (in worktree/branch)
───────                              ──────────────────────────
1. tbd ready --json → pick bead
2. tbd update <id> --status=in_progress
3. tbd sync (claim is visible)
4. Create worktree / branch
5. Build agent prompt ────────────▸  6. Receive prompt:
   - bead details (tbd show)            - "Work ONLY on bead <id>"
   - relevant spec section              - Spec context
   - guidelines (auto-selected)         - Guidelines
   - codebase context
                                     7. Do the work: write code + tests
                                     8. Run OWN tests (not all tests)
                                     9. Ensure: build + typecheck + lint
                                     10. git pull --rebase origin/main
                                         (or integration branch)
                                     11. Resolve merge conflicts
                                     12. git push
                                     13. tbd close <id> --reason="..."
                                     14. tbd sync
                                     15. Exit
16. Detect agent exited
17. Verify bead is closed
18. Log result (pass/fail/timeout)
19. Pick next ready bead → repeat
```

**Key design decision: agents merge, not the harness.**

Why:
- The agent has full context of what it changed — it can resolve conflicts
  intelligently
- The harness would have to understand the code to merge, which defeats the purpose
- If merge fails, the agent can retry or adjust its approach
- This follows the principle: the entity that created the change resolves the
  conflicts

**Agent completion checklist** (enforced via prompt, verified by harness):
- [ ] Own tests pass (tests the agent wrote or modified)
- [ ] `tsc --noEmit` passes (typecheck)
- [ ] Build succeeds
- [ ] Lint passes (or at minimum, no new violations)
- [ ] Changes are pushed to remote
- [ ] Bead is closed via `tbd close`
- [ ] `tbd sync` is run

**What agents do NOT need to fix**:
- Other agents' broken tests (that's the maintenance phase)
- Pre-existing lint warnings they didn't introduce
- Tests in unrelated modules

**Failure handling**:
- Agent timeout → kill process, mark bead as `open` (unclaim), create a note
- Agent exits with error → mark bead `open`, log error, increment retry counter
- Max retries exceeded → mark bead as blocked, log for human review
- Merge conflict the agent can't resolve → same as failure, retry with fresh state

### Phase 4: Maintain

**Trigger**: After every N beads complete (configurable), or after all beads in a
batch complete.

**Steps**:
1. Spawn a maintenance agent on the integration branch (not a worktree)
2. Maintenance agent prompt:
   - Run full test suite, fix failures introduced by recent merges
   - Ensure build passes end-to-end
   - Run typecheck, fix any new errors
   - Run linter, fix new violations
   - Do NOT change behavior or add features — only fix breakage
3. Maintenance agent commits with a clear message: "chore: fix test/build breakage"
4. Push

**This is itself a bead** — the harness auto-creates a maintenance bead of type
`chore` so it's tracked like any other work.

### Phase 5: Judge (Firewalled)

This is the critical feedback loop. The judge runs OUTSIDE the coding agents' context.

**Three evaluation layers**:

#### Layer 1: Automated Checks
- Full test suite passes
- Build succeeds
- Typecheck passes
- Lint passes
- No security vulnerabilities introduced (optional: `npm audit`, `cargo audit`)

#### Layer 2: Spec Drift Detection
A separate LLM call that compares the frozen spec against the current codebase:

```
Input to judge LLM:
  - Frozen spec (from Phase 1)
  - Git diff: main...integration (everything that changed)
  - File tree of changed files
  - Acceptance criteria (from Phase 1)

Output (structured):
  - drift_detected: boolean
  - issues: [{section, description, severity}]
  - new_beads: [{title, description, type}]
```

#### Layer 3: Acceptance Criteria Evaluation
See §Acceptance Criteria below.

**On PASS**: Pipeline completes. Log success. Optionally create PR.

**On FAIL**: Judge output is converted into new beads:
- Each `issue` becomes a bead with type `bug` or `task`
- These beads go into the queue
- Pipeline loops back to Phase 3

**Max iterations**: Configurable limit (default: 3) to prevent infinite loops.
After max iterations, the harness stops and reports what's still failing.

### Acceptance Criteria: External User Stories

**The problem**: If acceptance criteria live in the repo, coding agents can read them
and overfit — writing code that passes the checks without actually satisfying the
spec's intent. The judge must evaluate against criteria that coding agents have never
seen.

**Design: Generate-and-isolate pattern**

During Phase 1 (Spec Freeze), the harness makes a separate LLM call to generate
acceptance criteria from the frozen spec:

```
Input:
  - Frozen spec
  - Project context (what exists already)

Output:
  - User stories in Given/When/Then format
  - Edge cases the implementation must handle
  - Negative tests (what should NOT happen)
  - Integration scenarios
```

**Storage**: `.tbd/harness/acceptance/` (gitignored, never in agent context).

```
.tbd/harness/
├── frozen-spec.md           # Immutable spec snapshot
├── acceptance/
│   ├── user-stories.md      # Generated acceptance criteria
│   ├── edge-cases.md        # Generated edge cases
│   └── negative-tests.md    # What should NOT happen
├── run-log.yml              # Execution history
└── judge-results/
    ├── iteration-1.yml      # Judge verdict per iteration
    ├── iteration-2.yml
    └── ...
```

**Isolation guarantees**:
1. `.tbd/harness/` is in `.tbd/.gitignore` — not committed
2. Agent prompts never reference this directory
3. The harness never includes acceptance criteria in agent context
4. Only the judge phase reads these files

**How to generate good acceptance criteria**:

The generation prompt should be specific about producing criteria that are:
- **Behavioral**: "When a user does X, they should see Y" — not implementation
  details
- **Measurable**: Each criterion can be objectively evaluated by reading the code/diff
- **Independent**: Each criterion evaluates one aspect, not compound checks
- **Adversarial**: Include edge cases that naive implementations would miss

**Should these be regenerated each iteration?**

No. Generate once during Phase 1, then use the same criteria for all judge iterations.
This prevents the judge from "moving the goalposts" and ensures convergence.
If the spec itself changes (which requires human intervention), the acceptance
criteria are regenerated.

**Alternative considered: fully ephemeral generation**

We could have the judge generate criteria on the fly each time it evaluates. This
provides maximum isolation (nothing static to leak) but has a downside: the judge
might evaluate differently each time, making it hard to converge. Persisted criteria
are more predictable.

### Worktree Strategy

Two supported modes:

#### Mode 1: Per-agent worktrees (parallel, isolated)

```
repo/
├── .tbd/worktrees/
│   ├── agent-1/     # worktree on branch bead/scr-a1b2
│   ├── agent-2/     # worktree on branch bead/scr-c3d4
│   └── agent-3/     # worktree on branch bead/scr-e5f6
```

Each agent works in total isolation. Merging happens per-agent:
1. Agent finishes work
2. Agent runs `git pull --rebase origin/main` (or integration branch)
3. Agent resolves conflicts
4. Agent pushes

Harness periodically fast-forwards main/integration to include completed branches.

**Pros**: No interference between agents. Clean git history.
**Cons**: More merge conflicts if agents touch overlapping files. More disk space.

#### Mode 2: Shared branch (serial or lock-based)

All agents work on the same integration branch, one at a time (or with file-level
locks for parallel).

**Pros**: No merge step. Always up to date.
**Cons**: Serial execution limits concurrency. Lock contention for parallel.

**Recommendation**: Per-agent worktrees for most use cases. The merge cost is worth
the parallelism.

### Agent Backend Interface

```typescript
interface AgentBackend {
  name: string;

  /**
   * Spawn an agent to work on a bead.
   * The agent runs to completion and exits.
   * Returns the result (success/failure/timeout).
   */
  spawn(opts: {
    workdir: string;           // Path to worktree or repo
    prompt: string;            // Full agent prompt
    timeout: number;           // Max runtime in ms
    env?: Record<string, string>;
  }): Promise<AgentResult>;
}

interface AgentResult {
  status: 'success' | 'failure' | 'timeout';
  exitCode: number;
  stdout: string;             // Captured for logging
  stderr: string;
  duration: number;           // ms
}
```

**Backends**:

| Backend | Command | Notes |
| --- | --- | --- |
| `claude-code` | `claude -p "<prompt>" --allowedTools ...` | Best hooks support |
| `codex` | `codex exec "<prompt>"` | Non-interactive, exits when done |
| `subprocess` | Configurable shell command | For custom agents |

### Context Injection Per Bead

The harness assembles a per-bead prompt that includes:

1. **Bead details**: Output of `tbd show <id>` — title, description, dependencies,
   labels
2. **Spec section**: The relevant section of the frozen spec (extracted by matching
   bead title/description against spec headings)
3. **Guidelines**: Auto-selected based on bead labels or configured per-run
   (e.g., beads labeled `typescript` get `typescript-rules` injected)
4. **Codebase context**: Relevant files (the agent's job to explore further via tools)
5. **Completion checklist**: What the agent must do before exiting

The agent does NOT receive:
- Acceptance criteria
- Judge prompts or results
- Other agents' prompts or beads
- The harness configuration

### Configuration

```yaml
# .tbd/harness.yml
spec: docs/specs/plan-2026-02-12-feature-x.md

agent:
  backend: claude-code        # claude-code | codex | subprocess
  command: null               # Custom command for subprocess backend
  max_concurrency: 4          # Max parallel agents
  timeout_per_bead: 15m       # Per-bead timeout
  max_retries_per_bead: 2     # Retries before marking blocked

worktree:
  strategy: per-agent         # per-agent | shared
  base_branch: main           # Branch to create worktrees from
  cleanup: true               # Remove worktrees after completion

phases:
  decompose:
    auto: true                # Auto-generate beads from spec
    human_review: false       # Pause for human approval of beads

  implement:
    guidelines:               # Always inject these guidelines
      - typescript-rules
      - general-tdd-guidelines
    completion_checks:        # What agents must pass before closing
      - own-tests
      - typecheck
      - build
      - lint

  maintain:
    trigger: every_n_beads    # every_n_beads | after_all | never
    n: 5                      # How often (if every_n_beads)

  judge:
    enabled: true
    model: claude-opus-4-6    # Model for judge (can differ from coding agents)
    spec_drift: true          # Check for spec drift
    acceptance: true          # Evaluate acceptance criteria
    automated_checks:         # Which automated checks to run
      - tests
      - build
      - typecheck
      - lint
    max_iterations: 3         # Max spec→implement→judge loops
    on_complete: pr           # pr | none — what to do when done

acceptance:
  generate: true              # Auto-generate from spec during freeze
  model: claude-opus-4-6      # Model for generating acceptance criteria
  # Or provide manually:
  # path: docs/acceptance/feature-x.md
```

### Run Log and Observability

The harness maintains a run log at `.tbd/harness/run-log.yml`:

```yaml
run_id: run-2026-02-12-a1b2c3
spec: docs/specs/plan-2026-02-12-feature-x.md
started_at: 2026-02-12T10:00:00Z
status: in_progress  # pending | in_progress | completed | failed

iterations:
  - iteration: 1
    started_at: 2026-02-12T10:00:00Z
    phase: implement
    beads_total: 12
    beads_completed: 10
    beads_failed: 2
    beads_blocked: 0
    agents_spawned: 4
    maintenance_runs: 2
    judge_result:
      automated_checks: pass
      spec_drift: fail
      acceptance: partial
      new_beads_created: 3
      issues:
        - section: "Authentication flow"
          description: "OAuth callback not implemented"
          severity: critical

  - iteration: 2
    started_at: 2026-02-12T14:00:00Z
    phase: implement
    beads_total: 3  # Only the remediation beads
    beads_completed: 3
    judge_result:
      automated_checks: pass
      spec_drift: pass
      acceptance: pass

completed_at: 2026-02-12T15:30:00Z
status: completed
total_duration: 5h30m
total_beads: 15
total_agent_spawns: 19
```

### CLI Interface

```bash
# Full pipeline from spec
tbd run --spec docs/specs/plan-feature-x.md

# Resume from checkpoint (after crash or pause)
tbd run --resume

# Run with overrides
tbd run --spec plan.md --concurrency 2 --backend codex

# Status of current/last run
tbd run --status

# Just the judge phase (for testing judge config)
tbd run --judge-only

# Dry run — show what would happen without spawning agents
tbd run --spec plan.md --dry-run
```

## Implementation Plan

### Phase 1: Core Loop + Config

- [ ] Define `HarnessConfig` schema (Zod) from `.tbd/harness.yml`
- [ ] Implement run state machine: FREEZE → DECOMPOSE → IMPLEMENT → MAINTAIN → JUDGE
- [ ] Implement checkpoint save/restore (serialize state after each phase transition)
- [ ] Implement `tbd run` command entry point
- [ ] Implement `tbd run --status` and `tbd run --resume`

### Phase 2: Agent Backend Abstraction

- [ ] Define `AgentBackend` interface
- [ ] Implement `ClaudeCodeBackend` (spawn `claude -p "..."`)
- [ ] Implement `CodexBackend` (spawn `codex exec "..."`)
- [ ] Implement `SubprocessBackend` (configurable command)
- [ ] Implement prompt assembly (bead details + spec section + guidelines)
- [ ] Implement agent output capture and logging

### Phase 3: Worktree Management

- [ ] Implement worktree creation for per-agent mode
- [ ] Implement worktree cleanup after bead completion
- [ ] Implement branch naming convention: `tbd-run/<run-id>/<bead-id>`
- [ ] Implement base branch tracking (fast-forward after agent merges)

### Phase 4: Bead Claiming + Fan Out

- [ ] Implement serial bead claiming (harness is single sync point)
- [ ] Implement concurrent agent pool (up to `max_concurrency`)
- [ ] Implement agent lifecycle: spawn → monitor → collect result
- [ ] Implement retry logic (re-open bead, increment counter, re-queue)
- [ ] Implement timeout handling (kill agent, unclaim bead)

### Phase 5: Maintenance Phase

- [ ] Implement maintenance trigger logic (every N beads, after all)
- [ ] Implement maintenance agent prompt template
- [ ] Auto-create maintenance bead for tracking

### Phase 6: Acceptance Criteria Generation

- [ ] Implement acceptance criteria generation from frozen spec
- [ ] Implement storage in `.tbd/harness/acceptance/`
- [ ] Implement isolation guarantees (gitignore, not in agent context)

### Phase 7: Judge + Feedback Loop

- [ ] Implement automated checks runner (tests, build, typecheck, lint)
- [ ] Implement spec drift detection (LLM call with diff + spec)
- [ ] Implement acceptance criteria evaluation (LLM call)
- [ ] Implement bead creation from judge failures
- [ ] Implement iteration counter and max_iterations guard
- [ ] Implement final output (PR creation, summary report)

### Phase 8: Observability

- [ ] Implement run-log.yml writer
- [ ] Implement `tbd run --status` reader
- [ ] Implement real-time progress output (which agents are running, bead status)

## Testing Strategy

### Unit Tests
- Config parsing and validation
- State machine transitions
- Prompt assembly
- Agent result handling
- Bead claiming logic
- Judge output → bead creation

### Integration Tests
- Full pipeline with mock agent backend (returns canned results)
- Checkpoint save/restore across simulated crashes
- Retry logic with failing agents
- Judge feedback loop (fail → new beads → re-implement → pass)

### Golden Tests
- Snapshot the run-log output for a known scenario
- Snapshot the agent prompts generated for known beads
- Snapshot the judge input assembled from known diffs

## Open Questions

1. **How should the harness extract "relevant spec section" per bead?**
   - Option A: Simple text matching (bead title against spec headings)
   - Option B: LLM call to identify relevant sections
   - Option C: Manual annotation in beads (e.g., `--spec-section "3.2 Auth"`)
   - Recommendation: Start with A, fall back to "include entire spec" for small specs

2. **Should the judge model be different from the coding agent model?**
   - Using a different (potentially stronger) model for judging prevents the "student
     grading their own homework" problem
   - But increases cost
   - Recommendation: Default to same model, allow override in config

3. **How to handle beads that touch the same files?**
   - The dependency system should prevent this (dependent beads wait)
   - But in practice, agents may touch shared files (imports, config, etc.)
   - The merge-on-agent-side approach handles this: last agent to merge resolves
     conflicts
   - If conflicts are frequent, the maintenance phase cleans up

4. **What if acceptance criteria generation produces bad criteria?**
   - The judge might reject valid code because the acceptance criteria are wrong
   - Mitigation: human can review `.tbd/harness/acceptance/` before running
   - Mitigation: `max_iterations` prevents infinite loops
   - Mitigation: manual acceptance criteria path as override

5. **Should user stories be regenerated on subsequent iterations?**
   - No. Generate once during freeze. This prevents moving goalposts.
   - If the spec changes, the human must re-freeze, which regenerates criteria.

6. **Should the harness support "partial completion"?**
   - e.g., 10/12 beads pass judge, 2 fail — ship the 10?
   - Recommendation: No for MVP. All-or-nothing per run. The human can manually
     close remaining beads and run `tbd run --judge-only` to re-evaluate.

## References

- [Attractor spec](https://github.com/strongdm/attractor/blob/main/attractor-spec.md)
  — DAG orchestrator for AI workflows (reference for checkpointing, goal gates)
- [tbd transactional mode spec](docs/project/specs/active/plan-2026-01-19-transactional-mode-and-agent-registration.md)
  — Agent registration + transactions (complementary feature)
- [tbd design doc](packages/tbd/docs/tbd-design.md) — Current tbd architecture
- [Beads](https://github.com/steveyegge/beads) — Original git-native issue tracking
- [Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) — Real-time agent
  messaging (complementary, not replaced)
- [Lessons in spec coding](https://github.com/jlevy/speculate/blob/main/about/lessons_in_spec_coding.md)
  — jlevy's spec-driven development philosophy
