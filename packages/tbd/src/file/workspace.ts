/**
 * Workspace operations for sync failure recovery, backups, and bulk editing.
 *
 * Workspaces are directories under .tbd/workspaces/ that store issue data.
 * They mirror the data-sync directory structure:
 *   .tbd/workspaces/{name}/
 *     issues/
 *     mappings/
 *     attic/
 *
 * See: plan-2026-01-30-workspace-sync-alt.md
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { listIssues, writeIssue } from './storage.js';
import { WORKSPACES_DIR, getWorkspaceDir, isValidWorkspaceName } from '../lib/paths.js';

/**
 * Options for saveToWorkspace.
 * One of workspace, dir, or outbox must be specified.
 */
export interface SaveOptions {
  /** Named workspace under .tbd/workspaces/ */
  workspace?: string;
  /** Arbitrary directory path */
  dir?: string;
  /** Shortcut for --workspace=outbox --updates-only */
  outbox?: boolean;
  /** Only save issues modified since last sync */
  updatesOnly?: boolean;
}

/**
 * Result from saveToWorkspace operation.
 */
export interface SaveResult {
  /** Number of issues saved */
  saved: number;
  /** Number of conflicts (went to attic) */
  conflicts: number;
  /** Target directory where issues were saved */
  targetDir: string;
}

/**
 * Ensure a directory exists.
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Get the target directory for save operation.
 */
function getTargetDir(tbdRoot: string, options: SaveOptions): string {
  if (options.dir) {
    return options.dir;
  }

  const workspaceName = options.outbox ? 'outbox' : options.workspace;
  if (!workspaceName) {
    throw new Error('One of --workspace, --dir, or --outbox is required');
  }

  if (!isValidWorkspaceName(workspaceName)) {
    throw new Error(`Invalid workspace name: ${workspaceName}`);
  }

  return join(tbdRoot, getWorkspaceDir(workspaceName));
}

/**
 * Save issues from data-sync directory to a workspace or directory.
 *
 * @param tbdRoot - The root directory of the tbd project
 * @param dataSyncDir - The data-sync directory containing source issues
 * @param options - Save options (workspace name, directory, or outbox)
 * @returns Save result with counts
 */
export async function saveToWorkspace(
  tbdRoot: string,
  dataSyncDir: string,
  options: SaveOptions,
): Promise<SaveResult> {
  const targetDir = getTargetDir(tbdRoot, options);

  // Create target directory structure
  const issuesDir = join(targetDir, 'issues');
  const mappingsDir = join(targetDir, 'mappings');
  const atticDir = join(targetDir, 'attic');

  await ensureDir(issuesDir);
  await ensureDir(mappingsDir);
  await ensureDir(atticDir);

  // List all issues in source
  const issues = await listIssues(dataSyncDir);

  // TODO: Implement --updates-only logic
  // For now, save all issues (ignoring updatesOnly flag)
  const _isUpdatesOnly = options.updatesOnly ?? options.outbox;

  let saved = 0;
  const conflicts = 0;

  // Save each issue to target
  for (const issue of issues) {
    // TODO: Check for conflicts if issue already exists in workspace
    // For now, just overwrite
    await writeIssue(targetDir, issue);
    saved++;
  }

  // TODO: Copy mappings

  return {
    saved,
    conflicts,
    targetDir,
  };
}

/**
 * List all workspaces in .tbd/workspaces/.
 *
 * @param tbdRoot - The root directory of the tbd project
 * @returns Array of workspace names
 */
export async function listWorkspaces(tbdRoot: string): Promise<string[]> {
  const workspacesDir = join(tbdRoot, WORKSPACES_DIR);

  let entries: string[];
  try {
    entries = await readdir(workspacesDir);
  } catch {
    // Directory doesn't exist
    return [];
  }

  // Filter to directories only
  const workspaces: string[] = [];
  for (const entry of entries) {
    try {
      const entryPath = join(workspacesDir, entry);
      const entryStat = await stat(entryPath);
      if (entryStat.isDirectory()) {
        workspaces.push(entry);
      }
    } catch {
      // Skip entries we can't stat
    }
  }

  return workspaces;
}

/**
 * Delete a workspace.
 *
 * @param tbdRoot - The root directory of the tbd project
 * @param name - Workspace name
 */
export async function deleteWorkspace(tbdRoot: string, name: string): Promise<void> {
  const workspaceDir = join(tbdRoot, getWorkspaceDir(name));

  try {
    await rm(workspaceDir, { recursive: true, force: true });
  } catch {
    // Ignore errors if workspace doesn't exist
  }
}

/**
 * Check if a workspace exists.
 *
 * @param tbdRoot - The root directory of the tbd project
 * @param name - Workspace name
 * @returns true if the workspace directory exists
 */
export async function workspaceExists(tbdRoot: string, name: string): Promise<boolean> {
  const workspaceDir = join(tbdRoot, getWorkspaceDir(name));

  try {
    const s = await stat(workspaceDir);
    return s.isDirectory();
  } catch {
    return false;
  }
}
