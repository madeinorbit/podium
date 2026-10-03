/** ADR 6 Amendment 1: the SAME completeness obligations on every cache adapter. */
import { asMutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AuthorityReadPort,
  type CacheMutation,
  ReplicaStoreCorruptError,
} from '../replica/ports'
import { Replica } from '../replica/replica'
import type { Cursor, EntityRecord } from '../replica/types'
import type { SyncInstantiation } from './instantiation'

const PRINCIPAL = 'u-ada'
const cursor = (seq: number): Cursor => ({ feedId: 'feed', epoch: 'epoch', seq })
const rows: readonly EntityRecord[] = [
  { entity: 'session', entityId: 's', value: { sessionId: 's' }, provenance: { seq: 1 } },
  {
    entity: 'sessionUserState',
    entityId: 'personal',
    value: { readAt: 'read' },
    provenance: { seq: 1 },
  },
]
const mutation = (seq: number): CacheMutation => ({
  operations: [
    {
      kind: 'upsert',
      entity: 'sessionUserState',
      entityId: 'personal',
      value: { readAt: `read-${seq}` },
      provenance: { seq },
    },
  ],
  cursor: cursor(seq),
  personalRowsCompleteAt: cursor(seq),
})
const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const idleAuthority: AuthorityReadPort = {
  changesRange: async () => (async function* () {})(),
  bootstrap: async function* () {
    yield* []
    throw new Error('unexpected bootstrap')
  },
}

export function describePersonalRowCompleteness(instantiation: SyncInstantiation): void {
  describe(`personal row completeness — ${instantiation.name}`, () => {
    it('publishes rows, cursor and certification together in ONE batch', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      const before = storage.unitOfWorkTransactions()
      await storage.unitOfWork.transact(async (span) => {
        cache.applyAtomic(mutation(1), span)
        expect(cache.readEntities()).toEqual([])
        expect(cache.readCursor()).toBeNull()
        expect(cache.readPersonalRowsCompleteAt()).toBeNull()
      })
      expect(storage.unitOfWorkTransactions() - before).toBe(1)
      expect(cache.read('sessionUserState', 'personal')?.value).toEqual({ readAt: 'read-1' })
      expect(cache.readCursor()).toEqual(cursor(1))
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(1))
    })

    it('keeps the entire old state when a certified batch aborts', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      await storage.unitOfWork.transact(async (span) => cache.applyAtomic(mutation(1), span))
      storage.failNextCommit(new Error('power loss'))
      await expect(
        storage.unitOfWork.transact(async (span) => cache.applyAtomic(mutation(2), span)),
      ).rejects.toThrow('power loss')
      expect(cache.read('sessionUserState', 'personal')?.value).toEqual({ readAt: 'read-1' })
      expect(cache.readCursor()).toEqual(cursor(1))
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(1))
    })

    it('certifies a whole installed snapshot at its final buffered cursor', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      await storage.unitOfWork.transact(async (span) => {
        cache.installSnapshot(rows, cursor(1), [mutation(2), mutation(3)], span)
        expect(cache.readPersonalRowsCompleteAt()).toBeNull()
      })
      expect(cache.read('session', 's')?.value).toEqual({ sessionId: 's' })
      expect(cache.read('sessionUserState', 'personal')?.value).toEqual({ readAt: 'read-3' })
      expect(cache.readCursor()).toEqual(cursor(3))
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(3))
    })

    it('extends one draft with the newest certification instead of resurrecting an earlier one', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      await storage.unitOfWork.transact(async (span) => {
        cache.applyAtomic(mutation(1), span)
        cache.applyAtomic(mutation(2), span)
      })
      expect(cache.readCursor()).toEqual(cursor(2))
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(2))
      expect(cache.read('sessionUserState', 'personal')?.value).toEqual({ readAt: 'read-2' })
    })

    it('rejects certification without its exact same-batch cursor before staging rows', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      for (const claim of [
        undefined,
        cursor(0),
        { ...cursor(1), feedId: 'other' },
        { ...cursor(1), epoch: 'other' },
      ]) {
        await expect(
          storage.unitOfWork.transact(async (span) => {
            cache.applyAtomic({ ...mutation(1), cursor: claim }, span)
          }),
        ).rejects.toThrow('same batch cursor')
        expect(cache.readEntities()).toEqual([])
        expect(cache.readCursor()).toBeNull()
        expect(cache.readPersonalRowsCompleteAt()).toBeNull()
      }
      await expect(
        storage.unitOfWork.transact(async (span) => {
          cache.installSnapshot(
            rows,
            cursor(1),
            [{ ...mutation(2), personalRowsCompleteAt: cursor(3) }],
            span,
          )
        }),
      ).rejects.toThrow('same batch cursor')
      expect(cache.readEntities()).toEqual([])
      expect(cache.readCursor()).toBeNull()
      expect(cache.readPersonalRowsCompleteAt()).toBeNull()
    })

    it('clears unproven row/cursor writes and explicit invalidation, retaining stale rows', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      for (const change of [
        { operations: [], personalRowsCompleteAt: null },
        { operations: [], cursor: cursor(2) },
        { operations: [{ kind: 'remove', entity: 'sessionUserState', entityId: 'personal' }] },
      ] satisfies CacheMutation[]) {
        await storage.unitOfWork.transact(async (span) =>
          cache.installSnapshot(rows, cursor(1), [], span),
        )
        await storage.unitOfWork.transact(async (span) => cache.applyAtomic(change, span))
        expect(cache.readPersonalRowsCompleteAt()).toBeNull()
        expect(cache.read('session', 's')?.value).toEqual({ sessionId: 's' })
      }
    })

    it('a principal switch never inherits another principal’s certification', async () => {
      const storage = await instantiation.open()
      const ada = storage.viewFor(PRINCIPAL).cache
      const bob = storage.viewFor('u-bob').cache
      await storage.unitOfWork.transact(async (span) =>
        ada.installSnapshot(rows, cursor(1), [], span),
      )
      expect(ada.readEntities()).toEqual(rows)
      expect(bob.readPersonalRowsCompleteAt()).toBeNull()
      expect(bob.readCursor()).toBeNull()
      ada.discardCache()
      expect(ada.readEntities()).toEqual([])
      expect(ada.readCursor()).toBeNull()
      expect(ada.readPersonalRowsCompleteAt()).toBeNull()
      expect(bob.readPersonalRowsCompleteAt()).toBeNull()
    })

    it('an old cache is unknown until successful resume; certified deltas then preserve completeness', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      await storage.unitOfWork.transact(async (span) =>
        cache.applyAtomic({ ...mutation(1), personalRowsCompleteAt: undefined }, span),
      )
      expect(cache.readPersonalRowsCompleteAt()).toBeNull()
      const replica = new Replica({ store: cache, authority: idleAuthority })
      replica.connect()
      await replica.settled()
      expect(replica.posture).toBe('live')
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(1))
      await replica.receive({
        ...cursor(2),
        kind: 'delta',
        fromSeq: 1,
        minAvailableSeq: 1,
        changes: [],
      })
      await replica.settled()
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(2))
    })

    it('an interrupted legacy resume never certifies its committed prefix', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      await storage.unitOfWork.transact(async (span) =>
        cache.applyAtomic({ operations: [], cursor: cursor(1) }, span),
      )
      const replica = new Replica({
        store: cache,
        authority: {
          ...idleAuthority,
          changesRange: async () =>
            (async function* () {
              yield {
                ...cursor(2),
                kind: 'delta' as const,
                fromSeq: 1,
                minAvailableSeq: 1,
                changes: [],
              }
              throw new Error('connection lost')
            })(),
        },
      })
      replica.connect()
      await replica.settled()
      expect(replica.posture).toBe('stale')
      expect(cache.readCursor()).toEqual(cursor(2))
      expect(cache.readPersonalRowsCompleteAt()).toBeNull()
    })

    it('an older pending frame cannot restore certification behind a rescope', async () => {
      const storage = await instantiation.open()
      const { cache } = storage.viewFor(PRINCIPAL)
      await storage.unitOfWork.transact(async (span) =>
        cache.installSnapshot(rows, cursor(1), [], span),
      )
      const staged = barrier()
      const commit = barrier()
      const entered = barrier()
      const walk = barrier()
      const replica = new Replica({
        store: cache,
        authority: {
          ...idleAuthority,
          bootstrap: async function* () {
            entered.release()
            await walk.promise
            yield { feedId: 'feed', epoch: 'epoch', snapshotSeq: 10, changes: [], last: true }
          },
        },
        overlay: {
          pending: () => [],
          reduce: () => ({ kind: 'no-reducer' }),
          retire: async () => {},
        },
        unitOfWork: {
          transact: async (body) =>
            storage.unitOfWork.transact(async (span) => {
              const result = await body(span)
              staged.release()
              await commit.promise
              return result
            }),
        },
      })
      replica.connect()
      await replica.settled()
      await replica.receive({
        ...cursor(2),
        kind: 'delta',
        fromSeq: 1,
        minAvailableSeq: 1,
        changes: [
          {
            seq: 2,
            entity: 'sessionUserState',
            entityId: 'personal',
            op: 'upsert',
            payload: { readAt: 'new' },
            mutationId: asMutationId('mine'),
          },
        ],
      })
      await staged.promise
      await replica.receive({ kind: 'rescope', feedId: 'feed', epoch: 'epoch' })
      commit.release()
      try {
        await entered.promise
        expect(cache.readCursor()).toEqual(cursor(2))
        expect(cache.readPersonalRowsCompleteAt()).toBeNull()
      } finally {
        walk.release()
        await replica.settled()
      }
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(10))
    })

    for (const cause of [
      'rescope',
      'resync-required',
      'compacted',
      'malformed',
      'epoch-mismatch',
      'local-corruption',
      'schema-version',
    ] as const) {
      it(`clears certification before the ${cause} recovery walk, then certifies its replacement`, async () => {
        const storage = await instantiation.open()
        const { cache } = storage.viewFor(PRINCIPAL)
        await storage.unitOfWork.transact(async (span) =>
          cache.installSnapshot(rows, cursor(1), [], span),
        )
        const entered = barrier()
        const walk = barrier()
        const corrupt = cause === 'local-corruption'
        let failWrite = false
        const store = new Proxy(cache, {
          get(target, property) {
            if (property === 'applyAtomic' && failWrite) {
              return () => {
                failWrite = false
                throw new ReplicaStoreCorruptError()
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const replica = new Replica({
          store,
          authority: {
            changesRange: async () =>
              cause === 'compacted'
                ? { kind: 'bootstrap-required', reason: 'compacted' }
                : (async function* () {})(),
            bootstrap: async function* () {
              entered.release()
              await walk.promise
              yield { feedId: 'feed', epoch: 'epoch', snapshotSeq: 10, changes: [], last: true }
            },
          },
        })
        if (cause !== 'compacted') {
          replica.connect()
          await replica.settled()
        }
        if (cause === 'schema-version') replica.replicaSchemaChanged()
        else if (cause === 'compacted') replica.connect()
        else if (cause === 'resync-required') replica.requestRebootstrap()
        else if (cause === 'rescope')
          await replica.receive({ kind: 'rescope', feedId: 'feed', epoch: 'epoch' })
        else {
          failWrite = corrupt
          await replica.receive({
            ...cursor(2),
            kind: 'delta',
            minAvailableSeq: 1,
            epoch: cause === 'epoch-mismatch' ? 'other' : 'epoch',
            fromSeq: cause === 'malformed' ? -1 : 1,
            changes: [],
          })
        }
        try {
          await entered.promise
          expect(cache.readPersonalRowsCompleteAt()).toBeNull()
          expect(cache.read('session', 's') !== undefined).toBe(
            !corrupt && cause !== 'schema-version',
          )
        } finally {
          walk.release()
          await replica.settled()
        }
        expect(cache.readCursor()).toEqual(cursor(10))
        expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor(10))
      })
    }
  })
}
