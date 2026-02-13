/**
 * Claude Code backend implementation.
 *
 * Spawns `claude -p "..." --output-format json --dangerously-skip-permissions`
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

export class ClaudeCodeBackend implements AgentBackend {
  name = 'claude-code';

  async spawn(opts: SpawnOptions): Promise<AgentResult> {
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--allowedTools',
      'Edit,Write,Bash,Read,Glob,Grep',
      '--no-session-persistence',
      '--max-turns',
      '100',
    ];

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
    // Pass 1: Reasoning (natural language)
    const reasoningPrompt = buildJudgeReasoningPrompt(opts);
    const pass1 = await spawnProcess(
      'claude',
      [
        '-p',
        reasoningPrompt,
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
        '--allowedTools',
        'Read,Glob,Grep,Bash',
        '--no-session-persistence',
      ],
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

    // Pass 2: Structuring (JSON schema)
    const structuringPrompt = buildJudgeStructuringPrompt(pass1.lastLines);
    const pass2 = await spawnProcess(
      'claude',
      [
        '-p',
        structuringPrompt,
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
        '--no-session-persistence',
      ],
      {
        cwd: opts.workdir,
        timeout: 120_000, // 2 min for structuring
        env: opts.env,
      },
    );

    try {
      // Try to parse the structured output
      const parsed = JSON.parse(extractJsonFromOutput(pass2.lastLines));
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
  "observations": [{"beadId": string, "action": "promote"|"dismiss"|"merge", "reason": string}],
  "newBeads": [{"title": string, "description": string, "type": "bug"|"task"|"feature"}]
}

Return ONLY the JSON object, no other text.`;
}

function extractJsonFromOutput(output: string): string {
  // Find the first complete JSON object in the output, handling multi-line JSON.
  // Claude Code --output-format json may emit envelopes or multi-line objects.
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
