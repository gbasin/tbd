/**
 * Subprocess backend — configurable shell command for custom agents.
 *
 * The command receives the prompt via stdin (piped) or as the first argument.
 */

import type { AgentBackend, AgentResult, SpawnOptions } from '../../../../lib/harness/types.js';
import { spawnProcess, toAgentResult } from './backend.js';

export class SubprocessBackend implements AgentBackend {
  name = 'subprocess';

  constructor(private readonly command: string) {}

  async spawn(opts: SpawnOptions): Promise<AgentResult> {
    // Split command into executable and args
    const parts = this.command.split(/\s+/);
    const executable = parts[0]!;
    const baseArgs = parts.slice(1);

    // Pass prompt as final argument
    const args = [...baseArgs, opts.prompt];

    const result = await spawnProcess(executable, args, {
      cwd: opts.workdir,
      timeout: opts.timeout,
      env: opts.env,
    });

    return toAgentResult(result);
  }
}
