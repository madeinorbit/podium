/**
 * POD-1158 — the D10 seam defect, pinned.
 *
 * ─── WHAT WAS BROKEN ─────────────────────────────────────────────────────────
 *
 * `Replica.commitRegions` opened its OWN span and committed it synchronously:
 *
 *     const span = this.store.beginSpan()
 *     write(span)                        // cache + cursor staged
 *     overlay.retire(retirements, span)  // returned void
 *     span.commit()
 *
 * `OptimisticOverlayPort.retire` returned `void`, so the only route to the real
 * Outbox was the ASYNC `retireAllApplied(ids, span)`. Its first act is a microtask
 * deferral — `Outbox.mutate` opens with `this.mutations.then(...)` and `Outbox.stage`
 * then awaits `store.read()` — so `span.join` was reached strictly AFTER the Replica
 * had already committed. Measured against the REAL Replica and the REAL Outbox, on
 * the normal path with no crash injected:
 *
 *   - the enrolment threw `cannot enrol in a span that has already settled`,
 *   - the outbox record stayed DURABLE and stuck in `applied`,
 *   - the replica cursor ADVANCED past the frame that confirmed it.
 *
 * That is the torn state ADR 2 D10 forbids, reachable by ordinary use.
 *
 * No adapter could have fixed it. `OutboxStorePort.read`/`apply` are
 * Promise-returning because IndexedDB and SQLite are asynchronous, while every
 * `SyncSpan` hook is synchronous by decision because an IndexedDB transaction
 * auto-closes on an unrelated await. A synchronous enrolment cannot reach an async
 * store; an async enrolment cannot reach a settled span.
 *
 * ─── WHAT FIXED IT ───────────────────────────────────────────────────────────
 *
 * The Replica is a PARTICIPANT, not an owner. It is handed a `SyncUnitOfWork` and
 * runs a multi-region commit inside `transact`, whose BODY is async — which is where
 * ADR 2 always allowed asynchrony — while every hook registered inside stays
 * synchronous. `commit`/`abort` remain on `OwnedSyncSpan`, held only by the unit of
 * work, and the Replica's view of its store has no `beginSpan` at all.
 *
 * ─── WHY THIS FILE IS AT THE PACKAGE ROOT ────────────────────────────────────
 *
 * Beside `span.ts`, not inside `replica/`. The seam is NEUTRAL — owned by neither
 * kernel — and a test of it must import BOTH roles, which `check-boundaries` rule 10
 * rightly forbids from inside the direction-locked `replica/` directory. The rule
 * caught the first draft of this file; the fix is the location, never an allowlist
 * entry, because a cross-hop test that had to be excused from the direction rule
 * would be evidence the direction rule was wrong.
 *
 * ─── WHY THESE TESTS ARE HERE, AND WHEN TO DELETE THEM ───────────────────────
 *
 * They assert the CORRECT properties, named after the defect, so a refactor that
 * reintroduces self-opening reds by name rather than by mystery. They should be
 * deleted only alongside the seam itself.
 */

import { actorUser, asUserId } from '@podium/model'
import type { MutationId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { Outbox } from './outbox/outbox'
import {
  InMemoryOutboxStore,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './outbox/test-doubles'
import { InMemoryReplicaStore } from './replica/memory-store'
import type { OptimisticOverlayPort, RetirementIntent } from './replica/overlay'
import type { ReplicaCacheStore, ReplicaParticipantStore, SyncSpan } from './replica/ports'
import { Replica, SyncUnitOfWorkRequiredError } from './replica/replica'
import { deltaFrame, EPOCH, FakeAuthority, FEED_ID, upsertChange } from './replica/test-support'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const ADA = asUserId('ada')

const command = { name: 'issues.close', version: 1, delivery: 'offline-eligible' } as const
const attribution = { actor: actorUser(ADA), onBehalfOf: ADA } as const

/**
 * The REAL Outbox wired to the REAL Replica through the seam — no double on either
 * side. This is the pairing the defect lived in, and the only configuration that can
 * see it.
 */
async function wired(): Promise<{
  replica: Replica
  outbox: Outbox
  store: InMemoryReplicaStore
  outboxStore: InMemoryOutboxStore
  enrolments: (SyncSpan | undefined)[]
  enqueue(entityId: string): Promise<MutationId>
}> {
  const store = new InMemoryReplicaStore()
  const outboxStore = new InMemoryOutboxStore()
  const clock = new ManualClock()
  const outbox = await Outbox.open({
    store: outboxStore,
    submit: new ScriptedAuthority(() => ({ kind: 'applied' })),
    principal: ADA,
    now: clock.now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds(),
    onStoreUnreadable: (error) => {
      throw error
    },
  })
  /** Which span each retirement was handed. `undefined` here would BE the defect. */
  const enrolments: (SyncSpan | undefined)[] = []

  const overlay: OptimisticOverlayPort = {
    pending: (entity, entityId) =>
      outbox
        .pending()
        .filter((record) => record.partitionKey === `${entity}:${entityId}`)
        .map((record) => ({
          mutationId: record.mutationId,
          entity,
          entityId,
          command: record.command,
        })),
    reduce: (base) => ({ kind: 'value', value: base }),
    // ASYNC, deliberately. A synchronous double here would pass on the old seam too
    // and would therefore prove nothing about the defect this file pins.
    retire: (matches: readonly RetirementIntent[], span?: SyncSpan) => {
      enrolments.push(span)
      const ids = matches
        .map((match) => match.mutationId)
        .filter((id): id is string => id !== undefined) as MutationId[]
      return (async () => {
        for (const id of ids) {
          if (outbox.find(id)?.state === 'accepted') await outbox.noteApplied(id)
        }
        const applied = ids.filter((id) => outbox.find(id)?.state === 'applied')
        if (applied.length > 0) await outbox.retireAllApplied(applied, span)
      })()
    },
  }

  const feed = new FakeAuthority()
  feed.slice = { snapshotSeq: 0, rows: [] }
  const replica = new Replica({
    store: store.cache,
    authority: feed,
    overlay,
    unitOfWork: store.unitOfWork,
  })
  replica.connect()
  await replica.settled()

  return {
    replica,
    outbox,
    store,
    outboxStore,
    enrolments,
    enqueue: async (entityId: string) => {
      const record = await outbox.enqueue({
        command,
        input: { entityId },
        attribution,
        partitionKey: `issue:${entityId}`,
      })
      await outbox.drain()
      return record.mutationId
    },
  }
}

describe('POD-1158 — the Replica participates in a transaction it does not own', () => {
  it('an ASYNC participant ENROLS: the retirement is handed the live span, not a settled one', async () => {
    const w = await wired()
    const id = await w.enqueue('POD-1')

    w.replica.receive(
      deltaFrame(0, 1, [upsertChange(1, 'issue', 'POD-1', { closed: true }, { mutationId: id })]),
    )
    await w.replica.settled()

    // The enrolment happened AT ALL, and with a real span. Under the defect this call
    // rejected with 'cannot enrol in a span that has already settled'.
    expect(w.enrolments).toHaveLength(1)
    expect(w.enrolments[0]).toBeDefined()
    // …and it took effect: the entry is gone from durable storage, not merely from memory.
    expect(await w.outboxStore.read()).toEqual([])
    expect(w.outbox.find(id)).toBeUndefined()
    expect(w.replica.cursor?.seq).toBe(1)
  })

  it('the cursor and the retirement are INSEPARABLE: a refused commit advances neither', async () => {
    const w = await wired()
    const id = await w.enqueue('POD-1')
    const cursorBefore = w.replica.cursor
    const durableBefore = await w.outboxStore.read()
    expect(durableBefore).toHaveLength(1)

    // Refuse at the serialized commit point, after both regions have staged.
    w.store.cache.failNextPrepare = 'durable write denied'
    w.replica.receive(
      deltaFrame(0, 1, [upsertChange(1, 'issue', 'POD-1', { closed: true }, { mutationId: id })]),
    )
    // SURFACED, not swallowed. The refusal arrives on the unit of work the Replica
    // joined, which is the boundary that owns the outcome.
    await expect(w.replica.settled()).rejects.toThrow('durable write denied')

    // THE TORN STATE THE DEFECT PRODUCED, asserted absent — each half separately, so a
    // mix cannot hide inside one combined match.
    expect(w.replica.cursor).toEqual(cursorBefore)
    expect(await w.outboxStore.read()).toEqual(durableBefore)
    expect(w.outbox.find(id)?.state).toBe('applied')
    // The user's write is still the user's write. Nothing was reported as landed.
    expect(w.replica.view('issue', 'POD-1')).not.toEqual({ closed: true })
  })

  it('BOTH regions publish in ONE physical transaction, not one each', async () => {
    const w = await wired()
    const id = await w.enqueue('POD-1')
    const before = w.store.transactions
    const outboxWritesBefore = w.outboxStore.writes

    w.replica.receive(
      deltaFrame(0, 1, [upsertChange(1, 'issue', 'POD-1', { closed: true }, { mutationId: id })]),
    )
    await w.replica.settled()

    // ONE publication for the whole span (D10 clause 5), however many regions enrolled.
    expect(w.store.transactions - before).toBe(1)
    // The outbox region published exactly once, inside it — not in a second transaction
    // of its own, which is what the old seam was forced into.
    expect(w.outboxStore.writes - outboxWritesBefore).toBe(1)
  })

  it('an overlay with NO unit of work is refused at CONSTRUCTION, not silently autocommitted', () => {
    const store = new InMemoryReplicaStore()
    const feed = new FakeAuthority()
    const overlay: OptimisticOverlayPort = {
      pending: () => [],
      reduce: (base) => ({ kind: 'value', value: base }),
      retire: () => {},
    }

    // A multi-region commit with no transaction boundary is the D10 non-compliance, so
    // it is unreachable rather than merely discouraged. Construction is the right
    // moment: it fires before any frame has been accepted, so no user work is in
    // flight when it does.
    expect(() => new Replica({ store: store.cache, authority: feed, overlay })).toThrow(
      SyncUnitOfWorkRequiredError,
    )
    // POSITIVE CONTROL — the same construction WITH a unit of work succeeds, so the
    // refusal is about the missing boundary and not about the overlay being unwelcome.
    expect(
      () =>
        new Replica({
          store: store.cache,
          authority: feed,
          overlay,
          unitOfWork: store.unitOfWork,
        }),
    ).not.toThrow()
  })

  it('the SINGLE-REGION autocommit arm cannot be reached by a multi-participant commit', async () => {
    const w = await wired()
    const before = w.store.transactions
    const enrolmentsBefore = w.enrolments.length

    // A frame carrying NO provenance: nothing to retire, so exactly one region is
    // touched and D10 clause 2 permits an autocommit. This is the arm that exists.
    w.replica.receive(deltaFrame(0, 1, [upsertChange(1, 'issue', 'OTHER', { n: 1 })]))
    await w.replica.settled()
    expect(w.store.transactions - before).toBe(1)
    // …and the overlay was never handed a batch, which is WHY it was single-region.
    // The two facts are the same fact: the autocommit arm is guarded by "no
    // retirements", and no retirements means no second participant. There is no input
    // that produces a second participant AND takes this arm.
    expect(w.enrolments).toHaveLength(enrolmentsBefore)

    // COUNTERFACTUAL, same replica: add provenance and the commit leaves that arm.
    const id = await w.enqueue('POD-2')
    w.replica.receive(
      deltaFrame(1, 2, [upsertChange(2, 'issue', 'POD-2', { closed: true }, { mutationId: id })]),
    )
    await w.replica.settled()
    expect(w.enrolments.length).toBe(enrolmentsBefore + 1)
  })

  it('the Replica CANNOT settle a transaction: its store view has no way to open one', () => {
    // TYPE-LEVEL, which is the only place this can live, and the reason is worth
    // stating because the obvious runtime check is WRONG: the span object the Replica
    // is handed genuinely HAS `commit`/`abort` at run time — the unit of work holds
    // the very same object as an `OwnedSyncSpan`. What makes settlement unreachable is
    // that the Replica's declared types offer no route to it: `transact` hands the body
    // a `SyncSpan`, and its store view has no `beginSpan`. A `Object.keys` assertion
    // here would fail while the guarantee held, and would tempt somebody to "fix" it by
    // wrapping the span in a proxy that hides methods — which protects nothing.
    //
    // `@ts-expect-error` on a TYPE position, so nothing executes: dereferencing the
    // property at run time would throw for the ordinary reason and prove nothing.
    // @ts-expect-error — `beginSpan` is deliberately absent from the participant view.
    type NoBeginSpan = ReplicaParticipantStore['beginSpan']
    // THE INSTRUMENT SAYS YES: the same lookup on the FULL port compiles. Without this,
    // a typo in the property name would produce the identical expected error and the
    // assertion above would be measuring nothing.
    type HasBeginSpan = ReplicaCacheStore['beginSpan']
    const probe: { no?: NoBeginSpan; yes?: HasBeginSpan } = {}
    expect(probe.no).toBeUndefined()
    expect(probe.yes).toBeUndefined()

    // And the participant view is otherwise the SAME port: a full adapter satisfies it
    // structurally, so no adapter needs a second class and no cast is required.
    const store = new InMemoryReplicaStore()
    const full: ReplicaCacheStore = store.cache
    const narrowed: ReplicaParticipantStore = full
    expect(narrowed).toBe(full)
  })

  it('feed identity is untouched by the change: the seam carries no cause, rung or rescope', async () => {
    // The seam must never become a channel for the replica→outbox edge both roles
    // deliberately removed. Asserted on the OBSERVABLE shape rather than by reading the
    // source, so a future parameter cannot slip in unnoticed.
    const w = await wired()
    const id = await w.enqueue('POD-1')
    w.replica.receive(
      deltaFrame(0, 1, [upsertChange(1, 'issue', 'POD-1', { closed: true }, { mutationId: id })], {
        feedId: FEED_ID,
        epoch: EPOCH,
      }),
    )
    await w.replica.settled()

    const span = w.enrolments[0] as SyncSpan
    const reachable = new Set<string>()
    for (let proto: object | null = span; proto !== null; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) reachable.add(key)
    }
    // The DOMAIN vocabulary the seam must never carry. `commit`/`abort` are excluded
    // from this list on purpose and not by oversight: they exist on the concrete object
    // because its OWNER settles through it, and the previous test is where the Replica's
    // inability to reach them is asserted, at the only level that can enforce it.
    for (const forbidden of ['cause', 'rung', 'rescope', 'discardCache', 'retire', 'enqueue']) {
      expect(reachable.has(forbidden)).toBe(false)
    }
    expect(reachable.has('join')).toBe(true)
    expect(reachable.has('onCommit')).toBe(true)
  })
})
