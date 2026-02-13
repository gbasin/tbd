/**
 * Orchestrator integration tests.
 *
 * Exercises Orchestrator.run() end-to-end with mocked backends, a simulated
 * tbd CLI, and stubbed git/worktree operations. Real temp directories are
 * used for checkpoint, events, and run-log state files.
 *
 * These tests validate the state machine transitions that the unit tests
 * (compiler.test.ts) and component integration tests (compiler-integration.test.ts)
 * cannot cover.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { createHash } from 'node:crypto';

import type {
  AgentBackend,
  AgentResult,
  JudgeBackend,
  JudgeResult,
  SpawnOptions,
  JudgeEvaluateOptions,
  Checkpoint,
} from '../src/lib/compiler/types.js';
import { CheckpointSchema, RunLogSchema } from '../src/lib/compiler/types.js';
import type { Issue } from '../src/lib/types.js';
import { CompilerError } from '../src/cli/lib/errors.js';

// =============================================================================
// Mock Backends
// =============================================================================

class MockAgentBackend implements AgentBackend {
  name = 'mock';
  results: AgentResult[] = [];
  spawnCalls: SpawnOptions[] = [];
  /** Called synchronously during spawn — use to simulate agent side effects. */
  onSpawn?: (opts: SpawnOptions) => void;

  async spawn(opts: SpawnOptions): Promise<AgentResult> {
    this.spawnCalls.push(opts);
    if (this.onSpawn) this.onSpawn(opts);
    const result = this.results.shift();
    // Stagger delays so concurrent agents resolve one at a time. This prevents
    // the AgentPool's auto-cleanup .then() handler from deleting a slot before
    // waitForAny() captures it. Each subsequent spawn gets a longer delay.
    const delay = this.spawnCalls.length * 200;
    await new Promise<void>((r) => setTimeout(r, delay));
    return result ?? { status: 'success', exitCode: 0, lastLines: '', duration: 100 };
  }
}

class MockJudgeBackend implements JudgeBackend {
  name = 'mock-judge';
  results: JudgeResult[] = [];
  evaluateCalls: JudgeEvaluateOptions[] = [];

  evaluate(opts: JudgeEvaluateOptions): Promise<JudgeResult> {
    this.evaluateCalls.push(opts);
    const result = this.results.shift();
    if (!result) {
      return Promise.resolve({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: { passed: true, results: [] },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });
    }
    return Promise.resolve(result);
  }
}

// =============================================================================
// TBD CLI Simulator
// =============================================================================

/**
 * Simulates the tbd CLI for testing. Tracks bead state and responds
 * to list/show/create/update/close/sync/label/dep commands.
 */
class TbdSimulator {
  beads = new Map<string, SimBead>();
  private nextId = 1;

  /** Pre-populate beads that will be "created by decompose agent". */
  addBead(bead: SimBead): void {
    this.beads.set(bead.id, bead);
  }

  /** Handle a tbd CLI invocation. Returns stdout. */
  handle(args: string[]): string {
    const cmd = args[0];

    if (cmd === 'list') return this.handleList(args.slice(1));
    if (cmd === 'show') return this.handleShow(args.slice(1));
    if (cmd === 'create') return this.handleCreate(args.slice(1));
    if (cmd === 'update') return this.handleUpdate(args.slice(1));
    if (cmd === 'close') return this.handleClose(args.slice(1));
    if (cmd === 'label') return this.handleLabel(args.slice(1));
    if (cmd === 'dep') return this.handleDep(args.slice(1));
    if (cmd === 'sync') return '';

    return '';
  }

  private handleList(args: string[]): string {
    let results = Array.from(this.beads.values());

    // Filter by label
    const labelArgs = args.filter((a) => a.startsWith('--label='));
    for (const la of labelArgs) {
      const label = la.replace('--label=', '');
      results = results.filter((b) => b.labels.includes(label));
    }

    // Filter by status
    const statusArg = args.find((a) => a.startsWith('--status='));
    if (statusArg) {
      const status = statusArg.replace('--status=', '');
      results = results.filter((b) => b.status === status);
    }

    if (args.includes('--json')) {
      return JSON.stringify(results.map((b) => this.toIssue(b)));
    }
    return results.map((b) => `${b.id}: ${b.title}`).join('\n');
  }

  private handleShow(args: string[]): string {
    const id = args[0];
    if (!id) return '{}';
    const bead = this.beads.get(id);
    if (!bead) return '{}';
    if (args.includes('--json')) {
      return JSON.stringify(this.toIssue(bead));
    }
    return `${bead.id}: ${bead.title} [${bead.status}]`;
  }

  private handleCreate(args: string[]): string {
    const title = args[0] ?? 'Untitled';
    const id = `is-${String(this.nextId++).padStart(26, '0')}`;
    const typeArg = args.find((a) => a.startsWith('--type='));
    const kind = typeArg ? typeArg.replace('--type=', '') : 'task';
    const labels: string[] = [];
    for (const a of args) {
      if (a.startsWith('--label=')) labels.push(a.replace('--label=', ''));
    }
    this.beads.set(id, { id, title, kind, status: 'open', labels, dependsOn: [] });
    return id;
  }

  private handleUpdate(args: string[]): string {
    const id = args[0];
    if (!id) return '';
    const bead = this.beads.get(id);
    if (!bead) return '';
    const statusArg = args.find((a) => a.startsWith('--status='));
    if (statusArg) {
      bead.status = statusArg.replace('--status=', '');
    }
    return '';
  }

  private handleClose(args: string[]): string {
    const id = args[0];
    if (!id) return '';
    const bead = this.beads.get(id);
    if (bead) bead.status = 'closed';
    return '';
  }

  private handleLabel(args: string[]): string {
    if (args[0] === 'add' && args[1] && args[2]) {
      const bead = this.beads.get(args[1]);
      if (bead) bead.labels.push(args[2]);
    }
    return '';
  }

  private handleDep(args: string[]): string {
    // `tbd dep add A B` means "A depends on B".
    // In tbd's inverted model, B gets {type: 'blocks', target: A}.
    // But for the sim we track the human-readable direction on A.
    if (args[0] === 'add' && args[1] && args[2]) {
      const bead = this.beads.get(args[1]);
      if (bead) bead.dependsOn.push(args[2]);
    }
    return '';
  }

  private toIssue(b: SimBead): Issue {
    // Convert human-readable dependsOn to tbd's inverted model.
    // "A dependsOn B" → B has {type: 'blocks', target: A}.
    // We need to find all beads that list b.id in their dependsOn
    // and add {type: 'blocks', target: theirId} here.
    const blocksDeps: { type: 'blocks'; target: string }[] = [];
    for (const [, other] of this.beads) {
      if (other.dependsOn.includes(b.id)) {
        blocksDeps.push({ type: 'blocks', target: other.id });
      }
    }

    return {
      type: 'is',
      version: 1,
      id: b.id,
      title: b.title,
      kind: b.kind as Issue['kind'],
      status: b.status as Issue['status'],
      priority: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      labels: b.labels,
      dependencies: blocksDeps,
    };
  }
}

interface SimBead {
  id: string;
  title: string;
  kind: string;
  status: string;
  labels: string[];
  /** IDs of beads this bead depends on (human-readable direction). */
  dependsOn: string[];
  description?: string;
}

// =============================================================================
// Module Mocks
// =============================================================================

// Mock backends/detect — inject our mock backends
const mockAgentBackend = new MockAgentBackend();
const mockJudgeBackend = new MockJudgeBackend();

vi.mock('../src/cli/lib/compiler/backends/detect.js', () => ({
  resolveBackendSpec: () => mockAgentBackend,
  resolveJudgeBackendSpec: () => mockJudgeBackend,
}));

// Mock worktree — avoid real git operations
vi.mock('../src/cli/lib/compiler/worktree.js', () => {
  return {
    WorktreeManager: class StubWorktreeManager {
      createIntegrationBranch(runId: string) {
        if (worktreeCreateBranchError) throw worktreeCreateBranchError;
        return `tbd-compile/${runId}`;
      }
      createAgentWorktree(_runId: string, _beadId: string, _branch: string) {
        if (worktreeAgentError) throw worktreeAgentError;
        return '/tmp/stub-worktree';
      }
      createMaintenanceWorktree() {
        return '/tmp/stub-maint-worktree';
      }
      createJudgeWorktree() {
        return '/tmp/stub-judge-worktree';
      }
      removeWorktree() {
        // no-op
      }
    },
  };
});

// Mock console-reporter — silence output
vi.mock('../src/cli/lib/compiler/console-reporter.js', () => ({
  ConsoleReporter: new Proxy(
    {},
    {
      get: () => () => {
        // no-op stub
      },
    },
  ),
}));

// Mock prompts — avoid filesystem reads
vi.mock('../src/cli/lib/compiler/prompts.js', () => ({
  loadGuidelines: () => Promise.resolve(''),
  buildCodingAgentPrompt: () => Promise.resolve('mock coding prompt'),
  buildMaintenancePrompt: () => 'mock maintenance prompt',
}));

// Mock acceptance — avoid XDG cache and agent spawn
vi.mock('../src/lib/compiler/acceptance.js', () => ({
  AcceptanceManager: class StubAcceptanceManager {
    getPath() {
      return '/tmp/stub-acceptance';
    }
    async generate(_specPath: string, spawnFn: (prompt: string) => Promise<string>) {
      if (acceptanceShouldCallCallback) {
        await spawnFn('Generate acceptance criteria for this spec.');
      }
    }
    verify() {
      // no-op
    }
  },
  acceptanceCacheDir: () => '/tmp/stub-acceptance',
}));

// Mock backends/backend — avoid killing real processes
vi.mock('../src/cli/lib/compiler/backends/backend.js', () => ({
  killAllActiveProcessesAndWait: () => Promise.resolve(),
}));

// Mock checkpoint — serialize concurrent saves to prevent race condition.
// The orchestrator fires spawnMaintenance() without awaiting it, which can cause
// concurrent saveCheckpoint() calls that race on checkpoint.yml.tmp.
vi.mock('../src/cli/lib/compiler/checkpoint.js', async (importOriginal) => {
  const mod: any = await importOriginal();

  let saveLock: Promise<void> = Promise.resolve();

  class SerialCheckpointManager extends mod.CheckpointManager {
    async save(checkpoint: Checkpoint): Promise<void> {
      const prev = saveLock;
      let resolve!: () => void;
      saveLock = new Promise((r) => {
        resolve = r;
      });
      await prev;
      try {
        await super.save(checkpoint);
      } finally {
        resolve();
      }
    }
  }

  return {
    CheckpointManager: SerialCheckpointManager,
    computeFileHash: mod.computeFileHash,
    verifySpecHash: mod.verifySpecHash,
  };
});

// =============================================================================
// child_process mock — intercept tbd and git CLI calls
// =============================================================================

let tbdSim: TbdSimulator;
let gitStatusOverride = '';
let worktreeCreateBranchError: Error | null = null;
let worktreeAgentError: Error | null = null;
let acceptanceShouldCallCallback = false;

vi.mock('node:child_process', () => {
  return {
    execFile: (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
      const cb =
        typeof optsOrCb === 'function'
          ? (optsOrCb as (err: Error | null, result: { stdout: string; stderr: string }) => void)
          : typeof maybeCb === 'function'
            ? (maybeCb as (err: Error | null, result: { stdout: string; stderr: string }) => void)
            : null;

      if (cmd === 'tbd') {
        const stdout = tbdSim.handle(args);
        if (cb) cb(null, { stdout, stderr: '' });
        return;
      }

      if (cmd === 'git') {
        // Support per-test override for git status --porcelain (judge integrity check)
        if (gitStatusOverride && args.includes('status') && args.includes('--porcelain')) {
          if (cb) cb(null, { stdout: gitStatusOverride, stderr: '' });
          return;
        }
        // Stub git calls: return empty/success for all
        if (cb) cb(null, { stdout: '', stderr: '' });
        return;
      }

      if (cmd === 'gh') {
        // Stub gh pr create
        if (cb) cb(null, { stdout: 'https://github.com/test/pr/1', stderr: '' });
        return;
      }

      // Unexpected command — error
      if (cb) cb(new Error(`Unexpected command: ${cmd}`), { stdout: '', stderr: '' });
    },
    execFileSync: (_cmd: string) => {
      // Used by detect.js isInPath — already mocked away
      return Buffer.from('');
    },
  };
});

// =============================================================================
// Import Orchestrator AFTER mocks are set up
// =============================================================================

const { Orchestrator } = await import('../src/cli/lib/compiler/orchestrator.js');
const { parseCompilerConfig } = await import('../src/lib/compiler/config.js');

// =============================================================================
// Test Helpers
// =============================================================================

let tempDir: string;

function defaultConfig(overrides?: Record<string, unknown>) {
  return parseCompilerConfig({
    agent: { backend: 'claude-code', max_concurrency: 2, max_retries_per_bead: 2 },
    target_branch: 'auto',
    worktree: { base_branch: 'main', cleanup: false },
    phases: {
      decompose: { auto: false },
      implement: { guidelines: [] },
      maintain: { trigger: 'never' },
      judge: { enabled: false, on_complete: 'none' },
    },
    acceptance: { generate: false },
    ...overrides,
  });
}

async function setupTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tbd-orch-test-'));
  // Create .tbd/compiler structure so Orchestrator can initialize
  await mkdir(join(dir, '.tbd', 'compiler'), { recursive: true });
  return dir;
}

async function createSpecFile(
  dir: string,
  content = '# Test Spec\nBuild a widget.',
): Promise<string> {
  const specPath = 'specs/test-spec.md';
  await mkdir(join(dir, 'specs'), { recursive: true });
  await writeFile(join(dir, specPath), content);
  return specPath;
}

async function readCheckpoint(dir: string): Promise<Checkpoint | null> {
  // Find the run directory
  const { readdirSync } = await import('node:fs');
  const compilerDir = join(dir, '.tbd', 'compiler');
  let runs: string[];
  try {
    runs = readdirSync(compilerDir).filter((d: string) => d.startsWith('run-'));
  } catch {
    return null;
  }
  if (runs.length === 0) return null;

  const runDir = join(compilerDir, runs.sort().reverse()[0]!);
  try {
    const content = await readFile(join(runDir, 'checkpoint.yml'), 'utf-8');
    return CheckpointSchema.parse(yamlParse(content));
  } catch {
    return null;
  }
}

async function readRunLog(dir: string) {
  const { readdirSync } = await import('node:fs');
  const compilerDir = join(dir, '.tbd', 'compiler');
  const runs = readdirSync(compilerDir)
    .filter((d: string) => d.startsWith('run-'))
    .sort()
    .reverse();
  if (runs.length === 0) return null;

  const runDir = join(compilerDir, runs[0]!);
  try {
    const content = await readFile(join(runDir, 'run-log.yml'), 'utf-8');
    return RunLogSchema.parse(yamlParse(content));
  } catch {
    return null;
  }
}

async function readEvents(dir: string): Promise<string[]> {
  const { readdirSync } = await import('node:fs');
  const compilerDir = join(dir, '.tbd', 'compiler');
  const runs = readdirSync(compilerDir)
    .filter((d: string) => d.startsWith('run-'))
    .sort()
    .reverse();
  if (runs.length === 0) return [];

  const runDir = join(compilerDir, runs[0]!);
  try {
    const content = await readFile(join(runDir, 'events.jsonl'), 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l).event as string);
  } catch {
    return [];
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Orchestrator', () => {
  beforeEach(async () => {
    tbdSim = new TbdSimulator();
    mockAgentBackend.results = [];
    mockAgentBackend.spawnCalls = [];
    mockAgentBackend.onSpawn = undefined;
    mockJudgeBackend.results = [];
    mockJudgeBackend.evaluateCalls = [];
    gitStatusOverride = '';
    worktreeCreateBranchError = null;
    worktreeAgentError = null;
    acceptanceShouldCallCallback = false;
    tempDir = await setupTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Happy path: no judge
  // ===========================================================================

  describe('happy path (judge disabled)', () => {
    it('completes a run with 2 independent beads', async () => {
      const specPath = await createSpecFile(tempDir);
      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Implement widget UI',
        kind: 'task',
        status: 'open',
        labels: [], // Labels added during decompose
        dependsOn: [],
      });
      tbdSim.addBead({
        id: 'is-00000000000000000000000002',
        title: 'Add widget tests',
        kind: 'task',
        status: 'open',
        labels: [],
        dependsOn: [],
      });

      // Pre-label beads and use existing_selector mode (avoids auto-decompose).
      const bead1 = tbdSim.beads.get('is-00000000000000000000000001')!;
      const bead2 = tbdSim.beads.get('is-00000000000000000000000002')!;
      bead1.labels.push('my-feature');
      bead2.labels.push('my-feature');

      const configWithSelector = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'my-feature' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      // Simulate agent closing in_progress beads on spawn
      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };
      // Queue results for the 2 implementation agents
      mockAgentBackend.results.push(
        { status: 'success', exitCode: 0, lastLines: '', duration: 200 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 300 },
      );

      const orchestrator = new Orchestrator({
        config: configWithSelector,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(result.totalBeads).toBe(2);
      expect(result.iterations).toBe(1);
      expect(result.message).toContain('judge disabled');

      // Verify checkpoint state
      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.state).toBe('completed');
      expect(cp!.beads.completed).toHaveLength(2);
      expect(cp!.beads.blocked).toHaveLength(0);

      // Verify events include key milestones
      const events = await readEvents(tempDir);
      expect(events).toContain('run_started');
      expect(events).toContain('phase_changed');
      expect(events).toContain('spec_frozen');
      expect(events).toContain('beads_created');
      expect(events).toContain('agent_started');
      expect(events).toContain('agent_finished');
      expect(events).toContain('bead_completed');

      // Verify run log exists (note: when judge is disabled, runLog.complete()
      // is not called — this is a known gap in the orchestrator)
      const runLog = await readRunLog(tempDir);
      expect(runLog).not.toBeNull();
    });
  });

  // ===========================================================================
  // Dry run
  // ===========================================================================

  describe('dry run', () => {
    it('returns schedule without implementing', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Step 1',
        kind: 'task',
        status: 'open',
        labels: ['plan-x'],
        dependsOn: [],
      });
      tbdSim.addBead({
        id: 'is-00000000000000000000000002',
        title: 'Step 2',
        kind: 'task',
        status: 'open',
        labels: ['plan-x'],
        dependsOn: ['is-00000000000000000000000001'],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'plan-x' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
        dryRun: true,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('dry_run');
      expect(result.totalBeads).toBe(2);
      expect(result.iterations).toBe(0);
      expect(result.schedule).toBeDefined();
      expect(result.schedule).toHaveLength(2);

      // Step 1 should come before Step 2 (dependency order)
      const ids = result.schedule!.map((s) => s.id);
      expect(ids.indexOf('is-00000000000000000000000001')).toBeLessThan(
        ids.indexOf('is-00000000000000000000000002'),
      );

      // No agents should have been spawned for implementation
      // (decompose agent skipped because we used existing_selector)
      expect(mockAgentBackend.spawnCalls).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Bead retry — agent exits 0 but bead not closed
  // ===========================================================================

  describe('bead retry', () => {
    it('retries when agent exits successfully but bead stays open', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Tricky bead',
        kind: 'task',
        status: 'open',
        labels: ['retry-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        agent: { backend: 'claude-code', max_concurrency: 1, max_retries_per_bead: 2 },
        phases: {
          decompose: { auto: false, existing_selector: 'retry-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      // First attempt: agent "succeeds" but doesn't close the bead
      // Second attempt: agent closes it
      let spawnCount = 0;
      mockAgentBackend.onSpawn = () => {
        spawnCount++;
        if (spawnCount === 2) {
          const bead = tbdSim.beads.get('is-00000000000000000000000001')!;
          bead.status = 'closed';
        }
      };

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(mockAgentBackend.spawnCalls).toHaveLength(2); // Tried twice

      // Verify retry was tracked in events
      const events = await readEvents(tempDir);
      expect(events).toContain('bead_retry');
      expect(events).toContain('bead_completed');
    });
  });

  // ===========================================================================
  // Bead blocked after max retries
  // ===========================================================================

  describe('bead blocked', () => {
    it('blocks bead after max retries exceeded', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Stubborn bead',
        kind: 'task',
        status: 'open',
        labels: ['block-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        agent: { backend: 'claude-code', max_concurrency: 1, max_retries_per_bead: 1 },
        phases: {
          decompose: { auto: false, existing_selector: 'block-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      // Agent always "succeeds" but never closes the bead — no onSpawn needed

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      // With judge disabled and all beads blocked, pipeline still "completes"
      // (the loop exits when no beads are schedulable)
      expect(result.status).toBe('completed');

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.beads.blocked).toContain('is-00000000000000000000000001');
      expect(cp!.beads.retryCounts['is-00000000000000000000000001']).toBe(2); // initial + 1 retry

      const events = await readEvents(tempDir);
      expect(events).toContain('bead_blocked');

      // Agent was spawned 2 times: initial + 1 retry
      expect(mockAgentBackend.spawnCalls).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Judge pass on first iteration
  // ===========================================================================

  describe('judge enabled', () => {
    it('completes when judge passes on first iteration', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Implement feature',
        kind: 'task',
        status: 'open',
        labels: ['judge-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'judge-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: true, on_complete: 'none', max_iterations: 3 },
        },
      });

      // Implement agent closes the bead
      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      // Judge passes
      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: {
          passed: true,
          results: [{ criterion: 'works', passed: true, evidence: 'yes' }],
        },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(result.iterations).toBe(1);
      expect(result.message).toContain('acceptance criteria passed');

      const events = await readEvents(tempDir);
      expect(events).toContain('judge_finished');

      const cp = await readCheckpoint(tempDir);
      expect(cp!.state).toBe('completed');
    });
  });

  // ===========================================================================
  // Judge fail → remediation → pass on second iteration
  // ===========================================================================

  describe('judge remediation loop', () => {
    it('creates remediation beads when judge fails, then passes on retry', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Initial implementation',
        kind: 'task',
        status: 'open',
        labels: ['loop-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'loop-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: true, on_complete: 'none', max_iterations: 3 },
        },
      });

      // Implementation agent: always closes in_progress beads
      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      // Judge iteration 1: FAIL — adds 1 remediation bead
      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: {
          detected: true,
          issues: [{ section: 'API', description: 'Missing endpoint', severity: 'major' }],
        },
        acceptance: {
          passed: false,
          results: [
            { criterion: 'API works', passed: false, evidence: 'Missing /widget endpoint' },
          ],
        },
        observations: [],
        newBeads: [
          { title: 'Add /widget endpoint', description: 'Missing API endpoint', type: 'bug' },
        ],
        lastLines: '',
        duration: 100,
      });

      // Judge iteration 2: PASS
      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: {
          passed: true,
          results: [{ criterion: 'API works', passed: true, evidence: 'All endpoints present' }],
        },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(result.iterations).toBe(2);

      // Verify remediation bead was created
      const remediationBeads = Array.from(tbdSim.beads.values()).filter((b) =>
        b.labels.includes('remediation'),
      );
      expect(remediationBeads).toHaveLength(1);
      expect(remediationBeads[0]!.title).toContain('Add /widget endpoint');

      // Verify both judge calls happened
      expect(mockJudgeBackend.evaluateCalls).toHaveLength(2);

      const cp = await readCheckpoint(tempDir);
      expect(cp!.state).toBe('completed');
      expect(cp!.iteration).toBe(2);
    });
  });

  // ===========================================================================
  // Max iterations exceeded
  // ===========================================================================

  describe('max iterations', () => {
    it('fails with E_MAX_ITERATIONS when judge always rejects', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Never-good-enough',
        kind: 'task',
        status: 'open',
        labels: ['max-iter-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'max-iter-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: true, on_complete: 'none', max_iterations: 2 },
        },
      });

      // Implement agent: always closes in_progress beads
      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      // Judge always fails
      const failResult: JudgeResult = {
        status: 'success',
        specDrift: {
          detected: true,
          issues: [{ section: 'All', description: 'Not good enough', severity: 'critical' }],
        },
        acceptance: { passed: false, results: [] },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      };
      mockJudgeBackend.results.push({ ...failResult }, { ...failResult });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).message).toMatch(/Max iterations/i);
      }

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.state).toBe('failed');
    });
  });

  // ===========================================================================
  // No spec provided
  // ===========================================================================

  describe('error handling', () => {
    it('throws E_SPEC_NOT_FOUND when no spec path given', async () => {
      const config = defaultConfig();

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
      });

      await expect(orchestrator.run()).rejects.toThrow(CompilerError);
    });

    it('throws E_SPEC_NOT_FOUND when spec file does not exist', async () => {
      const config = defaultConfig();

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath: 'specs/nonexistent.md',
      });

      await expect(orchestrator.run()).rejects.toThrow(CompilerError);
    });

    it('throws E_BEAD_SCOPE_AMBIGUOUS when existing_selector finds no beads', async () => {
      const specPath = await createSpecFile(tempDir);
      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'nonexistent-label' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      await expect(orchestrator.run()).rejects.toThrow(CompilerError);
    });
  });

  // ===========================================================================
  // Dependency ordering
  // ===========================================================================

  describe('dependency ordering', () => {
    it('implements beads in dependency order', async () => {
      const specPath = await createSpecFile(tempDir);

      // B depends on A — A must be implemented first
      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'A: Foundation',
        kind: 'task',
        status: 'open',
        labels: ['dep-test'],
        dependsOn: [],
      });
      tbdSim.addBead({
        id: 'is-00000000000000000000000002',
        title: 'B: Depends on A',
        kind: 'task',
        status: 'open',
        labels: ['dep-test'],
        dependsOn: ['is-00000000000000000000000001'],
      });

      const config = defaultConfig({
        agent: { backend: 'claude-code', max_concurrency: 2 },
        phases: {
          decompose: { auto: false, existing_selector: 'dep-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      const implementOrder: string[] = [];
      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') {
            implementOrder.push(bead.id);
            bead.status = 'closed';
          }
        }
      };

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      // A must be scheduled before B
      expect(implementOrder.indexOf('is-00000000000000000000000001')).toBeLessThan(
        implementOrder.indexOf('is-00000000000000000000000002'),
      );
    });
  });

  // ===========================================================================
  // Checkpoint persistence
  // ===========================================================================

  describe('checkpoint persistence', () => {
    it('writes valid checkpoint YAML after each phase', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Single bead',
        kind: 'task',
        status: 'open',
        labels: ['cp-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'cp-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      await orchestrator.run();

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.schemaVersion).toBe(1);
      expect(cp!.runId).toMatch(/^run-\d{4}-\d{2}-\d{2}-\w+$/);
      expect(cp!.specPath).toBe(specPath);
      expect(cp!.frozenSpecPath).toContain('frozen-spec.md');
      expect(cp!.frozenSpecSha256).toHaveLength(64);
      expect(cp!.targetBranch).toMatch(/^tbd-compile\//);
      expect(cp!.baseBranch).toBe('main');
      expect(cp!.state).toBe('completed');
      expect(cp!.beads.completed).toContain('is-00000000000000000000000001');
    });
  });

  // ===========================================================================
  // Frozen spec hash
  // ===========================================================================

  describe('spec freezing', () => {
    it('creates a frozen copy with SHA-256 hash', async () => {
      const specContent = '# My Spec\n\nBuild something great.';
      const specPath = await createSpecFile(tempDir, specContent);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Build it',
        kind: 'task',
        status: 'open',
        labels: ['freeze-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'freeze-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      await orchestrator.run();

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();

      // Verify frozen spec exists and matches original
      const frozenContent = await readFile(join(tempDir, cp!.frozenSpecPath), 'utf-8');
      expect(frozenContent).toBe(specContent);

      // Verify hash is a valid SHA-256 hex string
      expect(cp!.frozenSpecSha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ===========================================================================
  // Resume: no runs exist
  // ===========================================================================

  describe('resume: no runs exist', () => {
    it('throws E_CHECKPOINT_CORRUPT when no run directory exists', async () => {
      const specPath = await createSpecFile(tempDir);
      const config = defaultConfig();

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
        resume: true,
      });

      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).code).toBe('E_CHECKPOINT_CORRUPT');
        expect((err as CompilerError).message).toMatch(/No compiler runs found/i);
      }
    });
  });

  // ===========================================================================
  // Resume: already-completed run
  // ===========================================================================

  describe('resume: already-completed run', () => {
    it('throws E_CHECKPOINT_CORRUPT when most recent run is already completed', async () => {
      const runId = 'run-2026-01-15-abc12';
      const runDir = join(tempDir, '.tbd', 'compiler', runId);
      await mkdir(runDir, { recursive: true });

      const specPath = await createSpecFile(tempDir);
      const frozenContent = '# Frozen Spec\nBuild a widget.';
      const frozenSpecRelPath = join('.tbd', 'compiler', runId, 'frozen-spec.md');
      await writeFile(join(tempDir, frozenSpecRelPath), frozenContent);
      const frozenHash = createHash('sha256').update(frozenContent).digest('hex');

      const checkpoint: Checkpoint = {
        schemaVersion: 1,
        runId,
        specPath,
        frozenSpecPath: frozenSpecRelPath,
        frozenSpecSha256: frozenHash,
        targetBranch: `tbd-compile/${runId}`,
        baseBranch: 'main',
        state: 'completed',
        iteration: 1,
        beads: {
          total: 1,
          completed: ['is-00000000000000000000000001'],
          inProgress: [],
          blocked: [],
          retryCounts: {},
          claims: {},
        },
        agents: { maxConcurrency: 2, active: [] },
        maintenance: { runCount: 0, runs: [] },
        observations: { pending: [], promoted: [], dismissed: [] },
      };

      await writeFile(join(runDir, 'checkpoint.yml'), yamlStringify(checkpoint));

      const config = defaultConfig();
      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
        resume: true,
      });

      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).code).toBe('E_CHECKPOINT_CORRUPT');
        expect((err as CompilerError).message).toMatch(/already completed/i);
      }
    });
  });

  // ===========================================================================
  // Resume: reconciles stale in-progress beads
  // ===========================================================================

  describe('resume: reconciles stale in-progress beads', () => {
    it('increments retryCounts, clears claims, resets beads to open', async () => {
      const beadId = 'is-00000000000000000000000001';
      const runId = 'run-2026-01-15-recon';
      const runDir = join(tempDir, '.tbd', 'compiler', runId);
      await mkdir(runDir, { recursive: true });

      const specPath = await createSpecFile(tempDir);
      const frozenContent = '# Frozen Spec\nBuild a widget.';
      const frozenSpecRelPath = join('.tbd', 'compiler', runId, 'frozen-spec.md');
      await writeFile(join(tempDir, frozenSpecRelPath), frozenContent);
      const frozenHash = createHash('sha256').update(frozenContent).digest('hex');

      const checkpoint: Checkpoint = {
        schemaVersion: 1,
        runId,
        specPath,
        frozenSpecPath: frozenSpecRelPath,
        frozenSpecSha256: frozenHash,
        targetBranch: `tbd-compile/${runId}`,
        baseBranch: 'main',
        state: 'implementing',
        iteration: 1,
        beads: {
          total: 1,
          completed: [],
          inProgress: [beadId],
          blocked: [],
          retryCounts: {},
          claims: { [beadId]: 'run:1:1' },
        },
        agents: { maxConcurrency: 2, active: [] },
        maintenance: { runCount: 0, runs: [] },
        observations: { pending: [], promoted: [], dismissed: [] },
      };

      await writeFile(join(runDir, 'checkpoint.yml'), yamlStringify(checkpoint));
      await writeFile(
        join(runDir, 'events.jsonl'),
        '{"v":1,"ts":"2026-01-15T00:00:00.000Z","event":"run_started"}\n',
      );

      const runLog = {
        runId,
        spec: specPath,
        startedAt: '2026-01-15T00:00:00.000Z',
        status: 'in_progress',
        targetBranch: `tbd-compile/${runId}`,
        iterations: [],
      };
      await writeFile(join(runDir, 'run-log.yml'), yamlStringify(runLog));

      tbdSim.addBead({
        id: beadId,
        title: 'Stale bead',
        kind: 'task',
        status: 'in_progress',
        labels: [`compiler-run:${runId}`],
        dependsOn: [],
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: `compiler-run:${runId}` },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
        resume: true,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.state).toBe('completed');
      expect(cp!.beads.completed).toContain(beadId);
      expect(cp!.beads.inProgress).toHaveLength(0);
      // After reconciliation the old claim is cleared, but the resumed implement
      // phase creates a new claim when spawning the agent. The important thing is
      // the bead completed and retry count was incremented.
      expect(cp!.beads.retryCounts[beadId]).toBeGreaterThanOrEqual(1);

      const events = await readEvents(tempDir);
      expect(events).toContain('run_resumed');
    });
  });

  // ===========================================================================
  // Auto-decompose
  // ===========================================================================

  describe('auto-decompose', () => {
    it('spawns decompose agent then implementation agents', async () => {
      const specPath = await createSpecFile(tempDir);

      const config = defaultConfig({
        phases: {
          decompose: { auto: true },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      let spawnCount = 0;
      mockAgentBackend.onSpawn = (opts: SpawnOptions) => {
        spawnCount++;
        if (spawnCount === 1) {
          // First spawn is the decompose agent — create beads with the run label
          const match = /compiler-run:(run-[\w-]+)/.exec(opts.prompt);
          const runLabel = match ? `compiler-run:${match[1]}` : 'compiler-run:unknown';
          tbdSim.addBead({
            id: 'is-00000000000000000000000001',
            title: 'Decomposed task 1',
            kind: 'task',
            status: 'open',
            labels: [runLabel],
            dependsOn: [],
          });
          tbdSim.addBead({
            id: 'is-00000000000000000000000002',
            title: 'Decomposed task 2',
            kind: 'task',
            status: 'open',
            labels: [runLabel],
            dependsOn: [],
          });
        } else {
          // Implementation agents — close in_progress beads
          for (const [, bead] of tbdSim.beads) {
            if (bead.status === 'in_progress') bead.status = 'closed';
          }
        }
      };

      mockAgentBackend.results.push(
        { status: 'success', exitCode: 0, lastLines: '', duration: 100 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 200 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 300 },
      );

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(result.totalBeads).toBe(2);
      expect(mockAgentBackend.spawnCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('throws when decompose agent fails', async () => {
      const specPath = await createSpecFile(tempDir);

      const config = defaultConfig({
        phases: {
          decompose: { auto: true },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      mockAgentBackend.results.push({
        status: 'failure',
        exitCode: 1,
        lastLines: 'agent crashed',
        duration: 50,
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).message).toMatch(/Decomposition agent failed/i);
      }
    });
  });

  // ===========================================================================
  // Open beads guard
  // ===========================================================================

  describe('open beads guard', () => {
    it('throws E_BEAD_SCOPE_AMBIGUOUS when open beads exist but no selector', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Stray bead',
        kind: 'task',
        status: 'open',
        labels: [],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).message).toMatch(/open bead/i);
      }
    });
  });

  // ===========================================================================
  // Maintenance trigger: after_all
  // ===========================================================================

  describe('maintenance trigger: after_all', () => {
    it('spawns maintenance agent after all beads complete', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Single bead',
        kind: 'task',
        status: 'open',
        labels: ['maint-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'maint-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'after_all' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      mockAgentBackend.results.push(
        { status: 'success', exitCode: 0, lastLines: '', duration: 200 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 100 },
      );

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(mockAgentBackend.spawnCalls).toHaveLength(2);

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.maintenance.runCount).toBe(1);

      const events = await readEvents(tempDir);
      expect(events).toContain('maintenance_started');
      expect(events).toContain('maintenance_finished');
    });
  });

  // ===========================================================================
  // Maintenance trigger: every_n_beads
  // ===========================================================================

  describe('maintenance trigger: every_n_beads', () => {
    it('runs maintenance after each bead completion when n=1', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Bead A',
        kind: 'task',
        status: 'open',
        labels: ['maint-n-test'],
        dependsOn: [],
      });
      tbdSim.addBead({
        id: 'is-00000000000000000000000002',
        title: 'Bead B',
        kind: 'task',
        status: 'open',
        labels: ['maint-n-test'],
        dependsOn: ['is-00000000000000000000000001'],
      });

      const config = defaultConfig({
        agent: { backend: 'claude-code', max_concurrency: 1 },
        phases: {
          decompose: { auto: false, existing_selector: 'maint-n-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'every_n_beads', n: 1 },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      mockAgentBackend.results.push(
        { status: 'success', exitCode: 0, lastLines: '', duration: 200 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 50 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 200 },
        { status: 'success', exitCode: 0, lastLines: '', duration: 50 },
      );

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(mockAgentBackend.spawnCalls).toHaveLength(4);

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.maintenance.runCount).toBe(2);

      const events = await readEvents(tempDir);
      const maintStarted = events.filter((e) => e === 'maintenance_started');
      expect(maintStarted).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Judge on_complete: 'pr'
  // ===========================================================================

  describe('judge on_complete: pr', () => {
    it('creates PR when judge passes and on_complete is pr', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Implement feature',
        kind: 'task',
        status: 'open',
        labels: ['pr-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        target_branch: 'auto',
        phases: {
          decompose: { auto: false, existing_selector: 'pr-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: true, on_complete: 'pr', max_iterations: 3 },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: {
          passed: true,
          results: [{ criterion: 'works', passed: true, evidence: 'verified' }],
        },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(result.message).toContain('acceptance criteria passed');

      const events = await readEvents(tempDir);
      expect(events).toContain('pr_created');
    });
  });

  // ===========================================================================
  // Judge integrity check: modified files detected
  // ===========================================================================

  describe('judge integrity check', () => {
    it('synthesizes failure when judge worktree has modified files', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Implement feature',
        kind: 'task',
        status: 'open',
        labels: ['integrity-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'integrity-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: true, on_complete: 'none', max_iterations: 1 },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      // Judge returns passing, but integrity check will override
      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: {
          passed: true,
          results: [{ criterion: 'works', passed: true, evidence: 'yes' }],
        },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });

      // Override git status --porcelain to return modified files
      gitStatusOverride = ' M src/tampered.ts';

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      // With max_iterations: 1 and synthesized failure, triggers E_MAX_ITERATIONS
      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).message).toMatch(/Max iterations/i);
      }

      const events = await readEvents(tempDir);
      expect(events).toContain('judge_integrity_violation');

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.state).toBe('failed');
    });
  });

  // ===========================================================================
  // Judge observation handling: promote, dismiss, merge
  // ===========================================================================

  describe('judge observation handling', () => {
    it('processes promote, dismiss, and merge observation actions', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Implement feature',
        kind: 'task',
        status: 'open',
        labels: ['obs-test'],
        dependsOn: [],
      });

      tbdSim.addBead({
        id: 'obs-1',
        title: 'Observation: important finding',
        kind: 'task',
        status: 'open',
        labels: ['observation'],
        dependsOn: [],
      });
      tbdSim.addBead({
        id: 'obs-2',
        title: 'Observation: not needed',
        kind: 'task',
        status: 'open',
        labels: ['observation'],
        dependsOn: [],
      });
      tbdSim.addBead({
        id: 'obs-3',
        title: 'Observation: duplicate',
        kind: 'task',
        status: 'open',
        labels: ['observation'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'obs-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: true, on_complete: 'none', max_iterations: 3 },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      // First judge: FAIL with all 3 observation actions
      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: {
          passed: false,
          results: [{ criterion: 'feature complete', passed: false, evidence: 'missing parts' }],
        },
        observations: [
          { beadId: 'obs-1', action: 'promote', reason: 'important' },
          { beadId: 'obs-2', action: 'dismiss', reason: 'not needed' },
          {
            beadId: 'obs-3',
            action: 'merge',
            mergeWith: 'is-00000000000000000000000001',
            reason: 'duplicate',
          },
        ],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });

      // Second judge: PASS
      mockJudgeBackend.results.push({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        acceptance: {
          passed: true,
          results: [{ criterion: 'feature complete', passed: true, evidence: 'all parts present' }],
        },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 100,
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(result.iterations).toBe(2);

      expect(tbdSim.beads.get('obs-1')!.status).toBe('closed');
      expect(tbdSim.beads.get('obs-2')!.status).toBe('closed');
      expect(tbdSim.beads.get('obs-3')!.status).toBe('closed');

      const promotedBeads = Array.from(tbdSim.beads.values()).filter((b) =>
        b.labels.includes('promoted-observation'),
      );
      expect(promotedBeads).toHaveLength(1);

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.observations.promoted).toContain('obs-1');
      expect(cp!.observations.dismissed).toContain('obs-2');
      expect(cp!.observations.dismissed).toContain('obs-3');
    });
  });

  // ===========================================================================
  // Non-CompilerError wrapping
  // ===========================================================================

  describe('non-CompilerError wrapping', () => {
    it('wraps non-CompilerError as E_CONFIG_INVALID', async () => {
      const specPath = await createSpecFile(tempDir);
      // Trigger a plain Error during implement (inside executePipeline's
      // try/finally) so the event logger's fd is properly closed.
      worktreeAgentError = new Error('git worktree command failed unexpectedly');

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Trigger agent worktree error',
        kind: 'task',
        status: 'open',
        labels: ['wrap-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        phases: {
          decompose: { auto: false, existing_selector: 'wrap-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      try {
        await orchestrator.run();
        expect.fail('Expected CompilerError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompilerError);
        expect((err as CompilerError).code).toBe('E_CONFIG_INVALID');
        expect((err as CompilerError).message).toContain(
          'git worktree command failed unexpectedly',
        );
      }
    });
  });

  // ===========================================================================
  // Acceptance generation
  // ===========================================================================

  describe('acceptance generation', () => {
    it('spawns agent for acceptance criteria generation before implement', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Build widget',
        kind: 'task',
        status: 'open',
        labels: ['accept-gen-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        acceptance: { generate: true },
        phases: {
          decompose: { auto: false, existing_selector: 'accept-gen-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      acceptanceShouldCallCallback = true;

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(mockAgentBackend.spawnCalls).toHaveLength(2);
      expect(mockAgentBackend.spawnCalls[0]!.workdir).toBe(tempDir);
      expect(mockAgentBackend.spawnCalls[0]!.outputFormat).toBe('text');

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.acceptancePath).toBe('/tmp/stub-acceptance');
    });
  });

  // ===========================================================================
  // Acceptance explicit path
  // ===========================================================================

  describe('acceptance explicit path', () => {
    it('sets checkpoint.acceptancePath from config.acceptance.path', async () => {
      const specPath = await createSpecFile(tempDir);

      tbdSim.addBead({
        id: 'is-00000000000000000000000001',
        title: 'Build widget',
        kind: 'task',
        status: 'open',
        labels: ['accept-path-test'],
        dependsOn: [],
      });

      const config = defaultConfig({
        acceptance: { generate: false, path: '/custom/acceptance.md' },
        phases: {
          decompose: { auto: false, existing_selector: 'accept-path-test' },
          implement: { guidelines: [] },
          maintain: { trigger: 'never' },
          judge: { enabled: false, on_complete: 'none' },
        },
      });

      mockAgentBackend.onSpawn = () => {
        for (const [, bead] of tbdSim.beads) {
          if (bead.status === 'in_progress') bead.status = 'closed';
        }
      };

      const orchestrator = new Orchestrator({
        config,
        tbdRoot: tempDir,
        specPath,
      });

      const result = await orchestrator.run();

      expect(result.status).toBe('completed');
      expect(mockAgentBackend.spawnCalls).toHaveLength(1);

      const cp = await readCheckpoint(tempDir);
      expect(cp).not.toBeNull();
      expect(cp!.acceptancePath).toBe('/custom/acceptance.md');
    });
  });
});
