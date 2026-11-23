import { actorUser, asMutationId, asUserId } from '@podium/model'
import { IDBKeyRange } from 'fake-indexeddb'
import { expect, it } from 'vitest'
import { CollectionServer, issue, WORLD_NOW } from '../../conformance/collection-server'
import type { OutboxRecord } from '../../outbox/records'
import { Replica } from '../../replica/replica'
import { type IdbFactoryLike, requestAsPromise } from './idb'
import {
  ENTITY_STORE,
  INDEX_STORE,
  META_STORE,
  OUTBOX_STORE,
  REPLICA_DB_NAME,
  REPLICA_SCHEMA_VERSION,
} from './schema'
import { IndexedDbSyncStore } from './store'
import { freshFactory, readDurable } from './test-support'

const CURSOR = { feedId: 'feed', epoch: 'epoch', seq: 7, kindTokens: {} }
const USER = asUserId('ada')
const QUEUED: OutboxRecord = {
  mutationId: asMutationId('queued-before-upgrade'),
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'old' },
  partitionKey: 'issue:old',
  attribution: { actor: actorUser(USER), onBehalfOf: USER },
  state: 'queued',
  queuedAt: 1,
  attempts: 0,
}

async function oldStore(version: number): Promise<IdbFactoryLike> {
  const factory = freshFactory()
  const request = factory.open(REPLICA_DB_NAME, version)
  request.onupgradeneeded = () => {
    const db = request.result
    db.createObjectStore(ENTITY_STORE, { keyPath: ['principal', 'entity', 'entityId'] })
    db.createObjectStore(META_STORE, { keyPath: ['principal', 'key'] })
    db.createObjectStore(OUTBOX_STORE, { keyPath: ['principal', 'mutationId'] })
    if (version === 2) db.createObjectStore(INDEX_STORE, { keyPath: ['principal', 'key'] })
  }
  const db = await requestAsPromise(request)
  try {
    const tx = db.transaction([ENTITY_STORE, META_STORE, OUTBOX_STORE], 'readwrite')
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    for (const principal of ['legacy', 'compatible']) {
      tx.objectStore(ENTITY_STORE).put({
        principal,
        entity: 'issueProjection',
        entityId: 'old',
        value: { id: 'old', title: principal },
        provenance: { seq: 7 },
      })
      tx.objectStore(META_STORE).put({ principal, key: 'cursor', value: CURSOR })
      tx.objectStore(OUTBOX_STORE).put({
        principal,
        mutationId: QUEUED.mutationId,
        ordinal: 1,
        record: QUEUED,
      })
    }
    // dev.26's whole-snapshot completeness marker, also retained by an
    // intermediate build which opened it without upgrading its logical schema.
    tx.objectStore(META_STORE).put({
      principal: 'legacy',
      key: 'personal-rows-complete-at',
      value: CURSOR,
    })
    tx.objectStore(META_STORE).put({
      principal: 'compatible',
      key: 'policy',
      value: { clientType: 'browser', recentDays: 30, steps: [] },
    })
    await complete
  } finally {
    db.close()
  }
  return factory
}

for (const version of [1, 2])
  for (const ranges of [false, true])
    it(`upgrades schema ${version} without collection metadata, with key ranges ${ranges}`, async () => {
      const factory = await oldStore(version)
      const upgrades: unknown[] = []
      const store = await IndexedDbSyncStore.open({
        factory,
        ...(ranges ? { keyRange: IDBKeyRange } : {}),
        onDegraded: () => {
          throw new Error('unexpected degradation')
        },
        onSchemaUpgrade: (event) => upgrades.push(event),
      })
      try {
        const legacy = store.viewFor('legacy')
        expect(legacy.cache.readCursor()).toBeNull()
        expect(legacy.cache.readEntities()).toEqual([])
        expect(legacy.cache.readInstances().size).toBe(0)
        expect(await legacy.outbox.read()).toEqual([QUEUED])
        const compatible = store.viewFor('compatible')
        expect(compatible.cache.readCursor()).toMatchObject({ seq: 7 })
        expect(compatible.cache.read('issueProjection', 'old')).toBeDefined()
        expect(await compatible.outbox.read()).toEqual([QUEUED])
        expect(upgrades).toEqual([
          { from: version, to: REPLICA_SCHEMA_VERSION, cachePrincipalsReset: 1 },
        ])
      } finally {
        store.close()
      }
      const durable = await readDurable(factory)
      expect(
        durable[META_STORE]?.filter((row) => (row as { principal: string }).principal === 'legacy'),
      ).toEqual([])
      expect(durable[OUTBOX_STORE]).toHaveLength(2)
      const reopened = await IndexedDbSyncStore.open({ factory, onDegraded: () => {} })
      try {
        expect(await reopened.viewFor('legacy').outbox.read()).toEqual([QUEUED])
      } finally {
        reopened.close()
      }
    })

it('bootstraps the collection policy after upgrading a whole-snapshot cache', async () => {
  const factory = await oldStore(1)
  const store = await IndexedDbSyncStore.open({
    factory,
    keyRange: IDBKeyRange,
    onDegraded: () => {},
  })
  const cache = store.viewFor('legacy').cache
  const authority = new CollectionServer()
  authority.answerComesWith = true
  authority.put('issueProjection', 'fresh', issue('fresh'))
  const replica = new Replica({ store: cache, authority, now: () => WORLD_NOW })
  try {
    replica.connect()
    await replica.settled()
    await store.settled()
    expect(replica.posture).toBe('live')
    expect(replica.stats().bootstraps).toBe(1)
    expect(cache.readPolicy()).not.toBeNull()
    expect(replica.isComplete({ collection: 'issueProjection.stubs', part: 'stub' })).toBeDefined()
    expect(await store.viewFor('legacy').outbox.read()).toEqual([QUEUED])
  } finally {
    replica.disconnect()
    store.close()
  }
})
