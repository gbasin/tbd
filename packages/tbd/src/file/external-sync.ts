/**
 * External issue synchronization: pull/push status and labels between
 * local beads and linked GitHub Issues.
 *
 * Pull: read GitHub issue state → update local bead status
 * Push: read local bead status → update GitHub issue state
 *
 * Uses the staging-area model: local create/update/close have no external
 * side effects. External sync only happens during `tbd sync`.
 *
 * See: plan-2026-02-10-external-issue-linking.md §3b
 */

import type { Issue } from '../lib/types.js';
import type { OperationLogger } from '../lib/types.js';
import {
  parseGitHubIssueUrl,
  getGitHubIssueState,
  closeGitHubIssue,
  reopenGitHubIssue,
  githubToTbdStatus,
  TBD_TO_GITHUB_STATUS,
  type GitHubIssueRef,
} from './github-issues.js';

// =============================================================================
// Types
// =============================================================================

export interface ExternalSyncResult {
  pulled: number;
  pushed: number;
  errors: string[];
}

// =============================================================================
// External Pull
// =============================================================================

/**
 * Pull: fetch GitHub issue states and update local bead statuses.
 *
 * For each bead with an external_issue_url:
 * 1. Parse the GitHub issue URL
 * 2. Fetch the current GitHub issue state
 * 3. Map GitHub state to tbd status
 * 4. Update the bead if status changed
 *
 * @returns Number of beads updated and any errors
 */
export async function externalPull(
  issues: Issue[],
  writeIssueFn: (issue: Issue) => Promise<void>,
  timestamp: string,
  logger: OperationLogger,
): Promise<{ pulled: number; errors: string[] }> {
  const linked = issues.filter((i) => i.external_issue_url);
  if (linked.length === 0) {
    return { pulled: 0, errors: [] };
  }

  logger.progress(`Checking ${linked.length} linked issue(s)...`);
  let pulled = 0;
  const errors: string[] = [];

  for (const issue of linked) {
    const ref = parseGitHubIssueUrl(issue.external_issue_url!);
    if (!ref) {
      errors.push(`${issue.id}: invalid external_issue_url: ${issue.external_issue_url}`);
      continue;
    }

    try {
      const ghState = await getGitHubIssueState(ref);
      const newStatus = githubToTbdStatus(ghState.state, ghState.state_reason, issue.status);

      if (newStatus) {
        logger.info(`${issue.id}: ${issue.status} → ${newStatus} (from GitHub)`);
        issue.status = newStatus as Issue['status'];
        if (newStatus === 'closed') {
          issue.closed_at = timestamp;
        }
        issue.version += 1;
        issue.updated_at = timestamp;
        await writeIssueFn(issue);
        pulled++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${issue.id}: failed to fetch GitHub state: ${msg}`);
      logger.warn(`${issue.id}: ${msg}`);
    }
  }

  return { pulled, errors };
}

// =============================================================================
// External Push
// =============================================================================

/**
 * Push: push local bead statuses to linked GitHub Issues.
 *
 * For each bead with an external_issue_url:
 * 1. Parse the GitHub issue URL
 * 2. Map tbd status to GitHub state
 * 3. Update GitHub issue if state differs
 *
 * @returns Number of GitHub issues updated and any errors
 */
export async function externalPush(
  issues: Issue[],
  logger: OperationLogger,
): Promise<{ pushed: number; errors: string[] }> {
  const linked = issues.filter((i) => i.external_issue_url);
  if (linked.length === 0) {
    return { pushed: 0, errors: [] };
  }

  logger.progress(`Pushing status to ${linked.length} linked issue(s)...`);
  let pushed = 0;
  const errors: string[] = [];

  for (const issue of linked) {
    const ref = parseGitHubIssueUrl(issue.external_issue_url!);
    if (!ref) {
      errors.push(`${issue.id}: invalid external_issue_url: ${issue.external_issue_url}`);
      continue;
    }

    const mapping = TBD_TO_GITHUB_STATUS[issue.status];
    if (mapping === null || mapping === undefined) {
      // blocked → no change on GitHub
      logger.debug(`${issue.id}: status ${issue.status} has no GitHub mapping, skipping`);
      continue;
    }

    try {
      const ghState = await getGitHubIssueState(ref);

      // Only push if the state actually differs
      if (ghState.state === mapping.state) {
        continue; // Already in sync
      }

      await pushStatusToGitHub(ref, mapping, logger, issue.id);
      pushed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${issue.id}: failed to push to GitHub: ${msg}`);
      logger.warn(`${issue.id}: ${msg}`);
    }
  }

  return { pushed, errors };
}

async function pushStatusToGitHub(
  ref: GitHubIssueRef,
  mapping: { state: 'open' | 'closed'; state_reason?: 'completed' | 'not_planned' },
  logger: OperationLogger,
  issueId: string,
): Promise<void> {
  if (mapping.state === 'closed') {
    logger.info(`${issueId}: closing GitHub issue (${mapping.state_reason ?? 'completed'})`);
    await closeGitHubIssue(ref, mapping.state_reason ?? 'completed');
  } else {
    logger.info(`${issueId}: reopening GitHub issue`);
    await reopenGitHubIssue(ref);
  }
}
