/**
 * Zod schemas and TypeScript types for the orchestrator harness.
 *
 * Pure types — no CLI or Node dependencies.
 */

import { z } from 'zod';

// =============================================================================
// Run Phase
// =============================================================================

export const RunPhase = z.enum([
  'freezing',
  'decomposing',
  'implementing',
  'maintaining',
  'judging',
  'completed',
  'failed',
]);
export type RunPhaseType = z.infer<typeof RunPhase>;

// =============================================================================
// Error Codes
// =============================================================================

export const HarnessErrorCode = z.enum([
  'E_SPEC_NOT_FOUND',
  'E_CONFIG_INVALID',
  'E_BACKEND_UNAVAILABLE',
  'E_RUN_LOCKED',
  'E_BEAD_SCOPE_AMBIGUOUS',
  'E_GRAPH_CYCLE',
  'E_DEADLOCK',
  'E_EXTERNAL_BLOCKED',
  'E_AGENT_TIMEOUT',
  'E_ACCEPTANCE_MISSING',
  'E_JUDGE_PARSE_FAILED',
  'E_CHECKPOINT_CORRUPT',
  'E_PR_CREATE_FAILED',
  'E_MAX_ITERATIONS',
  'E_MAX_RUNTIME',
  'E_SPEC_HASH_MISMATCH',
]);
export type HarnessErrorCodeType = z.infer<typeof HarnessErrorCode>;

/** Maps error codes to CLI exit codes */
export const ERROR_CODE_EXIT_MAP: Record<HarnessErrorCodeType, number> = {
  E_SPEC_NOT_FOUND: 2,
  E_CONFIG_INVALID: 2,
  E_BACKEND_UNAVAILABLE: 2,
  E_RUN_LOCKED: 3,
  E_BEAD_SCOPE_AMBIGUOUS: 2,
  E_GRAPH_CYCLE: 4,
  E_DEADLOCK: 4,
  E_EXTERNAL_BLOCKED: 4,
  E_AGENT_TIMEOUT: 4,
  E_ACCEPTANCE_MISSING: 3,
  E_JUDGE_PARSE_FAILED: 4,
  E_CHECKPOINT_CORRUPT: 3,
  E_PR_CREATE_FAILED: 4,
  E_MAX_ITERATIONS: 5,
  E_MAX_RUNTIME: 5,
  E_SPEC_HASH_MISMATCH: 3,
};

// =============================================================================
// Agent Result
// =============================================================================

export const AgentResultSchema = z.object({
  status: z.enum(['success', 'failure', 'timeout']),
  exitCode: z.number().int(),
  lastLines: z.string(),
  logHint: z.string().optional(),
  duration: z.number(),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

// =============================================================================
// Judge Result
// =============================================================================

export const JudgeSpecDriftIssueSchema = z.object({
  section: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'major', 'minor']),
});

export const JudgeAcceptanceResultSchema = z.object({
  criterion: z.string(),
  passed: z.boolean(),
  evidence: z.string(),
});

export const JudgeObservationActionSchema = z.object({
  beadId: z.string(),
  action: z.enum(['promote', 'dismiss', 'merge']),
  reason: z.string(),
  mergeWith: z.string().optional(),
});

export const JudgeNewBeadSchema = z.object({
  title: z.string(),
  description: z.string(),
  type: z.enum(['bug', 'task', 'feature']),
});

export const JudgeResultSchema = z.object({
  status: z.enum(['success', 'failure', 'timeout']),
  specDrift: z.object({
    detected: z.boolean(),
    issues: z.array(JudgeSpecDriftIssueSchema),
  }),
  acceptance: z.object({
    passed: z.boolean(),
    results: z.array(JudgeAcceptanceResultSchema),
  }),
  observations: z.array(JudgeObservationActionSchema),
  newBeads: z.array(JudgeNewBeadSchema),
  lastLines: z.string(),
  duration: z.number(),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

// =============================================================================
// Harness Event
// =============================================================================

export const HarnessEventSchema = z
  .object({
    v: z.literal(1),
    ts: z.string().datetime(),
    event: z.string(),
    // Allow arbitrary additional fields
  })
  .passthrough();
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

// =============================================================================
// Maintenance Run Record
// =============================================================================

export const MaintenanceRunSchema = z.object({
  id: z.string(),
  triggerCompletedCount: z.number().int(),
  state: z.enum(['running', 'success', 'failure']),
});

// =============================================================================
// Active Agent Record
// =============================================================================

export const ActiveAgentSchema = z.object({
  agentId: z.number().int(),
  beadId: z.string(),
  worktree: z.string(),
  startedAt: z.string().datetime(),
  pid: z.number().int(),
});

// =============================================================================
// Checkpoint Schema
// =============================================================================

export const CheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  specPath: z.string(),
  frozenSpecPath: z.string(),
  frozenSpecSha256: z.string(),
  acceptancePath: z.string().optional(),
  targetBranch: z.string(),
  baseBranch: z.string(),

  state: RunPhase,
  iteration: z.number().int().default(1),

  beads: z.object({
    total: z.number().int(),
    completed: z.array(z.string()),
    inProgress: z.array(z.string()),
    blocked: z.array(z.string()),
    retryCounts: z.record(z.string(), z.number().int()),
    claims: z.record(z.string(), z.string()),
  }),

  agents: z.object({
    maxConcurrency: z.number().int(),
    active: z.array(ActiveAgentSchema),
  }),

  maintenance: z.object({
    lastRunAt: z.string().datetime().optional(),
    worktree: z.string().optional(),
    beadId: z.string().optional(),
    runCount: z.number().int().default(0),
    runs: z.array(MaintenanceRunSchema).default([]),
  }),

  observations: z.object({
    pending: z.array(z.string()),
    promoted: z.array(z.string()),
    dismissed: z.array(z.string()),
  }),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// =============================================================================
// Run Log Schema
// =============================================================================

export const RunLogIterationSchema = z.object({
  iteration: z.number().int(),
  startedAt: z.string().datetime(),
  phase: z.string(),
  beadsTotal: z.number().int(),
  beadsCompleted: z.number().int(),
  beadsFailed: z.number().int(),
  beadsBlocked: z.number().int(),
  agentsSpawned: z.number().int(),
  maintenanceRuns: z.number().int(),
  observationsCreated: z.number().int(),
  judgeResult: z
    .object({
      specDrift: z.string().optional(),
      acceptance: z.string().optional(),
      observationsPromoted: z.number().int().optional(),
      observationsDismissed: z.number().int().optional(),
      newBeadsCreated: z.number().int().optional(),
      issues: z.array(JudgeSpecDriftIssueSchema).optional(),
    })
    .optional(),
});

export const RunLogSchema = z.object({
  runId: z.string(),
  spec: z.string(),
  startedAt: z.string().datetime(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  targetBranch: z.string(),
  iterations: z.array(RunLogIterationSchema).default([]),
  completedAt: z.string().datetime().optional(),
  totalDuration: z.string().optional(),
  totalBeads: z.number().int().optional(),
  totalAgentSpawns: z.number().int().optional(),
});
export type RunLog = z.infer<typeof RunLogSchema>;

// =============================================================================
// Backend Interfaces
// =============================================================================

export interface SpawnOptions {
  workdir: string;
  prompt: string;
  timeout: number;
  env?: Record<string, string>;
  systemPrompt?: string;
}

export interface AgentBackend {
  name: string;
  spawn(opts: SpawnOptions): Promise<AgentResult>;
}

export interface JudgeEvaluateOptions {
  workdir: string;
  frozenSpecPath: string;
  acceptancePath: string;
  observationBeadIds: string[];
  timeout: number;
  env?: Record<string, string>;
}

export interface JudgeBackend {
  name: string;
  evaluate(opts: JudgeEvaluateOptions): Promise<JudgeResult>;
}
