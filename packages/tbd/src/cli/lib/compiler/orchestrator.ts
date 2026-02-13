/**
 * Main orchestrator state machine for tbd compile.
 *
 * Composes all compiler components:
 * freeze → decompose → implement → maintain → judge → (loop or done)
 */

import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CompilerConfig } from '../../../lib/compiler/config.js';
import { getBeadTimeoutMs } from '../../../lib/compiler/config.js';
import type { Checkpoint, AgentResult, JudgeResult } from '../../../lib/compiler/types.js';
import type { Issue } from '../../../lib/types.js';
import { ERROR_CODE_EXIT_MAP } from '../../../lib/compiler/types.js';
import type { CompilerErrorCodeType } from '../../../lib/compiler/types.js';
import { AcceptanceManager } from '../../../lib/compiler/acceptance.js';
import { compilerRunDir } from '../../../lib/paths.js';
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
import { CompilerError } from '../errors.js';
import { ConsoleReporter } from './console-reporter.js';

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
  config: CompilerConfig;
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
  private readonly config: CompilerConfig;
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
  private tbdMutex = Promise.resolve();

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
      if (error instanceof CompilerError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      throw new CompilerError(message, 'E_CONFIG_INVALID', 2);
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private async startFresh(): Promise<void> {
    if (!this.opts.specPath) {
      throw compilerError('E_SPEC_NOT_FOUND', 'No spec path provided. Use --spec <path>');
    }

    // Verify spec exists
    try {
      await readFile(join(this.tbdRoot, this.opts.specPath));
    } catch {
      throw compilerError('E_SPEC_NOT_FOUND', `Spec file not found: ${this.opts.specPath}`);
    }

    this.runId = generateRunId();
    this.runDir = join(this.tbdRoot, compilerRunDir(this.runId));

    // Create state directory
    await mkdir(this.runDir, { recursive: true });

    this.checkpointMgr = new CheckpointManager(this.runDir);
    this.eventLogger = new EventLogger(join(this.runDir, 'events.jsonl'));
    await this.eventLogger.open();
    this.runLock = new RunLock(this.runDir, this.runId);
    await this.runLock.acquire();

    this.eventLogger.emit({ event: 'run_started', run_id: this.runId, spec: this.opts.specPath });
    ConsoleReporter.runStarted(this.runId, this.opts.specPath);

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
    const compilerDir = join(this.tbdRoot, '.tbd', 'compiler');
    let runDirs: string[];
    try {
      runDirs = readdirSync(compilerDir)
        .filter((d: string) => d.startsWith('run-'))
        .sort()
        .reverse();
    } catch {
      throw compilerError('E_CHECKPOINT_CORRUPT', 'No compiler runs found to resume');
    }

    if (runDirs.length === 0) {
      throw compilerError('E_CHECKPOINT_CORRUPT', 'No compiler runs found to resume');
    }

    this.runId = runDirs[0]!;
    this.runDir = join(compilerDir, this.runId);
    this.checkpointMgr = new CheckpointManager(this.runDir);
    this.checkpoint = await this.checkpointMgr.load();

    // Reject resume of already-terminal runs
    if (this.checkpoint.state === 'completed' || this.checkpoint.state === 'failed') {
      throw compilerError(
        'E_CHECKPOINT_CORRUPT',
        `Most recent run (${this.runId}) is already ${this.checkpoint.state}. Nothing to resume.`,
      );
    }

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

    // Reconcile in-progress beads: they were interrupted by the previous crash/signal.
    // Reset them to open so they can be rescheduled.
    if (this.checkpoint.beads.inProgress.length > 0) {
      for (const beadId of this.checkpoint.beads.inProgress) {
        await this.tbdExecSafe(['update', beadId, '--status=open']);
      }
      this.checkpoint.beads.inProgress = [];
      this.checkpoint.agents.active = [];
      await this.saveCheckpoint();
    }

    // Verify acceptance criteria still exist
    if (this.checkpoint.acceptancePath) {
      const acceptance = new AcceptanceManager(this.runId);
      try {
        await acceptance.verify();
      } catch {
        throw compilerError(
          'E_ACCEPTANCE_MISSING',
          `Acceptance criteria cache was cleared for run ${this.runId}. ` +
            'Cannot regenerate mid-run. Re-run from scratch with: tbd compile --spec <path>',
        );
      }
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
    ConsoleReporter.runResumed(this.runId, this.checkpoint.state);
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

        // Record judge results in run-log
        this.runLog.updateIteration({
          judgeResult: {
            specDrift: judgeResult.specDrift.detected ? 'detected' : 'none',
            acceptance: judgeResult.acceptance.passed ? 'passed' : 'failed',
            observationsPromoted: judgeResult.observations.filter((o) => o.action === 'promote')
              .length,
            observationsDismissed: judgeResult.observations.filter((o) => o.action === 'dismiss')
              .length,
            newBeadsCreated: judgeResult.newBeads.length,
            issues: judgeResult.specDrift.issues,
          },
        });
        await this.runLog.flush();

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
          ConsoleReporter.runCompleted(this.checkpoint.beads.total, this.checkpoint.iteration);

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
    ConsoleReporter.runFailed(`max iterations (${maxIterations}) reached`);

    throw compilerError(
      'E_MAX_ITERATIONS',
      `Max iterations (${maxIterations}) reached. Some acceptance criteria still failing.`,
    );
  }

  // ===========================================================================
  // Phase 1: Freeze
  // ===========================================================================

  private async freeze(): Promise<void> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'freeze' });
    ConsoleReporter.phaseStarted('freeze');
    this.checkpoint.state = 'freezing';

    const frozenPath = join(compilerRunDir(this.runId), 'frozen-spec.md');
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
          outputFormat: 'text', // Acceptance criteria are markdown, not JSON
        });
        return result.lastLines;
      });
      this.checkpoint.acceptancePath = acceptance.getPath();
      ConsoleReporter.acceptanceGenerated();
    } else if (this.config.acceptance.path) {
      this.checkpoint.acceptancePath = this.config.acceptance.path;
    }

    await this.saveCheckpoint();
    this.eventLogger.emit({ event: 'spec_frozen', hash });
    ConsoleReporter.specFrozen(hash);
  }

  // ===========================================================================
  // Phase 2: Decompose
  // ===========================================================================

  private async decompose(): Promise<void> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'decompose' });
    ConsoleReporter.phaseStarted('decompose');
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
        throw compilerError(
          'E_BEAD_SCOPE_AMBIGUOUS',
          `No open beads found with label: ${beadLabel}`,
        );
      }

      // Add compiler-run label to existing beads
      for (const bead of beads) {
        await this.tbdExecStrict(['label', 'add', bead.id, `compiler-run:${this.runId}`]);
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
   - \`tbd create "<title>" --type=task --label=compiler-run:${this.runId}\`
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
        throw compilerError(
          'E_DEADLOCK',
          `Decomposition agent failed: ${result.lastLines.slice(-200)}`,
        );
      }

      // Count created beads
      const stdout = await this.tbdExecSafe([
        'list',
        `--label=compiler-run:${this.runId}`,
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
    ConsoleReporter.beadsCreated(this.checkpoint.beads.total);

    this.runLog.startIteration(this.checkpoint.iteration);
    this.runLog.updateIteration({ beadsTotal: this.checkpoint.beads.total });
    await this.runLog.flush();
  }

  // ===========================================================================
  // Phase 3: Implement
  // ===========================================================================

  private async implement(): Promise<void> {
    this.eventLogger.emit({ event: 'phase_changed', phase: 'implement' });
    ConsoleReporter.phaseStarted('implement', this.checkpoint.iteration);
    this.checkpoint.state = 'implementing';

    const backend = createAgentBackend(this.config.agent.backend, this.config.agent.command);
    const pool = new AgentPool(backend, this.config.agent.max_concurrency);
    const guidelines = await loadGuidelines(this.tbdRoot, this.config.phases.implement.guidelines);
    const timeout = getBeadTimeoutMs(this.config);

    // Get all run beads AND their external blockers for correct graph construction
    const runBeadStdout = await this.tbdExecSafe([
      'list',
      `--label=compiler-run:${this.runId}`,
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
      throw compilerError('E_GRAPH_CYCLE', `Dependency cycles detected: ${JSON.stringify(cycles)}`);
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

        // Update bead status and sync so claim is persisted
        await this.tbdExecSafe(['update', nextBead.id, '--status=in_progress']);
        await this.tbdExecSafe(['sync']);

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

        // Resolve bead dependency info for the prompt
        const depIds = scheduler.getDependencyIds(nextBead.id);
        const beadDependencies = depIds
          .map((id) => {
            const dep = scheduler.getIssue(id);
            return dep ? `- ${dep.title} (${id})` : `- ${id}`;
          })
          .join('\n');

        // Build prompt
        const prompt = await buildCodingAgentPrompt({
          beadId: nextBead.id,
          beadTitle: nextBead.title,
          beadDescription: nextBead.description ?? '',
          beadType: nextBead.kind,
          beadPriority: nextBead.priority,
          beadDependencies: beadDependencies || 'None',
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
            TBD_COMPILER_RUN_ID: this.runId,
            TBD_COMPILER_TARGET_BRANCH: this.checkpoint.targetBranch,
          },
        });

        this.totalAgentSpawns++;
        this.eventLogger.emit({
          event: 'agent_started',
          bead_id: nextBead.id,
        });
        ConsoleReporter.agentStarted(nextBead.id, nextBead.title);
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
            throw compilerError('E_EXTERNAL_BLOCKED', external.chains.join('\n'));
          }
          throw compilerError('E_DEADLOCK', deadlock.reason);
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
      ConsoleReporter.agentFinished(slot.beadId, result.status, result.duration);

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
      ConsoleReporter.beadCompleted(beadId);
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
      ConsoleReporter.beadBlocked(beadId, 'max retries exceeded');
    } else {
      // Reset to open for retry (worktree will be cleaned up on next assignment)
      await this.tbdExecSafe(['update', beadId, '--status=open']);
      this.eventLogger.emit({
        event: 'bead_retry',
        bead_id: beadId,
        retry: retryCount,
        failure_mode: result.status,
      });
      ConsoleReporter.beadRetry(beadId, retryCount);
    }
  }

  // ===========================================================================
  // Phase 4: Maintain
  // ===========================================================================

  private async spawnMaintenance(index: number): Promise<void> {
    this.eventLogger.emit({ event: 'maintenance_started', index });
    ConsoleReporter.maintenanceStarted(index);

    // Create a maintenance bead for tracking
    const maintBeadId = await this.tbdExecSafe([
      'create',
      `Maintenance run #${index}`,
      '--type=task',
      `--label=compiler-run:${this.runId}`,
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
        TBD_COMPILER_RUN_ID: this.runId,
        TBD_COMPILER_TARGET_BRANCH: this.checkpoint.targetBranch,
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
    ConsoleReporter.maintenanceFinished(index, result.status, result.duration);

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
    ConsoleReporter.phaseStarted('judge', this.checkpoint.iteration);
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
        TBD_COMPILER_RUN_ID: this.runId,
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

    const judgePassed = result.acceptance.passed && !result.specDrift.detected;
    this.eventLogger.emit({
      event: 'judge_finished',
      iteration: this.checkpoint.iteration,
      verdict: judgePassed ? 'pass' : 'fail',
      new_beads: result.newBeads.length,
    });
    ConsoleReporter.judgeVerdict(this.checkpoint.iteration, judgePassed, result.newBeads.length);

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
    // Create beads from judge findings (with descriptions)
    for (const bead of judgeResult.newBeads) {
      const createResult = await this.tbdExecSafe([
        'create',
        `${bead.title}: ${bead.description}`,
        `--type=${bead.type}`,
        `--label=compiler-run:${this.runId}`,
        `--label=remediation`,
      ]);
      if (createResult) this.checkpoint.beads.total++;
    }

    // Handle observation beads
    for (const obs of judgeResult.observations) {
      if (obs.action === 'promote') {
        this.checkpoint.observations.promoted.push(obs.beadId);
        // Create an implementation bead from the promoted observation
        const createResult = await this.tbdExecSafe([
          'create',
          `Promoted: ${obs.reason}`,
          '--type=task',
          `--label=compiler-run:${this.runId}`,
          '--label=promoted-observation',
        ]);
        if (createResult) this.checkpoint.beads.total++;
        // Close the observation bead
        await this.tbdExecSafe(['close', obs.beadId, `--reason=Promoted to implementation bead`]);
      } else if (obs.action === 'dismiss') {
        this.checkpoint.observations.dismissed.push(obs.beadId);
        await this.tbdExecSafe(['close', obs.beadId, `--reason=Dismissed by judge: ${obs.reason}`]);
      } else if (obs.action === 'merge' && obs.mergeWith) {
        // Merge: close observation, reference the target finding
        this.checkpoint.observations.dismissed.push(obs.beadId);
        await this.tbdExecSafe([
          'close',
          obs.beadId,
          `--reason=Merged with ${obs.mergeWith}: ${obs.reason}`,
        ]);
      }
    }

    this.eventLogger.emit({
      event: 'remediation_created',
      new_beads: judgeResult.newBeads.length,
      promoted: judgeResult.observations.filter((o) => o.action === 'promote').length,
      dismissed: judgeResult.observations.filter((o) => o.action === 'dismiss').length,
    });

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
      ConsoleReporter.prCreated(stdout.trim());
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
   * Serialize tbd CLI calls to prevent concurrent file-system corruption.
   * tbd uses file-based storage, so parallel CLI invocations can corrupt data.
   */
  private async withTbdLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.tbdMutex;
    this.tbdMutex = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Execute a tbd CLI command. Throws on failure.
   * Use for operations where failure is an error (label, list during decompose).
   */
  private async tbdExecStrict(args: string[]): Promise<string> {
    return this.withTbdLock(async () => {
      try {
        const { stdout } = await execFileAsync('tbd', args, { cwd: this.tbdRoot });
        return stdout;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.eventLogger.emit({ event: 'tbd_command_error', args, error: msg });
        throw compilerError(
          'E_CONFIG_INVALID',
          `tbd command failed: tbd ${args.join(' ')}\n${msg}`,
        );
      }
    });
  }

  /**
   * Execute a tbd CLI command. Logs errors but does not throw.
   * Use for best-effort operations (status updates, listing).
   */
  private async tbdExecSafe(args: string[]): Promise<string> {
    return this.withTbdLock(async () => {
      try {
        const { stdout } = await execFileAsync('tbd', args, { cwd: this.tbdRoot });
        return stdout;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.eventLogger.emit({ event: 'tbd_command_error', args, error: msg });
        return '';
      }
    });
  }

  private async listRunBeads(): Promise<Issue[]> {
    try {
      const stdout = await this.tbdExecSafe([
        'list',
        `--label=compiler-run:${this.runId}`,
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
        `--label=compiler-run:${this.runId}`,
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
      ConsoleReporter.runInterrupted();

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

function compilerError(code: CompilerErrorCodeType, message: string): CompilerError {
  return new CompilerError(message, code, ERROR_CODE_EXIT_MAP[code] ?? 4);
}
