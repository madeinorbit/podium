import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { CLIENT_WIRE_VERSION, SYNC_CONTENT_TYPE, type FeedDeltaMessage } from '@podium/protocol'
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

const cursor = { feedId: 'feed-1', epoch: 'epoch-1', seq: 10 }
function syncResponse(records: unknown[]): Response {
  return new Response(records.map((record) => JSON.stringify(record) + '\n').join(''), {
    headers: { 'content-type': SYNC_CONTENT_TYPE },
  })
}
const syncMeta = {
  type: 'syncMeta',
  formatVersion: 1,
  wireVersion: CLIENT_WIRE_VERSION,
  wireSchemaDigest: '0123456789abcdef',
  transferId: 'transfer-1',
  minAvailableSeq: 0,
  ...cursor,
}

describe('shared replica reconnect recovery', () => {
  it.each([
    'read-failed',
    'compressor-failed',
    'deadline',
    'server-shutdown',
    'missing-complete',
  ])('recovers from %s without leaving a connected replica offline', async (reason) => {
    const storage = device()
    const delta: FeedDeltaMessage = {
      type: 'feedDelta',
      ...cursor,
      fromSeq: 10,
      seq: 11,
      minAvailableSeq: 0,
      changes: [],
    }
    const replies = [
      syncResponse([
        { ...syncMeta, mode: 'snapshot', totalRows: 0 },
        { type: 'feedBootstrap', ...cursor, fromSeq: 0, minAvailableSeq: 0, changes: [], last: true },
        { type: 'syncComplete', transferId: syncMeta.transferId, seq: 10, records: 1, rows: 0 },
      ]),
      syncResponse([
        { ...syncMeta, mode: 'delta', fromSeq: 10, seq: 11 },
        delta,
        ...(reason === 'missing-complete'
          ? []
          : [{ type: 'syncError', transferId: syncMeta.transferId, reason }]),
      ]),
      syncResponse([
        { ...syncMeta, mode: 'delta', fromSeq: 11, seq: 11 },
        { type: 'syncComplete', transferId: syncMeta.transferId, seq: 11, records: 0, rows: 0 },
      ]),
    ]
    const fetch = vi.fn(async () => {
      const reply = replies.shift()
      if (!reply) throw new Error('unexpected sync request')
      return reply
    })
    const assembly = await openReplicaAssembly({
      api: {} as never,
      principal,
      openStore,
      settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix },
      httpSync: { origin: 'https://sync.test', streamingFetch: { fetch } },
    })
    try {
      assembly.feed.connected(false)
      await vi.waitFor(() => expect(assembly.progress.getSnapshot().phase).toBe('ready'))
      assembly.feed.disconnected()
      expect(assembly.progress.getSnapshot().phase).toBe('offline')
      assembly.feed.connected(false)
      await vi.waitFor(() => expect(assembly.progress.getSnapshot().failure).toBe(reason))
      // The failed range's durable prefix remains resumable. Socket recovery
      // must start a new walk instead of keeping the feed permanently stopped.
      expect(assembly.feed.helloFields()).toEqual({ feedCursor: { ...cursor, seq: 11 } })
      assembly.feed.disconnected()
      assembly.feed.connected(false)
      await vi.waitFor(() => expect(assembly.progress.getSnapshot()).toMatchObject({
        phase: 'ready', blocking: false, error: null, failure: null,
      }))
      expect(fetch).toHaveBeenCalledTimes(3)
      assembly.feed.frame({ ...delta, fromSeq: 11, seq: 12 })
      await vi.waitFor(() => expect(assembly.feed.helloFields()).toEqual({
        feedCursor: { ...cursor, seq: 12 },
      }))
      expect(assembly.progress.getSnapshot().phase).toBe('ready')
    } finally {
      await assembly.dispose()
    }
  })

  it.each([
    ['expired credentials', 401, 'auth', 'http-401'],
    ['malformed content', 200, 'format', 'invalid-json'],
  ] as const)('keeps %s stopped across reconnects', async (_label, status, error, failure) => {
    const storage = device()
    const fetch = vi.fn(async () => new Response(status === 200 ? 'bad-json\n' : null, {
      status,
      headers: { 'content-type': SYNC_CONTENT_TYPE },
    }))
    const expired = vi.fn()
    const assembly = await openReplicaAssembly({
      api: {} as never,
      principal,
      openStore,
      settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix },
      httpSync: { origin: 'https://sync.test', streamingFetch: { fetch } },
      onAuthExpired: expired,
    })
    try {
      assembly.feed.connected(false)
      await vi.waitFor(() => expect(assembly.progress.getSnapshot()).toMatchObject({
        phase: 'error', blocking: true, error, failure,
      }))
      assembly.feed.disconnected()
      assembly.feed.connected(false)
      assembly.feed.frame({
        type: 'feedResyncRequired',
        feedId: cursor.feedId,
        epoch: cursor.epoch,
        cause: 'authority-shed-load',
      })
      expect(fetch).toHaveBeenCalledOnce()
      expect(expired).toHaveBeenCalledTimes(error === 'auth' ? 1 : 0)
      expect(assembly.progress.getSnapshot()).toMatchObject({ phase: 'error', error, failure })
    } finally {
      await assembly.dispose()
    }
  })
})

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
