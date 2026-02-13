/**
 * Ephemeral worktree management for the compiler.
 *
 * Creates per-agent, per-maintenance, and per-judge worktrees under .tbd/worktrees/.
 * All worktrees are ephemeral — created fresh per bead and deleted after completion.
 */

import { execFile } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { COMPILER_WORKTREES_DIR } from '../../../lib/paths.js';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  private readonly worktreesDir: string;

  constructor(private readonly repoRoot: string) {
    this.worktreesDir = join(repoRoot, COMPILER_WORKTREES_DIR);
  }

  /**
   * Create a worktree for a coding agent.
   * Branch name: tbd-compile/<run-id>/bead-<first-8-chars-of-ulid>
   */
  async createAgentWorktree(runId: string, beadId: string, targetBranch: string): Promise<string> {
    const shortId = beadId.replace(/^is-/, '').slice(0, 8);
    const branchName = `tbd-compile/${runId}/bead-${shortId}`;
    const worktreePath = join(this.worktreesDir, `agent-${shortId}`);

    await this.createWorktree(worktreePath, branchName, targetBranch);
    return worktreePath;
  }

  /**
   * Create a worktree for maintenance.
   */
  async createMaintenanceWorktree(
    runId: string,
    maintIndex: number,
    targetBranch: string,
  ): Promise<string> {
    const worktreePath = join(this.worktreesDir, `maint-${maintIndex}`);
    const branchName = `tbd-compile/${runId}/maint-${maintIndex}`;

    await this.createWorktree(worktreePath, branchName, targetBranch);
    return worktreePath;
  }

  /**
   * Create a worktree for the judge.
   */
  async createJudgeWorktree(targetBranch: string, iteration: number): Promise<string> {
    const worktreePath = join(this.worktreesDir, `judge-${iteration}`);

    // Fetch latest from remote
    await execFileAsync('git', ['-C', this.repoRoot, 'fetch', 'origin', targetBranch]);

    // Create worktree from remote branch (detached for read-only)
    await mkdir(this.worktreesDir, { recursive: true });
    await execFileAsync('git', [
      '-C',
      this.repoRoot,
      'worktree',
      'add',
      '--detach',
      worktreePath,
      `origin/${targetBranch}`,
    ]);

    return worktreePath;
  }

  /**
   * Remove a worktree and prune git's record of it.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    try {
      await execFileAsync('git', [
        '-C',
        this.repoRoot,
        'worktree',
        'remove',
        '--force',
        worktreePath,
      ]);
    } catch {
      // Fallback: force remove directory and prune
      try {
        await rm(worktreePath, { recursive: true, force: true });
        await execFileAsync('git', ['-C', this.repoRoot, 'worktree', 'prune']);
      } catch {
        // Best effort
      }
    }
  }

  /**
   * Create the integration branch for a run.
   */
  async createIntegrationBranch(runId: string, baseBranch: string): Promise<string> {
    const branchName = `tbd-compile/${runId}`;

    // Fetch latest
    await execFileAsync('git', ['-C', this.repoRoot, 'fetch', 'origin', baseBranch]);

    // Create branch from latest remote
    await execFileAsync('git', ['-C', this.repoRoot, 'branch', branchName, `origin/${baseBranch}`]);

    // Push to remote
    await execFileAsync('git', ['-C', this.repoRoot, 'push', '-u', 'origin', branchName]);

    return branchName;
  }

  private async createWorktree(
    worktreePath: string,
    branchName: string,
    targetBranch: string,
  ): Promise<void> {
    await mkdir(this.worktreesDir, { recursive: true });

    // Fetch target branch
    await execFileAsync('git', ['-C', this.repoRoot, 'fetch', 'origin', targetBranch]);

    // Remove existing worktree if present (handles retry after failure)
    try {
      await this.removeWorktree(worktreePath);
    } catch {
      // No existing worktree — fine
    }

    // Delete existing branch if present (from a previous attempt)
    try {
      await execFileAsync('git', ['-C', this.repoRoot, 'branch', '-D', branchName]);
    } catch {
      // Branch doesn't exist — fine
    }

    // Create worktree with a new branch based on target
    await execFileAsync('git', [
      '-C',
      this.repoRoot,
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      `origin/${targetBranch}`,
    ]);
  }
}
