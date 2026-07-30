/**
 * The Replica transition table — ADR 2 D6/D7 as amended by ADR 2 Amendment 1
 * D13/D14/D15, expressed as DATA rather than as prose.
 *
 * Why data: the acceptance criterion is "state machine unit-tested against the
 * ADR's transition table", and a table that lives only in a doc gets tested by
 * whichever rows the implementer remembered. Every `Replica` operation returns
 * the `rowId` it took; `transition-table.test.ts` asserts that every row here is
 * exercised by the suite, so a row nobody drives is a FAILING test rather than an
 * unnoticed hole. Adding a row to the ADR and not to the tests breaks the build.
 *
 * The three rows the multi-user amendment adds are D13-WATERMARK, D14-EVICT and
 * D14-RESCOPE. Their boundary is stated explicitly rather than implied
 * (Amendment 1 D14.4): `evict` is the CHEAP INCREMENTAL path — a bounded,
 * enumerable set of entities leaves this principal's view; `rescope` is the
 * ALWAYS-LEGAL TERMINAL path — the authority declines to enumerate (role change,
 * subtree owner transfer, unenumerable revoke, or queue pressure) and sends the
 * replica down rung 2 instead. The authority may take the terminal path at any
 * time; the replica may never take the incremental one on its own initiative,
 * because choosing which entities left the view would be the replica evaluating
 * visibility.
 *
 * Every row here is quoted from the ADR pack. There are deliberately NO derived
 * rows: an earlier revision carried two (absorbing re-delivered and overlapping
 * frames) and review rejected them, because a local fork of a load-bearing wire
 * contract is not a decision this issue gets to make on its own.
 */

import type { HealRung, Posture } from './types'

export interface TransitionRow {
  /** Stable id. Returned by the state machine; asserted for coverage by the suite. */
  readonly id: string
  /** Posture(s) this row can fire from. */
  readonly from: readonly Posture[]
  /** The input that fires it. */
  readonly input: string
  /** The guard that selects this row over its siblings. */
  readonly condition: string
  /** What the replica does. */
  readonly effect: string
  /** Posture after the transition. */
  readonly to: Posture
  /** D7 ladder rung, or null where the row is not a ladder step. */
  readonly rung: HealRung | null
  /** The clause that decides it. */
  readonly adr: string
}

export const REPLICA_TRANSITIONS: readonly TransitionRow[] = [
  // ─── Rung 0: the normal path ───────────────────────────────────────────────
  {
    id: 'D7-0-APPLY',
    from: ['live'],
    input: 'delta frame',
    condition: 'feedId/epoch match AND fromSeq === cursor.seq AND changes non-empty',
    effect: 'Apply changes in seq order and set cursor = seq, in ONE transaction.',
    to: 'live',
    rung: 0,
    adr: 'ADR 2 D7 rung 0; Amendment 1 D13 (accept iff fromSeq === cursor)',
  },
  {
    id: 'D13-WATERMARK',
    from: ['live'],
    input: 'delta frame',
    condition: 'feedId/epoch match AND fromSeq === cursor.seq AND changes IS EMPTY',
    effect:
      'Advance cursor = seq with no entity change. NOT a gap, NOT a heal. Bounded: nothing is retained.',
    to: 'live',
    rung: 0,
    adr: 'Amendment 1 D13 — an empty certified frame is a watermark and is the normal path',
  },
  {
    id: 'D14-EVICT',
    from: ['live'],
    input: 'delta frame containing op=evict',
    condition: 'certified frame, contiguous',
    effect:
      'Drop the entity from cache and derived views. Record exit kind `evicted`. MUST NOT surface as a deletion, emit a domain delete, or write a tombstone.',
    to: 'live',
    rung: 0,
    adr: 'Amendment 1 D14.1 / D14.5 — the third member of the removal family',
  },
  {
    id: 'D5-REMOVE',
    from: ['live'],
    input: 'delta frame containing op=remove',
    condition: 'certified frame, contiguous',
    effect: 'Tombstone. Drop the entity and record exit kind `removed` — this one IS a deletion.',
    to: 'live',
    rung: 0,
    adr: 'ADR 2 D5 — tombstones are feed rows',
  },
  {
    id: 'D14-READMIT',
    from: ['live'],
    input: 'delta frame containing op=upsert for a previously evicted entity',
    condition: "entity's revision has NOT moved",
    effect:
      'Install it. An upsert whose revision has not moved is still a valid upsert; clear the exit kind and flag the emission as a re-admission (not a creation).',
    to: 'live',
    rung: 0,
    adr: 'Amendment 1 D14.2 — re-admission needs no new op',
  },

  // ─── Rung 1: gap ───────────────────────────────────────────────────────────
  {
    id: 'D7-1-GAP',
    from: ['live'],
    input: 'delta frame',
    condition:
      'feedId/epoch match AND fromSeq !== cursor.seq — INCLUDING a re-delivered or overlapping frame',
    effect:
      'Do NOT apply. Buffer the frame and call changesSince(cursor). D13.1 guarantees frames are contiguous and non-overlapping, so anything else is a protocol violation, not a case to absorb.',
    to: 'healing',
    rung: 1,
    adr: 'ADR 2 D7 rung 1, as amended by D13 (explicit lower bound also catches a lost frame)',
  },
  {
    id: 'D7-1-HEALED',
    from: ['healing'],
    input: 'changesSince reply',
    condition: 'certified, feedId/epoch match, fromSeq === cursor.seq, well-formed',
    effect: 'Apply the reply, then drain buffered frames while they stay contiguous.',
    to: 'live',
    rung: 1,
    adr: 'ADR 2 D7 rung 1',
  },
  {
    id: 'D7-1-RESUME',
    from: ['stale'],
    input: 'connect()',
    condition: 'a cursor is held',
    effect: 'Resume from the cursor: changesSince(cursor). Reconnect is a heal, not a bootstrap.',
    to: 'healing',
    rung: 1,
    adr: 'ADR 2 D7 stale-visible; D6 (bootstrap is the RECOVERY case, not the normal one)',
  },
  {
    id: 'D7-1-FRAME-WHILE-STALE',
    from: ['stale'],
    input: 'delta frame',
    condition: 'arrives before connect() — the link came back underneath us',
    effect:
      'Do not apply blind: frames were missed while offline, so buffer it and heal from the cursor first.',
    to: 'healing',
    rung: 1,
    adr: 'ADR 2 D7 rung 1 (conservative: any uncertainty resolves downward)',
  },

  // ─── Rung 2: re-bootstrap ──────────────────────────────────────────────────
  {
    id: 'D7-2-COMPACTED',
    from: ['healing'],
    input: 'changesSince reply',
    condition: 'reply is bootstrap-required (cursor below minAvailableSeq / unknown)',
    effect: 'Re-bootstrap (scoped). Discard the cache at the atomic swap. KEEP THE OUTBOX.',
    to: 'bootstrapping',
    rung: 2,
    adr: 'ADR 2 D7 rung 2',
  },
  {
    id: 'D7-2-RESYNC',
    from: ['live', 'healing', 'stale'],
    input: 'resync-required control frame',
    condition: 'always — the authority shed load',
    effect: 'Re-bootstrap. Telemetry records a BACKPRESSURE cause, not an authz one.',
    to: 'bootstrapping',
    rung: 2,
    adr: 'ADR 2 D9 → D7 rung 2',
  },
  {
    id: 'D14-RESCOPE',
    from: ['live', 'healing', 'stale', 'bootstrapping', 'cold'],
    input: 'rescope control frame',
    condition: "always legal — the principal's rights changed",
    effect:
      'Re-bootstrap, scoped, on the SAME path as every other rung: discard the cache, KEEP THE OUTBOX. Telemetry records an AUTHZ cause, distinguishable from resync-required.',
    to: 'bootstrapping',
    rung: 2,
    adr: 'Amendment 1 D14.4; ADR 2 D7 outbox rule; ADR 3 D9 invariant 5',
  },
  {
    id: 'D7-2-COLD',
    from: ['cold'],
    input: 'connect()',
    condition: 'no cursor held',
    effect: "Bootstrap the principal's slice. The most-exercised path in the system.",
    to: 'bootstrapping',
    rung: 2,
    adr: 'ADR 2 D6; Amendment 1 D15',
  },

  // ─── Rungs 3-6 ─────────────────────────────────────────────────────────────
  {
    id: 'D7-3-MALFORMED',
    from: ['live', 'healing', 'stale', 'bootstrapping'],
    input: 'delta frame',
    condition:
      'frame/range shape fails (change outside the covered range, decreasing seq, upsert without payload, remove/evict with payload, empty id, inverted range), OR the injected known-kind validator rejects a payload or an embedded-id mismatch',
    effect:
      'Do not apply, do not advance. Re-bootstrap. Checked on EVERY route into the store — live, and before a frame is buffered during a heal or a walk. Unknown kinds stay lenient per D4 and still advance the cursor.',
    to: 'bootstrapping',
    rung: 3,
    adr: 'ADR 2 D7 rung 3 + D4 lenient parsing — escalates rather than retrying, or the heal loops forever',
  },
  {
    id: 'D7-3-REPLY-MALFORMED',
    from: ['healing'],
    input: 'changesSince reply',
    condition: 'non-contiguous with the cursor, or fails validation',
    effect: 'Re-bootstrap. A sideways retry of the request that just failed is an infinite loop.',
    to: 'bootstrapping',
    rung: 3,
    adr: 'ADR 2 D7 rung 3 + "why the ladder must be strictly downward"',
  },
  {
    id: 'D7-4-EPOCH',
    from: ['live', 'healing', 'stale'],
    input: 'delta frame or changesSince reply',
    condition: 'feedId or epoch differs from the held cursor',
    effect:
      'Discard the replica entirely and re-bootstrap. Epoch is compared by EQUALITY only, never ordered.',
    to: 'bootstrapping',
    rung: 4,
    adr: 'ADR 2 D1 + D7 rung 4',
  },
  {
    id: 'D7-5-CORRUPT',
    from: ['live', 'healing', 'bootstrapping'],
    input: 'store throws ReplicaStoreCorruptError',
    condition: 'the local store is unreadable',
    effect:
      'Clear the cache explicitly and re-bootstrap as a cold client. The outbox is on a port this path cannot reach; if it is ALSO lost, its own store surfaces that loudly.',
    to: 'bootstrapping',
    rung: 5,
    adr: 'ADR 2 D7 rung 5; ADR 6 D4.5',
  },
  {
    id: 'D7-6-SCHEMA',
    from: ['live', 'stale', 'cold'],
    input: 'replicaSchemaChanged()',
    condition: 'the local store layout version moved',
    effect: 'Discard and re-bootstrap. A client is never obliged to migrate.',
    to: 'bootstrapping',
    rung: 6,
    adr: 'ADR 2 D4 (replica schema version) + D7 rung 6; ADR 6 D5.1',
  },

  // ─── Bootstrap walk (D6 shape, D15 slice) ──────────────────────────────────
  {
    id: 'D6-BUFFER',
    from: ['bootstrapping', 'healing'],
    input: 'delta frame',
    condition: 'a bootstrap walk or a heal is in flight',
    effect:
      'Buffer the frame. The rule is stated over FRAMES, not over ops, so watermarks and evicts buffer exactly like ordinary changes and no op kind can be forgotten.',
    to: 'bootstrapping',
    rung: null,
    adr: 'ADR 2 D6.3; Amendment 1 D15.2',
  },
  {
    id: 'D6-BUFFER-COVERED',
    from: ['bootstrapping', 'healing'],
    input: 'buffered frame, at install or at drain',
    condition: 'frame.seq <= cursor.seq (the snapshot or the heal already covers it)',
    effect:
      'DROP it. Not applied and not healed: our own cursor already certifies that range, so there is nothing to learn from it. Nothing from the frame reaches the store, so this is not acceptance of an overlapping frame.',
    to: 'live',
    rung: null,
    adr: 'ADR 2 D6.3',
  },
  {
    id: 'D6-INSTALL',
    from: ['bootstrapping'],
    input: 'last chunk',
    condition: 'the walk completed',
    effect:
      'ONE transaction: swap staging into place (this is the cache discard), apply buffered deltas in order, commit the cursor. No half-installed replica.',
    to: 'live',
    rung: null,
    adr: 'ADR 2 D6.4 / D10; Amendment 1 D15.3',
  },
  {
    id: 'D6-INSTALL-GAP',
    from: ['bootstrapping'],
    input: 'buffered frames, at install',
    condition: 'a buffered frame does not chain EXACTLY (fromSeq !== running cursor)',
    effect:
      'Apply whole frames while they chain exactly, keep the rest buffered, and heal from the cursor reached. No frame is ever truncated: applying a fragment of a certified range is the acceptance D13 forbids.',
    to: 'healing',
    rung: 1,
    adr: 'ADR 2 D7 rung 1 — resolve downward rather than guess across the hole',
  },
  {
    id: 'D6-RESTART',
    from: ['bootstrapping'],
    input: 'chunk stream fails, or a chunk is malformed',
    condition: 'attempts remain',
    effect:
      'Discard staging and restart from scratch. Bootstrap is restartable, not resumable, in Phase 2.',
    to: 'bootstrapping',
    rung: null,
    adr: 'ADR 2 D6.5 + Deferred ("resumable bootstrap")',
  },
  {
    id: 'D6-EXHAUSTED',
    from: ['bootstrapping'],
    input: 'chunk stream fails',
    condition: 'no attempts remain',
    effect:
      'Surface the failure and keep serving the last-known slice, marked stale. Never blank the UI.',
    to: 'stale',
    rung: null,
    adr: 'ADR 2 D7 "stale-visible, never blank"',
  },

  // ─── Connectivity ──────────────────────────────────────────────────────────
  {
    id: 'D7-STALE-VISIBLE',
    from: ['live', 'healing', 'bootstrapping'],
    input: 'disconnect()',
    condition: 'a slice is installed',
    effect:
      'Keep serving the last-known slice, marked stale. Under scoping it may include rows a revocation has since removed; that is a stale read and it is NOT expired locally.',
    to: 'stale',
    rung: null,
    adr: 'ADR 2 D7 stale-visible; Amendment 1 D13 (do not expire visibility on a timer)',
  },
  {
    id: 'D7-DISCONNECT-COLD',
    from: ['cold', 'bootstrapping'],
    input: 'disconnect()',
    condition: 'no slice installed',
    effect: 'Stay cold. There is nothing to show stale.',
    to: 'cold',
    rung: null,
    adr: 'ADR 2 D7',
  },
] as const

export function transitionRow(id: string): TransitionRow {
  const row = REPLICA_TRANSITIONS.find((r) => r.id === id)
  if (row === undefined) throw new Error(`unknown transition row: ${id}`)
  return row
}
