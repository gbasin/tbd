/**
 * Golden / snapshot tests for compiler subsystem outputs.
 *
 * These tests verify deterministic outputs against known inputs using
 * vitest snapshot testing. Snapshots are auto-generated on first run
 * and verified on subsequent runs.
 *
 * Run `pnpm test -- -u` to update snapshots after intentional changes.
 */

import { vi, describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Mock readFile BEFORE importing prompts so the module picks up the mock.
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', async (importOriginal) => {
  return {
    ...(await importOriginal()),
    readFile: vi
      .fn()
      .mockResolvedValue(
        '# Test Spec\n\nThis is the frozen spec content for testing.\n\n## Features\n- Feature A\n- Feature B',
      ),
  };
});

import {
  buildCodingAgentPrompt,
  buildMaintenancePrompt,
  buildJudgeReasoningPrompt,
  buildJudgeStructuringPrompt,
} from '../src/cli/lib/compiler/prompts.js';

import { Scheduler } from '../src/cli/lib/compiler/scheduler.js';
import { buildDependencyGraph } from '../src/lib/compiler/graph.js';
import type { Issue } from '../src/lib/types.js';

// =============================================================================
// Test Helpers
// =============================================================================

// Valid ULID-style issue IDs for deterministic test data.
const ID_A = 'is-00000000000000000000000001';
const ID_B = 'is-00000000000000000000000002';
const ID_C = 'is-00000000000000000000000003';
const ID_D = 'is-00000000000000000000000004';
const ID_E = 'is-00000000000000000000000005';

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

// =============================================================================
// Prompt Snapshots
// =============================================================================

describe('compiler golden tests', () => {
  describe('prompt snapshots', () => {
    it('should produce a deterministic coding agent prompt', async () => {
      const prompt = await buildCodingAgentPrompt({
        beadId: 'is-01HX5ZZK',
        beadTitle: 'Implement user authentication middleware',
        beadDescription: 'Create Express middleware for JWT validation',
        beadType: 'task',
        beadPriority: 1,
        beadDependencies: 'is-X9Y8 (closed), is-Z1W2 (closed)',
        frozenSpecPath: '/fake/path/frozen-spec.md',
        runId: 'run-2026-02-12-a1b2c3',
        targetBranch: 'tbd-compile/run-2026-02-12-a1b2c3',
      });

      expect(prompt).toMatchSnapshot();
    });

    it('should produce a deterministic judge reasoning prompt', () => {
      const prompt = buildJudgeReasoningPrompt(
        '/path/to/frozen-spec.md',
        '/home/user/.cache/tbd-compiler/run-abc/acceptance/',
        ['obs-1', 'obs-2'],
      );

      expect(prompt).toMatchSnapshot();
    });

    it('should produce judge reasoning prompt without observations', () => {
      const prompt = buildJudgeReasoningPrompt(
        '/path/to/frozen-spec.md',
        '/path/to/acceptance/',
        [],
      );

      expect(prompt).toMatchSnapshot();
    });

    it('should produce a deterministic judge structuring prompt', () => {
      const prompt = buildJudgeStructuringPrompt(
        'The implementation covers all spec sections. Feature A works correctly. Feature B has a minor issue with edge case handling.',
      );

      expect(prompt).toMatchSnapshot();
    });

    it('should produce a deterministic maintenance prompt', () => {
      const prompt = buildMaintenancePrompt(
        'tbd-compile/run-2026-02-12-a1b2c3',
        'run-2026-02-12-a1b2c3',
      );

      expect(prompt).toMatchSnapshot();
    });
  });

  // ===========================================================================
  // Scheduler Schedule Snapshot
  // ===========================================================================

  describe('scheduler schedule snapshot', () => {
    it('should produce a deterministic schedule for a known graph', () => {
      // Diamond: A blocks B and C. B and C both block D. Plus independent E.
      const issues = [
        makeIssue({
          id: ID_A,
          title: 'Setup types',
          priority: 2,
          dependencies: [
            { type: 'blocks', target: ID_B },
            { type: 'blocks', target: ID_C },
          ],
        }),
        makeIssue({
          id: ID_B,
          title: 'Implement auth',
          priority: 1,
          dependencies: [{ type: 'blocks', target: ID_D }],
        }),
        makeIssue({
          id: ID_C,
          title: 'Implement API',
          priority: 2,
          dependencies: [{ type: 'blocks', target: ID_D }],
        }),
        makeIssue({ id: ID_D, title: 'Integration tests', priority: 3 }),
        makeIssue({ id: ID_E, title: 'Update docs', priority: 4 }),
      ];

      const allIds = new Set(issues.map((i) => i.id));
      const scheduler = new Scheduler(allIds);
      scheduler.rebuild(issues);

      // Simulate picking beads in scheduler order
      const schedule: string[] = [];
      const completed = new Set<string>();

      let next = scheduler.pickNext(completed, new Set(), new Set());
      while (next) {
        schedule.push(`${next.id} (${next.title})`);
        completed.add(next.id);
        next = scheduler.pickNext(completed, new Set(), new Set());
      }

      expect(schedule).toMatchSnapshot();
    });
  });

  // ===========================================================================
  // Dependency Graph Snapshot
  // ===========================================================================

  describe('dependency graph snapshot', () => {
    it('should produce a deterministic dependency graph for known beads', () => {
      const issues = [
        makeIssue({
          id: ID_A,
          dependencies: [
            { type: 'blocks', target: ID_B },
            { type: 'blocks', target: ID_C },
          ],
        }),
        makeIssue({
          id: ID_B,
          dependencies: [{ type: 'blocks', target: ID_D }],
        }),
        makeIssue({
          id: ID_C,
          dependencies: [{ type: 'blocks', target: ID_D }],
        }),
        makeIssue({ id: ID_D }),
      ];

      const graph = buildDependencyGraph(issues);

      // Convert Maps to sorted objects for snapshot stability
      const snapshot = {
        forward: Object.fromEntries(
          [...graph.forward.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
        reverse: Object.fromEntries(
          [...graph.reverse.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
        roots: [...graph.roots].sort(),
        allIds: [...graph.allIds].sort(),
      };

      expect(snapshot).toMatchSnapshot();
    });
  });
});
