/**
 * THE ADAPTER'S OWN OBLIGATIONS — the ones neither the conformance suite nor the
 * crash, quota and lifecycle files reach.
 *
 * Each case here pins a property that a plausible-looking adapter can break while
 * every other suite in this directory stays green:
 *
 *  - the in-transaction precondition re-check (ADR 6 D4.6), which only a SECOND
 *    CONNECTION can exercise, because a single connection's mirror already knows;
 *  - "no SQLite at all still yields a working replica" (ADR 6 D1's in-memory adapter
 *    of the same port);
 *  - the JSON round trip, which is what a column actually stores;
 *  - `discardCache()` cannot reach the outbox, carried through to durable rows;
 *  - two principals over one file are disjoint by KEY, not by a filter.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import { ReplicaStoreCorruptError } from '../../replica/ports'
import type { Cursor } from '../../replica/types'
import { SyncCommitConflict } from '../../span'
import { type DurabilityDegradation, SqliteSyncStore } from './store'
import { freshDatabaseFile, readDurable, sqliteEngine } from './test-support'

const ADA = asUserId('ada')
const GRACE = asUserId('grace')
const M: MutationId = 'm-1' as MutationId
const CURSOR_1: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }

const record = (state: OutboxRecord['state']): OutboxRecord => ({
  mutationId: M,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(ADA), onBehalfOf: ADA },
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

describe('mobile SQLite adapter — store obligations', () => {
  let file: string
  let cleanup: () => void
  let degradations: DurabilityDegradation[]

  beforeEach(() => {
    const fresh = freshDatabaseFile()
    file = fresh.file
    cleanup = fresh.cleanup
    degradations = []
  })

  afterEach(() => {
    cleanup()
  })

  const open = async (): Promise<SqliteSyncStore> =>
    await SqliteSyncStore.open({
      openDatabase: () => sqliteEngine.open(file),
      deleteDatabase: () => undefined,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  describe('D4.6 — preconditions are re-checked inside the transaction, against durable rows', () => {
    /**
     * D4.6 is written for web's multi-TAB case. The mobile equivalent is a second
     * CONNECTION to the same file — a share extension, a notification-service process,
     * or the app relaunched while the old process is still finishing — and it is the
     * only way to reach this branch, because one connection's mirror already knows
     * what it wrote. A test with a single store can never fail this case, which is
     * exactly why it would be the one nobody writes.
     */
    it('a mutation staged against a stale belief is REFUSED at commit, not applied', async () => {
      const first = await open()
      const firstView = first.viewFor(ADA)
      await firstView.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        undefined,
      )

      // A second connection, with a mirror of its own, moves the record on.
      const second = await open()
      await second
        .viewFor(ADA)
        .outbox.apply(
          { put: [record('sending')], expect: [{ mutationId: M, expect: 'queued' }] },
          undefined,
        )
      second.close()

      // The first connection still believes `queued` — its mirror says so, so the
      // staging check passes and only the durable re-check can catch this.
      await expect(
        first.unitOfWork.transact(async (span) => {
          const result = await firstView.outbox.apply(
            { remove: [M], expect: [{ mutationId: M, expect: 'queued' }] },
            span,
          )
          expect(result).toEqual({ ok: true })
          firstView.cache.applyAtomic(
            {
              operations: [
                {
                  kind: 'upsert',
                  entity: 'issue',
                  entityId: 'ADA-1',
                  value: { v: 1 },
                  provenance: { seq: 1 },
                },
              ],
              cursor: CURSOR_1,
            },
            span,
          )
        }),
      ).rejects.toBeInstanceOf(SyncCommitConflict)

      // NOTHING was applied — including the ENTITY write in the same span, which is
      // the part a conflict handler that only rolled back the outbox would leave
      // behind. The record is still what the other connection made it.
      const durable = readDurable(file)
      expect(durable.entities).toEqual([])
      expect(durable.cursors).toEqual([])
      expect((durable.outbox[0]?.record as OutboxRecord).state).toBe('sending')
      first.close()
    })

    it('COUNTERFACTUAL — with a belief that is still true, the same commit lands', async () => {
      // Without this, the refusal above is equally consistent with an adapter that
      // refuses every multi-region commit, which would make the whole gate vacuous in
      // the other direction.
      const store = await open()
      const view = store.viewFor(ADA)
      await view.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        undefined,
      )
      await store.unitOfWork.transact(async (span) => {
        await view.outbox.apply(
          { remove: [M], expect: [{ mutationId: M, expect: 'queued' }] },
          span,
        )
        view.cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issue',
                entityId: 'ADA-1',
                value: { v: 1 },
                provenance: { seq: 1 },
              },
            ],
            cursor: CURSOR_1,
          },
          span,
        )
      })
      const durable = readDurable(file)
      expect(durable.entities.map((r) => r.value)).toEqual([{ v: 1 }])
      expect(durable.outbox).toEqual([])
      store.close()
    })
  })

  it('ADR 6 D1 — no usable SQLite at all still yields a working replica, and says it is not durable', async () => {
    const store = await SqliteSyncStore.open({
      openDatabase: () => {
        throw new Error('no SQLite on this platform')
      },
      deleteDatabase: () => {
        throw new Error('and nothing to delete either')
      },
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

    // SURFACED, never silent — the client can tell the user its offline guarantees
    // are gone rather than discovering it after a relaunch.
    expect(store.durability()).toBe('unavailable')
    expect(degradations).toEqual([
      expect.objectContaining({ mode: 'unavailable', cause: 'unavailable' }),
    ])

    // …and the session still works, in memory. A store that threw here would take the
    // app down on launch, which D4.5 rules out for the corrupt case and which is no
    // more acceptable for the absent one.
    const view = store.viewFor(ADA)
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'ADA-1',
          value: { v: 3 },
          provenance: { seq: 1 },
        },
      ],
      cursor: CURSOR_1,
    })
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 3 })
    expect(view.cache.readCursor()).toEqual(CURSOR_1)
  })

  it('ADR 2 D7 rung 5 — an unreadable store refuses reads with ReplicaStoreCorruptError', async () => {
    const store = await open()
    const view = store.viewFor(ADA)
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'ADA-1',
          value: { v: 1 },
          provenance: { seq: 1 },
        },
      ],
    })
    // It can say yes first.
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 1 })

    store.setCorrupt(true)
    expect(store.durability()).toBe('unavailable')
    expect(() => view.cache.readEntities()).toThrow(ReplicaStoreCorruptError)
    expect(() => view.cache.readCursor()).toThrow(ReplicaStoreCorruptError)
    await expect(view.outbox.read()).rejects.toBeInstanceOf(ReplicaStoreCorruptError)
    store.close()
  })

  it('values ride through JSON, because that is what the column holds', async () => {
    // The class of bug ADR 6 D4 exists to catch: anything surviving only by object
    // identity fails here the same way it would on device. Asserting the PROJECTION
    // rather than the input is what makes that visible instead of a surprise later.
    const store = await open()
    const view = store.viewFor(ADA)
    view.cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: 'ADA-1',
          value: { at: new Date('2026-01-01T00:00:00.000Z'), nested: { list: [1, 2] } },
          provenance: { seq: 1 },
        },
      ],
    })
    store.close()

    const relaunched = await open()
    expect(relaunched.viewFor(ADA).cache.read('issue', 'ADA-1')?.value).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      nested: { list: [1, 2] },
    })
    relaunched.close()
  })

  it('discardCache() reaches entities and cursor and CANNOT reach the outbox — durably', async () => {
    const store = await open()
    const view = store.viewFor(ADA)
    await store.unitOfWork.transact(async (span) => {
      await view.outbox.apply(
        { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
        span,
      )
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issue',
              entityId: 'ADA-1',
              value: { v: 1 },
              provenance: { seq: 1 },
            },
          ],
          cursor: CURSOR_1,
        },
        span,
      )
    })

    view.cache.discardCache()

    // The user's unsent write survives the cache being thrown away. Under
    // private-by-default a rescope fires whenever anyone's shares change, so this path
    // is reachable by a colleague clicking "share" — losing the queue here is data
    // loss on a normal path, not an exotic one.
    const durable = readDurable(file)
    expect(durable.entities).toEqual([])
    expect(durable.cursors).toEqual([])
    expect(durable.outbox.map((r) => r.mutationId)).toEqual([M])
    store.close()
  })

  it('two principals over one file are disjoint by KEY, and a discard reaches only one', async () => {
    const store = await open()
    for (const [principal, value] of [
      [ADA, { v: 'ada' }],
      [GRACE, { v: 'grace' }],
    ] as const) {
      store.viewFor(principal).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'SHARED-1',
            value,
            provenance: { seq: 1 },
          },
        ],
        cursor: CURSOR_1,
      })
    }

    // Same entity id, two rows, no interference — which a shared keyspace with a
    // `principal` column would not give: the second write would have replaced the
    // first.
    expect(store.viewFor(ADA).cache.read('issue', 'SHARED-1')?.value).toEqual({ v: 'ada' })
    expect(store.viewFor(GRACE).cache.read('issue', 'SHARED-1')?.value).toEqual({ v: 'grace' })

    store.viewFor(ADA).cache.discardCache()
    const durable = readDurable(file)
    expect(durable.entities).toEqual([
      { principal: GRACE, entity: 'issue', entityId: 'SHARED-1', value: { v: 'grace' } },
    ])
    expect(durable.cursors.map((r) => r.principal)).toEqual([GRACE])
    store.close()
  })

  it('sign-out erases entity, cursor and outbox for only that principal', async () => {
    const store = await open()
    for (const principal of [ADA, GRACE]) {
      const view = store.viewFor(principal)
      await store.unitOfWork.transact(async (span) => {
        await view.outbox.apply(
          { put: [record('queued')], expect: [{ mutationId: M, expect: 'absent' }] },
          span,
        )
        view.cache.applyAtomic(
          {
            operations: [
              {
                kind: 'upsert',
                entity: 'issue',
                entityId: 'SHARED-1',
                value: { owner: principal },
                provenance: { seq: 1 },
              },
            ],
            cursor: CURSOR_1,
          },
          span,
        )
      })
    }

    await store.erasePrincipal(ADA)
    store.close()

    const durable = readDurable(file)
    expect(durable.entities).toEqual([
      {
        principal: GRACE,
        entity: 'issue',
        entityId: 'SHARED-1',
        value: { owner: GRACE },
      },
    ])
    expect(durable.cursors.map((row) => row.principal)).toEqual([GRACE])
    expect(durable.outbox.map((row) => row.principal)).toEqual([GRACE])
  })
})
