/**
 * POD-7159 — schema version 1 to 2: a store written by the build before the
 * disk index opens with every row and marker readable, its index built once
 * from its rows. A crash in the middle of that build leaves the store as it
 * was; the session keeps every row in memory and the next open builds it.
 */
import { IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { CollectionServer, issue, session, WORLD_NOW } from '../../conformance/collection-server'
import { instanceKey } from '../../replica/cache-state'
import { BUCKET_RECORDS, INDEX_BUCKETS } from '../../replica/disk-index'
import { Replica } from '../../replica/replica'
import type { EntityRecord, InstanceSpec } from '../../replica/types'
import type { IdbDatabaseLike, IdbFactoryLike } from './idb'
import { ENTITY_STORE, META_STORE, OUTBOX_STORE, REPLICA_DB_NAME } from './schema'
import { IndexedDbSyncStore } from './store'
import { FaultyIdbFactory, freshFactory, readDurable } from './test-support'

const PRINCIPAL = 'u-ada'
const ISSUE = 'issueProjection'
const tree = (root: string): InstanceSpec => ({
  collection: 'issueProjection.tree',
  args: { root },
  part: 'main',
})
const keyOf = (row: Pick<EntityRecord, 'entity' | 'entityId'>) =>
  `${row.entity}\u0000${row.entityId}`

const ticks = async (count = 5): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function world(): CollectionServer {
  const server = new CollectionServer()
  server.put(ISSUE, 'A1', issue('A1'))
  server.put(ISSUE, 'A2', issue('A2', { stage: 'review', parentId: 'A1' }))
  server.put(ISSUE, 'D1', issue('D1', { stage: 'done', closedReason: 'completed', parentId: 'A1' }))
  server.put(ISSUE, 'D2', issue('D2', { stage: 'done', closedReason: 'completed' }))
  server.put('session', 'S1', session('S1', { issueId: 'A1' }))
  server.put('session', 'S9', session('S9', { issueId: 'D1', status: 'ended' }))
  server.answerComesWith = true
  return server
}

/**
 * The comes-with markers the build before the index wrote for what records
 * come with (their own markers, via the holder); the build after records them
 * on the holder instead. D1's sessions in the tree, and its user state.
 */
const OLD_COMES_WITH = [
  {
    collection: 'session.ofIssue',
    args: { issueId: 'D1' },
    part: 'main',
    via: 'issueProjection.tree',
  },
  {
    collection: 'issueUserState.ofIssue',
    args: { issueId: 'D1' },
    part: 'main',
    via: 'issueProjection',
  },
] as const

/**
 * POD-7160 — the index's buckets stay about `BUCKET_RECORDS` records each:
 * past 256 of them the count doubles, every bucket written again once; a
 * later change patches its own bucket, and the reopened store reads it all.
 */
const MANY = INDEX_BUCKETS * BUCKET_RECORDS + 100
const historyStub = (n: number, seq: number) => ({
  kind: 'upsert' as const,
  entity: ISSUE,
  entityId: `H${n}`,
  value: issue(`H${n}`, { stage: 'done', closedReason: 'completed' }),
  provenance: { seq },
  asOf: seq,
  part: 'stub' as const,
})
const at = (seq: number) => ({ feedId: 'feed', epoch: 'epoch', seq })

const open = (factory: IdbFactoryLike) =>
  IndexedDbSyncStore.open({ factory, keyRange: IDBKeyRange, onDegraded: () => {} })

/** A device that downloaded the world and opened the tree of A1, as the build before the index left it. */
async function versionOneStore(): Promise<{
  readonly factory: IdbFactoryLike
  readonly rows: readonly EntityRecord[]
  readonly markers: readonly string[]
}> {
  const factory = freshFactory()
  const store = await open(factory)
  const { cache } = store.viewFor(PRINCIPAL)
  const server = world()
  const replica = new Replica({ store: cache, authority: server, now: () => WORLD_NOW })
  replica.connect()
  await replica.settled()
  await ticks()
  await replica.settled()
  await replica.load([tree('A1')])
  await replica.settled()
  await store.settled()
  const rows = [...cache.readEntities(), ...cache.readStubs()]
  const markers = [...cache.readInstances().keys()].sort()
  store.close()
  // The version-1 layout: the same entity and meta rows, no index store, no flag.
  const durable = await readDurable(factory)
  await new Promise<void>((resolve) => {
    const request = factory.deleteDatabase(REPLICA_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
  const db = await new Promise<IdbDatabaseLike>((resolve, reject) => {
    const request = factory.open(REPLICA_DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ENTITY_STORE, {
        keyPath: ['principal', 'entity', 'entityId'],
      })
      request.result.createObjectStore(META_STORE, { keyPath: ['principal', 'key'] })
      request.result.createObjectStore(OUTBOX_STORE, { keyPath: ['principal', 'mutationId'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
  })
  const tx = db.transaction([ENTITY_STORE, META_STORE], 'readwrite')
  for (const row of durable[ENTITY_STORE] ?? []) tx.objectStore(ENTITY_STORE).put(row)
  // The build before the index wrote a stub-level record as an entity row too
  // (this build keeps it in its index entry only, POD-7170).
  for (const row of rows)
    if (row.part === 'stub')
      tx.objectStore(ENTITY_STORE).put({
        principal: PRINCIPAL,
        entity: row.entity,
        entityId: row.entityId,
        value: row.value,
        revision: row.revision,
        provenance: row.provenance,
        part: 'stub',
        ...(row.asOf === undefined ? {} : { asOf: row.asOf }),
      })
  const meta = (durable[META_STORE] ?? []) as { principal: string; key: string; value: unknown }[]
  for (const row of meta) if (row.principal !== '') tx.objectStore(META_STORE).put(row)
  const cursor = meta.find((row) => row.principal === PRINCIPAL && row.key === 'cursor')?.value
  for (const spec of OLD_COMES_WITH)
    tx.objectStore(META_STORE).put({
      principal: PRINCIPAL,
      key: `instance\u0000${instanceKey(spec)}`,
      value: { ...spec, key: instanceKey(spec), completeAt: cursor },
    })
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('seed failed'))
  })
  db.close()
  expect(rows.length).toBeGreaterThan(4)
  expect(markers).toContain(instanceKey(tree('A1')))
  return { factory, rows, markers }
}

/** Every row and marker the old store held is readable: by the index, from disk, and as a screen reads it. */
async function expectReadable(
  store: IndexedDbSyncStore,
  rows: readonly EntityRecord[],
  markers: readonly string[],
): Promise<void> {
  const { cache } = store.viewFor(PRINCIPAL)
  expect([...cache.readInstances().keys()].sort()).toEqual(markers)
  const index = cache.readDiskIndex()
  const read = await cache.readDiskRows(rows.map(keyOf))
  const byKey = new Map(read.map((row) => [keyOf(row), row]))
  for (const row of rows) {
    expect(index.record(keyOf(row)), row.entityId).toMatchObject({
      level: row.part === 'stub' ? 'stub' : 'main',
    })
    expect(byKey.get(keyOf(row))?.value, row.entityId).toEqual(row.value)
  }
  // The tree is answered from disk: no server.
  // The tree is answered from disk: the server is never asked for it (what
  // its records come with and the old store did not mark is asked, as ever).
  const server = world()
  const asked: string[] = []
  const answer = server.collections.bind(server)
  server.collections = (instances) => {
    asked.push(...instances.map((instance) => instanceKey(instance)))
    return answer(instances)
  }
  // A row a record brings is not in memory at start: it comes with the record.
  expect(cache.read('session', 'S9')).toBeUndefined()
  const replica = new Replica({ store: cache, authority: server, now: () => WORLD_NOW })
  await replica.load([tree('A1')])
  await replica.settled()
  expect(asked).not.toContain(instanceKey(tree('A1')))
  expect(replica.isComplete(tree('A1'))).toBeDefined()
  for (const id of ['A1', 'A2', 'D1']) expect(cache.read(ISSUE, id), id).toBeDefined()
  // The old comes-with markers are on D1 now: its tree sessions came with it from disk.
  for (const spec of OLD_COMES_WITH)
    expect(cache.readInstances().has(instanceKey(spec))).toBe(false)
  expect(index.record(`${ISSUE}\u0000D1`)?.cw).toContain('issueProjection.tree')
  expect(index.record('session\u0000S9')?.holders).toContain(`^${ISSUE}\u0000D1`)
  expect(cache.read('session', 'S9')).toBeDefined()
}

describe('IndexedDB schema 1 to 2: the disk index (POD-7159)', () => {
  it('opens a version-1 store with every row and marker readable, and builds the index once', async () => {
    const { factory, rows, markers } = await versionOneStore()
    const store = await open(factory)
    await expectReadable(store, rows, markers)
    store.close()
    // Built once: the next open reads the index and no entity row of the tree.
    const counted = new FaultyIdbFactory(factory)
    const again = await open(counted)
    expect(counted.getAlls).not.toContain(ENTITY_STORE)
    await expectReadable(again, rows, markers)
    again.close()
  })

  for (const at of [0, 3, 10])
    it(`keeps every row after a crash at write ${at} of the build, and builds it on the next open`, async () => {
      const { factory, rows, markers } = await versionOneStore()
      const faulty = new FaultyIdbFactory(factory)
      // The open's two reads, then the build's one write transaction.
      faulty.denyWriteAt({ at, mode: 'after', error: new Error('power loss'), times: 3 })
      const crashed = await open(faulty)
      expect(faulty.denials).toBe(1)
      const { cache } = crashed.viewFor(PRINCIPAL)
      for (const row of rows)
        expect(cache.readRow(row.entity, row.entityId)?.value, row.entityId).toEqual(row.value)
      crashed.close()
      const durable = await readDurable(factory)
      expect(durable['disk-index'] ?? []).toEqual([])
      const store = await open(factory)
      await expectReadable(store, rows, markers)
      store.close()
    })

  it('grows its buckets with the disk, patches a bucket per change, and reads them back after a reopen (POD-7160)', async () => {
    const factory = freshFactory()
    const store = await open(factory)
    const { cache } = store.viewFor(PRINCIPAL)
    cache.applyAtomic({
      operations: Array.from({ length: MANY }, (_, n) => historyStub(n, 1)),
      cursor: at(1),
    })
    await store.settled()
    expect(cache.readDiskIndex().bucketCount).toBe(2 * INDEX_BUCKETS)
    cache.applyAtomic({ operations: [historyStub(7, 2)], cursor: at(2) })
    cache.applyAtomic({
      operations: [{ kind: 'remove', entity: ISSUE, entityId: 'H8' }],
      cursor: at(3),
    })
    await store.settled()
    store.close()
    const durable = (await readDurable(factory))['disk-index'] as {
      readonly key: string
      readonly v: { readonly k: readonly string[]; readonly n?: number }
    }[]
    const buckets = durable.filter((row) => row.key.startsWith('b'))
    expect(buckets.length).toBeLessThanOrEqual(2 * INDEX_BUCKETS)
    for (const row of buckets) {
      expect(row.v.n, row.key).toBe(2 * INDEX_BUCKETS)
      expect(row.v.k.length, row.key).toBeLessThan(3 * BUCKET_RECORDS)
    }
    expect(buckets.reduce((sum, row) => sum + row.v.k.length, 0)).toBe(MANY - 1)
    const again = await open(factory)
    const reopened = again.viewFor(PRINCIPAL).cache
    const index = reopened.readDiskIndex()
    expect(index.bucketCount).toBe(2 * INDEX_BUCKETS)
    expect(index.recordCount).toBe(MANY - 1)
    expect(index.record(`${ISSUE}\u0000H7`)).toMatchObject({ seq: 2, level: 'stub' })
    expect(index.record(`${ISSUE}\u0000H8`)).toBeUndefined()
    expect(reopened.readRow(ISSUE, 'H7')).toMatchObject({ part: 'stub', asOf: 2 })
    expect(reopened.readRow(ISSUE, 'H8')).toBeUndefined()
    expect(reopened.readRow(ISSUE, `H${MANY - 1}`)?.part).toBe('stub')
    again.close()
  })
})
