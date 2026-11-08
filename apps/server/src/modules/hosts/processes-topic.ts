import type { MachineId } from '@podium/model'
import type { HostMemoryBreakdown, TopicPayload, TopicWatchMessage } from '@podium/protocol'
import { topicKey } from '@podium/protocol'
import type { TopicProducer } from '../../gateway/topic-routing'

/** The producer holds only live readings, while subscribed. Reclaim selection
 * remains server-authoritative; the daemon supplies the process measurement. */
export class MachineProcessesTopic implements TopicProducer {
  private readonly held = new Map<
    string,
    {
      value?: TopicPayload<'machine.processes'>
      reading: boolean
      preparing?: boolean
      next?: HostMemoryBreakdown
    }
  >()
  constructor(
    private readonly deps: {
      supports: (id: MachineId) => boolean
      roots: (id: MachineId) => Promise<string[]>
      reclaim: (id: MachineId) => Promise<NonNullable<TopicPayload<'machine.processes'>['reclaim']>>
      fallback: (id: MachineId) => Promise<HostMemoryBreakdown>
      send: (id: MachineId, frame: TopicWatchMessage) => void
      publish: (id: string, value: TopicPayload<'machine.processes'> | undefined) => void
      onError?: (error: unknown) => void
    },
  ) {}
  machineOf(id: string): MachineId {
    return id as MachineId
  }
  snapshot(id: string): TopicPayload<'machine.processes'> | undefined {
    return this.held.get(id)?.value
  }
  start(id: string): void {
    // Reattach resets demand, including an outstanding preparation from the old link.
    const state = { reading: false, preparing: true }
    this.held.set(id, state)
    const machine = this.machineOf(id)
    void (async () => {
      if (this.deps.supports(machine)) {
        const roots = await this.deps.roots(machine)
        if (this.held.get(id) === state)
          this.deps.send(machine, {
            type: 'topicWatch',
            key: topicKey('machine.processes', id),
            on: true,
            input: { roots },
          })
      } else {
        // Older daemons: one request on open/reconnect; focus resubscribes for freshness.
        const breakdown = await this.deps.fallback(machine)
        if (this.held.get(id) === state) this.receive(id, breakdown)
      }
    })()
      .catch((error) => {
        if (this.held.get(id) === state) this.deps.onError?.(error)
      })
      .finally(() => {
        state.preparing = false
      })
  }
  unavailable(id: string): void {
    if (!this.held.has(id)) return
    this.held.set(id, { reading: false })
    this.deps.publish(id, undefined)
  }
  refresh(id: string): void {
    const state = this.held.get(id)
    if (state && !state.preparing && !state.reading && !this.deps.supports(this.machineOf(id)))
      this.start(id)
  }
  stop(id: string): void {
    this.held.delete(id)
    const machine = this.machineOf(id)
    if (this.deps.supports(machine))
      this.deps.send(machine, {
        type: 'topicWatch',
        key: topicKey('machine.processes', id),
        on: false,
      })
  }
  receive(id: string, breakdown: HostMemoryBreakdown): void {
    const state = this.held.get(id)
    if (!state) return
    if (state.reading) {
      state.next = breakdown
      return
    }
    state.reading = true
    void (async () => {
      let reclaim: TopicPayload<'machine.processes'>['reclaim']
      let reclaimError: string | undefined
      try {
        reclaim = await this.deps.reclaim(this.machineOf(id))
      } catch (error) {
        reclaimError = error instanceof Error ? error.message : String(error)
      }
      if (this.held.get(id) !== state) return
      state.value = {
        breakdown,
        ...(reclaim ? { reclaim } : {}),
        ...(reclaimError ? { reclaimError } : {}),
      }
      this.deps.publish(id, state.value)
      state.reading = false
      const next = state.next
      state.next = undefined
      if (next) this.receive(id, next)
    })()
  }
}
