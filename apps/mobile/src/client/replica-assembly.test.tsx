import {
  principalKeyPrefix,
  REPLICA_KEY_PREFIX,
  type StorageApi,
} from '@podium/client-core/replica'
import { type SqlDatabaseLike, SqliteSyncStore } from '@podium/sync/adapters/mobile-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [],
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => null }))

import {
  type MobileEntityStore,
  type MobileReplica,
  openMobileReplica,
} from './MobileClientProvider'

const principal = JSON.stringify(['installation-a', 'alice'])
const opened: MobileReplica[] = []
const device = (): StorageApi & { keys(): string[] } => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  }
}
const httpSync = (fetch: (input: string, init: RequestInit) => Promise<Response>) => ({
  origin: 'https://sync.test',
  streamingFetch: { fetch },
})
async function resolveSqlite(): Promise<(file: string) => SqlDatabaseLike> {
  const attempts: string[] = []
  for (const [specifier, exportName] of [
    ['bun:sqlite', 'Database'],
    ['node:sqlite', 'DatabaseSync'],
  ] as const) {
    try {
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      const Database = module[exportName] as (new (file: string) => SqlDatabaseLike) | undefined
      if (typeof Database === 'function') return (file) => new Database(file)
      attempts.push(`${specifier}: no ${exportName}`)
    } catch (error) {
      attempts.push(`${specifier}: ${(error as Error).message}`)
    }
  }
  throw new Error(`no real SQLite in this runtime (${attempts.join('; ')})`)
}
const openSqlite = await resolveSqlite()
const store = () =>
  SqliteSyncStore.open({
    openDatabase: () => openSqlite(':memory:'),
    deleteDatabase: () => {},
    onDegraded: () => {},
  })
afterEach(async () => {
  for (const replica of opened.splice(0)) await replica.dispose()
})

describe('mobile shared assembly adapter', () => {
  it.each([
    'unavailable',
    'degraded-memory',
  ] as const)('refuses %s before reading or retiring legacy writes', async (mode) => {
    const storage = device()
    storage.setItem('podium.outbox.v1', 'queued work')
    const close = vi.fn()
    const viewFor = vi.fn()
    const unavailable = { durability: () => mode, close, viewFor } as unknown as MobileEntityStore
    await expect(
      openMobileReplica({
        api: {} as never,
        principal,
        storage,
        enumerateKeys: storage.keys,
        openStore: async () => unavailable,
        httpSync: httpSync(async () => new Response()),
        onDegraded: () => {},
      }),
    ).rejects.toMatchObject({ failure: { kind: 'replica-blocked' } })
    expect(storage.getItem('podium.outbox.v1')).toBe('queued work')
    expect(viewFor).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('refuses a bridge persistence failure before opening a principal view', async () => {
    const data = await store()
    const viewFor = vi.spyOn(data, 'viewFor')
    const close = vi.spyOn(data, 'close')
    const storage = device()
    await expect(
      openMobileReplica({
        api: {} as never,
        principal,
        storage,
        enumerateKeys: storage.keys,
        openStore: async () => data,
        flushStorage: async () => {
          throw new Error('native marker write failed')
        },
        httpSync: httpSync(async () => new Response()),
        onDegraded: () => {},
      }),
    ).rejects.toMatchObject({ failure: { kind: 'replica-blocked' } })
    expect(viewFor).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('carries an already-prefixed queue and publishes the same migration notice as web', async () => {
    const storage = device()
    const key = `${principalKeyPrefix(REPLICA_KEY_PREFIX, principal)}.outbox.v1`
    storage.setItem(
      key,
      JSON.stringify([
        {
          mutationId: 'm-folded',
          kind: 'rename',
          input: { sessionId: 's', name: 'offline name' },
          queuedAt: Date.now(),
        },
      ]),
    )
    const notice = vi.fn()
    const replica = await openMobileReplica({
      api: {} as never,
      principal,
      storage,
      enumerateKeys: storage.keys,
      openStore: store,
      evidence: { kind: 'single-account', principal },
      httpSync: httpSync(async () => new Response()),
      onDegraded: notice,
    })
    opened.push(replica)
    expect(storage.getItem(key)).toBeNull()
    expect(
      (await replica.store.viewFor(principal).outbox.read()).map((row) => row.mutationId),
    ).toEqual(['m-folded'])
    expect(notice).toHaveBeenCalledWith('1 queued change moved to secure storage.')
  })

  it.each([
    401, 403,
  ])('stops HTTP %i, preserves auth cause, and notifies the credential owner once', async (status) => {
    const storage = device()
    const fetch = vi.fn(async () => new Response(null, { status }))
    const expired = vi.fn()
    const replica = await openMobileReplica({
      api: {} as never,
      principal,
      storage,
      enumerateKeys: storage.keys,
      openStore: store,
      httpSync: httpSync(fetch),
      onDegraded: () => {},
      onAuthExpired: expired,
    })
    opened.push(replica)
    replica.feed.connected(false)
    await vi.waitFor(() => expect(replica.syncProgress.shared.getSnapshot().error).toBe('auth'))
    replica.feed.connected(false)
    replica.syncProgress.retry()
    expect(replica.syncProgress.getSnapshot()).toMatchObject({
      phase: 'failed',
      failure: `http-${status}`,
      blocking: true,
    })
    expect(expired).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps a malformed download stopped until an explicit retry', async () => {
    const storage = device()
    const fetch = vi.fn(
      async () =>
        new Response('bad-json\n', { headers: { 'content-type': 'application/x-ndjson' } }),
    )
    const replica = await openMobileReplica({
      api: {} as never,
      principal,
      storage,
      enumerateKeys: storage.keys,
      openStore: store,
      httpSync: httpSync(fetch),
      onDegraded: () => {},
    })
    opened.push(replica)
    replica.feed.connected(false)
    await vi.waitFor(() => expect(replica.syncProgress.shared.getSnapshot().error).toBe('format'))
    replica.feed.connected(false)
    expect(fetch).toHaveBeenCalledOnce()
    replica.syncProgress.retry()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(replica.syncProgress.shared.getSnapshot().attempt).toBe(2)
  })
})
