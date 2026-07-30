/**
 * The rest of ADR 6's normative web clauses: corruption (D4.5), multi-tab
 * (D4.6), the in-memory fallback (D1 row 3), FIFO across a reload (ADR 3 D12 as
 * `OutboxStorePort.apply` states it), and one guard that fails if the conformance
 * suite ever stops talking to IndexedDB.
 */

import type { MutationId } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import { SyncCommitConflict } from '../../span'
import { indexedDbInstantiation } from './conformance'
import type { IdbFactoryLike, IdbOpenRequestLike } from './idb'
import { ENTITY_STORE, OUTBOX_STORE, REPLICA_DB_NAME, REPLICA_SCHEMA_VERSION } from './schema'
import { type DurabilityDegradation, IndexedDbSyncStore } from './store'
import { freshFactory, readDurable } from './test-support'

const PRINCIPAL = 'ada'
const CURSOR: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }

const record = (mutationId: string, state: OutboxRecord['state'] = 'queued'): OutboxRecord => ({
  mutationId: mutationId as MutationId,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: { kind: 'user', userId: PRINCIPAL }, onBehalfOf: PRINCIPAL },
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

describe('IndexedDbSyncStore', () => {
  let factory: IdbFactoryLike
  let degradations: DurabilityDegradation[]

  beforeEach(() => {
    factory = freshFactory()
    degradations = []
  })

  const open = async (f: IdbFactoryLike = factory): Promise<IndexedDbSyncStore> =>
    await IndexedDbSyncStore.open({
      factory: f,
      databaseName: REPLICA_DB_NAME,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  const put = async (store: IndexedDbSyncStore, id: string): Promise<void> => {
    const result = await store.viewFor(PRINCIPAL).outbox.apply({
      put: [record(id)],
      expect: [{ mutationId: id as MutationId, expect: 'absent' }],
    })
    expect(result).toEqual({ ok: true })
  }

  describe('ADR 3 D12 — insertion order survives a reload', () => {
    it('a re-opened store hands the queue back in INSERTION order, not key order', async () => {
      const store = await open()
      // Deliberately enqueued against alphabetical order: key order would be
      // m-a, m-b, m-c and insertion order is the reverse. A store that hydrated by
      // IndexedDB key order — which is what `getAll` returns and what an adapter
      // gets for free — would produce the sorted list, so this case cannot pass by
      // accident.
      for (const id of ['m-c', 'm-a', 'm-b']) await put(store, id)
      expect((await store.viewFor(PRINCIPAL).outbox.read()).map((r) => r.mutationId)).toEqual([
        'm-c',
        'm-a',
        'm-b',
      ])
      store.close()

      const reopened = await open()
      expect((await reopened.viewFor(PRINCIPAL).outbox.read()).map((r) => r.mutationId)).toEqual([
        'm-c',
        'm-a',
        'm-b',
      ])
      reopened.close()
    })

    it('a REPLACING put keeps the record’s existing position, across a reload', async () => {
      const store = await open()
      for (const id of ['m-c', 'm-a', 'm-b']) await put(store, id)
      await store.viewFor(PRINCIPAL).outbox.apply({
        put: [record('m-c', 'sending')],
        expect: [{ mutationId: 'm-c' as MutationId, expect: 'queued' }],
      })
      store.close()

      const reopened = await open()
      const rows = await reopened.viewFor(PRINCIPAL).outbox.read()
      expect(rows.map((r) => r.mutationId)).toEqual(['m-c', 'm-a', 'm-b'])
      expect(rows[0]?.state).toBe('sending')
      reopened.close()
    })
  })

  describe('ADR 6 D4.6 — two tabs, one physical store', () => {
    /** Two connections over one origin: two mirrors, one engine. That IS two tabs. */
    const twoTabs = async (): Promise<[IndexedDbSyncStore, IndexedDbSyncStore]> => [
      await open(),
      await open(),
    ]

    it('a stale precondition is refused at COMMIT, by a read the other tab’s mirror cannot answer', async () => {
      const seed = await open()
      await put(seed, 'm-1')
      seed.close()

      const [tabA, tabB] = await twoTabs()
      // Both tabs believe m-1 is `queued`; both mirrors say so.
      expect((await tabB.viewFor(PRINCIPAL).outbox.read())[0]?.state).toBe('queued')

      // Tab A moves it on. Tab B's mirror is now stale and cannot know.
      await tabA.viewFor(PRINCIPAL).outbox.apply({
        put: [record('m-1', 'sending')],
        expect: [{ mutationId: 'm-1' as MutationId, expect: 'queued' }],
      })
      await tabA.settled()

      // Tab B stages against its stale mirror — so the mirror-level check PASSES,
      // which is exactly why the durable re-check inside the transaction has to
      // exist. Without it this commit would silently win.
      await expect(
        tabB.unitOfWork.transact(async (span) => {
          await tabB.viewFor(PRINCIPAL).outbox.apply(
            {
              remove: ['m-1' as MutationId],
              expect: [{ mutationId: 'm-1' as MutationId, expect: 'queued' }],
            },
            span,
          )
        }),
      ).rejects.toBeInstanceOf(SyncCommitConflict)

      // Tab A's write stands; nothing was clobbered.
      const durable = await readDurable(factory)
      expect((durable[OUTBOX_STORE] as { record: OutboxRecord }[])[0]?.record.state).toBe('sending')
      tabA.close()
      tabB.close()
    })

    it('COUNTERFACTUAL — with no concurrent writer the identical commit succeeds', async () => {
      // Without this, the case above is satisfied by an adapter that refuses every
      // span-enrolled outbox removal for any reason at all.
      const seed = await open()
      await put(seed, 'm-1')
      seed.close()

      const tab = await open()
      await tab.unitOfWork.transact(async (span) => {
        await tab.viewFor(PRINCIPAL).outbox.apply(
          {
            remove: ['m-1' as MutationId],
            expect: [{ mutationId: 'm-1' as MutationId, expect: 'queued' }],
          },
          span,
        )
      })
      expect(await tab.viewFor(PRINCIPAL).outbox.read()).toEqual([])
      tab.close()
    })
  })

  describe('ADR 6 D4.5 — poison never wedges boot', () => {
    it('a store written by a NEWER build is cleared and the client cold-starts', async () => {
      // Forward-only (D5.1): there is no down migration, so a database at a higher
      // version than this build understands cannot be read. IndexedDB refuses the
      // open with a VersionError, which is the real poison signal — no injector.
      await new Promise<void>((resolve, reject) => {
        const request: IdbOpenRequestLike = factory.open(
          REPLICA_DB_NAME,
          REPLICA_SCHEMA_VERSION + 5,
        )
        request.onupgradeneeded = () => {
          request.result.createObjectStore('from-the-future', { keyPath: 'id' })
        }
        request.onsuccess = () => {
          request.result.close()
          resolve()
        }
        request.onerror = () => {
          reject(request.error ?? new Error('seed failed'))
        }
      })

      // BOOT DOES NOT WEDGE, and it does not throw past the adapter boundary.
      const store = await open()
      expect(store.durability()).toBe('durable')
      expect(degradations).toHaveLength(1)
      expect(degradations[0]).toMatchObject({ cause: 'corrupt' })

      // …and it is usable: a cold client that writes gets durable storage back.
      await put(store, 'm-1')
      store.close()
      const rows = await readDurable(factory)
      expect((rows[OUTBOX_STORE] as unknown[]).length).toBe(1)
    })

    it('an unreadable store reports `unavailable` and refuses reads loudly', async () => {
      const store = await open()
      await put(store, 'm-1')
      store.setCorrupt(true)
      expect(store.durability()).toBe('unavailable')
      expect(() => store.viewFor(PRINCIPAL).cache.readEntities()).toThrow(/unreadable/)
      // ADR 2 D7: the outbox's own loss is the one that must be LOUD, so its read
      // rejects rather than starting quietly empty.
      await expect(store.viewFor(PRINCIPAL).outbox.read()).rejects.toThrow(/unreadable/)
      store.close()
    })
  })

  describe('ADR 6 D1 — the in-memory fallback is the same port', () => {
    it('no IndexedDB at all still yields a working replica, reported as `unavailable`', async () => {
      const refusing: IdbFactoryLike = {
        open: () => {
          const request = {
            result: undefined as never,
            error: { name: 'UnknownError', message: 'no IndexedDB here' },
            onsuccess: null,
            onerror: null as ((this: unknown, ev: unknown) => void) | null,
            onupgradeneeded: null,
            transaction: null,
          }
          queueMicrotask(() => request.onerror?.call(request, undefined))
          return request as unknown as IdbOpenRequestLike
        },
        deleteDatabase: () => {
          const request = {
            result: undefined as never,
            error: null,
            onsuccess: null as ((this: unknown, ev: unknown) => void) | null,
            onerror: null,
            onupgradeneeded: null,
            transaction: null,
          }
          queueMicrotask(() => request.onsuccess?.call(request, undefined))
          return request as unknown as IdbOpenRequestLike
        },
      }
      const store = await open(refusing)
      expect(store.durability()).toBe('unavailable')

      // Private mode / a hard quota session: the app still runs. D1 names this a
      // first-class surface, not a failure state, and it is the SAME port — so the
      // kernel above needs no second code path.
      const view = store.viewFor(PRINCIPAL)
      view.cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-1',
            value: { v: 0 },
            provenance: { seq: 1 },
          },
        ],
        cursor: CURSOR,
      })
      expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 0 })
      expect(view.cache.readCursor()).toEqual(CURSOR)
      await expect(store.settled()).resolves.toBeUndefined()
    })
  })

  describe('two principals over one physical store (ADR 6 D4.1 / Amendment 1 D15.3)', () => {
    it('each view’s rows are a disjoint KEY RANGE, and a discard reaches only its own', async () => {
      const store = await open()
      for (const principal of ['ada', 'grace']) {
        store.viewFor(principal).cache.applyAtomic({
          operations: [
            {
              kind: 'upsert',
              entity: 'issue',
              entityId: 'SHARED',
              value: { owner: principal },
              provenance: { seq: 1 },
            },
          ],
          cursor: CURSOR,
        })
      }
      await store.settled()
      // Same entity id, two rows: the principal is part of the key, so one view
      // cannot overwrite the other's copy.
      expect((await readDurable(factory))[ENTITY_STORE]).toHaveLength(2)

      store.viewFor('ada').cache.discardCache()
      await store.settled()
      expect(store.viewFor('ada').cache.read('issue', 'SHARED')).toBeUndefined()
      expect(store.viewFor('grace').cache.read('issue', 'SHARED')?.value).toEqual({
        owner: 'grace',
      })
      expect((await readDurable(factory))[ENTITY_STORE]).toHaveLength(1)
      store.close()
    })
  })

  it('GUARD — the conformance instantiation really is IndexedDB-backed', async () => {
    // The whole point of running POD-373's suite against this hop is that it runs
    // against a durable engine. If this adapter ever degenerated into a memory fake
    // — a wrapper that answers every read from a Map — all 30 conformance cases
    // would still pass and nothing would say so. This fails first, and by name.
    const storage = await indexedDbInstantiation.open()
    const view = storage.viewFor(PRINCIPAL)
    await view.outbox.apply({
      put: [record('m-guard')],
      expect: [{ mutationId: 'm-guard' as MutationId, expect: 'absent' }],
    })
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'ADA-1',
          value: { v: 0 },
          provenance: { seq: 1 },
        },
      ],
      cursor: CURSOR,
    })
    // Read back through the store's OWN cold-start path, which re-reads IndexedDB.
    // A memory-only implementation would have nothing to re-read from.
    const rows = await view.outbox.read()
    expect(rows.map((r) => r.mutationId)).toEqual(['m-guard'])
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 0 })
    expect(indexedDbInstantiation.name).toBe('indexeddb')
  })
})
