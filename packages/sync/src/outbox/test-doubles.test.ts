import { actorUser, asUserId, type MutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { OutboxStoreMutation, SyncSpan } from './ports'
import { SyncCommitConflict } from './ports'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from './records'
import type { OutboxState } from './states'
import { InMemoryOutboxStore, InMemoryUnitOfWork } from './test-doubles'

/**
 * ADVERSARIAL PROBES AGAINST THE DOUBLES THEMSELVES (POD-1130).
 *
 * `outbox.test.ts` drives the kernel and uses these doubles as scenery. This file
 * points at the scenery. The reason is measured, not theoretical: across POD-370's
 * review sequence FIVE of the eight findings were in the doubles and none of them
 * was in the kernel —
 *
 *   1. snapshot-restore rollback deleting a CONCURRENT transaction's committed row;
 *   2. per-key undo permitting a DIRTY READ;
 *   3. …and reordering records on abort, which D12's FIFO depends on;
 *   4. an ambient current-span join absorbing an unrelated caller's write;
 *   5. a generic `Error` where a typed commit conflict was needed.
 *
 * Every probe below is the shape of one of those. They run directly against
 * `InMemoryOutboxStore` / `InMemoryUnitOfWork` with hand-built mutations, because a
 * defect in a double is invisible from a test whose subject is the kernel: the
 * kernel simply reports what the double told it.
 *
 * The interleavings are DETERMINISTIC — a body parked on a gate we resolve, never
 * a sleep. POD-373's conformance suite is parameterised by instantiation, so
 * anything asserted here is a claim about what a real IndexedDB/SQLite adapter owes
 * too; see `docs/design/outbox-fake-vs-real-adapter.md` for the divergences
 * POD-374/375 must close, which THIS file cannot observe.
 */

const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }
const ADA: OutboxAttribution = {
  actor: actorUser(asUserId('u-ada')),
  onBehalfOf: asUserId('u-ada'),
}

const id = (s: string): MutationId => s as MutationId

/** A durable record. `mark` distinguishes two writes of the SAME id, so a probe can
 *  say WHICH writer won rather than only that somebody did. */
const rec = (name: string, state: OutboxState = 'queued', mark = 'a'): OutboxRecord => ({
  mutationId: id(name),
  command: CLOSE,
  input: { name, mark },
  partitionKey: `p-${name}`,
  attribution: ADA,
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

const putting = (record: OutboxRecord, expect: OutboxState | 'absent'): OutboxStoreMutation => ({
  put: [record],
  expect: [{ mutationId: record.mutationId, expect }],
})

const removing = (name: string, expect: OutboxState | 'absent'): OutboxStoreMutation => ({
  remove: [id(name)],
  expect: [{ mutationId: id(name), expect }],
})

const ids = (records: readonly OutboxRecord[]): string[] => records.map((r) => r.mutationId)

/** Let queued microtasks drain. Not a sleep: there is no real work to wait on, only
 *  a scheduling barrier, so this cannot flake under load the way `setTimeout` can. */
const flush = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

/**
 * A transaction parked mid-body, so a probe controls exactly when it settles.
 *
 * `commit()` resolves the body and the unit of work commits; `abort()` throws
 * inside the body, which is the normal error path.
 */
interface OpenSpan {
  readonly span: SyncSpan
  readonly commit: () => Promise<void>
  readonly abort: () => Promise<unknown>
}

const ABORTED = new Error('probe abort')

async function open(uow: InMemoryUnitOfWork): Promise<OpenSpan> {
  let release!: () => void
  let reject!: (error: unknown) => void
  let span: SyncSpan | undefined
  const gate = new Promise<void>((resolve, rejectGate) => {
    release = resolve
    reject = rejectGate
  })
  const run = uow.transact(async (opened) => {
    span = opened
    await gate
  })
  // Swallow here; the probe awaits the settled outcome through commit()/abort().
  const settled = run.then(
    () => undefined,
    (error: unknown) => error,
  )
  await flush()
  if (!span) throw new Error('span never opened')
  return {
    span,
    commit: async () => {
      release()
      const outcome = await settled
      if (outcome !== undefined) throw outcome
    },
    abort: async () => {
      reject(ABORTED)
      return await settled
    },
  }
}

describe('InMemoryOutboxStore under concurrent spans', () => {
  it('publishes N concurrent spans in commit order, losing none', async () => {
    const store = new InMemoryOutboxStore()
    // One unit of work per span: a single one SERIALIZES, so N concurrent spans over
    // one physical store means N instances — which is also the real configuration
    // (two principal-bound instances, or two browser tabs, over one database).
    const spans = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const opened = await open(new InMemoryUnitOfWork())
        await store.apply(putting(rec(`m${i}`), 'absent'), opened.span)
        return opened
      }),
    )
    const published: string[] = []
    spans.forEach((opened, i) => {
      opened.span.onCommit(() => published.push(`m${i}`))
    })
    // Commit in an order that is NOT the staging order, so "durable order equals
    // commit order" is distinguishable from "durable order equals staging order".
    const order = [3, 0, 7, 1, 6, 2, 5, 4]
    for (const i of order) await spans[i]?.commit()

    expect(published).toEqual(order.map((i) => `m${i}`))
    expect(ids(store.durable())).toEqual(published)
  })

  it('refuses the second claimant of one id at COMMIT, with a typed conflict', async () => {
    const store = new InMemoryOutboxStore()
    const first = await open(new InMemoryUnitOfWork())
    const second = await open(new InMemoryUnitOfWork())

    // Both stage against a store where `m1` is absent, and both are told yes: the
    // stage is a transaction-local decision and neither can see the other.
    expect(await store.apply(putting(rec('m1', 'queued', 'first'), 'absent'), first.span)).toEqual({
      ok: true,
    })
    expect(await store.apply(putting(rec('m1', 'queued', 'second'), 'absent'), second.span)).toEqual(
      { ok: true },
    )

    await first.commit()
    // …and exactly one of them lands. The loser learns at COMMIT, which is the only
    // point at which the store can know.
    const error = await second.commit().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SyncCommitConflict)
    expect((error as SyncCommitConflict).conflicts).toEqual(['m1'])
    expect(store.durable()).toHaveLength(1)
    expect((store.durable()[0]?.input as { mark: string }).mark).toBe('first')
  })

  it('a stale precondition is refused at commit as SyncCommitConflict naming the record', async () => {
    const store = new InMemoryOutboxStore([rec('m1', 'queued')])
    const opened = await open(new InMemoryUnitOfWork())
    // Staged while `m1` really was `queued`.
    expect(await store.apply(putting(rec('m1', 'sending'), 'queued'), opened.span)).toEqual({
      ok: true,
    })
    // Truth moves underneath it.
    expect(await store.apply(putting(rec('m1', 'accepted'), 'queued'))).toEqual({ ok: true })

    const before = JSON.stringify(store.durable())
    const error = await opened.commit().then(
      () => undefined,
      (e: unknown) => e,
    )

    // A GENERIC Error here was finding #5: a conflict is an ordinary
    // concurrent-writer outcome participants resolve by re-staging, and it has to be
    // distinguishable from a storage failure.
    expect(error).toBeInstanceOf(SyncCommitConflict)
    expect((error as SyncCommitConflict).conflicts).toEqual(['m1'])
    expect(JSON.stringify(store.durable())).toBe(before)
  })

  it("an abort cannot delete a row another span committed while it was open", async () => {
    // Finding #1, exactly: snapshot-restore rollback deleting a concurrent
    // transaction's committed row.
    const store = new InMemoryOutboxStore([rec('m1', 'queued')])
    const doomed = await open(new InMemoryUnitOfWork())
    expect(await store.apply(removing('m1', 'queued'), doomed.span)).toEqual({ ok: true })

    const winner = await open(new InMemoryUnitOfWork())
    expect(await store.apply(putting(rec('m1', 'sending'), 'queued'), winner.span)).toEqual({
      ok: true,
    })
    await winner.commit()

    const afterWinner = JSON.stringify(store.durable())
    expect(await doomed.abort()).toBe(ABORTED)
    expect(JSON.stringify(store.durable())).toBe(afterWinner)
    expect(store.durable()[0]?.state).toBe('sending')
  })

  it('leaves the store byte-identical, ORDER included, when a span aborts', async () => {
    // Finding #3: restoring a removed record by push changed durable order, and D12's
    // FIFO is expressed as record order. A set comparison cannot see this.
    const store = new InMemoryOutboxStore([rec('m1'), rec('m2'), rec('m3')])
    const before = JSON.stringify(store.durable())

    const opened = await open(new InMemoryUnitOfWork())
    await store.apply(removing('m2', 'queued'), opened.span)
    await store.apply(putting(rec('m4'), 'absent'), opened.span)
    await store.apply(putting(rec('m1', 'sending'), 'queued'), opened.span)
    expect(await opened.abort()).toBe(ABORTED)

    expect(JSON.stringify(store.durable())).toBe(before)
    expect(ids(store.durable())).toEqual(['m1', 'm2', 'm3'])
  })

  it('a replacing put keeps its position rather than moving to the end', async () => {
    const store = new InMemoryOutboxStore([rec('m1'), rec('m2'), rec('m3')])
    const opened = await open(new InMemoryUnitOfWork())
    await store.apply(putting(rec('m1', 'sending'), 'queued'), opened.span)
    await opened.commit()
    expect(ids(store.durable())).toEqual(['m1', 'm2', 'm3'])
    expect(store.durable()[0]?.state).toBe('sending')
  })

  it('does not expose a span’s staged write to any other reader (no dirty read)', async () => {
    // Finding #2. The counterfactual matters: an outsider claiming the same id with
    // `absent` must be TOLD YES, which is only observable because the outsider exists.
    const store = new InMemoryOutboxStore()
    const opened = await open(new InMemoryUnitOfWork())
    await store.apply(putting(rec('m9', 'queued', 'staged'), 'absent'), opened.span)
    expect(await store.read()).toEqual([])
    // The SECOND and later applies take a different branch inside the store — the
    // one that folds the span's own pending mutations — so the invisibility has to
    // be asserted again after it. A mutation-test survivor found this exact hole.
    await store.apply(putting(rec('m8', 'queued', 'staged'), 'absent'), opened.span)
    expect(await store.read()).toEqual([])
    await store.apply(removing('m8', 'queued'), opened.span)

    expect(await store.read()).toEqual([])
    expect(store.durable()).toEqual([])
    expect(await store.apply(putting(rec('m9', 'queued', 'outsider'), 'absent'))).toEqual({
      ok: true,
    })

    const error = await opened.commit().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SyncCommitConflict)
    expect((store.durable()[0]?.input as { mark: string }).mark).toBe('outsider')
  })

  it("a span reads its OWN staged writes", async () => {
    const store = new InMemoryOutboxStore()
    const opened = await open(new InMemoryUnitOfWork())
    // Only legal if the second apply validates against the span-local view: against
    // durable truth `m1` is still absent, so `expect: 'queued'` would conflict.
    expect(await store.apply(putting(rec('m1', 'queued'), 'absent'), opened.span)).toEqual({
      ok: true,
    })
    expect(await store.apply(putting(rec('m1', 'sending'), 'queued'), opened.span)).toEqual({
      ok: true,
    })
    await opened.commit()
    expect(store.durable()).toHaveLength(1)
    expect(store.durable()[0]?.state).toBe('sending')
  })

  it('never absorbs an unrelated caller’s write into an open span', async () => {
    // Finding #4: an ambient "current span" cannot tell lexical nesting from an
    // unrelated concurrent caller. A write made with NO span must be durable
    // immediately and must survive the open span's abort.
    const store = new InMemoryOutboxStore()
    const opened = await open(new InMemoryUnitOfWork())
    await store.apply(putting(rec('inside'), 'absent'), opened.span)

    expect(await store.apply(putting(rec('outside'), 'absent'))).toEqual({ ok: true })
    expect(ids(store.durable())).toEqual(['outside'])

    expect(await opened.abort()).toBe(ABORTED)
    expect(ids(store.durable())).toEqual(['outside'])
  })

  it('drops an aborted span’s staging, so a later span may re-claim the id as absent', async () => {
    const store = new InMemoryOutboxStore()
    const first = await open(new InMemoryUnitOfWork())
    await store.apply(putting(rec('m1', 'queued', 'first'), 'absent'), first.span)
    expect(await first.abort()).toBe(ABORTED)

    const second = await open(new InMemoryUnitOfWork())
    expect(await store.apply(putting(rec('m1', 'queued', 'second'), 'absent'), second.span)).toEqual(
      { ok: true },
    )
    await second.commit()
    expect((store.durable()[0]?.input as { mark: string }).mark).toBe('second')
  })

  it('refuses a mutation that touches a record with no precondition', async () => {
    const store = new InMemoryOutboxStore()
    await expect(store.apply({ put: [rec('m1')], expect: [] })).rejects.toThrow(
      /no precondition/u,
    )
    expect(store.durable()).toEqual([])
  })

  it('publishes nothing when ONE of a span’s several mutations goes stale', async () => {
    // Atomicity across enrolled writes: a partially committed transaction is not a
    // unit of work. `m2` is the one that goes stale; `m1` and `m3` must not land.
    const store = new InMemoryOutboxStore([rec('m2', 'queued')])
    const opened = await open(new InMemoryUnitOfWork())
    await store.apply(putting(rec('m1'), 'absent'), opened.span)
    await store.apply(putting(rec('m2', 'sending'), 'queued'), opened.span)
    await store.apply(putting(rec('m3'), 'absent'), opened.span)

    await store.apply(putting(rec('m2', 'accepted'), 'queued'))
    const before = JSON.stringify(store.durable())

    const error = await opened.commit().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SyncCommitConflict)
    expect((error as SyncCommitConflict).conflicts).toEqual(['m2'])
    expect(JSON.stringify(store.durable())).toBe(before)
  })

  it('cannot be joined after it has settled', async () => {
    const store = new InMemoryOutboxStore()
    const opened = await open(new InMemoryUnitOfWork())
    await store.apply(putting(rec('m1'), 'absent'), opened.span)
    await opened.commit()
    expect(() => opened.span.onCommit(() => undefined)).toThrow(/already settled/u)
    await expect(store.apply(putting(rec('m2'), 'absent'), opened.span)).rejects.toThrow(
      /already settled/u,
    )
  })
})

describe('InMemoryUnitOfWork commit gap', () => {
  /**
   * The gap is the instrument this whole file leans on, so prove it can say YES
   * before believing anything it says NO to. With the gap on, a peer writer over the
   * same physical store lands BETWEEN the span's body and its commit; with the gap
   * off it cannot, which is exactly the blindness that hid POD-370's commit-lock
   * defect. The two configurations must therefore differ.
   */
  /**
   * How many microtask turns a peer gets between the body returning and the commit
   * publishing. A self-rescheduling counter is the whole instrument: it is exactly
   * how many chances an unrelated writer over the same store has to interleave.
   */
  const turnsBeforeCommit = async (commitGap: boolean): Promise<number> => {
    const store = new InMemoryOutboxStore()
    const uow = new InMemoryUnitOfWork()
    uow.commitGap = commitGap
    let turn = 0
    let committedAt = -1
    const spin = (): void => {
      turn += 1
      if (turn < 20) void Promise.resolve().then(spin)
    }
    await uow.transact(async (span) => {
      await store.apply(putting(rec('span'), 'absent'), span)
      span.onCommit(() => {
        committedAt = turn
      })
      void Promise.resolve().then(spin)
    })
    return committedAt
  }

  it('gives a peer writer one more turn than a synchronous commit would', async () => {
    const withGap = await turnsBeforeCommit(true)
    const without = await turnsBeforeCommit(false)
    expect(withGap).toBe(without + 1)
    // And the synchronous path leaves a turn open anyway — awaiting the body is
    // itself a hop — so the gap is a widening of a real window, not an invented one.
    expect(without).toBeGreaterThan(0)
  })

  it('is ON by default', async () => {
    expect(new InMemoryUnitOfWork().commitGap).toBe(true)
  })
})
