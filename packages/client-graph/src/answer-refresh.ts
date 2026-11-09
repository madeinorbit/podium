import type { Replica } from '@podium/client-core/replica'
import type { SocketHub, TopicState } from '@podium/client-core/socket-transport'
import type { MachineId } from '@podium/model'
import { checkoutTopicId, type TopicKind, type TopicPayload } from '@podium/protocol'

/** Each request owner declares why it can change. No schedule is a refresh source. */
export type AnswerSignal = (changed: () => void) => () => void

/** Browser focus/visibility is also the declared fallback for older daemons.
 * Native views supply AppState through their platform adapter. */
export const focusRefresh: AnswerSignal = (changed) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const wake = (): void => {
    if (document.visibilityState !== 'hidden') changed()
  }
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  return () => {
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}

export function topicRefresh<K extends TopicKind>(
  hub: Pick<SocketHub, 'subscribeTopic'>,
  kind: K,
  id: string,
): AnswerSignal {
  return (changed) => {
    let version: string | undefined
    return hub.subscribeTopic(kind, id, {
      onState: (state: TopicState<TopicPayload<K>>) => {
        if (state.status !== 'value') return
        const next = `${state.position.epoch}:${state.position.seq}`
        if (next === version) return
        version = next
        changed()
      },
    })
  }
}

/** The machines a request answer may be about: my access rows (POD-6644). */
export interface AnswerMachines {
  /** The machine the server runs on, when I may see it. */
  serverMachineId(): MachineId | undefined
  /** Run `changed` after my machines may have moved. Answers the unsubscribe. */
  subscribe(changed: () => void): () => void
}

type MachineReplica = Pick<Replica, 'rows' | 'subscribeAddressedBatch'>

/** {@link AnswerMachines} over the replica's `machineAccess` records. Prefers
 *  the server's explicit identity over compatibility component labels. */
export function replicaAnswerMachines(replica: MachineReplica): AnswerMachines {
  return {
    serverMachineId() {
      const rows = replica.rows('machineAccess')
      return (
        rows.find((row) => row.hostsServer === true) ??
        rows.find((row) => row.components?.includes('server'))
      )?.machineId
    },
    subscribe(changed) {
      return (
        replica.subscribeAddressedBatch?.((batch) => {
          if (batch.type === 'replace' || batch.rows.some((row) => row.kind === 'machineAccess')) {
            changed()
          }
        }) ?? (() => {})
      )
    },
  }
}

export function answerMachineId(
  machines: AnswerMachines,
  requested?: MachineId,
): MachineId | undefined {
  return requested ?? machines.serverMachineId()
}

export function checkoutRefresh(
  hub: Pick<SocketHub, 'subscribeTopic'>,
  machines: AnswerMachines,
  machineId: MachineId | undefined,
  path: string,
): AnswerSignal {
  return (changed) => {
    let current: MachineId | undefined
    let release: (() => void) | undefined
    const bind = (): void => {
      // An omitted machine means the server host, never the first remote host.
      const machine = answerMachineId(machines, machineId)
      if (current === machine) return
      release?.()
      current = machine
      release = machine
        ? topicRefresh(hub, 'checkout.changed', checkoutTopicId(machine, path))(changed)
        : undefined
    }
    bind()
    const unlisten = machines.subscribe(bind)
    const unfocus = focusRefresh(changed)
    return () => {
      release?.()
      unlisten()
      unfocus()
    }
  }
}

/** One in-flight refresh plus a trailing read if a change arrived during it.
 * This avoids dropping the final edit while an older answer is being fetched. */
export class AnswerRefresh {
  private stop: (() => void) | undefined
  private running = false
  private dirty = false
  private generation = 0
  constructor(
    private readonly read: () => Promise<unknown> | void,
    readonly signal: AnswerSignal = focusRefresh,
  ) {}
  open(): void {
    if (this.stop) return
    this.stop = () => {}
    let subscribing = true
    this.stop = this.signal(() => {
      if (!subscribing) this.refresh()
    })
    subscribing = false
    this.refresh()
  }
  refresh(): void {
    if (!this.stop) return
    if (this.running) {
      this.dirty = true
      return
    }
    const generation = this.generation
    this.running = true
    void Promise.resolve()
      .then(() => {
        if (generation === this.generation && this.stop) return this.read()
      })
      .catch(() => {})
      .finally(() => {
        if (generation !== this.generation) return
        this.running = false
        if (this.dirty) {
          this.dirty = false
          this.refresh()
        }
      })
  }
  close(): void {
    this.stop?.()
    this.stop = undefined
    this.generation += 1
    this.running = false
    this.dirty = false
  }
}
