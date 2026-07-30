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
import { type InMemoryOutbox, InMemoryReplicaStore } from './memory-store'
import type { OptimisticOverlayPort, RetirementIntent } from './overlay'
import type { CacheOperation, KnownKindValidatorPort } from './ports'
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
import type { ChangeEnvelope, Posture, RebootstrapCause, ReplicaEvent } from './types'

/** Union of every transition row driven by this file. Asserted for totality at the end. */
const SEEN = new Set<string>()
/** Every (row, from, to) the suite actually observed. Asserted against the table. */
const OBSERVED: { rowId: string; from: Posture; to: Posture }[] = []
const live: Replica[] = []

afterEach(() => {
  // Deliberately NOT awaiting settled(): several tests park a replica mid-walk on
  // a manually-driven bootstrap channel, and awaiting one of those hangs. The
  // machine seals each transition's post-state when its posture settles, so the
  // record is already accurate without waiting.
  for (const replica of live) {
    for (const row of replica.trace) SEEN.add(row)
    OBSERVED.push(...replica.transitions)
  }
  live.length = 0
})

interface Harness {
  readonly store: InMemoryReplicaStore
  readonly authority: FakeAuthority
  readonly replica: Replica
  readonly events: ReplicaEvent[]
}

function harness(
  options: {
    /**
     * A FACTORY, not an object: the overlay under test is backed by the outbox
     * region of the very store the Replica writes through, which is the only way a
     * test can tell "the batch was handed over" from "the batch took effect".
     */
    overlay?: (store: InMemoryReplicaStore) => OptimisticOverlayPort
    validator?: KnownKindValidatorPort
    maxBootstrapAttempts?: number
  } = {},
): Harness {
  const store = new InMemoryReplicaStore()
  const authority = new FakeAuthority()
  const events: ReplicaEvent[] = []
  const replica = new Replica({
    store: store.cache,
    authority,
    overlay: options.overlay?.(store),
    validator: options.validator,
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

/** One cache operation, for the tests that drive the store port directly. */
const upsertOp = (entityId: string): CacheOperation => ({
  kind: 'upsert',
  entity: 'session',
  entityId,
  value: { name: entityId },
  provenance: { seq: 1, originId: 'o1' },
})

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

  it('a re-delivered frame is a GAP, not something to absorb (literal D13)', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])
    const frame = deltaFrame(0, 3, [session(3, 's1', 'one')])
    h.replica.receive(frame)
    h.authority.changesSinceQueue = [deltaFrame(3, 3, [])]

    const outcome = h.replica.receive(frame)
    await h.replica.settled()

    // D13.1 guarantees contiguous non-overlapping frames per connection, so a
    // re-delivery is a protocol violation. Absorbing it would remove the only
    // check that catches an authority emitting overlapping ranges.
    expect(outcome.rowId).toBe('D7-1-GAP')
    expect(h.authority.changesSinceCalls).toEqual([cursorAt(3)])
    // And it resolves — one heal, not a loop.
    expect(h.replica.posture).toBe('live')
    expect(h.replica.cursor?.seq).toBe(3)
    expect(h.replica.stats().heals).toBe(1)
  })

  it('a partially overlapping frame is a GAP too — never truncated and applied', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])
    h.replica.receive(deltaFrame(0, 3, [session(3, 's1', 'first')]))
    h.authority.changesSinceQueue = [deltaFrame(3, 6, [session(6, 's2', 'tail')])]

    const outcome = h.replica.receive(
      deltaFrame(1, 6, [session(3, 's1', 'STALE-REPLAY'), session(6, 's2', 'tail')]),
    )
    await h.replica.settled()

    expect(outcome.rowId).toBe('D7-1-GAP')
    // The stale replay never reached the store; the heal supplied the tail.
    expect(h.replica.view('session', 's1')).toEqual({ name: 'first' })
    expect(h.replica.view('session', 's2')).toEqual({ name: 'tail' })
    expect(h.replica.cursor?.seq).toBe(6)
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

  it('drops a buffered frame the snapshot covers, and HEALS rather than truncating a straddling one', async () => {
    const h = harness()
    await bootstrapped(h, 5, [])
    const channel = h.authority.driveManually()
    h.authority.changesSinceQueue = [deltaFrame(30, 35, [session(35, 'tail', 'Z')])]

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(30, [session(10, 'a', 'A')], false))
    await Promise.resolve()
    h.replica.receive(deltaFrame(5, 20, [session(20, 'covered', 'X')])) // wholly <= 30
    h.replica.receive(
      deltaFrame(25, 35, [session(28, 'also-covered', 'Y'), session(35, 'tail', 'Z')]),
    )
    channel.push(bootstrapChunk(30, [], true))
    await h.replica.settled()

    expect(h.replica.trace).toContain('D6-BUFFER-COVERED')
    // The straddling frame was NOT truncated and applied — it healed instead.
    expect(h.replica.trace).toContain('D6-INSTALL-GAP')
    expect(h.replica.cursor?.seq).toBe(35)
    expect(h.replica.view('session', 'tail')).toEqual({ name: 'Z' })
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
  /**
   * A FAKE reducer over a REAL outbox region. The reducer vocabulary is POD-351's
   * contract and the outbox state machine is POD-370's; what this proves is the
   * D10 seam between them and the Replica.
   *
   * It is backed by the store's own outbox rather than by a private array on
   * purpose: a private array can only record that `retire` was CALLED, and the
   * property under test is that a batch handed over inside a span takes effect iff
   * that span commits. `handed` is the calls; `outbox.list()` is the effect. A test
   * that conflates the two cannot fail when an abort retires everything anyway.
   */
  function overlayOver(outbox: InMemoryOutbox): OptimisticOverlayPort & {
    /** One entry per CALL, so the suite can prove batching and not merely content. */
    readonly handed: readonly RetirementIntent[][]
  } {
    return {
      handed: outbox.batches,
      pending: (entity, entityId) =>
        outbox
          .list()
          .filter((e) => e.entity === entity && e.entityId === entityId)
          .map((e) => ({
            mutationId: e.mutationId,
            entity: e.entity,
            entityId: e.entityId,
            command: e.command,
          })),
      reduce: (base, command) => ({ ...(base as object | undefined), ...(command as object) }),
      // The Replica passes the span; the outbox stages into it and publishes with it.
      retire: (matches, span) => outbox.retireBatch(matches, span),
    }
  }

  /** The wiring every test in this block uses: one physical store, both regions. */
  function overlayHarness(): Harness & {
    overlay: ReturnType<typeof overlayOver>
    outbox: InMemoryOutbox
  } {
    let captured: ReturnType<typeof overlayOver> | undefined
    const h = harness({
      overlay: (store) => {
        captured = overlayOver(store.outbox)
        return captured
      },
    })
    return { ...h, overlay: captured as ReturnType<typeof overlayOver>, outbox: h.store.outbox }
  }

  const queued = (h: { outbox: InMemoryOutbox }, mutationId: string, entityId: string) =>
    h.outbox.enqueue({ mutationId, entity: 'session', entityId, command: { name: mutationId } })

  it('projects pending commands over authoritative truth without storing the result', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [session(0, 's1', 'server name')])
    h.outbox.enqueue({
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
    const h = overlayHarness()
    await bootstrapped(h, 0, [session(0, 's1', 'server name')])
    h.outbox.enqueue({
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

    expect(h.overlay.handed).toEqual([
      [{ entity: 'session', entityId: 's1', causationId: 'cmd-1', mutationId: 'm1' }],
    ])
    expect(h.outbox.list()).toHaveLength(0)
    expect(h.replica.view('session', 's1')).toEqual({ name: 'typed name' })
  })

  it('retires on EVERY provenance-carrying op, not only upserts', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [session(0, 'gone', 'a'), session(0, 'unshared', 'b')])

    h.replica.receive(
      deltaFrame(0, 3, [
        {
          seq: 1,
          entity: 'session',
          entityId: 'gone',
          op: 'remove',
          causationId: 'cmd-del',
          mutationId: 'm-del',
        },
        {
          seq: 2,
          entity: 'session',
          entityId: 'unshared',
          op: 'evict',
          causationId: 'cmd-ev',
          mutationId: 'm-ev',
        },
        session(3, 'kept', 'c', { causationId: 'cmd-up', mutationId: 'm-up' }),
      ]),
    )

    // A delete I authored must retire its outbox entry exactly as an edit does;
    // previously only the upsert branch retired, so a tombstone caused by my own
    // command left its overlay entry pending forever.
    expect(h.overlay.handed.flat().map((r) => r.mutationId)).toEqual(['m-del', 'm-ev', 'm-up'])
  })

  // ── Multi-retirement batching: ONE ordered batch, ONE unit of work (D10) ────

  it('submits TWO retirements as ONE ordered batch in ONE transaction', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [])
    queued(h, 'm-a', 'a')
    queued(h, 'm-b', 'b')
    const before = h.store.transactions

    h.replica.receive(
      deltaFrame(0, 2, [
        session(1, 'a', 'a', { causationId: 'cmd-a', mutationId: 'm-a' }),
        session(2, 'b', 'b', { causationId: 'cmd-b', mutationId: 'm-b' }),
      ]),
    )

    // ONE call carrying BOTH, in feed order — not two calls. Per-retirement calls
    // inside a shared unit of work each stage from the same pre-commit outbox
    // snapshot, so the second resurrects the first (POD-370 reproduced this).
    expect(h.overlay.handed).toHaveLength(1)
    expect(h.overlay.handed[0]?.map((r) => r.mutationId)).toEqual(['m-a', 'm-b'])
    // BOTH are gone. Under the per-call bug the earlier one comes back here.
    expect(h.outbox.list()).toHaveLength(0)
    // The entity operations, the cursor and the retirements published ONCE
    // together, not once per participant (D10 clause 5).
    expect(h.store.transactions - before).toBe(1)
  })

  it('deduplicates two changes that carry the SAME provenance', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [])
    queued(h, 'm-a', 'a')

    // One command, two rows: legal, and anchored per-principal rows may even share
    // a seq (D14.3). Retiring twice is at best noise and at worst a second
    // retirement of an entry the first already removed.
    h.replica.receive(
      deltaFrame(0, 2, [
        session(1, 'a', 'first', { causationId: 'cmd-a', mutationId: 'm-a' }),
        session(2, 'a', 'second', { causationId: 'cmd-a', mutationId: 'm-a' }),
      ]),
    )

    expect(h.overlay.handed).toHaveLength(1)
    expect(h.overlay.handed[0]?.map((r) => r.mutationId)).toEqual(['m-a'])
  })

  it('ABORT retires nothing, applies nothing, and emits nothing', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [session(0, 'a', 'server a')])
    queued(h, 'm-a', 'a')
    queued(h, 'm-b', 'b')
    const before = h.store.transactions
    h.events.length = 0
    // Refuse at the serialized commit point, with both drafts still private.
    h.store.cache.failNextPrepare = 'durable write denied'

    expect(() =>
      h.replica.receive(
        deltaFrame(0, 2, [
          session(1, 'a', 'aborted a', { causationId: 'cmd-a', mutationId: 'm-a' }),
          session(2, 'b', 'aborted b', { causationId: 'cmd-b', mutationId: 'm-b' }),
        ]),
      ),
    ).toThrow('durable write denied')

    // The batch was HANDED OVER — and took no effect. Both commands are still the
    // user's unsent work: telling them a write landed when it did not is the worse
    // half of this bug, because the optimistic value disappears too.
    expect(h.overlay.handed).toHaveLength(1)
    expect(h.outbox.list().map((e) => e.mutationId)).toEqual(['m-a', 'm-b'])
    // Nothing published, and no cursor advance the store cannot back.
    expect(h.store.transactions - before).toBe(0)
    expect(h.replica.cursor?.seq).toBe(0)
    expect(h.replica.entities().map((r) => r.value)).toEqual([{ name: 'server a' }])
    expect(h.events).toEqual([])
  })

  it('REHYDRATES after an abort to the pre-frame state, with both commands queued', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [session(0, 'a', 'server a')])
    queued(h, 'm-a', 'a')
    queued(h, 'm-b', 'b')
    h.store.cache.failNextPrepare = 'durable write denied'
    expect(() =>
      h.replica.receive(
        deltaFrame(0, 2, [
          session(1, 'a', 'aborted a', { causationId: 'cmd-a', mutationId: 'm-a' }),
          session(2, 'b', 'aborted b', { causationId: 'cmd-b', mutationId: 'm-b' }),
        ]),
      ),
    ).toThrow()

    // A fresh Replica over the SAME physical store — the process restarted, so
    // nothing in RAM can be covering for a draft that was never published.
    const rehydrated = new Replica({
      store: h.store.cache,
      authority: h.authority,
      overlay: overlayOver(h.outbox),
    })
    live.push(rehydrated)

    expect(rehydrated.cursor?.seq).toBe(0)
    expect(rehydrated.entities().map((r) => r.value)).toEqual([{ name: 'server a' }])
    // Both optimistic values are still on screen, from the outbox, as D7 requires.
    expect(rehydrated.view('session', 'a')).toEqual({ name: 'm-a' })
    expect(rehydrated.view('session', 'b')).toEqual({ name: 'm-b' })
  })

  it('retires through the BOOTSTRAP path too, not only live and heal', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 5, [])
    queued(h, 'm-buffered', 's1')
    const channel = h.authority.driveManually()

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(10, [], false))
    await Promise.resolve()
    h.replica.receive(
      deltaFrame(10, 11, [
        session(11, 's1', 'mine', { causationId: 'cmd-1', mutationId: 'm-buffered' }),
      ]),
    )
    channel.push(bootstrapChunk(10, [], true))
    await h.replica.settled()

    // The bootstrap replay used to be a second emission path that retired nothing.
    expect(h.overlay.handed.flat().map((r) => r.mutationId)).toEqual(['m-buffered'])
    expect(h.outbox.list()).toHaveLength(0)
  })

  it('AGGREGATES retirements across every buffered frame ONE install includes', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 5, [])
    queued(h, 'm-one', 's1')
    queued(h, 'm-two', 's2')
    const channel = h.authority.driveManually()
    const before = h.store.transactions

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(10, [], false))
    await Promise.resolve()
    // TWO buffered frames, each confirming one of my commands. The install commits
    // both onto the snapshot in one transaction, so it owes ONE batch of two.
    h.replica.receive(
      deltaFrame(10, 11, [session(11, 's1', 'one', { causationId: 'cmd-1', mutationId: 'm-one' })]),
    )
    h.replica.receive(
      deltaFrame(11, 12, [session(12, 's2', 'two', { causationId: 'cmd-2', mutationId: 'm-two' })]),
    )
    channel.push(bootstrapChunk(10, [], true))
    await h.replica.settled()

    expect(h.overlay.handed).toHaveLength(1)
    expect(h.overlay.handed[0]?.map((r) => r.mutationId)).toEqual(['m-one', 'm-two'])
    expect(h.outbox.list()).toHaveLength(0)
    // Snapshot swap + both buffered frames + cursor + both retirements: ONE publish.
    expect(h.store.transactions - before).toBe(1)
  })

  it('a bootstrap install that ABORTS retires neither buffered frame', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 5, [])
    queued(h, 'm-one', 's1')
    queued(h, 'm-two', 's2')
    const channel = h.authority.driveManually()

    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(10, [session(3, 'fresh', 'new')], false))
    await Promise.resolve()
    h.replica.receive(
      deltaFrame(10, 11, [session(11, 's1', 'one', { causationId: 'cmd-1', mutationId: 'm-one' })]),
    )
    h.replica.receive(
      deltaFrame(11, 12, [session(12, 's2', 'two', { causationId: 'cmd-2', mutationId: 'm-two' })]),
    )
    h.store.cache.failNextPrepare = 'durable write denied'
    channel.push(bootstrapChunk(10, [], true))
    // The authority stops serving after the aborted install, so the restarted walk
    // runs out of attempts instead of blocking forever on a manual channel this
    // test never feeds again. What is under test is the ABORT, not the retry: the
    // point is that the replica ends up with its pre-bootstrap slice and an
    // untouched outbox however the walk finishes.
    h.authority.manual = null
    h.authority.slice = null
    await h.replica.settled()
    expect(h.replica.trace).toContain('D6-RESTART')

    // The walk restarts (D6-RESTART) rather than half-installing, and NOTHING was
    // retired: a command confirmed by a frame whose install never committed is
    // still unsent work.
    expect(h.outbox.list().map((e) => e.mutationId)).toEqual(['m-one', 'm-two'])
    expect(h.replica.entities()).toHaveLength(0)
    expect(h.replica.cursor?.seq).toBe(5)
    // Handed over exactly once, by the install that then aborted — so this asserts
    // the batch took NO effect, not that it was never built.
    expect(h.overlay.handed.flat().map((r) => r.mutationId)).toEqual(['m-one', 'm-two'])
  })

  it('a frame carrying NO provenance opens no unit of work (D10 clause 2)', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 0, [])
    const before = h.store.transactions

    // Somebody else's change. Single-region write, so it autocommits: enrolling one
    // participant in a span would add a unit of work whose commit is the write's.
    h.replica.receive(deltaFrame(0, 1, [session(1, 'theirs', 'x')]))

    expect(h.overlay.handed).toHaveLength(0)
    expect(h.store.transactions - before).toBe(1)
    expect(h.replica.view('session', 'theirs')).toEqual({ name: 'x' })
  })

  it('survives a rescope, and the DISCARD never touches the outbox at all', async () => {
    const h = overlayHarness()
    await bootstrapped(h, 10, [session(1, 's1', 'server name')])
    h.outbox.enqueue({
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
    // And the outbox was never even ASKED. A rescope carries no certified frame, so
    // it owes no retirement; an install that swept the queue "because it was
    // rebuilding anyway" is the data loss ports.ts exists to make unreachable.
    expect(h.overlay.handed).toHaveLength(0)
    expect(h.outbox.list()).toHaveLength(1)
  })

  // ── The physical store publishes once for the whole span (D10 clause 5) ────

  it('TWO PRINCIPAL-BOUND VIEWS sharing one span publish ONCE between them', () => {
    const store = new InMemoryReplicaStore()
    const mine = store.viewFor('me')
    const theirs = store.viewFor('them')
    mine.outbox.enqueue({ mutationId: 'm-mine', entity: 'session', entityId: 'a', command: {} })
    theirs.outbox.enqueue({ mutationId: 'm-theirs', entity: 'session', entityId: 'b', command: {} })
    const before = store.transactions

    // ONE logical commit across four regions: two principals' caches and two
    // principals' outboxes. Joining is explicit-span-only — each participant is in
    // because the span was handed to it, never because a transaction was ambient.
    const span = store.beginSpan()
    mine.cache.applyAtomic({ operations: [upsertOp('a')], cursor: cursorAt(1) }, span)
    theirs.cache.applyAtomic({ operations: [upsertOp('b')], cursor: cursorAt(1) }, span)
    mine.outbox.retireBatch([{ entity: 'session', entityId: 'a', mutationId: 'm-mine' }], span)
    theirs.outbox.retireBatch([{ entity: 'session', entityId: 'b', mutationId: 'm-theirs' }], span)

    // Nothing is visible before the commit: a reader looking mid-span sees the
    // pre-span state, never another principal's half-applied slice.
    expect(mine.cache.readEntities()).toHaveLength(0)
    expect(mine.outbox.list()).toHaveLength(1)

    span.commit()

    expect(mine.cache.readEntities().map((r) => r.entityId)).toEqual(['a'])
    expect(theirs.cache.readEntities().map((r) => r.entityId)).toEqual(['b'])
    expect(mine.outbox.list()).toHaveLength(0)
    expect(theirs.outbox.list()).toHaveLength(0)
    // ONE publish for the whole span, not one per participant.
    expect(store.transactions - before).toBe(1)
  })

  it('an ABORTED shared span retires NEITHER principal and applies NEITHER slice', () => {
    const store = new InMemoryReplicaStore()
    const mine = store.viewFor('me')
    const theirs = store.viewFor('them')
    mine.outbox.enqueue({ mutationId: 'm-mine', entity: 'session', entityId: 'a', command: {} })
    theirs.outbox.enqueue({ mutationId: 'm-theirs', entity: 'session', entityId: 'b', command: {} })
    const before = store.transactions

    const span = store.beginSpan()
    mine.cache.applyAtomic({ operations: [upsertOp('a')], cursor: cursorAt(1) }, span)
    theirs.cache.applyAtomic({ operations: [upsertOp('b')], cursor: cursorAt(1) }, span)
    mine.outbox.retireBatch([{ entity: 'session', entityId: 'a', mutationId: 'm-mine' }], span)
    theirs.outbox.retireBatch([{ entity: 'session', entityId: 'b', mutationId: 'm-theirs' }], span)
    span.abort()

    expect(mine.cache.readEntities()).toHaveLength(0)
    expect(theirs.cache.readEntities()).toHaveLength(0)
    expect(mine.outbox.list()).toHaveLength(1)
    expect(theirs.outbox.list()).toHaveLength(1)
    expect(store.transactions - before).toBe(0)
  })

  it('REPEATED batches in one span EXTEND the draft rather than replacing it', () => {
    const store = new InMemoryReplicaStore()
    const view = store.viewFor('me')
    view.outbox.enqueue({ mutationId: 'm1', entity: 'session', entityId: 'a', command: {} })
    view.outbox.enqueue({ mutationId: 'm2', entity: 'session', entityId: 'b', command: {} })
    view.outbox.enqueue({ mutationId: 'm3', entity: 'session', entityId: 'c', command: {} })

    const span = store.beginSpan()
    view.outbox.retireBatch([{ entity: 'session', entityId: 'a', mutationId: 'm1' }], span)
    view.outbox.retireBatch([{ entity: 'session', entityId: 'b', mutationId: 'm2' }], span)
    span.commit()

    // A second batch that restaged from the pre-commit entries would resurrect m1.
    // Same for the cache side: two applyAtomic calls in one span must compose.
    expect(view.outbox.list().map((e) => e.mutationId)).toEqual(['m3'])
  })

  it('two cache writes in one span COMPOSE in order rather than the last winning', () => {
    const store = new InMemoryReplicaStore()
    const view = store.viewFor('me')

    const span = store.beginSpan()
    view.cache.applyAtomic({ operations: [upsertOp('a')], cursor: cursorAt(1) }, span)
    view.cache.applyAtomic({ operations: [upsertOp('b')], cursor: cursorAt(2) }, span)
    span.commit()

    expect(view.cache.readEntities().map((r) => r.entityId)).toEqual(['a', 'b'])
    expect(view.cache.readCursor()?.seq).toBe(2)
  })

  it('a PUBLISHED span cannot be joined, committed or aborted again', () => {
    const store = new InMemoryReplicaStore()
    const view = store.viewFor('me')
    const span = store.beginSpan()
    view.cache.applyAtomic({ operations: [upsertOp('a')], cursor: cursorAt(1) }, span)
    span.commit()

    expect(() => span.commit()).toThrow('span already settled')
    // Loud on purpose: the drafts are live in the store, so there is nothing an
    // abort could undo. This is the one re-settle that stays an error.
    expect(() => span.abort()).toThrow('cannot abort a span that already published')
    expect(() => span.join({ publish: () => {} })).toThrow('already settled')
  })

  it('aborting a span whose commit was VETOED is a no-op, not a second failure', () => {
    const store = new InMemoryReplicaStore()
    const span = store.beginSpan()
    // Write through and veto the SAME region: `viewFor` hands out a fresh region
    // per principal, so vetoing one and writing the other vetoes nothing.
    store.cache.applyAtomic({ operations: [upsertOp('a')], cursor: cursorAt(1) }, span)
    store.cache.failNextPrepare = 'durable write denied'

    // The `commit() in try / abort() in catch` idiom is the ONLY way a caller can
    // release a span on the error path, so the abort has to survive the veto. It
    // used to throw 'span already settled' over the top, which is how the store's
    // real refusal stopped reaching the caller.
    expect(() => span.commit()).toThrow('durable write denied')
    expect(() => span.abort()).not.toThrow()

    // And the veto really did roll back: nothing published, no transaction counted.
    expect(store.cache.readCursor()).toBeNull()
    expect(store.transactions).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('feed order is the correctness property, including inside one frame', () => {
  it('remove(seq 1) then upsert(seq 2) for one entity leaves the entity PRESENT', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])

    h.replica.receive(
      deltaFrame(0, 2, [
        removeChange(1, 'session', 's1'),
        upsertChange(2, 'session', 's1', { name: 'recreated' }),
      ]),
    )

    // Grouping the frame by op kind applied the upsert first and then deleted it.
    // The store port takes ONE ordered operation list so no adapter can do that.
    expect(h.replica.view('session', 's1')).toEqual({ name: 'recreated' })
    expect(h.replica.exitKind('session', 's1')).toBeUndefined()
  })

  it('evict(seq 1) then re-admitting upsert(seq 2) in ONE frame leaves it present', async () => {
    const h = harness()
    await bootstrapped(h, 0, [session(0, 's1', 'v', { revision: 4 })])

    h.replica.receive(
      deltaFrame(0, 2, [evictChange(1, 'session', 's1'), session(2, 's1', 'v', { revision: 4 })]),
    )

    expect(h.replica.view('session', 's1')).toEqual({ name: 'v' })
    expect(h.replica.exitKind('session', 's1')).toBeUndefined()
  })

  it('upsert(seq 1) then remove(seq 2) still deletes — order cuts both ways', async () => {
    const h = harness()
    await bootstrapped(h, 0, [])

    h.replica.receive(
      deltaFrame(0, 2, [
        upsertChange(1, 'session', 's1', { name: 'brief' }),
        removeChange(2, 'session', 's1'),
      ]),
    )

    expect(h.replica.view('session', 's1')).toBeUndefined()
    expect(h.replica.exitKind('session', 's1')).toBe('removed')
  })

  it('holds order through a heal reply and through buffered bootstrap frames', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.authority.changesSinceQueue = [
      deltaFrame(10, 12, [
        removeChange(11, 'session', 'healed'),
        upsertChange(12, 'session', 'healed', { name: 'back' }),
      ]),
    ]
    // A gap drives the heal; the heal reply carries remove-then-upsert in one range.
    h.replica.receive(deltaFrame(12, 13, [session(13, 'later', 'L')]))
    await h.replica.settled()
    expect(h.replica.view('session', 'healed')).toEqual({ name: 'back' })
    expect(h.replica.view('session', 'later')).toEqual({ name: 'L' })

    // ...and through the install path's buffered frames.
    const channel = h.authority.driveManually()
    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(50, [], false))
    await Promise.resolve()
    h.replica.receive(
      deltaFrame(50, 52, [
        removeChange(51, 'session', 'buf'),
        upsertChange(52, 'session', 'buf', { name: 'survived' }),
      ]),
    )
    channel.push(bootstrapChunk(50, [], true))
    await h.replica.settled()
    expect(h.replica.view('session', 'buf')).toEqual({ name: 'survived' })
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('rung 3 is unavoidable on every route into the store', () => {
  const badEvict = deltaFrame(10, 14, [
    { seq: 11, entity: 'session', entityId: 'i', op: 'evict', payload: {} },
  ])

  it('rejects a malformed frame that arrives DURING a heal, before it is buffered', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.authority.changesSinceQueue = [deltaFrame(10, 11, [])]
    h.authority.slice = { snapshotSeq: 60, rows: [] }

    h.replica.receive(deltaFrame(30, 31, [session(31, 'x', 'y')])) // gap -> healing
    expect(h.replica.posture).toBe('healing')
    const outcome = h.replica.receive(badEvict) // arrives mid-heal
    await h.replica.settled()

    // Buffering first meant this was applied later without ever passing rung 3.
    expect(outcome.rowId).toBe('D7-3-MALFORMED')
    expect(h.replica.cursor?.seq).toBe(60)
  })

  it('rejects a malformed frame that arrives DURING a bootstrap walk', async () => {
    const h = harness()
    await bootstrapped(h, 5, [])
    const channel = h.authority.driveManually()
    h.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(30, [], false))
    await Promise.resolve()

    const outcome = h.replica.receive(badEvict)

    expect(outcome.rowId).toBe('D7-3-MALFORMED')
  })

  it('an injected validator makes known-kind schema and id-mismatch failures reachable', async () => {
    const validator = {
      knows: (entity: string) => entity === 'session',
      validate: (change: ChangeEnvelope) => {
        const payload = change.payload as { id?: string; name?: unknown } | undefined
        if (payload === undefined) return null
        if (typeof payload.name !== 'string') return 'session.name must be a string'
        // The #247-round-2 rule: an embedded id must match the envelope's.
        if (payload.id !== undefined && payload.id !== change.entityId)
          return 'embedded id mismatch'
        return null
      },
    }
    const h = harness({ validator })
    await bootstrapped(h, 10, [])
    h.authority.slice = { snapshotSeq: 99, rows: [] }

    const outcome = h.replica.receive(
      deltaFrame(10, 11, [upsertChange(11, 'session', 's1', { id: 'SOMEONE-ELSE', name: 'x' })]),
    )
    await h.replica.settled()

    expect(outcome.rowId).toBe('D7-3-MALFORMED')
    expect(h.replica.cursor?.seq).toBe(99)
  })

  it('keeps UNKNOWN kinds lenient — they apply and the cursor advances (D4)', async () => {
    const validator = {
      knows: (entity: string) => entity === 'session',
      validate: () => 'session is always invalid in this test',
    }
    const h = harness({ validator })
    await bootstrapped(h, 10, [])

    const outcome = h.replica.receive(
      deltaFrame(10, 11, [upsertChange(11, 'kindFromTheFuture', 'k1', { anything: true })]),
    )

    // Quarantining an unknown kind would be an invisible permanent gap that heals
    // to the same rows forever — the exact failure D4's leniency prevents.
    expect(outcome.rowId).toBe('D7-0-APPLY')
    expect(h.replica.cursor?.seq).toBe(11)
    expect(h.replica.view('kindFromTheFuture', 'k1')).toEqual({ anything: true })
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('the ladder always resolves downward and TERMINATES', () => {
  it('an unsatisfiable buffered frame does not loop install -> heal -> install', async () => {
    const h = harness()
    // The authority can only ever offer a snapshot at 10, and never a delta.
    h.authority.slice = { snapshotSeq: 10, rows: [] }
    h.replica.connect()
    await h.replica.settled()

    // A frame far ahead of anything the authority will serve. Re-buffering it
    // across the install kept the ladder open forever: install -> heal ->
    // "re-bootstrap" -> install -> the same frame, with no exit.
    h.replica.receive(deltaFrame(20, 21, [session(21, 'unreachable', 'U')]))
    await h.replica.settled()

    expect(h.authority.bootstrapCalls).toBeLessThanOrEqual(3)
    expect(h.replica.stats().bufferedFrames).toBe(0)
    expect(h.replica.posture).toBe('live')
    expect(h.replica.cursor?.seq).toBe(10)
  })

  it('settled() itself refuses to hide a non-terminating ladder', async () => {
    // The guard exists because a loop here presents as a hang, not a failure.
    const h = harness()
    h.authority.slice = { snapshotSeq: 1, rows: [] }
    h.replica.connect()
    await expect(h.replica.settled()).resolves.toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('rescope and resync are legal from ANY posture (D14.4 / D9)', () => {
  // The table claims these are always-legal terminal paths. A claim the suite
  // never drives is exactly the "declared transition the code may not perform"
  // the table is supposed to rule out, so each declared posture is driven here.
  const rescope = { kind: 'rescope', feedId: FEED_ID, epoch: EPOCH } as const
  const resync = { kind: 'resync-required', feedId: FEED_ID, epoch: EPOCH } as const

  it('rescope from cold', () => {
    const h = harness()
    expect(h.replica.posture).toBe('cold')
    expect(h.replica.receive(rescope).rowId).toBe('D14-RESCOPE')
  })

  it('rescope from bootstrapping, mid-walk', async () => {
    const h = harness()
    const channel = h.authority.driveManually()
    h.replica.connect()
    channel.push(bootstrapChunk(5, [], false))
    await Promise.resolve()
    expect(h.replica.posture).toBe('bootstrapping')
    expect(h.replica.receive(rescope).rowId).toBe('D14-RESCOPE')
  })

  it('rescope from healing', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.authority.changesSinceQueue = [deltaFrame(10, 11, [])]
    h.replica.receive(deltaFrame(30, 31, [session(31, 'x', 'y')]))
    expect(h.replica.posture).toBe('healing')
    expect(h.replica.receive(rescope).rowId).toBe('D14-RESCOPE')
  })

  it('rescope from stale — a rights change while offline still lands', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.replica.disconnect()
    expect(h.replica.posture).toBe('stale')
    expect(h.replica.receive(rescope).rowId).toBe('D14-RESCOPE')
  })

  it('resync-required from healing and from stale', async () => {
    const a = harness()
    await bootstrapped(a, 10, [])
    a.authority.changesSinceQueue = [deltaFrame(10, 11, [])]
    a.replica.receive(deltaFrame(30, 31, [session(31, 'x', 'y')]))
    expect(a.replica.posture).toBe('healing')
    expect(a.replica.receive(resync).rowId).toBe('D7-2-RESYNC')

    const b = harness()
    await bootstrapped(b, 10, [])
    b.replica.disconnect()
    expect(b.replica.receive(resync).rowId).toBe('D7-2-RESYNC')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('every declared ADR route is driven, not merely declared', () => {
  // These exist because the table DECLARES these source postures. A declared
  // transition nobody drives is worse than an undocumented one: POD-372 and
  // POD-373 implement against the table.
  const bad = deltaFrame(10, 14, [
    { seq: 11, entity: 'session', entityId: 'i', op: 'evict', payload: {} },
  ])
  const otherEpoch = (fromSeq: number, seq: number) =>
    deltaFrame(fromSeq, seq, [], { epoch: 'epoch-OTHER' })

  it('rung 4 fires from stale and from bootstrapping', async () => {
    const a = harness()
    await bootstrapped(a, 10, [])
    a.replica.disconnect()
    expect(a.replica.receive(otherEpoch(10, 11)).rowId).toBe('D7-4-EPOCH')

    const b = harness()
    await bootstrapped(b, 10, [])
    const channel = b.authority.driveManually()
    b.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(20, [], false))
    await Promise.resolve()
    expect(b.replica.posture).toBe('bootstrapping')
    expect(b.replica.receive(otherEpoch(10, 11)).rowId).toBe('D7-4-EPOCH')
  })

  it('rung 3 fires from stale', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    h.replica.disconnect()
    expect(h.replica.receive(bad).rowId).toBe('D7-3-MALFORMED')
  })

  it('rung 6 (schema bump) fires from cold and from stale', async () => {
    const a = harness()
    expect(a.replica.posture).toBe('cold')
    expect(a.replica.replicaSchemaChanged().rowId).toBe('D7-6-SCHEMA')

    const b = harness()
    await bootstrapped(b, 10, [])
    b.replica.disconnect()
    expect(b.replica.replicaSchemaChanged().rowId).toBe('D7-6-SCHEMA')
  })

  it('rung 5 (corruption) fires from healing and from bootstrapping', async () => {
    // The claim is about the SOURCE posture, so assert against `transitions`
    // (which records `from`) rather than `trace` (which records only that the row
    // fired). A trace-only assertion passes identically whichever posture the
    // replica was in, so it cannot distinguish these two cases at all.
    const corruptFrom = (r: Replica) =>
      r.transitions.filter((t) => t.rowId === 'D7-5-CORRUPT').map((t) => t.from)

    const a = harness()
    await bootstrapped(a, 10, [])
    a.authority.changesSinceQueue = [deltaFrame(10, 12, [session(12, 's', 'v')])]
    a.replica.receive(deltaFrame(30, 31, [session(31, 'x', 'y')]))
    expect(a.replica.posture).toBe('healing')
    a.store.setCorrupt(true)
    await a.replica.settled().catch(() => undefined)
    expect(corruptFrom(a.replica)).toEqual(['healing'])

    const b = harness()
    await bootstrapped(b, 10, [])
    const channel = b.authority.driveManually()
    b.replica.receive({ kind: 'rescope', feedId: FEED_ID, epoch: EPOCH })
    channel.push(bootstrapChunk(20, [], false))
    await Promise.resolve()
    b.store.setCorrupt(true)
    channel.push(bootstrapChunk(20, [], true))
    // Leave manual mode so the re-bootstrap rung 5 starts is served by the scripted
    // slice instead of blocking forever on a channel this test never feeds again.
    // The generator already handed out above keeps its own reference, so the last
    // chunk pushed a line earlier is still delivered to the walk in flight.
    b.authority.manual = null
    await b.replica.settled().catch(() => undefined)
    expect(corruptFrom(b.replica)).toEqual(['bootstrapping'])
    // And it TERMINATED: a store that stays corrupt exhausts the walk's budget
    // rather than renewing it once per attempt (D7, strictly downward).
    expect(b.replica.trace).toContain('D6-EXHAUSTED')
  })

  it('D6-BUFFER fires from healing, and the drain drops the covered frame from live', async () => {
    const h = harness()
    await bootstrapped(h, 10, [])
    // Heal reply lands at 20, so both buffered frames are wholly covered by it.
    h.authority.changesSinceQueue = [deltaFrame(10, 20, [])]

    // The frame that OPENS the heal is itself buffered, and it must be one the
    // drain can get past: the drain walks the buffer in arrival order and stops at
    // the first frame that does not chain, so a leading gap frame would short-
    // circuit the walk and the covered frame behind it would never be classified.
    // That is exactly what the previous fixture did, which is why the row this
    // test is named for never fired.
    h.replica.receive(deltaFrame(12, 15, [session(15, 'x', 'y')]))
    expect(h.replica.posture).toBe('healing')
    expect(h.replica.receive(deltaFrame(15, 18, [])).rowId).toBe('D6-BUFFER')

    await h.replica.settled()

    // Both were at or below the healed cursor, so both are dropped rather than
    // applied — nothing from either frame reaches the store.
    const covered = h.replica.transitions.filter((t) => t.rowId === 'D6-BUFFER-COVERED')
    expect(covered.map((t) => t.from)).toEqual(['live', 'live'])
    expect(h.replica.cursor?.seq).toBe(20)
    expect(h.replica.view('session', 'x')).toBeUndefined()
  })

  it('disconnect fires from healing, from stale, and cold from bootstrapping', async () => {
    const a = harness()
    await bootstrapped(a, 10, [])
    a.authority.changesSinceQueue = [deltaFrame(10, 11, [])]
    a.replica.receive(deltaFrame(30, 31, [session(31, 'x', 'y')]))
    expect(a.replica.posture).toBe('healing')
    expect(a.replica.disconnect().rowId).toBe('D7-STALE-VISIBLE')
    // Idempotent: disconnecting an already-stale replica is still stale-visible.
    expect(a.replica.disconnect().rowId).toBe('D7-STALE-VISIBLE')

    const b = harness()
    b.authority.driveManually()
    b.replica.connect()
    expect(b.replica.posture).toBe('bootstrapping')
    // Never installed a cursor, so there is no slice to keep visible.
    expect(b.replica.disconnect().rowId).toBe('D7-DISCONNECT-COLD')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('transition-table totality — the table must AGREE with the machine', () => {
  it('every row of the ADR transition table is driven by this suite', () => {
    const declared = REPLICA_TRANSITIONS.map((row) => row.id)
    const missing = declared.filter((id) => !SEEN.has(id))
    expect(missing).toEqual([])
  })

  it('every OBSERVED transition matched its declared from/to postures', () => {
    // The id-presence check above only proves a row was reached. This one proves
    // the row is TRUE: that the machine really moved between the postures the
    // normative table declares. It is what catches a declared transition the code
    // does not perform — worse than an undocumented one, because POD-372 and
    // POD-373 implement against the table.
    const violations: string[] = []
    for (const observed of OBSERVED) {
      const row = REPLICA_TRANSITIONS.find((r) => r.id === observed.rowId)
      if (row === undefined) {
        violations.push(`${observed.rowId}: not in the table at all`)
        continue
      }
      if (!row.from.includes(observed.from)) {
        violations.push(
          `${row.id}: fired from '${observed.from}', which the table does not declare (${row.from.join('|')})`,
        )
      }
      if (!row.to.includes(observed.to)) {
        violations.push(
          `${row.id}: landed in '${observed.to}', which the table does not declare (${row.to.join('|')})`,
        )
      }
    }
    expect([...new Set(violations)]).toEqual([])
  })

  it('every declared from-posture is actually exercised somewhere in the suite', () => {
    // A declared route nobody drives is an untested claim. Reported as a list so
    // adding a from-posture to the table without a test fails loudly.
    const unexercised: string[] = []
    for (const row of REPLICA_TRANSITIONS) {
      for (const from of row.from) {
        const seen = OBSERVED.some((o) => o.rowId === row.id && o.from === from)
        if (!seen) unexercised.push(`${row.id} from '${from}'`)
      }
    }
    expect(unexercised).toEqual([])
  })

  it('every row cites the clause that decides it, and rungs resolve downward', () => {
    for (const row of REPLICA_TRANSITIONS) {
      expect(row.adr, `${row.id} must cite its ADR clause`).not.toBe('')
      expect(row.from.length, `${row.id} must declare a source posture`).toBeGreaterThan(0)
      expect(row.to.length, `${row.id} must declare a destination posture`).toBeGreaterThan(0)
    }
    // Rungs 2-6 all terminate at the same place — that is the whole design.
    const terminal = REPLICA_TRANSITIONS.filter((r) => r.rung !== null && r.rung >= 2)
    expect(terminal.every((r) => r.to.includes('bootstrapping'))).toBe(true)
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
