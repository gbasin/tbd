/**
 * Atomic checkpoint save/restore for the compiler.
 *
 * Uses crash-safe write protocol:
 * 1. Write to tmp file
 * 2. fsync tmp file
 * 3. Rename tmp → checkpoint.yml (atomic on POSIX)
 * 4. fsync parent directory
 */

import { readFile, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import { CheckpointSchema, type Checkpoint } from '../../../lib/compiler/types.js';
import { CompilerError } from '../errors.js';

const CHECKPOINT_FILENAME = 'checkpoint.yml';
const CHECKPOINT_TMP_FILENAME = 'checkpoint.yml.tmp';

export class CheckpointManager {
  private readonly checkpointPath: string;
  private readonly tmpPath: string;

  constructor(private readonly runDir: string) {
    this.checkpointPath = join(runDir, CHECKPOINT_FILENAME);
    this.tmpPath = join(runDir, CHECKPOINT_TMP_FILENAME);
  }

  /** Atomically save checkpoint to disk. */
  async save(checkpoint: Checkpoint): Promise<void> {
    const content = yamlStringify(checkpoint);

    // 1. Write to temp file + fsync
    const tmpFd = await open(this.tmpPath, 'w');
    await tmpFd.write(content, null, 'utf-8');
    await tmpFd.sync();
    await tmpFd.close();

    // 3. Atomic rename
    await rename(this.tmpPath, this.checkpointPath);

    // 4. fsync parent directory
    const parentFd = await open(dirname(this.checkpointPath), 'r');
    await parentFd.sync();
    await parentFd.close();
  }

  /** Load checkpoint from disk with schema validation. */
  async load(): Promise<Checkpoint> {
    // Clean up stale .tmp file from interrupted save (checkpoint.yml is still valid)
    await unlink(this.tmpPath).catch(() => {});

    const content = await readFile(this.checkpointPath, 'utf-8');
    const raw = yamlParse(content) as Record<string, unknown> | undefined;

    // Validate schema version
    if (raw?.schemaVersion !== 1) {
      throw new CompilerError(
        `Unknown checkpoint schema version: ${String(raw?.schemaVersion)}. ` +
          'Upgrade tbd to resume this run.',
        'E_CHECKPOINT_CORRUPT',
        3,
      );
    }

    return CheckpointSchema.parse(raw);
  }

  /** Check if a checkpoint exists. */
  async exists(): Promise<boolean> {
    try {
      await readFile(this.checkpointPath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Compute SHA-256 hash of a file's contents.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Verify that a file's SHA-256 hash matches the expected value.
 * Throws on mismatch.
 */
export async function verifySpecHash(filePath: string, expectedHash: string): Promise<void> {
  const actualHash = await computeFileHash(filePath);
  if (actualHash !== expectedHash) {
    throw new CompilerError(
      `Frozen spec hash mismatch — expected ${expectedHash.slice(0, 12)}... ` +
        `but got ${actualHash.slice(0, 12)}... ` +
        'The spec may have been modified after freezing.',
      'E_SPEC_HASH_MISMATCH',
      3,
    );
  }
}
