/**
 * Codex CLI backend implementation.
 *
 * Spawns `codex exec "..." --cd <workdir> --ask-for-approval never`
 */

import type {
  AgentBackend,
  JudgeBackend,
  AgentResult,
  JudgeResult,
  SpawnOptions,
  JudgeEvaluateOptions,
} from '../../../../lib/harness/types.js';
import { JudgeResultSchema } from '../../../../lib/harness/types.js';
import { spawnProcess, toAgentResult } from './backend.js';

export class CodexBackend implements AgentBackend {
  name = 'codex';

  async spawn(opts: SpawnOptions): Promise<AgentResult> {
    const prompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;

    const args = [
      'exec',
      prompt,
      '--cd',
      opts.workdir,
      '--ask-for-approval',
      'never',
      '--json',
      '--ephemeral',
    ];

    const result = await spawnProcess('codex', args, {
      cwd: opts.workdir,
      timeout: opts.timeout,
      env: opts.env,
    });

    return toAgentResult(result);
  }
}

export class CodexJudge implements JudgeBackend {
  name = 'codex';

  async evaluate(opts: JudgeEvaluateOptions): Promise<JudgeResult> {
    const obsSection =
      opts.observationBeadIds.length > 0
        ? `\nReview observation beads: ${opts.observationBeadIds.join(', ')}`
        : '';

    // Pass 1: Reasoning (read-only sandbox)
    const reasoningPrompt =
      `Evaluate the implementation against the frozen spec at ${opts.frozenSpecPath} ` +
      `and acceptance criteria at ${opts.acceptancePath}. ` +
      `Explore the codebase, compare against spec, report findings.${obsSection}`;

    const pass1 = await spawnProcess(
      'codex',
      [
        'exec',
        reasoningPrompt,
        '--cd',
        opts.workdir,
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--ephemeral',
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

    // Pass 2: Structuring
    const structuringPrompt =
      `Parse this evaluation into JSON: ${pass1.lastLines}\n\n` +
      'Return: {"specDrift":{"detected":bool,"issues":[...]}, "acceptance":{"passed":bool,"results":[...]}, ' +
      '"observations":[...], "newBeads":[...]}';

    const pass2 = await spawnProcess(
      'codex',
      [
        'exec',
        structuringPrompt,
        '--cd',
        opts.workdir,
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--ephemeral',
      ],
      {
        cwd: opts.workdir,
        timeout: 120_000,
        env: opts.env,
      },
    );

    try {
      const lines = pass2.lastLines.split('\n');
      let jsonStr = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          jsonStr = trimmed;
          break;
        }
      }
      const parsed = JSON.parse(jsonStr || pass2.lastLines.trim());
      return JudgeResultSchema.parse({
        ...parsed,
        status: 'success',
        lastLines: pass2.lastLines,
        duration: pass1.duration + pass2.duration,
      });
    } catch {
      return {
        status: 'failure',
        specDrift: { detected: false, issues: [] },
        acceptance: { passed: false, results: [] },
        observations: [],
        newBeads: [],
        lastLines: pass2.lastLines,
        duration: pass1.duration + pass2.duration,
      };
    }
  }
}
