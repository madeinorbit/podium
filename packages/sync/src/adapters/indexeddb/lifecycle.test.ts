import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import {
  ENTITY_STORE,
  META_STORE,
  OUTBOX_STORE,
  REPLICA_DB_NAME,
  REPLICA_SCHEMA_VERSION,
} from './schema'
import { type DurabilityDegradation, IndexedDbReconnectError, IndexedDbSyncStore } from './store'
import { requestAsPromise } from './idb'
import { SyncCommitConflict } from '../../span'
import { freshFactory, readDurable } from './test-support'

const PRINCIPAL = asUserId('ada')
const CURSOR: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }
const RECORD: OutboxRecord = {
  mutationId: 'pending' as MutationId,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(PRINCIPAL), onBehalfOf: PRINCIPAL },
  state: 'queued',
  queuedAt: 1_700_000_000_000,
  attempts: 0,
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('IndexedDB connection lifecycle', () => {
  it.each([
    'native close',
    'versionchange',
    'teardown',
  ] as const)('preserves a pending atomic span after %s', async (boundary) => {
    const factory = freshFactory()
    const opens = vi.spyOn(factory, 'open')
    const degradations: DurabilityDegradation[] = []
    const store = await IndexedDbSyncStore.open({
      factory,
      onDegraded: (event) => {
        degradations.push(event)
      },
    })
    const db = opens.mock.results[0]!.value.result
    const staged = deferred()
    const resume = deferred()
    const adopted: string[] = []
    const view = store.viewFor(PRINCIPAL)
    const pending = store.unitOfWork.transact(async (span) => {
      view.cache.applyAtomic(
        {
          operations: [
            { kind: 'upsert', entity: 'issue', entityId: 'ADA-1', value: { title: 'saved' } },
          ],
          cursor: CURSOR,
        },
        span,
      )
      await view.outbox.apply(
        {
          put: [RECORD],
          expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }],
        },
        span,
      )
      span.onCommit(() => {
        adopted.push('first')
      })
      span.onCommit(() => {
        adopted.push('second')
      })
      staged.resolve()
      await resume.promise
    })
    // Attach immediately so the baseline failure is an assertion, not an orphan.
    const result = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await staged.promise
    if (boundary === 'native close') db.close()
    if (boundary === 'versionchange') db.onversionchange?.call(db, {})
    if (boundary === 'teardown') store.close()
    expect(adopted).toEqual([])
    expect(view.cache.readCursor()).toBeNull()
    expect((await readDurable(factory))[OUTBOX_STORE]).toEqual([])
    resume.resolve()
    try {
      expect(await result).toBeUndefined()
      expect(adopted).toEqual(['first', 'second'])
      expect(view.cache.readCursor()).toEqual(CURSOR)
      expect(degradations).toEqual([])
      if (boundary === 'teardown') {
        for (const opened of opens.mock.results) {
          // No recovered handle may outlive teardown; active transactions still
          // finish normally even though their connection refuses new ones.
          expect(() => opened.value.result.transaction([OUTBOX_STORE], 'readonly')).toThrow(
            expect.objectContaining({ name: 'InvalidStateError' }),
          )
        }
      }
      const durable = await readDurable(factory)
      expect(durable[ENTITY_STORE]).toMatchObject([
        { entityId: 'ADA-1', value: { title: 'saved' } },
      ])
      expect(durable[META_STORE]).toMatchObject([{ key: 'cursor', value: CURSOR }])
      expect(durable[OUTBOX_STORE]).toMatchObject([{ record: RECORD }])
    } finally {
      store.close()
    }
  })

  it('shares recovery across independent lanes without changing cache write order', async () => {
    const factory = freshFactory()
    const opens = vi.spyOn(factory, 'open')
    const onDegraded = vi.fn()
    const store = await IndexedDbSyncStore.open({ factory, onDegraded })
    const view = store.viewFor(PRINCIPAL)
    opens.mock.results[0]!.value.result.close()
    view.cache.applyAtomic({
      operations: [
        { kind: 'upsert', entity: 'issue', entityId: 'ADA-1', value: { title: 'first' } },
      ],
      cursor: CURSOR,
    })
    view.cache.applyAtomic({
      operations: [
        { kind: 'upsert', entity: 'issue', entityId: 'ADA-1', value: { title: 'second' } },
      ],
      cursor: { ...CURSOR, seq: 2 },
    })
    const outbox = view.outbox.apply({
      put: [RECORD],
      expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }],
    })
    await expect(outbox).resolves.toEqual({ ok: true })
    await store.settled()
    expect(opens).toHaveBeenCalledTimes(2)
    expect(onDegraded).not.toHaveBeenCalled()
    store.close()
    const durable = await readDurable(factory)
    expect(durable[ENTITY_STORE]).toMatchObject([{ value: { title: 'second' } }])
    expect(durable[META_STORE]).toMatchObject([{ value: { ...CURSOR, seq: 2 } }])
    expect(durable[OUTBOX_STORE]).toMatchObject([{ record: RECORD }])
  })

  it('rechecks cross-tab preconditions after reopening, before any adoption', async () => {
    const factory = freshFactory()
    const opens = vi.spyOn(factory, 'open')
    const store = await IndexedDbSyncStore.open({ factory, onDegraded: vi.fn() })
    const db = opens.mock.results[0]!.value.result
    const other = await IndexedDbSyncStore.open({ factory, onDegraded: vi.fn() })
    const staged = deferred()
    const resume = deferred()
    const adopted = vi.fn()
    const pending = store.unitOfWork.transact(async (span) => {
      store.viewFor(PRINCIPAL).cache.applyAtomic({ operations: [], cursor: CURSOR }, span)
      await store
        .viewFor(PRINCIPAL)
        .outbox.apply(
          { put: [RECORD], expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }] },
          span,
        )
      span.onCommit(adopted)
      staged.resolve()
      await resume.promise
    })
    const outcome = pending.catch((error: unknown) => error)
    await staged.promise
    await other.viewFor(PRINCIPAL).outbox.apply({
      put: [RECORD],
      expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }],
    })
    db.close()
    resume.resolve()
    expect(await outcome).toBeInstanceOf(SyncCommitConflict)
    expect(adopted).not.toHaveBeenCalled()
    expect(store.viewFor(PRINCIPAL).cache.readCursor()).toBeNull()
    store.close()
    other.close()
    const durable = await readDurable(factory)
    expect(durable[META_STORE]).toEqual([])
    expect(durable[OUTBOX_STORE]).toMatchObject([{ record: RECORD }])
  })

  it.each([
    'all regions',
    'outbox',
  ] as const)('recovers the %s fresh-truth read', async (region) => {
    const factory = freshFactory()
    const opens = vi.spyOn(factory, 'open')
    const store = await IndexedDbSyncStore.open({ factory, onDegraded: vi.fn() })
    const db = opens.mock.results[0]!.value.result
    const writer = await IndexedDbSyncStore.open({ factory, onDegraded: vi.fn() })
    await writer.viewFor(PRINCIPAL).outbox.apply({
      put: [RECORD],
      expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }],
    })
    db.close()
    if (region === 'all regions') await store.rehydrate()
    expect(await store.viewFor(PRINCIPAL).outbox.read()).toEqual([RECORD])
    store.close()
    writer.close()
  })

  it.each([
    'awaited span',
    'void span',
    'eager cache',
  ] as const)('surfaces an incompatible upgrade for %s without deleting durable data', async (path) => {
    const factory = freshFactory()
    const deletes = vi.spyOn(factory, 'deleteDatabase')
    const onDegraded = vi.fn()
    const store = await IndexedDbSyncStore.open({ factory, onDegraded })
    const view = store.viewFor(PRINCIPAL)
    await view.outbox.apply({
      put: [RECORD],
      expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }],
    })
    // A real versionchange from another tab closes this store's old handle.
    const upgraded = await requestAsPromise(
      factory.open(REPLICA_DB_NAME, REPLICA_SCHEMA_VERSION + 1),
    )
    const adopted = vi.fn()
    const mutation = { operations: [], cursor: CURSOR }
    if (path === 'awaited span') {
      await expect(
        store.unitOfWork.transact(async (span) => {
          view.cache.applyAtomic(mutation, span)
          span.onCommit(adopted)
        }),
      ).rejects.toMatchObject({ name: 'IndexedDbReconnectError', cause: { name: 'VersionError' } })
      expect(adopted).not.toHaveBeenCalled()
      expect(view.cache.readCursor()).toBeNull()
    } else if (path === 'void span') {
      const span = view.cache.beginSpan()
      view.cache.applyAtomic(mutation, span)
      span.onCommit(adopted)
      span.commit()
      // The void port cannot return the promise. Give an orphan a whole task
      // to surface, then observe its failure through the documented boundary.
      await new Promise((resolve) => setTimeout(resolve, 10))
      await expect(store.settled()).rejects.toBeInstanceOf(IndexedDbReconnectError)
      expect(adopted).not.toHaveBeenCalled()
      expect(view.cache.readCursor()).toBeNull()
    } else {
      view.cache.applyAtomic(mutation)
      // Start fresh-truth reads while the eager commit is still pending: a
      // failed commit must not let them replace its published in-memory draft.
      const [cacheRead, outboxRead] = await Promise.allSettled([
        store.rehydrate(),
        view.outbox.read(),
      ])
      expect(cacheRead.status).toBe('fulfilled')
      // The independent outbox read can reach the closed connection first. Its
      // async port reports the failed reopen to its caller, without erasing rows.
      expect(outboxRead).toMatchObject({
        status: 'rejected',
        reason: { name: 'IndexedDbReconnectError' },
      })
      expect(view.cache.readCursor()).toEqual(CURSOR)
      expect(onDegraded).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'degraded-memory', cause: 'unavailable' }),
      )
    }
    expect(deletes).not.toHaveBeenCalled()
    store.close()
    upgraded.close()
    const durable = await readDurable({
      open: (name) => factory.open(name),
      deleteDatabase: (name) => factory.deleteDatabase(name),
    })
    expect(durable[OUTBOX_STORE]).toMatchObject([{ record: RECORD }])
    expect(durable[META_STORE]).toEqual([])
  })
})
