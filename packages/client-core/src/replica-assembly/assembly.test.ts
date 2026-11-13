import { SessionMeta } from '@podium/model'
import { CLIENT_WIRE_VERSION, type FeedDeltaMessage, SYNC_CONTENT_TYPE } from '@podium/protocol'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { principalKeyPrefix, type ReplicaAddressedBatch, type StorageApi } from '../replica'
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
  return new Response(records.map((record) => `${JSON.stringify(record)}\n`).join(''), {
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

const sessionChange = (
  seq: number,
  entityId: string,
  name = entityId,
): FeedDeltaMessage['changes'][number] => ({
  seq,
  entity: 'session',
  entityId,
  op: 'upsert' as const,
  value: SessionMeta.parse({
    sessionId: entityId,
    name,
    title: name,
    agentKind: 'codex',
    cwd: '/project',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: '2026-11-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
  }),
})
function delta(
  fromSeq: number,
  seq: number,
  changes: FeedDeltaMessage['changes'],
): FeedDeltaMessage {
  return { type: 'feedDelta', ...cursor, fromSeq, seq, minAvailableSeq: 0, changes }
}
const complete = (seq: number, records: number, rows = records) => ({
  type: 'syncComplete',
  transferId: syncMeta.transferId,
  seq,
  records,
  rows,
})

function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value
    },
    cancel: cancelled,
  })
  return {
    response: new Response(body, { headers: { 'content-type': SYNC_CONTENT_TYPE } }),
    push: (record: unknown) =>
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(record)}\n`)),
    close: () => controller.close(),
    cancelled,
  }
}

async function catchupFixture(replies: Response[]) {
  const storage = device()
  const fetch = vi.fn(async (_input: string) => {
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected sync request')
    return reply
  })
  replies.unshift(
    syncResponse([
      { ...syncMeta, mode: 'snapshot', totalRows: 1 },
      {
        type: 'feedBootstrap',
        ...cursor,
        fromSeq: 0,
        minAvailableSeq: 0,
        changes: [sessionChange(10, 'saved')],
        last: true,
      },
      complete(10, 1),
    ]),
  )
  const assembly = await openReplicaAssembly({
    api: {} as never,
    principal,
    openStore,
    settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix },
    httpSync: { origin: 'https://sync.test', streamingFetch: { fetch } },
  })
  assembly.feed.connected(false)
  try {
    await vi.waitFor(() => expect(assembly.progress.getSnapshot().phase).toBe('ready'))
  } catch (error) {
    await assembly.dispose()
    throw error
  }
  await assembly.replica.hydrate()
  const batches: ReplicaAddressedBatch[] = []
  const visible: string[][] = []
  assembly.replica.subscribeAddressedBatch?.((batch) => {
    batches.push(batch)
    visible.push(assembly.replica.rows('sessions').map((row) => row.name ?? row.sessionId))
  })
  const rowBatches = vi.fn()
  const cursors = vi.fn()
  assembly.replica.subscribeRowBatch?.(rowBatches)
  assembly.replica.subscribeCursor?.(cursors)
  assembly.feed.disconnected()
  return { assembly, fetch, batches, visible, rowBatches, cursors }
}

describe('shared catch-up publication', () => {
  it('commits every page durably but publishes one pool batch only after range completion', async () => {
    const stream = controlledResponse()
    const h = await catchupFixture([stream.response])
    try {
      const outbox = h.assembly.store.viewFor(principal).outbox
      expect(await outbox.read()).toEqual([])
      h.assembly.feed.connected(false)
      stream.push({ ...syncMeta, mode: 'delta', fromSeq: 10, seq: 12 })
      stream.push(delta(10, 11, [sessionChange(11, 'one')]))
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().framesCommitted).toBe(1))
      await h.assembly.settled()
      expect(await outbox.read()).toEqual([])
      expect(h.assembly.store.viewFor(principal).cache.readCursor()?.seq).toBe(11)
      expect(h.batches).toEqual([])
      expect(h.cursors).not.toHaveBeenCalled()
      stream.push(delta(11, 12, [sessionChange(12, 'two')]))
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().framesCommitted).toBe(2))
      await h.assembly.settled()
      expect(await outbox.read()).toEqual([])
      expect(h.assembly.store.viewFor(principal).cache.readCursor()?.seq).toBe(12)
      expect(h.batches).toEqual([])
      stream.push(complete(12, 2))
      stream.close()
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().phase).toBe('ready'))
      expect(h.batches).toEqual([
        {
          type: 'update',
          rows: [
            { kind: 'sessions', id: 'one' },
            { kind: 'sessions', id: 'two' },
          ],
        },
      ])
      expect(h.visible).toEqual([['one', 'saved', 'two']])
      expect(h.rowBatches).toHaveBeenCalledOnce()
      expect(h.cursors).toHaveBeenCalledOnce()
      expect(await outbox.read()).toEqual([])
    } finally {
      await h.assembly.dispose()
    }
  })

  it.each([
    'stream failure',
    'socket suspension',
  ] as const)('retains a durable prefix without publishing it after %s, then includes it in the next batch', async (interruption) => {
    const stream = controlledResponse()
    const h = await catchupFixture([
      stream.response,
      syncResponse([
        { ...syncMeta, mode: 'delta', fromSeq: 11, seq: 12 },
        delta(11, 12, [sessionChange(12, 'next')]),
        complete(12, 1),
      ]),
    ])
    try {
      h.assembly.feed.connected(false)
      stream.push({ ...syncMeta, mode: 'delta', fromSeq: 10, seq: 12 })
      stream.push(delta(10, 11, [sessionChange(11, 'prefix')]))
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().framesCommitted).toBe(1))
      if (interruption === 'stream failure') {
        stream.push({ type: 'syncError', transferId: syncMeta.transferId, reason: 'read-failed' })
        stream.close()
        await vi.waitFor(() =>
          expect(h.assembly.progress.getSnapshot().failure).toBe('read-failed'),
        )
      } else {
        h.assembly.feed.disconnected()
        await vi.waitFor(() => expect(stream.cancelled).toHaveBeenCalled())
      }
      expect(h.assembly.store.viewFor(principal).cache.readCursor()?.seq).toBe(11)
      expect(h.batches).toEqual([])
      expect(h.cursors).not.toHaveBeenCalled()
      h.assembly.feed.connected(false)
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().phase).toBe('ready'))
      expect(new URL(h.fetch.mock.calls.at(-1)?.[0] ?? '').searchParams.get('from')).toBe('11')
      expect(h.visible).toEqual([['next', 'prefix', 'saved']])
      expect(h.rowBatches).toHaveBeenCalledOnce()
      expect(h.cursors).toHaveBeenCalledOnce()
    } finally {
      await h.assembly.dispose()
    }
  })

  it('folds overlapping and later live events into the final pool update in feed order', async () => {
    const stream = controlledResponse()
    const h = await catchupFixture([stream.response])
    try {
      h.assembly.feed.connected(false)
      stream.push({ ...syncMeta, mode: 'delta', fromSeq: 10, seq: 12 })
      stream.push(delta(10, 11, [sessionChange(11, 'shared', 'intermediate')]))
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().framesCommitted).toBe(1))
      const last = delta(11, 12, [sessionChange(12, 'shared', 'range final')])
      h.assembly.feed.frame(last)
      h.assembly.feed.frame(
        delta(12, 13, [{ seq: 13, entity: 'session', entityId: 'shared', op: 'remove' }]),
      )
      h.assembly.feed.frame(delta(13, 14, [sessionChange(14, 'shared', 'live final')]))
      stream.push(last)
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().framesCommitted).toBe(2))
      expect(h.batches).toEqual([])
      stream.push(complete(12, 2))
      stream.close()
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().phase).toBe('ready'))
      expect(h.visible).toEqual([['saved', 'live final']])
      expect(h.batches).toEqual([{ type: 'update', rows: [{ kind: 'sessions', id: 'shared' }] }])
      expect(h.assembly.feed.helloFields()?.feedCursor?.seq).toBe(14)
      expect(h.cursors).toHaveBeenCalledOnce()
    } finally {
      await h.assembly.dispose()
    }
  })

  it('replaces an unpublished prefix atomically if recovery needs a full download', async () => {
    const stream = controlledResponse()
    const snapshot = controlledResponse()
    const h = await catchupFixture([
      stream.response,
      new Response(JSON.stringify({ kind: 'bootstrap-required', reason: 'compacted-or-unknown' }), {
        status: 409,
      }),
      snapshot.response,
    ])
    try {
      h.assembly.feed.connected(false)
      stream.push({ ...syncMeta, mode: 'delta', fromSeq: 10, seq: 12 })
      stream.push(delta(10, 11, [sessionChange(11, 'prefix')]))
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().framesCommitted).toBe(1))
      h.assembly.feed.disconnected()
      h.assembly.feed.connected(false)
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4))
      snapshot.push({ ...syncMeta, mode: 'snapshot', seq: 20, totalRows: 1 })
      snapshot.push({
        type: 'feedBootstrap',
        ...cursor,
        seq: 20,
        fromSeq: 0,
        minAvailableSeq: 0,
        changes: [sessionChange(20, 'replacement')],
        last: true,
      })
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().rowsSeen).toBe(1))
      expect(h.batches).toEqual([])
      expect(h.assembly.store.viewFor(principal).cache.readCursor()?.seq).toBe(11)
      snapshot.push(complete(20, 1))
      snapshot.close()
      await vi.waitFor(() => expect(h.assembly.progress.getSnapshot().phase).toBe('ready'))
      expect(h.visible).toEqual([['replacement']])
      expect(h.batches).toEqual([{ type: 'replace', reason: 'bootstrap' }])
      expect(h.rowBatches).toHaveBeenCalledOnce()
    } finally {
      await h.assembly.dispose()
    }
  })
})

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
        {
          type: 'feedBootstrap',
          ...cursor,
          fromSeq: 0,
          minAvailableSeq: 0,
          changes: [],
          last: true,
        },
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
      await vi.waitFor(() =>
        expect(assembly.progress.getSnapshot()).toMatchObject({
          phase: 'ready',
          blocking: false,
          error: null,
          failure: null,
        }),
      )
      expect(fetch).toHaveBeenCalledTimes(3)
      assembly.feed.frame({ ...delta, fromSeq: 11, seq: 12 })
      await vi.waitFor(() =>
        expect(assembly.feed.helloFields()).toEqual({
          feedCursor: { ...cursor, seq: 12 },
        }),
      )
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
    const fetch = vi.fn(
      async () =>
        new Response(status === 200 ? 'bad-json\n' : null, {
          status,
          headers: { 'content-type': SYNC_CONTENT_TYPE },
        }),
    )
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
      await vi.waitFor(() =>
        expect(assembly.progress.getSnapshot()).toMatchObject({
          phase: 'error',
          blocking: true,
          error,
          failure,
        }),
      )
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
    await expect(
      openReplicaAssembly({
        api: {} as never,
        principal,
        openStore: async () => store,
        settings: { storage, enumerateKeys: storage.keys, basePrefix: prefix },
        evidence: { kind: 'single-account', principal },
        httpSync,
      }),
    ).rejects.toMatchObject({ failure: { kind: 'replica-blocked' } })
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
