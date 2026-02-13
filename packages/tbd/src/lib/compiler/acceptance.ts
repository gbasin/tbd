/**
 * Acceptance criteria management.
 *
 * Generates acceptance criteria from a frozen spec and stores them
 * outside the repository (XDG cache) so coding agents cannot access them.
 */

import { mkdir, readFile, access } from 'node:fs/promises';
import { writeFile } from 'atomically';
import { join } from 'node:path';
import { homedir } from 'node:os';

// =============================================================================
// XDG Cache Paths
// =============================================================================

/** Get the XDG cache home directory. */
function xdgCacheHome(): string {
  return process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
}

/** Get the acceptance criteria directory for a run. */
export function acceptanceCacheDir(runId: string): string {
  return join(xdgCacheHome(), 'tbd-compiler', runId, 'acceptance');
}

// =============================================================================
// Acceptance Criteria Manager
// =============================================================================

export class AcceptanceManager {
  private readonly cacheDir: string;

  constructor(runId: string) {
    this.cacheDir = acceptanceCacheDir(runId);
  }

  /** Get the path to the acceptance criteria directory. */
  getPath(): string {
    return this.cacheDir;
  }

  /**
   * Generate acceptance criteria from a frozen spec using an agent backend.
   * The criteria are stored outside the repository.
   */
  async generate(
    frozenSpecPath: string,
    spawnFn: (prompt: string) => Promise<string>,
  ): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });

    const frozenSpec = await readFile(frozenSpecPath, 'utf-8');

    const prompt = `Generate acceptance criteria for the following specification.

## Specification
${frozenSpec}

## Output Format

Generate three separate sections:

### User Stories (Given/When/Then format)
Write behavioral user stories that can be evaluated by reading code and tests.
Each story should be independent and testable.

### Edge Cases
List edge cases that a naive implementation would miss.
Include boundary conditions, error cases, and concurrency scenarios.

### Negative Tests
List things that should NOT happen. Include security concerns,
data integrity violations, and incorrect behaviors.

Output each section clearly labeled.`;

    const output = await spawnFn(prompt);

    // Split output into sections and write files
    const sections = splitSections(output);
    await writeFile(join(this.cacheDir, 'user-stories.md'), sections.userStories, 'utf-8');
    await writeFile(join(this.cacheDir, 'edge-cases.md'), sections.edgeCases, 'utf-8');
    await writeFile(join(this.cacheDir, 'negative-tests.md'), sections.negativeTests, 'utf-8');
  }

  /**
   * Verify that acceptance criteria exist on disk.
   * Required before judge phase — fails if cache was cleared.
   */
  async verify(): Promise<void> {
    try {
      await access(this.cacheDir);
      await access(join(this.cacheDir, 'user-stories.md'));
    } catch {
      throw new Error(
        `Acceptance criteria not found at ${this.cacheDir}. ` +
          'Cannot regenerate (would change criteria mid-run). ' +
          'Re-run from scratch with: tbd compile --spec <path>',
      );
    }
  }
}

function splitSections(output: string): {
  userStories: string;
  edgeCases: string;
  negativeTests: string;
} {
  // Best-effort section splitting
  const lines = output.split('\n');
  let currentSection = 'userStories';
  const sections: Record<string, string[]> = {
    userStories: [],
    edgeCases: [],
    negativeTests: [],
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('user stor') || lower.includes('given/when/then')) {
      currentSection = 'userStories';
    } else if (lower.includes('edge case')) {
      currentSection = 'edgeCases';
    } else if (lower.includes('negative test')) {
      currentSection = 'negativeTests';
    }
    sections[currentSection]!.push(line);
  }

  return {
    userStories: sections.userStories!.join('\n') || output,
    edgeCases: sections.edgeCases!.join('\n') || '(No edge cases section found)',
    negativeTests: sections.negativeTests!.join('\n') || '(No negative tests section found)',
  };
}
