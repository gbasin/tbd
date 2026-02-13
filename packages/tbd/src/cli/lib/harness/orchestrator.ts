/**
 * Main orchestrator state machine for tbd compile.
 *
 * Composes all harness components:
 * freeze → decompose → implement → maintain → judge → (loop or done)
 */

import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { HarnessConfig } from '../../../lib/harness/config.js';
import { getBeadTimeoutMs } from '../../../lib/harness/config.js';
import type { Checkpoint, AgentResult, JudgeResult } from '../../../lib/harness/types.js';
import type { Issue } from '../../../lib/types.js';
import { ERROR_CODE_EXIT_MAP } from '../../../lib/harness/types.js';
import type { HarnessErrorCodeType } from '../../../lib/harness/types.js';
import { AcceptanceManager } from '../../../lib/harness/acceptance.js';
import { harnessRunDir } from '../../../lib/paths.js';
import { CheckpointManager, computeFileHash, verifySpecHash } from './checkpoint.js';
import { EventLogger } from './events.js';
import { RunLock } from './run-lock.js';
import { RunLogWriter } from './run-log.js';
import { WorktreeManager } from './worktree.js';
import { Scheduler } from './scheduler.js';
import { AgentPool } from './agent-pool.js';
import { buildCodingAgentPrompt, buildMaintenancePrompt, loadGuidelines } from './prompts.js';
import { createAgentBackend, createJudgeBackend } from './backends/detect.js';
import { killAllActiveProcesses } from './backends/backend.js';
import { HarnessError } from '../errors.js';

const execFileAsync = promisify(execFile);

// =============================================================================
// Run ID Generation
// =============================================================================

function generateRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const hash = Math.random().toString(36).slice(2, 8);
  return `run-${date}-${hash}`;
}

// =============================================================================
// Orchestrator
// =============================================================================

export interface OrchestratorOptions {
  config: HarnessConfig;
  tbdRoot: string;
  specPath?: string;
  resume?: boolean;
  dryRun?: boolean;
  beadLabel?: string;
}

export interface OrchestratorResult {
  runId: string;
  status: 'completed' | 'failed' | 'dry_run';
  totalBeads: number;
  iterations: number;
  message: string;
}

export class Orchestrator {
  private readonly config: HarnessConfig;
  private readonly tbdRoot: string;
  private runId = '';
  private runDir = '';
  private checkpointMgr!: CheckpointManager;
  private eventLogger!: EventLogger;
  private runLock!: RunLock;
  private runLog!: RunLogWriter;
  private worktreeMgr!: WorktreeManager;
  private checkpoint!: Checkpoint;
  private totalAgentSpawns = 0;

  constructor(private readonly opts: OrchestratorOptions) {
    this.config = opts.config;
    this.tbdRoot = opts.tbdRoot;
    this.worktreeMgr = new WorktreeManager(opts.tbdRoot);
  }

  /** Run the full pipeline. */
  async run(): Promise<OrchestratorResult> {
    try {
      if (this.opts.resume) {
        await this.resumeFromCheckpoint();
      } else {
        await this.startFresh();
      }

      // Register SIGTERM handler
      const cleanup = this.setupSignalHandlers();

      try {
        const result = await this.executePipeline();
        return result;
      } finally {
        cleanup();
        await this.eventLogger.close();
        await this.runLock.release();
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      throw new HarnessError(message, 'E_CONFIG_INVALID', 2);
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private async startFresh(): Promise<void> {
    if (!this.opts.specPath) {
      throw harnessError('E_SPEC_NOT_FOUND', 'No spec path provided. Use --spec <path>');
    }

    // Verify spec exists
    try {
      await readFile(join(this.tbdRoot, this.opts.specPath));
    } catch {
      throw harnessError('E_SPEC_NOT_FOUND', `Spec file not found: ${this.opts.specPath}`);
    }

    this.runId = generateRunId();
    this.runDir = join(this.tbdRoot, harnessRunDir(this.runId));

    // Create state directory
    await mkdir(this.runDir, { recursive: true });

    this.checkpointMgr = new CheckpointManager(this.runDir);
    this.eventLogger = new EventLogger(join(this.runDir, 'events.jsonl'));
    await this.eventLogger.open();
    this.runLock = new RunLock(this.runDir, this.runId);
    await this.runLock.acquire();

    this.eventLogger.emit({ event: 'run_started', run_id: this.runId, spec: this.opts.specPath });

    // Initialize checkpoint
    this.checkpoint = {
      schemaVersion: 1,
      runId: this.runId,
      specPath: this.opts.specPath,
      frozenSpecPath: '',
      frozenSpecSha256: '',
      targetBranch: '',
      baseBranch: this.config.worktree.base_branch,
      state: 'freezing',
      iteration: 1,
      beads: { total: 0, completed: [], inProgress: [], blocked: [], retryCounts: {}, claims: {} },
      agents: { maxConcurrency: this.config.agent.max_concurrency, active: [] },
      maintenance: { runCount: 0, runs: [] },
      observations: { pending: [], promoted: [], dismissed: [] },
    };

    // Determine target branch
    if (this.config.target_branch === 'auto') {
      const branchName = await this.worktreeMgr.createIntegrationBranch(
        this.runId,
        this.config.worktree.base_branch,
      );
      this.checkpoint.targetBranch = branchName;
    } else {
      this.checkpoint.targetBranch = this.config.target_branch;
    }

    this.runLog = new RunLogWriter(
      this.runDir,
      this.runId,
      this.opts.specPath,
      this.checkpoint.targetBranch,
    );
  }

  private async resumeFromCheckpoint(): Promise<void> {
    // Find most recent run
    const { readdirSync } = await import('node:fs');
    const harnessDir = join(this.tbdRoot, '.tbd', 'harness');
    let runDirs: string[];
    try {
      runDirs = readdirSync(harnessDir)
        .filter((d: string) => d.startsWith('run-'))
        .sort()
        .reverse();
    } catch {
      throw harnessError('E_CHECKPOINT_CORRUPT', 'No harness runs found to resume');
    }

    if (runDirs.length === 0) {
      throw harnessError('E_CHECKPOINT_CORRUPT', 'No harness runs found to resume');
    }

    this.runId = runDirs[0]!;
    this.runDir = join(harnessDir, this.runId);
    this.checkpointMgr = new CheckpointManager(this.runDir);
    this.checkpoint = await this.checkpointMgr.load();

    this.eventLogger = new EventLogger(join(this.runDir, 'events.jsonl'));
    await this.eventLogger.open();
    this.runLock = new RunLock(this.runDir, this.runId);
    await this.runLock.acquire();
    this.runLog = new RunLogWriter(
      this.runDir,
      this.runId,
      this.checkpoint.specPath,
      this.checkpoint.targetBranch,
    );
    await this.runLog.load();

    // Verify acceptance criteria still exist
    if (this.checkpoint.acceptancePath) {
      const acceptance = new AcceptanceManager(this.runId);
      await acceptance.verify();
    }

    // Verify frozen spec hash
    if (this.checkpoint.frozenSpecPath) {
      await verifySpecHash(
        join(this.tbdRoot, this.checkpoint.frozenSpecPath),
        this.checkpoint.frozenSpecSha256,
      );
    }

    this.eventLogger.emit({
      event: 'run_resumed',
      run_id: this.runId,
      phase: this.checkpoint.state,
    });
  }

  // ===========================================================================
  // Pipeline Execution
  // ===========================================================================

  private async executePipeline(): Promise<OrchestratorResult> {
    // Re-read phase from checkpoint each time (not cached — fixes resume loops)
    const initialPhase = this.checkpoint.state;

    if (initialPhase === 'freezing' || initialPhase === 'decomposing') {
      // Guard: skip freeze if already frozen (resume safety)
      if (!this.checkpoint.frozenSpecPath) {
        await this.freeze();
      }
      await this.decompose();

      if (this.opts.dryRun) {
        return {
          runId: this.runId,
          status: 'dry_run',
          totalBeads: this.checkpoint.beads.total,
          iterations: 0,
          message: `Dry run complete. ${this.checkpoint.beads.total} beads created. Use --resume to continue.`,
        };
      }
    }

    // Main loop: implement → maintain → judge → (loop or done)
    const maxIterations = this.config.phases.judge.max_iterations;

    while (this.checkpoint.iteration <= maxIterations) {
      // Re-read state each iteration (critical for post-judge remediation loops)
      if (this.checkpoint.state !== 'judging') {
        // Verify spec hash before implement phase
        await this.verifyFrozenSpec();
        await this.implement();
      }

      if (this.config.phases.judge.enabled) {
        // Verify spec hash before judge phase
        await this.verifyFrozenSpec();
        const judgeResult = await this.judge();

        if (judgeResult.acceptance.passed && !judgeResult.specDrift.detected) {
          // PASS — we're done
          if (this.config.phases.judge.on_complete === 'pr') {
            await this.createPR();
          }

          this.checkpoint.state = 'completed';
          await this.saveCheckpoint();

          this.runLog.complete(this.checkpoint.beads.total, this.totalAgentSpawns);
          await this.runLog.flush();

          this.eventLogger.emit({
            event: 'run_completed',
            status: 'completed',
            total_beads: this.checkpoint.beads.total,
          });

          return {
            runId: this.runId,
            status: 'completed',
            totalBeads: this.checkpoint.beads.total,
            iterations: this.checkpoint.iteration,
            message: 'All acceptance criteria passed. Run complete.',
          };
        }

        // FAIL — create remediation beads and loop
        await this.createRemediationBeads(judgeResult);
        this.checkpoint.iteration++;
        // Reset state to implementing for next iteration
        this.checkpoint.state = 'implementing';
        await this.saveCheckpoint();

        this.runLog.startIteration(this.checkpoint.iteration);
        await this.runLog.flush();
      } else {
        // No judge — complete after implementation
        this.checkpoint.state = 'completed';
        await this.saveCheckpoint();

        return {
          runId: this.runId,
          status: 'completed',
          totalBeads: this.checkpoint.beads.total,
          iterations: 1,
          message: 'Implementation complete (judge disabled).',
        };
      }
    }

    // Max iterations reached
    this.checkpoint.state = 'failed';
    await this.saveCheckpoint();
    this.runLog.fail();
    await this.runLog.flush();

    throw harnessError(
      'E_MAX_ITERATIONS',
      `Max iterations (${maxIterations}) reached. Some acceptance criteria still failing.`,
    );
  }

  // ===========================================================================
  // Phase 1: Freeze
  // ===========================================================================

  private async freeze(): Promise<void> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'freeze' });
    this.checkpoint.state = 'freezing';

    const frozenPath = join(harnessRunDir(this.runId), 'frozen-spec.md');
    const absFrozenPath = join(this.tbdRoot, frozenPath);

    // Copy spec to frozen location
    await copyFile(join(this.tbdRoot, this.checkpoint.specPath), absFrozenPath);

    // Compute hash
    const hash = await computeFileHash(absFrozenPath);
    this.checkpoint.frozenSpecPath = frozenPath;
    this.checkpoint.frozenSpecSha256 = hash;

    // Generate acceptance criteria
    if (this.config.acceptance.generate) {
      const acceptance = new AcceptanceManager(this.runId);
      const backend = createAgentBackend(this.config.agent.backend, this.config.agent.command);
      await acceptance.generate(absFrozenPath, async (prompt) => {
        const result = await backend.spawn({
          workdir: this.tbdRoot,
          prompt,
          timeout: 300_000, // 5 min for acceptance generation
        });
        return result.lastLines;
      });
      this.checkpoint.acceptancePath = acceptance.getPath();
    } else if (this.config.acceptance.path) {
      this.checkpoint.acceptancePath = this.config.acceptance.path;
    }

    await this.saveCheckpoint();
    this.eventLogger.emit({ event: 'spec_frozen', hash });
  }

  // ===========================================================================
  // Phase 2: Decompose
  // ===========================================================================

  private async decompose(): Promise<void> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'decompose' });
    this.checkpoint.state = 'decomposing';

    const beadLabel = this.opts.beadLabel ?? this.config.phases.decompose.existing_selector;

    if (beadLabel) {
      // Use existing beads with this label
      const stdout = await this.tbdExecStrict([
        'list',
        `--label=${beadLabel}`,
        '--status=open',
        '--json',
      ]);

      const beads = JSON.parse(stdout) as { id: string }[];
      if (!Array.isArray(beads) || beads.length === 0) {
        throw harnessError(
          'E_BEAD_SCOPE_AMBIGUOUS',
          `No open beads found with label: ${beadLabel}`,
        );
      }

      // Add harness-run label to existing beads
      for (const bead of beads) {
        await this.tbdExecStrict(['label', 'add', bead.id, `harness-run:${this.runId}`]);
      }

      this.checkpoint.beads.total = beads.length;
    } else if (this.config.phases.decompose.auto) {
      // Spawn decomposition agent
      const backend = createAgentBackend(this.config.agent.backend, this.config.agent.command);

      const frozenSpec = await readFile(
        join(this.tbdRoot, this.checkpoint.frozenSpecPath),
        'utf-8',
      );

      const prompt = `You are a decomposition agent. Read the following spec and create implementation beads (tasks) using the tbd CLI.

## Spec
${frozenSpec}

## Instructions
1. Break the spec into atomic implementation beads
2. Each bead should be completable by a single agent in one session
3. Create beads with dependencies where order matters
4. Use these commands:
   - \`tbd create "<title>" --type=task --label=harness-run:${this.runId}\`
   - \`tbd dep add <bead-id> <depends-on-id>\` (first bead depends on second)
5. After creating all beads: \`tbd sync\`

Create beads now.`;

      const result = await backend.spawn({
        workdir: this.tbdRoot,
        prompt,
        timeout: getBeadTimeoutMs(this.config),
      });
      this.totalAgentSpawns++;

      if (result.status !== 'success') {
        throw harnessError(
          'E_DEADLOCK',
          `Decomposition agent failed: ${result.lastLines.slice(-200)}`,
        );
      }

      // Count created beads
      const stdout = await this.tbdExecSafe([
        'list',
        `--label=harness-run:${this.runId}`,
        '--status=open',
        '--json',
      ]);

      const beads = JSON.parse(stdout || '[]') as unknown[];
      this.checkpoint.beads.total = Array.isArray(beads) ? beads.length : 0;
    }

    await this.saveCheckpoint();
    this.eventLogger.emit({
      event: 'beads_created',
      count: this.checkpoint.beads.total,
    });

    this.runLog.startIteration(this.checkpoint.iteration);
    this.runLog.updateIteration({ beadsTotal: this.checkpoint.beads.total });
    await this.runLog.flush();
  }

  // ===========================================================================
  // Phase 3: Implement
  // ===========================================================================

  private async implement(): Promise<void> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'implement' });
    this.checkpoint.state = 'implementing';

    const backend = createAgentBackend(this.config.agent.backend, this.config.agent.command);
    const pool = new AgentPool(backend, this.config.agent.max_concurrency);
    const guidelines = await loadGuidelines(this.tbdRoot, this.config.phases.implement.guidelines);
    const timeout = getBeadTimeoutMs(this.config);

    // Get all run beads AND their external blockers for correct graph construction
    const runBeadStdout = await this.tbdExecSafe([
      'list',
      `--label=harness-run:${this.runId}`,
      '--json',
    ]);
    const allBeads = JSON.parse(runBeadStdout || '[]') as Issue[];
    const runBeadIds = new Set<string>(allBeads.map((b) => b.id));

    // Also fetch all open issues so external blocker edges are visible
    const allIssuesStdout = await this.tbdExecSafe(['list', '--status=open', '--json']);
    const allIssues = JSON.parse(allIssuesStdout || '[]') as Issue[];

    const completedIds = new Set<string>(this.checkpoint.beads.completed);
    const inProgressIds = new Set<string>(this.checkpoint.beads.inProgress);
    const blockedIds = new Set<string>(this.checkpoint.beads.blocked);

    const scheduler = new Scheduler(runBeadIds);
    scheduler.rebuild(allIssues);

    // Check for cycles
    const cycles = scheduler.checkCycles();
    if (cycles.length > 0) {
      throw harnessError('E_GRAPH_CYCLE', `Dependency cycles detected: ${JSON.stringify(cycles)}`);
    }

    let beadsCompletedThisIteration = 0;
    let maintRunCount = this.checkpoint.maintenance.runCount;
    let maintPromise: Promise<void> | null = null;

    // Main implementation loop
    while (true) {
      // Assign beads while there's capacity
      while (pool.hasCapacity) {
        // Refresh bead lists periodically for accurate scheduling
        await this.listRunBeads();
        const freshAllIssues = JSON.parse(
          (await this.tbdExecSafe(['list', '--status=open', '--json'])) || '[]',
        ) as Issue[];
        scheduler.rebuild(freshAllIssues);

        const nextBead = scheduler.pickNext(completedIds, inProgressIds, blockedIds);
        if (!nextBead) break;

        // Claim bead
        inProgressIds.add(nextBead.id);
        this.checkpoint.beads.inProgress = Array.from(inProgressIds);
        const claimCount = (this.checkpoint.beads.retryCounts[nextBead.id] ?? 0) + 1;
        this.checkpoint.beads.claims[nextBead.id] =
          `${this.runId}:${this.checkpoint.iteration}:${claimCount}`;

        // Update bead status
        await this.tbdExecSafe(['update', nextBead.id, '--status=in_progress']);

        // Create worktree (handles existing worktrees from retries)
        const worktreePath = await this.worktreeMgr.createAgentWorktree(
          this.runId,
          nextBead.id,
          this.checkpoint.targetBranch,
        );

        // Track active agent in checkpoint
        this.checkpoint.agents.active.push({
          agentId: this.totalAgentSpawns + 1,
          beadId: nextBead.id,
          worktree: worktreePath,
          startedAt: new Date().toISOString(),
          pid: 0, // PID assigned by backend
        });

        // Build prompt
        const prompt = await buildCodingAgentPrompt({
          beadId: nextBead.id,
          beadTitle: nextBead.title,
          beadDescription: nextBead.description ?? '',
          beadType: nextBead.kind,
          beadPriority: nextBead.priority,
          beadDependencies: '',
          frozenSpecPath: join(this.tbdRoot, this.checkpoint.frozenSpecPath),
          runId: this.runId,
          targetBranch: this.checkpoint.targetBranch,
        });

        pool.assign(nextBead.id, {
          workdir: worktreePath,
          prompt,
          timeout,
          systemPrompt: guidelines || undefined,
          env: {
            TBD_HARNESS_RUN_ID: this.runId,
            TBD_HARNESS_TARGET_BRANCH: this.checkpoint.targetBranch,
          },
        });

        this.totalAgentSpawns++;
        this.eventLogger.emit({
          event: 'agent_started',
          bead_id: nextBead.id,
        });
        await this.saveCheckpoint();
      }

      // Wait for any agent to complete
      const completed = await pool.waitForAny();
      if (!completed) {
        // No agents running — check if we're done or deadlocked
        const deadlock = scheduler.detectDeadlock(completedIds, inProgressIds, blockedIds, 0);
        if (deadlock.deadlocked) {
          // Check for external blockers
          const external = scheduler.detectExternalBlockers(completedIds, blockedIds);
          if (external.blocked) {
            throw harnessError('E_EXTERNAL_BLOCKED', external.chains.join('\n'));
          }
          throw harnessError('E_DEADLOCK', deadlock.reason);
        }
        break; // All beads done
      }

      const { slot, result } = completed;
      inProgressIds.delete(slot.beadId);
      this.checkpoint.beads.inProgress = Array.from(inProgressIds);
      // Remove from active agents
      this.checkpoint.agents.active = this.checkpoint.agents.active.filter(
        (a) => a.beadId !== slot.beadId,
      );

      this.eventLogger.emit({
        event: 'agent_finished',
        bead_id: slot.beadId,
        status: result.status,
        duration_ms: result.duration,
      });

      // Handle result
      await this.handleAgentResult(slot.beadId, result, completedIds, blockedIds);

      if (completedIds.has(slot.beadId)) {
        beadsCompletedThisIteration++;

        // Trigger maintenance if needed
        if (
          this.config.phases.maintain.trigger === 'every_n_beads' &&
          beadsCompletedThisIteration % this.config.phases.maintain.n === 0
        ) {
          // Wait for any running maintenance before starting new one
          if (maintPromise) await maintPromise;
          maintRunCount++;
          maintPromise = this.spawnMaintenance(maintRunCount);
        }
      }

      // Clean up worktree if bead is terminal
      if (completedIds.has(slot.beadId) || blockedIds.has(slot.beadId)) {
        const shortId = slot.beadId.replace(/^is-/, '').slice(0, 8);
        const worktreePath = join(this.tbdRoot, '.tbd', 'worktrees', `agent-${shortId}`);
        if (this.config.worktree.cleanup) {
          await this.worktreeMgr.removeWorktree(worktreePath).catch(() => {});
        }
      }

      await this.saveCheckpoint();
    }

    // Await any running maintenance before leaving implement phase
    if (maintPromise) await maintPromise;

    // Run final maintenance if configured
    if (this.config.phases.maintain.trigger === 'after_all') {
      maintRunCount++;
      await this.spawnMaintenance(maintRunCount);
    }

    this.checkpoint.maintenance.runCount = maintRunCount;
    this.runLog.updateIteration({
      beadsCompleted: completedIds.size,
      beadsFailed: blockedIds.size,
      beadsBlocked: blockedIds.size,
      agentsSpawned: this.totalAgentSpawns,
      maintenanceRuns: maintRunCount,
    });
    await this.runLog.flush();
  }

  private async handleAgentResult(
    beadId: string,
    result: AgentResult,
    completedIds: Set<string>,
    blockedIds: Set<string>,
  ): Promise<void> {
    // Check if bead was actually closed by the agent
    const beadStatus = await this.getBeadStatus(beadId);

    if (beadStatus === 'closed') {
      completedIds.add(beadId);
      this.checkpoint.beads.completed = Array.from(completedIds);
      this.eventLogger.emit({ event: 'bead_completed', bead_id: beadId });
      return;
    }

    // Not closed — handle failure
    const retryCount = (this.checkpoint.beads.retryCounts[beadId] ?? 0) + 1;
    this.checkpoint.beads.retryCounts[beadId] = retryCount;

    if (retryCount > this.config.agent.max_retries_per_bead) {
      // Max retries exceeded — mark as blocked
      blockedIds.add(beadId);
      this.checkpoint.beads.blocked = Array.from(blockedIds);
      await this.tbdExecSafe(['update', beadId, '--status=blocked']);
      this.eventLogger.emit({
        event: 'bead_blocked',
        bead_id: beadId,
        reason: 'max_retries_exceeded',
        last_lines: result.lastLines.slice(-200),
      });
    } else {
      // Reset to open for retry (worktree will be cleaned up on next assignment)
      await this.tbdExecSafe(['update', beadId, '--status=open']);
      this.eventLogger.emit({
        event: 'bead_retry',
        bead_id: beadId,
        retry: retryCount,
        failure_mode: result.status,
      });
    }
  }

  // ===========================================================================
  // Phase 4: Maintain
  // ===========================================================================

  private async spawnMaintenance(index: number): Promise<void> {
    this.eventLogger.emit({ event: 'maintenance_started', index });

    // Create a maintenance bead for tracking
    const maintBeadId = await this.tbdExecSafe([
      'create',
      `Maintenance run #${index}`,
      '--type=task',
      `--label=harness-run:${this.runId}`,
      '--label=maintenance',
    ]);

    const backend = createAgentBackend(this.config.agent.backend, this.config.agent.command);
    const worktreePath = await this.worktreeMgr.createMaintenanceWorktree(
      this.runId,
      index,
      this.checkpoint.targetBranch,
    );

    // Track maintenance run in checkpoint
    this.checkpoint.maintenance.runs.push({
      id: `maint-${index}`,
      triggerCompletedCount: this.checkpoint.beads.completed.length,
      state: 'running',
    });
    this.checkpoint.maintenance.lastRunAt = new Date().toISOString();
    this.checkpoint.maintenance.beadId = maintBeadId.trim() || undefined;
    await this.saveCheckpoint();

    const prompt = buildMaintenancePrompt(this.checkpoint.targetBranch, this.runId);
    const result = await backend.spawn({
      workdir: worktreePath,
      prompt,
      timeout: getBeadTimeoutMs(this.config),
      env: {
        TBD_HARNESS_RUN_ID: this.runId,
        TBD_HARNESS_TARGET_BRANCH: this.checkpoint.targetBranch,
      },
    });
    this.totalAgentSpawns++;

    // Update maintenance run state
    const maintRun = this.checkpoint.maintenance.runs.find((r) => r.id === `maint-${index}`);
    if (maintRun) {
      maintRun.state = result.status === 'success' ? 'success' : 'failure';
    }
    await this.saveCheckpoint();

    this.eventLogger.emit({
      event: 'maintenance_finished',
      status: result.status,
      duration_ms: result.duration,
    });

    // Cleanup maintenance worktree
    if (this.config.worktree.cleanup) {
      await this.worktreeMgr.removeWorktree(worktreePath).catch(() => {});
    }
  }

  // ===========================================================================
  // Phase 5: Judge
  // ===========================================================================

  private async judge(): Promise<JudgeResult> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'judge' });
    this.checkpoint.state = 'judging';
    await this.saveCheckpoint();

    // Verify spec hash before judging
    await this.verifyFrozenSpec();

    // Discover observation beads
    const observationIds = await this.getObservationBeadIds();

    // Create judge worktree
    const judgeWorktree = await this.worktreeMgr.createJudgeWorktree(
      this.checkpoint.targetBranch,
      this.checkpoint.iteration,
    );

    const judgeBackend = createJudgeBackend(this.config.agent.backend);
    const result = await judgeBackend.evaluate({
      workdir: judgeWorktree,
      frozenSpecPath: join(this.tbdRoot, this.checkpoint.frozenSpecPath),
      acceptancePath: this.checkpoint.acceptancePath ?? '',
      observationBeadIds: observationIds,
      timeout: getBeadTimeoutMs(this.config) * 2, // Judge gets more time
      env: {
        TBD_HARNESS_RUN_ID: this.runId,
      },
    });
    this.totalAgentSpawns++;

    // Post-judge integrity check
    try {
      const { stdout } = await execFileAsync('git', ['-C', judgeWorktree, 'status', '--porcelain']);
      if (stdout.trim().length > 0) {
        this.eventLogger.emit({
          event: 'judge_integrity_violation',
          modified_files: stdout.trim(),
        });
        // Discard result — judge modified files
        return {
          status: 'failure',
          specDrift: { detected: false, issues: [] },
          acceptance: { passed: false, results: [] },
          observations: [],
          newBeads: [],
          lastLines: 'Judge integrity check failed — modified files in read-only worktree',
          duration: result.duration,
        };
      }
    } catch {
      // Integrity check failed — continue with result
    }

    // Cleanup judge worktree
    if (this.config.worktree.cleanup) {
      await this.worktreeMgr.removeWorktree(judgeWorktree).catch(() => {});
    }

    this.eventLogger.emit({
      event: 'judge_finished',
      iteration: this.checkpoint.iteration,
      verdict: result.acceptance.passed && !result.specDrift.detected ? 'pass' : 'fail',
      new_beads: result.newBeads.length,
    });

    // Store judge result
    const judgeResultDir = join(this.runDir, 'judge-results');
    await mkdir(judgeResultDir, { recursive: true });
    const { writeFile: atomicWrite } = await import('atomically');
    const yaml = await import('yaml');
    await atomicWrite(
      join(judgeResultDir, `iteration-${this.checkpoint.iteration}.yml`),
      yaml.stringify(result),
    );

    return result;
  }

  private async createRemediationBeads(judgeResult: JudgeResult): Promise<void> {
    // Create beads from judge findings
    for (const bead of judgeResult.newBeads) {
      await this.tbdExecSafe([
        'create',
        bead.title,
        `--type=${bead.type}`,
        `--label=harness-run:${this.runId}`,
        `--label=remediation`,
      ]);
      this.checkpoint.beads.total++;
    }

    // Handle observation beads
    for (const obs of judgeResult.observations) {
      if (obs.action === 'promote') {
        this.checkpoint.observations.promoted.push(obs.beadId);
        // Promoted beads are already labeled, just update
      } else if (obs.action === 'dismiss') {
        this.checkpoint.observations.dismissed.push(obs.beadId);
        await this.tbdExecSafe(['close', obs.beadId, `--reason=Dismissed by judge: ${obs.reason}`]);
      }
    }

    await this.saveCheckpoint();
  }

  // ===========================================================================
  // PR Creation
  // ===========================================================================

  private async createPR(): Promise<void> {
    if (this.config.target_branch !== 'auto') return; // Only for integration branch mode

    try {
      // Fetch latest base branch
      await execFileAsync('git', [
        '-C',
        this.tbdRoot,
        'fetch',
        'origin',
        this.config.worktree.base_branch,
      ]);

      // Rebase integration branch onto latest base
      try {
        await execFileAsync('git', [
          '-C',
          this.tbdRoot,
          'rebase',
          `origin/${this.config.worktree.base_branch}`,
          this.checkpoint.targetBranch,
        ]);
      } catch {
        // Rebase conflict — abort and continue with current state
        await execFileAsync('git', ['-C', this.tbdRoot, 'rebase', '--abort']).catch(() => {});
      }

      // Push with force-with-lease (safe force push after rebase)
      try {
        await execFileAsync('git', [
          '-C',
          this.tbdRoot,
          'push',
          '--force-with-lease',
          'origin',
          this.checkpoint.targetBranch,
        ]);
      } catch {
        // Fallback: create rebased branch
        const rebasedBranch = `${this.checkpoint.targetBranch}-rebased`;
        await execFileAsync('git', [
          '-C',
          this.tbdRoot,
          'branch',
          rebasedBranch,
          this.checkpoint.targetBranch,
        ]);
        await execFileAsync('git', ['-C', this.tbdRoot, 'push', '-u', 'origin', rebasedBranch]);
        this.checkpoint.targetBranch = rebasedBranch;
      }

      // Create PR via gh CLI
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'create',
          '--base',
          this.config.worktree.base_branch,
          '--head',
          this.checkpoint.targetBranch,
          '--title',
          `tbd compile: ${this.checkpoint.specPath}`,
          '--body',
          `## Summary\n\nAutomated implementation from spec: ${this.checkpoint.specPath}\n\n` +
            `- **Beads completed**: ${this.checkpoint.beads.completed.length}\n` +
            `- **Iterations**: ${this.checkpoint.iteration}\n` +
            `- **Agent spawns**: ${this.totalAgentSpawns}\n\n` +
            `Generated by \`tbd compile\``,
          '--label',
          'tbd-compile',
        ],
        { cwd: this.tbdRoot },
      );

      this.eventLogger.emit({ event: 'pr_created', url: stdout.trim() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.eventLogger.emit({ event: 'pr_creation_failed', error: msg });
      // Non-fatal — log but don't throw
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async saveCheckpoint(): Promise<void> {
    await this.checkpointMgr.save(this.checkpoint);
  }

  /** Verify frozen spec hash. Throws E_SPEC_HASH_MISMATCH on tampering. */
  private async verifyFrozenSpec(): Promise<void> {
    if (this.checkpoint.frozenSpecPath && this.checkpoint.frozenSpecSha256) {
      await verifySpecHash(
        join(this.tbdRoot, this.checkpoint.frozenSpecPath),
        this.checkpoint.frozenSpecSha256,
      );
    }
  }

  /**
   * Execute a tbd CLI command. Throws on failure.
   * Use for operations where failure is an error (label, list during decompose).
   */
  private async tbdExecStrict(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('tbd', args, { cwd: this.tbdRoot });
      return stdout;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.eventLogger.emit({ event: 'tbd_command_error', args, error: msg });
      throw harnessError('E_CONFIG_INVALID', `tbd command failed: tbd ${args.join(' ')}\n${msg}`);
    }
  }

  /**
   * Execute a tbd CLI command. Logs errors but does not throw.
   * Use for best-effort operations (status updates, listing).
   */
  private async tbdExecSafe(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('tbd', args, { cwd: this.tbdRoot });
      return stdout;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.eventLogger.emit({ event: 'tbd_command_error', args, error: msg });
      return '';
    }
  }

  private async listRunBeads(): Promise<Issue[]> {
    try {
      const stdout = await this.tbdExecSafe([
        'list',
        `--label=harness-run:${this.runId}`,
        '--json',
      ]);
      return JSON.parse(stdout || '[]') as Issue[];
    } catch {
      return [];
    }
  }

  private async getBeadStatus(beadId: string): Promise<string> {
    try {
      const stdout = await this.tbdExecSafe(['show', beadId, '--json']);
      const bead = JSON.parse(stdout) as { status?: string };
      return bead.status ?? 'open';
    } catch {
      return 'open';
    }
  }

  private async getObservationBeadIds(): Promise<string[]> {
    try {
      const stdout = await this.tbdExecSafe([
        'list',
        '--label=observation',
        `--label=harness-run:${this.runId}`,
        '--status=open',
        '--json',
      ]);
      const beads = JSON.parse(stdout || '[]') as { id: string }[];
      return beads.map((b) => b.id);
    } catch {
      return [];
    }
  }

  private setupSignalHandlers(): () => void {
    const handler = async () => {
      this.eventLogger.emit({ event: 'run_interrupted' });

      // Kill all active agent process groups
      killAllActiveProcesses();

      // Save checkpoint so run is safely resumable
      try {
        await this.saveCheckpoint();
      } catch {
        // Best effort
      }

      await this.eventLogger.close();
      await this.runLock.release();
      process.exit(130);
    };

    const syncHandler = () => {
      void handler();
    };

    process.on('SIGTERM', syncHandler);
    process.on('SIGINT', syncHandler);

    return () => {
      process.removeListener('SIGTERM', syncHandler);
      process.removeListener('SIGINT', syncHandler);
    };
  }
}

function harnessError(code: HarnessErrorCodeType, message: string): HarnessError {
  return new HarnessError(message, code, ERROR_CODE_EXIT_MAP[code] ?? 4);
}
