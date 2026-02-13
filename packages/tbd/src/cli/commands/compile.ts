/**
 * `tbd compile` - Automated spec-to-code pipeline.
 *
 * Freezes a spec, decomposes it into beads, fans out coding agents,
 * runs maintenance, judges against the spec, and loops until done.
 */

import { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

import { BaseCommand } from '../lib/base-command.js';
import { requireInit, HarnessError } from '../lib/errors.js';
import { HARNESS_DIR, TBD_DIR } from '../../lib/paths.js';
import { parseHarnessConfig } from '../../lib/harness/config.js';
import { RunLogSchema } from '../../lib/harness/types.js';
import { Orchestrator } from '../lib/harness/orchestrator.js';

// =============================================================================
// Options
// =============================================================================

interface CompileOptions {
  spec?: string;
  resume?: boolean;
  status?: string | true;
  dryRun?: boolean;
  concurrency?: string;
  backend?: string;
  beadLabel?: string;
}

// =============================================================================
// Handler
// =============================================================================

class CompileHandler extends BaseCommand {
  async run(options: CompileOptions): Promise<void> {
    const tbdRoot = await requireInit();

    // --status mode: show run status and exit
    if (options.status !== undefined) {
      await this.showStatus(tbdRoot, options.status);
      return;
    }

    // Load config from .tbd/harness.yml (optional)
    const config = await this.loadConfig(tbdRoot, options);

    // Validate: need either --spec or --resume
    if (!options.spec && !options.resume) {
      throw new HarnessError(
        'Must specify --spec <path> for a new run or --resume to continue.',
        'E_SPEC_NOT_FOUND',
        2,
      );
    }

    const orchestrator = new Orchestrator({
      config,
      tbdRoot,
      specPath: options.spec,
      resume: options.resume,
      dryRun: options.dryRun,
      beadLabel: options.beadLabel,
    });

    const result = await orchestrator.run();

    this.output.data(result, () => {
      const colors = this.output.getColors();

      if (result.status === 'dry_run') {
        console.log(colors.bold('Dry run complete'));
        console.log(result.message);
        return;
      }

      if (result.status === 'completed') {
        console.log(colors.bold(colors.success('Pipeline completed successfully')));
      } else {
        console.log(colors.bold(colors.error('Pipeline failed')));
      }
      console.log(`  Run ID:      ${result.runId}`);
      console.log(`  Beads:       ${result.totalBeads}`);
      console.log(`  Iterations:  ${result.iterations}`);
      if (result.message) {
        console.log(`  Message:     ${result.message}`);
      }
    });

    if (result.status === 'failed') {
      process.exit(1);
    }
  }

  // ===========================================================================
  // Config Loading
  // ===========================================================================

  private async loadConfig(tbdRoot: string, options: CompileOptions) {
    let rawConfig: unknown = {};

    // Load from .tbd/harness.yml if it exists
    const configPath = join(tbdRoot, TBD_DIR, 'harness.yml');
    try {
      const content = await readFile(configPath, 'utf-8');
      rawConfig = yamlParse(content) ?? {};
    } catch {
      // No config file — use defaults
    }

    // CLI overrides
    const overrides: Record<string, unknown> = {};
    if (options.concurrency) {
      const n = parseInt(options.concurrency, 10);
      if (isNaN(n) || n < 1) {
        throw new HarnessError(
          `Invalid concurrency value: ${options.concurrency}`,
          'E_CONFIG_INVALID',
          2,
        );
      }
      overrides.agent = {
        ...(typeof rawConfig === 'object' && rawConfig !== null && 'agent' in rawConfig
          ? ((rawConfig as Record<string, unknown>).agent as Record<string, unknown>)
          : {}),
        max_concurrency: n,
      };
    }
    if (options.backend) {
      const agentOverride =
        overrides.agent ??
        (typeof rawConfig === 'object' && rawConfig !== null && 'agent' in rawConfig
          ? (rawConfig as Record<string, unknown>).agent
          : {});
      overrides.agent = {
        ...(typeof agentOverride === 'object' && agentOverride !== null ? agentOverride : {}),
        backend: options.backend,
      };
    }

    const merged = {
      ...(typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}),
      ...overrides,
    };
    return parseHarnessConfig(merged);
  }

  // ===========================================================================
  // Status Display
  // ===========================================================================

  private async showStatus(tbdRoot: string, runIdArg: string | true): Promise<void> {
    const harnessDir = join(tbdRoot, HARNESS_DIR);

    if (runIdArg === true) {
      // No specific run-id — list all runs
      await this.listRuns(harnessDir);
      return;
    }

    // Show specific run
    await this.showRunStatus(harnessDir, runIdArg);
  }

  private async listRuns(harnessDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(harnessDir);
    } catch {
      this.output.info('No harness runs found.');
      return;
    }

    // Filter to run directories (run-YYYYMMDD-*)
    const runs = entries
      .filter((e) => e.startsWith('run-'))
      .sort()
      .reverse();

    if (runs.length === 0) {
      this.output.info('No harness runs found.');
      return;
    }

    const summaries: { runId: string; status: string; spec: string; startedAt: string }[] = [];

    for (const runId of runs) {
      const logPath = join(harnessDir, runId, 'run-log.yml');
      try {
        const content = await readFile(logPath, 'utf-8');
        const log = RunLogSchema.parse(yamlParse(content));
        summaries.push({
          runId: log.runId,
          status: log.status,
          spec: log.spec,
          startedAt: log.startedAt,
        });
      } catch {
        summaries.push({
          runId,
          status: 'unknown',
          spec: '?',
          startedAt: '?',
        });
      }
    }

    this.output.data(summaries, () => {
      const colors = this.output.getColors();
      console.log(colors.bold('Harness runs:'));
      console.log('');
      for (const s of summaries) {
        const statusColor =
          s.status === 'completed'
            ? colors.success
            : s.status === 'failed'
              ? colors.error
              : s.status === 'in_progress'
                ? colors.warn
                : colors.dim;
        console.log(`  ${s.runId}  ${statusColor(s.status.padEnd(12))}  ${s.spec}`);
      }
    });
  }

  private async showRunStatus(harnessDir: string, runId: string): Promise<void> {
    const logPath = join(harnessDir, runId, 'run-log.yml');
    let logContent: string;
    try {
      logContent = await readFile(logPath, 'utf-8');
    } catch {
      throw new HarnessError(`Run not found: ${runId}`, 'E_SPEC_NOT_FOUND', 2);
    }

    const log = RunLogSchema.parse(yamlParse(logContent));

    this.output.data(log, () => {
      const colors = this.output.getColors();
      console.log(colors.bold(`Run: ${log.runId}`));
      console.log(`  Spec:        ${log.spec}`);
      console.log(`  Status:      ${log.status}`);
      console.log(`  Branch:      ${log.targetBranch}`);
      console.log(`  Started:     ${log.startedAt}`);
      if (log.completedAt) {
        console.log(`  Completed:   ${log.completedAt}`);
      }
      if (log.totalDuration) {
        console.log(`  Duration:    ${log.totalDuration}`);
      }
      if (log.totalBeads !== undefined) {
        console.log(`  Total beads: ${log.totalBeads}`);
      }
      if (log.totalAgentSpawns !== undefined) {
        console.log(`  Agents:      ${log.totalAgentSpawns}`);
      }

      if (log.iterations.length > 0) {
        console.log('');
        console.log(colors.bold('  Iterations:'));
        for (const iter of log.iterations) {
          console.log(
            `    #${iter.iteration}: ${iter.beadsCompleted}/${iter.beadsTotal} beads, ${iter.agentsSpawned} agents, ${iter.maintenanceRuns} maintenance`,
          );
          if (iter.judgeResult) {
            const jr = iter.judgeResult;
            console.log(
              `      Judge: drift=${jr.specDrift ?? '?'}, acceptance=${jr.acceptance ?? '?'}`,
            );
          }
        }
      }
    });
  }
}

// =============================================================================
// Command Definition
// =============================================================================

export const compileCommand = new Command('compile')
  .description('Automated spec-to-code pipeline: freeze, decompose, implement, judge')
  .option('--spec <path>', 'Path to the specification file')
  .option('--resume', 'Resume the most recent interrupted run')
  .option('--status [run-id]', 'Show status of harness runs')
  .option('--concurrency <n>', 'Maximum concurrent agents')
  .option('--backend <name>', 'Agent backend: auto, claude-code, codex, subprocess')
  .option('--bead-label <label>', 'Use existing beads with this label instead of decomposing')
  .action(async (options, command) => {
    const handler = new CompileHandler(command);
    await handler.run(options);
  });
