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

/** Prefer the server's explicit identity over compatibility component labels. */
export function answerMachineId(
  hub: Pick<SocketHub, 'machines'>,
  requested?: MachineId,
): MachineId | undefined {
  if (requested) return requested
  const machines = hub.machines()
  return (
    machines.find((machine) => machine.serverMoveEligibility?.reason === 'current-server') ??
    machines.find((machine) => machine.components?.includes('server'))
  )?.id
}

export function checkoutRefresh(
  hub: Pick<SocketHub, 'subscribeTopic' | 'machines' | 'on'>,
  machineId: MachineId | undefined,
  path: string,
): AnswerSignal {
  return (changed) => {
    let current: MachineId | undefined
    let release: (() => void) | undefined
    const bind = (): void => {
      // An omitted machine means the server host, never the first remote host.
      const machine = answerMachineId(hub, machineId)
      if (current === machine) return
      release?.()
      current = machine
      release = machine
        ? topicRefresh(hub, 'checkout.changed', checkoutTopicId(machine, path))(changed)
        : undefined
    }
    bind()
    const unlisten = hub.on('machines', bind)
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
