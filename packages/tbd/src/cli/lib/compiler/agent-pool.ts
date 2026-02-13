/**
 * Concurrent agent pool for the compiler.
 *
 * Manages up to maxConcurrency agent slots with spawn/monitor/kill lifecycle.
 */

import type { AgentBackend, AgentResult, SpawnOptions } from '../../../lib/compiler/types.js';

export interface PoolSlot {
  agentId: number;
  beadId: string;
  promise: Promise<AgentResult>;
  startedAt: Date;
}

export class AgentPool {
  private slots = new Map<number, PoolSlot>();
  private nextAgentId = 1;

  constructor(
    private readonly backend: AgentBackend,
    private readonly maxConcurrency: number,
  ) {}

  /** Current number of active agents. */
  get activeCount(): number {
    return this.slots.size;
  }

  /** Whether there's room for another agent. */
  get hasCapacity(): boolean {
    return this.slots.size < this.maxConcurrency;
  }

  /** Get all active slot info. */
  getActiveSlots(): PoolSlot[] {
    return Array.from(this.slots.values());
  }

  /**
   * Assign a bead to an agent slot. Spawns the agent and returns the slot.
   */
  assign(beadId: string, opts: SpawnOptions): PoolSlot {
    const agentId = this.nextAgentId++;
    const promise = this.backend.spawn(opts);

    const slot: PoolSlot = {
      agentId,
      beadId,
      promise,
      startedAt: new Date(),
    };

    this.slots.set(agentId, slot);

    // Auto-remove from pool when done
    promise
      .then(() => {
        this.slots.delete(agentId);
      })
      .catch(() => {
        this.slots.delete(agentId);
      });

    return slot;
  }

  /**
   * Wait for any one agent to complete. Returns the completed slot's result.
   * Returns null if no agents are running.
   */
  async waitForAny(): Promise<{ slot: PoolSlot; result: AgentResult } | null> {
    if (this.slots.size === 0) return null;

    const entries = Array.from(this.slots.entries());
    const wrappedPromises = entries.map(([id, slot]) =>
      slot.promise.then(
        (result) => ({ id, slot, result }),
        (error) => ({
          id,
          slot,
          result: {
            status: 'failure' as const,
            exitCode: 1,
            lastLines: error instanceof Error ? error.message : String(error),
            duration: Date.now() - slot.startedAt.getTime(),
          },
        }),
      ),
    );

    const completed = await Promise.race(wrappedPromises);
    this.slots.delete(completed.id);
    return { slot: completed.slot, result: completed.result };
  }

  /**
   * Wait for all agents to complete.
   */
  async waitForAll(): Promise<void> {
    while (this.slots.size > 0) {
      await this.waitForAny();
    }
  }
}
