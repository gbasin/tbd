/**
 * Critical-path scheduler for the compiler.
 *
 * Picks beads in order: max fan-out (impact depth) DESC → priority ASC → created ASC.
 * Detects deadlocks and external blockers.
 */

import type { Issue } from '../../../lib/types.js';
import {
  buildDependencyGraph,
  detectCycles,
  computeAllImpactDepths,
  type DependencyGraph,
} from '../../../lib/compiler/graph.js';
import { comparisonChain, ordering } from '../../../lib/comparison-chain.js';

export class Scheduler {
  private graph: DependencyGraph;
  private impactDepths: Map<string, number>;
  private issueMap: Map<string, Issue>;

  constructor(private readonly runBeadIds: Set<string>) {
    this.graph = { forward: new Map(), reverse: new Map(), roots: [], allIds: new Set() };
    this.impactDepths = new Map();
    this.issueMap = new Map();
  }

  /**
   * Rebuild the dependency graph from a fresh list of issues.
   * Call this before each scheduling cycle.
   */
  rebuild(allIssues: Issue[]): void {
    // Build graph from ALL issues so external blocker edges are visible.
    // (tbd stores deps inversely — external blockers carry `blocks` edges for run beads.)
    this.issueMap = new Map(allIssues.map((i) => [i.id, i]));

    this.graph = buildDependencyGraph(allIssues);
    this.impactDepths = computeAllImpactDepths(this.graph);
  }

  /**
   * Check for cycles in the dependency graph. Should be called once after initial build.
   * Returns cycle lists (empty if no cycles).
   */
  checkCycles(): string[][] {
    return detectCycles(this.graph);
  }

  /**
   * Pick the next ready bead to assign.
   * Returns null if no beads are ready.
   */
  pickNext(
    completedIds: Set<string>,
    inProgressIds: Set<string>,
    blockedIds: Set<string>,
  ): Issue | null {
    const ready = this.getReadyBeads(completedIds, inProgressIds, blockedIds);
    if (ready.length === 0) return null;

    // Sort: impact depth DESC, priority ASC, created_at ASC
    ready.sort(
      comparisonChain<Issue>()
        .compare((i) => this.impactDepths.get(i.id) ?? 0, ordering.reversed)
        .compare((i) => i.priority)
        .compare((i) => i.created_at)
        .result(),
    );

    return ready[0]!;
  }

  /**
   * Get all beads that are ready to be assigned.
   */
  private getReadyBeads(
    completedIds: Set<string>,
    inProgressIds: Set<string>,
    blockedIds: Set<string>,
  ): Issue[] {
    const ready: Issue[] = [];

    for (const id of this.runBeadIds) {
      // Skip completed, in-progress, or blocked beads
      if (completedIds.has(id) || inProgressIds.has(id) || blockedIds.has(id)) continue;

      const issue = this.issueMap.get(id);
      if (!issue || issue.status === 'closed') continue;

      // Check if all blockers are resolved
      const blockers = this.graph.reverse.get(id) ?? [];
      const hasUnresolvedBlocker = blockers.some((blockerId) => {
        // If blocker is a run bead, check if it's completed
        if (this.runBeadIds.has(blockerId)) {
          return !completedIds.has(blockerId);
        }
        // If blocker is external, check if it's closed
        const blocker = this.issueMap.get(blockerId);
        return blocker ? blocker.status !== 'closed' : false;
      });

      if (!hasUnresolvedBlocker) {
        ready.push(issue);
      }
    }

    return ready;
  }

  /** Get the dependency IDs (blockers) for a bead. */
  getDependencyIds(beadId: string): string[] {
    return this.graph.reverse.get(beadId) ?? [];
  }

  /** Get an issue by ID. */
  getIssue(id: string): Issue | undefined {
    return this.issueMap.get(id);
  }

  /**
   * Detect deadlock: no ready beads, no active agents, but open beads remain.
   */
  detectDeadlock(
    completedIds: Set<string>,
    inProgressIds: Set<string>,
    blockedIds: Set<string>,
    activeAgentCount: number,
  ): { deadlocked: boolean; reason: string } {
    if (activeAgentCount > 0) {
      return { deadlocked: false, reason: '' };
    }

    const ready = this.getReadyBeads(completedIds, inProgressIds, blockedIds);
    if (ready.length > 0) {
      return { deadlocked: false, reason: '' };
    }

    // Check if there are any remaining open beads (exclude in-progress — they may still complete)
    const openBeads: string[] = [];
    for (const id of this.runBeadIds) {
      if (!completedIds.has(id) && !blockedIds.has(id) && !inProgressIds.has(id)) {
        openBeads.push(id);
      }
    }

    if (openBeads.length === 0) {
      return { deadlocked: false, reason: '' };
    }

    return {
      deadlocked: true,
      reason:
        `Deadlock: ${openBeads.length} open bead(s) but none are ready and no agents are running. ` +
        `Unready beads: ${openBeads.join(', ')}`,
    };
  }

  /**
   * Detect external blockers: remaining beads blocked by non-run beads.
   */
  detectExternalBlockers(
    completedIds: Set<string>,
    blockedIds: Set<string>,
  ): { blocked: boolean; chains: string[] } {
    const chains: string[] = [];

    for (const id of this.runBeadIds) {
      if (completedIds.has(id) || blockedIds.has(id)) continue;

      const blockers = this.graph.reverse.get(id) ?? [];
      for (const blockerId of blockers) {
        if (!this.runBeadIds.has(blockerId)) {
          const blocker = this.issueMap.get(blockerId);
          if (blocker && blocker.status !== 'closed') {
            chains.push(`${id} blocked by external bead ${blockerId} (${blocker.title})`);
          }
        }
      }
    }

    return { blocked: chains.length > 0, chains };
  }
}
