import type { HostMetricsWire, MachineWire } from '@podium/model'
import type { TopicKind } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { ClientSubscriptionRegistry, type TopicListener } from '../socket-transport/subscriptions'
import { createHostMetricsService, type HostMetricsHub } from './host-metrics'

/** A hub over the REAL client registry; frames out are recorded, frames in are injected. */
function fakeHub(initial: string[]) {
  const registry = new ClientSubscriptionRegistry(false)
  const sent: string[] = []
  let machines = initial.map((id) => ({ id }) as unknown as MachineWire)
  const machineListeners = new Set<(m: MachineWire[]) => void>()
  const hub: HostMetricsHub = {
    holdTopics(kind, ids, listener) {
      const held = listener as TopicListener
      const wanted = new Set(ids)
      for (const id of registry.topicIdsHeldBy(kind, held)) {
        if (wanted.delete(id)) continue
        if (registry.releaseTopic(kind, id, held)) sent.push(`-${kind}:${id}`)
      }
      for (const id of wanted) {
        if (registry.acquireTopic(kind, id, held).fresh) sent.push(`+${kind}:${id}`)
      }
    },
    topicState: (kind, id) => registry.topic(kind as TopicKind, id)?.state as never,
    machines: () => machines,
    on: (_event, handler) => {
      machineListeners.add(handler)
      return () => machineListeners.delete(handler)
    },
  }
  return {
    hub,
    sent,
    snapshot(id: string, value: HostMetricsWire | undefined) {
      const entry = registry.topic('machine.metrics', id)
      if (!entry) return
      registry.applyTopicSnapshot(entry, { epoch: 'e', seq: 0 }, value)
      for (const listener of entry.listeners) listener.onState?.(entry.state)
    },
    setMachines(ids: string[]) {
      machines = ids.map((id) => ({ id }) as unknown as MachineWire)
      for (const listener of machineListeners) listener(machines)
    },
  }
}

const sample = (id: string): HostMetricsWire => ({
  hostname: `host-${id}`,
  machineId: id as never,
  sampledAt: '2026-11-08T00:00:00.000Z',
  memory: { totalBytes: 2, availableBytes: 1, swapTotalBytes: 0, swapFreeBytes: 0 },
})

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('host metrics service (POD-5800)', () => {
  it('holds no topic until a reader subscribes, and releases them all with the last reader', async () => {
    const f = fakeHub(['m1', 'm2'])
    const service = createHostMetricsService(f.hub)
    expect(f.sent).toEqual([])
    const offA = service.subscribe(() => {})
    const offB = service.subscribe(() => {})
    expect(f.sent).toEqual(['+machine.metrics:m1', '+machine.metrics:m2'])
    offA()
    expect(f.sent).toHaveLength(2)
    offB()
    expect(f.sent).toEqual([
      '+machine.metrics:m1',
      '+machine.metrics:m2',
      '-machine.metrics:m1',
      '-machine.metrics:m2',
    ])
    await tick()
    expect(service.getSnapshot()).toEqual([])
  })

  it('shows nothing before a snapshot, then the values, in machine-list order', async () => {
    const f = fakeHub(['m1', 'm2'])
    const service = createHostMetricsService(f.hub)
    let heard = 0
    service.subscribe(() => {
      heard += 1
    })
    await tick()
    expect(service.getSnapshot()).toEqual([])
    f.snapshot('m2', sample('m2'))
    f.snapshot('m1', sample('m1'))
    await tick()
    expect(service.getSnapshot().map((h) => h.machineId)).toEqual(['m1', 'm2'])
    // Two snapshots in one turn are one publish.
    expect(heard).toBe(1)
    // Unknown removes the machine rather than keeping a stale number.
    f.snapshot('m1', undefined)
    await tick()
    expect(service.getSnapshot().map((h) => h.machineId)).toEqual(['m2'])
  })

  it('follows the machine list while read', () => {
    const f = fakeHub(['m1'])
    const service = createHostMetricsService(f.hub)
    service.subscribe(() => {})
    f.setMachines(['m1', 'm3'])
    f.setMachines(['m3'])
    expect(f.sent).toEqual(['+machine.metrics:m1', '+machine.metrics:m3', '-machine.metrics:m1'])
  })
})
