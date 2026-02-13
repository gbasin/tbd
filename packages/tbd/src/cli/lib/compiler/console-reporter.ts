/**
 * Real-time console reporter for tbd compile milestones.
 *
 * Prints major pipeline events to stderr so the user isn't blind
 * while the pipeline runs. Uses stderr to keep stdout clean for
 * structured/JSON output.
 */

import pc from 'picocolors';

const PREFIX = pc.dim('[compile]');

function ts(): string {
  return pc.dim(new Date().toLocaleTimeString());
}

function log(msg: string): void {
  console.error(`${PREFIX} ${ts()} ${msg}`);
}

export const ConsoleReporter = {
  runStarted(runId: string, specPath: string): void {
    log(`${pc.bold('Run started')} ${pc.dim(runId)}`);
    log(`  Spec: ${specPath}`);
  },

  runResumed(runId: string, phase: string): void {
    log(`${pc.bold('Resuming')} ${pc.dim(runId)} from ${phase}`);
  },

  specFrozen(hash: string): void {
    log(`${pc.green('✓')} Spec frozen ${pc.dim(hash.slice(0, 12))}`);
  },

  acceptanceGenerated(): void {
    log(`${pc.green('✓')} Acceptance criteria generated`);
  },

  beadsCreated(count: number): void {
    log(`${pc.green('✓')} ${count} beads created`);
  },

  phaseStarted(phase: string, iteration?: number): void {
    const iterStr = iteration ? ` ${pc.dim(`(iteration ${iteration})`)}` : '';
    log(`${pc.blue('→')} Phase: ${pc.bold(phase)}${iterStr}`);
  },

  agentStarted(beadId: string, beadTitle: string): void {
    log(`  ${pc.dim('▶')} Agent started: ${beadTitle} ${pc.dim(beadId)}`);
  },

  agentFinished(beadId: string, status: string, durationMs: number): void {
    const dur = formatDuration(durationMs);
    const icon = status === 'success' ? pc.green('✓') : pc.red('✗');
    log(`  ${icon} Agent finished ${pc.dim(beadId)} ${pc.dim(dur)}`);
  },

  beadCompleted(beadId: string): void {
    log(`  ${pc.green('✓')} Bead completed ${pc.dim(beadId)}`);
  },

  beadBlocked(beadId: string, reason: string): void {
    log(`  ${pc.red('●')} Bead blocked ${pc.dim(beadId)} — ${reason}`);
  },

  beadRetry(beadId: string, attempt: number): void {
    log(`  ${pc.yellow('↻')} Retrying bead ${pc.dim(beadId)} (attempt ${attempt})`);
  },

  maintenanceStarted(index: number): void {
    log(`  ${pc.blue('⚙')} Maintenance #${index} started`);
  },

  maintenanceFinished(index: number, status: string, durationMs: number): void {
    const dur = formatDuration(durationMs);
    const icon = status === 'success' ? pc.green('✓') : pc.red('✗');
    log(`  ${icon} Maintenance #${index} finished ${pc.dim(dur)}`);
  },

  judgeVerdict(iteration: number, passed: boolean, newBeads: number): void {
    if (passed) {
      log(`${pc.green('✓')} Judge passed ${pc.dim(`(iteration ${iteration})`)}`);
    } else {
      log(
        `${pc.yellow('✗')} Judge failed ${pc.dim(`(iteration ${iteration})`)} — ${newBeads} remediation beads`,
      );
    }
  },

  prCreated(url: string): void {
    log(`${pc.green('✓')} PR created: ${url}`);
  },

  runCompleted(totalBeads: number, iterations: number): void {
    log(
      `${pc.green(pc.bold('✓ Pipeline completed'))} — ${totalBeads} beads, ${iterations} iterations`,
    );
  },

  runFailed(message: string): void {
    log(`${pc.red(pc.bold('✗ Pipeline failed'))} — ${message}`);
  },

  runInterrupted(): void {
    log(`${pc.yellow('⚠')} Run interrupted — checkpoint saved`);
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}
