/**
 * JSONL event log writer for the compiler.
 *
 * Append-only, serialized write queue to prevent interleaved writes
 * from concurrent agent completions.
 */

import { open, type FileHandle } from 'node:fs/promises';

import type { CompilerEvent } from '../../../lib/compiler/types.js';

export class EventLogger {
  private fd: FileHandle | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** Open the event log file for appending. */
  async open(): Promise<void> {
    this.fd = await open(this.filePath, 'a');
  }

  /** Emit a single event. Serialized through a write queue. */
  emit(event: Omit<CompilerEvent, 'v' | 'ts'>): void {
    const record = {
      v: 1 as const,
      ts: new Date().toISOString(),
      ...event,
    };
    const line = JSON.stringify(record) + '\n';

    // Chain onto the write queue so only one write is in-flight at a time
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.fd) {
        await this.fd.write(line);
      }
    });
  }

  /** Flush all pending writes and close the file handle. */
  async close(): Promise<void> {
    await this.writeQueue;
    if (this.fd) {
      await this.fd.close();
      this.fd = null;
    }
  }
}
