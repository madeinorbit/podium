/**
 * `machine.condition` — a server-produced value topic (ADR 7 Amendment 2 D26):
 * `{ online, since }`, read from the daemon connection this server holds, with
 * the presence facts that describe that link (POD-6644: last seen, presence
 * path, availability, daemon readiness). None of them is a record field.
 *
 * `since` is the moment THIS server saw the connection change. It is connection
 * state, which exists only in process; nothing here mirrors a table. A machine
 * the server has not seen connect since it started reads `{ online: false,
 * since: null }`: offline for at least as long as the server has been up, with
 * no invented time.
 */

import type { MachineId } from '@podium/model'
import type { MachineConditionPayload } from '@podium/protocol'

export interface MachineConditionTopicDeps {
  /** The machine's condition now, without `since` (this topic's own memory). */
  readonly condition: (machineId: MachineId) => Omit<MachineConditionPayload, 'since'>
  readonly now: () => number
  /** Hand the newest value to the topic routing (dropped when nobody holds it). */
  readonly publish: (machineId: MachineId, value: MachineConditionPayload) => void
}

export class MachineConditionTopic {
  private readonly since = new Map<MachineId, string>()

  constructor(private readonly deps: MachineConditionTopicDeps) {}

  private readonly online = new Map<MachineId, boolean>()

  snapshot(machineId: MachineId): MachineConditionPayload {
    return { ...this.deps.condition(machineId), since: this.since.get(machineId) ?? null }
  }

  /**
   * The machine's condition moved: its daemon connection attached or detached
   * (which moves `since`), or a presence fact beside it changed.
   */
  changed(machineId: MachineId): void {
    const online = this.deps.condition(machineId).online
    if (this.online.get(machineId) !== online) {
      this.online.set(machineId, online)
      this.since.set(machineId, new Date(this.deps.now()).toISOString())
    }
    this.deps.publish(machineId, this.snapshot(machineId))
  }
}
