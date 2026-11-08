import type { HostMetricsWire, MachineWire } from '@podium/model'
import type { TopicKind, TopicPayload } from '@podium/protocol'
import type { TopicListener, TopicState } from '../socket-transport/subscriptions'

/** The slice of the socket hub this service uses. */
export interface HostMetricsHub {
  holdTopics<K extends TopicKind>(
    kind: K,
    ids: readonly string[],
    listener: TopicListener<TopicPayload<K>>,
  ): void
  topicState<K extends TopicKind>(kind: K, id: string): TopicState<TopicPayload<K>> | undefined
  machines(): MachineWire[]
  on(event: 'machines', handler: (machines: MachineWire[]) => void): () => void
}

/**
 * HOST METRICS, ON DEMAND (ADR 7 Amendment 2; POD-5800).
 *
 * The thin service today's readers go through (the header strip, the machine
 * panels, mobile Pulse) until the LiveStore (POD-5798) takes them over. Its
 * read surface is the store the readers already used, `subscribe` and
 * `getSnapshot`; what changed is where the numbers come from:
 *
 * - while at least one reader is subscribed, it holds `machine.metrics:<id>`
 *   for every machine the client knows, following the machine list;
 * - when the last reader leaves, it releases them all, and a daemon nobody
 *   else watches stops sampling.
 *
 * The snapshot lists the machines whose topic currently holds a value, in
 * machine-list order. A machine that is pending or unknown is simply absent,
 * which is how every reader already showed "no sample": a fresh client never
 * shows a stale number.
 */
export function createHostMetricsService(hub: HostMetricsHub) {
  let snapshot: HostMetricsWire[] = []
  let destroyed = false
  let rebuildQueued = false
  let offMachines: (() => void) | undefined
  const listeners = new Set<() => void>()
  const holder: TopicListener<HostMetricsWire> = { onState: () => queueRebuild() }

  const machineIds = (): string[] => hub.machines().map((machine) => String(machine.id))

  function rebuild(): void {
    rebuildQueued = false
    if (destroyed) return
    const next: HostMetricsWire[] = []
    for (const id of listeners.size > 0 ? machineIds() : []) {
      const state = hub.topicState('machine.metrics', id)
      if (state?.status === 'value') next.push(state.value)
    }
    if (
      next.length === snapshot.length &&
      next.every((value, index) => value === snapshot[index])
    ) {
      return
    }
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  /** One rebuild per burst: N machines answering one reconnect is one publish. */
  function queueRebuild(): void {
    if (rebuildQueued || destroyed) return
    rebuildQueued = true
    queueMicrotask(rebuild)
  }

  function demand(): void {
    hub.holdTopics('machine.metrics', listeners.size > 0 ? machineIds() : [], holder)
    queueRebuild()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      if (destroyed) return () => {}
      listeners.add(listener)
      if (listeners.size === 1) {
        offMachines = hub.on('machines', demand)
        demand()
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        offMachines?.()
        offMachines = undefined
        demand()
      }
    },
    destroy(): void {
      if (destroyed) return
      const held = listeners.size > 0
      listeners.clear()
      offMachines?.()
      offMachines = undefined
      if (held) hub.holdTopics('machine.metrics', [], holder)
      destroyed = true
      snapshot = []
    },
  }
}
