/**
 * Tests for the tbd compile orchestrator subsystem.
 *
 * Covers pure-logic units only: Scheduler, config parsing, and graph utilities.
 * No process spawning, git operations, or file I/O.
 */

import { describe, it, expect } from 'vitest';

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
