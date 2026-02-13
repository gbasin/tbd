/**
 * Per-run lock with heartbeat for preventing duplicate harness processes.
 *
 * - Lock file: .tbd/harness/<run-id>/lock.json
 * - Heartbeat: updated every 5 seconds
 * - Stale detection: heartbeat > 30s old AND PID not alive
 */

import { readFile, unlink } from 'node:fs/promises';
import { writeFile } from 'atomically';
import { join } from 'node:path';

const LOCK_FILENAME = 'lock.json';
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_THRESHOLD_MS = 30_000;

interface LockData {
  runId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
}

export class RunLock {
  private readonly lockPath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    runDir: string,
    private readonly runId: string,
  ) {
    this.lockPath = join(runDir, LOCK_FILENAME);
  }

  /**
   * Acquire the lock. Checks for stale locks and removes them.
   * Throws if the lock is held by a live process.
   */
  async acquire(): Promise<void> {
    // Check existing lock
    const existing = await this.readLock();
    if (existing) {
      const isStale = this.isStale(existing);
      if (!isStale) {
        throw new Error(
          `Run ${existing.runId} is already in progress (pid ${existing.pid}). ` +
            'Use --resume after the other process exits.',
        );
      }
      // Stale lock — remove and acquire
    }

    // Write new lock
    const lockData: LockData = {
      runId: this.runId,
      pid: process.pid,
      hostname: (await import('node:os')).hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    await writeFile(this.lockPath, JSON.stringify(lockData, null, 2), 'utf-8');

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.updateHeartbeat().catch(() => {
        // Ignore heartbeat write errors — not fatal
      });
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive just for heartbeat
    this.heartbeatTimer.unref();
  }

  /** Release the lock and stop the heartbeat. */
  async release(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      await unlink(this.lockPath);
    } catch {
      // Lock file may already be gone
    }
  }

  private async updateHeartbeat(): Promise<void> {
    const existing = await this.readLock();
    if (existing?.pid === process.pid) {
      existing.heartbeatAt = new Date().toISOString();
      await writeFile(this.lockPath, JSON.stringify(existing, null, 2), 'utf-8');
    }
  }

  private async readLock(): Promise<LockData | null> {
    try {
      const content = await readFile(this.lockPath, 'utf-8');
      return JSON.parse(content) as LockData;
    } catch {
      return null;
    }
  }

  private isStale(lock: LockData): boolean {
    // Both conditions must be true: heartbeat expired AND PID not alive
    const heartbeatAge = Date.now() - new Date(lock.heartbeatAt).getTime();
    if (heartbeatAge < STALE_THRESHOLD_MS) {
      return false;
    }

    // Check if PID is alive
    try {
      process.kill(lock.pid, 0);
      return false; // PID is alive
    } catch {
      return true; // PID is dead → stale
    }
  }
}
