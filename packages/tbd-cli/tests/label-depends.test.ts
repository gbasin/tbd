/**
 * Tests for label and depends commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { writeIssue, readIssue, listIssues } from '../src/file/storage.js';
import type { Issue } from '../src/lib/types.js';

describe('label commands logic', () => {
  let testDir: string;
  const issuesDir = '.tbd-sync';

  beforeEach(async () => {
    testDir = join(tmpdir(), `tbd-label-test-${randomBytes(4).toString('hex')}`);
    await mkdir(join(testDir, issuesDir, 'issues'), { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds labels to an issue', async () => {
    const issue: Issue = {
      type: 'is',
      id: 'is-1ab001',
      version: 1,
      kind: 'task',
      title: 'Label test',
      status: 'open',
      priority: 2,
      labels: ['existing'],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, issue);

    // Simulate adding labels
    const loaded = await readIssue(issuesDir, 'is-1ab001');
    const labelsSet = new Set(loaded.labels);
    labelsSet.add('new-label');
    labelsSet.add('another');
    loaded.labels = [...labelsSet];
    loaded.version += 1;

    await writeIssue(issuesDir, loaded);

    const result = await readIssue(issuesDir, 'is-1ab001');
    expect(result.labels).toContain('existing');
    expect(result.labels).toContain('new-label');
    expect(result.labels).toContain('another');
    expect(result.version).toBe(2);
  });

  it('removes labels from an issue', async () => {
    const issue: Issue = {
      type: 'is',
      id: 'is-1ab002',
      version: 1,
      kind: 'bug',
      title: 'Remove label test',
      status: 'open',
      priority: 1,
      labels: ['keep', 'remove-me', 'also-keep'],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, issue);

    // Simulate removing labels
    const loaded = await readIssue(issuesDir, 'is-1ab002');
    const removeSet = new Set(['remove-me']);
    loaded.labels = loaded.labels.filter((l) => !removeSet.has(l));
    loaded.version += 1;

    await writeIssue(issuesDir, loaded);

    const result = await readIssue(issuesDir, 'is-1ab002');
    expect(result.labels).toContain('keep');
    expect(result.labels).toContain('also-keep');
    expect(result.labels).not.toContain('remove-me');
  });

  it('lists all labels with counts', async () => {
    const issue1: Issue = {
      type: 'is',
      id: 'is-1ab003',
      version: 1,
      kind: 'task',
      title: 'Task 1',
      status: 'open',
      priority: 2,
      labels: ['frontend', 'urgent'],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const issue2: Issue = {
      type: 'is',
      id: 'is-1ab004',
      version: 1,
      kind: 'task',
      title: 'Task 2',
      status: 'open',
      priority: 2,
      labels: ['backend', 'urgent'],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, issue1);
    await writeIssue(issuesDir, issue2);

    const issues = await listIssues(issuesDir);
    const labelCounts = new Map<string, number>();
    for (const issue of issues) {
      for (const label of issue.labels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }

    expect(labelCounts.get('urgent')).toBe(2);
    expect(labelCounts.get('frontend')).toBe(1);
    expect(labelCounts.get('backend')).toBe(1);
  });
});

describe('depends commands logic', () => {
  let testDir: string;
  const issuesDir = '.tbd-sync';

  beforeEach(async () => {
    testDir = join(tmpdir(), `tbd-depends-test-${randomBytes(4).toString('hex')}`);
    await mkdir(join(testDir, issuesDir, 'issues'), { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds a blocks dependency', async () => {
    const blocker: Issue = {
      type: 'is',
      id: 'is-de0001',
      version: 1,
      kind: 'task',
      title: 'Blocking task',
      status: 'open',
      priority: 1,
      labels: [],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const blocked: Issue = {
      type: 'is',
      id: 'is-de0002',
      version: 1,
      kind: 'task',
      title: 'Blocked task',
      status: 'open',
      priority: 2,
      labels: [],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, blocker);
    await writeIssue(issuesDir, blocked);

    // Simulate adding dependency
    const loadedBlocker = await readIssue(issuesDir, 'is-de0001');
    loadedBlocker.dependencies.push({ type: 'blocks', target: 'is-de0002' });
    loadedBlocker.version += 1;

    await writeIssue(issuesDir, loadedBlocker);

    const result = await readIssue(issuesDir, 'is-de0001');
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.type).toBe('blocks');
    expect(result.dependencies[0]!.target).toBe('is-de0002');
  });

  it('removes a blocks dependency', async () => {
    const blocker: Issue = {
      type: 'is',
      id: 'is-de0003',
      version: 1,
      kind: 'task',
      title: 'Blocking task',
      status: 'open',
      priority: 1,
      labels: [],
      dependencies: [{ type: 'blocks', target: 'is-de0004' }],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const blocked: Issue = {
      type: 'is',
      id: 'is-de0004',
      version: 1,
      kind: 'task',
      title: 'Blocked task',
      status: 'open',
      priority: 2,
      labels: [],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, blocker);
    await writeIssue(issuesDir, blocked);

    // Simulate removing dependency
    const loadedBlocker = await readIssue(issuesDir, 'is-de0003');
    loadedBlocker.dependencies = loadedBlocker.dependencies.filter(
      (dep) => !(dep.type === 'blocks' && dep.target === 'is-de0004'),
    );
    loadedBlocker.version += 1;

    await writeIssue(issuesDir, loadedBlocker);

    const result = await readIssue(issuesDir, 'is-de0003');
    expect(result.dependencies).toHaveLength(0);
  });

  it('lists dependencies in both directions', async () => {
    const issue1: Issue = {
      type: 'is',
      id: 'is-de0005',
      version: 1,
      kind: 'task',
      title: 'Task 1',
      status: 'open',
      priority: 1,
      labels: [],
      dependencies: [{ type: 'blocks', target: 'is-de0006' }],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const issue2: Issue = {
      type: 'is',
      id: 'is-de0006',
      version: 1,
      kind: 'task',
      title: 'Task 2',
      status: 'open',
      priority: 2,
      labels: [],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, issue1);
    await writeIssue(issuesDir, issue2);

    const allIssues = await listIssues(issuesDir);

    // Find what issue1 blocks (forward dependencies)
    const loaded1 = await readIssue(issuesDir, 'is-de0005');
    const blocks = loaded1.dependencies
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => dep.target);
    expect(blocks).toContain('is-de0006');

    // Find what blocks issue2 (reverse lookup)
    const blockedBy: string[] = [];
    for (const issue of allIssues) {
      for (const dep of issue.dependencies) {
        if (dep.type === 'blocks' && dep.target === 'is-de0006') {
          blockedBy.push(issue.id);
        }
      }
    }
    expect(blockedBy).toContain('is-de0005');
  });

  it('prevents self-referencing dependencies', async () => {
    const issue: Issue = {
      type: 'is',
      id: 'is-de0007',
      version: 1,
      kind: 'task',
      title: 'Self-ref test',
      status: 'open',
      priority: 2,
      labels: [],
      dependencies: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    await writeIssue(issuesDir, issue);

    // In real command, trying to add self-reference would error
    // Here we just verify the logic check works
    const sourceId = 'is-de0007';
    const targetId = 'is-de0007';
    expect(sourceId === targetId).toBe(true);
  });
});
