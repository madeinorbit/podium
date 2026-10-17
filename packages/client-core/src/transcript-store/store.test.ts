import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { createSideCache } from '../replica/kernel/side-cache'
import type { StoredTranscriptMessage } from './backend'
import { openIndexedDbTranscriptBackend } from './indexeddb'
import { createMemoryTranscriptBackend } from './memory'
import { createTranscriptStore, type TranscriptStoreChange } from './store'

const DAY = 24 * 60 * 60 * 1000

function clock(start = 1_000_000) {
  let at = start
  return { now: () => at, advance: (ms: number) => void (at += ms) }
}

const message = (chat: string, i: number, size = 0): StoredTranscriptMessage => ({
  id: `${chat}-${i}`,
  seq: i * 1024,
  json: JSON.stringify({ id: `${chat}-${i}`, role: 'assistant', text: 'x'.repeat(size) }),
})

const put = (count: number, chat: string, size = 0, from = 0): TranscriptStoreChange => ({
  upsert: Array.from({ length: count }, (_, i) => message(chat, from + i, size)),
})

describe('transcript store limits', () => {
  it('keeps the newest 2,000 messages of a chat that goes over', async () => {
    const backend = createMemoryTranscriptBackend()
    const store = createTranscriptStore({ backend, now: clock().now })
    await store.put('chat', put(1_500, 'chat'))
    await store.put('chat', put(700, 'chat', 0, 1_500))
    const chats = await backend.chats()
    expect(chats[0]).toMatchObject({ count: 2_000 })
    const oldest = await store.readBefore('chat', 200 * 1024 + 1, 5)
    expect(oldest.messages.map((m) => m.item.id)).toEqual(['chat-200'])
    expect(oldest.hasOlder).toBe(false)
    const newest = await store.readNewest('chat', 3)
    expect(newest.messages.map((m) => m.item.id)).toEqual(['chat-2197', 'chat-2198', 'chat-2199'])
    expect(newest.hasOlder).toBe(true)
  })

  it('deletes a chat not opened for 31 days, and keeps a held or recently opened one', async () => {
    const time = clock()
    const backend = createMemoryTranscriptBackend()
    const store = createTranscriptStore({ backend, now: time.now })
    await store.put('stale', put(3, 'stale'))
    await store.put('held', put(3, 'held'))
    await store.put('recent', put(3, 'recent'))
    const release = store.hold('held')
    time.advance(31 * DAY)
    store.touch('recent')
    await store.sweep()
    expect((await backend.chats()).map((c) => c.chat).sort()).toEqual(['held', 'recent'])
    release()
    await store.sweep()
    expect((await backend.chats()).map((c) => c.chat).sort()).toEqual(['recent'])
    expect((await store.readNewest('stale', 5)).messages).toEqual([])
  })

  it('over 10 MB deletes whole oldest-opened chats until under 9 MB, never an open or warm one', async () => {
    const time = clock()
    const backend = createMemoryTranscriptBackend()
    const store = createTranscriptStore({ backend, now: time.now })
    const MB = 1024 * 1024
    // Ten chats of ~1 MB each (20 rows of ~50 KB), opened in order c0..c9.
    // c0 is the oldest-opened, but it stays open (held): c1 and c2 must go instead.
    let release = () => {}
    for (let c = 0; c < 10; c++) {
      await store.put(`c${c}`, put(20, `c${c}`, 50 * 1024))
      if (c === 0) release = store.hold('c0')
      time.advance(1_000)
    }
    const before = await backend.chats()
    const total = (rows: { bytes: number }[]) => rows.reduce((sum, row) => sum + row.bytes, 0)
    expect(total(before)).toBeLessThan(10 * MB)
    await store.put('c10', put(20, 'c10', 50 * 1024))
    const after = await backend.chats()
    expect(total(after)).toBeLessThanOrEqual(9 * MB)
    const kept = after.map((c) => c.chat)
    expect(kept).toContain('c0')
    expect(kept).not.toContain('c1')
    expect(kept).not.toContain('c2')
    expect(kept).toContain('c10')
    // Whole chats only: every surviving chat still has all of its rows.
    for (const chat of after) expect(chat.count).toBe(20)
    release()
  })

  it('reports a repeated quota failure once, stops writing, and keeps reading', async () => {
    const backend = createMemoryTranscriptBackend()
    const onDegraded = vi.fn()
    const store = createTranscriptStore({ backend, now: clock().now, onDegraded })
    await store.put('chat', put(2, 'chat'))
    const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    backend.failNextCommit(quota)
    backend.failNextCommit(quota)
    await store.put('chat', put(1, 'chat', 0, 2))
    await store.put('chat', put(1, 'chat', 0, 3))
    await store.put('other', put(1, 'other'))
    expect(onDegraded).toHaveBeenCalledOnce()
    expect(onDegraded.mock.calls[0]![0]).toMatchObject({
      kind: 'transcript-store-degraded',
      reason: 'quota',
    })
    expect((await backend.chats()).map((c) => [c.chat, c.count])).toEqual([['chat', 2]])
    expect((await store.readNewest('chat', 5)).messages).toHaveLength(2)
  })

  it('retries a quota failure once after the size clean-up', async () => {
    const backend = createMemoryTranscriptBackend()
    const onDegraded = vi.fn()
    const store = createTranscriptStore({ backend, now: clock().now, onDegraded })
    backend.failNextCommit(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))
    await store.put('chat', put(2, 'chat'))
    expect(onDegraded).not.toHaveBeenCalled()
    expect((await backend.chats())[0]).toMatchObject({ count: 2 })
  })

  it('sign-out erase deletes the database even when it never opened', async () => {
    const deleteDatabase = vi.fn(async () => {})
    const store = createTranscriptStore({
      backend: Promise.reject(new Error('blocked')),
      deleteDatabase,
      onDegraded: () => {},
    })
    await store.erase()
    expect(deleteDatabase).toHaveBeenCalledOnce()
    const backend = createMemoryTranscriptBackend()
    const opened = createTranscriptStore({ backend })
    await opened.put('chat', put(1, 'chat'))
    await opened.erase()
    expect(backend.erased).toBe(true)
  })
})

describe('transcript clean-up stays inside the transcript database', () => {
  it('leaves the entity store, drafts, the outbox and UI state byte-identical', async () => {
    const factory = new IDBFactory()
    // The entity replica in its own IndexedDB database, with a row and a queued write.
    const entities = await IndexedDbSyncStore.open({
      factory: factory as never,
      onDegraded: () => {},
    })
    const view = entities.viewFor('alice')
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'ADA-1',
          value: { title: 'kept' },
          provenance: { seq: 1 },
        },
      ],
      cursor: { feedId: 'feed', epoch: 'epoch', seq: 1 },
    })
    await entities.settled()
    // UI state, drafts and the outbox in the side cache's key space.
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    }
    const side = createSideCache({ storage, enumerateKeys: () => [...data.keys()], keyPrefix: 'p' })
    side.uiState().set('podium.sidebar.width', '320')
    side.uiState().set('podium.drafts', '{"s1":"half a message"}')
    side.outboxStorage().save([{ mutationId: 'm1', kind: 'rename', queuedAt: 1 } as never])
    const snapshotStorage = () => JSON.stringify([...data.entries()].sort())
    const dumpIdb = async (name: string) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = factory.open(name)
        req.onsuccess = () => resolve(req.result as unknown as IDBDatabase)
        req.onerror = () => reject(req.error)
      })
      const out: Record<string, unknown[]> = {}
      for (const store of Array.from(db.objectStoreNames)) {
        out[store] = await new Promise((resolve) => {
          const req = db.transaction(store).objectStore(store).getAll()
          req.onsuccess = () => resolve(req.result)
        })
      }
      db.close()
      return JSON.stringify(out)
    }
    const storageBefore = snapshotStorage()
    const entitiesBefore = await dumpIdb('podium-kernel-replica')

    const time = clock()
    const store = createTranscriptStore({
      backend: openIndexedDbTranscriptBackend({
        factory: factory as never,
        keyRange: IDBKeyRange as never,
        databaseName: 'podium-transcripts:alice',
      }),
      now: time.now,
      limits: { budgetBytes: 4_000, targetBytes: 3_000, messagesPerChat: 5 },
    })
    for (let c = 0; c < 6; c++) await store.put(`c${c}`, put(8, `c${c}`, 100))
    time.advance(31 * DAY)
    await store.sweep()
    await store.erase()

    expect(snapshotStorage()).toBe(storageBefore)
    expect(await dumpIdb('podium-kernel-replica')).toBe(entitiesBefore)
    side.dispose()
    entities.close()
  })
})
