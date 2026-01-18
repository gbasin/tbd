/**
 * Tree view utilities for displaying issues with parent-child relationships.
 *
 * Used by `tbd list --pretty` to show hierarchical issue structure.
 */

import type { createColors } from './output.js';
import { formatPriority, getPriorityColor } from '../../lib/priority.js';
import { getStatusIcon, getStatusColor } from '../../lib/status.js';
import { formatKind, type IssueForDisplay } from './issueFormat.js';

/**
 * Tree node representing an issue with its children.
 */
export interface TreeNode {
  issue: IssueForDisplay;
  children: TreeNode[];
}

/**
 * Unicode box-drawing characters for tree display.
 */
const TREE_CHARS = {
  /** Middle child connector: ├── */
  BRANCH: '├── ',
  /** Last child connector: └── */
  LAST: '└── ',
  /** Vertical line continuation: │    */
  VERTICAL: '│   ',
  /** Empty space for alignment:      */
  SPACE: '    ',
} as const;

/**
 * Build a tree structure from a flat list of issues.
 *
 * Groups children under their parents based on parent_id.
 * Issues without a parent (or whose parent is not in the list) become root nodes.
 *
 * @param issues - Flat list of issues with optional parent_id
 * @returns Array of root tree nodes with nested children
 */
export function buildIssueTree(issues: (IssueForDisplay & { parentId?: string })[]): TreeNode[] {
  // Create a map for quick lookup by ID
  const issueMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // First pass: create nodes for all issues
  for (const issue of issues) {
    issueMap.set(issue.id, { issue, children: [] });
  }

  // Second pass: build parent-child relationships
  for (const issue of issues) {
    const node = issueMap.get(issue.id)!;

    if (issue.parentId && issueMap.has(issue.parentId)) {
      // Has a parent that's in our list - add as child
      const parentNode = issueMap.get(issue.parentId)!;
      parentNode.children.push(node);
    } else {
      // No parent or parent not in list - this is a root
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Format a single issue line for tree view (no header, compact format).
 *
 * Format: {ID}  {PRI}  {STATUS}  [kind] {TITLE}
 */
function formatTreeIssueLine(
  issue: IssueForDisplay,
  colors: ReturnType<typeof createColors>,
): string {
  const id = colors.id(issue.id);
  const pri = getPriorityColor(issue.priority, colors)(formatPriority(issue.priority));
  const statusText = `${getStatusIcon(issue.status)} ${issue.status}`;
  const status = getStatusColor(issue.status, colors)(statusText);
  const kind = colors.dim(formatKind(issue.kind));

  return `${id}  ${pri}  ${status}  ${kind} ${issue.title}`;
}

/**
 * Render a tree node and its children as formatted lines.
 *
 * @param node - The tree node to render
 * @param colors - Color functions for formatting
 * @param prefix - Current line prefix (for nested indentation)
 * @param isLast - Whether this is the last sibling at its level
 * @returns Array of formatted lines
 */
function renderTreeNode(
  node: TreeNode,
  colors: ReturnType<typeof createColors>,
  prefix = '',
  _isLast = true,
): string[] {
  const lines: string[] = [];

  // Render this node
  const issueLine = formatTreeIssueLine(node.issue, colors);
  lines.push(prefix + issueLine);

  // Render children
  const childCount = node.children.length;
  node.children.forEach((child, index) => {
    const isLastChild = index === childCount - 1;

    // Determine the connector for this child
    const connector = isLastChild ? TREE_CHARS.LAST : TREE_CHARS.BRANCH;

    // Determine the prefix for grandchildren
    // If this child is not last, we need a vertical line; otherwise space
    const childPrefix = prefix + (isLastChild ? TREE_CHARS.SPACE : TREE_CHARS.VERTICAL);

    // Render child with its prefix
    const childLines = renderTreeNode(child, colors, '', isLastChild);

    // Add connector to first line, maintain prefix for continuation lines
    childLines.forEach((line, lineIndex) => {
      if (lineIndex === 0) {
        lines.push(colors.dim(connector) + line);
      } else {
        lines.push(childPrefix + line);
      }
    });
  });

  return lines;
}

/**
 * Render a complete tree view of issues.
 *
 * @param roots - Array of root tree nodes
 * @param colors - Color functions for formatting
 * @returns Array of formatted lines (without header, count is separate)
 */
export function renderIssueTree(
  roots: TreeNode[],
  colors: ReturnType<typeof createColors>,
): string[] {
  const lines: string[] = [];

  for (const root of roots) {
    const rootLines = renderTreeNode(root, colors, '', true);
    lines.push(...rootLines);
  }

  return lines;
}

/**
 * Count total issues in a tree (including all nested children).
 */
export function countTreeIssues(roots: TreeNode[]): number {
  let count = 0;

  function countNode(node: TreeNode): void {
    count++;
    for (const child of node.children) {
      countNode(child);
    }
  }

  for (const root of roots) {
    countNode(root);
  }

  return count;
}
