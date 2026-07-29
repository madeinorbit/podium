/**
 * Replica conformance — the FAILURE paths, not the mechanism's existence.
 *
 * Every test here delivers the thing it is named after: the out-of-order tests
 * genuinely deliver out of order, the duplicate tests genuinely re-deliver, the
 * cursor-too-old test genuinely gets told to re-bootstrap, and the reconnect test
 * genuinely disconnects between two bootstrap chunks. A suite that only proves the
 * API exists is stopped short, not done.
 *
 * The last block asserts that every row of the ADR's transition table
 * (`transition-table.ts`) was actually driven by this file. Adding a row to the
 * ADR without a test that reaches it is a failing build.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryReplicaStore } from './memory-store'
import type { OptimisticOverlayPort, PendingMutation } from './overlay'
import { Replica } from './replica'
import {
  bootstrapChunk,
  cursorAt,
  deltaFrame,
  EPOCH,
  evictChange,
  FakeAuthority,
  FEED_ID,
  removeChange,
  upsertChange,
  watermark,
} from './test-support'
import { REPLICA_TRANSITIONS } from './transition-table'
import type { ChangeEnvelope, RebootstrapCause, ReplicaEvent } from './types'

/** Union of every transition row driven by this file. Asserted for totality at the end. */
const SEEN = new Set<string>()
const live: Replica[] = []

afterEach(() => {
  for (const replica of live) for (const row of replica.trace) SEEN.add(row)
  live.length = 0
})

interface Harness {
  readonly store: InMemoryReplicaStore
  readonly authority: FakeAuthority
  readonly replica: Replica
  readonly events: ReplicaEvent[]
}

function harness(
  options: { overlay?: OptimisticOverlayPort; maxBootstrapAttempts?: number } = {},
): Harness {
  const store = new InMemoryReplicaStore()
  const authority = new FakeAuthority()
  const events: ReplicaEvent[] = []
  const replica = new Replica({
    store: store.cache,
    authority,
    overlay: options.overlay,
    maxBootstrapAttempts: options.maxBootstrapAttempts,
    onEvent: (event) => events.push(event),
  })
  live.push(replica)
  return { store, authority, replica, events }
}

/** Cold start through the real bootstrap path — the way every rung terminates. */
async function bootstrapped(
  h: Harness,
  snapshotSeq: number,
  rows: readonly ChangeEnvelope[],
): Promise<void> {
  h.authority.slice = { snapshotSeq, rows }
  h.replica.connect()
  await h.replica.settled()
}

const session = (seq: number, id: string, name: string, extra: Partial<ChangeEnvelope> = {}) =>
  upsertChange(seq, 'session', id, { name }, extra)

// ───────────────────────────────────────────────────────────────────────────────
describe('delta-first: bootstrap is the recovery path, not the normal one', () => {
  it('cold connect installs the slice and lands live at the snapshot point', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(4, 's1', 'one'), session(7, 's2', 'two')])

    expect(h.replica.posture).toBe('live')
    expect(h.replica.cursor).toEqual(cursorAt(10))
    expect(h.replica.entities()).toHaveLength(2)
    expect(h.replica.view('session', 's1')).toEqual({ name: 'one' })
  })

  it('steady state is deltas: 50 frames apply without a second bootstrap', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])

    for (let seq = 1; seq <= 50; seq += 1) {
      h.replica.receive(deltaFrame(seq - 1, seq, [session(seq, `s${seq}`, `n${seq}`)]))
    }
    await h.replica.settled()

    expect(h.authority.bootstrapCalls).toBe(1)
    expect(h.authority.changesSinceCalls).toHaveLength(0)
    expect(h.replica.cursor?.seq).toBe(50)
    expect(h.replica.stats().entityCount).toBe(50)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D13 watermarks — a suppressed range is a cursor advance, not a gap', () => {
  it('an empty certified frame advances the cursor and changes nothing else', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'one')])

    const outcome = h.replica.receive(watermark(0, 9))

    expect(outcome.rowId).toBe('D13-WATERMARK')
    expect(outcome.rung).toBe(0)
    expect(h.replica.cursor?.seq).toBe(9)
    expect(h.replica.view('session', 's1')).toEqual({ name: 'one' })
    expect(h.events.filter((e) => e.type === 'upserted')).toHaveLength(1) // the bootstrap row only
    expect(h.events.at(-1)).toEqual({ type: 'cursor', cursor: cursorAt(9), watermarkOnly: true })
  })

  it('a long watermark-only stretch stays healthy and BOUNDED — no heal, no growth', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'one')])

    for (let seq = 1; seq <= 500; seq += 1) h.replica.receive(watermark(seq - 1, seq))
    await h.replica.settled()

    const stats = h.replica.stats()
    expect(h.replica.posture).toBe('live')
    expect(h.replica.cursor?.seq).toBe(500)
    // The three ways a watermark stretch could rot the replica, each excluded:
    expect(stats.heals).toBe(0) // never enters the D7 ladder
    expect(stats.bootstraps).toBe(1) // the cold start, and nothing since
    expect(stats.bufferedFrames).toBe(0) // no accumulating buffer
    expect(stats.pendingGaps).toBe(0) // no accumulating pending-gap set
    expect(stats.entityCount).toBe(1)
    expect(stats.watermarksApplied).toBe(500)
  })

  it('a visible change after a watermark stretch stays contiguous', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])
    h.replica.receive(watermark(0, 99))

    const outcome = h.replica.receive(deltaFrame(99, 100, [session(100, 's9', 'nine')]))

    expect(outcome.rowId).toBe('D7-0-APPLY')
    expect(h.replica.cursor?.seq).toBe(100)
    expect(h.replica.view('session', 's9')).toEqual({ name: 'nine' })
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D14 the removal family — evict is not remove', () => {
  it('an evicted row disappears from the view WITHOUT being rendered as deleted', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'mine')])
    h.events.length = 0

    const outcome = h.replica.receive(deltaFrame(0, 5, [evictChange(5, 'session', 's1')]))

    expect(outcome.rowId).toBe('D14-EVICT')
    expect(h.replica.view('session', 's1')).toBeUndefined()
    expect(h.events.some((e) => e.type === 'evicted')).toBe(true)
    // The whole point: no deletion is surfaced, anywhere.
    expect(h.events.some((e) => e.type === 'removed')).toBe(false)
    expect(h.replica.exitKind('session', 's1')).toBe('evicted')
  })

  it('a removed row IS a deletion, and the two are distinguishable in the model', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 'gone', 'a'), session(0, 'unshared', 'b')])

    // Delivered in separate frames so each row's own transition is observable:
    // a frame carrying both is classified by its most alarming member.
    expect(h.replica.receive(deltaFrame(0, 5, [removeChange(5, 'session', 'gone')])).rowId).toBe(
      'D5-REMOVE',
    )
    expect(h.replica.receive(deltaFrame(5, 6, [evictChange(6, 'session', 'unshared')])).rowId).toBe(
      'D14-EVICT',
    )

    expect(h.replica.view('session', 'gone')).toBeUndefined()
    expect(h.replica.view('session', 'unshared')).toBeUndefined()
    // Same visible outcome, different model facts. This is the D5/D14.5 pair.
    expect(h.replica.exitKind('session', 'gone')).toBe('removed')
    expect(h.replica.exitKind('session', 'unshared')).toBe('evicted')
    expect(h.events.filter((e) => e.type === 'removed').map((e) => e.entityId)).toEqual(['gone'])
    expect(h.events.filter((e) => e.type === 'evicted').map((e) => e.entityId)).toEqual([
      'unshared',
    ])
  })

  it('re-admission arrives as a plain upsert whose revision has NOT moved', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'mine', { revision: 7 })])
    h.replica.receive(deltaFrame(0, 5, [evictChange(5, 'session', 's1')]))
    h.events.length = 0

    // Same revision 7: a grant does not move entity truth (D14 rejected-alternatives).
    const outcome = h.replica.receive(deltaFrame(5, 9, [session(9, 's1', 'mine', { revision: 7 })]))

    expect(outcome.rowId).toBe('D14-READMIT')
    expect(h.replica.view('session', 's1')).toEqual({ name: 'mine' })
    expect(h.replica.exitKind('session', 's1')).toBeUndefined()
    const upserted = h.events.find((e) => e.type === 'upserted')
    // POD-307 needs this: a re-admitted entity must not read as newly created.
    expect(upserted).toMatchObject({ readmitted: true })
    expect(h.replica.entities()[0]?.revision).toBe(7)
  })

  it('a shared seq is well-formed: anchored per-principal rows may collide (D14.3)', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])

    const outcome = h.replica.receive(
      deltaFrame(0, 3, [
        upsertChange(3, 'issue', 'i1', { title: 'a' }),
        upsertChange(3, 'issue', 'i2', { title: 'b' }),
      ]),
    )

    expect(outcome.rowId).toBe('D7-0-APPLY')
    expect(h.replica.stats().entityCount).toBe(2)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D7 rung 1 — gaps, genuine out-of-order delivery, and duplicates', () => {
  it('a hole is not applied: the cursor never certifies data that never arrived', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.authority.changesSinceQueue = [deltaFrame(10, 14, [session(12, 's1', 'healed')])]

    const outcome = h.replica.receive(deltaFrame(13, 14, [session(14, 's2', 'late')]))

    expect(outcome.rowId).toBe('D7-1-GAP')
    expect(outcome.rung).toBe(1)
    expect(h.replica.cursor?.seq).toBe(10) // NOT advanced
    await h.replica.settled()
    expect(h.authority.changesSinceCalls).toEqual([cursorAt(10)])
    expect(h.replica.cursor?.seq).toBe(14)
    expect(h.replica.view('session', 's1')).toEqual({ name: 'healed' })
  })

  it('frames delivered genuinely out of order converge', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    // The heal reply covers only up to 12; the buffered later frame finishes the job.
    h.authority.changesSinceQueue = [
      deltaFrame(10, 12, [session(11, 'a', 'A'), session(12, 'b', 'B')]),
    ]

    // Deliver 12→14 BEFORE 10→12 exists. This is the real reordering.
    h.replica.receive(deltaFrame(12, 14, [session(13, 'c', 'C')]))
    await h.replica.settled()

    expect(h.replica.posture).toBe('live')
    expect(h.replica.cursor?.seq).toBe(14)
    expect(h.replica.view('session', 'a')).toEqual({ name: 'A' })
    expect(h.replica.view('session', 'c')).toEqual({ name: 'C' })
    expect(h.replica.stats().bufferedFrames).toBe(0)
  })

  it('a re-delivered frame is IGNORED — not read as a gap, not healed', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])
    const frame = deltaFrame(0, 3, [session(3, 's1', 'one')])
    h.replica.receive(frame)
    const transactionsAfterFirst = h.store.transactions

    const outcome = h.replica.receive(frame)
    await h.replica.settled()

    expect(outcome.rowId).toBe('D13-DUPLICATE')
    expect(h.replica.cursor?.seq).toBe(3)
    expect(h.store.transactions).toBe(transactionsAfterFirst) // nothing re-applied
    expect(h.authority.changesSinceCalls).toHaveLength(0) // and no heal loop
    expect(h.replica.stats().heals).toBe(0)
  })

  it('a partially overlapping frame applies only its uncovered tail', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])
    h.replica.receive(deltaFrame(0, 3, [session(3, 's1', 'first')]))

    // (1, 6] overlaps what we already hold through 3.
    const outcome = h.replica.receive(
      deltaFrame(1, 6, [session(3, 's1', 'STALE-REPLAY'), session(6, 's2', 'tail')]),
    )

    expect(outcome.rowId).toBe('D13-OVERLAP')
    expect(h.replica.cursor?.seq).toBe(6)
    expect(h.replica.view('session', 's2')).toEqual({ name: 'tail' })
    // The already-covered row was not re-applied — it would have overwritten nothing
    // here, but re-applying is how a truncation bug hides.
    expect(h.replica.view('session', 's1')).toEqual({ name: 'first' })
  })

  it('cursor too old to resume from: the heal reply says re-bootstrap (rung 2)', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(1, 'old', 'x')])
    h.authority.changesSinceQueue = [
      { kind: 'bootstrap-required', reason: 'below minAvailableSeq' },
    ]
    h.authority.slice = { snapshotSeq: 900, rows: [session(800, 'fresh', 'y')] }

    h.replica.receive(deltaFrame(500, 501, [session(501, 'z', 'z')]))
    await h.replica.settled()

    expect(h.replica.trace).toContain('D7-2-COMPACTED')
    expect(h.authority.bootstrapCalls).toBe(2)
    expect(h.replica.cursor?.seq).toBe(900)
    expect(h.replica.view('session', 'old')).toBeUndefined() // the cache WAS discarded
    expect(h.replica.view('session', 'fresh')).toEqual({ name: 'y' })
  })

  it('a non-contiguous heal reply escalates to rung 3 instead of retrying forever', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    // Reply does not start at our cursor: the exact silent-divergence class
    // parseChangesSinceResult was written for.
    h.authority.changesSinceQueue = [deltaFrame(11, 14, [session(12, 's', 'x')])]
    h.authority.slice = { snapshotSeq: 20, rows: [] }

    h.replica.receive(deltaFrame(13, 14, [session(14, 's2', 'y')]))
    await h.replica.settled()

    expect(h.replica.trace).toContain('D7-3-REPLY-MALFORMED')
    expect(h.authority.bootstrapCalls).toBe(2)
    expect(h.replica.cursor?.seq).toBe(20)
  })

  it('a heal reply from another epoch is rung 4, not rung 1', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.authority.changesSinceQueue = [deltaFrame(10, 12, [], { epoch: 'epoch-2' })]
    h.authority.slice = { snapshotSeq: 30, rows: [] }

    h.replica.receive(deltaFrame(13, 14, [session(14, 's', 'x')]))
    await h.replica.settled()

    expect(h.replica.trace).toContain('D7-4-EPOCH')
    expect(h.replica.cursor?.seq).toBe(30)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D7 rung 3 — semantic validation is protocol law', () => {
  const malformed: [string, ReturnType<typeof deltaFrame>][] = [
    ['change below the covered range', deltaFrame(10, 14, [session(9, 's', 'x')])],
    ['change above the covered range', deltaFrame(10, 14, [session(15, 's', 'x')])],
    ['decreasing seq', deltaFrame(10, 14, [session(13, 'a', 'x'), session(12, 'b', 'y')])],
    [
      'upsert without payload',
      deltaFrame(10, 14, [{ seq: 11, entity: 's', entityId: 'i', op: 'upsert' }]),
    ],
    [
      'evict carrying a payload',
      deltaFrame(10, 14, [{ seq: 11, entity: 's', entityId: 'i', op: 'evict', payload: {} }]),
    ],
    [
      'remove carrying a payload',
      deltaFrame(10, 14, [{ seq: 11, entity: 's', entityId: 'i', op: 'remove', payload: {} }]),
    ],
    ['inverted covered range', deltaFrame(14, 10, [])],
    ['changes inside an empty range', deltaFrame(10, 10, [session(10, 's', 'x')])],
    ['empty entity id', deltaFrame(10, 14, [session(11, '', 'x')])],
  ]

  for (const [name, frame] of malformed) {
    it(`rejects and re-bootstraps: ${name}`, async () => {
      const h = harness()
      await bootstrapped(h, 10, [session(1, 'keep', 'v')])
      h.authority.slice = { snapshotSeq: 40, rows: [session(20, 'fresh', 'w')] }

      const outcome = h.replica.receive(frame)

      expect(outcome.rowId).toBe('D7-3-MALFORMED')
      expect(outcome.rung).toBe(3)
      await h.replica.settled()
      expect(h.replica.cursor?.seq).toBe(40)
    })
  }
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D7 rungs 2-6 — one terminal path, and THE OUTBOX SURVIVES EVERY RUNG', () => {
  /**
   * ADR 2 D7: "discard the cache, re-bootstrap, keep the outbox" — for EVERY rung.
   * Under private-by-default `rescope` makes this a normal-path event, so a
   * drop-the-outbox bug is reachable by a colleague clicking share. Proven here
   * per rung rather than assumed for one of them.
   */
  const rungs: { name: string; rung: number; drive: (h: Harness) => void }[] = [
    {
      name: 'rescope (authz — Amendment 1 D14.4)',
      rung: 2,
      drive: (h) => void h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH }),
    },
    {
      name: 'resync-required (backpressure — D9)',
      rung: 2,
      drive: (h) =>
        void h.replica.receive({ kind: 'resync-required', feedId: FEED_ID, epoch: EPOCH }),
    },
    {
      name: 'epoch mismatch (rung 4)',
      rung: 4,
      drive: (h) =>
        void h.replica.receive(deltaFrame(10, 11, [session(11, 'x', 'y')], { epoch: 'epoch-2' })),
    },
    {
      name: 'malformed frame (rung 3)',
      rung: 3,
      drive: (h) => void h.replica.receive(deltaFrame(10, 14, [session(99, 'x', 'y')])),
    },
    {
      name: 'local corruption (rung 5)',
      rung: 5,
      drive: (h) => {
        h.store.setCorrupt(true)
        const outcome = h.replica.receive(watermark(10, 11))
        h.store.setCorrupt(false)
        expect(outcome.rowId).toBe('D7-5-CORRUPT')
      },
    },
    {
      name: 'replica schema version bump (rung 6)',
      rung: 6,
      drive: (h) => void h.replica.replicaSchemaChanged(),
    },
  ]

  for (const { name, rung, drive } of rungs) {
    it(`${name} re-bootstraps and keeps the outbox intact`, async () => {
      const h = harness()
      await bootstrapped(h, 10, [session(1, 'cached', 'old')])
      h.store.outbox.enqueue({
        mutationId: 'm1',
        entity: 'session',
        entityId: 's1',
        command: { rename: 'a' },
      })
      h.store.outbox.enqueue({
        mutationId: 'm2',
        entity: 'issue',
        entityId: 'i1',
        command: { close: true },
      })
      h.authority.slice = { snapshotSeq: 77, rows: [session(70, 'fresh', 'new')] }

      drive(h)
      await h.replica.settled()

      expect(h.replica.posture).toBe('live')
      expect(h.authority.bootstrapCalls).toBe(2)
      // The cache went; the queued user work did not.
      expect(h.replica.view('session', 'cached')).toBeUndefined()
      expect(h.replica.view('session', 'fresh')).toEqual({ name: 'new' })
      expect(h.store.outbox.list().map((e) => e.mutationId)).toEqual(['m1', 'm2'])
      expect(h.replica.cursor?.seq).toBe(77)
      expect(rung).toBeGreaterThan(1)
    })
  }

  it('rescope is legal while offline, and still keeps the outbox', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(1, 'cached', 'old')])
    h.store.outbox.enqueue({ mutationId: 'm1', entity: 'session', entityId: 's1', command: {} })
    h.replica.disconnect()
    h.authority.slice = { snapshotSeq: 88, rows: [] }

    const outcome = h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()

    expect(outcome.rowId).toBe('D14-RESCOPE')
    expect(outcome.rung).toBe(2)
    expect(h.store.outbox.list()).toHaveLength(1)
  })

  it('rescope and resync-required stay distinguishable in telemetry', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.authority.slice = { snapshotSeq: 11, rows: [] }
    h.events.length = 0

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()
    h.authority.slice = { snapshotSeq: 12, rows: [] }
    h.replica.receive({ kind: 'resync-required', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()

    const causes = h.events
      .filter((e) => e.type === 'heal')
      .map((e) => (e as { cause: string }).cause)
    // A policy change must never read as a performance incident (D14.4).
    expect(causes).toEqual(['rescope', 'resync-required'])
  })

  it('a queued command is a request against an ENTITY, never against a feed position', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.store.outbox.enqueue({ mutationId: 'm1', entity: 'session', entityId: 's1', command: {} })
    h.authority.slice = { snapshotSeq: 99, rows: [] }

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()

    // Deciding a rescope made it moot would be the replica arbitrating.
    expect(h.store.outbox.list()).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D6/D15 scoped bootstrap — chunked, buffered, atomically installed', () => {
  it('installs exactly the slice, including per-user state rows', async () => {
    const h = harness()
    // Per-user state (ADR 1 amendment / POD-1076) is keyed (userId, entityId) and
    // is part of the principal's slice like any other row. The Replica does not
    // interpret the key — it is just another entity kind (D4 lenient parsing).
    await bootstrapped(h, 20, [
      session(1, 's1', 'shared with me'),
      upsertChange(2, 'sessionUserState', 'u-alice:s1', { readAt: 5, pinned: true }),
      upsertChange(3, 'issueUserState', 'u-alice:i1', { snoozedUntil: 99 }),
    ])

    expect(h.replica.stats().entityCount).toBe(3)
    expect(h.replica.view('sessionUserState', 'u-alice:s1')).toEqual({ readAt: 5, pinned: true })
    expect(h.replica.view('issueUserState', 'u-alice:i1')).toEqual({ snoozedUntil: 99 })
    // Nothing outside the slice leaked in: the Replica installed what it was given.
    expect(h.replica.view('session', 'someone-elses')).toBeUndefined()
  })

  it('buffers concurrent frames during the walk — watermarks and evicts included', async () => {
    const h = harness()
    await bootstrapped(h, 5, [session(1, 'stale-row', 'v')])
    const channel = h.authority.driveManually()

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(20, [session(10, 'a', 'A')], false))
    await Promise.resolve()

    // Everything that can arrive mid-walk, arrives mid-walk.
    expect(h.replica.receive(watermark(20, 21)).rowId).toBe('D6-BUFFER')
    expect(h.replica.receive(deltaFrame(21, 22, [evictChange(22, 'session', 'a')])).rowId).toBe(
      'D6-BUFFER',
    )
    expect(h.replica.receive(deltaFrame(22, 23, [session(23, 'b', 'B')])).rowId).toBe('D6-BUFFER')
    expect(h.replica.stats().bufferedFrames).toBe(3)

    channel.push(bootstrapChunk(20, [session(15, 'c', 'C')], true))
    await h.replica.settled()

    expect(h.replica.posture).toBe('live')
    expect(h.replica.cursor?.seq).toBe(23)
    // The buffered evict took effect on the freshly installed row — buffering is
    // stated over frames, so no op kind can be forgotten.
    expect(h.replica.view('session', 'a')).toBeUndefined()
    expect(h.replica.exitKind('session', 'a')).toBe('evicted')
    expect(h.replica.view('session', 'b')).toEqual({ name: 'B' })
    expect(h.replica.view('session', 'c')).toEqual({ name: 'C' })
    expect(h.replica.view('session', 'stale-row')).toBeUndefined()
    expect(h.replica.stats().bufferedFrames).toBe(0)
  })

  it('discards a buffered frame the snapshot already covers, and truncates a straddling one', async () => {
    const h = harness()
    await bootstrapped(h, 5, [])
    const channel = h.authority.driveManually()

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(30, [session(10, 'a', 'A')], false))
    await Promise.resolve()
    h.replica.receive(deltaFrame(5, 20, [session(20, 'covered', 'X')])) // wholly ≤ 30
    h.replica.receive(
      deltaFrame(25, 35, [session(28, 'also-covered', 'Y'), session(35, 'tail', 'Z')]),
    )
    channel.push(bootstrapChunk(30, [], true))
    await h.replica.settled()

    expect(h.replica.trace).toContain('D6-BUFFER-COVERED')
    expect(h.replica.trace).toContain('D6-BUFFER-STRADDLE')
    expect(h.replica.cursor?.seq).toBe(35)
    expect(h.replica.view('session', 'tail')).toEqual({ name: 'Z' })
    // Rows at or below the snapshot point come from the SNAPSHOT, not the buffer.
    expect(h.replica.view('session', 'covered')).toBeUndefined()
    expect(h.replica.view('session', 'also-covered')).toBeUndefined()
  })

  it('install is ONE transaction covering snapshot, buffered deltas and cursor', async () => {
    const h = harness()
    await bootstrapped(h, 5, [])
    const channel = h.authority.driveManually()
    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(10, [session(1, 'a', 'A')], false))
    await Promise.resolve()
    h.replica.receive(deltaFrame(10, 11, [session(11, 'b', 'B')]))
    h.replica.receive(deltaFrame(11, 12, [session(12, 'c', 'C')]))
    const before = h.store.transactions

    channel.push(bootstrapChunk(10, [], true))
    await h.replica.settled()

    expect(h.store.transactions - before).toBe(1)
    expect(h.replica.stats().entityCount).toBe(3)
  })

  it('a buffered hole is not guessed across: apply while contiguous, then heal', async () => {
    const h = harness()
    await bootstrapped(h, 5, [])
    const channel = h.authority.driveManually()
    h.authority.changesSinceQueue = [deltaFrame(11, 40, [session(40, 'healed', 'H')])]

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(10, [], false))
    await Promise.resolve()
    h.replica.receive(deltaFrame(10, 11, [session(11, 'a', 'A')]))
    h.replica.receive(deltaFrame(30, 31, [session(31, 'b', 'B')])) // a hole at 12..30
    channel.push(bootstrapChunk(10, [], true))
    await h.replica.settled()

    expect(h.replica.trace).toContain('D6-INSTALL-GAP')
    expect(h.replica.view('session', 'a')).toEqual({ name: 'A' })
    expect(h.replica.view('session', 'healed')).toEqual({ name: 'H' })
    expect(h.replica.cursor?.seq).toBe(40)
  })

  it('a failed walk restarts from scratch and there is no half-installed replica', async () => {
    const h = harness()
    h.authority.bootstrapFailures = 2
    h.authority.slice = { snapshotSeq: 12, rows: [session(3, 'a', 'A'), session(4, 'b', 'B')] }

    h.replica.connect()
    await h.replica.settled()

    expect(h.replica.trace.filter((r) => r === 'D6-RESTART')).toHaveLength(2)
    expect(h.authority.bootstrapCalls).toBe(3)
    expect(h.replica.posture).toBe('live')
    expect(h.replica.stats().entityCount).toBe(2)
  })

  it('an exhausted bootstrap keeps the last-known slice visible rather than blanking', async () => {
    const h = harness({ maxBootstrapAttempts: 2 })
    await bootstrapped(h, 5, [session(1, 'kept', 'V')])
    h.authority.slice = null
    h.authority.bootstrapFailures = 99

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()

    expect(h.replica.trace).toContain('D6-EXHAUSTED')
    expect(h.replica.posture).toBe('stale')
    expect(h.replica.isStale).toBe(true)
    // Never blank: D6's atomic swap is what makes this possible.
    expect(h.replica.view('session', 'kept')).toEqual({ name: 'V' })
    expect(h.events.some((e) => e.type === 'bootstrap-failed')).toBe(true)
  })

  it('rejects a bootstrap chunk carrying a non-upsert row (a snapshot is positive state)', async () => {
    const h = harness({ maxBootstrapAttempts: 1 })
    const channel = h.authority.driveManually()
    h.replica.connect()
    channel.push(bootstrapChunk(10, [removeChange(3, 'session', 'x')], true))
    await h.replica.settled()

    expect(h.replica.posture).toBe('cold')
    expect(h.replica.stats().entityCount).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('D7 stale-visible — disconnection is not data loss, and reconnect converges', () => {
  it('disconnect keeps the last-known slice visible and marked stale', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(1, 's1', 'v')])

    const outcome = h.replica.disconnect()

    expect(outcome.rowId).toBe('D7-STALE-VISIBLE')
    expect(h.replica.posture).toBe('stale')
    expect(h.replica.view('session', 's1')).toEqual({ name: 'v' })
    expect(h.replica.cursor?.seq).toBe(10)
  })

  it('a cold replica with nothing installed stays cold on disconnect', () => {
    const h = harness()
    const outcome = h.replica.disconnect()
    expect(outcome.rowId).toBe('D7-DISCONNECT-COLD')
    expect(h.replica.posture).toBe('cold')
  })

  it('REVOKED WHILE OFFLINE: the stale view keeps showing the row, and reconnect corrects it', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(1, 'shared', 'a colleague shared this')])
    h.replica.disconnect()

    // Documented and accepted: while offline the replica may show rows a
    // revocation has since removed. It is a stale read, of the same class as any
    // other, and it is NOT expired locally — that would be the replica arbitrating.
    expect(h.replica.view('session', 'shared')).toEqual({ name: 'a colleague shared this' })
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(6 * 60 * 60 * 1000)
      expect(h.replica.view('session', 'shared')).toEqual({ name: 'a colleague shared this' })
    } finally {
      vi.useRealTimers()
    }

    // Reconnect: resume from the cursor, and the revocation arrives as an evict.
    h.authority.changesSinceQueue = [deltaFrame(10, 14, [evictChange(14, 'session', 'shared')])]
    h.events.length = 0
    const outcome = h.replica.connect()
    await h.replica.settled()

    expect(outcome.rowId).toBe('D7-1-RESUME')
    expect(h.authority.changesSinceCalls).toEqual([cursorAt(10)]) // resumed, not re-bootstrapped
    expect(h.authority.bootstrapCalls).toBe(1)
    expect(h.replica.view('session', 'shared')).toBeUndefined()
    expect(h.replica.exitKind('session', 'shared')).toBe('evicted')
    expect(h.events.some((e) => e.type === 'removed')).toBe(false) // still not a deletion
  })

  it('reconnect converges via rescope when the authority declines to enumerate', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(1, 'shared', 'v'), session(2, 'mine', 'w')])
    h.replica.disconnect()
    h.authority.slice = { snapshotSeq: 50, rows: [session(2, 'mine', 'w')] }

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()

    expect(h.replica.view('session', 'shared')).toBeUndefined()
    expect(h.replica.view('session', 'mine')).toEqual({ name: 'w' })
    expect(h.replica.posture).toBe('live')
  })

  it('a frame arriving while stale heals from the cursor rather than applying blind', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.replica.disconnect()
    h.authority.changesSinceQueue = [deltaFrame(10, 12, [session(12, 'missed', 'M')])]

    const outcome = h.replica.receive(deltaFrame(12, 13, [session(13, 'new', 'N')]))
    await h.replica.settled()

    expect(outcome.rowId).toBe('D7-1-FRAME-WHILE-STALE')
    expect(h.replica.view('session', 'missed')).toEqual({ name: 'M' }) // the missed one
    expect(h.replica.view('session', 'new')).toEqual({ name: 'N' }) // and the buffered one
    expect(h.replica.cursor?.seq).toBe(13)
  })

  it('RECONNECT MID-APPLY: disconnecting between two chunks leaves no half-installed slice', async () => {
    const h = harness()
    await bootstrapped(h, 5, [session(1, 'original', 'O')])
    const channel = h.authority.driveManually()

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(30, [session(10, 'partial', 'P')], false))
    await Promise.resolve()
    h.replica.disconnect()
    channel.push(bootstrapChunk(30, [session(11, 'more', 'M')], true))
    await h.replica.settled()

    // The abandoned walk installed NOTHING, and the old slice is still there.
    expect(h.replica.posture).toBe('stale')
    expect(h.replica.view('session', 'partial')).toBeUndefined()
    expect(h.replica.view('session', 'original')).toEqual({ name: 'O' })
    expect(h.replica.cursor?.seq).toBe(5)

    // Reconnecting resumes cleanly.
    h.authority.manual = null
    h.authority.changesSinceQueue = [deltaFrame(5, 6, [session(6, 'after', 'A')])]
    h.replica.connect()
    await h.replica.settled()
    expect(h.replica.posture).toBe('live')
    expect(h.replica.view('session', 'after')).toEqual({ name: 'A' })
  })

  it('a transport failure during a heal parks stale instead of losing the slice', async () => {
    const h = harness()
    await bootstrapped(h, 10, [session(1, 's1', 'v')])
    h.authority.changesSinceQueue = [new Error('socket closed')]

    h.replica.receive(deltaFrame(12, 13, [session(13, 'x', 'y')]))
    await h.replica.settled()

    expect(h.replica.posture).toBe('stale')
    expect(h.replica.view('session', 's1')).toEqual({ name: 'v' })
    expect(h.replica.cursor?.seq).toBe(10)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('the replica never arbitrates', () => {
  it('applies a same-revision upsert instead of deduping it away', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'first', { revision: 3 })])

    h.replica.receive(deltaFrame(0, 4, [session(4, 's1', 'second', { revision: 3 })]))

    // Feed order is the only order. A "skip duplicate revisions" optimisation
    // would silently break D14.2 re-admission.
    expect(h.replica.view('session', 's1')).toEqual({ name: 'second' })
  })

  it('applies a LOWER revision that arrives later in the feed', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'high', { revision: 9 })])

    h.replica.receive(deltaFrame(0, 4, [session(4, 's1', 'low', { revision: 2 })]))

    // Comparing revisions to pick a winner is arbitration, and it is the
    // Authority's job. The replica applies the ordering it was given.
    expect(h.replica.view('session', 's1')).toEqual({ name: 'low' })
    expect(h.replica.entities()[0]?.revision).toBe(2)
  })

  it('keeps provenance on the envelope, never inside the payload (D8)', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])

    h.replica.receive(
      deltaFrame(0, 4, [
        session(4, 's1', 'v', { originId: 'peer-7', causationId: 'cmd-1', mutationId: 'm-1' }),
      ]),
    )

    const record = h.replica.entities()[0]
    expect(record?.provenance).toEqual({
      seq: 4,
      originId: 'peer-7',
      causationId: 'cmd-1',
      mutationId: 'm-1',
    })
    // The payload is untouched: provenance churn must never look like a content change.
    expect(record?.value).toEqual({ name: 'v' })
    expect(Object.keys(record?.value as object)).toEqual(['name'])
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('the optimistic-overlay reducer seam', () => {
  /** A FAKE reducer. The real vocabulary is POD-351's contract; this only proves the port. */
  function fakeOverlay(): OptimisticOverlayPort & { retired: unknown[]; queue: PendingMutation[] } {
    const queue: PendingMutation[] = []
    const retired: unknown[] = []
    return {
      queue,
      retired,
      pending: (entity, entityId) =>
        queue.filter((p) => p.entity === entity && p.entityId === entityId),
      reduce: (base, command) => ({ ...(base as object | undefined), ...(command as object) }),
      retire: (match) => {
        retired.push(match)
        const index = queue.findIndex((p) => p.mutationId === match.mutationId)
        if (index >= 0) queue.splice(index, 1)
      },
    }
  }

  it('projects pending commands over authoritative truth without storing the result', async () => {
    const overlay = fakeOverlay()
    const h = harness({ overlay })
    await bootstrapped(h, 0, [session(0, 's1', 'server name')])
    overlay.queue.push({
      mutationId: 'm1',
      entity: 'session',
      entityId: 's1',
      command: { name: 'typed name' },
    })

    expect(h.replica.view('session', 's1')).toEqual({ name: 'typed name' })
    // Derived, never stored twice (ADR 4 D7): the base row is untouched.
    expect(h.replica.entities()[0]?.value).toEqual({ name: 'server name' })
  })

  it('retires exactly, by envelope provenance rather than by value comparison', async () => {
    const overlay = fakeOverlay()
    const h = harness({ overlay })
    await bootstrapped(h, 0, [session(0, 's1', 'server name')])
    overlay.queue.push({
      mutationId: 'm1',
      entity: 'session',
      entityId: 's1',
      command: { name: 'typed name' },
    })

    h.replica.receive(
      deltaFrame(0, 4, [
        session(4, 's1', 'typed name', { causationId: 'cmd-1', mutationId: 'm1' }),
      ]),
    )

    expect(overlay.retired).toEqual([
      { entity: 'session', entityId: 's1', causationId: 'cmd-1', mutationId: 'm1' },
    ])
    expect(h.replica.view('session', 's1')).toEqual({ name: 'typed name' })
  })

  it('survives a rescope, because it is derived from the outbox rather than cached', async () => {
    const overlay = fakeOverlay()
    const h = harness({ overlay })
    await bootstrapped(h, 10, [session(1, 's1', 'server name')])
    overlay.queue.push({
      mutationId: 'm1',
      entity: 'session',
      entityId: 's1',
      command: { name: 'typed name' },
    })
    h.authority.slice = { snapshotSeq: 40, rows: [session(20, 's1', 'server name v2')] }

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    await h.replica.settled()

    // The cache was replaced; the user's unsent edit is still on screen.
    expect(h.replica.entities()[0]?.value).toEqual({ name: 'server name v2' })
    expect(h.replica.view('session', 's1')).toEqual({ name: 'typed name' })
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('transition-table totality', () => {
  it('every row of the ADR transition table is driven by this suite', () => {
    const declared = REPLICA_TRANSITIONS.map((row) => row.id)
    const missing = declared.filter((id) => !SEEN.has(id))
    expect(missing).toEqual([])
  })

  it('every row cites the clause that decides it, and rungs resolve downward', () => {
    for (const row of REPLICA_TRANSITIONS) {
      expect(row.adr, `${row.id} must cite its ADR clause`).not.toBe('')
      expect(row.from.length, `${row.id} must declare a source posture`).toBeGreaterThan(0)
    }
    // Rungs 2-6 all terminate at the same place — that is the whole design.
    const terminal = REPLICA_TRANSITIONS.filter((r) => r.rung !== null && r.rung >= 2)
    expect(terminal.every((r) => r.to === 'bootstrapping')).toBe(true)
    expect(terminal.length).toBeGreaterThanOrEqual(8)
  })

  it('no transition is guarded on a visibility test the replica would have to perform', () => {
    // The replica may be TOLD its rights changed (D14-RESCOPE) — it may never
    // COMPUTE who may see what. So the guard is on evaluation verbs, not on the
    // vocabulary itself. The structural version of this rule is the direction
    // lint in scripts/check-boundaries.ts, which reads the source rather than
    // the table.
    const evaluates = /may see|can see|is visible to|filter (the )?(view|slice)|check (the )?grant/i
    for (const row of REPLICA_TRANSITIONS) {
      expect(evaluates.test(row.condition), `${row.id} must not evaluate visibility`).toBe(false)
      expect(evaluates.test(row.effect), `${row.id} must not evaluate visibility`).toBe(false)
    }
  })
})

/** A rebootstrap cause exists for every terminal rung — a compile-time completeness check. */
const CAUSES: Record<RebootstrapCause, true> = {
  compacted: true,
  'resync-required': true,
  rescope: true,
  malformed: true,
  'epoch-mismatch': true,
  'local-corruption': true,
  'schema-version': true,
  'cold-start': true,
}
void CAUSES
