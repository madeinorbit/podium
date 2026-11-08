/**
 * THE HIBERNATION SWEEP IS A VIEWER (ADR 7 Amendment 2 D21; POD-5800).
 *
 * `HostsService.onHostMetrics` runs the memory, load and idle-count pressure
 * policy on every host sample. A daemon that speaks `topics.v1` samples only
 * while `machine.metrics:<id>` is held, so the sweep holds that key itself, as a
 * named server-side subscriber on the one registry, for every connected machine
 * while hibernation is enabled. Demand stays "subscriber count", with no second
 * rule: switch hibernation off, close every client, and the daemon samples
 * nothing.
 */

import type { MachineId } from '@podium/model'

export const HIBERNATION_HOLDER = 'hibernation'

export interface MetricsDemandDeps {
  readonly hold: (machineId: MachineId) => void
  readonly release: (machineId: MachineId) => void
  readonly enabled: () => Promise<boolean>
  readonly onlineMachineIds: () => readonly MachineId[]
}

export class HibernationMetricsDemand {
  /** Bumped on every decision, so a late settings read cannot undo a newer one. */
  private generation = 0

  constructor(private readonly deps: MetricsDemandDeps) {}

  async connected(machineId: MachineId): Promise<void> {
    const generation = ++this.generation
    const enabled = await this.deps.enabled()
    if (generation !== this.generation) return void (await this.reevaluate())
    if (enabled) this.deps.hold(machineId)
  }

  disconnected(machineId: MachineId): void {
    this.deps.release(machineId)
  }

  /** Hibernation may have been switched on or off: re-decide for every connected machine. */
  async reevaluate(): Promise<void> {
    const generation = ++this.generation
    const enabled = await this.deps.enabled()
    if (generation !== this.generation) return
    for (const machineId of this.deps.onlineMachineIds()) {
      if (enabled) this.deps.hold(machineId)
      else this.deps.release(machineId)
    }
  }
}
