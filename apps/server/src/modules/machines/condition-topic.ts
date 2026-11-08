/**
 * `machine.condition` — a server-produced value topic (ADR 7 Amendment 2 D26):
 * `{ online, since }`, read from the daemon connection this server holds.
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
  /** A live daemon socket for this machine, right now. */
  readonly online: (machineId: MachineId) => boolean
  readonly now: () => number
  /** Hand the newest value to the topic routing (dropped when nobody holds it). */
  readonly publish: (machineId: MachineId, value: MachineConditionPayload) => void
}

export class MachineConditionTopic {
  private readonly since = new Map<MachineId, string>()

  constructor(private readonly deps: MachineConditionTopicDeps) {}

  snapshot(machineId: MachineId): MachineConditionPayload {
    return { online: this.deps.online(machineId), since: this.since.get(machineId) ?? null }
  }

  /** The daemon connection for this machine attached or detached. */
  changed(machineId: MachineId): void {
    this.since.set(machineId, new Date(this.deps.now()).toISOString())
    this.deps.publish(machineId, this.snapshot(machineId))
  }
}
