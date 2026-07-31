/**
 * Feed identity and the healing ladder, as PURE decisions (ADR 2 D1 + D7).
 *
 * This module holds no state and touches no storage. It answers exactly one
 * question — *given the cursor we hold and the thing that just arrived, which
 * rung of the ladder are we on?* — so every rung is unit-testable without a
 * socket, a server, or a replica. The driver (`applyFeedEvent` callers) turns
 * the answer into storage effects; the storage effects live in `replica.ts` and
 * the install machinery in `bootstrap.ts`.
 *
 * ## Why the cursor is a triple
 *
 * ADR 2 D1: a bare `seq` cannot distinguish "you are up to date" from "you hold
 * entities off a timeline that no longer exists". Restore the authority from a
 * backup whose log ends at 400 while this client holds 500, let the authority
 * write 100 more changes, and `changesSince(500)` finds cursor === max and
 * answers `[]` — "up to date" — forever. The 401..500 we hold are phantoms and
 * nothing can detect it. So the cursor is `(feedId, epoch, seq)` and both ids
 * are compared by EQUALITY ONLY — the epoch is a minted id, never a counter
 * (POD-792: a counter re-collides when the same backup is restored twice).
 *
 * ## Why the ladder is strictly downward
 *
 * D7: every rung resolves to a rung BELOW it, never sideways. A sideways
 * resolution — retrying the request that just failed — is an infinite loop, and
 * that loop is not hypothetical: healing a malformed row via `changesSince`
 * returns the same malformed row and spins forever (the shipped `sync.ts`
 * lenient-parsing note records it). That is why rung 3 escalates to
 * re-bootstrap instead of re-healing.
 */

/** The replica cache format this build understands (ADR 2 D4 — the replica
 *  schema version, one of three independent version namespaces and NOT
 *  `WIRE_VERSION`). Bump when a persisted row shape changes incompatibly; the
 *  bump is rung 6 — discard the cache and re-bootstrap. */
export const REPLICA_SCHEMA_VERSION = 1

/**
 * The replica's cursor (ADR 2 D1). Persisted with the entities it covers and in
 * the same commit (D10).
 *
 * `feedId`/`epoch` are null on a cold client and against a pre-identity
 * authority (one that predates POD-792 and stamps neither). Null means "not yet
 * known", NOT "mismatched": an authority that never states its identity cannot
 * be caught lying about it, and refusing to sync with it would be a regression
 * rather than a safety property. See {@link identityVerdict}.
 */
export interface FeedCursor {
  feedId: string | null
  epoch: string | null
  /** Last applied seq. 0 = nothing applied (cold). Seqs are 1-based. */
  seq: number
}

export const COLD_CURSOR: FeedCursor = { feedId: null, epoch: null, seq: 0 }

/** The identity an authority stamped on a frame or reply (ADR 2 D1/D5). All
 *  three are optional: the WS delta frame carries them only for clients that
 *  negotiated `CAP_SYNC_FEED_IDENTITY`, and any authority may predate them. */
export interface FeedStamp {
  feedId?: string
  epoch?: string
  /** The lowest seq the authority can still DELIVER (ADR 2 D5). */
  minAvailableSeq?: number
}

/** What just arrived, in the only two shapes the ladder judges. */
export type FeedEvent =
  | {
      kind: 'delta'
      /** First change's seq. Absent for an EMPTY delta (nothing to be contiguous with). */
      firstSeq?: number
      /** Cursor the delta carries us to (the last change's seq). */
      cursor: number
      stamp: FeedStamp
    }
  | {
      kind: 'snapshot'
      /** The `(feedId, epoch, snapshotSeq)` the authority read its state at. */
      cursor: number
      stamp: FeedStamp
    }

/** A rung of ADR 2 D7's ladder. The numbers are the ADR's, deliberately — a
 *  reader should be able to hold this type and the ADR table side by side. */
export type FeedAction =
  /** 0 — identity matches and `seq === cursor + 1`. The normal path. */
  | { rung: 0; effect: 'apply' }
  /** 1 — gap. Do not apply; `changesSince(cursor)`. */
  | { rung: 1; effect: 'heal'; reason: 'gap' }
  /** 2 — compacted: the authority can no longer serve our cursor. */
  | { rung: 2; effect: 'rebootstrap'; reason: 'compacted' }
  /** 3 — malformed: a known-kind row failed validation, or the reply is
   *  non-contiguous. Never apply, never advance. */
  | { rung: 3; effect: 'rebootstrap'; reason: 'malformed' }
  /** 4 — the feed identity is not the one we hold. The cache is phantom. */
  | { rung: 4; effect: 'discard'; reason: 'epoch-mismatch' }
  /** 5 — the local store is unreadable. */
  | { rung: 5; effect: 'discard'; reason: 'local-corruption' }
  /** 6 — the replica schema version moved. */
  | { rung: 6; effect: 'discard'; reason: 'schema-bump' }
  /** Not a rung: an already-applied delta. Idempotent no-op, cursor stands. */
  | { rung: 0; effect: 'skip'; reason: 'stale' }

/**
 * Compare a held identity against a stamped one (ADR 2 D1 — EQUALITY ONLY).
 *
 * Three-valued on purpose, because "unknown" is not "mismatched":
 * - `match`     — both sides state an identity and they agree.
 * - `unknown`   — one side states nothing. A cold client has nothing to compare;
 *                 a pre-identity authority stamps nothing. Neither is evidence
 *                 of a dead timeline, and treating it as one would make every
 *                 cold start and every old server a permanent reset loop.
 * - `mismatch`  — both sides state an identity and they DISAGREE. Rung 4.
 *
 * Note what this deliberately does NOT do: it never infers a mismatch from a
 * one-sided identity. The cost of that choice is honest and bounded — against an
 * authority that stamps nothing we are back to a bare seq and D1's phantom
 * window is open, exactly as it is today. The cap negotiation (POD-792) is what
 * closes it; this function must not pretend to close it by guessing.
 */
export function identityVerdict(
  held: Pick<FeedCursor, 'feedId' | 'epoch'>,
  stamp: FeedStamp,
): 'match' | 'unknown' | 'mismatch' {
  const pairs: Array<[string | null, string | undefined]> = [
    [held.feedId, stamp.feedId],
    [held.epoch, stamp.epoch],
  ]
  let sawKnown = false
  for (const [ours, theirs] of pairs) {
    if (ours === null || theirs === undefined) continue
    if (ours !== theirs) return 'mismatch'
    sawKnown = true
  }
  return sawKnown ? 'match' : 'unknown'
}

/**
 * Rung 2's predicate (ADR 2 D5): can the authority still serve what we'd ask for?
 *
 * The authority's own servability rule is "I can serve `cursor` iff every change
 * in `(cursor, max]` is retained", i.e. iff `cursor + 1 >= minAvailableSeq`. So
 * we must re-bootstrap when `cursor + 1 < minAvailableSeq`. D7's table states the
 * shorthand `cursor < minAvailableSeq`, which is the same rule off by one and
 * errs toward one needless re-bootstrap; the exact form is free, so we take it.
 *
 * A cold cursor (seq 0) is never "compacted" — it is a bootstrap, which is where
 * rung 2 was going to send it anyway.
 */
export function isCompacted(seq: number, minAvailableSeq: number | undefined): boolean {
  if (minAvailableSeq === undefined || seq === 0) return false
  return seq + 1 < minAvailableSeq
}

/**
 * THE ladder (ADR 2 D7). Pure: `held` + `event` in, rung out.
 *
 * Order matters and is the ADR's: identity is judged BEFORE contiguity, because
 * a seq is only meaningful within a generation — `seq === cursor + 1` across an
 * epoch bump is a coincidence, not a match, and applying it would silently weld
 * two timelines together. That single ordering is the whole reason D1 exists.
 */
export function decideFeedAction(held: FeedCursor, event: FeedEvent): FeedAction {
  // Rung 4 first — see above. A mismatch invalidates every other question.
  if (identityVerdict(held, event.stamp) === 'mismatch') {
    return { rung: 4, effect: 'discard', reason: 'epoch-mismatch' }
  }

  // A snapshot IS the terminal recovery: it carries whole state at a definite
  // `(feedId, epoch, cursor)`, so there is nothing to be contiguous with and
  // nothing to compact past. Install it.
  if (event.kind === 'snapshot') return { rung: 0, effect: 'apply' }

  // Rung 2 — compacted. Checked BEFORE the gap rule: when the authority has
  // pruned past us, `changesSince` cannot answer and healing would be the
  // sideways resolution D7 forbids. D5 publishes `minAvailableSeq` precisely so
  // we can know this BEFORE asking rather than after being refused.
  if (isCompacted(held.seq, event.stamp.minAvailableSeq)) {
    return { rung: 2, effect: 'rebootstrap', reason: 'compacted' }
  }

  // An empty delta must not move the cursor (protocol law — `sync.ts` #247 r3).
  if (event.firstSeq === undefined) {
    return event.cursor === held.seq
      ? { rung: 0, effect: 'skip', reason: 'stale' }
      : { rung: 3, effect: 'rebootstrap', reason: 'malformed' }
  }

  // Rung 3 — a batch that ends before it starts is not a batch. Judged BEFORE
  // staleness: `cursor < firstSeq` also satisfies "wholly stale" for some held
  // seqs, and reading an incoherent batch as a benign no-op would let a
  // producer bug sit undetected behind a skip.
  if (event.cursor < event.firstSeq) {
    return { rung: 3, effect: 'rebootstrap', reason: 'malformed' }
  }

  // Wholly stale: every change is at or below the cursor. Idempotent no-op —
  // NOT a gap. A reconnect that replays the batch we just applied lands here.
  if (event.cursor <= held.seq) return { rung: 0, effect: 'skip', reason: 'stale' }

  // Rung 0 / rung 1 — contiguity. `firstSeq === seq + 1` is the whole test.
  // Partially-stale batches (first <= cursor < last) are the caller's to trim
  // BEFORE asking: it drops the applied prefix and re-asks with the fresh first
  // seq. Trimming here would hide the difference between a batch we can splice
  // and a batch that skips rows we never saw.
  if (event.firstSeq !== held.seq + 1) return { rung: 1, effect: 'heal', reason: 'gap' }

  return { rung: 0, effect: 'apply' }
}

/** The cursor to persist after `event` applied. Derives the triple from the
 *  stamp, KEEPING what we already hold when the authority states nothing — a
 *  pre-identity reply must never blank an identity a previous reply established
 *  (that would make the next stamped reply read as a rung-4 mismatch against
 *  nothing, an infinite reset loop against a mixed-version authority). */
export function advanceCursor(held: FeedCursor, event: FeedEvent): FeedCursor {
  return {
    feedId: event.stamp.feedId ?? held.feedId,
    epoch: event.stamp.epoch ?? held.epoch,
    seq: event.cursor,
  }
}
