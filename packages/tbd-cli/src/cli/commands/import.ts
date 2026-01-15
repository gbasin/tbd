/**
 * `tbd import` - Import from Beads or other sources.
 *
 * See: tbd-design-v3.md §5.1 Import Strategy
 */

import { Command } from 'commander';
import { readFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { BaseCommand } from '../lib/baseCommand.js';
import { writeIssue, listIssues, atomicWriteFile } from '../../file/storage.js';
import { generateInternalId } from '../../lib/ids.js';
import { IssueStatus, IssueKind } from '../../lib/schemas.js';
import type { Issue, IssueStatusType, IssueKindType, DependencyType } from '../../lib/types.js';

// Base directory for issues
const ISSUES_BASE_DIR = '.tbd-sync';
const MAPPINGS_DIR = '.tbd-sync/mappings';

interface ImportOptions {
  fromBeads?: boolean;
  beadsDir?: string;
  merge?: boolean;
  verbose?: boolean;
}

/**
 * Beads issue structure (from JSONL export).
 */
interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  type?: string;
  issue_type?: string;
  status: string;
  priority?: number;
  assignee?: string;
  labels?: string[];
  dependencies?: { type: string; target: string }[];
  created_at: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  due?: string;
  defer?: string;
  parent?: string;
}

/**
 * ID mapping file structure.
 */
type IdMapping = Record<string, string>;

/**
 * Load existing ID mapping.
 */
async function loadMapping(): Promise<IdMapping> {
  const mappingPath = join(process.cwd(), MAPPINGS_DIR, 'beads.yml');
  try {
    const content = await readFile(mappingPath, 'utf-8');
    return (parseYaml(content) as IdMapping) ?? {};
  } catch {
    return {};
  }
}

/**
 * Save ID mapping.
 */
async function saveMapping(mapping: IdMapping): Promise<void> {
  const mappingsDir = join(process.cwd(), MAPPINGS_DIR);
  await mkdir(mappingsDir, { recursive: true });
  const mappingPath = join(mappingsDir, 'beads.yml');
  const content = stringifyYaml(mapping, { sortMapEntries: true });
  await atomicWriteFile(mappingPath, content);
}

/**
 * Map Beads status to Tbd status.
 */
function mapStatus(beadsStatus: string): IssueStatusType {
  const statusMap: Record<string, IssueStatusType> = {
    open: 'open',
    in_progress: 'in_progress',
    blocked: 'blocked',
    deferred: 'deferred',
    closed: 'closed',
    tombstone: 'closed',
  };
  const result = IssueStatus.safeParse(statusMap[beadsStatus] ?? beadsStatus);
  return result.success ? result.data : 'open';
}

/**
 * Map Beads issue type to Tbd kind.
 */
function mapKind(beadsType?: string): IssueKindType {
  const kindMap: Record<string, IssueKindType> = {
    bug: 'bug',
    feature: 'feature',
    task: 'task',
    epic: 'epic',
    chore: 'chore',
  };
  if (!beadsType) return 'task';
  const result = IssueKind.safeParse(kindMap[beadsType] ?? beadsType);
  return result.success ? result.data : 'task';
}

/**
 * Convert Beads issue to Tbd issue.
 */
function convertIssue(beads: BeadsIssue, tbdId: string, depMapping: IdMapping): Issue {
  // Convert dependencies, translating IDs
  const dependencies: DependencyType[] = [];
  if (beads.dependencies) {
    for (const dep of beads.dependencies) {
      if (dep.type === 'blocks' || dep.type === 'blocked_by') {
        const targetId = depMapping[dep.target];
        if (targetId) {
          // "blocked_by" in Beads means the target blocks this issue
          // In Tbd, we only have "blocks", so we need to handle this carefully
          // For now, we store "blocks" dependencies directly
          if (dep.type === 'blocks') {
            dependencies.push({ type: 'blocks', target: targetId });
          }
          // Note: blocked_by would need to be added to the target issue's dependencies
        }
      }
    }
  }

  return {
    type: 'is',
    id: tbdId,
    version: 1,
    kind: mapKind(beads.type ?? beads.issue_type),
    title: beads.title,
    description: beads.description,
    notes: beads.notes,
    status: mapStatus(beads.status),
    priority: beads.priority ?? 2,
    assignee: beads.assignee,
    labels: beads.labels ?? [],
    dependencies,
    created_at: beads.created_at,
    updated_at: beads.updated_at,
    closed_at: beads.closed_at ?? null,
    close_reason: beads.close_reason ?? null,
    due_date: beads.due ?? null,
    deferred_until: beads.defer ?? null,
    parent_id: beads.parent ? depMapping[beads.parent] : null,
    extensions: {
      beads: {
        original_id: beads.id,
        imported_at: new Date().toISOString(),
      },
    },
  };
}

class ImportHandler extends BaseCommand {
  async run(file: string | undefined, options: ImportOptions): Promise<void> {
    // Validate input
    if (!file && !options.fromBeads) {
      this.output.error('Provide a file path or use --from-beads');
      return;
    }

    if (options.fromBeads) {
      await this.importFromBeads(options);
    } else if (file) {
      await this.importFromFile(file, options);
    }
  }

  private async importFromFile(filePath: string, options: ImportOptions): Promise<void> {
    // Check file exists
    try {
      await access(filePath);
    } catch {
      this.output.error(`File not found: ${filePath}`);
      return;
    }

    if (this.checkDryRun('Would import issues', { file: filePath })) {
      // For dry run, still parse and show what would happen
      const content = await readFile(filePath, 'utf-8');
      const lines = content
        .trim()
        .split('\n')
        .filter((l) => l);
      this.output.info(`Would import ${lines.length} issues from ${filePath}`);
      return;
    }

    // Load file content
    const content = await readFile(filePath, 'utf-8');
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l);

    // Parse JSONL
    const beadsIssues: BeadsIssue[] = [];
    for (const line of lines) {
      try {
        const issue = JSON.parse(line) as BeadsIssue;
        if (issue.id && issue.title) {
          beadsIssues.push(issue);
        }
      } catch {
        if (options.verbose) {
          this.output.warn(`Skipping invalid JSON line`);
        }
      }
    }

    if (beadsIssues.length === 0) {
      this.output.info('No valid issues found in file');
      return;
    }

    // Load existing mapping and issues
    const mapping = await loadMapping();
    const existingIssues = await this.loadExistingIssues();
    const existingByBeadsId = new Map<string, Issue>();

    // Build reverse lookup from extensions
    for (const issue of existingIssues) {
      const beadsExt = issue.extensions?.beads as { original_id?: string } | undefined;
      if (beadsExt?.original_id) {
        existingByBeadsId.set(beadsExt.original_id, issue);
      }
    }

    // First pass: assign IDs to all issues (needed for dependency translation)
    for (const beads of beadsIssues) {
      if (!mapping[beads.id]) {
        const existing = existingByBeadsId.get(beads.id);
        if (existing) {
          mapping[beads.id] = existing.id;
        } else {
          mapping[beads.id] = generateInternalId();
        }
      }
    }

    // Second pass: convert and save issues
    let imported = 0;
    let skipped = 0;
    let merged = 0;

    for (const beads of beadsIssues) {
      const tbdId = mapping[beads.id]!;
      const existing = existingByBeadsId.get(beads.id);

      if (existing && !options.merge) {
        // Check if Beads is newer
        if (new Date(beads.updated_at) <= new Date(existing.updated_at)) {
          skipped++;
          continue;
        }
      }

      const issue = convertIssue(beads, tbdId, mapping);

      if (existing) {
        // Merge: keep higher version, update fields
        issue.version = existing.version + 1;
        merged++;
      } else {
        imported++;
      }

      try {
        await writeIssue(ISSUES_BASE_DIR, issue);
      } catch (error) {
        if (options.verbose) {
          this.output.warn(`Failed to write issue ${beads.id}: ${(error as Error).message}`);
        }
      }
    }

    // Save updated mapping
    await saveMapping(mapping);

    const result = { imported, skipped, merged, total: beadsIssues.length };

    this.output.data(result, () => {
      this.output.success(`Import complete from ${filePath}`);
      console.log(`  New issues:   ${imported}`);
      console.log(`  Merged:       ${merged}`);
      console.log(`  Skipped:      ${skipped}`);
    });
  }

  private async importFromBeads(options: ImportOptions): Promise<void> {
    const beadsDir = options.beadsDir ?? '.beads';
    const jsonlPath = join(beadsDir, 'issues.jsonl');

    try {
      await access(jsonlPath);
    } catch {
      this.output.error(`Beads database not found at ${beadsDir}`);
      this.output.info('Use `bd export > issues.jsonl` to create an export file');
      return;
    }

    await this.importFromFile(jsonlPath, options);
  }

  private async loadExistingIssues(): Promise<Issue[]> {
    try {
      return await listIssues(ISSUES_BASE_DIR);
    } catch {
      return [];
    }
  }
}

export const importCommand = new Command('import')
  .description('Import issues from Beads or JSONL file')
  .argument('[file]', 'JSONL file to import')
  .option('--from-beads', 'Import directly from Beads database')
  .option('--beads-dir <path>', 'Beads data directory')
  .option('--merge', 'Merge with existing issues instead of skipping duplicates')
  .option('--verbose', 'Show detailed import progress')
  .action(async (file, options, command) => {
    const handler = new ImportHandler(command);
    await handler.run(file, options);
  });
