import { asUserId } from '@podium/model'
import { expect, it } from 'vitest'
import { requestAsPromise } from './idb'
import { ALL_STORES, ENTITY_STORE, META_STORE, OUTBOX_STORE, REPLICA_DB_NAME, upgradeSchema } from './schema'
import { FaultyIdbFactory, freshFactory, QuotaExceededDomError, readDurable } from './test-support'
import { IndexedDbSyncStore } from './store'
import { enqueueWrites } from './write-batch'

const principal = asUserId('write-batch-guard')
const pre = {
  [ENTITY_STORE]: [{ principal, entity: 'issueProjection', entityId: 'old', value: { title: 'old' } }],
  [META_STORE]: [{ principal, key: 'cursor', value: { feedId: 'feed', epoch: 'one', seq: 1 } }],
  [OUTBOX_STORE]: [{ principal, mutationId: 'old-command', ordinal: 1, record: { state: 'applied' } }],
}
const ops = [
  { kind: 'delete' as const, store: ENTITY_STORE, key: [principal, 'issueProjection', 'old'] },
  ...Array.from({ length: 900 }, (_, i) => ({ kind: 'put' as const, store: ENTITY_STORE,
    value: { principal, entity: 'issueProjection', entityId: `new-${i}`, value: { title: `new ${i}` } } })),
  { kind: 'put' as const, store: META_STORE,
    value: { principal, key: 'cursor', value: { feedId: 'feed', epoch: 'one', seq: 2 } } },
  { kind: 'delete' as const, store: OUTBOX_STORE, key: [principal, 'old-command'] },
]

async function fixture() {
  const factory = new FaultyIdbFactory(freshFactory())
  const request = factory.open(REPLICA_DB_NAME, 1)
  request.onupgradeneeded = () => upgradeSchema(request.result)
  const db = await requestAsPromise(request)
  const tx = db.transaction([...ALL_STORES], 'readwrite')
  const done = completion(tx)
  for (const [name, rows] of Object.entries(pre)) for (const row of rows) tx.objectStore(name).put(row)
  expect(await done).toBe(true)
  return { factory, db }
}

function completion(tx: Parameters<typeof enqueueWrites>[0]): Promise<boolean> {
  return new Promise(resolve => {
    tx.oncomplete = () => resolve(true)
    tx.onabort = () => resolve(false)
  })
}

it('bounds the initial write task and commits every batch in one transaction', async () => {
  const { factory, db } = await fixture()
  try {
    const tx = db.transaction([...ALL_STORES], 'readwrite'), done = completion(tx)
    const before = factory.writesIssued
    const queued = enqueueWrites(tx, ops)
    expect(factory.writesIssued - before).toBeGreaterThan(0)
    expect(factory.writesIssued - before).toBeLessThanOrEqual(256)
    await queued
    expect(await done).toBe(true)
    expect(factory.writesIssued - before).toBe(ops.length)
    const durable = await readDurable(factory)
    expect(durable[ENTITY_STORE]).toHaveLength(900)
    expect(durable[ENTITY_STORE]).not.toContainEqual(pre[ENTITY_STORE][0])
    expect(durable[META_STORE]).toEqual([{ principal, key: 'cursor',
      value: { feedId: 'feed', epoch: 'one', seq: 2 } }])
    expect(durable[OUTBOX_STORE]).toEqual([])
    expect(factory.transactions.filter(tx => tx.mode === 'readwrite')).toHaveLength(2)
  } finally { db.close() }
})

it.each(['deny', 'after'] as const)('a failure in a later batch rolls back every region (%s)', async mode => {
  const { factory, db } = await fixture()
  try {
    factory.denyWriteAt({ at: 300, mode, error: new Error('later-batch power loss') })
    const tx = db.transaction([...ALL_STORES], 'readwrite'), done = completion(tx)
    const before = factory.writesIssued
    await expect(enqueueWrites(tx, ops)).rejects.toBeDefined()
    expect(await done).toBe(false)
    expect(factory.writesIssued - before).toBeGreaterThan(256)
    expect(factory.denials).toBe(1)
    expect(await readDurable(factory)).toEqual(pre)
  } finally { db.close() }
})

it('reports a later-batch quota abort as quota and keeps the pre-state durable', async () => {
  const factory = new FaultyIdbFactory(freshFactory())
  const degradations: { cause: string }[] = []
  const store = await IndexedDbSyncStore.open({ factory, onDegraded: d => degradations.push(d) })
  try {
    store.viewFor(principal).cache.installSnapshot(
      [{ entity: 'issueProjection', entityId: 'old', value: { title: 'old' } }],
      { feedId: 'feed', epoch: 'one', seq: 1 }, [],
    )
    await store.settled()
    const before = await readDurable(factory)
    factory.denyWriteAt({ at: 300, mode: 'after', error: new QuotaExceededDomError() })
    store.viewFor(principal).cache.installSnapshot(
      Array.from({ length: 900 }, (_, i) => ({ entity: 'issueProjection', entityId: `new-${i}`, value: { title: 'new' } })),
      { feedId: 'feed', epoch: 'one', seq: 2 }, [],
    )
    await store.settled()
    expect(factory.denials).toBe(1)
    expect(degradations).toMatchObject([{ cause: 'quota' }])
    expect(await readDurable(factory)).toEqual(before)
  } finally { store.close() }
})
