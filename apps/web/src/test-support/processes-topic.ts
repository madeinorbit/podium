import type { SocketHub, TopicListener, TopicState } from '@podium/client-core/socket-transport'
import type { TopicPayload } from '@podium/protocol'

type Value = TopicPayload<'machine.processes'>
/** A demand-bound transport for panel tests. Production view models stay real. */
export function processesTopicFixture(read: () => Promise<Value>) {
  const held = new Map<string, { listeners: Set<TopicListener<Value>>; state: TopicState<Value> }>()
  const sample = (id: string): void => {
    const entry = held.get(id)
    if (!entry) return
    void read().then((value) => {
      if (held.get(id) !== entry) return
      entry.state = { status: 'value', value, position: { epoch: 'test', seq: 1 } }
      for (const listener of entry.listeners) listener.onState?.(entry.state)
    })
  }
  const hub = {
    machines: () => [],
    on: () => () => {},
    subscribeTopic(_kind: string, id: string, listener: TopicListener<Value>) {
      let entry = held.get(id)
      if (!entry) {
        entry = { listeners: new Set(), state: { status: 'pending' } }
        held.set(id, entry)
        sample(id)
      }
      entry.listeners.add(listener)
      listener.onState?.(entry.state)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0) held.delete(id)
      }
    },
    refreshTopic: (_kind: string, id: string) => sample(id),
  } as unknown as SocketHub
  return {
    hub,
    get holders() {
      return [...held.values()].reduce((n, entry) => n + entry.listeners.size, 0)
    },
  }
}
