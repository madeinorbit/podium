import { expect, it } from 'vitest'
import type { PodiumClientApi } from './api'
import { createReplicatedLayoutController } from './engine/replicated-layout'
import type { StoreNotices } from './engine/types'
import type { EngineOutbox } from './engine/wiring'
import type { OutboxEntry } from './outbox'
import { createSideCache, memoryStorage } from './replica'
import type { StorageEventApi } from './replica/contract'

it('publishes exact keys for local writes and cross-tab additions, changes and removals', () => {
  const storage = memoryStorage()
  let deliver!: (event: StorageEvent) => void
  const storageEventApi: StorageEventApi = {
    addEventListener: (_event, listener) => {
      deliver = listener
    },
    removeEventListener: () => {},
  }
  const side = createSideCache({
    storage,
    keyPrefix: 'keyed-ui',
    enumerateKeys: () => [],
    storageEventApi,
  })
  const ui = side.uiState(),
    changes: string[][] = []
  const stop = ui.subscribe((keys) => changes.push([...keys].sort()))
  try {
    ui.set('one', '1')
    ui.set('two', '2')
    expect(changes).toEqual([['one'], ['two']])
    changes.length = 0
    storage.setItem('keyed-ui.uistate.v1', JSON.stringify({ one: 'new', two: '2', three: '3' }))
    deliver({ key: 'keyed-ui.uistate.v1' } as StorageEvent)
    expect(changes).toEqual([['one', 'three']])
    expect(ui.get('one')).toBe('new')
    changes.length = 0
    storage.setItem('keyed-ui.uistate.v1', JSON.stringify({ two: '2', three: '3' }))
    deliver({ key: 'keyed-ui.uistate.v1' } as StorageEvent)
    expect(changes).toEqual([['one']])
    expect(ui.get('one')).toBeNull()
  } finally {
    stop()
    side.dispose()
  }
})

it('publishes only changed layout keys through optimism, queue drain and authoritative replacement', async () => {
  const pending: OutboxEntry[] = []
  let sequence = 0
  let controller!: ReturnType<typeof createReplicatedLayoutController>
  const outbox = {
    pending: () => pending,
    awaiting: () => [],
    retireAwaiting: () => {},
    enqueue: (kind: string, input: unknown) => {
      const entry = {
        kind,
        input,
        queuedAt: ++sequence,
        mutationId: `keyed-${sequence}`,
      } as OutboxEntry
      pending.push(entry)
      controller.outboxChanged()
      return entry
    },
  } as unknown as EngineOutbox
  controller = createReplicatedLayoutController({
    api: {} as PodiumClientApi,
    outbox,
    notices: { error: () => {}, info: () => {} } as StoreNotices,
    seed: { 'sidebar.section.one': 'saved' },
  })
  const changes: string[][] = []
  const stop = controller.subscribe((keys) => {
    if (keys.size) changes.push([...keys].sort())
  })
  try {
    controller.set('sidebar.section.one', '1')
    await Promise.resolve()
    await Promise.resolve()
    expect(changes).toEqual([['sidebar.section.one']])
    expect(controller.get('sidebar.section.one')).toBe('1')
    changes.length = 0
    controller.set('sidebar.section.two', '2')
    await Promise.resolve()
    await Promise.resolve()
    expect(changes).toEqual([['sidebar.section.two']])
    changes.length = 0
    pending.shift()
    controller.outboxChanged()
    expect(changes).toEqual([['sidebar.section.one']])
    expect(controller.get('sidebar.section.one')).toBe('saved')
    changes.length = 0
    controller.replace({ 'sidebar.section.one': 'feed' })
    expect(changes).toEqual([['sidebar.section.one']])
    expect(controller.get('sidebar.section.two')).toBe('2')
  } finally {
    stop()
  }
})
