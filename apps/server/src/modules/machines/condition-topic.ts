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

import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import type { MachineConditionPayload } from '@podium/protocol'
import type { DaemonLinkKind } from '../../gateway/daemon-link-kind'

const log = createLogger('server:machine-condition')

export interface MachineConditionTopicDeps {
  /** The machine's condition now, without `since` (this topic's own memory) or `linkKind`. */
  readonly condition: (machineId: MachineId) => Omit<MachineConditionPayload, 'since'>
  /**
   * The server's judgement of the connected daemon's link, read when a value
   * is built (POD-7484: it reads the workspace's trusted networks). Absent: no
   * value names a link.
   */
  readonly linkKind?: (machineId: MachineId) => Promise<DaemonLinkKind | undefined>
  readonly now: () => number
  /** Hand the newest value to the topic routing (dropped when nobody holds it). */
  readonly publish: (machineId: MachineId, value: MachineConditionPayload) => void
}

export class MachineConditionTopic {
  private readonly since = new Map<MachineId, string>()
  private readonly online = new Map<MachineId, boolean>()
  /** Per machine, the newest change; a value built for an older one is not published. */
  private readonly changes = new Map<MachineId, number>()
  private changeCount = 0

  constructor(private readonly deps: MachineConditionTopicDeps) {}

  /** The value now. A promise when the link kind has to be read. */
  snapshot(machineId: MachineId): MachineConditionPayload | Promise<MachineConditionPayload> {
    const value = { ...this.deps.condition(machineId), since: this.since.get(machineId) ?? null }
    const linkKind = this.deps.linkKind
    if (linkKind === undefined) return value
    return linkKind(machineId).then((kind) => (kind ? { ...value, linkKind: kind } : value))
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
    const value = this.snapshot(machineId)
    if (!(value instanceof Promise)) {
      this.deps.publish(machineId, value)
      return
    }
    const change = ++this.changeCount
    this.changes.set(machineId, change)
    void value.then(
      (built) => {
        if (this.changes.get(machineId) !== change) return
        this.changes.delete(machineId)
        this.deps.publish(machineId, built)
      },
      (err: unknown) => {
        if (this.changes.get(machineId) === change) this.changes.delete(machineId)
        log.warn('machine condition not published: its link could not be judged', { err })
      },
    )
  }
}
