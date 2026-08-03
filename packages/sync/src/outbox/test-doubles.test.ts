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
 * a sleep.
 *
 * WHAT THIS FILE CANNOT SAY, and where that half lives. Everything here certifies
 * the DOUBLE. A behaviour the double permits that a real transaction forbids would
 * be a false green for the whole conformance suite, and nothing in this file can
 * see it. `../conformance/store-fidelity.ts` carries the probes that survive the
 * port and runs them against the in-memory, IndexedDB and SQLite instantiations
 * alike; the concurrently-open-span probes below are the ones that do NOT survive
 * it, because a durable unit of work serializes `transact` and parking a span would
 * deadlock rather than fail.
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

  it('returns a span-less conflict as a VALUE, not a throw, and writes nothing', async () => {
    // ports.ts: a conflict is an ordinary concurrent-writer outcome the kernel
    // resolves by re-staging, so it is a result; a storage failure is a throw. The
    // two must stay distinguishable, and the store must not have half-applied.
    const store = new InMemoryOutboxStore([rec('m1', 'accepted')])
    const before = JSON.stringify(store.durable())
    expect(await store.apply(putting(rec('m1', 'sending'), 'queued'))).toEqual({
      ok: false,
      conflicts: [id('m1')],
    })
    expect(JSON.stringify(store.durable())).toBe(before)
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

/**
 * A SMALL MODEL CHECK OVER INTERLEAVINGS (POD-1130 work item 2, decided YES).
 *
 * The probes above are barrier-based, like POD-370's: each one catches the hazard
 * it aims at and nothing else, and every one of them was written by someone who
 * already knew which bug to look for. Four of POD-370's five double defects were
 * found by review rather than by a test, which is the argument for an instrument
 * that does not need the hazard named in advance.
 *
 * This is not a second name-matcher on the same class of evidence (a
 * differently-worded probe would be). It asserts a WHOLE-STATE equality — the
 * durable JSON, byte for byte, ORDER included — after EVERY step of a randomly
 * generated schedule, against an oracle folded independently. Every one of the
 * five findings shows up as an inequality here without being described: a
 * concurrent row deleted by a rollback, a dirty read, a reordered record, an
 * absorbed write, and a commit that should have refused.
 *
 * Reproducible on purpose: a seeded LCG, and every step awaited to completion, so
 * a failure prints a seed you can replay rather than a race you cannot. The oracle
 * restates the port's two documented rules (`ports.ts`: what a precondition means,
 * and that a first put appends while a replacing put keeps its position) in a
 * different spelling from the double's; it does not share code with it.
 */
describe('InMemoryOutboxStore against a model, over generated interleavings', () => {
  const held = (records: readonly OutboxRecord[], name: string): OutboxRecord | undefined =>
    records.find((r) => r.mutationId === id(name))

  /** ports.ts: an expectation that does not hold is a conflict. */
  const conflictsOf = (m: OutboxStoreMutation, records: readonly OutboxRecord[]): string[] =>
    m.expect
      .filter(({ mutationId, expect: want }) => {
        const found = held(records, mutationId)
        return want === 'absent' ? found !== undefined : found?.state !== want
      })
      .map((e) => String(e.mutationId))

  /** ports.ts: a first put APPENDS, a replacing put keeps its position, remove
   *  deletes by id, and anything unmentioned is untouched. */
  const fold = (
    records: readonly OutboxRecord[],
    m: OutboxStoreMutation,
  ): readonly OutboxRecord[] => {
    const removed = new Set<string>((m.remove ?? []).map(String))
    let next = records.filter((r) => !removed.has(String(r.mutationId)))
    for (const record of m.put ?? []) {
      const at = next.findIndex((r) => r.mutationId === record.mutationId)
      next = at === -1 ? [...next, record] : next.map((r, i) => (i === at ? record : r))
    }
    return next
  }

  const NEXT: Record<OutboxState, OutboxState> = {
    queued: 'sending',
    sending: 'accepted',
    accepted: 'queued',
    applied: 'queued',
    rejected: 'queued',
    expired: 'queued',
    'dead-letter': 'queued',
    cancelled: 'queued',
  }

  const NAMES = ['a', 'b', 'c'] as const

  /**
   * What the generated schedules ACTUALLY reached, accumulated across seeds and
   * pinned by the last test in this block.
   *
   * A model check whose schedules never produce a refused commit or an abort taken
   * while another span is open is green for the same reason a broken counter reads
   * zero. These counters are what make its green mean something, and they are also
   * what stops the coverage SHRINKING silently the next time the generator or the
   * seed list is touched — "12 passed" reads identically either way.
   */
  const reached = {
    commitsAccepted: 0,
    commitsRefused: 0,
    abortsWithAPeerSpanOpen: 0,
    spanlessWrites: 0,
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => s * 7919))(
    'durable state matches the model after every step (seed %i)',
    async (seed) => {
      let bits = seed >>> 0
      const rnd = (): number => {
        bits = (Math.imul(bits, 1664525) + 1013904223) >>> 0
        return bits / 2 ** 32
      }
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T

      const store = new InMemoryOutboxStore()
      /** The oracle. Only SUCCESSFUL publishes move it. */
      let model: readonly OutboxRecord[] = []
      const open_: (OpenSpan | undefined)[] = [undefined, undefined, undefined]
      /** What each open span has staged, so its view and its commit are predictable. */
      const staged: OutboxStoreMutation[][] = [[], [], []]
      let marker = 0

      /** A mutation generated against `view`, so it is valid WHEN STAGED. Whether it
       *  is still valid at COMMIT is the thing under test. */
      const generate = (view: readonly OutboxRecord[]): OutboxStoreMutation => {
        const name = pick(NAMES)
        const current = held(view, name)
        if (current && rnd() < 0.35) return removing(name, current.state)
        marker += 1
        const state = current ? (NEXT[current.state] as OutboxState) : 'queued'
        return putting(rec(name, state, `k${marker}`), current ? current.state : 'absent')
      }

      const agrees = (where: string): void => {
        expect(JSON.stringify(store.durable()), where).toBe(JSON.stringify(model))
      }

      for (let step = 0; step < 24; step += 1) {
        const slot = Math.floor(rnd() * open_.length)
        const opened = open_[slot]
        const roll = rnd()

        if (!opened) {
          if (roll < 0.45) {
            open_[slot] = await open(new InMemoryUnitOfWork())
            staged[slot] = []
          } else {
            // A span-less write: its own transaction, durable immediately, and it
            // must never be absorbed into anybody's open span.
            const mutation = generate(model)
            const expected = conflictsOf(mutation, model)
            const result = await store.apply(mutation)
            // A span-less write is generated against CURRENT truth, so it always
            // holds; the refusal path for one is a case probe above, not a class the
            // generator can reach.
            reached.spanlessWrites += 1
            expect(expected).toEqual([])
            expect(result).toEqual({ ok: true })
            model = fold(model, mutation)
          }
          agrees(`seed ${seed} step ${step} (no span in slot ${slot})`)
          continue
        }

        if (roll < 0.5) {
          // Stage. Generated against the span's OWN view: live truth plus its
          // pending mutations, which is the only view it is allowed to have.
          const view = (staged[slot] ?? []).reduce(fold, model)
          const mutation = generate(view)
          expect(await store.apply(mutation, opened.span)).toEqual({ ok: true })
          staged[slot]?.push(mutation)
        } else if (roll < 0.8) {
          // Commit. Predict it: every staged mutation is re-validated against
          // CURRENT truth in order, and the whole span refuses on the first failure.
          let next = model
          let refused: string[] | undefined
          for (const mutation of staged[slot] ?? []) {
            const bad = conflictsOf(mutation, next)
            if (bad.length > 0) {
              refused = bad
              break
            }
            next = fold(next, mutation)
          }
          const error = await opened.commit().then(
            () => undefined,
            (e: unknown) => e,
          )
          if (refused === undefined) {
            reached.commitsAccepted += 1
            expect(error, `seed ${seed} step ${step}`).toBeUndefined()
            model = next
          } else {
            reached.commitsRefused += 1
            expect(error, `seed ${seed} step ${step}`).toBeInstanceOf(SyncCommitConflict)
            expect((error as SyncCommitConflict).conflicts).toEqual(refused)
          }
          open_[slot] = undefined
          staged[slot] = []
        } else {
          // Abort. Nothing this span staged may reach the store, and nothing anyone
          // else committed may leave it.
          if (open_.some((other, i) => other !== undefined && i !== slot)) {
            reached.abortsWithAPeerSpanOpen += 1
          }
          expect(await opened.abort()).toBe(ABORTED)
          open_[slot] = undefined
          staged[slot] = []
        }
        agrees(`seed ${seed} step ${step} (slot ${slot})`)
      }

      // Drain, so a schedule never ends with work the assertions never settled.
      for (const opened of open_) if (opened) await opened.abort()
      agrees(`seed ${seed} final`)
    },
  )

  it('exercised every interleaving class it claims to (runs last)', () => {
    // Lower bounds, not exact counts: the point is that none of these is ZERO, which
    // is what a schedule generator degrades to silently. Raise them only alongside a
    // measurement; never lower one to make a red go away.
    // Measured on the seed list as committed: 33 / 5 / 15 / 93.
    expect(reached.commitsAccepted).toBeGreaterThanOrEqual(20)
    expect(reached.commitsRefused).toBeGreaterThanOrEqual(3)
    expect(reached.abortsWithAPeerSpanOpen).toBeGreaterThanOrEqual(8)
    expect(reached.spanlessWrites).toBeGreaterThanOrEqual(40)
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
