/**
 * Prompt assembly for compiler agents.
 *
 * Builds prompts for: coding agents, maintenance agents, judge (pass 1+2).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TBD_GUIDELINES_DIR } from '../../../lib/paths.js';

/**
 * Build prompt for a coding agent working on a single bead.
 */
export async function buildCodingAgentPrompt(opts: {
  beadId: string;
  beadTitle: string;
  beadDescription: string;
  beadType: string;
  beadPriority: number;
  beadDependencies: string;
  frozenSpecPath: string;
  runId: string;
  targetBranch: string;
}): Promise<string> {
  const frozenSpec = await readFile(opts.frozenSpecPath, 'utf-8');

  return `You are a coding agent working on a single task (bead) as part of an automated pipeline. Work ONLY on the bead described below. Do not work on other tasks.

## Your Bead

**ID**: ${opts.beadId}
**Title**: ${opts.beadTitle}
**Type**: ${opts.beadType}
**Priority**: P${opts.beadPriority}
**Dependencies**: ${opts.beadDependencies || 'None'}
**Description**: ${opts.beadDescription || 'See spec for details.'}

## Frozen Spec

${frozenSpec}

## Completion Checklist

You MUST complete ALL of these before exiting:

1. Write code and tests for your bead
2. Run your own tests (the tests you wrote or modified)
3. Typecheck: \`pnpm tsc --noEmit\` (or equivalent)
4. Build: \`pnpm build\` (or equivalent)
5. Lint: \`pnpm lint\` (or equivalent)
6. Push to remote:
   \`\`\`
   git fetch origin ${opts.targetBranch}
   git rebase origin/${opts.targetBranch}
   git push origin HEAD:${opts.targetBranch}
   \`\`\`
   If push fails with non-fast-forward: re-fetch, re-rebase, retry (up to 3 times).
7. Close your bead: \`tbd close ${opts.beadId} --reason="<brief summary>"\`
8. Sync: \`tbd sync\`

## Observation Beads

If you discover out-of-scope issues while working, create observation beads:
\`\`\`
tbd create "Observation: <description>" \\
  --type=task --label=observation --label=compiler-run:${opts.runId}
\`\`\`
Do NOT fix out-of-scope issues yourself. Just log them and move on.

## What NOT to Do

- Do NOT work on other beads
- Do NOT fix other agents' broken tests (maintenance handles that)
- Do NOT read or reference acceptance criteria (you don't have access)
- Do NOT modify the frozen spec`;
}

/**
 * Build system prompt (guidelines) for a coding agent.
 */
export async function loadGuidelines(tbdRoot: string, guidelineNames: string[]): Promise<string> {
  const parts: string[] = [];

  for (const name of guidelineNames) {
    const filePath = join(tbdRoot, TBD_GUIDELINES_DIR, `${name}.md`);
    try {
      const content = await readFile(filePath, 'utf-8');
      parts.push(`## Guideline: ${name}\n\n${content}`);
    } catch {
      // Guideline not found — skip silently
    }
  }

  return parts.join('\n\n');
}

/**
 * Build prompt for a maintenance agent.
 */
export function buildMaintenancePrompt(targetBranch: string, _runId: string): string {
  return `You are a maintenance agent. Your job is to fix breakage introduced by recent merges.

## Instructions

1. Pull latest from the target branch:
   \`\`\`
   git fetch origin ${targetBranch}
   git rebase origin/${targetBranch}
   \`\`\`
2. Run the full test suite, build, typecheck, and lint
3. Fix any failures — focus on:
   - Test regressions from merge conflicts
   - Build errors from incompatible changes
   - Type errors from interface mismatches
   - Import/export issues
4. Do NOT change behavior or add features — only fix breakage
5. Commit with: "chore: fix test/build breakage (maintenance)"
6. Push:
   \`\`\`
   git push origin HEAD:${targetBranch}
   \`\`\`
7. Close your maintenance bead and sync:
   \`\`\`
   tbd close <your-bead-id> --reason="Fixed breakage"
   tbd sync
   \`\`\`

## What NOT to Do

- Do NOT add new features
- Do NOT refactor working code
- Do NOT modify the frozen spec
- Do NOT create observation beads (only coding agents do that)`;
}

/**
 * Build prompt for judge pass 1 (reasoning).
 */
export function buildJudgeReasoningPrompt(
  frozenSpecPath: string,
  acceptancePath: string,
  observationBeadIds: string[],
): string {
  const obsSection =
    observationBeadIds.length > 0
      ? `\n\n## Observation Beads to Triage\n\nReview these observation beads: ${observationBeadIds.join(', ')}\nFor each, decide: promote (create implementation bead), dismiss, or merge with a finding.`
      : '';

  return `You are a judge evaluating an implementation against its specification.

## Frozen Spec
Read the frozen spec at: ${frozenSpecPath}

## Acceptance Criteria
Read the acceptance criteria at: ${acceptancePath}

## Instructions

1. Explore the codebase using tools (Read, Glob, Grep, Bash for git diff/log)
2. Compare the implementation against each section of the frozen spec
3. Evaluate each acceptance criterion by reading code and checking tests
4. Identify any spec drift (missing features, wrong behavior, extra features)
5. For each finding, cite specific files and line numbers as evidence

Do NOT modify any files. You are read-only.

Report your findings in detail.${obsSection}`;
}

/**
 * Build prompt for judge pass 2 (structuring).
 */
export function buildJudgeStructuringPrompt(reasoning: string): string {
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
