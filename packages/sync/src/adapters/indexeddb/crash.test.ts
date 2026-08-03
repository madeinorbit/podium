/**
 * KILL BETWEEN WRITES, AT EVERY BOUNDARY (ADR 6 D4.1/D4.2, ADR 2 D10).
 *
 * The invariant under test is one sentence from D4.1: on crash or power loss
 * mid-operation the store recovers to either the PRE-operation or the
 * POST-operation snapshot, "never a torn mix (e.g. new cursor without entity rows
 * it covers; outbox ack without overlay clear; entity rows without a still-pending
 * outbox entry the user saw as queued)".
 *
 * ─── WHAT MAKES THIS TEST ABLE TO SAY NO ─────────────────────────────────────
 *
 * Three things, each of which the shape it guards against would defeat:
 *
 *  1. THE CRASH LANDS BETWEEN WRITES THAT EXIST. Every case commits a transaction
 *     touching ALL THREE regions — an outbox removal, an entity upsert and a
 *     cursor advance — and the fault fires at a named request index inside the
 *     live transaction. `writesIssued` is asserted, so a case whose transaction
 *     turned out to carry fewer requests than the boundary it names FAILS instead
 *     of quietly testing an earlier boundary. That is the "crash between no
 *     writes" trap stated in the brief.
 *
 *  2. THE PRE-STATE IS DISTINGUISHABLE FROM THE POST-STATE IN EVERY REGION.
 *     `seedPreState` puts a DIFFERENT value in all three: entity E@v0 vs E@v1,
 *     cursor seq 1 vs 2, outbox holding M vs not holding it. A torn outcome is
 *     therefore a value this suite can name, and the `expectPre`/`expectPost`
 *     helpers check all three together — a check of one region alone would pass on
 *     exactly the mix D4.1 forbids.
 *
 *  3. THE KILL IS REAL. The store object is DISCARDED and reopened over the same
 *     `IdbFactoryLike`, and the assertions read the object stores through a
 *     connection of their own (`readDurable`). Nothing here asks the mirror what
 *     survived the death of the mirror.
 *
 * The positive control runs first: with no fault the same transaction reaches
 * POST in all three regions. Without it, every "still PRE" assertion below could
 * be satisfied by an adapter that never writes anything at all.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import type { IdbFactoryLike } from './idb'
import { CURSOR_KEY, ENTITY_STORE, META_STORE, OUTBOX_STORE, REPLICA_DB_NAME } from './schema'
import { type DurabilityDegradation, type IndexedDbStoreView, IndexedDbSyncStore } from './store'
import { FaultyIdbFactory, freshFactory, readDurable } from './test-support'

const PRINCIPAL = asUserId('ada')
const M: MutationId = 'm-1' as MutationId

const CURSOR_1: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }
const CURSOR_2: Cursor = { feedId: 'feed', epoch: 'e1', seq: 2 }

const record = (state: OutboxRecord['state']): OutboxRecord => ({
  mutationId: M,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(PRINCIPAL), onBehalfOf: PRINCIPAL },
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 1,
})

describe('IndexedDB adapter — kill between writes, at every boundary', () => {
  let factory: FaultyIdbFactory
  let degradations: DurabilityDegradation[]

  beforeEach(() => {
    factory = new FaultyIdbFactory(freshFactory())
    degradations = []
  })

  const open = async (): Promise<IndexedDbSyncStore> =>
    await IndexedDbSyncStore.open({
      factory: factory as IdbFactoryLike,
      databaseName: REPLICA_DB_NAME,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  /**
   * PRE: entity E@v0, cursor seq 1, and the user's command M durable in `applied`.
   *
   * Committed through the adapter's own multi-region path so the starting point is
   * one this store really produces, then verified against the engine directly.
   */
  async function seedPreState(): Promise<void> {
    const store = await open()
    const view = store.viewFor(PRINCIPAL)
    await store.unitOfWork.transact(async (span) => {
      const result = await view.outbox.apply(
        { put: [record('applied')], expect: [{ mutationId: M, expect: 'absent' }] },
        span,
      )
      expect(result).toEqual({ ok: true })
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issue',
              entityId: 'ADA-1',
              value: { v: 0 },
              provenance: { seq: 1 },
            },
          ],
          cursor: CURSOR_1,
        },
        span,
      )
    })
    await store.settled()
    store.close()
    await expectPre()
  }

  /**
   * THE OPERATION EVERY CASE CRASHES INSIDE — one transaction over all three
   * regions, which is the only shape in which a torn mix is even expressible.
   */
  async function commitAllThree(
    view: IndexedDbStoreView,
    store: IndexedDbSyncStore,
  ): Promise<void> {
    await store.unitOfWork.transact(async (span) => {
      await view.outbox.apply({ remove: [M], expect: [{ mutationId: M, expect: 'applied' }] }, span)
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issue',
              entityId: 'ADA-1',
              value: { v: 1 },
              provenance: { seq: 2 },
            },
          ],
          cursor: CURSOR_2,
        },
        span,
      )
    })
  }

  const durableView = async (): Promise<{
    entity: unknown
    cursor: unknown
    outbox: string[]
  }> => {
    const rows = await readDurable(factory as IdbFactoryLike)
    const entities = rows[ENTITY_STORE] as { entityId: string; value: unknown }[]
    const meta = rows[META_STORE] as { key: string; value: Cursor }[]
    const outbox = rows[OUTBOX_STORE] as { mutationId: string }[]
    return {
      entity: entities.find((row) => row.entityId === 'ADA-1')?.value,
      cursor: meta.find((row) => row.key === CURSOR_KEY)?.value,
      outbox: outbox.map((row) => row.mutationId),
    }
  }

  /** All three regions at PRE. Checked together: one region alone passes on a tear. */
  async function expectPre(): Promise<void> {
    expect(await durableView()).toEqual({ entity: { v: 0 }, cursor: CURSOR_1, outbox: [M] })
  }

  /** All three regions at POST. */
  async function expectPost(): Promise<void> {
    expect(await durableView()).toEqual({ entity: { v: 1 }, cursor: CURSOR_2, outbox: [] })
  }

  it('POSITIVE CONTROL — with no fault the same transaction reaches POST in all three regions', async () => {
    await seedPreState()
    const store = await open()
    await commitAllThree(store.viewFor(PRINCIPAL), store)
    await store.settled()
    store.close()
    await expectPost()
  })

  /**
   * THE BOUNDARY TABLE.
   *
   * `writes` is the number of write requests the transaction issues; it is
   * ASSERTED per case rather than assumed, so a change that makes the commit carry
   * fewer requests fails these cases instead of silently collapsing them onto the
   * same instant. Three regions ⇒ three requests: the outbox delete, the entity
   * put and the cursor put.
   */
  const BOUNDARIES = [
    { at: 0, mode: 'deny' as const, what: 'before the outbox removal reached the store' },
    { at: 1, mode: 'deny' as const, what: 'between the outbox removal and the entity upsert' },
    { at: 2, mode: 'deny' as const, what: 'between the entity upsert and the cursor advance' },
    { at: 2, mode: 'after' as const, what: 'after every write was issued and before the commit' },
  ]

  for (const boundary of BOUNDARIES) {
    it(`kill ${boundary.what} leaves PRE, in every region`, async () => {
      await seedPreState()
      const store = await open()
      const before = factory.writesIssued
      factory.denyWriteAt({
        at: boundary.at,
        mode: boundary.mode,
        error: new Error('power loss'),
      })

      // SURFACED, not swallowed: the kernel that opened the unit of work is told.
      await expect(commitAllThree(store.viewFor(PRINCIPAL), store)).rejects.toThrow(/power loss/)

      // The transaction really did carry three write requests, so the boundary this
      // case names is the boundary it hit. `deny` refuses its target, so one fewer
      // reaches the engine; `after` lets all three through and then kills.
      expect(factory.writesIssued - before).toBe(boundary.mode === 'after' ? 3 : boundary.at + 1)
      expect(factory.denials).toBe(1)

      // THE KILL: the store object dies, IndexedDB does not.
      store.close()
      await expectPre()

      // …and a client that comes back up reads PRE too — the mirror was never
      // published, so nothing in memory outlived the transaction that failed.
      const reopened = await open()
      const view = reopened.viewFor(PRINCIPAL)
      expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 0 })
      expect(view.cache.readCursor()).toEqual(CURSOR_1)
      expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual([M])
      reopened.close()
    })
  }

  it('kill after the durable commit but before the client reads it back leaves POST, in every region', async () => {
    await seedPreState()
    const store = await open()
    await commitAllThree(store.viewFor(PRINCIPAL), store)
    await store.settled()
    // The client dies without ever having rendered the result. The commit already
    // happened, so the durable snapshot is POST — the other side of D4.1's "PRE or
    // POST" — and a reopened client picks it up rather than replaying.
    store.close()
    await expectPost()
    const reopened = await open()
    const view = reopened.viewFor(PRINCIPAL)
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 1 })
    expect(view.cache.readCursor()).toEqual(CURSOR_2)
    expect(await view.outbox.read()).toEqual([])
    reopened.close()
  })

  it('D4.2 — a crash never leaves the cursor AHEAD of the entity rows it covers', async () => {
    // The direction that matters. D4.2 permits data ahead of a lost cursor advance
    // (re-pull re-applies idempotent upserts) and FORBIDS the reverse, because a
    // cursor past rows that were never written is a gap no heal will ever notice.
    await seedPreState()
    for (const at of [0, 1, 2]) {
      const store = await open()
      factory.denyWriteAt({ at, error: new Error('power loss') })
      await expect(commitAllThree(store.viewFor(PRINCIPAL), store)).rejects.toThrow()
      store.close()
      const durable = await durableView()
      const cursorSeq = (durable.cursor as Cursor).seq
      const entityIsNew = JSON.stringify(durable.entity) === JSON.stringify({ v: 1 })
      expect(cursorSeq === CURSOR_2.seq && !entityIsNew).toBe(false)
    }
  })

  it('a crash mid-commit is not mistaken for a quota denial — the mode stays durable', async () => {
    // The counterfactual for `quota.test.ts`: the adapter's degradation branch is
    // chosen by WHAT the engine said, not by the fact that something failed. A
    // crash that flipped the store into degraded-memory would silently stop
    // persisting for the rest of the session.
    await seedPreState()
    const store = await open()
    factory.denyWriteAt({ at: 1, error: new Error('power loss') })
    await expect(commitAllThree(store.viewFor(PRINCIPAL), store)).rejects.toThrow(/power loss/)
    expect(degradations).toEqual([])
    expect(store.durability()).toBe('durable')

    // And the store is still usable: the SAME operation now commits.
    await commitAllThree(store.viewFor(PRINCIPAL), store)
    await store.settled()
    store.close()
    await expectPost()
  })
})
