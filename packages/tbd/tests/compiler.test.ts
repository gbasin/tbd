/**
 * Tests for the tbd compile orchestrator subsystem.
 *
 * Covers pure-logic units only: Scheduler, config parsing, and graph utilities.
 * No process spawning, git operations, or file I/O.
 */

import { describe, it, expect, vi } from 'vitest';

import { Scheduler } from '../src/cli/lib/compiler/scheduler.js';
import {
  parseCompilerConfig,
  parseDuration,
  getBeadTimeoutMs,
  BackendSpec,
} from '../src/lib/compiler/config.js';
import {
  buildDependencyGraph,
  topologicalSort,
  computeImpactDepth,
} from '../src/lib/compiler/graph.js';
import type { Issue } from '../src/lib/types.js';
import {
  RunPhase,
  CompilerErrorCode,
  ERROR_CODE_EXIT_MAP,
  JudgeResultSchema,
  CompilerEventSchema,
  CheckpointSchema,
} from '../src/lib/compiler/types.js';
import {
  buildCodingAgentPrompt,
  buildMaintenancePrompt,
  buildJudgeReasoningPrompt,
  buildJudgeStructuringPrompt,
} from '../src/cli/lib/compiler/prompts.js';
import { toAgentResult, type ProcessResult } from '../src/cli/lib/compiler/backends/backend.js';
import { CompilerError, CLIError } from '../src/cli/lib/errors.js';

// Mock node:fs/promises for prompt assembly tests
vi.mock('node:fs/promises', async (importOriginal) => {
  return {
    ...(await importOriginal()),
    readFile: vi.fn(),
  };
});

// =============================================================================
// Test Helpers
// =============================================================================

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

// Valid ULID-style issue IDs for test data
const ID_A = 'is-00000000000000000000000001';
const ID_B = 'is-00000000000000000000000002';
const ID_C = 'is-00000000000000000000000003';
const ID_D = 'is-00000000000000000000000004';
const ID_EXT = 'is-00000000000000000000000099';

// =============================================================================
// Scheduler
// =============================================================================

describe('Scheduler', () => {
  describe('pickNext', () => {
    it('should return the highest-impact root first', () => {
      // A blocks B and C (impact depth 2), D is independent (impact depth 0).
      // A should be picked first because it has the highest fan-out.
      const a = makeIssue({
        id: ID_A,
        dependencies: [
          { type: 'blocks', target: ID_B },
          { type: 'blocks', target: ID_C },
        ],
      });
      const b = makeIssue({ id: ID_B });
      const c = makeIssue({ id: ID_C });
      const d = makeIssue({ id: ID_D });

      const scheduler = new Scheduler(new Set([ID_A, ID_B, ID_C, ID_D]));
      scheduler.rebuild([a, b, c, d]);

      const next = scheduler.pickNext(new Set(), new Set(), new Set());
      expect(next).not.toBeNull();
      expect(next!.id).toBe(ID_A);
    });

    it('should skip completed, in-progress, and blocked beads', () => {
      const a = makeIssue({ id: ID_A });
      const b = makeIssue({ id: ID_B });
      const c = makeIssue({ id: ID_C });

      const scheduler = new Scheduler(new Set([ID_A, ID_B, ID_C]));
      scheduler.rebuild([a, b, c]);

      // A completed, B in-progress, C blocked
      const next = scheduler.pickNext(new Set([ID_A]), new Set([ID_B]), new Set([ID_C]));
      expect(next).toBeNull();
    });

    it('should return null when all beads are completed', () => {
      const a = makeIssue({ id: ID_A });
      const b = makeIssue({ id: ID_B });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const next = scheduler.pickNext(new Set([ID_A, ID_B]), new Set(), new Set());
      expect(next).toBeNull();
    });

    it('should respect external blockers', () => {
      // External bead (not in runBeadIds) blocks a run bead.
      // The external bead carries the 'blocks' edge: EXT blocks A.
      const ext = makeIssue({
        id: ID_EXT,
        status: 'open',
        dependencies: [{ type: 'blocks', target: ID_A }],
      });
      const a = makeIssue({ id: ID_A });

      // Only A is in the run set; EXT is external.
      const scheduler = new Scheduler(new Set([ID_A]));
      scheduler.rebuild([ext, a]);

      const next = scheduler.pickNext(new Set(), new Set(), new Set());
      // A is blocked by the open external bead, so nothing should be ready.
      expect(next).toBeNull();
    });

    it('should allow a bead when its external blocker is closed', () => {
      const ext = makeIssue({
        id: ID_EXT,
        status: 'closed',
        dependencies: [{ type: 'blocks', target: ID_A }],
      });
      const a = makeIssue({ id: ID_A });

      const scheduler = new Scheduler(new Set([ID_A]));
      scheduler.rebuild([ext, a]);

      const next = scheduler.pickNext(new Set(), new Set(), new Set());
      expect(next).not.toBeNull();
      expect(next!.id).toBe(ID_A);
    });

    it('should pick higher-priority bead when impact depths are equal', () => {
      // Both A and B are independent roots with the same impact depth (0).
      // A has priority 1 (higher), B has priority 3 (lower).
      // Lower priority number wins (ASC sort on priority).
      const a = makeIssue({ id: ID_A, priority: 1 });
      const b = makeIssue({ id: ID_B, priority: 3 });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const next = scheduler.pickNext(new Set(), new Set(), new Set());
      expect(next).not.toBeNull();
      expect(next!.id).toBe(ID_A);
    });
  });

  describe('checkCycles', () => {
    it('should detect a cycle between two issues', () => {
      // A blocks B, B blocks A -- a cycle.
      const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
      const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_A }] });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const cycles = scheduler.checkCycles();
      expect(cycles.length).toBeGreaterThan(0);

      // The cycle should contain both A and B.
      const cycleIds = cycles.flat();
      expect(cycleIds).toContain(ID_A);
      expect(cycleIds).toContain(ID_B);
    });

    it('should return empty array for a valid DAG', () => {
      // A blocks B, B blocks C -- a chain with no cycles.
      const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
      const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_C }] });
      const c = makeIssue({ id: ID_C });

      const scheduler = new Scheduler(new Set([ID_A, ID_B, ID_C]));
      scheduler.rebuild([a, b, c]);

      const cycles = scheduler.checkCycles();
      expect(cycles).toEqual([]);
    });
  });

  describe('detectDeadlock', () => {
    it('should return deadlocked when open beads exist but none are ready and no agents are running', () => {
      // A blocks B, B blocks A -- mutual dependency makes neither ready.
      const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
      const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_A }] });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const result = scheduler.detectDeadlock(new Set(), new Set(), new Set(), 0);
      expect(result.deadlocked).toBe(true);
      expect(result.reason).toContain('Deadlock');
    });

    it('should return not deadlocked when agents are running', () => {
      // Same cyclic graph, but agents are still running.
      const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
      const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_A }] });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const result = scheduler.detectDeadlock(new Set(), new Set(), new Set(), 1);
      expect(result.deadlocked).toBe(false);
    });

    it('should return not deadlocked when all beads are completed', () => {
      const a = makeIssue({ id: ID_A });
      const b = makeIssue({ id: ID_B });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const result = scheduler.detectDeadlock(new Set([ID_A, ID_B]), new Set(), new Set(), 0);
      expect(result.deadlocked).toBe(false);
    });

    it('should return not deadlocked when ready beads exist', () => {
      const a = makeIssue({ id: ID_A });

      const scheduler = new Scheduler(new Set([ID_A]));
      scheduler.rebuild([a]);

      const result = scheduler.detectDeadlock(new Set(), new Set(), new Set(), 0);
      expect(result.deadlocked).toBe(false);
    });
  });

  describe('detectExternalBlockers', () => {
    it('should identify chains where an external bead blocks a run bead', () => {
      // EXT blocks A; EXT is not in the run set.
      const ext = makeIssue({
        id: ID_EXT,
        status: 'open',
        dependencies: [{ type: 'blocks', target: ID_A }],
      });
      const a = makeIssue({ id: ID_A });

      const scheduler = new Scheduler(new Set([ID_A]));
      scheduler.rebuild([ext, a]);

      const result = scheduler.detectExternalBlockers(new Set(), new Set());
      expect(result.blocked).toBe(true);
      expect(result.chains.length).toBe(1);
      expect(result.chains[0]).toContain(ID_A);
      expect(result.chains[0]).toContain(ID_EXT);
    });

    it('should return no chains when all blockers are within the run set', () => {
      // A blocks B; both in run set -- not external.
      const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
      const b = makeIssue({ id: ID_B });

      const scheduler = new Scheduler(new Set([ID_A, ID_B]));
      scheduler.rebuild([a, b]);

      const result = scheduler.detectExternalBlockers(new Set(), new Set());
      expect(result.blocked).toBe(false);
      expect(result.chains).toEqual([]);
    });

    it('should not report external blockers that are already closed', () => {
      const ext = makeIssue({
        id: ID_EXT,
        status: 'closed',
        dependencies: [{ type: 'blocks', target: ID_A }],
      });
      const a = makeIssue({ id: ID_A });

      const scheduler = new Scheduler(new Set([ID_A]));
      scheduler.rebuild([ext, a]);

      const result = scheduler.detectExternalBlockers(new Set(), new Set());
      expect(result.blocked).toBe(false);
      expect(result.chains).toEqual([]);
    });

    it('should skip completed run beads', () => {
      const ext = makeIssue({
        id: ID_EXT,
        status: 'open',
        dependencies: [{ type: 'blocks', target: ID_A }],
      });
      const a = makeIssue({ id: ID_A });

      const scheduler = new Scheduler(new Set([ID_A]));
      scheduler.rebuild([ext, a]);

      // A is already completed, so its external blocker should not be reported.
      const result = scheduler.detectExternalBlockers(new Set([ID_A]), new Set());
      expect(result.blocked).toBe(false);
    });
  });
});

// =============================================================================
// Config Parsing
// =============================================================================

describe('parseCompilerConfig', () => {
  it('should return all defaults for an empty object', () => {
    const config = parseCompilerConfig({});

    expect(config.agent.max_concurrency).toBe(4);
    expect(config.agent.backend).toBe('auto');
    expect(config.agent.timeout_per_bead).toBe('15m');
    expect(config.agent.max_retries_per_bead).toBe(2);
    expect(config.agent.command).toBeNull();
    expect(config.target_branch).toBe('auto');
    expect(config.worktree.strategy).toBe('per-agent');
    expect(config.worktree.base_branch).toBe('main');
    expect(config.worktree.cleanup).toBe(true);
    expect(config.phases.decompose.auto).toBe(true);
    expect(config.phases.implement.guidelines).toEqual([
      'typescript-rules',
      'general-tdd-guidelines',
    ]);
    expect(config.phases.judge.enabled).toBe(true);
    expect(config.phases.judge.on_complete).toBe('pr');
  });

  it('should override a single nested field while keeping other defaults', () => {
    const config = parseCompilerConfig({ agent: { max_concurrency: 8 } });

    expect(config.agent.max_concurrency).toBe(8);
    // Other agent defaults preserved
    expect(config.agent.backend).toBe('auto');
    expect(config.agent.timeout_per_bead).toBe('15m');
    expect(config.agent.max_retries_per_bead).toBe(2);
  });

  it('should override multiple fields across different sections', () => {
    const config = parseCompilerConfig({
      target_branch: 'develop',
      worktree: { base_branch: 'develop', cleanup: false },
      phases: { judge: { enabled: false } },
    });

    expect(config.target_branch).toBe('develop');
    expect(config.worktree.base_branch).toBe('develop');
    expect(config.worktree.cleanup).toBe(false);
    expect(config.phases.judge.enabled).toBe(false);
    // Other judge defaults preserved
    expect(config.phases.judge.max_iterations).toBe(3);
  });
});

describe('parseDuration', () => {
  it('should parse minutes to milliseconds', () => {
    expect(parseDuration('15m')).toBe(900_000);
  });

  it('should parse seconds to milliseconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('should parse hours to milliseconds', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('should parse milliseconds directly', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('should throw for an invalid duration string', () => {
    expect(() => parseDuration('invalid')).toThrow();
  });

  it('should throw for a duration without units', () => {
    expect(() => parseDuration('100')).toThrow();
  });

  it('should throw for an empty string', () => {
    expect(() => parseDuration('')).toThrow();
  });
});

describe('getBeadTimeoutMs', () => {
  it('should return the default timeout from default config', () => {
    const config = parseCompilerConfig({});
    expect(getBeadTimeoutMs(config)).toBe(900_000); // 15m = 900000ms
  });

  it('should respect a custom timeout_per_bead value', () => {
    const config = parseCompilerConfig({ agent: { timeout_per_bead: '1h' } });
    expect(getBeadTimeoutMs(config)).toBe(3_600_000);
  });
});

describe('BackendSpec validation', () => {
  it('should accept a single valid backend string', () => {
    expect(BackendSpec.parse('auto')).toBe('auto');
    expect(BackendSpec.parse('claude-code')).toBe('claude-code');
    expect(BackendSpec.parse('codex')).toBe('codex');
    expect(BackendSpec.parse('subprocess')).toBe('subprocess');
  });

  it('should accept an array of valid backend strings', () => {
    const result = BackendSpec.parse(['claude-code', 'codex']);
    expect(result).toEqual(['claude-code', 'codex']);
  });

  it('should reject an invalid backend string', () => {
    expect(() => BackendSpec.parse('invalid-backend')).toThrow();
  });

  it('should reject an empty array', () => {
    expect(() => BackendSpec.parse([])).toThrow();
  });

  it('should reject an array containing an invalid backend', () => {
    expect(() => BackendSpec.parse(['claude-code', 'invalid'])).toThrow();
  });
});

// =============================================================================
// Graph Utilities
// =============================================================================

describe('buildDependencyGraph', () => {
  it('should build correct forward and reverse edges from blocks dependencies', () => {
    // A blocks B: A.dependencies = [{type: 'blocks', target: B}]
    const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
    const b = makeIssue({ id: ID_B });

    const graph = buildDependencyGraph([a, b]);

    // Forward: A -> [B]
    expect(graph.forward.get(ID_A)).toContain(ID_B);
    // Reverse: B <- [A]
    expect(graph.reverse.get(ID_B)).toContain(ID_A);
  });

  it('should include all issue IDs in allIds', () => {
    const a = makeIssue({ id: ID_A });
    const b = makeIssue({ id: ID_B });
    const c = makeIssue({ id: ID_C });

    const graph = buildDependencyGraph([a, b, c]);

    expect(graph.allIds.has(ID_A)).toBe(true);
    expect(graph.allIds.has(ID_B)).toBe(true);
    expect(graph.allIds.has(ID_C)).toBe(true);
    expect(graph.allIds.size).toBe(3);
  });

  it('should identify roots as issues with no unresolved blockers', () => {
    // A blocks B. A is a root (nothing blocks it). B is not a root.
    const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
    const b = makeIssue({ id: ID_B });

    const graph = buildDependencyGraph([a, b]);

    expect(graph.roots).toContain(ID_A);
    expect(graph.roots).not.toContain(ID_B);
  });

  it('should treat a closed blocker as resolved, making the blocked issue a root', () => {
    // A blocks B, but A is closed, so B is also a root.
    const a = makeIssue({
      id: ID_A,
      status: 'closed',
      dependencies: [{ type: 'blocks', target: ID_B }],
    });
    const b = makeIssue({ id: ID_B });

    const graph = buildDependencyGraph([a, b]);

    expect(graph.roots).toContain(ID_A);
    expect(graph.roots).toContain(ID_B);
  });

  it('should handle issues with no dependencies', () => {
    const a = makeIssue({ id: ID_A });
    const b = makeIssue({ id: ID_B });

    const graph = buildDependencyGraph([a, b]);

    expect(graph.roots).toContain(ID_A);
    expect(graph.roots).toContain(ID_B);
    expect(graph.forward.get(ID_A) ?? []).toEqual([]);
    expect(graph.forward.get(ID_B) ?? []).toEqual([]);
  });
});

describe('topologicalSort', () => {
  it('should return dependency-respecting order', () => {
    // A blocks B, B blocks C. Valid topological orders: A, B, C.
    const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
    const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_C }] });
    const c = makeIssue({ id: ID_C });

    const graph = buildDependencyGraph([a, b, c]);
    const sorted = topologicalSort(graph);

    const indexA = sorted.indexOf(ID_A);
    const indexB = sorted.indexOf(ID_B);
    const indexC = sorted.indexOf(ID_C);

    // A must come before B, B must come before C.
    expect(indexA).toBeLessThan(indexB);
    expect(indexB).toBeLessThan(indexC);
  });

  it('should include all nodes in the output', () => {
    const a = makeIssue({ id: ID_A });
    const b = makeIssue({ id: ID_B });
    const c = makeIssue({ id: ID_C });

    const graph = buildDependencyGraph([a, b, c]);
    const sorted = topologicalSort(graph);

    expect(sorted).toHaveLength(3);
    expect(sorted).toContain(ID_A);
    expect(sorted).toContain(ID_B);
    expect(sorted).toContain(ID_C);
  });

  it('should handle a diamond dependency pattern', () => {
    // A blocks B and C, both B and C block D.
    const a = makeIssue({
      id: ID_A,
      dependencies: [
        { type: 'blocks', target: ID_B },
        { type: 'blocks', target: ID_C },
      ],
    });
    const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_D }] });
    const c = makeIssue({ id: ID_C, dependencies: [{ type: 'blocks', target: ID_D }] });
    const d = makeIssue({ id: ID_D });

    const graph = buildDependencyGraph([a, b, c, d]);
    const sorted = topologicalSort(graph);

    const indexA = sorted.indexOf(ID_A);
    const indexB = sorted.indexOf(ID_B);
    const indexC = sorted.indexOf(ID_C);
    const indexD = sorted.indexOf(ID_D);

    // A before B and C, both B and C before D.
    expect(indexA).toBeLessThan(indexB);
    expect(indexA).toBeLessThan(indexC);
    expect(indexB).toBeLessThan(indexD);
    expect(indexC).toBeLessThan(indexD);
  });

  it('should throw on cycles', () => {
    // A blocks B, B blocks A.
    const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
    const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_A }] });

    const graph = buildDependencyGraph([a, b]);

    expect(() => topologicalSort(graph)).toThrow(/cycle/i);
  });
});

describe('computeImpactDepth', () => {
  it('should return 0 for a leaf node with no downstream dependents', () => {
    const a = makeIssue({ id: ID_A });

    const graph = buildDependencyGraph([a]);
    expect(computeImpactDepth(graph, ID_A)).toBe(0);
  });

  it('should return the correct transitive count for a linear chain', () => {
    // A blocks B, B blocks C. A's impact depth = 2 (B + C).
    const a = makeIssue({ id: ID_A, dependencies: [{ type: 'blocks', target: ID_B }] });
    const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_C }] });
    const c = makeIssue({ id: ID_C });

    const graph = buildDependencyGraph([a, b, c]);

    expect(computeImpactDepth(graph, ID_A)).toBe(2);
    expect(computeImpactDepth(graph, ID_B)).toBe(1);
    expect(computeImpactDepth(graph, ID_C)).toBe(0);
  });

  it('should count fan-out correctly', () => {
    // A blocks B and C. A's impact depth = 2.
    const a = makeIssue({
      id: ID_A,
      dependencies: [
        { type: 'blocks', target: ID_B },
        { type: 'blocks', target: ID_C },
      ],
    });
    const b = makeIssue({ id: ID_B });
    const c = makeIssue({ id: ID_C });

    const graph = buildDependencyGraph([a, b, c]);

    expect(computeImpactDepth(graph, ID_A)).toBe(2);
    expect(computeImpactDepth(graph, ID_B)).toBe(0);
    expect(computeImpactDepth(graph, ID_C)).toBe(0);
  });

  it('should count diamond pattern edges correctly', () => {
    // A blocks B and C, both B and C block D.
    // DFS from A: visit B (+1), B->D (+1+0), visit C (+1), C->D (D already visited, +1+0).
    // Total = 4 because the edge to D is counted from both B and C, even though
    // D's own subtree is only traversed once (visited set prevents re-exploration).
    const a = makeIssue({
      id: ID_A,
      dependencies: [
        { type: 'blocks', target: ID_B },
        { type: 'blocks', target: ID_C },
      ],
    });
    const b = makeIssue({ id: ID_B, dependencies: [{ type: 'blocks', target: ID_D }] });
    const c = makeIssue({ id: ID_C, dependencies: [{ type: 'blocks', target: ID_D }] });
    const d = makeIssue({ id: ID_D });

    const graph = buildDependencyGraph([a, b, c, d]);

    expect(computeImpactDepth(graph, ID_A)).toBe(4);
    // B unblocks D = 1.
    expect(computeImpactDepth(graph, ID_B)).toBe(1);
    // C unblocks D = 1.
    expect(computeImpactDepth(graph, ID_C)).toBe(1);
    expect(computeImpactDepth(graph, ID_D)).toBe(0);
  });
});

// =============================================================================
// 1. State Machine Transitions (RunPhase)
// =============================================================================

describe('RunPhase', () => {
  it('should accept all valid phase values', () => {
    const validPhases = [
      'freezing',
      'decomposing',
      'implementing',
      'maintaining',
      'judging',
      'completed',
      'failed',
    ] as const;

    for (const phase of validPhases) {
      expect(RunPhase.parse(phase)).toBe(phase);
    }
  });

  it('should have exactly seven phases', () => {
    expect(RunPhase.options).toHaveLength(7);
  });

  it('should reject an invalid phase string', () => {
    expect(() => RunPhase.parse('running')).toThrow();
    expect(() => RunPhase.parse('pending')).toThrow();
    expect(() => RunPhase.parse('')).toThrow();
  });

  it('should contain all expected phases in its options', () => {
    expect(RunPhase.options).toContain('freezing');
    expect(RunPhase.options).toContain('decomposing');
    expect(RunPhase.options).toContain('implementing');
    expect(RunPhase.options).toContain('maintaining');
    expect(RunPhase.options).toContain('judging');
    expect(RunPhase.options).toContain('completed');
    expect(RunPhase.options).toContain('failed');
  });
});

// =============================================================================
// 2. Prompt Assembly
// =============================================================================

describe('Prompt Assembly', () => {
  describe('buildCodingAgentPrompt', () => {
    it('should include bead ID, title, and frozen spec content in the prompt', async () => {
      const { readFile } = await import('node:fs/promises');
      const mockedReadFile = vi.mocked(readFile);
      mockedReadFile.mockResolvedValueOnce('# Fake Frozen Spec\nSome content here.');

      const prompt = await buildCodingAgentPrompt({
        beadId: ID_A,
        beadTitle: 'Implement feature X',
        beadDescription: 'Detailed description of feature X',
        beadType: 'task',
        beadPriority: 2,
        beadDependencies: '',
        frozenSpecPath: '/fake/path/frozen-spec.md',
        runId: 'run-test-001',
        targetBranch: 'compile/test',
      });

      expect(prompt).toContain(ID_A);
      expect(prompt).toContain('Implement feature X');
      expect(prompt).toContain('# Fake Frozen Spec');
      expect(prompt).toContain('Some content here.');
      expect(mockedReadFile).toHaveBeenCalledWith('/fake/path/frozen-spec.md', 'utf-8');
    });

    it('should include the completion checklist', async () => {
      const { readFile } = await import('node:fs/promises');
      const mockedReadFile = vi.mocked(readFile);
      mockedReadFile.mockResolvedValueOnce('spec content');

      const prompt = await buildCodingAgentPrompt({
        beadId: ID_A,
        beadTitle: 'Test bead',
        beadDescription: '',
        beadType: 'task',
        beadPriority: 1,
        beadDependencies: '',
        frozenSpecPath: '/fake/spec.md',
        runId: 'run-001',
        targetBranch: 'compile/branch',
      });

      expect(prompt).toContain('Completion Checklist');
      expect(prompt).toContain('Write code and tests');
      expect(prompt).toContain('pnpm tsc --noEmit');
      expect(prompt).toContain('pnpm build');
      expect(prompt).toContain('pnpm lint');
    });

    it('should include observation instructions with the run ID label', async () => {
      const { readFile } = await import('node:fs/promises');
      const mockedReadFile = vi.mocked(readFile);
      mockedReadFile.mockResolvedValueOnce('spec');

      const prompt = await buildCodingAgentPrompt({
        beadId: ID_B,
        beadTitle: 'Another bead',
        beadDescription: 'desc',
        beadType: 'feature',
        beadPriority: 3,
        beadDependencies: ID_A,
        frozenSpecPath: '/fake/spec.md',
        runId: 'run-xyz-789',
        targetBranch: 'compile/my-feature',
      });

      expect(prompt).toContain('Observation Beads');
      expect(prompt).toContain('compiler-run:run-xyz-789');
    });

    it('should include the target branch in push instructions', async () => {
      const { readFile } = await import('node:fs/promises');
      const mockedReadFile = vi.mocked(readFile);
      mockedReadFile.mockResolvedValueOnce('spec');

      const prompt = await buildCodingAgentPrompt({
        beadId: ID_A,
        beadTitle: 'Test',
        beadDescription: '',
        beadType: 'task',
        beadPriority: 1,
        beadDependencies: '',
        frozenSpecPath: '/fake/spec.md',
        runId: 'run-001',
        targetBranch: 'compile/unique-branch',
      });

      expect(prompt).toContain('compile/unique-branch');
      expect(prompt).toContain('git push origin HEAD:compile/unique-branch');
    });
  });

  describe('buildMaintenancePrompt', () => {
    it('should contain the target branch', () => {
      const prompt = buildMaintenancePrompt('compile/my-branch', 'run-001');
      expect(prompt).toContain('compile/my-branch');
    });

    it('should contain fix-only instructions', () => {
      const prompt = buildMaintenancePrompt('compile/test', 'run-001');
      expect(prompt).toContain('Do NOT change behavior or add features');
      expect(prompt).toContain('only fix breakage');
    });

    it('should include git fetch and push instructions for the target branch', () => {
      const prompt = buildMaintenancePrompt('compile/feature-x', 'run-002');
      expect(prompt).toContain('git fetch origin compile/feature-x');
      expect(prompt).toContain('git push origin HEAD:compile/feature-x');
    });

    it('should instruct not to create observation beads', () => {
      const prompt = buildMaintenancePrompt('compile/test', 'run-001');
      expect(prompt).toContain('Do NOT create observation beads');
    });
  });

  describe('buildJudgeReasoningPrompt', () => {
    it('should contain the frozen spec path', () => {
      const prompt = buildJudgeReasoningPrompt(
        '/path/to/frozen-spec.md',
        '/path/to/acceptance.md',
        [],
      );
      expect(prompt).toContain('/path/to/frozen-spec.md');
    });

    it('should contain the acceptance path', () => {
      const prompt = buildJudgeReasoningPrompt(
        '/path/to/frozen-spec.md',
        '/path/to/acceptance.md',
        [],
      );
      expect(prompt).toContain('/path/to/acceptance.md');
    });

    it('should include observation bead IDs when provided', () => {
      const prompt = buildJudgeReasoningPrompt('/spec.md', '/acceptance.md', [ID_A, ID_B]);
      expect(prompt).toContain(ID_A);
      expect(prompt).toContain(ID_B);
      expect(prompt).toContain('Observation Beads to Triage');
    });

    it('should omit observation section when no observation bead IDs are provided', () => {
      const prompt = buildJudgeReasoningPrompt('/spec.md', '/acceptance.md', []);
      expect(prompt).not.toContain('Observation Beads to Triage');
    });
  });

  describe('buildJudgeStructuringPrompt', () => {
    it('should contain the reasoning text', () => {
      const reasoning = 'The implementation matches the spec with minor issues.';
      const prompt = buildJudgeStructuringPrompt(reasoning);
      expect(prompt).toContain(reasoning);
    });

    it('should contain JSON structure instructions', () => {
      const prompt = buildJudgeStructuringPrompt('some reasoning');
      expect(prompt).toContain('specDrift');
      expect(prompt).toContain('acceptance');
      expect(prompt).toContain('observations');
      expect(prompt).toContain('newBeads');
      expect(prompt).toContain('JSON');
    });

    it('should instruct to return only JSON', () => {
      const prompt = buildJudgeStructuringPrompt('evaluation text');
      expect(prompt).toContain('Return ONLY the JSON object');
    });
  });
});

// =============================================================================
// 3. Agent Result Handling (toAgentResult)
// =============================================================================

describe('toAgentResult', () => {
  it('should return status timeout when timedOut is true', () => {
    const processResult: ProcessResult = {
      exitCode: 137,
      lastLines: 'killed by timeout',
      duration: 60000,
      timedOut: true,
      pid: 12345,
    };

    const result = toAgentResult(processResult);
    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBe(137);
  });

  it('should return status success when exitCode is 0 and not timed out', () => {
    const processResult: ProcessResult = {
      exitCode: 0,
      lastLines: 'all done',
      duration: 5000,
      timedOut: false,
      pid: 54321,
    };

    const result = toAgentResult(processResult);
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
  });

  it('should return status failure when exitCode is non-zero and not timed out', () => {
    const processResult: ProcessResult = {
      exitCode: 1,
      lastLines: 'error occurred',
      duration: 3000,
      timedOut: false,
      pid: 99999,
    };

    const result = toAgentResult(processResult);
    expect(result.status).toBe('failure');
    expect(result.exitCode).toBe(1);
  });

  it('should preserve lastLines from the process result', () => {
    const processResult: ProcessResult = {
      exitCode: 0,
      lastLines: 'line1\nline2\nline3',
      duration: 1000,
      timedOut: false,
      pid: 111,
    };

    const result = toAgentResult(processResult);
    expect(result.lastLines).toBe('line1\nline2\nline3');
  });

  it('should preserve duration from the process result', () => {
    const processResult: ProcessResult = {
      exitCode: 0,
      lastLines: '',
      duration: 42000,
      timedOut: false,
      pid: 222,
    };

    const result = toAgentResult(processResult);
    expect(result.duration).toBe(42000);
  });

  it('should preserve pid from the process result', () => {
    const processResult: ProcessResult = {
      exitCode: 0,
      lastLines: '',
      duration: 100,
      timedOut: false,
      pid: 77777,
    };

    const result = toAgentResult(processResult);
    expect(result.pid).toBe(77777);
  });
});

// =============================================================================
// 4. Judge Output Parsing (JudgeResultSchema)
// =============================================================================

describe('JudgeResultSchema', () => {
  const validJudgeResult = {
    status: 'success',
    specDrift: {
      detected: true,
      issues: [{ section: 'Auth module', description: 'Missing OAuth flow', severity: 'critical' }],
    },
    acceptance: {
      passed: false,
      results: [
        { criterion: 'Login works', passed: true, evidence: 'Test passes in auth.test.ts' },
        { criterion: 'OAuth support', passed: false, evidence: 'No OAuth code found' },
      ],
    },
    observations: [{ beadId: ID_A, action: 'promote', reason: 'Needs implementation' }],
    newBeads: [{ title: 'Add OAuth provider', description: 'Implement OAuth flow', type: 'task' }],
    lastLines: 'Evaluation complete.',
    duration: 15000,
  };

  it('should parse a valid full JudgeResult object successfully', () => {
    const parsed = JudgeResultSchema.parse(validJudgeResult);
    expect(parsed.status).toBe('success');
    expect(parsed.specDrift.detected).toBe(true);
    expect(parsed.specDrift.issues).toHaveLength(1);
    expect(parsed.acceptance.passed).toBe(false);
    expect(parsed.acceptance.results).toHaveLength(2);
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.newBeads).toHaveLength(1);
    expect(parsed.lastLines).toBe('Evaluation complete.');
    expect(parsed.duration).toBe(15000);
  });

  it('should reject when required fields are missing', () => {
    // Missing status
    expect(() => JudgeResultSchema.parse({ specDrift: { detected: false, issues: [] } })).toThrow();

    // Missing specDrift
    expect(() =>
      JudgeResultSchema.parse({
        status: 'success',
        acceptance: { passed: true, results: [] },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 0,
      }),
    ).toThrow();

    // Missing acceptance
    expect(() =>
      JudgeResultSchema.parse({
        status: 'success',
        specDrift: { detected: false, issues: [] },
        observations: [],
        newBeads: [],
        lastLines: '',
        duration: 0,
      }),
    ).toThrow();
  });

  it('should reject invalid severity values', () => {
    const badSeverity = {
      ...validJudgeResult,
      specDrift: {
        detected: true,
        issues: [{ section: 'A', description: 'B', severity: 'catastrophic' }],
      },
    };
    expect(() => JudgeResultSchema.parse(badSeverity)).toThrow();
  });

  it('should reject invalid action values', () => {
    const badAction = {
      ...validJudgeResult,
      observations: [{ beadId: ID_A, action: 'delete', reason: 'bad action' }],
    };
    expect(() => JudgeResultSchema.parse(badAction)).toThrow();
  });

  it('should accept valid severity values', () => {
    for (const severity of ['critical', 'major', 'minor']) {
      const result = {
        ...validJudgeResult,
        specDrift: {
          detected: true,
          issues: [{ section: 'S', description: 'D', severity }],
        },
      };
      expect(() => JudgeResultSchema.parse(result)).not.toThrow();
    }
  });

  it('should accept valid action values', () => {
    for (const action of ['promote', 'dismiss', 'merge']) {
      const result = {
        ...validJudgeResult,
        observations: [{ beadId: ID_A, action, reason: 'test' }],
      };
      expect(() => JudgeResultSchema.parse(result)).not.toThrow();
    }
  });
});

// =============================================================================
// 5. Event Log Serialization (CompilerEventSchema)
// =============================================================================

describe('CompilerEventSchema', () => {
  it('should parse a valid event with v:1 and ts', () => {
    const event = {
      v: 1,
      ts: '2026-01-15T10:30:00Z',
      event: 'bead_started',
    };
    const parsed = CompilerEventSchema.parse(event);
    expect(parsed.v).toBe(1);
    expect(parsed.ts).toBe('2026-01-15T10:30:00Z');
    expect(parsed.event).toBe('bead_started');
  });

  it('should reject v:2 (must be literal 1)', () => {
    const event = {
      v: 2,
      ts: '2026-01-15T10:30:00Z',
      event: 'bead_started',
    };
    expect(() => CompilerEventSchema.parse(event)).toThrow();
  });

  it('should reject missing ts', () => {
    const event = {
      v: 1,
      event: 'bead_started',
    };
    expect(() => CompilerEventSchema.parse(event)).toThrow();
  });

  it('should reject missing v', () => {
    const event = {
      ts: '2026-01-15T10:30:00Z',
      event: 'bead_started',
    };
    expect(() => CompilerEventSchema.parse(event)).toThrow();
  });

  it('should preserve extra passthrough fields', () => {
    const event = {
      v: 1,
      ts: '2026-01-15T10:30:00Z',
      event: 'agent_spawned',
      beadId: ID_A,
      agentId: 7,
      customField: 'extra data',
    };
    const parsed = CompilerEventSchema.parse(event);
    expect(parsed.beadId).toBe(ID_A);
    expect(parsed.agentId).toBe(7);
    expect(parsed.customField).toBe('extra data');
  });

  it('should reject an invalid ts format (not datetime)', () => {
    const event = {
      v: 1,
      ts: 'not-a-date',
      event: 'test',
    };
    expect(() => CompilerEventSchema.parse(event)).toThrow();
  });
});

// =============================================================================
// 6. CLI Exit Code Mapping and JSON Error Envelope
// =============================================================================

describe('ERROR_CODE_EXIT_MAP', () => {
  it('should map E_SPEC_NOT_FOUND to exit code 2', () => {
    expect(ERROR_CODE_EXIT_MAP.E_SPEC_NOT_FOUND).toBe(2);
  });

  it('should map E_RUN_LOCKED to exit code 3', () => {
    expect(ERROR_CODE_EXIT_MAP.E_RUN_LOCKED).toBe(3);
  });

  it('should map E_DEADLOCK to exit code 4', () => {
    expect(ERROR_CODE_EXIT_MAP.E_DEADLOCK).toBe(4);
  });

  it('should map E_MAX_ITERATIONS to exit code 5', () => {
    expect(ERROR_CODE_EXIT_MAP.E_MAX_ITERATIONS).toBe(5);
  });

  it('should map E_GRAPH_CYCLE to exit code 4', () => {
    expect(ERROR_CODE_EXIT_MAP.E_GRAPH_CYCLE).toBe(4);
  });

  it('should map E_MAX_RUNTIME to exit code 5', () => {
    expect(ERROR_CODE_EXIT_MAP.E_MAX_RUNTIME).toBe(5);
  });
});

describe('CompilerError', () => {
  it('should have the correct code and exitCode', () => {
    const err = new CompilerError('spec not found', 'E_SPEC_NOT_FOUND', 2);
    expect(err.code).toBe('E_SPEC_NOT_FOUND');
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('spec not found');
  });

  it('should be an instance of CLIError', () => {
    const err = new CompilerError('locked', 'E_RUN_LOCKED', 3);
    expect(err).toBeInstanceOf(CLIError);
  });

  it('should be an instance of Error', () => {
    const err = new CompilerError('deadlock', 'E_DEADLOCK', 4);
    expect(err).toBeInstanceOf(Error);
  });

  it('should have name set to CompilerError', () => {
    const err = new CompilerError('test', 'E_SPEC_NOT_FOUND', 2);
    expect(err.name).toBe('CompilerError');
  });
});

// =============================================================================
// 7. Schema Version Validation (CheckpointSchema)
// =============================================================================

describe('CheckpointSchema version validation', () => {
  const validCheckpoint = {
    schemaVersion: 1,
    runId: 'run-test-001',
    specPath: '/path/to/spec.md',
    frozenSpecPath: '/path/to/frozen-spec.md',
    frozenSpecSha256: 'abc123def456',
    targetBranch: 'compile/test',
    baseBranch: 'main',
    state: 'implementing',
    iteration: 1,
    beads: {
      total: 3,
      completed: [ID_A],
      inProgress: [ID_B],
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
  };

  it('should accept schemaVersion 1', () => {
    const parsed = CheckpointSchema.parse(validCheckpoint);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('should reject schemaVersion 2 (literal 1 required)', () => {
    const bad = { ...validCheckpoint, schemaVersion: 2 };
    expect(() => CheckpointSchema.parse(bad)).toThrow();
  });

  it('should reject missing schemaVersion', () => {
    const { schemaVersion: _, ...noVersion } = validCheckpoint;
    expect(() => CheckpointSchema.parse(noVersion)).toThrow();
  });

  it('should reject schemaVersion 0', () => {
    const bad = { ...validCheckpoint, schemaVersion: 0 };
    expect(() => CheckpointSchema.parse(bad)).toThrow();
  });

  it('should parse a complete valid checkpoint with all fields', () => {
    const parsed = CheckpointSchema.parse(validCheckpoint);
    expect(parsed.runId).toBe('run-test-001');
    expect(parsed.state).toBe('implementing');
    expect(parsed.beads.total).toBe(3);
    expect(parsed.beads.completed).toEqual([ID_A]);
    expect(parsed.beads.inProgress).toEqual([ID_B]);
    expect(parsed.agents.maxConcurrency).toBe(4);
  });
});

// =============================================================================
// 8. Pre-existing Bead Selector (E_BEAD_SCOPE_AMBIGUOUS)
// =============================================================================

describe('E_BEAD_SCOPE_AMBIGUOUS', () => {
  it('should be a valid CompilerErrorCode', () => {
    const parsed = CompilerErrorCode.parse('E_BEAD_SCOPE_AMBIGUOUS');
    expect(parsed).toBe('E_BEAD_SCOPE_AMBIGUOUS');
  });

  it('should map to exit code 2 in ERROR_CODE_EXIT_MAP', () => {
    expect(ERROR_CODE_EXIT_MAP.E_BEAD_SCOPE_AMBIGUOUS).toBe(2);
  });

  it('should reject an invalid error code', () => {
    expect(() => CompilerErrorCode.parse('E_NONEXISTENT')).toThrow();
  });
});
