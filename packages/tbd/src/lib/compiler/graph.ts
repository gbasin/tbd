/**
 * Dependency graph construction and analysis.
 *
 * Shared between `tbd ready` and the compiler scheduler.
 *
 * IMPORTANT: tbd stores dependencies inversely.
 * `tbd dep add A B` ("A depends on B") stores `{type: blocks, target: A}` on issue B.
 * This means: B.dependencies = [{type: 'blocks', target: A}] — "B blocks A".
 */

import type { Issue } from '../types.js';

// =============================================================================
// Types
// =============================================================================

export interface DependencyGraph {
  /** issueId → list of issues it blocks (forward edges) */
  forward: Map<string, string[]>;
  /** issueId → list of issues that block it (reverse edges) */
  reverse: Map<string, string[]>;
  /** Issues with no unresolved blockers */
  roots: string[];
  /** All issue IDs in the graph */
  allIds: Set<string>;
}

// =============================================================================
// Graph Construction
// =============================================================================

/**
 * Build a dependency graph from a list of issues.
 *
 * Uses tbd's inverted dependency storage:
 * issue.dependencies[].type === 'blocks' means this issue blocks dep.target.
 */
export function buildDependencyGraph(issues: Issue[]): DependencyGraph {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const allIds = new Set(issues.map((i) => i.id));
  const issueMap = new Map(issues.map((i) => [i.id, i]));

  for (const issue of issues) {
    for (const dep of issue.dependencies) {
      if (dep.type === 'blocks') {
        // issue blocks dep.target → forward edge from issue to target
        const fwd = forward.get(issue.id) ?? [];
        fwd.push(dep.target);
        forward.set(issue.id, fwd);

        // dep.target is blocked by issue → reverse edge
        const rev = reverse.get(dep.target) ?? [];
        rev.push(issue.id);
        reverse.set(dep.target, rev);
      }
    }
  }

  // Roots: issues with no unresolved blockers (among the provided issues)
  const roots = issues
    .filter((i) => {
      const blockers = reverse.get(i.id) ?? [];
      return !blockers.some((blockerId) => {
        const blocker = issueMap.get(blockerId);
        return blocker && blocker.status !== 'closed';
      });
    })
    .map((i) => i.id);

  return { forward, reverse, roots, allIds };
}

// =============================================================================
// Cycle Detection (Tarjan's SCC)
// =============================================================================

/**
 * Detect cycles in the dependency graph using Tarjan's SCC algorithm.
 * Returns list of cycles (each cycle is a list of issue IDs with length > 1).
 */
export function detectCycles(graph: DependencyGraph): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const successors = graph.forward.get(v) ?? [];
    for (const w of successors) {
      if (!graph.allIds.has(w)) continue; // skip external refs
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      // Only report SCCs with more than one node (actual cycles)
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const id of graph.allIds) {
    if (!indices.has(id)) {
      strongconnect(id);
    }
  }

  return sccs;
}

// =============================================================================
// Impact Depth (Fan-out analysis)
// =============================================================================

/**
 * Compute impact depth for an issue: how many downstream issues it transitively unblocks.
 * Higher impact depth = higher scheduling priority (foundation beads first).
 */
export function computeImpactDepth(graph: DependencyGraph, issueId: string): number {
  const visited = new Set<string>();

  function dfs(id: string): number {
    if (visited.has(id)) return 0;
    visited.add(id);

    const successors = graph.forward.get(id) ?? [];
    let count = 0;
    for (const s of successors) {
      if (graph.allIds.has(s)) {
        count += 1 + dfs(s);
      }
    }
    return count;
  }

  return dfs(issueId);
}

/**
 * Compute impact depth for all issues in the graph.
 */
export function computeAllImpactDepths(graph: DependencyGraph): Map<string, number> {
  const depths = new Map<string, number>();
  for (const id of graph.allIds) {
    depths.set(id, computeImpactDepth(graph, id));
  }
  return depths;
}

// =============================================================================
// Topological Sort (Kahn's Algorithm)
// =============================================================================

/**
 * Topological sort of the dependency graph using Kahn's algorithm.
 * Returns issues in dependency-respecting order (dependencies first).
 * Throws if the graph contains cycles.
 */
export function topologicalSort(graph: DependencyGraph): string[] {
  // Count in-degree for each node (number of unresolved blockers within the graph)
  const inDegree = new Map<string, number>();
  for (const id of graph.allIds) {
    inDegree.set(id, 0);
  }

  for (const [, targets] of graph.forward) {
    for (const target of targets) {
      if (graph.allIds.has(target)) {
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }
  }

  // Start with nodes that have no in-edges
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    const successors = graph.forward.get(node) ?? [];
    for (const s of successors) {
      if (!graph.allIds.has(s)) continue;
      const newDegree = (inDegree.get(s) ?? 1) - 1;
      inDegree.set(s, newDegree);
      if (newDegree === 0) {
        queue.push(s);
      }
    }
  }

  if (sorted.length !== graph.allIds.size) {
    throw new Error('Dependency graph contains cycles — cannot topologically sort');
  }

  return sorted;
}
