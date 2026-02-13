/**
 * Compiler configuration schema and loader.
 *
 * Zero-config works out of the box — all fields have sensible defaults.
 * Power users can create .tbd/compiler.yml to customize.
 */

import { z } from 'zod';

// =============================================================================
// Duration Parsing
// =============================================================================

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;

/** Parse a human-readable duration string into milliseconds. */
export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input);
  if (!match) {
    throw new Error(`Invalid duration: "${input}" (expected format: 15m, 30s, 1h, 500ms)`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

// =============================================================================
// Config Schema
// =============================================================================

/** A backend spec: single backend string, or array for random selection per spawn. */
export const BackendSpec = z.union([
  z.enum(['auto', 'claude-code', 'codex', 'subprocess']),
  z.array(z.enum(['claude-code', 'codex', 'subprocess'])).min(1),
]);

export type BackendSpec = z.infer<typeof BackendSpec>;

export const CompilerConfigSchema = z.object({
  spec: z.string().optional(),

  agent: z
    .object({
      backend: BackendSpec.default('auto'),
      command: z.string().nullable().default(null),
      max_concurrency: z.number().int().min(1).default(4),
      timeout_per_bead: z.string().default('15m'),
      max_retries_per_bead: z.number().int().min(0).default(2),
    })
    .default({}),

  target_branch: z.string().default('auto'),

  worktree: z
    .object({
      strategy: z.enum(['per-agent', 'shared']).default('per-agent'),
      base_branch: z.string().default('main'),
      cleanup: z.boolean().default(true),
    })
    .default({}),

  phases: z
    .object({
      decompose: z
        .object({
          auto: z.boolean().default(true),
          human_review: z.boolean().default(false),
          existing_selector: z.string().optional(),
          backend: BackendSpec.optional(),
        })
        .default({}),

      implement: z
        .object({
          guidelines: z.array(z.string()).default(['typescript-rules', 'general-tdd-guidelines']),
          completion_checks: z
            .array(z.string())
            .default(['own-tests', 'typecheck', 'build', 'lint']),
          backend: BackendSpec.optional(),
        })
        .default({}),

      maintain: z
        .object({
          trigger: z.enum(['every_n_beads', 'after_all', 'never']).default('every_n_beads'),
          n: z.number().int().min(1).default(25),
          backend: BackendSpec.optional(),
        })
        .default({}),

      judge: z
        .object({
          enabled: z.boolean().default(true),
          spec_drift: z.boolean().default(true),
          acceptance: z.boolean().default(true),
          max_iterations: z.number().int().min(1).default(3),
          on_complete: z.enum(['pr', 'none']).default('pr'),
          backend: BackendSpec.optional(),
        })
        .default({}),
    })
    .default({}),

  acceptance: z
    .object({
      generate: z.boolean().default(true),
      path: z.string().optional(),
    })
    .default({}),
});

export type CompilerConfig = z.infer<typeof CompilerConfigSchema>;

/** Load and validate a raw config object, applying all defaults. */
export function parseCompilerConfig(raw: unknown): CompilerConfig {
  return CompilerConfigSchema.parse(raw ?? {});
}

/** Get the bead timeout in milliseconds. */
export function getBeadTimeoutMs(config: CompilerConfig): number {
  return parseDuration(config.agent.timeout_per_bead);
}
