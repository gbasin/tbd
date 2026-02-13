# Feature: Orchestrator Harness (`tbd run`)

**Date:** 2026-02-12

**Author:** Gary Basin (with Claude)

**Status:** Draft

## Overview

Add an orchestrator harness to tbd that drives a fully automated spec-to-code loop.
The harness replaces the chat-based human-in-the-loop with a deterministic pipeline:
freeze a spec, decompose into beads, fan out to coding agents using critical-path
scheduling, run maintenance, judge against the spec via a firewalled agent, and loop
until done.

The core thesis: **chatting with coding agents while they're coding is an anti-pattern.**
A detailed spec should be created upfront, broken into atomic tasks with dependencies,
and agents should work in a loop until done. If the result isn't what you want, you
messed up by not structuring the feedback loop properly. The frozen spec is law — there
is no escape hatch for amending mid-run.

## Goals

- **G1**: One command (`tbd run --spec plan.md`) drives the full spec → code → judge
  loop with zero configuration required
- **G2**: Agents work on single beads in isolation — no inter-agent chat
- **G3**: The judge is a separate headless agent with its own interface, running with
  tools in an isolated context that coding agents cannot see or influence
- **G4**: Agents handle their own rebase-merging, build, typecheck, lint, and relevant
  tests
- **G5**: The harness is agent-backend agnostic (Claude Code, Codex, subprocess, API)
- **G6**: Checkpoint/resume — crashes don't lose progress
- **G7**: Observable — append-only JSONL event log plus structured run summary
- **G8**: Zero-config for the default case — auto-detect backend, sensible defaults,
  optional config file for power users

## Non-Goals

- Real-time inter-agent messaging (use Agent Mail / Gas Town for that)
- Arbitrary DAG orchestration (this is a fixed pipeline with a feedback loop, not
  Attractor)
- Replacing `tbd` interactive mode — the harness is an additional module, not a
  replacement
- Supporting agents that need persistent conversations — agents are stateless per bead
- Cost controls or budget caps (v1 — add in a future version)
- Spec amendments mid-run — if the spec is wrong, stop, fix it, re-run
- `--from-phase` flexible entry points (v1 uses `--resume` only — add later)

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

### Reference: Beads Viewer

[beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) provides critical
path analysis, impact depth (keystones), slack calculation, and topological sort for
bead dependency graphs. The harness uses these concepts for scheduling:
- **Critical path**: longest dependency chain = minimum time to completion
- **Impact depth**: how many downstream beads a given bead unblocks
- **`--robot-plan`**: dependency-respecting execution plan with parallel work tracks

The harness should either shell out to `bv --robot-plan` for scheduling or port the
critical-path / topological-sort logic internally.

## Design

### Pipeline Architecture

The harness implements a fixed pipeline with a feedback loop:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  PHASE 1: SPEC FREEZE                                           │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐           │
│  │ Load spec│───▸│ Freeze spec  │───▸│ Gen accept.  │           │
│  │          │    │ (immutable)  │    │ criteria     │           │
│  └──────────┘    └──────────────┘    └──────┬───────┘           │
│                                          │                       │
│  PHASE 2: DECOMPOSE                      ▼                       │
│  ┌──────────────────────────────────────────┐                    │
│  │ Generate beads from spec (or use existing)│                   │
│  └──────────────────┬───────────────────────┘                    │
│                     │                                            │
│  PHASE 3+4: IMPLEMENT + MAINTAIN  (parallel)                     │
│  ┌──────────────────▼───────────────────────┐                    │
│  │ Harness assigns beads (critical-path order)│                  │
│  │ Agents: code → test → build → rebase-merge │                 │
│  │ Agents may create observation beads        │                  │
│  │                                            │                  │
│  │ Every N beads: maintenance agent spawns    │                  │
│  │ in parallel (fresh worktree each time)    │                  │
│  └──────────────────┬───────────────────────┘                    │
│                     │                                            │
│  PHASE 5: JUDGE     ▼                                            │
│  ┌──────────────────────────────────────────┐                    │
│  │ Headless judge agent (separate interface) │                   │
│  │ Spec drift + acceptance criteria eval     │                   │
│  │ Triages agent observation beads           │                   │
│  └───────┬──────────────────────┬───────────┘                    │
│          │                      │                                │
│       FAIL                    PASS                               │
│          │                      │                                │
│  ┌───────▼───────┐      ┌──────▼──────┐                         │
│  │ Create fix     │      │   DONE      │                         │
│  │ beads → loop  │      │             │                         │
│  └───────┬───────┘      └─────────────┘                         │
│          │                                                       │
│          └──────────────────▸ PHASE 3 (loop)                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Phase 1: Spec Freeze

**Input**: Path to a spec markdown file.

**Prerequisite**: The spec should be complete and reviewed before invoking the harness.
The harness does not critique or review the spec — it trusts it as-is. If the spec is
wrong, stop the run, fix the spec, and re-run.

**Steps**:
1. Load the spec file
2. Generate run ID (`run-<date>-<short-hash>`)
3. Create integration branch `tbd-run/<run-id>` from base branch (if using
   integration branch mode). Push to origin.
4. Create harness state directory `.tbd/harness/<run-id>/`
5. Freeze: copy the spec to `.tbd/harness/<run-id>/frozen-spec.md` (immutable
   reference). Compute SHA-256 hash and store in checkpoint.
6. Generate acceptance criteria by spawning an agent via `AgentBackend.spawn()` —
   store **outside the repo** (see §Acceptance Criteria below)
7. Write initial checkpoint (includes `frozenSpecSha256`)

**Frozen spec integrity**: The SHA-256 hash of the frozen spec is stored in the
checkpoint at freeze time. The harness **verifies this hash before each phase
transition** (decompose, implement, judge) to detect accidental or malicious
modification. Hash mismatch is a hard error — the run stops immediately.

**All LLM calls use `AgentBackend.spawn()`**: The acceptance criteria generation is
not a direct API call — it spawns a headless agent using the same backend abstraction
as coding agents. This keeps the backend interface uniform and avoids a separate API
client dependency.

### Phase 2: Decompose

**Input**: Frozen spec.

**Steps**:
1. If beads already exist (e.g., from a previous `tbd shortcut
   plan-implementation-with-beads`), use them. **Selection**: Pre-existing beads
   must be identified by an explicit selector — either a `--bead-label <label>`
   CLI flag or `decompose.existing_selector` in config. If open beads exist but
   no selector is provided, the harness fails with `E_BEAD_SCOPE_AMBIGUOUS`
   rather than accidentally consuming unrelated beads.
2. If no beads exist, spawn a decomposition agent via `AgentBackend.spawn()` that
   reads the spec and creates beads with dependencies via `tbd create` and
   `tbd dep add`
3. **Label all beads** with `harness-run:<run-id>` for scoping — this is how the
   harness identifies which beads belong to this run
4. `tbd sync` to publish beads
5. Log: number of beads created, dependency graph

**Bead scoping**: All beads created by a run are labeled `harness-run:<run-id>`.
This allows `tbd list --label=harness-run:<run-id>` to retrieve exactly the beads
for a given run, without interference from manually created beads or other runs.
When using pre-existing beads (step 1), the harness adds the label to them.

**Human gate**: If `human_review: true` in config, the harness pauses here after
beads are created and waits for explicit approval before starting implementation.
This lets the user inspect the decomposition before agents start coding.

**Output**: A set of labeled beads in the task queue, with dependencies.

### Phase 3: Implement (Fan Out)

**Input**: Ready beads from the harness scheduler.

**Concurrency**: Up to `max_concurrency` agents in parallel.

#### Bead Claiming: Harness as Single Serializer

**Critical design decision**: The harness is the **sole reader** of `tbd ready` and
the **sole assigner** of beads. Agents never call `tbd ready` themselves.

Why: tbd has no atomic claim operation. Without a serialized claim point, two agents
could both read the same bead as "ready" and race to claim it. The harness eliminates
this race condition by being the single process that reads, claims, and assigns beads.

#### Run Lock

To prevent two harness processes from acting as "sole assigner" simultaneously
(e.g., duplicate `--resume` invocations), the harness acquires a **per-run lock**:

```
.tbd/harness/<run-id>/lock.json
{
  "runId": "run-2026-02-12-a1b2c3",
  "pid": 12345,
  "hostname": "dev-machine",
  "startedAt": "2026-02-12T10:00:00Z",
  "heartbeatAt": "2026-02-12T10:15:30Z"
}
```

- **Heartbeat**: Updated every 5 seconds while the harness is running
- **Stale detection**: A lock is considered stale if `heartbeatAt` is older than
  30 seconds AND the PID is not alive (`kill(pid, 0)` fails or PID belongs to a
  different process). Both conditions must be true — heartbeat alone is not
  sufficient to prevent split-brain if the clock skews.
- **Acquisition**: If lock exists and is not stale, the harness exits with
  `E_RUN_LOCKED`. If lock is stale (heartbeat expired + dead PID), the harness
  logs a warning, removes the stale lock, and acquires a new one.
- **Release**: Lock file is deleted on normal harness exit. On crash, the
  heartbeat goes stale and the next `--resume` can safely acquire.

**Harness-side ready filtering**: The harness does NOT call `tbd ready` (which lacks
`--label` support). Instead, it:
1. Calls `tbd list --label=harness-run:<run-id> --status=open --json`
2. Applies ready-filtering logic (no unresolved blockers) using the shared
   `buildDependencyGraph()` library function from `lib/graph.ts`
3. Ranks the filtered set using critical-path scheduling (see below)
4. Claims the top bead via `tbd update <id> --status=in_progress`

**External dependency handling**: Beads may have dependencies on beads outside the
run scope (not labeled `harness-run:<run-id>`). The scheduler treats these as
unresolvable blockers — the bead stays blocked until the external dependency is
closed manually. If all remaining beads are blocked by external dependencies, the
harness reports the blocking chains and exits with `E_EXTERNAL_BLOCKED` (distinct
from `E_DEADLOCK`, which indicates an internal cycle or all-blocked-by-failed-bead
condition). This distinction helps operators take the right remediation action.

The harness **serializes all its own tbd operations** (create, update, sync) to
avoid collisions with concurrent agent tbd calls. Agents' own tbd calls (close,
create observation beads, sync) remain concurrent and rely on tbd's LWW merge.

#### Critical-Path Scheduling

The harness does not pick beads in FIFO order. It uses critical-path scheduling
(inspired by [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)):

1. **Max fan-out first**: Pick beads that unblock the most downstream beads (impact
   depth / keystones)
2. **Then by priority**: P0 > P1 > P2 > P3 > P4
3. **Then by creation order**: Oldest first as tiebreaker

This maximizes parallelism over time — foundation beads (types, schemas, shared
utilities) naturally execute first because they have the highest fan-out.

#### Deadlock Detection

The scheduler detects two deadlock scenarios and **fails fast**:

1. **Circular dependencies**: Detected at graph construction time by
   `detectCycles()` (see §Dependency Graph Construction). The harness errors
   before any agent spawns.

2. **Blocked-bead deadlock**: All remaining open beads depend on a permanently-failed
   bead (max retries exceeded, marked blocked). The scheduler detects this when:
   - No beads are ready (all have unresolved blockers)
   - No agents are currently running
   - Open beads still remain
   In this case, the harness reports the blocked dependency chain and exits with a
   diagnostic — it does not wait indefinitely.

#### Dependency Graph Construction

**Important**: tbd stores dependencies **inversely**. `tbd dep add A B` ("A depends
on B") stores `{type: blocks, target: A}` on issue **B**, not on A. The scheduler
must account for this inversion when building the dependency graph.

This logic should be extracted as a **shared library function** in `lib/graph.ts`
that both the scheduler and `tbd ready` can use:

```typescript
// lib/graph.ts — shared dependency graph construction
interface DependencyGraph {
  forward: Map<string, string[]>;  // issueId → [issues it blocks]
  reverse: Map<string, string[]>;  // issueId → [issues that block it]
  roots: string[];                 // Issues with no blockers (ready to start)
}

function buildDependencyGraph(issues: Issue[]): DependencyGraph {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();

  for (const issue of issues) {
    for (const dep of issue.dependencies) {
      if (dep.type === 'blocks') {
        // issue blocks dep.target → forward edge from issue to target
        const fwd = forward.get(issue.id) ?? [];
        fwd.push(dep.target);
        forward.set(issue.id, fwd);

        // dep.target is blocked by issue → reverse edge
        const rev = reverse.get(dep.target) ?? [];
        rev.push(issue.id);
        reverse.set(dep.target, rev);
      }
    }
  }

  const roots = issues
    .filter((i) => !(reverse.get(i.id)?.some(
      (blockerId) => issues.find((b) => b.id === blockerId)?.status !== 'closed'
    )))
    .map((i) => i.id);

  return { forward, reverse, roots };
}

function computeImpactDepth(graph: DependencyGraph, issueId: string): number {
  // DFS: count all transitive downstream issues
}

function detectCycles(graph: DependencyGraph): string[][] {
  // Tarjan's SCC or simple DFS cycle detection
  // Returns list of cycles (each cycle is a list of issue IDs)
  // Called at graph construction time — fail fast if cycles exist
}
```

**Cycle detection**: `buildDependencyGraph()` calls `detectCycles()` at construction
time. If cycles are found, the harness **fails immediately** with a diagnostic
listing the circular dependency chain(s). This prevents the scheduler from deadlocking
silently.

The `tbd ready` command currently implements its own reverse-lookup inline
(`ready.ts:50-59`). After this refactor, both `tbd ready` and the harness import
`buildDependencyGraph()` from the shared library.

#### Per-Bead Flow

```
Harness                              Agent (in worktree/branch)
───────                              ──────────────────────────
1. Scheduler picks next bead
   (critical-path order)
2. tbd update <id> --status=in_progress
3. tbd sync (claim is visible)
4. Create worktree / branch
5. Build agent prompt ────────────▸  6. Receive prompt:
   - bead details (tbd show)            - "Work ONLY on bead <id>"
   - entire frozen spec                 - Full spec (agent greps it)
   - guidelines (auto-selected)         - Guidelines
   - completion checklist               - Push/close/sync instructions
                                     7. Do the work: write code + tests
                                     8. Run OWN tests (not all tests)
                                     9. Ensure: build + typecheck + lint
                                     10. git fetch origin <target-branch>
                                     11. git rebase origin/<target-branch>
                                     12. Resolve merge conflicts
                                     13. git push origin HEAD:<target-branch>
                                         (push directly to integration branch)
                                     14. If push fails (non-fast-forward):
                                         → re-fetch, re-rebase, retry push
                                     15. tbd close <id> --reason="..."
                                     16. (Optional) tbd create for
                                         observation beads
                                     17. tbd sync
                                     18. Exit
19. Detect agent exited
20. Verify bead is closed
21. Log result (pass/fail/timeout)
22. Emit event to JSONL log
23. Delete agent worktree (fresh per bead)
24. Scheduler picks next bead → repeat
```

#### Agents Rebase-Merge (Not the Harness)

Agents are responsible for rebasing onto the target branch and resolving merge
conflicts. This is the right default because:
- The agent has full context of what it changed — it can resolve conflicts
  intelligently
- The harness would have to understand the code to merge, which defeats the purpose
- If merge fails, the agent can retry or adjust its approach
- This follows the principle: the entity that created the change resolves the
  conflicts

**Known tradeoff at scale**: With 8+ concurrent agents, each successive merge sees
more changes from previously merged agents. Agents touching shared files (imports,
configs, barrel exports) will experience increasing conflict frequency. The retry
budget must account for this — at 50+ beads, conflict-related retries will be common.
The maintenance phase acts as a safety net for breakage introduced by conflict
resolution.

#### Push Target and Concurrent Push Races

Agents push directly to the target branch (integration or main):
```bash
git push origin HEAD:<target-branch>
```

When two agents finish simultaneously, one will get a non-fast-forward rejection.
The agent must handle this with a retry loop:
```
1. git fetch origin <target-branch>
2. git rebase origin/<target-branch>
3. Resolve any conflicts
4. git push origin HEAD:<target-branch>
5. If non-fast-forward → go to 1 (up to 3 retries)
```

This is communicated to agents via the completion checklist in their prompt. The
agent's retry loop is separate from the harness's retry budget — push retries are
expected, not counted as bead failures.

#### Observation Beads

Agents may discover out-of-scope issues while working on their bead. Rather than
ignoring these or failing, agents can create **observation beads** via `tbd create`:

```bash
tbd create "Observation: shared utility X doesn't handle edge case Y" \
  --type=task --label=observation --label=harness-run:<run-id>
```

Observation beads are NOT automatically executed in the current run. They are
collected and triaged by the judge agent during Phase 5, which decides whether to
promote them to implementation beads for the next iteration or dismiss them.

#### Agent Completion Checklist

Enforced via prompt, verified by harness:
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

#### Failure Handling and Retry Semantics

Three failure modes, each with distinct retry behavior:

**1. Timeout** (agent exceeds `timeout_per_bead`):
- Harness kills the process
- **Retry starts from fresh worktree** off the target branch (previous state is
  suspect — agent may have been stuck in a loop)
- Mark bead as `open`, increment retry counter

**2. Crash** (agent exits with non-zero exit code):
- **Retry starts from fresh worktree** off the target branch (previous state may be
  corrupted)
- Mark bead as `open`, log error, increment retry counter

**3. Incomplete** (agent exits cleanly but bead is not closed):
- **Retry reuses existing worktree** (agent likely made progress, just didn't finish
  the checklist — e.g., tests didn't pass)
- Mark bead as `open`, increment retry counter

**All failure modes**:
- Max retries exceeded → mark bead as blocked, log for human review

### Phase 4: Maintain

**Trigger**: After every N beads complete (configurable), or after all beads in a
batch complete.

**Model**: Always spawn a maintenance agent — no harness-side check runner. This
keeps the harness simple (it orchestrates, it doesn't execute) and handles both
obvious failures (test regressions) and subtle ones (integration issues the harness
can't detect via exit codes).

**Maintenance gets a fresh worktree each time**, consistent with the per-bead model
(all worktrees are ephemeral):

```
repo/
├── .tbd/worktrees/
│   ├── agent-1/          # Per-bead coding agent worktrees (ephemeral)
│   ├── agent-2/
│   └── maint-<n>/        # Per-maintenance-run worktree (ephemeral)
```

**Maintenance runs in parallel** with coding agents — it does not pause the
implementation phase. The scheduler continues assigning beads to coding agents while
maintenance runs. If maintenance commits a fix, subsequent agents will pick it up
when they rebase.

**Maintenance concurrency**: At most **1 maintenance run** at a time (default
`max_maintenance_concurrency: 1`). If a new maintenance trigger fires while one is
already running, the trigger is **coalesced** — the pending trigger is noted but
no additional maintenance agent is spawned. The currently running maintenance will
handle all accumulated breakage. This prevents resource thrash and noisy merges
from overlapping maintenance runs.

**Per-maintenance-run flow**:
1. Harness auto-creates a maintenance bead of type `chore` (tracked like any work),
   labeled `harness-run:<run-id>`
2. Create fresh worktree on the target branch
3. Spawn maintenance agent via `AgentBackend.spawn()` in the fresh worktree
3. Maintenance agent prompt:
   - Pull latest from target branch
   - Run full test suite, build, typecheck, lint
   - Fix any failures introduced by recent merges
   - Do NOT change behavior or add features — only fix breakage
4. Agent commits with: "chore: fix test/build breakage"
5. Agent pushes and closes the maintenance bead
6. Harness logs result

### Phase 5: Judge (Firewalled Agent)

**Trigger**: The judge runs after an **iteration barrier** is satisfied. The barrier
uses a **maintenance trigger watermark** for deterministic ordering:

1. Let `finalCodingCount` = number of closed coding beads in this iteration's scope
2. For each maintenance run, record its `triggerCompletedCount` (the bead count
   that triggered it)
3. Judge starts only when:
   - All scoped coding beads are terminal (closed or blocked)
   - All maintenance runs with `triggerCompletedCount <= finalCodingCount` are
     terminal
   - No coding agents are currently running

This prevents the race where the judge starts before a relevant maintenance fix
lands. The watermark ensures deterministic barrier resolution even with parallel
maintenance triggers.

#### Pre-Judge Setup

Before spawning the judge, the harness performs these setup steps:

1. **Discover observation beads**: Query `tbd list --label=observation
   --label=harness-run:<run-id> --status=open --json`. This uses AND semantics
   (both labels must match), returning only observation beads from this run.
   Extract the bead IDs to pass to `JudgeBackend.evaluate()`.

2. **Create judge worktree**: Create a fresh worktree from `origin/<target-branch>`
   (the remote integration branch, which has all agents' pushed work):
   ```bash
   git fetch origin <target-branch>
   git worktree add .tbd/worktrees/judge-<iteration> origin/<target-branch>
   ```
   This gives the judge a clean, up-to-date view of the integration branch.
   The worktree is deleted after judging completes.

**Post-judge integrity check**: After each judge pass completes, the harness runs
`git status --porcelain` in the judge worktree. If any files were modified (the
judge wrote to the repo despite read-only instructions), the harness logs a
warning event and discards the judge result. This is a practical mitigation for
the fact that Claude Code cannot enforce read-only at the OS level (see Known
Limitations). Codex with `--sandbox read-only` enforces this at the OS level.

3. **Prepare judge prompt**: Assemble the frozen spec path, acceptance criteria
   path, observation bead IDs, and evaluation instructions.

The judge is a **separate headless agent** with its own interface (`JudgeBackend`),
distinct from the coding `AgentBackend`. The judge runs with tool access to the repo
(grep, read files, git diff, etc.) but under stricter constraints: **read-only, no
code changes**.

#### Two-Pass Evaluation

The judge uses a **two-pass approach** to avoid the constraint of forced JSON output
limiting reasoning quality:

**Pass 1: Reasoning** — The judge agent runs with full tool access and natural
language output. It explores the codebase, compares against the spec and acceptance
criteria, and produces a detailed evaluation in markdown/natural language.

**Pass 2: Structuring** — A second, cheaper agent call parses the judge's reasoning
into the `JudgeResult` schema. This uses `--json-schema` (Claude Code) or
`--output-schema` (Codex) for guaranteed structured output.

This separation lets the judge reason freely (better evaluation quality) while still
producing machine-parseable results for the harness.

The judge evaluates three concerns:

#### Concern 1: Spec Drift Detection

The judge agent receives:
- The frozen spec (from Phase 1)
- Access to the repo (tools for reading files, running git diff, etc.)
- The target branch to evaluate

The judge uses its tools to methodically compare the frozen spec against the
implementation. It is NOT given the entire diff in a single prompt — it explores the
codebase like a reviewer would.

Output (structured):
```
- drift_detected: boolean
- issues: [{section, description, severity}]
- new_beads: [{title, description, type}]
```

#### Concern 2: Acceptance Criteria Evaluation

The judge also receives the acceptance criteria (stored outside the repo — see
§Acceptance Criteria). It evaluates each criterion by reading the relevant code,
checking test coverage, and verifying behavior.

#### Concern 3: Observation Bead Triage

The judge reviews any observation beads created by coding agents during Phase 3.
For each observation bead, the judge decides:
- **Promote**: Convert to a real implementation bead for the next iteration
- **Dismiss**: Close as not actionable or already handled
- **Merge**: Combine with an existing judge finding

#### Judge Verdicts

**On PASS**: Pipeline completes. Log success. Optionally create PR.

**On FAIL**: Judge output is converted into new beads:
- Spec drift issues → beads of type `task` (missing feature or behavior)
- Acceptance failures → beads of type `task` (behavior gap)
- Promoted observations → beads with type from judge's assessment
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

**Storage**: Outside the repository, in XDG cache managed by the harness:

```
~/.cache/tbd-harness/<run-id>/      # Outside repo — agents cannot access
├── acceptance/
│   ├── user-stories.md             # Generated acceptance criteria
│   ├── edge-cases.md               # Generated edge cases
│   └── negative-tests.md           # What should NOT happen
```

Uses `$XDG_CACHE_HOME/tbd-harness/` (defaults to `~/.cache/tbd-harness/`). This
survives reboots, unlike `/tmp/`.

The path is stored in the harness checkpoint so it persists across `--resume`.
**If the cache directory is missing on resume** (e.g., user cleared cache), the
harness **fails with an error** rather than silently regenerating — regeneration
could produce different criteria, making the judge evaluate against a moving target.

**In-repo harness state** (gitignored, never in agent context):

All harness state is **namespaced by run-id** to support historical inspection and
prevent overwrites from concurrent/subsequent runs:

```
.tbd/harness/<run-id>/
├── frozen-spec.md                  # Immutable spec snapshot
├── checkpoint.yml                  # Run state for --resume
├── run-log.yml                     # Execution history (summary)
├── events.jsonl                    # Append-only event stream
└── judge-results/
    ├── iteration-1.yml             # Judge verdict per iteration
    ├── iteration-2.yml
    └── ...
```

`tbd run --status` reads the most recent run. `tbd run --status <run-id>` reads a
specific historical run.

**Isolation guarantees**:
1. Acceptance criteria are stored **outside the repo entirely** — agents have no
   filesystem path to read them
2. Agent prompts never reference the acceptance directory
3. The harness never includes acceptance criteria in agent context
4. Only the judge agent receives the path to acceptance criteria

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
If the spec itself changes (which requires human intervention and a full re-run), the
acceptance criteria are regenerated.

**Alternative considered: fully ephemeral generation**

We could have the judge generate criteria on the fly each time it evaluates. This
provides maximum isolation (nothing static to leak) but has a downside: the judge
might evaluate differently each time, making it hard to converge. Persisted criteria
are more predictable.

### Target Branch Strategy

The harness supports two modes for where agents merge their work, **configurable via
`target_branch` in harness.yml**:

#### Mode 1: Integration branch (default)

The harness auto-creates a branch `tbd-run/<run-id>` from the base branch. All
agents rebase-merge onto this integration branch. After the judge passes, the harness
creates a PR from the integration branch to the base branch.

**Pros**: Clean separation from main. Easy rollback (delete branch). Other developers'
work is unaffected during the run. The final PR shows the complete changeset.

**Cons**: Extra merge step at the end. Integration branch can diverge from main if
main moves forward during the run.

**Branch divergence handling**: If `main` advances during the run (other developers
push), the integration branch will diverge. The harness handles this **at PR
creation time**, not during the run:
1. After the judge passes, `git fetch origin main`
2. Attempt `git rebase origin/main` on the integration branch
3. If rebase succeeds: create PR normally
4. If rebase has conflicts: create PR anyway with a note that manual conflict
   resolution is needed. The PR description includes the list of conflicting files.
This keeps the run itself simple (no mid-run rebasing) while ensuring the final PR
is mergeable in the common case.

#### Mode 2: Direct to main

Agents rebase-merge directly onto main. No integration branch. No final PR step.

**Pros**: Simpler. No branch management. Changes are immediately on main.

**Cons**: Harder to rollback (revert 50+ commits). Other devs' work gets tangled.
Risky for shared repos.

**Configuration**: `target_branch: auto` (default, creates integration branch) or
`target_branch: main` (direct to main, for solo devs).

### Worktree Strategy

Two supported modes:

#### Mode 1: Per-agent worktrees (parallel, isolated) — recommended

```
repo/
├── .tbd/worktrees/
│   ├── agent-1/        # worktree on branch tbd-run/<run-id>/bead-01hx5zzk
│   ├── agent-2/        # worktree on branch tbd-run/<run-id>/bead-01hx6aab
│   ├── agent-3/        # worktree on branch tbd-run/<run-id>/bead-01hx6bbc
│   ├── maint-1/        # fresh maintenance worktree (ephemeral)
│   └── judge-1/        # fresh judge worktree from origin/<target-branch>
```

All worktrees are **ephemeral** — created fresh for each bead or maintenance run,
deleted after completion. Branch names use truncated ULIDs (first 8 chars) for
readability: `tbd-run/<run-id>/bead-01hx5zzk` instead of the full 26-char ULID.

Each agent works in total isolation. Merging happens per-agent:
1. Agent finishes work
2. Agent runs `git pull --rebase origin/<target-branch>`
3. Agent resolves conflicts
4. Agent pushes

**Pros**: No interference between agents. Clean git history.
**Cons**: More merge conflicts if agents touch overlapping files. More disk space.

#### Mode 2: Shared branch (serial or lock-based)

All agents work on the same branch, one at a time (or with file-level locks for
parallel).

**Pros**: No merge step. Always up to date.
**Cons**: Serial execution limits concurrency. Lock contention for parallel.

**Recommendation**: Per-agent worktrees for most use cases. The merge cost is worth
the parallelism.

#### Note: tbd Commands in Agent Worktrees

tbd commands work correctly from inside agent worktrees. The path resolution uses
directory walking (not git-based discovery), and all git operations use explicit `-C`
flags. When agents run `tbd close`, `tbd create`, or `tbd sync` from a worktree,
these operations target the shared data-sync worktree correctly.

**Known behavior**: Multiple agents running `tbd sync` concurrently will use tbd's
Last-Write-Wins (LWW) merge strategy. This is acceptable — bead status updates are
eventually consistent with small delays. No additional locking is needed.

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
  lastLines: string;          // Last ~50 lines of output (for error context)
  logHint?: string;           // Path to agent's own log (e.g., ~/.claude/...)
  duration: number;           // ms
}
// Note: Full stdout/stderr capture is unnecessary — Claude Code logs to
// ~/.claude/ and Codex to .codex/. The harness only captures the tail
// of output for error context to avoid OOM with verbose agents.
```

### Judge Backend Interface

The judge uses a **separate interface** from coding agents, with stricter constraints:

```typescript
interface JudgeBackend {
  name: string;

  /**
   * Spawn a judge agent to evaluate the implementation.
   * The judge has tool access (read files, git diff, grep) but
   * MUST NOT modify code. Returns structured evaluation.
   */
  evaluate(opts: {
    workdir: string;              // Path to repo (read-only)
    frozenSpecPath: string;       // Path to frozen spec
    acceptancePath: string;       // Path to acceptance criteria (outside repo)
    observationBeadIds: string[]; // Observation beads to triage
    timeout: number;              // Max runtime in ms
    env?: Record<string, string>;
  }): Promise<JudgeResult>;
}

interface JudgeResult {
  status: 'success' | 'failure' | 'timeout';
  specDrift: {
    detected: boolean;
    issues: Array<{
      section: string;
      description: string;
      severity: 'critical' | 'major' | 'minor';
    }>;
  };
  acceptance: {
    passed: boolean;
    results: Array<{
      criterion: string;
      passed: boolean;
      evidence: string;
    }>;
  };
  observations: Array<{
    beadId: string;
    action: 'promote' | 'dismiss' | 'merge';
    reason: string;
    mergeWith?: string;           // Existing issue to merge with
  }>;
  newBeads: Array<{
    title: string;
    description: string;
    type: 'bug' | 'task' | 'feature';
  }>;
  lastLines: string;          // Last ~50 lines of judge output
  duration: number;
}
```

### Agent Backends

| Backend | Command | Notes |
| --- | --- | --- |
| `claude-code` | `claude -p "<prompt>" --output-format json --dangerously-skip-permissions` | Headless, structured output |
| `codex` | `codex exec "<prompt>" --cd <workdir> --ask-for-approval never` | Non-interactive, sandboxed |
| `subprocess` | Configurable shell command | For custom agents |

**Auto-detection** (for zero-config): The harness checks `PATH` for `claude` and
`codex` in order. First one found is used as the default backend. If neither is found,
the harness exits with a clear error message explaining how to install a supported
backend.

### Backend CLI Reference

Exact flags for each backend. These are the flags the harness passes when spawning
agents.

#### Claude Code

**Coding agent**:
```bash
claude -p "<bead details + frozen spec + completion checklist>" \
  --output-format json \
  --dangerously-skip-permissions \
  --allowedTools "Edit,Write,Bash,Read,Glob,Grep" \
  --no-session-persistence \
  --max-turns 100 \
  --append-system-prompt "<guidelines>"
```

**Prompt composition** (Claude Code):
- `-p` receives: bead details, entire frozen spec, completion checklist, observation
  bead instructions, run ID / target branch
- `--append-system-prompt` receives: coding guidelines (e.g., typescript-rules,
  general-tdd-guidelines). These go into the system prompt so they act as persistent
  rules rather than one-time instructions.

**Judge agent (pass 1 — reasoning)**:
```bash
claude -p "<prompt>" \
  --output-format json \
  --dangerously-skip-permissions \
  --allowedTools "Read,Glob,Grep,Bash(git diff),Bash(git log)" \
  --no-session-persistence
```

**Judge agent (pass 2 — structuring)**:
```bash
claude -p "<parse this evaluation into structured format: ...>" \
  --output-format json \
  --dangerously-skip-permissions \
  --no-session-persistence \
  --json-schema '{"type":"object","properties":{"specDrift":...}}'
```

Key flags:
- `-p`: Headless mode (non-interactive, print-and-exit)
- `--output-format json`: Structured output for harness parsing
- `--dangerously-skip-permissions`: No interactive permission prompts
- `--allowedTools`: Restrict tool access (judge gets read-only tools)
- `--no-session-persistence`: Don't persist session state between runs
- `--max-turns`: Cap on agentic round-trips (prevents runaway agents)
- `--append-system-prompt`: Inject guidelines without overriding CLAUDE.md
  (**NOT `--system-prompt`**, which replaces the existing system prompt)
- `--json-schema`: Force structured output matching a JSON schema (judge only)
- `--max-budget-usd`: Optional per-agent cost cap (future use)

**CLAUDE.md interaction**: If the repo has a CLAUDE.md, `claude -p` reads it
automatically. The harness uses `--append-system-prompt` to inject coding guidelines
**without overriding** the project's CLAUDE.md. Bead-specific instructions (bead
details, frozen spec, completion checklist) go into the `-p` prompt. This means
agents benefit from existing project rules plus harness-injected guidelines.

#### Codex CLI

**Coding agent**:
```bash
codex exec "<bead details + frozen spec + completion checklist>" \
  --cd <workdir> \
  --ask-for-approval never \
  --json \
  --ephemeral
```

**Prompt composition** (Codex):
- The `-p` equivalent is the positional prompt argument to `exec`
- Codex has no `--append-system-prompt`, so guidelines are prepended to the prompt
- `--json` outputs machine-readable JSON Lines for harness parsing

**Judge agent (pass 1 — reasoning)**:
```bash
codex exec "<prompt>" \
  --cd <workdir> \
  --sandbox read-only \
  --ask-for-approval never \
  --ephemeral
```

**Judge agent (pass 2 — structuring)**:
```bash
codex exec "<parse this evaluation: ...>" \
  --sandbox read-only \
  --ask-for-approval never \
  --output-schema '{"type":"object","properties":{"specDrift":...}}' \
  --ephemeral
```

Key flags:
- `exec`: Non-interactive execution mode
- `--cd`: Set working directory (agent worktree)
- `--sandbox read-only`: Perfect for judge — can read files but not modify
- `--ask-for-approval never`: No interactive prompts
- `--json`: Machine-readable JSON Lines output (coding agents)
- `--output-schema`: Force structured output matching a JSON schema (judge only)
- `--ephemeral`: Don't persist conversation state

**No built-in session timeout**: Neither Claude Code nor Codex has a native timeout
flag. The harness implements timeout externally (see §Process Lifecycle).

### Output Parsing

Each backend wraps agent output differently. Claude Code's `--output-format json`
returns a JSON envelope with metadata (session ID, token counts, etc.) and the
actual result nested inside. Codex's `--json` returns JSON Lines. The exact schemas
are **not hardcoded in this spec** — they should be verified empirically during
implementation and may change between backend versions.

**Design**: Each backend implements an `OutputParser` that extracts the agent result:

```typescript
interface OutputParser {
  /**
   * Parse raw process output into a structured result.
   * Handles backend-specific envelope formats.
   */
  parseAgentOutput(raw: string, exitCode: number): AgentResult;

  /**
   * Parse judge pass 2 output into JudgeResult.
   * Handles --json-schema / --output-schema envelope formats.
   */
  parseJudgeOutput(raw: string, exitCode: number): JudgeResult;
}
```

**For coding agents**: The harness primarily cares about `exitCode` and bead status
(checked via `tbd show <id>`). The structured JSON output is logged but not parsed
for control flow — the bead being closed is the success signal.

**For judge pass 2**: The structured output IS parsed for control flow (pass/fail,
new beads to create). The `OutputParser` must extract the `JudgeResult` from the
backend-specific envelope.

**Implementation note**: Start by capturing raw output and parsing it. If the
envelope format changes, only the `OutputParser` needs updating — the rest of the
harness is insulated.

### Context Injection Per Bead

The harness assembles a per-bead prompt that includes:

1. **Bead details**: Output of `tbd show <id> --json` — title, description,
   dependencies, labels (machine-readable, formatted by harness into prompt text)
2. **Frozen spec**: The **entire** frozen spec is provided to the agent. Agents are
   told which bead to work on and can read/grep the spec themselves for relevant
   context. No section extraction needed — this keeps prompt assembly simple and
   avoids the risk of extracting the wrong section.
3. **Guidelines**: Auto-selected based on bead labels or configured per-run
   (e.g., beads labeled `typescript` get `typescript-rules` injected)
4. **Codebase context**: Relevant files (the agent's job to explore further via tools)
5. **Completion checklist**: What the agent must do before exiting (including push
   retry loop for non-fast-forward)
6. **Run ID and target branch**: The run ID for observation bead labeling and the
   target branch for push/rebase operations
7. **Observation bead instructions**: How to create observation beads for out-of-scope
   discoveries, including the exact label: `--label=harness-run:<run-id>`

**Environment variables** set for each agent:
- `TBD_HARNESS_RUN_ID=<run-id>` — for observation bead labeling
- `TBD_HARNESS_TARGET_BRANCH=<target-branch>` — for rebase/push operations

The agent does NOT receive:
- Acceptance criteria
- Judge prompts or results
- Other agents' prompts or beads
- The harness configuration

### Configuration

**Configuration is optional.** `tbd run --spec plan.md` works with zero config by
auto-detecting the backend and using sensible defaults. The config file is for power
users who want to customize behavior.

```yaml
# .tbd/harness.yml (OPTIONAL — all values have sensible defaults)
spec: docs/specs/plan-2026-02-12-feature-x.md

agent:
  backend: auto                 # auto | claude-code | codex | subprocess
  command: null                 # Custom command for subprocess backend
  max_concurrency: 4            # Max parallel agents
  timeout_per_bead: 15m         # Per-bead timeout
  max_retries_per_bead: 2       # Retries before marking blocked

target_branch: auto             # auto (integration branch) | main
                                # auto creates tbd-run/<run-id> branch

worktree:
  strategy: per-agent           # per-agent | shared
  base_branch: main             # Branch to create worktrees from
  cleanup: true                 # Remove worktrees after completion

phases:
  decompose:
    auto: true                  # Auto-generate beads from spec
    human_review: false         # Pause after decomposition for human approval

  implement:
    guidelines:                 # Always inject these guidelines
      - typescript-rules
      - general-tdd-guidelines
    completion_checks:          # What agents must pass before closing
      - own-tests
      - typecheck
      - build
      - lint

  maintain:
    trigger: every_n_beads      # every_n_beads | after_all | never
    n: 5                        # How often (if every_n_beads)
    parallel: true              # Run maintenance in parallel with coding agents
    max_concurrency: 1          # Max concurrent maintenance runs (triggers coalesce)

  judge:
    enabled: true
    spec_drift: true            # Check for spec drift
    acceptance: true            # Evaluate acceptance criteria
    max_iterations: 3           # Max spec→implement→judge loops
    on_complete: pr             # pr | none — what to do when done

acceptance:
  generate: true                # Auto-generate from spec during freeze
  model: claude-opus-4-6        # Model for generating acceptance criteria
  # Or provide manually:
  # path: /path/to/acceptance/criteria/
```

**Defaults when no config file exists**:
- Backend: auto-detected from PATH (claude → codex → error)
- Target branch: auto (integration branch `tbd-run/<run-id>`)
- Concurrency: 4 coding agents (+ 1 parallel maintenance agent)
- Timeout: 15 minutes per bead
- Retries: 2 per bead
- Worktree strategy: per-agent, all ephemeral (fresh per bead/maintenance run)
- Decompose: auto-generate beads from spec, no human review gate
- Guidelines: `[typescript-rules, general-tdd-guidelines]` (always injected)
- Completion checks: own-tests, typecheck, build, lint
- Maintenance: every 5 beads, always spawns agent, fresh worktree (`maint-<n>/`),
  runs in parallel, max 1 concurrent (triggers coalesce)
- Judge: enabled, all checks (spec drift + acceptance), max 3 iterations, create
  PR on completion
- Acceptance criteria: auto-generated via `AgentBackend.spawn()`, stored in XDG cache
  (`~/.cache/tbd-harness/<run-id>/`)

### Run Log and Observability

The harness maintains two log files:

#### 1. Event Log (real-time, append-only)

`.tbd/harness/<run-id>/events.jsonl` — one JSON object per line, appended as events occur:

```jsonl
{"v":1,"ts":"2026-02-12T10:00:00Z","event":"run_started","run_id":"run-a1b2c3","spec":"plan.md"}
{"ts":"2026-02-12T10:00:05Z","event":"phase_changed","phase":"freeze"}
{"ts":"2026-02-12T10:01:00Z","event":"phase_changed","phase":"decompose"}
{"ts":"2026-02-12T10:02:00Z","event":"beads_created","count":12,"dependency_edges":15}
{"ts":"2026-02-12T10:02:01Z","event":"phase_changed","phase":"implement"}
{"ts":"2026-02-12T10:02:02Z","event":"bead_assigned","bead_id":"scr-a1b2","agent":1}
{"ts":"2026-02-12T10:02:02Z","event":"agent_started","agent":1,"bead_id":"scr-a1b2","workdir":".tbd/worktrees/agent-1"}
{"ts":"2026-02-12T10:15:00Z","event":"agent_finished","agent":1,"bead_id":"scr-a1b2","status":"success","duration_ms":779980}
{"ts":"2026-02-12T10:15:01Z","event":"bead_completed","bead_id":"scr-a1b2"}
{"ts":"2026-02-12T10:15:01Z","event":"observation_created","bead_id":"scr-x9y8","created_by":"agent-1"}
{"ts":"2026-02-12T10:15:02Z","event":"bead_assigned","bead_id":"scr-c3d4","agent":1}
{"ts":"2026-02-12T12:00:00Z","event":"maintenance_started","checks":{"tests":"fail","build":"pass"}}
{"ts":"2026-02-12T12:10:00Z","event":"maintenance_finished","status":"success"}
{"ts":"2026-02-12T14:00:00Z","event":"judge_started","iteration":1}
{"ts":"2026-02-12T14:30:00Z","event":"judge_finished","iteration":1,"verdict":"fail","new_beads":3}
{"ts":"2026-02-12T15:30:00Z","event":"run_completed","status":"completed","total_beads":15}
```

`tbd run --status` reads this file and presents a summary.

**Write safety**: The harness is the sole writer of `events.jsonl`. However, with
async operations (multiple agents finishing near-simultaneously), event emission
must be serialized to prevent interleaved writes. The harness uses an in-memory
write queue that flushes events sequentially through a single open file descriptor.
Each event is `JSON.stringify()` + `\n`, written via the serialized queue —
**not** relying on kernel-level atomicity guarantees (POSIX `PIPE_BUF` applies
to pipes/FIFOs, not regular files). The write queue ensures only one
`fs.appendFile()` is in flight at a time.

#### 2. Run Log (structured summary)

`.tbd/harness/<run-id>/run-log.yml` — updated at phase transitions:

```yaml
run_id: run-2026-02-12-a1b2c3
spec: docs/specs/plan-2026-02-12-feature-x.md
started_at: 2026-02-12T10:00:00Z
status: in_progress  # pending | in_progress | completed | failed
target_branch: tbd-run/run-2026-02-12-a1b2c3

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
    observations_created: 3
    judge_result:
      spec_drift: fail
      acceptance: partial
      observations_promoted: 1
      observations_dismissed: 2
      new_beads_created: 4
      issues:
        - section: "Authentication flow"
          description: "OAuth callback not implemented"
          severity: critical

  - iteration: 2
    started_at: 2026-02-12T14:00:00Z
    phase: implement
    beads_total: 4  # Remediation + promoted observations
    beads_completed: 4
    judge_result:
      spec_drift: pass
      acceptance: pass

completed_at: 2026-02-12T15:30:00Z
status: completed
total_duration: 5h30m
total_beads: 16
total_agent_spawns: 19
```

### CLI Interface

```bash
# Full pipeline from spec (zero-config)
tbd run --spec docs/specs/plan-feature-x.md

# Resume from checkpoint (after crash or pause)
tbd run --resume

# Run with overrides
tbd run --spec plan.md --concurrency 2 --backend codex

# Status of current/last run (reads JSONL event log)
tbd run --status

# Dry run — show what would happen without spawning agents
tbd run --spec plan.md --dry-run
```

**v1 scope**: `--spec`, `--resume`, `--status`, `--dry-run`, `--concurrency`,
`--backend`. No `--from-phase` or `--judge-only` (future versions).

#### Process Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Run completed successfully (judge passed) |
| `2` | Input/config error (missing spec, invalid config, backend not found) |
| `3` | Lock/precondition error (run locked, acceptance cache missing) |
| `4` | Runtime orchestration failure (all retries exhausted, deadlock) |
| `5` | Partial completion (max iterations reached) |

#### JSON Error Envelope

When `--json` is used, errors follow a consistent envelope:
```json
{
  "error": {
    "code": "E_RUN_LOCKED",
    "message": "Run run-2026-02-12-a1b2c3 is already in progress (pid 12345)",
    "runId": "run-2026-02-12-a1b2c3"
  }
}
```

Error codes: `E_SPEC_NOT_FOUND`, `E_CONFIG_INVALID`, `E_BACKEND_UNAVAILABLE`,
`E_RUN_LOCKED`, `E_BEAD_SCOPE_AMBIGUOUS`, `E_GRAPH_CYCLE`, `E_DEADLOCK`,
`E_EXTERNAL_BLOCKED`, `E_AGENT_TIMEOUT`, `E_ACCEPTANCE_MISSING`,
`E_JUDGE_PARSE_FAILED`, `E_CHECKPOINT_CORRUPT`, `E_PR_CREATE_FAILED`,
`E_MAX_ITERATIONS`, `E_MAX_RUNTIME`, `E_SPEC_HASH_MISMATCH`.

#### `--dry-run` Behavior

`tbd run --spec plan.md --dry-run` runs Phase 1 (spec freeze) and Phase 2
(decompose) but stops before Phase 3 (implement). It outputs:
- The generated run ID
- The frozen spec path
- The number of beads created (or detected)
- The dependency graph (as a table or tree)
- The critical-path schedule (what order beads would execute)
- The estimated number of agent slots needed
- The backend that would be used

This lets the user validate the decomposition and schedule before committing to a
full run. Beads created during dry-run are labeled and remain in the queue — the
user can `tbd run --resume` to continue from Phase 3.

#### Final PR Creation

When the judge passes (or `on_complete: pr` is configured), the harness creates a
PR from the integration branch to the base branch:

1. `git fetch origin main` (get latest base branch)
2. Attempt `git rebase origin/main` on the integration branch (handle divergence)
3. `git push --force-with-lease origin <integration-branch>` (safe force-push
   after rebase — `--force-with-lease` prevents overwriting unexpected upstream
   changes). **Fallback**: If force-push is rejected (branch protection), create
   a new branch `tbd-run/<run-id>-rebased` and push there instead.
4. Create PR via `gh pr create` (from integration branch or rebased branch) with:
   - Title: `tbd run: <spec title>`
   - Body: run summary (beads completed, iterations, judge results)
   - Labels: `tbd-run`, `automated`
5. Log PR URL to events.jsonl and run-log.yml

### Checkpoint Schema

The harness serializes state after every phase transition and significant event.
This enables `--resume` to recover from crashes.

**Checkpoint file**: `.tbd/harness/<run-id>/checkpoint.yml`

```yaml
schema_version: 1                   # For forward/backward compat on --resume
run_id: run-2026-02-12-a1b2c3
spec_path: docs/specs/plan-2026-02-12-feature-x.md
frozen_spec_path: .tbd/harness/run-2026-02-12-a1b2c3/frozen-spec.md
frozen_spec_sha256: a1b2c3d4e5f6...  # Verified before each phase transition
acceptance_path: /home/user/.cache/tbd-harness/run-2026-02-12-a1b2c3/acceptance/
target_branch: tbd-run/run-2026-02-12-a1b2c3
base_branch: main

state: implementing  # freezing | decomposing | implementing | maintaining | judging | completed | failed
iteration: 1

beads:
  total: 12
  completed: [scr-a1b2, scr-c3d4, ...]
  in_progress: [scr-e5f6]
  blocked: []
  retry_counts:
    scr-g7h8: 1
  claims:                           # Claim tokens for idempotent resume
    scr-e5f6: "run-a1b2c3:1:0"     # runId:iteration:attempt

agents:
  max_concurrency: 4
  active:
    - agent_id: 1
      bead_id: scr-e5f6
      worktree: .tbd/worktrees/agent-1
      started_at: 2026-02-12T10:15:00Z
      pid: 12345

maintenance:
  last_run_at: 2026-02-12T11:00:00Z
  worktree: .tbd/worktrees/maint-2  # Current maintenance worktree (if running)
  bead_id: scr-m1n2                 # Current maintenance bead (if running)
  run_count: 2                      # For naming: maint-1, maint-2, ...
  runs:                             # All maintenance runs (for barrier watermark)
    - id: maint-1
      trigger_completed_count: 5    # Bead count that triggered this run
      state: success
    - id: maint-2
      trigger_completed_count: 10
      state: running

observations:
  pending: [scr-x9y8, scr-z1w2]
  promoted: []
  dismissed: []
```

**What triggers a checkpoint write**:
- Phase transitions (freeze → decompose → implement → ...)
- Bead assignment (harness claims a bead for an agent)
- Bead completion (agent finishes, harness records result)
- Agent spawn/exit (PID tracking for cleanup)
- Maintenance start/finish

**Schema versioning**: The checkpoint includes `schema_version: 1`. On `--resume`,
the harness checks the version:
- Same major version: proceed normally (minor field additions are tolerated)
- Unknown/higher version: fail with `E_CHECKPOINT_CORRUPT` and actionable error
  ("upgrade tbd to resume this run")
- Lower version (future): run migration handler if available

Event log entries include `"v":1` for the same reason — readers skip unknown
versions gracefully.

**Atomic checkpoint writes**: Checkpoint writes use a crash-safe protocol to
prevent corruption from mid-write crashes:
1. Write to temp file: `.tbd/harness/<run-id>/checkpoint.yml.tmp`
2. `fsync` the temp file (ensure data is on disk)
3. `rename` temp file to `checkpoint.yml` (atomic on POSIX)
4. `fsync` the parent directory (ensure rename is durable)

This guarantees that the checkpoint file is always either the previous complete
state or the new complete state — never a partial write. On resume, if
`checkpoint.yml` is missing but `checkpoint.yml.tmp` exists, the harness warns
and treats it as a corrupted checkpoint.

**Resume behavior**:
- `--resume` reads checkpoint for **run state** (which beads are done, current
  phase, iteration count, etc.)
- **Re-reads `harness.yml`** (or CLI flags) for **operational config** (concurrency,
  timeout, backend). This allows mid-run tweaks — e.g., reducing concurrency after
  an OOM, or switching backends. Immutable state (run-id, frozen spec path,
  acceptance path, target branch) always comes from the checkpoint.
- Validates acceptance criteria path exists (fail if missing)
- Reconstructs in-memory state and restarts from the current phase
- In-progress beads at crash time are reconciled via **claim tokens**: each
  bead assignment writes a `claimToken` (`runId:iteration:attempt`) to the
  checkpoint before spawning the agent. On resume, beads with claim tokens
  but no live process are treated as incomplete retries.
- Active agent PIDs are checked — if process is gone, the bead is retried

### Process Lifecycle

The harness manages agent processes externally since neither Claude Code nor Codex
has a native timeout flag.

#### Spawn

Agents are spawned with `detached: true` to create a **process group**. This
ensures that when the harness kills an agent, all of the agent's child processes
(git, npm, tsc, etc.) are also killed — preventing orphan processes.

```typescript
const proc = spawn(backend.command, backend.args, {
  cwd: worktreeDir,
  detached: true,  // Create process group for clean tree-kill
  env: { ...process.env, ...agentEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Capture last ~50 lines for error context
const outputLines: string[] = [];
proc.stdout.on('data', (chunk: Buffer) => {
  outputLines.push(...chunk.toString().split('\n'));
  while (outputLines.length > 50) outputLines.shift();
});
proc.stderr.on('data', (chunk: Buffer) => {
  outputLines.push(...chunk.toString().split('\n'));
  while (outputLines.length > 50) outputLines.shift();
});
```

**Why `detached: true`**: Claude Code and Codex spawn child processes (git, npm,
tsc). Without process groups, SIGTERM only reaches the direct child — grandchild
processes (e.g., a `git push` in progress) would become orphans. Using negative PID
(`process.kill(-pid)`) sends the signal to the entire process group.

**Platform**: This uses Unix process groups (`kill(-pid)`). macOS and Linux only.
Windows support is out of scope for v1 (add `tree-kill` package if needed later).

#### Timeout

The harness implements timeout via external timer + signal cascade:

```
1. Timer fires at timeout_per_bead
2. Send SIGTERM to process group: process.kill(-proc.pid, 'SIGTERM')
3. Wait 10 seconds for graceful exit
4. If still running: process.kill(-proc.pid, 'SIGKILL')
5. Mark bead as timed out, schedule retry in fresh worktree
```

The 10-second grace period allows agents to flush output and close files. SIGKILL
is the last resort for hung processes. Signals target the process group (negative
PID) to ensure all descendant processes are terminated.

#### Crash Detection

```
1. Agent process exits with non-zero exit code
2. Harness captures last ~50 lines of output for error context
3. Check if bead was closed (tbd show <id>)
4. If bead not closed: mark as crashed, schedule retry in fresh worktree
5. If bead was closed: treat as success (agent crashed during cleanup)
```

#### Incomplete Detection

```
1. Agent process exits with exit code 0
2. Harness checks: is the bead closed? (tbd show <id>)
3. If bead not closed: mark as incomplete, schedule retry in same worktree
4. If bead closed: success
```

#### Cleanup on Harness Exit

If the harness itself is interrupted (Ctrl+C / SIGTERM):
1. Send SIGTERM to all active agent **process groups** (`process.kill(-pid)`)
2. Wait up to 30 seconds for agents to exit
3. SIGKILL any remaining process groups
4. Write checkpoint (so `--resume` works)
5. Do NOT delete worktrees (agents may have uncommitted progress)

### Agent Pool Model

The harness uses a **continuous assignment** model — it never pauses between bead
assignments. As soon as an agent slot opens up (agent finishes or times out), the
scheduler assigns the next ready bead.

```
Time ─────────────────────────────────────────────▸
Agent 1: [bead-A]──────[bead-D]──────[bead-G]────
Agent 2: [bead-B]────[bead-E]──────────[bead-H]──
Agent 3: [bead-C]──────────[bead-F]───────────────
Maint:   ........[maint-1]......[maint-2]..........
```

**Maintenance runs in parallel** in a fresh ephemeral worktree. It does not consume
a coding agent slot. The `max_concurrency` setting controls coding agents only — the
maintenance agent is always additional.

### Code Organization

New code for the harness lives alongside existing tbd CLI code:

```
packages/tbd/src/
├── cli/
│   ├── commands/
│   │   └── run.ts              # CLI entry point: tbd run --spec, --resume, --status
│   └── lib/
│       └── harness/
│           ├── orchestrator.ts  # Main pipeline state machine
│           ├── scheduler.ts     # Critical-path bead scheduling
│           ├── agent-pool.ts    # Concurrent agent management
│           ├── checkpoint.ts    # State serialization / resume
│           ├── events.ts        # JSONL event log writer
│           └── prompts.ts       # Agent prompt assembly
├── lib/
│   ├── graph.ts                 # Shared: buildDependencyGraph(), detectCycles(),
│   │                            #   computeImpactDepth() — used by tbd ready + harness
│   └── harness/
│       ├── types.ts             # HarnessConfig, AgentResult, JudgeResult schemas
│       ├── backends/
│       │   ├── backend.ts       # AgentBackend + JudgeBackend + OutputParser interfaces
│       │   ├── claude-code.ts   # ClaudeCodeBackend + ClaudeCodeOutputParser
│       │   ├── codex.ts         # CodexBackend + CodexOutputParser
│       │   └── subprocess.ts    # SubprocessBackend implementation
│       └── acceptance.ts        # Acceptance criteria generation + storage
```

**Why this split**:
- `cli/commands/run.ts`: Thin CLI wrapper — parses args, delegates to orchestrator
- `cli/lib/harness/`: Orchestration logic that depends on CLI patterns (OutputManager,
  BaseCommand context)
- `lib/harness/`: Pure library code (types, backends, acceptance) — no CLI dependency,
  could be imported by other tools

This follows the existing pattern where `cli/commands/` are thin, `cli/lib/` has
CLI-aware logic, and `lib/` has pure domain logic (see `lib/paths.ts`, `file/git.ts`).

## Implementation Plan

### Phase 1: Core Loop + Config

- [ ] Define `HarnessConfig` schema (Zod) with sensible defaults for all fields
- [ ] Implement zero-config auto-detection (backend from PATH, all defaults)
- [ ] Implement run state machine: FREEZE → DECOMPOSE → IMPLEMENT → MAINTAIN → JUDGE
- [ ] Implement per-run-id state directory (`.tbd/harness/<run-id>/`)
- [ ] Implement checkpoint save/restore (serialize state after each phase transition)
- [ ] Implement `tbd run` command entry point
- [ ] Implement `tbd run --status` (reads JSONL event log) and `tbd run --resume`
- [ ] Implement resume config merging (checkpoint state + re-read harness.yml for ops)
- [ ] Implement integration branch creation during Phase 1 (Spec Freeze)
- [ ] Implement `tbd run --dry-run` (freeze + decompose, show schedule, stop)
- [ ] Implement run lock with heartbeat (`lock.json`, 5s heartbeat, 30s stale)
- [ ] Implement frozen spec SHA-256 hash storage and per-phase verification
- [ ] Implement atomic checkpoint writes (tmp + fsync + rename + parent fsync)
- [ ] Implement CLI exit codes (0/2/3/4/5) and JSON error envelope
- [ ] Implement schema versioning for checkpoint (`schema_version: 1`) and events (`v:1`)
- [ ] Implement schema version check and migration hooks on resume
- [ ] Implement claim tokens for idempotent resume reconciliation

### Phase 2: Agent Backend Abstraction

- [ ] Define `AgentBackend` interface
- [ ] Define `JudgeBackend` interface (separate from AgentBackend)
- [ ] Implement `ClaudeCodeBackend` (spawn `claude -p "..."` with flags from
  §Backend CLI Reference)
- [ ] Implement `CodexBackend` (spawn `codex exec "..."` with flags from
  §Backend CLI Reference)
- [ ] Implement `SubprocessBackend` (configurable command)
- [ ] Implement backend auto-detection from PATH
- [ ] Implement prompt assembly (bead details + entire frozen spec + guidelines)
- [ ] Implement process group spawning (`detached: true` + `process.kill(-pid)`)
- [ ] Implement `OutputParser` interface per backend (Claude Code envelope, Codex JSON Lines)
- [ ] Implement agent output capture (last ~50 lines via streaming)
- [ ] Implement external timeout via SIGTERM → 10s grace → SIGKILL (process groups)
- [ ] Implement harness SIGTERM handler (cascade to agents, write checkpoint)

### Phase 3: Worktree + Branch Management

- [ ] Implement per-agent worktree creation (ephemeral, fresh per bead)
- [ ] Implement worktree cleanup after bead completion (delete worktree)
- [ ] Implement branch naming: `tbd-run/<run-id>/bead-<truncated-ulid>`
- [ ] Implement target branch configuration (auto vs. main)
- [ ] Implement push-retry loop for non-fast-forward (up to 3 retries)
- [ ] Implement final PR creation from integration branch
- [ ] Implement branch protection fallback (create rebased branch if force-push rejected)
- [ ] Implement pre-existing bead selector (`--bead-label` / `E_BEAD_SCOPE_AMBIGUOUS`)

### Phase 4: Bead Scheduling + Fan Out

- [ ] Implement `buildDependencyGraph()` shared library function in `lib/graph.ts`
  (inverted dependency resolution, used by both `tbd ready` and the harness)
- [ ] Implement `detectCycles()` — fail fast at graph construction time
- [ ] Implement `computeImpactDepth()` for critical-path ranking
- [ ] Implement deadlock detection (no ready beads + no active agents + open beads)
- [ ] Implement harness-side ready filtering (`tbd list --label --json` + graph library)
- [ ] Implement critical-path scheduler (max fan-out → priority → creation order)
- [ ] Implement harness-serialized bead claiming (no agent self-assignment)
- [ ] Implement serialized harness tbd operations (queue own create/update/sync calls)
- [ ] Implement continuous agent pool (up to `max_concurrency` coding agents)
- [ ] Implement agent lifecycle: spawn → monitor → collect result
- [ ] Implement retry logic with failure-mode-specific behavior:
  - Timeout/crash → fresh worktree
  - Incomplete → reuse worktree
- [ ] Implement timeout handling (SIGTERM → 10s → SIGKILL, unclaim bead)
- [ ] Implement observation bead tracking (label-based: `harness-run:<run-id>`)
- [ ] Implement bead scoping: label all beads with `harness-run:<run-id>`

### Phase 5: Maintenance Phase

- [ ] Implement fresh ephemeral maintenance worktree creation (`maint-<n>/`)
- [ ] Implement always-spawn maintenance agent model (no harness-side checks)
- [ ] Implement parallel execution (maintenance does not block coding agents)
- [ ] Implement maintenance concurrency cap (`max_concurrency: 1`) with trigger coalescing
- [ ] Implement maintenance trigger logic (every N beads, after all)
- [ ] Implement maintenance agent prompt template
- [ ] Auto-create maintenance bead with `harness-run:<run-id>` label

### Phase 6: Acceptance Criteria Generation

- [ ] Implement acceptance criteria generation via `AgentBackend.spawn()`
- [ ] Implement storage in XDG cache dir (`~/.cache/tbd-harness/<run-id>/`)
- [ ] Implement cache path persistence in checkpoint (for --resume)
- [ ] Implement fail-on-missing for `--resume` (no silent regeneration)
- [ ] Implement manual acceptance criteria path override

### Phase 7: Judge Agent + Feedback Loop

- [ ] Implement two-pass judge evaluation:
  - Pass 1: reasoning agent with full tool access, natural language output
  - Pass 2: structuring agent with `--json-schema`/`--output-schema`
- [ ] Implement JudgeBackend for Claude Code (pass 1: read-only `--allowedTools`;
  pass 2: `--json-schema` for structured output)
- [ ] Implement JudgeBackend for Codex (pass 1: `--sandbox read-only`;
  pass 2: `--output-schema` for structured output)
- [ ] Implement observation bead discovery
  (`tbd list --label=observation --label=harness-run:<run-id> --status=open --json`)
- [ ] Implement fresh judge worktree creation
  (`git worktree add .tbd/worktrees/judge-<iteration> origin/<target-branch>`)
- [ ] Implement judge worktree cleanup after evaluation
- [ ] Implement post-judge integrity check (`git status --porcelain`)
- [ ] Implement judge trigger: wait for all beads + last maintenance to complete
- [ ] Implement judge prompt (spec drift + acceptance eval + observation triage)
- [ ] Implement structured judge output parsing against `JudgeResult` schema
- [ ] Implement bead creation from judge failures (labeled `harness-run:<run-id>`)
- [ ] Implement observation bead triage (promote/dismiss/merge)
- [ ] Implement iteration counter and max_iterations guard
- [ ] Implement final output (PR creation, summary report)

### Phase 8: Observability

- [ ] Implement JSONL event log writer (append-only, serialized write queue)
- [ ] Implement run-log.yml writer (phase-transition updates)
- [ ] Implement `tbd run --status` reader (parses JSONL for live state)
- [ ] Implement `--dry-run` mode (show planned beads + schedule without executing)

## Testing Strategy

### Unit Tests
- Config parsing, validation, and zero-config defaults
- State machine transitions
- Critical-path scheduler (ordering correctness)
- Dependency graph construction (inverted dependency resolution)
- Cycle detection (various cycle topologies: self-loop, A→B→A, A→B→C→A)
- Deadlock detection (all beads blocked by failed bead)
- Impact depth computation (verify critical-path ordering)
- Prompt assembly (verify entire frozen spec is included, not a section)
- Agent result handling with failure-mode-specific retry
- Judge output parsing and bead creation
- Event log serialization
- Resume config merging (checkpoint state + current harness.yml operational config)
- Run lock acquisition, heartbeat, stale detection
- Atomic checkpoint write protocol (tmp + fsync + rename)
- Frozen spec SHA-256 hash verification (detect tampering)
- CLI exit code mapping and JSON error envelope
- Schema version validation and migration hooks
- Claim token idempotency on resume
- Pre-existing bead selector and E_BEAD_SCOPE_AMBIGUOUS

### Integration Tests
- Full pipeline with mock agent backend (returns canned results)
- Checkpoint save/restore across simulated crashes
- Resume with missing acceptance criteria cache → should fail
- Resume with modified `harness.yml` → verify operational config changes apply
- Retry logic: timeout → fresh worktree, incomplete → reuse worktree
- Judge feedback loop (fail → new beads → re-implement → pass)
- Observation bead flow (agent creates → judge triages → promoted bead executes)
- Integration branch creation and final PR
- Backend auto-detection
- Bead scoping: verify all beads labeled `harness-run:<run-id>`
- Parallel maintenance: verify maintenance does not block coding agents
- SIGTERM cascade: verify process groups receive signal and checkpoint is written
- Run lock contention: two `--resume` invocations → second gets `E_RUN_LOCKED`
- Stale lock recovery: simulate crashed harness, verify new process acquires lock
- Maintenance barrier: verify judge waits for all triggered maintenance (watermark)
- External dependency: bead blocked by non-run bead → `E_EXTERNAL_BLOCKED`
- Post-judge integrity: judge modifies worktree → result discarded
- Branch protection fallback: force-push rejected → new rebased branch created
- Maintenance coalescing: rapid triggers with max_concurrency=1 → no duplicate runs
- Schema version: resume with higher version → E_CHECKPOINT_CORRUPT
- Structured judge output: verify JSON schema enforcement
- Cycle detection: beads with circular deps → immediate error before any agent spawns
- Deadlock detection: all beads depend on a max-retried bead → harness exits
- Process group cleanup: agent timeout kills all descendant processes

### Golden Tests
- Snapshot the run-log output for a known scenario
- Snapshot the JSONL event stream for a known scenario
- Snapshot the agent prompt generated for a known bead (matches §Example Agent Prompt)
- Snapshot the judge prompt assembled from known state
- Snapshot the critical-path schedule for a known dependency graph
- Snapshot the dependency graph for a known set of beads with inverted dependencies

## Open Questions

1. ~~**How should the harness extract "relevant spec section" per bead?**~~
   **RESOLVED**: Agents receive the **entire frozen spec**. They can grep/read it
   themselves for relevant context. This avoids fragile section-extraction logic
   and gives agents full context to understand cross-cutting concerns.

2. **Should the judge model be different from the coding agent model?**
   - Using a different (potentially stronger) model for judging prevents the "student
     grading their own homework" problem
   - But increases cost
   - Recommendation: Default to same model, allow override in config

3. **How to handle beads that touch the same files?**
   - The dependency system should prevent this (dependent beads wait)
   - But in practice, agents may touch shared files (imports, config, etc.)
   - The rebase-merge approach handles this: last agent to merge resolves conflicts
   - If conflicts are frequent, the maintenance phase cleans up
   - At 50+ beads, conflict-related retries will be common — the retry budget must
     account for this

4. **What if acceptance criteria generation produces bad criteria?**
   - The judge might reject valid code because the acceptance criteria are wrong
   - Mitigation: `max_iterations` prevents infinite loops
   - Mitigation: manual acceptance criteria path as override in config
   - Note: since criteria are stored outside the repo, humans can't easily review
     them before the run. Consider adding a `--preview-acceptance` flag.

5. **Should the harness support "partial completion"?**
   - e.g., 10/12 beads pass judge, 2 fail — ship the 10?
   - Recommendation: No for v1. All-or-nothing per run. The human can manually
     close remaining beads and re-run.

6. ~~**How should the harness integrate with beads_viewer for scheduling?**~~
   **RESOLVED**: Port the algorithm (Option B). Implemented as `buildDependencyGraph()`
   + `computeImpactDepth()` + `detectCycles()` in `lib/graph.ts`. Shared with
   `tbd ready` via library refactor.

7. **Relationship to Transactional Mode spec**
   - The transactional mode spec adds `tbd tx begin`/`tbd tx commit` for atomic
     bead operations. The harness currently uses immediate mode.
   - These features are complementary but independent for v1.
   - Future: the harness could use transactional mode for atomic batch operations
     (e.g., creating all decomposition beads in one transaction).

## Example Agent Prompt

A complete example of the prompt assembled for a coding agent working on a single bead:

```
You are a coding agent working on a single task (bead) as part of an automated
pipeline. Work ONLY on the bead described below. Do not work on other tasks.

## Your Bead

**ID**: scr-a1b2
**Title**: Implement user authentication middleware
**Type**: task
**Priority**: P1
**Dependencies**: scr-x9y8 (closed), scr-z1w2 (closed)
**Description**: Create Express middleware that validates JWT tokens from the
Authorization header. Return 401 for missing/invalid tokens. Attach decoded
user to req.user.

## Frozen Spec

<contents of .tbd/harness/<run-id>/frozen-spec.md — entire spec included>

## Guidelines

<contents of typescript-rules guideline>
<contents of general-tdd-guidelines guideline>

## Completion Checklist

You MUST complete ALL of these before exiting:

1. Write code and tests for your bead
2. Run your own tests: `pnpm vitest run tests/auth-middleware.test.ts`
3. Typecheck: `pnpm tsc --noEmit`
4. Build: `pnpm build`
5. Lint: `pnpm lint`
6. Push to remote:
   ```
   git fetch origin tbd-run/run-2026-02-12-a1b2c3
   git rebase origin/tbd-run/run-2026-02-12-a1b2c3
   git push origin HEAD:tbd-run/run-2026-02-12-a1b2c3
   ```
   If push fails with non-fast-forward: re-fetch, re-rebase, retry (up to 3 times).
7. Close your bead: `tbd close scr-a1b2 --reason="Implemented auth middleware"`
8. Sync: `tbd sync`

## Observation Beads

If you discover out-of-scope issues while working, create observation beads:
```
tbd create "Observation: <description>" \
  --type=task --label=observation --label=harness-run:run-2026-02-12-a1b2c3
```
Do NOT fix out-of-scope issues yourself. Just log them and move on.

## What NOT to Do

- Do NOT work on other beads
- Do NOT fix other agents' broken tests (maintenance handles that)
- Do NOT read or reference acceptance criteria (you don't have access)
- Do NOT modify the frozen spec
```

**Environment variables** set alongside this prompt:
```
TBD_HARNESS_RUN_ID=run-2026-02-12-a1b2c3
TBD_HARNESS_TARGET_BRANCH=tbd-run/run-2026-02-12-a1b2c3
```

**How this prompt is delivered** (see §Backend CLI Reference for exact flags):
- **Claude Code**: Bead details, frozen spec, completion checklist, observation
  instructions → `-p` prompt. Guidelines → `--append-system-prompt`.
- **Codex**: Everything (including guidelines) → positional prompt argument to
  `codex exec`. Guidelines are prepended to the prompt since Codex has no
  `--append-system-prompt`.
- **Both**: Environment variables set via the `env` option on `spawn()`.

## Known Limitations

These are accepted tradeoffs for v1, documented for transparency:

1. **Acceptance criteria isolation is soft**: Coding agents run with full filesystem
   access (`--dangerously-skip-permissions` for Claude Code). An agent could
   theoretically read `~/.cache/tbd-harness/<run-id>/acceptance/*` if it knew the
   path. The isolation works because: (a) the path is never mentioned in agent
   prompts, (b) agents don't know acceptance criteria exist, (c) no environment
   variable hints at the path. For stronger isolation, use the Codex backend with
   `--sandbox workspace-write` which restricts filesystem access to the worktree.

2. **Frozen spec is inside the repo**: The frozen spec at
   `.tbd/harness/<run-id>/frozen-spec.md` is inside the repo. Agents with write
   access could modify it. In practice this doesn't happen — agents are told to
   work on their bead, not modify harness state. **Mitigation**: SHA-256 hash
   verification before each phase transition detects any modification (see §Phase
   1). Tampering triggers `E_SPEC_HASH_MISMATCH` and halts the run.

3. **Process tree killing is Unix-only**: The `detached: true` + `process.kill(-pid)`
   pattern for killing agent process groups only works on Unix/macOS. Windows is
   not supported in v1 (add `tree-kill` package for Windows support if needed).

4. **No cost controls in v1**: There is no budget cap or cost estimation. A run
   with 50+ beads and 3 judge iterations could consume significant API credits.
   `--max-budget-usd` exists in Claude Code but is not wired up in v1. See Future
   Work.

5. **LWW merge for concurrent tbd operations**: Multiple agents running `tbd sync`
   concurrently rely on Last-Write-Wins merge. In rare cases, a bead status update
   could be lost if two syncs collide within the same second. This is acceptable
   for v1 since the harness is the source of truth for bead state (via checkpoint),
   not the tbd data store.

## Performance Design Targets

These are testable targets for the harness's own overhead (not agent execution time):

| Operation | Target | Notes |
| --- | --- | --- |
| Scheduler recompute | p95 < 250ms for 500 beads | Graph rebuild + ranking |
| Checkpoint write | p95 < 100ms | Includes fsync |
| Event append | p99 < 20ms | Single serialized write |
| Resume from checkpoint | < 30s for ≤2000 beads | Includes bead status reconciliation |
| Orchestrator memory | < 512MB at 2000 beads | Excludes agent processes |

These targets inform the testing strategy — performance tests should validate them.

## Future Work (Post-v1)

- **Cost tracking and budget controls**: Pre-run cost estimates, `--budget` flag,
  per-phase cost tracking in run log
- **`--from-phase` entry points**: Resume from any phase (implement, maintain, judge)
- **`--judge-only`**: Re-run just the judge with different config
- **Canary phase**: Run 1-2 beads serially before fan-out to validate config
- **Spec amendments**: Update frozen spec mid-run, regenerate affected beads only
- **Live terminal dashboard**: Real-time TUI showing agent status and progress
- **Parallel maintenance**: Targeted per-failure agents instead of single agent
- **Atomic bead claiming**: `tbd claim` command with optimistic locking (currently
  the harness serializes claims, which is sufficient)
- **`--preview-acceptance`**: Show generated acceptance criteria before the run starts,
  so humans can review quality before committing to a full run
- **Spec review phase**: Optional AI review of the spec before freezing (removed
  from v1 — the harness expects a finished spec)
- **Metrics and alerting**: Prometheus/OpenTelemetry-compatible metrics for
  operational monitoring (bead attempts, failures, judge durations, active agents)
- **Windows support**: Add `tree-kill` package for cross-platform process group killing

## References

- [Attractor spec](https://github.com/strongdm/attractor/blob/main/attractor-spec.md)
  — DAG orchestrator for AI workflows (reference for checkpointing, goal gates)
- [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) — Critical path
  analysis, impact depth, and scheduling for bead dependency graphs
- [tbd transactional mode spec](docs/project/specs/active/plan-2026-01-19-transactional-mode-and-agent-registration.md)
  — Agent registration + transactions (complementary feature)
- [tbd design doc](packages/tbd/docs/tbd-design.md) — Current tbd architecture
- [Beads](https://github.com/steveyegge/beads) — Original git-native issue tracking
- [Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) — Real-time agent
  messaging (complementary, not replaced)
- [Lessons in spec coding](https://github.com/jlevy/speculate/blob/main/about/lessons_in_spec_coding.md)
  — jlevy's spec-driven development philosophy
