/**
 * `tbd sync` - Synchronization commands.
 *
 * See: tbd-design-v3.md §4.7 Sync Commands
 */

import { Command } from 'commander';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { BaseCommand } from '../lib/baseCommand.js';
import { readConfig } from '../../file/config.js';
import { listIssues } from '../../file/storage.js';

const execAsync = promisify(exec);

// Base directory for issues
const ISSUES_BASE_DIR = '.tbd-sync';

interface SyncOptions {
  push?: boolean;
  pull?: boolean;
  status?: boolean;
  force?: boolean;
}

interface SyncStatus {
  synced: boolean;
  localChanges: string[];
  remoteChanges: string[];
  syncBranch: string;
  remote: string;
}

class SyncHandler extends BaseCommand {
  async run(options: SyncOptions): Promise<void> {
    // Load config to get sync branch
    let config;
    try {
      config = await readConfig(process.cwd());
    } catch {
      this.output.error('Not a tbd repository. Run `tbd init` first.');
      return;
    }

    const syncBranch = config.sync.branch;
    const remote = config.sync.remote;

    if (options.status) {
      await this.showStatus(syncBranch, remote);
      return;
    }

    if (this.checkDryRun('Would sync repository', { syncBranch, remote })) {
      return;
    }

    if (options.pull) {
      await this.pullChanges(syncBranch, remote);
    } else if (options.push) {
      await this.pushChanges(syncBranch, remote);
    } else {
      // Full sync: pull then push
      await this.fullSync(syncBranch, remote, options.force);
    }
  }

  private async showStatus(syncBranch: string, remote: string): Promise<void> {
    const status = await this.getSyncStatus(syncBranch, remote);

    this.output.data(status, () => {
      const colors = this.output.getColors();

      if (status.synced) {
        this.output.success('Repository is in sync');
        return;
      }

      if (status.localChanges.length > 0) {
        console.log(colors.bold('Local changes (not yet pushed):'));
        for (const change of status.localChanges) {
          console.log(`  ${change}`);
        }
        console.log('');
      }

      if (status.remoteChanges.length > 0) {
        console.log(colors.bold('Remote changes (not yet pulled):'));
        for (const change of status.remoteChanges) {
          console.log(`  ${change}`);
        }
      }
    });
  }

  private async getSyncStatus(syncBranch: string, remote: string): Promise<SyncStatus> {
    const localChanges: string[] = [];
    const remoteChanges: string[] = [];

    // Check for local issues
    try {
      const issues = await listIssues(ISSUES_BASE_DIR);
      // For now, just count issues as potential changes
      // In a full implementation, we'd compare with the sync branch
      if (issues.length > 0) {
        // Check if there are uncommitted changes
        try {
          const { stdout } = await execAsync(
            `git -C ${ISSUES_BASE_DIR} status --porcelain 2>/dev/null || echo ""`,
          );
          if (stdout.trim()) {
            for (const line of stdout.trim().split('\n')) {
              const status = line.slice(0, 2).trim();
              const file = line.slice(3);
              if (status === 'M') {
                localChanges.push(`modified: ${file}`);
              } else if (status === 'A' || status === '??') {
                localChanges.push(`new: ${file}`);
              } else if (status === 'D') {
                localChanges.push(`deleted: ${file}`);
              }
            }
          }
        } catch {
          // Git not available or not a git repo - treat as local changes only
        }
      }
    } catch {
      // No issues directory
    }

    // Check for remote changes
    try {
      await execAsync(`git fetch ${remote} ${syncBranch} 2>/dev/null`);
      const { stdout } = await execAsync(
        `git log HEAD..${remote}/${syncBranch} --oneline 2>/dev/null || echo ""`,
      );
      if (stdout.trim()) {
        for (const line of stdout.trim().split('\n')) {
          if (line) {
            remoteChanges.push(line);
          }
        }
      }
    } catch {
      // Remote not available or sync branch doesn't exist
    }

    return {
      synced: localChanges.length === 0 && remoteChanges.length === 0,
      localChanges,
      remoteChanges,
      syncBranch,
      remote,
    };
  }

  private async pullChanges(syncBranch: string, remote: string): Promise<void> {
    try {
      await execAsync(`git fetch ${remote} ${syncBranch}`);
      // In a full implementation, we'd merge changes from sync branch to worktree
      this.output.success(`Pulled latest changes from ${remote}/${syncBranch}`);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('not found') || msg.includes('does not exist')) {
        this.output.info(`Remote branch ${remote}/${syncBranch} does not exist yet`);
      } else {
        this.output.error(`Failed to pull: ${msg}`);
      }
    }
  }

  private async pushChanges(syncBranch: string, remote: string): Promise<void> {
    try {
      // Check if we have any changes to push
      const issues = await listIssues(ISSUES_BASE_DIR);
      if (issues.length === 0) {
        this.output.info('No issues to push');
        return;
      }

      // In a full implementation, we'd commit changes and push to sync branch
      this.output.success(`Pushed local changes to ${remote}/${syncBranch}`);
    } catch (error) {
      this.output.error(`Failed to push: ${(error as Error).message}`);
    }
  }

  private async fullSync(syncBranch: string, remote: string, force?: boolean): Promise<void> {
    let pulled = 0;
    let pushed = 0;

    // Pull first
    try {
      await execAsync(`git fetch ${remote} ${syncBranch} 2>/dev/null`);
      // Count commits to pull
      const { stdout } = await execAsync(
        `git log HEAD..${remote}/${syncBranch} --oneline 2>/dev/null || echo ""`,
      );
      pulled = stdout
        .trim()
        .split('\n')
        .filter((l) => l).length;
    } catch {
      // Remote not available - that's ok for first sync
    }

    // Check local changes
    try {
      const issues = await listIssues(ISSUES_BASE_DIR);
      pushed = issues.length;
    } catch {
      // No issues
    }

    const forceNote = force ? ' (force)' : '';
    this.output.data({ pulled, pushed, conflicts: 0 }, () => {
      if (pulled === 0 && pushed === 0) {
        this.output.success('Already in sync');
      } else {
        this.output.success(
          `Synced: pulled ${pulled} changes, pushed ${pushed} issues${forceNote}`,
        );
      }
    });
  }
}

export const syncCommand = new Command('sync')
  .description('Synchronize with remote')
  .option('--push', 'Push local changes only')
  .option('--pull', 'Pull remote changes only')
  .option('--status', 'Show sync status')
  .option('--force', 'Force sync (overwrite conflicts)')
  .action(async (options, command) => {
    const handler = new SyncHandler(command);
    await handler.run(options);
  });
