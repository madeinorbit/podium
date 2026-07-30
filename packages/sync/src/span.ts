/**
 * ADR 2 D10's unit of work — the ONE definition site (POD-1146).
 *
 * POD-369 (the Replica role) and POD-370 (the Outbox role) each declared an
 * interface named `SyncSpan` for this seam, independently, in files whose comments
 * cite each other's findings. They were not the same type: the replica's was
 * `join(participant)` with an owner that commits or aborts; the outbox's was
 * `onCommit(adopt)`. That is the parallel-definition drift POD-302 exists to end,
 * arriving inside the sync kernel itself, and POD-305/POD-373 — which wire BOTH
 * modules — would have compiled against a port whose shape did not describe the
 * object they received.
 *
 * They were never two ports. They are two ROLES on one span, and one PHASE split
 * that both halves need:
 *
 *   ROLE — the REPLICA opens and owns the span (it decides when a certified
 *   frame's several retirements commit together, which is why `beginSpan` is on
 *   the cache port); the OUTBOX is handed one and participates. So settlement
 *   (`commit`/`abort`) lives on `OwnedSyncSpan` and NOWHERE ELSE, and a
 *   participant handed a `SyncSpan` has no way to settle somebody else's
 *   transaction. `OwnedSyncSpan extends SyncSpan` in that direction and not the
 *   other: an owner can do everything a participant can, never the reverse.
 *
 *   PHASE — `join` enrols DURABLE work (stage privately, veto in `prepare`,
 *   publish unfailably, drop the draft on `discard`); `onCommit` adopts IN-MEMORY
 *   state and emits observations strictly AFTER durability. Both halves need both,
 *   and neither substitutes for the other.
 *
 * EVERY HOOK ON THIS PORT IS SYNCHRONOUS, and that is a requirement rather than a
 * simplification. `SyncUnitOfWork`'s rule 3 already states the reason for the
 * transaction BODY — "every authority/network await finishes before the span
 * opens, because an IndexedDB transaction auto-closes on an unrelated await" — and
 * it binds a hook that runs INSIDE the transaction far harder: a `prepare` or
 * `publish` that awaited would close the very transaction it is enrolled in. The
 * asynchrony the durable adapters need lives outside the span, in
 * `SyncUnitOfWork.transact`'s body.
 *
 * NEUTRALITY. This module is a port and nothing else: no storage, no policy, no
 * replica→outbox edge readmitted under a new name. It carries no cause, rung,
 * rescope or re-bootstrap parameter, and it never will. Neither kernel module
 * imports the other; both import only this. It lives OUTSIDE `replica/` on purpose
 * — putting it inside would have made the outbox import the replica — and
 * `check-boundaries` rule 9 pins that with a single-path exception rather than a
 * widened one.
 */

/**
 * The PARTICIPANT-side handle: what a region is given when it is enrolled.
 *
 * Deliberately carries no `commit` and no `abort`. A participant that could settle
 * the span could publish its own region while another region's draft is still
 * unvalidated, which is precisely the torn state D10 forbids — and it would do so
 * to a transaction it does not own.
 */
export interface SyncSpan {
  /**
   * Enrol a durable region in this span. Idempotent per participant: joining twice
   * extends the one draft rather than creating a second.
   *
   * Joining is EXPLICIT-SPAN-ONLY. There is no ambient or current transaction to
   * pick up — a participant is in a span iff the span was handed to it. A
   * process-wide "current transaction" cannot tell lexical NESTING from an
   * unrelated CONCURRENT caller, so a mutation arriving mid-body was silently
   * absorbed into someone else's transaction: reported durable before it was, then
   * lost when that unrelated transaction aborted.
   */
  join(participant: SyncSpanParticipant): void
  /**
   * Adopt in-memory state — and publish observations — for work this participant
   * staged inside the span. Registered adoptions run in registration order AFTER
   * the span's durable commit.
   *
   * **This is the only IN-MEMORY hook, and there is deliberately no abort
   * counterpart.** Compare the failure mode of FORGETTING. Forget an `onAbort` and
   * memory ends up AHEAD of durable truth — a silent divergence asserting a fact
   * from a transaction that never committed, which survives until something trips
   * over it. Forget an `onCommit` and memory ends up BEHIND durable truth — a
   * stale read that the next apply or rehydrate corrects, and which can invent
   * nothing. The unsafe direction is therefore unreachable rather than merely
   * forbidden. That asymmetry is load-bearing; it is why a participant registering
   * nothing here is safe, and it is NOT weakened by `discard` on
   * `SyncSpanParticipant`, which drops a private durable draft nobody has observed
   * and can no more invent a fact than registering nothing can.
   *
   * Events are enrolled here too, not just state: inside a shared span "after my
   * commit" means after the OUTER commit, and an emitted event cannot be
   * un-emitted by any hook. That is what makes "no observation escapes on abort" a
   * mechanism rather than a hope.
   */
  onCommit(adopt: () => void): void
}

/**
 * One region's durable participation. Staged privately, published once.
 *
 * Two phases and not one, because publishing has to be unfailable. Anything that
 * can refuse — a corrupt region, a precondition that only holds at the serialized
 * point — refuses in `prepare`, while every draft is still private and abandoning
 * them all costs nothing. Once the first region has published there is no clean
 * way to report a failure in the second, which is exactly the torn state a span
 * exists to prevent.
 *
 * An adapter MUST be atomic across enrolled writes: staging or validating them
 * against a transaction-local view and publishing only once every one succeeds. An
 * implementation that applies enrolled writes in sequence and cannot undo one
 * already applied is not a unit of work — it is a partially committed transaction.
 */
export interface SyncSpanParticipant {
  /**
   * Last chance to VETO, run for every participant before any of them publishes.
   * Throwing here aborts the whole span and nothing is published. A late
   * precondition failure throws `SyncCommitConflict` so participants can re-stage.
   */
  prepare?(): void
  /**
   * Make the staged draft visible. MUST NOT throw, and MUST NOT await: by the time
   * this runs the span has passed the point where a failure could be reported
   * cleanly, so anything that can fail belongs in `prepare`.
   */
  publish(): void
  /**
   * Drop the private draft. Called on abort, and on any participant's veto.
   *
   * Optional for the same reason `onCommit` has no abort twin: an aborted span
   * published nothing, so forgetting `discard` leaks a draft the next span rebases
   * past — it cannot make anything durable or observable that was not.
   */
  discard?(): void
}

/**
 * The OPENER-side handle. Every path must reach commit or abort.
 *
 * Held only by whoever opened the span — today `ReplicaCacheStore.beginSpan()` and
 * `SyncUnitOfWork.transact`. It is handed DOWN to participants as a `SyncSpan`,
 * which is the whole role split: widening is free, narrowing is not.
 */
export interface OwnedSyncSpan extends SyncSpan {
  /**
   * Prepare every participant, then publish once — ONE publication for the whole
   * span, not one per participant. Throws if a participant vetoes, having first
   * discarded every draft. `onCommit` adoptions run last, after durability.
   */
  commit(): void
  /** Discard every participant's draft. Nothing published, nothing adopted, nothing retired. */
  abort(): void
}

/**
 * The transaction seam POD-305 and POD-373 wire; the kernel modules only declare
 * it and enrol into it.
 *
 * An explicit shared span is REQUIRED when one logical commit spans more than one
 * region: entities/cache + cursor + the outbox/overlay. A lone single-region
 * operation MAY autocommit and need not open one (D10 clause 2). A span resolves
 * only after DURABILITY, never before.
 *
 * **No silent per-write fallback on the durable path.** Leaving each write in its
 * own transaction IS the D10 non-compliance, so it is legal only as ADR 2's
 * explicitly surfaced degraded mode, never as normal wiring.
 *
 * **Only RETIREMENT enrols, on the outbox side.** The span exists to cover the
 * Replica's entity write, its cursor advance, and the retirement that follows from
 * them. Enqueue, discard, retry and edit are USER actions: they take no span and
 * do NOT join one that happens to be open — a user action issued while somebody
 * else's transaction is in flight commits independently and immediately, and
 * survives that transaction's abort.
 */
export interface SyncUnitOfWork {
  /**
   * Run `body` as ONE atomic span over the local store. Every write enrolled with
   * the span it receives is durable together or not at all.
   *
   * INDEPENDENT CALLS ARE SERIALIZED, and joining is expressed ONLY by threading
   * the span explicitly. The body does LOCAL STORAGE WORK ONLY: an authority round
   * trip inside it would let an IndexedDB transaction auto-close.
   *
   * Corollary for participants: do not open a transaction for a mutation that
   * touches ONE store and has nothing to be atomic with. A single record-level,
   * precondition-checked write is already atomic; the transaction exists to join a
   * MULTI-PARTICIPANT commit, and that always arrives as an explicit span.
   */
  transact<T>(body: (span: SyncSpan) => Promise<T>): Promise<T>
}

/**
 * A precondition that could only be evaluated at COMMIT time did not hold.
 *
 * This exists because an adapter enrolled in a span often cannot answer when the
 * write is handed to it: the check has to happen inside the native transaction, by
 * which point there is no caller left to return `{ok: false}` to. So the span
 * rejects — and it must reject with THIS type rather than a generic error, because
 * a conflict is an ordinary concurrent-writer outcome that participants resolve by
 * re-staging, while a generic failure is not resolvable and must surface. A typed
 * channel is what lets both kernels tell those apart.
 *
 * Neutral on purpose: it lives beside the span types so the Replica can raise and
 * recognise it too, without either kernel importing the other.
 */
export class SyncCommitConflict extends Error {
  constructor(readonly conflicts: readonly string[]) {
    super(`transaction rolled back: precondition failed at commit on ${conflicts.join(', ')}`)
    this.name = 'SyncCommitConflict'
  }
}
