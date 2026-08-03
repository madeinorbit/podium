/**
 * KILL BETWEEN WRITES, AT EVERY BOUNDARY (ADR 6 D4.1/D4.2/D4.7, ADR 2 D10).
 *
 * ─── WHY THIS FILE EXISTS AT ALL, AND WHY INHERITING THE SUITE WAS NOT ENOUGH ─
 *
 * POD-374 applied a mutant giving each staged write its OWN transaction — the ADR 2
 * D10 non-compliance verbatim — and POD-373's conformance suite stayed GREEN, all 30
 * cases. The reason is structural, not an oversight: the suite's `failNextCommit`
 * fires BEFORE the adapter's native transaction opens, so the kernel's
 * base/crash-between-writes gate cannot observe what a durable adapter does INSIDE
 * that transaction. The gate is correct for the kernel and BLIND to the adapter.
 *
 * So `conformance.test.ts` being green is not evidence for D4.1 on SQLite. THIS file
 * is. The invariant under test is one sentence from D4.1: on crash or power loss
 * mid-operation the store recovers to either the PRE-operation or the POST-operation
 * snapshot, "never a torn mix (e.g. new cursor without entity rows it covers; outbox
 * ack without overlay clear; entity rows without a still-pending outbox entry the
 * user saw as queued)".
 *
 * ─── WHAT MAKES THIS TEST ABLE TO SAY NO ─────────────────────────────────────
 *
 *  1. THE CRASH LANDS BETWEEN WRITES THAT EXIST. Every case commits a transaction
 *     touching ALL THREE regions — an outbox removal, an entity upsert and a cursor
 *     advance — and the fault fires at a named statement index inside the live
 *     transaction. `writesIssued` is ASSERTED per case, so a case whose transaction
 *     turned out to carry fewer statements than the boundary it names FAILS instead
 *     of quietly testing an earlier boundary.
 *
 *  2. THE PRE-STATE IS DISTINGUISHABLE FROM THE POST-STATE IN EVERY REGION.
 *     `seedPreState` puts a DIFFERENT value in all three: entity E@v0 vs E@v1, cursor
 *     seq 1 vs 2, outbox holding M vs not holding it. A torn outcome is therefore a
 *     value this suite can name, and `expectPre`/`expectPost` check all three
 *     together — a check of one region alone passes on exactly the mix D4.1 forbids.
 *
 *  3. THE KILL IS REAL. `deny` leaves a live connection the adapter must roll back;
 *     `crash` POISONS the connection so `COMMIT` and the adapter's own `ROLLBACK`
 *     both throw and nothing in-process can tidy up — which is what power loss is,
 *     and what D4.7 means by process death. In both modes the assertions read the
 *     tables through a CONNECTION OF THEIR OWN (`readDurable`), so SQLite's journal
 *     recovery answers rather than the mirror the crash was supposed to destroy.
 *
 * The positive control runs first: with no fault the same transaction reaches POST in
 * all three regions. Without it, every "still PRE" assertion below could be satisfied
 * by an adapter that never writes anything at all.
 */

import { actorUser, asUserId } from '@podium/model'
import type { MutationId } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import { type DurabilityDegradation, type SqliteStoreView, SqliteSyncStore } from './store'
import { FaultySqlDatabase, freshDatabaseFile, readDurable, sqliteEngine } from './test-support'

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

describe('mobile SQLite adapter — kill between writes, at every boundary', () => {
  let file: string
  let cleanup: () => void
  let degradations: DurabilityDegradation[]
  /** The wrapper the live store is writing through — one per `open()`. */
  let faulty: FaultySqlDatabase

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
      openDatabase: () => {
        faulty = new FaultySqlDatabase(sqliteEngine.open(file))
        return faulty
      },
      deleteDatabase: () => {
        throw new Error('these cases never poison the file')
      },
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
    store.close()
    expectPre()
  }

  /**
   * THE OPERATION EVERY CASE CRASHES INSIDE — one transaction over all three regions,
   * which is the only shape in which a torn mix is even expressible.
   */
  async function commitAllThree(view: SqliteStoreView, store: SqliteSyncStore): Promise<void> {
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

  const durableView = (): { entity: unknown; cursor: unknown; outbox: string[] } => {
    const rows = readDurable(file)
    return {
      entity: rows.entities.find((row) => row.entityId === 'ADA-1')?.value,
      cursor: rows.cursors.find((row) => row.principal === PRINCIPAL)?.cursor,
      outbox: rows.outbox.map((row) => row.mutationId),
    }
  }

  /** All three regions at PRE. Checked together: one region alone passes on a tear. */
  function expectPre(): void {
    expect(durableView()).toEqual({ entity: { v: 0 }, cursor: CURSOR_1, outbox: [M] })
  }

  /** All three regions at POST. */
  function expectPost(): void {
    expect(durableView()).toEqual({ entity: { v: 1 }, cursor: CURSOR_2, outbox: [] })
  }

  it('POSITIVE CONTROL — with no fault the same transaction reaches POST in all three regions', async () => {
    await seedPreState()
    const store = await open()
    await commitAllThree(store.viewFor(PRINCIPAL), store)
    store.close()
    expectPost()
  })

  /**
   * THE BOUNDARY TABLE.
   *
   * `writes` is the number of write statements the transaction issues; it is ASSERTED
   * per case rather than assumed, so a change that makes the commit carry fewer
   * statements fails these cases instead of silently collapsing them onto the same
   * instant. Three regions ⇒ three statements: the outbox delete, the entity upsert
   * and the cursor upsert. (The in-transaction precondition `SELECT` is a read and is
   * not counted — see `FaultySqlDatabase`.)
   */
  const BOUNDARIES = [
    { at: 0, mode: 'deny' as const, what: 'before the outbox removal reached the store' },
    { at: 1, mode: 'deny' as const, what: 'between the outbox removal and the entity upsert' },
    { at: 2, mode: 'deny' as const, what: 'between the entity upsert and the cursor advance' },
    { at: 2, mode: 'crash' as const, what: 'after every write was issued and before the commit' },
  ]

  for (const boundary of BOUNDARIES) {
    it(`kill ${boundary.what} leaves PRE, in every region`, async () => {
      await seedPreState()
      const store = await open()
      const before = faulty.writesIssued
      faulty.denyWriteAt({ at: boundary.at, mode: boundary.mode, error: new Error('power loss') })

      // SURFACED, not swallowed: the kernel that opened the unit of work is told.
      await expect(commitAllThree(store.viewFor(PRINCIPAL), store)).rejects.toThrow(/power loss/)

      // The transaction really did carry three write statements, so the boundary this
      // case names is the boundary it hit. `deny` refuses its target, so one fewer
      // reaches the engine; `crash` lets all three through and then kills.
      expect(faulty.writesIssued - before).toBe(boundary.mode === 'crash' ? 3 : boundary.at + 1)
      expect(faulty.denials).toBe(1)
      // A crash leaves a connection that CANNOT tidy up — the property that makes this
      // boundary unreachable by any `deny` index, asserted rather than described.
      expect(faulty.isDead).toBe(boundary.mode === 'crash')

      // THE KILL: the process's handle dies, the file does not. Releasing the handle
      // is what lets SQLite's journal roll the uncommitted transaction back — the
      // recovery a relaunched app performs.
      store.close()
      expectPre()

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
    // The client dies without ever having rendered the result, and WITHOUT any flush,
    // AppState hook or settle call (D4.7). The commit already happened, so the durable
    // snapshot is POST — the other side of D4.1's "PRE or POST" — and a reopened
    // client picks it up rather than replaying.
    store.close()
    expectPost()
    const reopened = await open()
    const view = reopened.viewFor(PRINCIPAL)
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 1 })
    expect(view.cache.readCursor()).toEqual(CURSOR_2)
    expect(await view.outbox.read()).toEqual([])
    reopened.close()
  })

  it('D4.2 — a crash never leaves the cursor AHEAD of the entity rows it covers', async () => {
    // The direction that matters. D4.2 permits data ahead of a lost cursor advance
    // (a re-pull re-applies idempotent upserts) and FORBIDS the reverse, because a
    // cursor past rows that were never written is a gap no heal will ever notice.
    for (const boundary of BOUNDARIES) {
      const fresh = freshDatabaseFile()
      file = fresh.file
      await seedPreState()
      const store = await open()
      faulty.denyWriteAt({ at: boundary.at, mode: boundary.mode, error: new Error('power loss') })
      await expect(commitAllThree(store.viewFor(PRINCIPAL), store)).rejects.toThrow()
      store.close()

      const durable = durableView()
      const cursorSeq = (durable.cursor as Cursor).seq
      const entityIsNew = JSON.stringify(durable.entity) === JSON.stringify({ v: 1 })
      expect(cursorSeq === CURSOR_2.seq && !entityIsNew).toBe(false)
      fresh.cleanup()
    }
  })

  it('a crash mid-commit is not mistaken for a quota denial — the mode stays durable', async () => {
    // The counterfactual for `quota.test.ts`: the adapter's degradation branch is
    // chosen by WHAT the engine said, not by the fact that something failed. A crash
    // that flipped the store into degraded-memory would silently stop persisting for
    // the rest of the session.
    await seedPreState()
    const store = await open()
    faulty.denyWriteAt({ at: 1, error: new Error('power loss') })
    await expect(commitAllThree(store.viewFor(PRINCIPAL), store)).rejects.toThrow(/power loss/)
    expect(degradations).toEqual([])
    expect(store.durability()).toBe('durable')

    // And the store is still usable: the SAME operation now commits. (`deny` and not
    // `crash`, because a crashed connection is meant to be unusable — proving the
    // mode did not flip needs a store that could still write if it wanted to.)
    await commitAllThree(store.viewFor(PRINCIPAL), store)
    store.close()
    expectPost()
  })
})
