/**
 * Integration tests for the compiler orchestrator components.
 *
 * Tests CheckpointManager, EventLogger, RunLock, AgentPool, and Scheduler
 * working together with mocked backends and real temp directories.
 * Does NOT test the full Orchestrator (which requires git/tbd CLI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CheckpointManager,
  computeFileHash,
  verifySpecHash,
} from '../src/cli/lib/compiler/checkpoint.js';
import { EventLogger } from '../src/cli/lib/compiler/events.js';
import { RunLock } from '../src/cli/lib/compiler/run-lock.js';
import { Scheduler } from '../src/cli/lib/compiler/scheduler.js';
import { AgentPool } from '../src/cli/lib/compiler/agent-pool.js';
import type {
  Checkpoint,
  AgentBackend,
  AgentResult,
  SpawnOptions,
} from '../src/lib/compiler/types.js';
import type { Issue } from '../src/lib/types.js';
import { CompilerError } from '../src/cli/lib/errors.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Mock agent backend that returns pre-configured results.
 * Records every spawn call for assertion.
 */
class MockAgentBackend implements AgentBackend {
  name = 'mock';
  results: AgentResult[] = [];
  spawnCalls: SpawnOptions[] = [];

  constructor(results?: AgentResult[]) {
    this.results = results ?? [];
  }

  spawn(opts: SpawnOptions): Promise<AgentResult> {
    this.spawnCalls.push(opts);
    const result = this.results.shift();
    return Promise.resolve(
      result ?? { status: 'success', exitCode: 0, lastLines: '', duration: 1000 },
    );
  }
}

/** Create a minimal valid Issue for testing. */
function makeIssue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    type: 'is',
    version: 1,
    title: overrides.id,
    kind: 'task',
    status: 'open',
    priority: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    labels: [],
    dependencies: [],
    ...overrides,
  };
}

/** Create a valid Checkpoint object for testing. */
function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    schemaVersion: 1,
    runId: 'run-test-001',
    specPath: 'specs/test-spec.md',
    frozenSpecPath: '.tbd/compiler/run-test-001/frozen-spec.md',
    frozenSpecSha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    targetBranch: 'compile/test',
    baseBranch: 'main',
    state: 'implementing',
    iteration: 1,
    beads: {
      total: 3,
      completed: ['is-00000000000000000000000001'],
      inProgress: ['is-00000000000000000000000002'],
      blocked: [],
      retryCounts: {},
      claims: {},
    },
    agents: {
      maxConcurrency: 4,
      active: [],
    },
    maintenance: {
      runCount: 0,
      runs: [],
    },
    observations: {
      pending: [],
      promoted: [],
      dismissed: [],
    },
    ...overrides,
  };
}

// Valid ULID-style issue IDs for test data
const ID_A = 'is-00000000000000000000000001';
const ID_B = 'is-00000000000000000000000002';
const ID_C = 'is-00000000000000000000000003';
const ID_D = 'is-00000000000000000000000004';
const ID_EXT = 'is-00000000000000000000000099';

// =============================================================================
// CheckpointManager
// =============================================================================

describe('CheckpointManager', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tbd-ckpt-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should save and restore a checkpoint roundtrip', async () => {
    const mgr = new CheckpointManager(tmpDir);
    const original = makeCheckpoint({
      runId: 'run-roundtrip-42',
      state: 'implementing',
      iteration: 3,
      beads: {
        total: 5,
        completed: [ID_A, ID_B],
        inProgress: [ID_C],
        blocked: [ID_D],
        retryCounts: { [ID_C]: 1 },
        claims: { [ID_C]: 'agent-7' },
      },
    });

    await mgr.save(original);
    const loaded = await mgr.load();

    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.runId).toBe('run-roundtrip-42');
    expect(loaded.state).toBe('implementing');
    expect(loaded.iteration).toBe(3);
    expect(loaded.beads.total).toBe(5);
    expect(loaded.beads.completed).toEqual([ID_A, ID_B]);
    expect(loaded.beads.inProgress).toEqual([ID_C]);
    expect(loaded.beads.blocked).toEqual([ID_D]);
    expect(loaded.beads.retryCounts).toEqual({ [ID_C]: 1 });
    expect(loaded.beads.claims).toEqual({ [ID_C]: 'agent-7' });
    expect(loaded.targetBranch).toBe(original.targetBranch);
    expect(loaded.baseBranch).toBe(original.baseBranch);
    expect(loaded.frozenSpecSha256).toBe(original.frozenSpecSha256);
  });

  it('should reject a checkpoint with unknown schema version', async () => {
    const mgr = new CheckpointManager(tmpDir);

    // Save a valid checkpoint first
    await mgr.save(makeCheckpoint());

    // Overwrite with schemaVersion: 2
    const checkpointPath = join(tmpDir, 'checkpoint.yml');
    const content = await readFile(checkpointPath, 'utf-8');
    const corrupted = content.replace('schemaVersion: 1', 'schemaVersion: 2');
    await writeFile(checkpointPath, corrupted, 'utf-8');

    try {
      await mgr.load();
      expect.unreachable('load() should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CompilerError);
      expect((err as CompilerError).code).toBe('E_CHECKPOINT_CORRUPT');
      expect((err as CompilerError).message).toContain('Unknown checkpoint schema version');
    }
  });

  it('should survive a simulated crash with a leftover .tmp file', async () => {
    const mgr = new CheckpointManager(tmpDir);

    // Save a valid checkpoint
    const original = makeCheckpoint({ runId: 'run-crash-safe' });
    await mgr.save(original);

    // Simulate an interrupted write by creating a .tmp file with garbage
    const tmpPath = join(tmpDir, 'checkpoint.yml.tmp');
    await writeFile(tmpPath, 'corrupted-partial-write', 'utf-8');

    // load() should succeed by cleaning up the stale .tmp file
    const loaded = await mgr.load();
    expect(loaded.runId).toBe('run-crash-safe');
    expect(loaded.schemaVersion).toBe(1);
  });
});

// =============================================================================
// Frozen Spec SHA-256 Hash
// =============================================================================

describe('computeFileHash / verifySpecHash', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tbd-hash-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should compute a stable hash and verify it matches', async () => {
    const filePath = join(tmpDir, 'spec.md');
    await writeFile(filePath, '# My Spec\n\nAcceptance criteria here.\n', 'utf-8');

    const hash = await computeFileHash(filePath);

    // SHA-256 hashes are 64 hex characters
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // verifySpecHash should not throw for a matching hash
    await expect(verifySpecHash(filePath, hash)).resolves.toBeUndefined();
  });

  it('should throw E_SPEC_HASH_MISMATCH when the file is modified', async () => {
    const filePath = join(tmpDir, 'spec.md');
    await writeFile(filePath, 'Original content', 'utf-8');

    const originalHash = await computeFileHash(filePath);

    // Modify the file
    await writeFile(filePath, 'Modified content', 'utf-8');

    try {
      await verifySpecHash(filePath, originalHash);
      expect.unreachable('verifySpecHash should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CompilerError);
      expect((err as CompilerError).code).toBe('E_SPEC_HASH_MISMATCH');
      expect((err as CompilerError).message).toContain('Frozen spec hash mismatch');
    }
  });
});

// =============================================================================
// EventLogger
// =============================================================================

describe('EventLogger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tbd-events-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should write serialized JSONL events without interleaving', async () => {
    const logPath = join(tmpDir, 'events.jsonl');
    const logger = new EventLogger(logPath);

    await logger.open();

    // Emit many events rapidly to stress the serialization queue
    const count = 20;
    for (let i = 0; i < count; i++) {
      logger.emit({ event: 'bead_started', beadId: `bead-${i}` });
    }

    await logger.close();

    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(count);

    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]!);

      // Every event must have v:1 and a ts field
      expect(parsed.v).toBe(1);
      expect(parsed.ts).toBeDefined();
      expect(typeof parsed.ts).toBe('string');

      // Verify the event payload
      expect(parsed.event).toBe('bead_started');
      expect(parsed.beadId).toBe(`bead-${i}`);
    }
  });
});

// =============================================================================
// RunLock
// =============================================================================

describe('RunLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tbd-lock-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should acquire and reject double acquisition, then allow after release', async () => {
    const lock1 = new RunLock(tmpDir, 'run-001');
    await lock1.acquire();

    // A second lock for the same run directory should fail
    const lock2 = new RunLock(tmpDir, 'run-001');
    try {
      await lock2.acquire();
      expect.unreachable('lock2.acquire() should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CompilerError);
      expect((err as CompilerError).code).toBe('E_RUN_LOCKED');
      expect((err as CompilerError).message).toContain('is already in progress');
    }

    // Release the first lock
    await lock1.release();

    // Now the second lock should succeed
    const lock3 = new RunLock(tmpDir, 'run-001');
    await lock3.acquire();
    await lock3.release();
  });

  it('should recover from a stale lock with a dead PID', async () => {
    // Write a stale lock.json manually with old heartbeat and a dead PID
    const lockPath = join(tmpDir, 'lock.json');
    const staleLock = {
      runId: 'run-stale',
      pid: 999999, // Very unlikely to be a real PID
      hostname: 'test-host',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(), // 60s ago, well past 30s threshold
    };
    await writeFile(lockPath, JSON.stringify(staleLock, null, 2), 'utf-8');

    // A new lock should detect the stale lock and acquire successfully
    const lock = new RunLock(tmpDir, 'run-fresh');
    await lock.acquire();

    // Verify we actually hold the lock now
    const lockContent = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(lockContent.runId).toBe('run-fresh');
    expect(lockContent.pid).toBe(process.pid);

    await lock.release();
  });
});

// =============================================================================
// AgentPool
// =============================================================================

describe('AgentPool', () => {
  it('should respect maxConcurrency and release slots on completion', async () => {
    // Use deferred promises so we control when agents "complete"
    const resolvers: ((result: AgentResult) => void)[] = [];
    const backend: AgentBackend = {
      name: 'deferred-mock',
      spawn: () =>
        new Promise<AgentResult>((resolve) => {
          resolvers.push(resolve);
        }),
    };

    const pool = new AgentPool(backend, 2);

    expect(pool.hasCapacity).toBe(true);
    expect(pool.activeCount).toBe(0);

    // Assign bead 1
    pool.assign(ID_A, { workdir: '/tmp/a', prompt: 'implement A', timeout: 60_000 });
    expect(pool.activeCount).toBe(1);
    expect(pool.hasCapacity).toBe(true);

    // Assign bead 2
    pool.assign(ID_B, { workdir: '/tmp/b', prompt: 'implement B', timeout: 60_000 });
    expect(pool.activeCount).toBe(2);
    expect(pool.hasCapacity).toBe(false);

    // Assign bead 3 (beyond capacity, but assign does not block -- it just fills a slot)
    pool.assign(ID_C, { workdir: '/tmp/c', prompt: 'implement C', timeout: 60_000 });
    expect(pool.activeCount).toBe(3);
    expect(pool.hasCapacity).toBe(false);

    // Resolve the first agent
    resolvers[0]!({ status: 'success', exitCode: 0, lastLines: '', duration: 500 });

    // Wait for any returns the first completed result
    const result = await pool.waitForAny();
    expect(result).not.toBeNull();
    expect(result!.result.status).toBe('success');

    // After one completion, activeCount should decrease
    // The slot auto-removes on resolve, and waitForAny also deletes it.
    // Two agents remain (indices 1 and 2).
    expect(pool.activeCount).toBe(2);
    expect(pool.hasCapacity).toBe(false);

    // Resolve remaining agents to clean up
    resolvers[1]!({ status: 'success', exitCode: 0, lastLines: '', duration: 600 });
    resolvers[2]!({ status: 'success', exitCode: 0, lastLines: '', duration: 700 });
    await pool.waitForAll();

    expect(pool.activeCount).toBe(0);
    expect(pool.hasCapacity).toBe(true);
  });

  it('should handle agent failure results correctly', async () => {
    const backend = new MockAgentBackend([
      { status: 'failure', exitCode: 1, lastLines: 'Error: compilation failed', duration: 2000 },
    ]);

    const pool = new AgentPool(backend, 2);
    pool.assign(ID_A, { workdir: '/tmp/a', prompt: 'implement A', timeout: 60_000 });

    const result = await pool.waitForAny();
    expect(result).not.toBeNull();
    expect(result!.result.status).toBe('failure');
    expect(result!.result.exitCode).toBe(1);
    expect(result!.result.lastLines).toBe('Error: compilation failed');
    expect(result!.slot.beadId).toBe(ID_A);
  });
});

// =============================================================================
// Scheduler — full cycle
// =============================================================================

describe('Scheduler — full cycle', () => {
  it('should pick beads in dependency-respecting, impact-depth order', () => {
    // Dependency chain: A blocks B, B blocks C. D is independent.
    // Impact depths: A=2 (B,C downstream), B=1 (C downstream), C=0, D=0
    // Expected pick order: A (depth 2), then B (depth 1), then C or D (depth 0)
    const a = makeIssue({
      id: ID_A,
      priority: 2,
      dependencies: [{ type: 'blocks', target: ID_B }],
    });
    const b = makeIssue({
      id: ID_B,
      priority: 2,
      dependencies: [{ type: 'blocks', target: ID_C }],
    });
    const c = makeIssue({ id: ID_C, priority: 2 });
    const d = makeIssue({ id: ID_D, priority: 2 });

    const scheduler = new Scheduler(new Set([ID_A, ID_B, ID_C, ID_D]));
    scheduler.rebuild([a, b, c, d]);

    const completed = new Set<string>();
    const inProgress = new Set<string>();
    const blocked = new Set<string>();
    const pickOrder: string[] = [];

    // Simulate a full scheduling cycle
    let next = scheduler.pickNext(completed, inProgress, blocked);
    while (next !== null) {
      pickOrder.push(next.id);
      // Immediately mark as completed
      completed.add(next.id);
      next = scheduler.pickNext(completed, inProgress, blocked);
    }

    expect(pickOrder).toHaveLength(4);

    // A must come before B (A blocks B)
    expect(pickOrder.indexOf(ID_A)).toBeLessThan(pickOrder.indexOf(ID_B));
    // B must come before C (B blocks C)
    expect(pickOrder.indexOf(ID_B)).toBeLessThan(pickOrder.indexOf(ID_C));

    // A should be first (highest impact depth)
    expect(pickOrder[0]).toBe(ID_A);
  });
});

// =============================================================================
// Scheduler — external blocker detection
// =============================================================================

describe('Scheduler — external blocker detection', () => {
  it('should detect external blockers and return blocking chains', () => {
    // EXT is an external bead (not in run set) that blocks A.
    const ext = makeIssue({
      id: ID_EXT,
      status: 'open',
      dependencies: [{ type: 'blocks', target: ID_A }],
    });
    const a = makeIssue({ id: ID_A });
    const b = makeIssue({ id: ID_B });

    const scheduler = new Scheduler(new Set([ID_A, ID_B]));
    scheduler.rebuild([ext, a, b]);

    const result = scheduler.detectExternalBlockers(new Set(), new Set());
    expect(result.blocked).toBe(true);
    expect(result.chains.length).toBe(1);
    expect(result.chains[0]).toContain(ID_A);
    expect(result.chains[0]).toContain(ID_EXT);
  });

  it('should not report external blockers for completed beads', () => {
    const ext = makeIssue({
      id: ID_EXT,
      status: 'open',
      dependencies: [{ type: 'blocks', target: ID_A }],
    });
    const a = makeIssue({ id: ID_A });

    const scheduler = new Scheduler(new Set([ID_A]));
    scheduler.rebuild([ext, a]);

    // A is already completed, so its external blocker is irrelevant
    const result = scheduler.detectExternalBlockers(new Set([ID_A]), new Set());
    expect(result.blocked).toBe(false);
    expect(result.chains).toEqual([]);
  });
});

// =============================================================================
// Scheduler — cycle detection
// =============================================================================

describe('Scheduler — cycle detection', () => {
  it('should detect cycles and prevent scheduling', () => {
    // A blocks B, B blocks C, C blocks A -- a 3-node cycle
    const a = makeIssue({
      id: ID_A,
      dependencies: [{ type: 'blocks', target: ID_B }],
    });
    const b = makeIssue({
      id: ID_B,
      dependencies: [{ type: 'blocks', target: ID_C }],
    });
    const c = makeIssue({
      id: ID_C,
      dependencies: [{ type: 'blocks', target: ID_A }],
    });

    const scheduler = new Scheduler(new Set([ID_A, ID_B, ID_C]));
    scheduler.rebuild([a, b, c]);

    // checkCycles should find cycles before any scheduling
    const cycles = scheduler.checkCycles();
    expect(cycles.length).toBeGreaterThan(0);

    // All three IDs should appear in the cycle(s)
    const allCycleIds = cycles.flat();
    expect(allCycleIds).toContain(ID_A);
    expect(allCycleIds).toContain(ID_B);
    expect(allCycleIds).toContain(ID_C);

    // pickNext cannot find any ready beads because all are blocked by the cycle
    const next = scheduler.pickNext(new Set(), new Set(), new Set());
    expect(next).toBeNull();
  });
});
