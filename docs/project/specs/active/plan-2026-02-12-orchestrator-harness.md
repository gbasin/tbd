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
│  ┌──────────┐    ┌───────────┐    ┌──────────────┐              │
│  │ Load spec│───▸│ AI review │───▸│ Freeze + gen │              │
│  │          │    │ (optional)│    │ acceptance   │              │
│  └──────────┘    └───────────┘    └──────┬───────┘              │
│                                          │                       │
│  PHASE 2: DECOMPOSE                      ▼                       │
│  ┌──────────────────────────────────────────┐                    │
│  │ Generate beads from spec (or use existing)│                   │
│  └──────────────────┬───────────────────────┘                    │
│                     │                                            │
│  PHASE 3: IMPLEMENT │  (fan out, up to N concurrent)             │
│  ┌──────────────────▼───────────────────────┐                    │
│  │ Harness assigns beads (critical-path order)│                  │
│  │ Agents: code → test → build → rebase-merge │                 │
│  │ Agents may create observation beads        │                  │
│  └──────────────────┬───────────────────────┘                    │
│                     │                                            │
│  PHASE 4: MAINTAIN  │                                            │
│  ┌──────────────────▼───────────────────────┐                    │
│  │ Harness runs automated checks             │                   │
│  │ If broken: spawn maintenance agent to fix  │                  │
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

**Steps**:
1. Load the spec file
2. (Optional) Run AI review — a separate LLM call that critiques the spec for
   completeness, ambiguity, and missing edge cases
3. Freeze: copy the spec to `.tbd/harness/frozen-spec.md` (immutable reference)
4. Generate acceptance criteria and store **outside the repo** (see §Acceptance
   Criteria below)

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

**Input**: Ready beads from the harness scheduler.

**Concurrency**: Up to `max_concurrency` agents in parallel.

#### Bead Claiming: Harness as Single Serializer

**Critical design decision**: The harness is the **sole reader** of `tbd ready` and
the **sole assigner** of beads. Agents never call `tbd ready` themselves.

Why: tbd has no atomic claim operation. Without a serialized claim point, two agents
could both read the same bead as "ready" and race to claim it. The harness eliminates
this race condition by being the single process that reads, claims, and assigns beads.

#### Critical-Path Scheduling

The harness does not pick beads in FIFO order. It uses critical-path scheduling
(inspired by [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)):

1. **Max fan-out first**: Pick beads that unblock the most downstream beads (impact
   depth / keystones)
2. **Then by priority**: P0 > P1 > P2 > P3 > P4
3. **Then by creation order**: Oldest first as tiebreaker

This maximizes parallelism over time — foundation beads (types, schemas, shared
utilities) naturally execute first because they have the highest fan-out.

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
   - relevant spec section              - Spec context
   - guidelines (auto-selected)         - Guidelines
   - codebase context
                                     7. Do the work: write code + tests
                                     8. Run OWN tests (not all tests)
                                     9. Ensure: build + typecheck + lint
                                     10. git pull --rebase origin/<target>
                                         (integration branch or main)
                                     11. Resolve merge conflicts
                                     12. git push
                                     13. tbd close <id> --reason="..."
                                     14. (Optional) tbd create for
                                         observation beads
                                     15. tbd sync
                                     16. Exit
17. Detect agent exited
18. Verify bead is closed
19. Log result (pass/fail/timeout)
20. Emit event to JSONL log
21. Scheduler picks next bead → repeat
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

#### Observation Beads

Agents may discover out-of-scope issues while working on their bead. Rather than
ignoring these or failing, agents can create **observation beads** via `tbd create`:

```bash
tbd create "Observation: shared utility X doesn't handle edge case Y" \
  --type=task --label=observation --label=harness-run
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

**Two-step process**:

**Step 1: Harness runs automated checks** (no agent needed):
- Full test suite
- Build
- Typecheck
- Lint
- (Optional) Security audit (`npm audit`, `cargo audit`)

If all checks pass → skip to Phase 5 (no agent spawn, saves cost).

**Step 2: If checks fail, spawn maintenance agent**:
1. Spawn a single maintenance agent on the target branch
2. Maintenance agent prompt:
   - Fix test failures introduced by recent merges
   - Ensure build passes end-to-end
   - Fix any new typecheck errors
   - Fix new lint violations
   - Do NOT change behavior or add features — only fix breakage
3. Maintenance agent commits with a clear message: "chore: fix test/build breakage"
4. Push

**This is itself a bead** — the harness auto-creates a maintenance bead of type
`chore` so it's tracked like any other work.

### Phase 5: Judge (Firewalled Agent)

The judge is a **separate headless agent** with its own interface (`JudgeBackend`),
distinct from the coding `AgentBackend`. The judge runs with tool access to the repo
(grep, read files, git diff, etc.) but under stricter constraints: **read-only, no
code changes, structured output only**.

The judge evaluates two concerns:

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

**Storage**: Outside the repository, in a temporary directory managed by the harness:

```
/tmp/tbd-harness-<run-id>/          # Outside repo — agents cannot access
├── acceptance/
│   ├── user-stories.md             # Generated acceptance criteria
│   ├── edge-cases.md               # Generated edge cases
│   └── negative-tests.md           # What should NOT happen
```

The path is stored in the harness checkpoint so it persists across `--resume`.

**In-repo harness state** (gitignored, never in agent context):

```
.tbd/harness/
├── frozen-spec.md                  # Immutable spec snapshot
├── run-log.yml                     # Execution history (summary)
├── events.jsonl                    # Append-only event stream
└── judge-results/
    ├── iteration-1.yml             # Judge verdict per iteration
    ├── iteration-2.yml
    └── ...
```

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
│   ├── agent-1/     # worktree on branch tbd-run/<run-id>/bead-a1b2
│   ├── agent-2/     # worktree on branch tbd-run/<run-id>/bead-c3d4
│   └── agent-3/     # worktree on branch tbd-run/<run-id>/bead-e5f6
```

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
  stdout: string;             // Captured for logging
  stderr: string;
  duration: number;           // ms
}
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
    type: 'bug' | 'task';
  }>;
  stdout: string;
  duration: number;
}
```

### Agent Backends

| Backend | Command | Notes |
| --- | --- | --- |
| `claude-code` | `claude -p "<prompt>" --allowedTools ...` | Best hooks support |
| `codex` | `codex exec "<prompt>"` | Non-interactive, exits when done |
| `subprocess` | Configurable shell command | For custom agents |

**Auto-detection** (for zero-config): The harness checks `PATH` for `claude` and
`codex` in order. First one found is used as the default backend. If neither is found,
the harness exits with a clear error message explaining how to install a supported
backend.

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
6. **Observation bead instructions**: How to create observation beads for out-of-scope
   discoveries

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
    human_review: false         # Pause for human approval of beads

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
- Target branch: auto (integration branch)
- Concurrency: 4
- Timeout: 15 minutes per bead
- Retries: 2 per bead
- Worktree strategy: per-agent
- Maintenance: every 5 beads
- Judge: enabled, all checks, max 3 iterations, create PR on completion
- Acceptance criteria: auto-generated

### Run Log and Observability

The harness maintains two log files:

#### 1. Event Log (real-time, append-only)

`.tbd/harness/events.jsonl` — one JSON object per line, appended as events occur:

```jsonl
{"ts":"2026-02-12T10:00:00Z","event":"run_started","run_id":"run-a1b2c3","spec":"plan.md"}
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

#### 2. Run Log (structured summary)

`.tbd/harness/run-log.yml` — updated at phase transitions:

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

## Implementation Plan

### Phase 1: Core Loop + Config

- [ ] Define `HarnessConfig` schema (Zod) with sensible defaults for all fields
- [ ] Implement zero-config auto-detection (backend from PATH, all defaults)
- [ ] Implement run state machine: FREEZE → DECOMPOSE → IMPLEMENT → MAINTAIN → JUDGE
- [ ] Implement checkpoint save/restore (serialize state after each phase transition)
- [ ] Implement `tbd run` command entry point
- [ ] Implement `tbd run --status` (reads JSONL event log) and `tbd run --resume`

### Phase 2: Agent Backend Abstraction

- [ ] Define `AgentBackend` interface
- [ ] Define `JudgeBackend` interface (separate from AgentBackend)
- [ ] Implement `ClaudeCodeBackend` (spawn `claude -p "..."`)
- [ ] Implement `CodexBackend` (spawn `codex exec "..."`)
- [ ] Implement `SubprocessBackend` (configurable command)
- [ ] Implement backend auto-detection from PATH
- [ ] Implement prompt assembly (bead details + spec section + guidelines)
- [ ] Implement agent output capture and logging

### Phase 3: Worktree + Branch Management

- [ ] Implement integration branch creation (`tbd-run/<run-id>`)
- [ ] Implement worktree creation for per-agent mode
- [ ] Implement worktree cleanup after bead completion
- [ ] Implement branch naming: `tbd-run/<run-id>/<bead-id>`
- [ ] Implement target branch configuration (auto vs. main)
- [ ] Implement final PR creation from integration branch

### Phase 4: Bead Scheduling + Fan Out

- [ ] Implement critical-path scheduler (max fan-out → priority → creation order)
- [ ] Implement harness-serialized bead claiming (no agent self-assignment)
- [ ] Implement concurrent agent pool (up to `max_concurrency`)
- [ ] Implement agent lifecycle: spawn → monitor → collect result
- [ ] Implement retry logic with failure-mode-specific behavior:
  - Timeout/crash → fresh worktree
  - Incomplete → reuse worktree
- [ ] Implement timeout handling (kill agent, unclaim bead)
- [ ] Implement observation bead tracking (label-based identification)

### Phase 5: Maintenance Phase

- [ ] Implement harness-side automated check runner (tests, build, typecheck, lint)
- [ ] Implement conditional agent spawn (only if checks fail)
- [ ] Implement maintenance trigger logic (every N beads, after all)
- [ ] Implement maintenance agent prompt template
- [ ] Auto-create maintenance bead for tracking

### Phase 6: Acceptance Criteria Generation

- [ ] Implement acceptance criteria generation from frozen spec
- [ ] Implement storage in temp directory outside repo
- [ ] Implement temp directory path persistence in checkpoint (for --resume)
- [ ] Implement manual acceptance criteria path override

### Phase 7: Judge Agent + Feedback Loop

- [ ] Implement JudgeBackend for Claude Code
- [ ] Implement JudgeBackend for Codex
- [ ] Implement judge prompt (spec drift + acceptance eval + observation triage)
- [ ] Implement structured judge output parsing
- [ ] Implement bead creation from judge failures
- [ ] Implement observation bead triage (promote/dismiss/merge)
- [ ] Implement iteration counter and max_iterations guard
- [ ] Implement final output (PR creation, summary report)

### Phase 8: Observability

- [ ] Implement JSONL event log writer (append-only)
- [ ] Implement run-log.yml writer (phase-transition updates)
- [ ] Implement `tbd run --status` reader (parses JSONL for live state)
- [ ] Implement `--dry-run` mode (show planned beads + schedule without executing)

## Testing Strategy

### Unit Tests
- Config parsing, validation, and zero-config defaults
- State machine transitions
- Critical-path scheduler (ordering correctness)
- Prompt assembly
- Agent result handling with failure-mode-specific retry
- Judge output parsing and bead creation
- Event log serialization

### Integration Tests
- Full pipeline with mock agent backend (returns canned results)
- Checkpoint save/restore across simulated crashes
- Retry logic: timeout → fresh worktree, incomplete → reuse worktree
- Judge feedback loop (fail → new beads → re-implement → pass)
- Observation bead flow (agent creates → judge triages → promoted bead executes)
- Integration branch creation and final PR
- Backend auto-detection

### Golden Tests
- Snapshot the run-log output for a known scenario
- Snapshot the JSONL event stream for a known scenario
- Snapshot the agent prompts generated for known beads
- Snapshot the judge prompt assembled from known state
- Snapshot the critical-path schedule for a known dependency graph

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

6. **How should the harness integrate with beads_viewer for scheduling?**
   - Option A: Shell out to `bv --robot-plan` (requires bv installed)
   - Option B: Port the critical-path algorithm into the harness (no external dep)
   - Option C: Optional integration — use bv if available, fall back to priority-only
   - Recommendation: Start with B (port the algorithm). The topological sort +
     impact depth calculation is not complex.

7. **Relationship to Transactional Mode spec**
   - The transactional mode spec adds `tbd tx begin`/`tbd tx commit` for atomic
     bead operations. The harness currently uses immediate mode.
   - These features are complementary but independent for v1.
   - Future: the harness could use transactional mode for atomic batch operations
     (e.g., creating all decomposition beads in one transaction).

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
