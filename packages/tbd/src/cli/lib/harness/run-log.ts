/**
 * Structured run log (run-log.yml) writer.
 *
 * Updated at phase transitions to provide a human-readable summary.
 */

import { readFile } from 'node:fs/promises';
import { writeFile } from 'atomically';
import { join } from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import {
  RunLogSchema,
  type RunLog,
  type RunLogIterationSchema,
} from '../../../lib/harness/types.js';
import type { z } from 'zod';

const RUN_LOG_FILENAME = 'run-log.yml';

type RunLogIteration = z.infer<typeof RunLogIterationSchema>;

export class RunLogWriter {
  private readonly logPath: string;
  private log: RunLog;

  constructor(runDir: string, runId: string, spec: string, targetBranch: string) {
    this.logPath = join(runDir, RUN_LOG_FILENAME);
    this.log = {
      runId,
      spec,
      startedAt: new Date().toISOString(),
      status: 'in_progress',
      targetBranch,
      iterations: [],
    };
  }

  /** Load an existing run log (for --resume). */
  async load(): Promise<void> {
    try {
      const content = await readFile(this.logPath, 'utf-8');
      this.log = RunLogSchema.parse(yamlParse(content));
    } catch {
      // If missing, keep the initial log
    }
  }

  /** Start a new iteration. */
  startIteration(iteration: number): void {
    const entry: RunLogIteration = {
      iteration,
      startedAt: new Date().toISOString(),
      phase: 'implement',
      beadsTotal: 0,
      beadsCompleted: 0,
      beadsFailed: 0,
      beadsBlocked: 0,
      agentsSpawned: 0,
      maintenanceRuns: 0,
      observationsCreated: 0,
    };
    this.log.iterations.push(entry);
  }

  /** Update the current iteration's counts. */
  updateIteration(updates: Partial<RunLogIteration>): void {
    const current = this.log.iterations[this.log.iterations.length - 1];
    if (current) {
      Object.assign(current, updates);
    }
  }

  /** Mark the run as completed. */
  complete(totalBeads: number, totalAgentSpawns: number): void {
    this.log.status = 'completed';
    this.log.completedAt = new Date().toISOString();
    this.log.totalBeads = totalBeads;
    this.log.totalAgentSpawns = totalAgentSpawns;

    const start = new Date(this.log.startedAt).getTime();
    const end = new Date(this.log.completedAt).getTime();
    const durationMs = end - start;
    this.log.totalDuration = formatDuration(durationMs);
  }

  /** Mark the run as failed. */
  fail(): void {
    this.log.status = 'failed';
    this.log.completedAt = new Date().toISOString();
  }

  /** Write the run log to disk. */
  async flush(): Promise<void> {
    await writeFile(this.logPath, yamlStringify(this.log), 'utf-8');
  }

  /** Get the current log state (for status display). */
  getLog(): RunLog {
    return this.log;
  }
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  return `${minutes}m`;
}
