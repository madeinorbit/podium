import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { principalKeyPrefix, type StorageApi } from '../replica'
import { openReplicaAssembly } from './assembly'

const principal = JSON.stringify(['installation-a', 'alice'])
const prefix = 'test.replica'
function device(): StorageApi & { keys(): string[] } {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}
const openStore = () =>
  IndexedDbSyncStore.open({ factory: new IDBFactory() as never, onDegraded: () => {} })
const httpSync = {
  origin: 'https://sync.test',
  streamingFetch: { fetch: async () => new Response(null, { status: 500 }) },
}

describe('shared replica storage lifecycle', () => {
  it('refuses unavailable private storage and closes the opened store', async () => {
    const storage = device()
    const store = await openStore()
    vi.spyOn(store, 'durability').mockReturnValue('degraded-memory')
    const close = vi.spyOn(store, 'close')
    await expect(openReplicaAssembly({
      api: {} as never, principal, openStore: async () => store,
      settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix },
      evidence: { kind: 'single-account', principal }, httpSync,
    })).rejects.toMatchObject({ failure: { kind: 'replica-blocked' } })
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps cleanup pending if the namespace cannot actually be erased', async () => {
    const storage = device()
    const stale = JSON.stringify(['installation-a', 'bob'])
    storage.setItem(`${principalKeyPrefix(prefix, stale)}.ui-state.v1`, 'private data')
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('remove denied')
    })
    const complete = vi.fn(async () => {})
    await expect(
      openReplicaAssembly({
        api: {} as never,
        principal,
        openStore,
        settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix },
        httpSync,
        pendingPrincipalCleanups: [{ principal: stale, complete }],
      }),
    ).rejects.toMatchObject({ failure: { kind: 'replica-blocked' } })
    expect(complete).not.toHaveBeenCalled()
  })

  it('erases only the acting principal and prevents a delayed feed or retry from restoring it', async () => {
    const storage = device()
    const other = `${principalKeyPrefix(prefix, 'bob')}.ui-state.v1`
    storage.setItem(other, 'other account')
    const fetch = vi.fn(async () => new Response(null, { status: 500 }))
    const flush = vi.fn(async () => {})
    const assembly = await openReplicaAssembly({
      api: {} as never,
      principal,
      openStore,
      settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix, flush },
      httpSync: { origin: 'https://sync.test', streamingFetch: { fetch } },
    })
    try {
      storage.setItem(`${principalKeyPrefix(prefix, principal)}.ui-state.v1`, 'private data')
      await assembly.erasePrincipalData()
      assembly.feed.connected(false)
      assembly.progress.retry()
      expect(fetch).not.toHaveBeenCalled()
      expect(storage.getItem(other)).toBe('other account')
      expect(
        storage.keys().some((key) => key.startsWith(principalKeyPrefix(prefix, principal))),
      ).toBe(false)
      expect(flush).toHaveBeenCalled()
    } finally {
      await assembly.dispose()
    }
  })
})
