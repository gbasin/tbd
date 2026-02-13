/**
 * Auto-detect available agent backend from PATH.
 *
 * Checks for `claude` then `codex` in order.
 */

import { execFileSync } from 'node:child_process';

import type { AgentBackend, JudgeBackend } from '../../../../lib/compiler/types.js';
import { ClaudeCodeBackend, ClaudeCodeJudge } from './claude-code.js';
import { CodexBackend, CodexJudge } from './codex.js';
import { SubprocessBackend } from './subprocess.js';

function isInPath(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect and create the agent backend.
 *
 * @param preference - 'auto' | 'claude-code' | 'codex' | 'subprocess'
 * @param customCommand - Command for subprocess backend
 */
export function createAgentBackend(
  preference: string,
  customCommand?: string | null,
): AgentBackend {
  if (preference === 'subprocess') {
    if (!customCommand) {
      throw new Error('Subprocess backend requires agent.command in config');
    }
    return new SubprocessBackend(customCommand);
  }

  if (preference === 'claude-code') {
    if (!isInPath('claude')) {
      throw new Error(
        'Claude Code CLI not found in PATH. Install: npm install -g @anthropic-ai/claude-code',
      );
    }
    return new ClaudeCodeBackend();
  }

  if (preference === 'codex') {
    if (!isInPath('codex')) {
      throw new Error('Codex CLI not found in PATH. Install: npm install -g @openai/codex');
    }
    return new CodexBackend();
  }

  // Auto-detect: try claude first, then codex
  if (isInPath('claude')) {
    return new ClaudeCodeBackend();
  }
  if (isInPath('codex')) {
    return new CodexBackend();
  }

  throw new Error(
    'No supported agent backend found in PATH. Install one of:\n' +
      '  - Claude Code: npm install -g @anthropic-ai/claude-code\n' +
      '  - Codex: npm install -g @openai/codex',
  );
}

/**
 * Detect and create the judge backend.
 */
export function createJudgeBackend(preference: string): JudgeBackend {
  if (
    preference === 'codex' ||
    (preference === 'auto' && !isInPath('claude') && isInPath('codex'))
  ) {
    return new CodexJudge();
  }
  // Default to Claude Code judge
  return new ClaudeCodeJudge();
}

/**
 * Resolve a BackendSpec (single string or array) into an AgentBackend.
 * When given an array, picks one at random.
 */
export function resolveBackendSpec(spec: string | string[], command?: string | null): AgentBackend {
  const choice = Array.isArray(spec) ? spec[Math.floor(Math.random() * spec.length)]! : spec;
  return createAgentBackend(choice, command);
}

/**
 * Resolve a BackendSpec (single string or array) into a JudgeBackend.
 * When given an array, picks one at random.
 */
export function resolveJudgeBackendSpec(spec: string | string[]): JudgeBackend {
  const choice = Array.isArray(spec) ? spec[Math.floor(Math.random() * spec.length)]! : spec;
  return createJudgeBackend(choice);
}
