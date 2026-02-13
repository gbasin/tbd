/**
 * Agent and Judge backend interfaces and shared process utilities.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { AgentResult } from '../../../../lib/compiler/types.js';

// =============================================================================
// Shared Process Spawn
// =============================================================================

const MAX_OUTPUT_LINES = 5_000;
const KILL_GRACE_MS = 10_000;

// =============================================================================
// Active Process Registry (for signal handler cleanup)
// =============================================================================

const activeProcesses = new Map<number, ChildProcess>();

/** Kill all active agent process groups. Used by signal handler. */
export function killAllActiveProcesses(): void {
  for (const [, proc] of activeProcesses) {
    killProcessGroup(proc);
  }
}

export interface ProcessResult {
  exitCode: number;
  lastLines: string;
  duration: number;
  timedOut: boolean;
}

/**
 * Spawn a process with:
 * - detached process group (for clean tree-kill)
 * - circular buffer for last ~50 lines of output
 * - external timeout via SIGTERM → grace → SIGKILL
 */
export function spawnProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    timeout: number;
    env?: Record<string, string>;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let timedOut = false;

    const proc: ChildProcess = spawn(command, args, {
      cwd: opts.cwd,
      detached: true,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track for signal handler cleanup
    if (proc.pid) activeProcesses.set(proc.pid, proc);

    // Circular buffer for last N lines
    const outputLines: string[] = [];
    const collectLines = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      outputLines.push(...lines);
      while (outputLines.length > MAX_OUTPUT_LINES) outputLines.shift();
    };

    proc.stdout?.on('data', collectLines);
    proc.stderr?.on('data', collectLines);

    // Timeout handler
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc);
    }, opts.timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (proc.pid) activeProcesses.delete(proc.pid);
      resolve({
        exitCode: code ?? 1,
        lastLines: outputLines.join('\n'),
        duration: Date.now() - startTime,
        timedOut,
      });
    });

    proc.on('error', () => {
      clearTimeout(timeoutId);
      if (proc.pid) activeProcesses.delete(proc.pid);
      resolve({
        exitCode: 1,
        lastLines: outputLines.join('\n'),
        duration: Date.now() - startTime,
        timedOut: false,
      });
    });
  });
}

/**
 * Kill a process group: SIGTERM → grace period → SIGKILL.
 */
export function killProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;

  try {
    // Send SIGTERM to the entire process group
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    // Process may already be dead
    return;
  }

  // Force kill after grace period
  setTimeout(() => {
    try {
      process.kill(-proc.pid!, 'SIGKILL');
    } catch {
      // Process already exited
    }
  }, KILL_GRACE_MS);
}

/**
 * Convert a ProcessResult into an AgentResult.
 */
export function toAgentResult(result: ProcessResult): AgentResult {
  return {
    status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'success' : 'failure',
    exitCode: result.exitCode,
    lastLines: result.lastLines,
    duration: result.duration,
  };
}
