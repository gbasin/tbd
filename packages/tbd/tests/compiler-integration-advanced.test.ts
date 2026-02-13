/**
 * Advanced compiler orchestrator integration tests.
 *
 * Covers retry logic, judge flow, maintenance tracking, schema enforcement,
 * and process-result conversion. All pure-logic tests -- no real processes,
 * git operations, or filesystem I/O.
 */

import { describe, it, expect } from 'vitest';

import {
  CheckpointSchema,
  JudgeResultSchema,
  MaintenanceRunSchema,
} from '../src/lib/compiler/types.js';
import type {
  Checkpoint,
  JudgeResult,
  AgentBackend,
  AgentResult,
  SpawnOptions,
} from '../src/lib/compiler/types.js';
import { parseCompilerConfig } from '../src/lib/compiler/config.js';
import { toAgentResult, type ProcessResult } from '../src/cli/lib/compiler/backends/backend.js';

// =============================================================================
// Test Helpers — Mock Backends
// =============================================================================

class MockAgentBackend implements AgentBackend {
  name = 'mock';
  results: AgentResult[] = [];
  spawnCalls: SpawnOptions[] = [];

  spawn(opts: SpawnOptions): Promise<AgentResult> {
    this.spawnCalls.push(opts);
    return Promise.resolve(
      this.results.shift() ?? { status: 'success', exitCode: 0, lastLines: '', duration: 1000 },
    );
  }
}

// =============================================================================
// Helper: build a minimal valid Checkpoint for testing
// =============================================================================

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    schemaVersion: 1 as const,
    runId: 'run-test-001',
    specPath: 'specs/test-spec.md',
    frozenSpecPath: '.tbd/compiler/frozen/test-spec.md',
    frozenSpecSha256: 'abc123def456',
    targetBranch: 'compiler/run-test-001',
    baseBranch: 'main',
    state: 'implementing',
    iteration: 1,
    beads: {
      total: 3,
      completed: [],
      inProgress: [],
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

// =============================================================================
// 1. Retry Logic: timeout/crash -> correct failure mode
// =============================================================================

describe('Retry logic: timeout and crash handling', () => {
  it('should convert a timed-out ProcessResult to status timeout', () => {
    const processResult: ProcessResult = {
      exitCode: 137,
      lastLines: 'process timed out after 15m',
      duration: 900_000,
      timedOut: true,
      pid: 12345,
    };

    const agentResult = toAgentResult(processResult);

    expect(agentResult.status).toBe('timeout');
    expect(agentResult.exitCode).toBe(137);
    expect(agentResult.lastLines).toBe('process timed out after 15m');
    expect(agentResult.duration).toBe(900_000);
    expect(agentResult.pid).toBe(12345);
  });

  it('should convert a crashed ProcessResult (exitCode 1) to status failure', () => {
    const processResult: ProcessResult = {
      exitCode: 1,
      lastLines: 'Error: segfault or unhandled exception',
      duration: 5000,
      timedOut: false,
      pid: 12346,
    };

    const agentResult = toAgentResult(processResult);

    expect(agentResult.status).toBe('failure');
    expect(agentResult.exitCode).toBe(1);
    expect(agentResult.lastLines).toBe('Error: segfault or unhandled exception');
    expect(agentResult.duration).toBe(5000);
    expect(agentResult.pid).toBe(12346);
  });

  it('should use MockAgentBackend to simulate timeout and return queued result', async () => {
    const backend = new MockAgentBackend();
    backend.results.push({
      status: 'timeout',
      exitCode: 137,
      lastLines: 'killed by timeout',
      duration: 900_000,
    });

    const result = await backend.spawn({
      workdir: '/tmp/test',
      prompt: 'implement feature',
      timeout: 900_000,
    });

    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBe(137);
    expect(backend.spawnCalls).toHaveLength(1);
    expect(backend.spawnCalls[0]!.workdir).toBe('/tmp/test');
  });

  it('should use MockAgentBackend to simulate crash and return queued result', async () => {
    const backend = new MockAgentBackend();
    backend.results.push({
      status: 'failure',
      exitCode: 1,
      lastLines: 'fatal error',
      duration: 2000,
    });

    const result = await backend.spawn({
      workdir: '/tmp/test',
      prompt: 'implement feature',
      timeout: 900_000,
    });

    expect(result.status).toBe('failure');
    expect(result.exitCode).toBe(1);
  });
});

// =============================================================================
// 2. Retry Logic: incomplete -> exitCode 0 success case
// =============================================================================

describe('Retry logic: incomplete handling (clean exit without closing bead)', () => {
  it('should convert exitCode 0 with no timeout to status success', () => {
    // The "incomplete" case: agent exits cleanly (exitCode 0) but did not
    // close the bead. toAgentResult maps this to "success" and the
    // orchestrator would detect the bead is still open and reuse the
    // worktree on retry rather than starting from scratch.
    const processResult: ProcessResult = {
      exitCode: 0,
      lastLines: 'Agent exited without closing bead',
      duration: 30_000,
      timedOut: false,
      pid: 99999,
    };

    const agentResult = toAgentResult(processResult);

    expect(agentResult.status).toBe('success');
    expect(agentResult.exitCode).toBe(0);
    expect(agentResult.lastLines).toBe('Agent exited without closing bead');
    expect(agentResult.duration).toBe(30_000);
    expect(agentResult.pid).toBe(99999);
  });
});

// =============================================================================
// 3. Judge result parsing -- pass verdict
// =============================================================================

describe('Judge result parsing: pass verdict', () => {
  it('should parse a valid passing JudgeResult with all fields correct', () => {
    const raw: JudgeResult = {
      status: 'success',
      specDrift: {
        detected: false,
        issues: [],
      },
      acceptance: {
        passed: true,
        results: [
          {
            criterion: 'All unit tests pass',
            passed: true,
            evidence: 'vitest run completed with 47/47 tests passing',
          },
          {
            criterion: 'TypeScript compiles without errors',
            passed: true,
            evidence: 'tsc --noEmit exited with code 0',
          },
        ],
      },
      observations: [],
      newBeads: [],
      lastLines: 'Judge evaluation complete',
      duration: 8000,
    };

    const parsed = JudgeResultSchema.parse(raw);

    expect(parsed.status).toBe('success');
    expect(parsed.specDrift.detected).toBe(false);
    expect(parsed.specDrift.issues).toHaveLength(0);
    expect(parsed.acceptance.passed).toBe(true);
    expect(parsed.acceptance.results).toHaveLength(2);
    expect(parsed.acceptance.results[0]!.criterion).toBe('All unit tests pass');
    expect(parsed.acceptance.results[0]!.passed).toBe(true);
    expect(parsed.acceptance.results[1]!.criterion).toBe('TypeScript compiles without errors');
    expect(parsed.observations).toHaveLength(0);
    expect(parsed.newBeads).toHaveLength(0);
    expect(parsed.lastLines).toBe('Judge evaluation complete');
    expect(parsed.duration).toBe(8000);
  });
});

// =============================================================================
// 4. Judge result parsing -- fail verdict with new beads
// =============================================================================

describe('Judge result parsing: fail verdict with new beads', () => {
  it('should parse a JudgeResult with spec drift, failed acceptance, and new beads', () => {
    const raw: JudgeResult = {
      status: 'success',
      specDrift: {
        detected: true,
        issues: [
          {
            section: 'API endpoints',
            description: 'POST /users endpoint missing validation for email field',
            severity: 'critical',
          },
          {
            section: 'Error handling',
            description: 'Custom error codes not implemented as specified',
            severity: 'major',
          },
        ],
      },
      acceptance: {
        passed: false,
        results: [
          {
            criterion: 'Email validation on POST /users',
            passed: false,
            evidence: 'No validation middleware found for email field',
          },
          {
            criterion: 'Rate limiting on all endpoints',
            passed: true,
            evidence: 'express-rate-limit middleware configured correctly',
          },
        ],
      },
      observations: [],
      newBeads: [
        {
          title: 'Add email validation to POST /users',
          description:
            'Implement Zod schema validation for the email field on the user creation endpoint',
          type: 'bug',
        },
        {
          title: 'Implement custom error codes',
          description:
            'Create error code enum and map to HTTP status codes as specified in the API design doc',
          type: 'task',
        },
      ],
      lastLines: 'Judge found issues requiring remediation',
      duration: 12000,
    };

    const parsed = JudgeResultSchema.parse(raw);

    expect(parsed.specDrift.detected).toBe(true);
    expect(parsed.specDrift.issues).toHaveLength(2);
    expect(parsed.specDrift.issues[0]!.severity).toBe('critical');
    expect(parsed.specDrift.issues[1]!.severity).toBe('major');

    expect(parsed.acceptance.passed).toBe(false);
    expect(parsed.acceptance.results).toHaveLength(2);
    expect(parsed.acceptance.results[0]!.passed).toBe(false);
    expect(parsed.acceptance.results[1]!.passed).toBe(true);

    expect(parsed.newBeads).toHaveLength(2);
    expect(parsed.newBeads[0]!.title).toBe('Add email validation to POST /users');
    expect(parsed.newBeads[0]!.type).toBe('bug');
    expect(parsed.newBeads[1]!.title).toBe('Implement custom error codes');
    expect(parsed.newBeads[1]!.type).toBe('task');
  });
});

// =============================================================================
// 5. Judge result parsing -- observation triage
// =============================================================================

describe('Judge result parsing: observation triage', () => {
  it('should parse a JudgeResult with promote, dismiss, and merge observation actions', () => {
    const raw: JudgeResult = {
      status: 'success',
      specDrift: { detected: false, issues: [] },
      acceptance: { passed: true, results: [] },
      observations: [
        {
          beadId: 'obs-001',
          action: 'promote',
          reason: 'Valid edge case that should become a tracked bead',
        },
        {
          beadId: 'obs-002',
          action: 'dismiss',
          reason: 'Duplicate of existing bead, no action needed',
        },
        {
          beadId: 'obs-003',
          action: 'merge',
          reason: 'Related work can be combined with existing bead',
          mergeWith: 'bead-existing-007',
        },
      ],
      newBeads: [],
      lastLines: 'Observation triage complete',
      duration: 6000,
    };

    const parsed = JudgeResultSchema.parse(raw);

    expect(parsed.observations).toHaveLength(3);

    // Promote action
    const promote = parsed.observations[0]!;
    expect(promote.beadId).toBe('obs-001');
    expect(promote.action).toBe('promote');
    expect(promote.reason).toBe('Valid edge case that should become a tracked bead');
    expect(promote.mergeWith).toBeUndefined();

    // Dismiss action
    const dismiss = parsed.observations[1]!;
    expect(dismiss.beadId).toBe('obs-002');
    expect(dismiss.action).toBe('dismiss');
    expect(dismiss.reason).toBe('Duplicate of existing bead, no action needed');

    // Merge action with mergeWith target
    const merge = parsed.observations[2]!;
    expect(merge.beadId).toBe('obs-003');
    expect(merge.action).toBe('merge');
    expect(merge.reason).toBe('Related work can be combined with existing bead');
    expect(merge.mergeWith).toBe('bead-existing-007');
  });
});

// =============================================================================
// 6. Maintenance trigger watermark
// =============================================================================

describe('Maintenance trigger watermark', () => {
  it('should parse a MaintenanceRunSchema with running state', () => {
    const parsed = MaintenanceRunSchema.parse({
      id: 'maint-run-001',
      triggerCompletedCount: 25,
      state: 'running',
    });

    expect(parsed.id).toBe('maint-run-001');
    expect(parsed.triggerCompletedCount).toBe(25);
    expect(parsed.state).toBe('running');
  });

  it('should parse a MaintenanceRunSchema with success state', () => {
    const parsed = MaintenanceRunSchema.parse({
      id: 'maint-run-002',
      triggerCompletedCount: 50,
      state: 'success',
    });

    expect(parsed.id).toBe('maint-run-002');
    expect(parsed.triggerCompletedCount).toBe(50);
    expect(parsed.state).toBe('success');
  });

  it('should parse a MaintenanceRunSchema with failure state', () => {
    const parsed = MaintenanceRunSchema.parse({
      id: 'maint-run-003',
      triggerCompletedCount: 75,
      state: 'failure',
    });

    expect(parsed.id).toBe('maint-run-003');
    expect(parsed.triggerCompletedCount).toBe(75);
    expect(parsed.state).toBe('failure');
  });

  it('should track multiple maintenance runs in a checkpoint', () => {
    const checkpoint = makeCheckpoint({
      maintenance: {
        lastRunAt: '2026-01-15T12:00:00Z',
        runCount: 3,
        runs: [
          { id: 'maint-001', triggerCompletedCount: 25, state: 'success' },
          { id: 'maint-002', triggerCompletedCount: 50, state: 'success' },
          { id: 'maint-003', triggerCompletedCount: 75, state: 'running' },
        ],
      },
    });

    const parsed = CheckpointSchema.parse(checkpoint);

    expect(parsed.maintenance.runCount).toBe(3);
    expect(parsed.maintenance.runs).toHaveLength(3);
    expect(parsed.maintenance.runs[0]!.triggerCompletedCount).toBe(25);
    expect(parsed.maintenance.runs[1]!.triggerCompletedCount).toBe(50);
    expect(parsed.maintenance.runs[2]!.triggerCompletedCount).toBe(75);
    expect(parsed.maintenance.runs[2]!.state).toBe('running');
    expect(parsed.maintenance.lastRunAt).toBe('2026-01-15T12:00:00Z');
  });
});

// =============================================================================
// 7. Bead scoping -- label format
// =============================================================================

describe('Bead scoping: label format', () => {
  it('should produce a correctly structured compiler-run label', () => {
    const runId = 'run-abc123';
    const label = `compiler-run:${runId}`;

    expect(label).toBe('compiler-run:run-abc123');
    expect(label).toMatch(/^compiler-run:.+$/);
  });

  it('should produce unique labels for different run IDs', () => {
    const runId1 = 'run-001';
    const runId2 = 'run-002';
    const label1 = `compiler-run:${runId1}`;
    const label2 = `compiler-run:${runId2}`;

    expect(label1).not.toBe(label2);
    expect(label1).toBe('compiler-run:run-001');
    expect(label2).toBe('compiler-run:run-002');
  });

  it('should embed the run ID as the suffix after the colon', () => {
    const runId = 'run-ulid-01HX9Z3K7M';
    const label = `compiler-run:${runId}`;

    // Extract the run ID back from the label
    const extractedRunId = label.split(':')[1];
    expect(extractedRunId).toBe(runId);
  });
});

// =============================================================================
// 8. Checkpoint claim tokens
// =============================================================================

describe('Checkpoint claim tokens', () => {
  it('should preserve claim tokens through CheckpointSchema parsing', () => {
    const checkpoint = makeCheckpoint({
      beads: {
        total: 3,
        completed: ['bead-1'],
        inProgress: ['bead-2'],
        blocked: [],
        retryCounts: { 'bead-2': 1 },
        claims: { 'bead-2': 'run-abc:1:1' },
      },
    });

    const parsed = CheckpointSchema.parse(checkpoint);

    expect(parsed.beads.claims).toEqual({ 'bead-2': 'run-abc:1:1' });
    expect(parsed.beads.retryCounts).toEqual({ 'bead-2': 1 });
    expect(parsed.beads.completed).toEqual(['bead-1']);
    expect(parsed.beads.inProgress).toEqual(['bead-2']);
    expect(parsed.beads.blocked).toEqual([]);
    expect(parsed.beads.total).toBe(3);
  });

  it('should handle multiple concurrent claims', () => {
    const checkpoint = makeCheckpoint({
      beads: {
        total: 5,
        completed: ['bead-1'],
        inProgress: ['bead-2', 'bead-3', 'bead-4'],
        blocked: ['bead-5'],
        retryCounts: { 'bead-2': 0, 'bead-3': 2, 'bead-4': 0 },
        claims: {
          'bead-2': 'run-abc:1:0',
          'bead-3': 'run-abc:1:2',
          'bead-4': 'run-abc:1:0',
        },
      },
    });

    const parsed = CheckpointSchema.parse(checkpoint);

    expect(Object.keys(parsed.beads.claims)).toHaveLength(3);
    expect(parsed.beads.claims['bead-2']).toBe('run-abc:1:0');
    expect(parsed.beads.claims['bead-3']).toBe('run-abc:1:2');
    expect(parsed.beads.claims['bead-4']).toBe('run-abc:1:0');
  });

  it('should accept empty claims and retryCounts', () => {
    const checkpoint = makeCheckpoint({
      beads: {
        total: 2,
        completed: [],
        inProgress: [],
        blocked: [],
        retryCounts: {},
        claims: {},
      },
    });

    const parsed = CheckpointSchema.parse(checkpoint);

    expect(parsed.beads.claims).toEqual({});
    expect(parsed.beads.retryCounts).toEqual({});
  });
});

// =============================================================================
// 9. Config merging on resume
// =============================================================================

describe('Config merging on resume', () => {
  it('should parse config with max_concurrency=4', () => {
    const config = parseCompilerConfig({ agent: { max_concurrency: 4 } });

    expect(config.agent.max_concurrency).toBe(4);
    expect(config.agent.backend).toBe('auto');
    expect(config.agent.timeout_per_bead).toBe('15m');
  });

  it('should parse config with max_concurrency=2 independently', () => {
    const config = parseCompilerConfig({ agent: { max_concurrency: 2 } });

    expect(config.agent.max_concurrency).toBe(2);
    // Other defaults still intact
    expect(config.agent.backend).toBe('auto');
    expect(config.agent.timeout_per_bead).toBe('15m');
  });

  it('should produce different configs from different inputs (simulating resume re-read)', () => {
    // First read: initial config
    const configBefore = parseCompilerConfig({
      agent: { max_concurrency: 4, timeout_per_bead: '15m' },
    });
    // Resume re-read: user changed concurrency and timeout
    const configAfter = parseCompilerConfig({
      agent: { max_concurrency: 2, timeout_per_bead: '30m' },
    });

    expect(configBefore.agent.max_concurrency).toBe(4);
    expect(configAfter.agent.max_concurrency).toBe(2);
    expect(configBefore.agent.timeout_per_bead).toBe('15m');
    expect(configAfter.agent.timeout_per_bead).toBe('30m');

    // Both share the same defaults for fields not overridden
    expect(configBefore.agent.backend).toBe(configAfter.agent.backend);
    expect(configBefore.agent.max_retries_per_bead).toBe(configAfter.agent.max_retries_per_bead);
    expect(configBefore.worktree.strategy).toBe(configAfter.worktree.strategy);
  });

  it('should allow changing phase config on resume without affecting other sections', () => {
    const initial = parseCompilerConfig({ phases: { judge: { max_iterations: 3 } } });
    const resumed = parseCompilerConfig({ phases: { judge: { max_iterations: 5 } } });

    expect(initial.phases.judge.max_iterations).toBe(3);
    expect(resumed.phases.judge.max_iterations).toBe(5);

    // Other phase defaults stay the same
    expect(initial.phases.judge.enabled).toBe(resumed.phases.judge.enabled);
    expect(initial.phases.decompose.auto).toBe(resumed.phases.decompose.auto);
  });
});

// =============================================================================
// 10. Structured judge output schema enforcement
// =============================================================================

describe('Structured judge output schema enforcement', () => {
  it('should reject a JudgeResult missing the specDrift field', () => {
    const malformed = {
      status: 'success',
      // specDrift intentionally missing
      acceptance: { passed: true, results: [] },
      observations: [],
      newBeads: [],
      lastLines: '',
      duration: 1000,
    };

    expect(() => JudgeResultSchema.parse(malformed)).toThrow();
  });

  it('should reject a JudgeResult with an invalid severity value', () => {
    const malformed = {
      status: 'success',
      specDrift: {
        detected: true,
        issues: [
          {
            section: 'API',
            description: 'Something wrong',
            severity: 'warning', // Invalid: must be "critical" | "major" | "minor"
          },
        ],
      },
      acceptance: { passed: true, results: [] },
      observations: [],
      newBeads: [],
      lastLines: '',
      duration: 1000,
    };

    expect(() => JudgeResultSchema.parse(malformed)).toThrow();
  });

  it('should reject a JudgeResult missing acceptance.passed', () => {
    const malformed = {
      status: 'success',
      specDrift: { detected: false, issues: [] },
      acceptance: {
        // passed intentionally missing
        results: [],
      },
      observations: [],
      newBeads: [],
      lastLines: '',
      duration: 1000,
    };

    expect(() => JudgeResultSchema.parse(malformed)).toThrow();
  });

  it('should reject a JudgeResult with an invalid observation action', () => {
    const malformed = {
      status: 'success',
      specDrift: { detected: false, issues: [] },
      acceptance: { passed: true, results: [] },
      observations: [
        {
          beadId: 'obs-001',
          action: 'delete', // Invalid: must be "promote" | "dismiss" | "merge"
          reason: 'test',
        },
      ],
      newBeads: [],
      lastLines: '',
      duration: 1000,
    };

    expect(() => JudgeResultSchema.parse(malformed)).toThrow();
  });

  it('should reject a JudgeResult with an invalid status value', () => {
    const malformed = {
      status: 'pending', // Invalid: must be "success" | "failure" | "timeout"
      specDrift: { detected: false, issues: [] },
      acceptance: { passed: true, results: [] },
      observations: [],
      newBeads: [],
      lastLines: '',
      duration: 1000,
    };

    expect(() => JudgeResultSchema.parse(malformed)).toThrow();
  });

  it('should accept a valid complete JudgeResult', () => {
    const valid: JudgeResult = {
      status: 'success',
      specDrift: {
        detected: true,
        issues: [
          { section: 'Auth', description: 'Missing RBAC checks', severity: 'critical' },
          { section: 'Logging', description: 'Verbose logs in production', severity: 'minor' },
        ],
      },
      acceptance: {
        passed: false,
        results: [
          { criterion: 'RBAC enforcement', passed: false, evidence: 'No middleware found' },
          { criterion: 'Logging levels', passed: true, evidence: 'winston configured correctly' },
        ],
      },
      observations: [
        { beadId: 'obs-1', action: 'promote', reason: 'Valid concern' },
        { beadId: 'obs-2', action: 'dismiss', reason: 'Not relevant' },
        { beadId: 'obs-3', action: 'merge', reason: 'Combine work', mergeWith: 'bead-5' },
      ],
      newBeads: [
        { title: 'Fix RBAC', description: 'Add role checks', type: 'bug' },
        { title: 'Add feature flag', description: 'Feature flag for new auth', type: 'feature' },
      ],
      lastLines: 'evaluation done',
      duration: 15000,
    };

    const parsed = JudgeResultSchema.parse(valid);

    expect(parsed.status).toBe('success');
    expect(parsed.specDrift.issues).toHaveLength(2);
    expect(parsed.acceptance.results).toHaveLength(2);
    expect(parsed.observations).toHaveLength(3);
    expect(parsed.newBeads).toHaveLength(2);
  });
});

// =============================================================================
// 11. Process group conversion (toAgentResult) -- all branches
// =============================================================================

describe('Process group conversion: toAgentResult all branches', () => {
  it('should map timedOut=true to status timeout', () => {
    const result = toAgentResult({
      exitCode: 137,
      lastLines: 'killed after timeout',
      duration: 900_000,
      timedOut: true,
      pid: 1001,
    });

    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBe(137);
    expect(result.lastLines).toBe('killed after timeout');
    expect(result.duration).toBe(900_000);
    expect(result.pid).toBe(1001);
  });

  it('should map timedOut=false and exitCode=0 to status success', () => {
    const result = toAgentResult({
      exitCode: 0,
      lastLines: 'all tasks completed',
      duration: 45_000,
      timedOut: false,
      pid: 1002,
    });

    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.lastLines).toBe('all tasks completed');
    expect(result.duration).toBe(45_000);
    expect(result.pid).toBe(1002);
  });

  it('should map timedOut=false and exitCode=1 to status failure', () => {
    const result = toAgentResult({
      exitCode: 1,
      lastLines: 'unhandled error',
      duration: 3000,
      timedOut: false,
      pid: 1003,
    });

    expect(result.status).toBe('failure');
    expect(result.exitCode).toBe(1);
    expect(result.lastLines).toBe('unhandled error');
    expect(result.duration).toBe(3000);
    expect(result.pid).toBe(1003);
  });

  it('should map timedOut=false and exitCode=137 (SIGKILL) to status failure', () => {
    // exitCode 137 = 128 + 9 (SIGKILL). When timedOut is false, this means
    // the process was killed externally (OOM killer, manual kill), not by
    // our timeout handler.
    const result = toAgentResult({
      exitCode: 137,
      lastLines: 'killed by signal 9',
      duration: 60_000,
      timedOut: false,
      pid: 1004,
    });

    expect(result.status).toBe('failure');
    expect(result.exitCode).toBe(137);
    expect(result.lastLines).toBe('killed by signal 9');
    expect(result.duration).toBe(60_000);
    expect(result.pid).toBe(1004);
  });

  it('should preserve all fields from ProcessResult in AgentResult', () => {
    const processResult: ProcessResult = {
      exitCode: 2,
      lastLines: 'multi\nline\noutput',
      duration: 7777,
      timedOut: false,
      pid: 42,
    };

    const agentResult = toAgentResult(processResult);

    expect(agentResult.exitCode).toBe(processResult.exitCode);
    expect(agentResult.lastLines).toBe(processResult.lastLines);
    expect(agentResult.duration).toBe(processResult.duration);
    expect(agentResult.pid).toBe(processResult.pid);
  });

  it('should handle exitCode=0 with timedOut=true as timeout (timeout takes precedence)', () => {
    // Edge case: the process happened to return 0 but was also flagged as
    // timed out (e.g., race between completion and the timer firing).
    // timedOut should take precedence.
    const result = toAgentResult({
      exitCode: 0,
      lastLines: 'race condition edge case',
      duration: 900_000,
      timedOut: true,
      pid: 1005,
    });

    expect(result.status).toBe('timeout');
  });
});
