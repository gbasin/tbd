import { execSync } from 'node:child_process';
import { defineConfig } from 'tsdown';

// Read package.json at build time
import pkg from './package.json' with { type: 'json' };

/**
 * Generate version string from git state.
 * Format: X.Y.Z-dev.N.hash for dev builds, X.Y.Z for tagged releases.
 *
 * See: research-modern-typescript-monorepo-patterns.md#dynamic-git-based-versioning
 */
function getGitVersion(): string {
  try {
    const git = (args: string) =>
      execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    // Get the latest tag
    const tag = git('describe --tags --abbrev=0');
    const tagVersion = tag.replace(/^v/, '');
    const [major, minor, patch] = tagVersion.split('.').map(Number);
    const commitsSinceTag = parseInt(git(`rev-list ${tag}..HEAD --count`), 10);
    const hash = git('rev-parse --short=7 HEAD');

    // Check for dirty working directory
    let dirty = false;
    try {
      git('diff --quiet');
      git('diff --cached --quiet');
    } catch {
      dirty = true;
    }

    // If on exact tag and clean, return tag version
    if (commitsSinceTag === 0 && !dirty) {
      return tagVersion;
    }

    // Bump patch for dev versions (ensures correct semver sorting)
    const bumpedPatch = (patch ?? 0) + 1;
    const suffix = dirty ? `${hash}-dirty` : hash;
    return `${major}.${minor}.${bumpedPatch}-dev.${commitsSinceTag}.${suffix}`;
  } catch {
    // Fall back to package.json version if git info unavailable
    return pkg.version;
  }
}

// Common options shared by all entry configs
const commonOptions = {
  format: ['esm', 'cjs'] as ('esm' | 'cjs')[],
  platform: 'node' as const,
  target: 'node20' as const,
  sourcemap: true,
  dts: true,
  define: {
    __TBD_VERSION__: JSON.stringify(getGitVersion()),
  },
};

export default defineConfig([
  // Library entry points (no shebang needed)
  {
    ...commonOptions,
    entry: {
      index: 'src/index.ts',
      cli: 'src/cli/cli.ts',
    },
    clean: true,
  },
  // CLI binary (with shebang)
  {
    ...commonOptions,
    entry: { bin: 'src/cli/bin.ts' },
    banner: '#!/usr/bin/env node',
    clean: false, // Don't clean - first config already cleaned
  },
]);
