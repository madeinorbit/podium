import { asUserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheOperation, ReplicaCacheStore } from '../replica/ports'
import type { Cursor, EntityRecord } from '../replica/types'
import type { SyncUnitOfWork } from '../span'

export const DRAFT_PRINCIPAL = asUserId('draft-ada')
const OTHER = asUserId('draft-grace')
const PRE: Cursor = { feedId: 'draft-feed', epoch: 'e1', seq: 1 }
const POST: Cursor = { ...PRE, seq: 2 }

interface DraftStore {
  readonly unitOfWork: SyncUnitOfWork
  viewFor(principal: string): { readonly cache: ReplicaCacheStore }
  entitiesOf(principal: string): Map<string, EntityRecord>
  close(): void
}

export interface DraftFixture {
  readonly store: DraftStore
  /** Deny the second write inside the native transaction, after the first lands. */
  failCommit(): void
  reopen(): Promise<DraftStore>
  settled(): Promise<void>
  cleanup(): void
}

const row = (id: string, value = 0): EntityRecord => ({
  entity: 'session',
  entityId: id,
  value: { heartbeat: value },
  provenance: { seq: value + 1 },
})

const upsert = (id: string, value = 1): CacheOperation => ({ kind: 'upsert', ...row(id, value) })
const remove = (id: string): CacheOperation => ({
  kind: 'remove',
  entity: 'session',
  entityId: id,
})

/** Count actual row enumeration/copies and published writes, without product counters. */
function countRows(rows: Map<string, EntityRecord>) {
  const counts = { copiedOrVisited: 0, sets: 0, deletes: 0 }
  function* counted<T>(iterator: IterableIterator<T>): IterableIterator<T> {
    for (const value of iterator) {
      counts.copiedOrVisited += 1
      yield value
    }
  }
  vi.spyOn(rows, Symbol.iterator).mockImplementation(() => counted(Map.prototype.entries.call(rows)))
  vi.spyOn(rows, 'entries').mockImplementation(() => counted(Map.prototype.entries.call(rows)))
  vi.spyOn(rows, 'keys').mockImplementation(() => counted(Map.prototype.keys.call(rows)))
  vi.spyOn(rows, 'values').mockImplementation(() => counted(Map.prototype.values.call(rows)))
  vi.spyOn(rows, 'forEach').mockImplementation((callback, thisArg) => {
    Map.prototype.forEach.call(rows, (value: EntityRecord, key: string) => {
      counts.copiedOrVisited += 1
      callback.call(thisArg, value, key, rows)
    })
  })
  vi.spyOn(rows, 'set').mockImplementation((key, value) => {
    counts.sets += 1
    return Map.prototype.set.call(rows, key, value)
  })
  vi.spyOn(rows, 'delete').mockImplementation((key) => {
    counts.deletes += 1
    return Map.prototype.delete.call(rows, key)
  })
  return counts
}

/** Run the same publication and cost contract against both durable engines. */
export function changedKeyDraftTests(name: string, create: () => Promise<DraftFixture>): void {
  describe(`${name} — changed-key drafts`, () => {
    let fixture: DraftFixture | undefined
    const open = async () => {
      fixture = await create()
      return fixture
    }
    afterEach(() => {
      vi.restoreAllMocks()
      fixture?.cleanup()
      fixture = undefined
    })

    async function seed(store: DraftStore, rows = [row('a'), row('b')]): Promise<ReplicaCacheStore> {
      const cache = store.viewFor(DRAFT_PRINCIPAL).cache
      await store.unitOfWork.transact(async (span) => cache.installSnapshot(rows, PRE, [], span))
      return cache
    }

    it.each([128, 512])('copy-count guard: one-row heartbeat visits zero of %i cached rows per update', async (size) => {
      const { store, settled } = await open()
      const cache = await seed(store, Array.from({ length: size }, (_, i) => row(String(i))))
      const rows = store.entitiesOf(DRAFT_PRINCIPAL)
      const counts = countRows(rows)
      for (let update = 1; update <= 5; update += 1) {
        counts.copiedOrVisited = counts.sets = counts.deletes = 0
        await store.unitOfWork.transact(async (span) => {
          cache.applyAtomic({ operations: [upsert('0', update)], cursor: POST }, span)
          expect(cache.read('session', '0')?.value).toEqual({ heartbeat: update - 1 })
        })
        expect(counts).toEqual({ copiedOrVisited: 0, sets: 1, deletes: 0 })
        expect(cache.read('session', '0')?.value).toEqual({ heartbeat: update })
      }
      counts.copiedOrVisited = counts.sets = counts.deletes = 0
      await store.unitOfWork.transact(async (span) => {
        cache.applyAtomic({ operations: [remove('1'), upsert('1', 9)], cursor: POST }, span)
      })
      expect(counts).toEqual({ copiedOrVisited: 0, sets: 1, deletes: 1 })
      counts.copiedOrVisited = counts.sets = counts.deletes = 0
      cache.applyAtomic({ operations: [upsert('0', 6)], cursor: POST })
      expect(cache.read('session', '0')?.value).toEqual({ heartbeat: 6 })
      await settled()
      expect(counts).toEqual({ copiedOrVisited: 0, sets: 1, deletes: 0 })
      expect(store.entitiesOf(DRAFT_PRINCIPAL)).toBe(rows)
      expect(rows.size).toBe(size)
    })

    it('prepare reads PRE; publish and adoption read the committed POST', async () => {
      const { store, reopen } = await open()
      const cache = await seed(store)
      const phases: string[] = []
      await store.unitOfWork.transact(async (span) => {
        cache.applyAtomic({ operations: [upsert('a'), remove('b')], cursor: POST }, span)
        expect(cache.read('session', 'a')?.value).toEqual({ heartbeat: 0 })
        expect(cache.read('session', 'b')).toBeDefined()
        span.join({
          prepare: () => {
            phases.push('prepare')
            expect(cache.read('session', 'a')?.value).toEqual({ heartbeat: 0 })
            expect(cache.readCursor()).toEqual(PRE)
          },
          publish: () => {
            phases.push('publish')
            expect(cache.read('session', 'a')?.value).toEqual({ heartbeat: 1 })
            expect(cache.read('session', 'b')).toBeUndefined()
            expect(cache.readCursor()).toEqual(POST)
          },
        })
        span.onCommit(() => {
          phases.push('adopt')
          expect(cache.read('session', 'a')?.value).toEqual({ heartbeat: 1 })
        })
      })
      expect(phases).toEqual(['prepare', 'publish', 'adopt'])
      store.close()
      const recovered = await reopen()
      try {
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readEntities()).toEqual([row('a', 1)])
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readCursor()).toEqual(POST)
      } finally {
        recovered.close()
      }
    })

    it.each(['body', 'prepare', 'transaction'] as const)('%s failure discards changed keys and leaves the old mirror and durable rows', async (failure) => {
      const { store, failCommit, reopen } = await open()
      const cache = await seed(store)
      const rows = store.entitiesOf(DRAFT_PRINCIPAL)
      const phases: string[] = []
      if (failure === 'transaction') failCommit()
      await expect(store.unitOfWork.transact(async (span) => {
        cache.applyAtomic({ operations: [upsert('a'), remove('b')], cursor: POST }, span)
        span.join({
          prepare: () => {
            expect(cache.read('session', 'a')?.value).toEqual({ heartbeat: 0 })
            if (failure === 'prepare') throw new Error('draft failure')
          },
          publish: () => { phases.push('publish') },
          discard: () => { phases.push('discard') },
        })
        span.onCommit(() => { phases.push('adopt') })
        if (failure === 'body') throw new Error('draft failure')
      })).rejects.toThrow('draft failure')
      expect(phases).toEqual(['discard'])
      expect(store.entitiesOf(DRAFT_PRINCIPAL)).toBe(rows)
      expect(cache.readEntities()).toEqual([row('a'), row('b')])
      expect(cache.readCursor()).toEqual(PRE)
      expect(cache.readPersonalRowsCompleteAt()).toEqual(PRE)
      store.close()
      const recovered = await reopen()
      try {
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readEntities()).toEqual([row('a'), row('b')])
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readCursor()).toEqual(PRE)
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readPersonalRowsCompleteAt()).toEqual(PRE)
      } finally {
        recovered.close()
      }
    })

    it('a later publication preserves unrelated keys committed while its body was open', async () => {
      const { store, reopen } = await open()
      const cache = await seed(store)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const first = store.unitOfWork.transact(async (span) => {
        cache.applyAtomic({ operations: [upsert('a')], cursor: POST }, span)
        await gate
      })
      try {
        await store.unitOfWork.transact(async (span) => {
          cache.applyAtomic({ operations: [upsert('b', 2)], cursor: POST }, span)
        })
      } finally {
        release()
        await first
      }
      expect(cache.readEntities()).toEqual([row('a', 1), row('b', 2)])
      store.close()
      const recovered = await reopen()
      try {
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readEntities()).toEqual([row('a', 1), row('b', 2)])
      } finally {
        recovered.close()
      }
    })

    it('ordered tombstones and upserts reinsert keys without changing untouched rows', async () => {
      const { store } = await open()
      const cache = await seed(store)
      const untouched = cache.read('session', 'b')
      await store.unitOfWork.transact(async (span) => {
        cache.applyAtomic({ operations: [upsert('c'), remove('a'), upsert('a', 2), upsert('d'), remove('c'), upsert('c', 3)] }, span)
        cache.applyAtomic({ operations: [{ kind: 'evict', entity: 'session', entityId: 'd' }], cursor: POST }, span)
      })
      expect(cache.readEntities()).toEqual([row('b'), row('a', 2), row('c', 3)])
      expect(cache.read('session', 'b')).toBe(untouched)
    })

    it('snapshot replacements consume the staged overlay, including new keys and tombstones', async () => {
      const { store, reopen } = await open()
      const cache = await seed(store)
      await store.unitOfWork.transact(async (span) => {
        cache.applyAtomic({ operations: [upsert('doomed'), remove('a')] }, span)
        cache.installSnapshot([row('snapshot')], POST, [{ operations: [remove('snapshot'), upsert('buffered')] }], span)
        cache.applyAtomic({ operations: [upsert('after')] }, span)
        cache.installSnapshot([row('final')], POST, [{ operations: [upsert('tail')] }], span)
        cache.applyAtomic({ operations: [remove('final'), upsert('tail', 2)] }, span)
        expect(cache.readEntities()).toEqual([row('a'), row('b')])
      })
      expect(cache.readEntities()).toEqual([row('tail', 2)])
      store.close()
      const recovered = await reopen()
      try {
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readEntities()).toEqual([row('tail', 2)])
        expect(recovered.viewFor(DRAFT_PRINCIPAL).cache.readCursor()).toEqual(POST)
      } finally {
        recovered.close()
      }
    })

    it('an aborted replacement leaves the published slice intact and principals stay isolated', async () => {
      const { store, settled } = await open()
      const cache = await seed(store)
      const other = store.viewFor(OTHER).cache
      await store.unitOfWork.transact(async (span) => other.installSnapshot([row('a', 7)], PRE, [], span))
      await expect(store.unitOfWork.transact(async (span) => {
        cache.installSnapshot([row('replacement')], POST, [], span)
        cache.applyAtomic({ operations: [remove('replacement'), upsert('tail')] }, span)
        throw new Error('abort replacement')
      })).rejects.toThrow('abort replacement')
      await store.unitOfWork.transact(async (span) => cache.applyAtomic({ operations: [remove('a')] }, span))
      expect(cache.readEntities()).toEqual([row('b')])
      expect(other.readEntities()).toEqual([row('a', 7)])
      cache.discardCache()
      expect(cache.readEntities()).toEqual([])
      expect(other.readEntities()).toEqual([row('a', 7)])
      await settled()
    })
  })
}
