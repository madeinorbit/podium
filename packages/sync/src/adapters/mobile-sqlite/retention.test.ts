import { rmSync } from 'node:fs'
import { actorUser, asMutationId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import { Replica } from '../../replica/replica'
import type { EntityRecord } from '../../replica/types'
import { SqliteSyncStore } from './store'
import { freshDatabaseFile, readDurable, sqliteEngine } from './test-support'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const remove of cleanup.splice(0)) remove()
})
const freshFactory = () => {
  const fresh = freshDatabaseFile()
  cleanup.push(fresh.cleanup)
  return fresh.file
}
const open = (options: {
  factory: string
  retainEntity?: (entity: string) => boolean
  onDegraded: (reason: unknown) => void
}) =>
  SqliteSyncStore.open({
    ...options,
    openDatabase: () => sqliteEngine.open(options.factory),
    deleteDatabase: () => rmSync(options.factory, { force: true }),
  })

const cursor = (seq: number) => ({ feedId: 'f', epoch: 'e', seq })
const row = (entity: string, id = 'i'): EntityRecord => ({
  entity,
  entityId: id,
  value: { id, title: entity },
  provenance: { seq: 1 },
})
const queued: OutboxRecord = {
  mutationId: asMutationId('m'),
  command: { name: 'issues.rename', version: 1, delivery: 'offline-eligible' },
  input: { id: 'i', title: 'authored' },
  partitionKey: 'issue:i',
  attribution: { actor: actorUser(asUserId('alice')), onBehalfOf: asUserId('alice') },
  state: 'queued',
  queuedAt: 1,
  attempts: 0,
}

describe('native SQLite optional entity retention', () => {
  it('keeps every kind unless the caller opts out', async () => {
    const factory = freshFactory()
    const store = await open({ factory, onDegraded: () => {} })
    store.viewFor('alice').cache.installSnapshot([row('issue'), row('future')], cursor(1), [])
    await store.settled()
    store.close()
    const reloaded = await open({ factory, onDegraded: () => {} })
    expect(
      reloaded
        .viewFor('alice')
        .cache.readEntities()
        .map((r) => r.entity)
        .sort(),
    ).toEqual(['future', 'issue'])
    reloaded.close()
  })

  it('ignores and retires old cache rows without resetting cursor, normalized rows or outbox', async () => {
    const factory = freshFactory()
    const old = await open({ factory, onDegraded: () => {} })
    for (const principal of ['alice', 'bob']) {
      old
        .viewFor(principal)
        .cache.installSnapshot([row('issue'), row('issueProjection'), row('future')], cursor(9), [])
    }
    await old.viewFor('alice').outbox.apply({
      put: [queued],
      expect: [{ mutationId: queued.mutationId, expect: 'absent' }],
    })
    await old.settled()
    old.close()
    const before = await readDurable(factory)
    const degraded: unknown[] = []
    const web = await open({
      factory,
      retainEntity: (entity) => entity !== 'issue',
      onDegraded: (d) => degraded.push(d),
    })
    for (const principal of ['alice', 'bob']) {
      const cache = web.viewFor(principal).cache
      expect(cache.read('issue', 'i')).toBeUndefined()
      expect(
        cache
          .readEntities()
          .map((r) => r.entity)
          .sort(),
      ).toEqual(['future', 'issueProjection'])
      expect(cache.readCursor()).toEqual(cursor(9))
    }
    expect(await web.viewFor('bob').outbox.read()).toEqual([])
    expect(await web.viewFor('alice').outbox.read()).toEqual([queued])
    expect(degraded).toEqual([])
    const after = await readDurable(factory)
    expect(after.entities).toEqual(before.entities.filter((r) => r.entity !== 'issue'))
    expect(after.cursors).toEqual(before.cursors)
    expect(after.outbox).toEqual(before.outbox)
    web.close()
  })

  it('drops snapshot, buffered and delta inputs on disk and in the mirror but commits their cursor', async () => {
    const factory = freshFactory()
    const store = await open({
      factory,
      retainEntity: (entity) => entity !== 'issue',
      onDegraded: () => {},
    })
    const cache = store.viewFor('alice').cache
    const put = (entity: string, id = 'i') => ({ kind: 'upsert' as const, ...row(entity, id) })
    await store.unitOfWork.transact(async (span) => {
      cache.installSnapshot(
        [row('issue'), row('issueProjection')],
        cursor(3),
        [{ operations: [put('issue', 'j')], cursor: cursor(4) }],
        span,
      )
    })
    await store.unitOfWork.transact(async (span) => {
      cache.applyAtomic(
        {
          operations: [
            put('issue', 'k'),
            put('future'),
            { kind: 'remove', entity: 'issue', entityId: 'i' },
          ],
          cursor: cursor(7),
        },
        span,
      )
    })
    expect(
      cache
        .readEntities()
        .map((r) => r.entity)
        .sort(),
    ).toEqual(['future', 'issueProjection'])
    expect(cache.readCursor()).toEqual(cursor(7))
    expect((await readDurable(factory)).entities.some((r) => r.entity === 'issue')).toBe(false)
    await store.rehydrate()
    expect(cache.readEntities()).toHaveLength(2)
    store.close()
  })

  it('preserves abort, rescope, delete vs eviction, readmission and principal boundaries', async () => {
    const factory = freshFactory()
    const store = await open({
      factory,
      retainEntity: (entity) => entity !== 'issue',
      onDegraded: () => {},
    })
    const alice = store.viewFor('alice')
    const bob = store.viewFor('bob')
    alice.cache.installSnapshot([row('issueProjection')], cursor(1), [])
    bob.cache.installSnapshot([row('issueProjection')], cursor(1), [])
    await alice.outbox.apply({
      put: [queued],
      expect: [{ mutationId: queued.mutationId, expect: 'absent' }],
    })
    const events: unknown[] = []
    const replica = new Replica({
      store: alice.cache,
      unitOfWork: store.unitOfWork,
      authority: {
        bootstrap: async function* () {},
        changesRange: async () => (async function* () {})(),
      },
      onEvent: (event) => events.push(event),
    })
    replica.connect()
    await replica.settled()
    const change = (
      seq: number,
      op: 'upsert' | 'remove' | 'evict',
      entity = 'issueProjection',
    ) => ({
      seq,
      op,
      entity,
      entityId: 'i',
      ...(op === 'upsert' ? { payload: row(entity).value } : {}),
    })
    const frame = async (fromSeq: number, seq: number, changes: ReturnType<typeof change>[]) => {
      await replica.receive({ kind: 'delta', ...cursor(seq), fromSeq, minAvailableSeq: 0, changes })
      await replica.settled()
    }
    await frame(1, 3, [change(2, 'upsert', 'issue'), change(3, 'evict')])
    expect(replica.exitKind('issueProjection', 'i')).toBe('evicted')
    expect(alice.cache.read('issue', 'i')).toBeUndefined()
    expect(bob.cache.read('issueProjection', 'i')).toBeDefined()
    await frame(3, 4, [change(4, 'upsert')])
    expect(events).toContainEqual(expect.objectContaining({ type: 'upserted', readmitted: true }))
    expect(replica.exitKind('issueProjection', 'i')).toBeUndefined()
    await frame(4, 5, [change(5, 'remove')])
    expect(replica.exitKind('issueProjection', 'i')).toBe('removed')
    await expect(
      store.unitOfWork.transact(async (span) => {
        alice.cache.installSnapshot([row('issueProjection', 'new')], cursor(99), [], span)
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(alice.cache.readCursor()).toEqual(cursor(5))
    expect(alice.cache.read('issueProjection', 'new')).toBeUndefined()
    await store.unitOfWork.transact(async (span) =>
      alice.cache.installSnapshot([], cursor(6), [], span),
    )
    expect(alice.cache.readEntities()).toEqual([])
    expect(await alice.outbox.read()).toEqual([queued])
    expect(bob.cache.readEntities()).toHaveLength(1)
    store.close()
  })
})
