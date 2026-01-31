/**
 * Tests for workspace operations (save/import).
 *
 * Workspaces store issue data for sync failure recovery, backups, and bulk editing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'atomically';

import {
  saveToWorkspace,
  importFromWorkspace,
  listWorkspaces,
  deleteWorkspace,
  workspaceExists,
} from '../src/file/workspace.js';
import { writeIssue, listIssues } from '../src/file/storage.js';
import { createTestIssue, testId, TEST_ULIDS } from './test-helpers.js';

describe('workspace operations', () => {
  let tempDir: string;
  let dataSyncDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tbd-workspace-test-'));
    // Create data-sync directory structure
    dataSyncDir = join(tempDir, '.tbd', 'data-sync');
    await mkdir(join(dataSyncDir, 'issues'), { recursive: true });
    await mkdir(join(dataSyncDir, 'mappings'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('saveToWorkspace', () => {
    it('saves all issues to a named workspace', async () => {
      // Create test issues using proper test helpers
      const issue1 = createTestIssue({ id: testId(TEST_ULIDS.ULID_1), title: 'Issue 1' });
      const issue2 = createTestIssue({ id: testId(TEST_ULIDS.ULID_2), title: 'Issue 2' });
      await writeIssue(dataSyncDir, issue1);
      await writeIssue(dataSyncDir, issue2);

      // Save to workspace
      const result = await saveToWorkspace(tempDir, dataSyncDir, {
        workspace: 'my-backup',
      });

      expect(result.saved).toBe(2);
      expect(result.conflicts).toBe(0);

      // Verify workspace has issues
      const workspaceIssuesDir = join(tempDir, '.tbd', 'workspaces', 'my-backup', 'issues');
      const files = await readdir(workspaceIssuesDir);
      expect(files.length).toBe(2);
    });

    it('creates workspace directory if it does not exist', async () => {
      const issue = createTestIssue({ id: testId(TEST_ULIDS.ULID_3), title: 'Test' });
      await writeIssue(dataSyncDir, issue);

      await saveToWorkspace(tempDir, dataSyncDir, { workspace: 'new-workspace' });

      const exists = await workspaceExists(tempDir, 'new-workspace');
      expect(exists).toBe(true);
    });

    it('saves to outbox workspace with --outbox shortcut', async () => {
      const issue = createTestIssue({ id: testId(TEST_ULIDS.ULID_4), title: 'Test' });
      await writeIssue(dataSyncDir, issue);

      const result = await saveToWorkspace(tempDir, dataSyncDir, { outbox: true });

      expect(result.saved).toBeGreaterThanOrEqual(0);
      const exists = await workspaceExists(tempDir, 'outbox');
      expect(exists).toBe(true);
    });

    it('saves to arbitrary directory with --dir option', async () => {
      const issue = createTestIssue({ id: testId(TEST_ULIDS.ULID_5), title: 'External backup' });
      await writeIssue(dataSyncDir, issue);

      const externalDir = join(tempDir, 'external-backup');
      await mkdir(externalDir, { recursive: true });

      const result = await saveToWorkspace(tempDir, dataSyncDir, { dir: externalDir });

      expect(result.saved).toBe(1);

      // Verify issues in external directory
      const files = await readdir(join(externalDir, 'issues'));
      expect(files.length).toBe(1);
    });

    it('returns 0 saved when no issues exist', async () => {
      const result = await saveToWorkspace(tempDir, dataSyncDir, { workspace: 'empty' });

      expect(result.saved).toBe(0);
      expect(result.conflicts).toBe(0);
    });
  });

  describe('listWorkspaces', () => {
    it('returns empty array when no workspaces exist', async () => {
      const workspaces = await listWorkspaces(tempDir);
      expect(workspaces).toEqual([]);
    });

    it('lists existing workspaces', async () => {
      // Create some workspaces
      await mkdir(join(tempDir, '.tbd', 'workspaces', 'ws1', 'issues'), { recursive: true });
      await mkdir(join(tempDir, '.tbd', 'workspaces', 'ws2', 'issues'), { recursive: true });

      const workspaces = await listWorkspaces(tempDir);
      expect(workspaces).toContain('ws1');
      expect(workspaces).toContain('ws2');
      expect(workspaces.length).toBe(2);
    });

    it('ignores non-directory entries', async () => {
      await mkdir(join(tempDir, '.tbd', 'workspaces', 'valid', 'issues'), { recursive: true });
      await mkdir(join(tempDir, '.tbd', 'workspaces'), { recursive: true });
      await writeFile(join(tempDir, '.tbd', 'workspaces', 'not-a-dir.txt'), 'content');

      const workspaces = await listWorkspaces(tempDir);
      expect(workspaces).toEqual(['valid']);
    });
  });

  describe('deleteWorkspace', () => {
    it('deletes an existing workspace', async () => {
      await mkdir(join(tempDir, '.tbd', 'workspaces', 'to-delete', 'issues'), { recursive: true });
      expect(await workspaceExists(tempDir, 'to-delete')).toBe(true);

      await deleteWorkspace(tempDir, 'to-delete');

      expect(await workspaceExists(tempDir, 'to-delete')).toBe(false);
    });

    it('succeeds silently when workspace does not exist', async () => {
      // Should not throw
      await deleteWorkspace(tempDir, 'nonexistent');
    });
  });

  describe('workspaceExists', () => {
    it('returns false when workspace does not exist', async () => {
      expect(await workspaceExists(tempDir, 'nonexistent')).toBe(false);
    });

    it('returns true when workspace exists', async () => {
      await mkdir(join(tempDir, '.tbd', 'workspaces', 'exists'), { recursive: true });
      expect(await workspaceExists(tempDir, 'exists')).toBe(true);
    });
  });

  describe('importFromWorkspace', () => {
    it('imports issues from workspace to data-sync directory', async () => {
      // Create issues in workspace
      const workspaceDir = join(tempDir, '.tbd', 'workspaces', 'my-import');
      await mkdir(join(workspaceDir, 'issues'), { recursive: true });
      await mkdir(join(workspaceDir, 'mappings'), { recursive: true });

      const issue1 = createTestIssue({ id: testId(TEST_ULIDS.ULID_6), title: 'Imported 1' });
      const issue2 = createTestIssue({ id: testId(TEST_ULIDS.ULID_7), title: 'Imported 2' });
      await writeIssue(workspaceDir, issue1);
      await writeIssue(workspaceDir, issue2);

      // Import from workspace
      const result = await importFromWorkspace(tempDir, dataSyncDir, {
        workspace: 'my-import',
      });

      expect(result.imported).toBe(2);
      expect(result.conflicts).toBe(0);

      // Verify issues in data-sync
      const issues = await listIssues(dataSyncDir);
      expect(issues.length).toBe(2);
    });

    it('does not delete workspace by default', async () => {
      // Setup workspace
      const workspaceDir = join(tempDir, '.tbd', 'workspaces', 'keep-me');
      await mkdir(join(workspaceDir, 'issues'), { recursive: true });
      const issue = createTestIssue({ id: testId(TEST_ULIDS.ULID_8), title: 'Keep' });
      await writeIssue(workspaceDir, issue);

      // Import without clear flag
      await importFromWorkspace(tempDir, dataSyncDir, { workspace: 'keep-me' });

      // Workspace should still exist
      expect(await workspaceExists(tempDir, 'keep-me')).toBe(true);
    });

    it('deletes workspace with clearOnSuccess flag', async () => {
      // Setup workspace
      const workspaceDir = join(tempDir, '.tbd', 'workspaces', 'delete-me');
      await mkdir(join(workspaceDir, 'issues'), { recursive: true });
      const issue = createTestIssue({ id: testId(TEST_ULIDS.ULID_9), title: 'Delete' });
      await writeIssue(workspaceDir, issue);

      // Import with clear flag
      await importFromWorkspace(tempDir, dataSyncDir, {
        workspace: 'delete-me',
        clearOnSuccess: true,
      });

      // Workspace should be deleted
      expect(await workspaceExists(tempDir, 'delete-me')).toBe(false);
    });

    it('--outbox shortcut implies clearOnSuccess', async () => {
      // Setup outbox
      const outboxDir = join(tempDir, '.tbd', 'workspaces', 'outbox');
      await mkdir(join(outboxDir, 'issues'), { recursive: true });
      const issue = createTestIssue({ id: testId(TEST_ULIDS.ULID_10), title: 'Outbox' });
      await writeIssue(outboxDir, issue);

      // Import with --outbox
      await importFromWorkspace(tempDir, dataSyncDir, { outbox: true });

      // Outbox should be deleted
      expect(await workspaceExists(tempDir, 'outbox')).toBe(false);
    });

    it('imports from arbitrary directory', async () => {
      // Setup external directory
      const externalDir = join(tempDir, 'external');
      await mkdir(join(externalDir, 'issues'), { recursive: true });
      const issue = createTestIssue({ id: testId(TEST_ULIDS.STORAGE_1), title: 'External' });
      await writeIssue(externalDir, issue);

      // Import from external
      const result = await importFromWorkspace(tempDir, dataSyncDir, { dir: externalDir });

      expect(result.imported).toBe(1);
    });
  });
});
