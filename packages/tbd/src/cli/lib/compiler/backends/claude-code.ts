/**
 * Claude Code backend implementation.
 *
 * Spawns `claude -p "..." --dangerously-skip-permissions`
 * Uses --output-format json for coding agents, plain text for acceptance/judge reasoning.
 */

import type {
  AgentBackend,
  JudgeBackend,
  AgentResult,
  JudgeResult,
  SpawnOptions,
  JudgeEvaluateOptions,
} from '../../../../lib/compiler/types.js';
import { JudgeResultSchema } from '../../../../lib/compiler/types.js';
import { spawnProcess, toAgentResult } from './backend.js';

/** JSON schema for judge structured output (pass 2). */
const JUDGE_RESULT_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    specDrift: {
      type: 'object',
      properties: {
        detected: { type: 'boolean' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              section: { type: 'string' },
              description: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
            },
            required: ['section', 'description', 'severity'],
          },
        },
      },
      required: ['detected', 'issues'],
    },
    acceptance: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              passed: { type: 'boolean' },
              evidence: { type: 'string' },
            },
            required: ['criterion', 'passed', 'evidence'],
          },
        },
      },
      required: ['passed', 'results'],
    },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beadId: { type: 'string' },
          action: { type: 'string', enum: ['promote', 'dismiss', 'merge'] },
          reason: { type: 'string' },
          mergeWith: { type: 'string' },
        },
        required: ['beadId', 'action', 'reason'],
      },
    },
    newBeads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['bug', 'task', 'feature'] },
        },
        required: ['title', 'description', 'type'],
      },
    },
  },
  required: ['specDrift', 'acceptance', 'observations', 'newBeads'],
});

export class ClaudeCodeBackend implements AgentBackend {
  name = 'claude-code';

  async spawn(opts: SpawnOptions): Promise<AgentResult> {
    const args = ['-p', opts.prompt, '--dangerously-skip-permissions'];

    // Only use JSON output format when explicitly requested (coding agents)
    if (opts.outputFormat !== 'text') {
      args.push('--output-format', 'json');
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    const result = await spawnProcess('claude', args, {
      cwd: opts.workdir,
      timeout: opts.timeout,
      env: opts.env,
    });

    return toAgentResult(result);
  }
}

export class ClaudeCodeJudge implements JudgeBackend {
  name = 'claude-code';

  async evaluate(opts: JudgeEvaluateOptions): Promise<JudgeResult> {
    // Pass 1: Reasoning (natural language — no JSON output format)
    const reasoningPrompt = buildJudgeReasoningPrompt(opts);
    const pass1 = await spawnProcess(
      'claude',
      ['-p', reasoningPrompt, '--dangerously-skip-permissions'],
      {
        cwd: opts.workdir,
        timeout: opts.timeout,
        env: opts.env,
      },
    );

    if (pass1.timedOut || pass1.exitCode !== 0) {
      return {
        status: pass1.timedOut ? 'timeout' : 'failure',
        specDrift: { detected: false, issues: [] },
        acceptance: { passed: false, results: [] },
        observations: [],
        newBeads: [],
        lastLines: pass1.lastLines,
        duration: pass1.duration,
      };
    }

    // Pass 2: Structuring (JSON schema enforced)
    const structuringPrompt = buildJudgeStructuringPrompt(pass1.lastLines);
    const pass2 = await spawnProcess(
      'claude',
      [
        '-p',
        structuringPrompt,
        '--output-format',
        'json',
        '--json-schema',
        JUDGE_RESULT_JSON_SCHEMA,
        '--dangerously-skip-permissions',
      ],
      {
        cwd: opts.workdir,
        timeout: 120_000, // 2 min for structuring
        env: opts.env,
      },
    );

    try {
      // Try to parse the structured output
      const parsed = JSON.parse(extractJsonFromOutput(pass2.lastLines)) as Record<string, unknown>;
      const result = JudgeResultSchema.parse({
        ...parsed,
        status: 'success',
        lastLines: pass2.lastLines,
        duration: pass1.duration + pass2.duration,
      });
      return result;
    } catch {
      return {
        status: 'failure',
        specDrift: { detected: false, issues: [] },
        acceptance: { passed: false, results: [] },
        observations: [],
        newBeads: [],
        lastLines: `Parse error. Pass 1 output:\n${pass1.lastLines}\nPass 2 output:\n${pass2.lastLines}`,
        duration: pass1.duration + pass2.duration,
      };
    }
  }
}

function buildJudgeReasoningPrompt(opts: JudgeEvaluateOptions): string {
  const obsSection =
    opts.observationBeadIds.length > 0
      ? `\n\n## Observation Beads to Triage\n\nReview these observation beads: ${opts.observationBeadIds.join(', ')}\nFor each, decide: promote (create implementation bead), dismiss, or merge with a finding.`
      : '';

  return `You are a judge evaluating an implementation against its specification.

## Frozen Spec
Read the frozen spec at: ${opts.frozenSpecPath}

## Acceptance Criteria
Read the acceptance criteria at: ${opts.acceptancePath}

## Instructions
1. Explore the codebase using tools (Read, Glob, Grep, Bash for git diff/log)
2. Compare the implementation against each section of the frozen spec
3. Evaluate each acceptance criterion
4. Identify any spec drift (missing features, wrong behavior, extra features)

Do NOT modify any files. You are read-only.

Report your findings in detail with evidence (file paths, line numbers, test results).${obsSection}`;
}

function buildJudgeStructuringPrompt(reasoning: string): string {
  return `Parse the following evaluation into a structured JSON object.

## Evaluation
${reasoning}

## Required JSON Structure
{
  "specDrift": {
    "detected": boolean,
    "issues": [{"section": string, "description": string, "severity": "critical"|"major"|"minor"}]
  },
  "acceptance": {
    "passed": boolean,
    "results": [{"criterion": string, "passed": boolean, "evidence": string}]
  },
  "observations": [{"beadId": string, "action": "promote"|"dismiss"|"merge", "reason": string, "mergeWith": string (optional)}],
  "newBeads": [{"title": string, "description": string, "type": "bug"|"task"|"feature"}]
}

Return ONLY the JSON object, no other text.`;
}

function extractJsonFromOutput(output: string): string {
  // Find the first complete JSON object in the output, handling multi-line JSON.
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim().startsWith('{')) continue;

    // Accumulate lines, tracking brace depth
    let depth = 0;
    let candidate = '';
    for (let j = i; j < lines.length; j++) {
      candidate += (j > i ? '\n' : '') + lines[j];
      for (const ch of lines[j]!) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth === 0) {
        try {
          JSON.parse(candidate.trim());
          return candidate.trim();
        } catch {
          break; // malformed — try next start line
        }
      }
    }
  }
  // Last resort: try parsing the whole output
  return output.trim();
}
