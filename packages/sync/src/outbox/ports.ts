/**
 * The Outbox role's ports and its observable events. Everything the Outbox needs
 * from the world is injected here, so the kernel stays infrastructure-neutral
 * (ADR 6 D3: one storage port, platform adapters behind it; the kernel never
 * imports IndexedDB or SQLite) and the whole lifecycle is testable in memory.
 */

import type { MutationId } from '@podium/protocol'
import type { AuthorityRefusal, OutboxRejectionReason } from './reasons'
import type { DeadLetterRecord, EnvelopeConfirmation, OutboxRecord, UserRef } from './records'

/**
 * What actually goes on the wire for one attempt.
 *
 * **There is no identity on this envelope, and that is the point.** ADR 3 D7:
 * the principal comes only from the authenticated transport — the submit port
 * closes over that transport. Amendment D14.3 strengthens it: a delegation is a
 * server-minted reference, and an envelope field naming a user, an agent or a
 * delegation is informational at best and an impersonation primitive at worst.
 * Amendment D16 adds the other half: rights are resolved LIVE over the
 * delegation chain at every apply, so there is deliberately nowhere here (and
 * nowhere on `OutboxRecord`) to put a capability that a replay could re-present.
 * A revoked human's queued work therefore cannot be drained with stale rights —
 * not because the drain remembers to re-check, but because it has nothing to
 * re-present.
 */
export interface OutboxEnvelope extends EnvelopeConfirmation {
  readonly mutationId: MutationId
  readonly command: string
  readonly version: number
  readonly input: unknown
  readonly expectedRevision?: number
  // The out-of-scope confirmation rides here via `EnvelopeConfirmation` (ADR 3
  // D8 outcome 3 / D2). It is not identity — it is a decision the USER made,
  // which is why it may ride the envelope while a principal may not.
}

/**
 * The outcome of one submit attempt.
 *
 * The `unreachable` / `rejected` split is the one classification the adapter owns
 * and must get right, because it decides between D9 invariant 4 (stay in
 * `queued`, retry forever until the age limit) and D10 (definitive: zero
 * automatic retries). A THROWN error is treated as `unreachable` — the
 * conservative direction: a misclassified transport blip costs a retry, whereas a
 * misclassified refusal would silently retry a poison entry forever.
 */
export type OutboxSubmitOutcome =
  /** The Authority accepted the envelope for processing; apply will follow (D9's
   *  optional hop — report `applied` directly when the hop is atomic). */
  | { readonly kind: 'accepted' }
  /** The Authority applied the command and recorded a receipt. */
  | { readonly kind: 'applied' }
  /** A DEFINITIVE refusal — policy, conflict or validation, never transport. */
  | { readonly kind: 'rejected'; readonly refusal: AuthorityRefusal }
  /** Network failure or an unreachable Authority (D9 invariant 4). */
  | { readonly kind: 'unreachable' }

export interface OutboxSubmitPort {
  /** Submit one envelope over an AUTHENTICATED transport. Apply-time
   *  re-authorization happens at the Authority on every drain including replay
   *  (D8/D16); this port carries no rights of its own. */
  submit(envelope: OutboxEnvelope): Promise<OutboxSubmitOutcome>
}

/**
 * Durable home for the queue (ADR 6 D1: transactional IndexedDB on web, SQLite
 * on mobile, in-memory for tests — never localStorage/AsyncStorage).
 *
 * `write` takes the whole record set on purpose: a partial write is then not
 * representable at the port, which is the cheapest way to honour D4.1 (one
 * storage transaction) and D4.3 (outbox entries are durable on the same footing
 * as entity rows). Adapters that batch the outbox together with entity rows,
 * cursor and overlay compose this call into that one transaction (POD-374/375).
 */
export interface OutboxStorePort {
  /** Reject (or throw) when the store is genuinely unreadable. That is the ONE
   *  case where user work is lost (ADR 2 D7), and the Outbox makes it loud
   *  rather than starting quietly empty. */
  read(): Promise<readonly OutboxRecord[]>
  /** Enroll this write in `span` when one is supplied, so it lands in the same
   *  native transaction as the entity rows and the cursor advance (ADR 2 D10).
   *  Without a span it is its own transaction — see `SyncUnitOfWork` rule 3 on
   *  why that is a surfaced degraded mode rather than the normal path. */
  write(records: readonly OutboxRecord[], span?: SyncSpan): Promise<void>
}

/**
 * The observable lifecycle. Three of these exist because ADR 3 D9 distinguishes
 * three things the shipped interim outbox collapsed into "it worked":
 *
 * - `local-ack` — durably queued HERE. Nothing has been told to anyone yet.
 * - `accepted`  — the Authority took the envelope for processing.
 * - `applied`   — the Authority applied it and recorded a receipt.
 */
export type OutboxEvent =
  /** Durably persisted locally. Emitted only after the store commit resolved —
   *  a local ack that outran its own durability would be a lie. */
  | { readonly type: 'local-ack'; readonly mutationId: MutationId }
  | { readonly type: 'sending'; readonly mutationId: MutationId }
  | { readonly type: 'accepted'; readonly mutationId: MutationId }
  | { readonly type: 'applied'; readonly mutationId: MutationId }
  /** Back to `queued` — transport, not verdict (D9 invariant 4). */
  | { readonly type: 'requeued'; readonly mutationId: MutationId }
  | {
      readonly type: 'rejected'
      readonly mutationId: MutationId
      readonly reason: OutboxRejectionReason
    }
  | {
      readonly type: 'expired'
      readonly mutationId: MutationId
      readonly reason: OutboxRejectionReason
    }
  /** Parked for user recovery (D9 invariant 2). Carries the record POD-316
   *  renders. */
  | { readonly type: 'dead-lettered'; readonly record: DeadLetterRecord }
  | { readonly type: 'cancelled'; readonly mutationId: MutationId }
  /** Retired after covering truth landed (D9 invariant 1's second licence). */
  | { readonly type: 'retired'; readonly mutationId: MutationId }
  /**
   * The store could not be read. ADR 2 D7: "the sole case where user work is
   * lost is a genuinely unreadable outbox store — and that loss must be loud."
   */
  | { readonly type: 'store-unreadable'; readonly error: unknown }

export interface OutboxConfig {
  readonly store: OutboxStorePort
  readonly submit: OutboxSubmitPort
  /**
   * The AUTHENTICATED principal this Outbox instance belongs to — the human whose
   * work it may see, drain and recover (ADR 3 D7/D14: derived from the transport
   * by the caller, never from a payload).
   *
   * Binding the instance is what makes privacy structural rather than filtered
   * (readiness §3.1.1): every observation API is scoped to this value, so there
   * is no query another principal could phrase to reach this author's dead
   * letters or pending work. A physical store shared by two principals yields two
   * bound instances, each blind to the other's entries and neither able to drop
   * them.
   */
  readonly principal: UserRef
  readonly now: () => number
  /**
   * Age ceiling from `queuedAt` (ADR 3 D10). REQUIRED, with no default here:
   * D10 is the sole owner of the value (14 days, with `SKEW_MARGIN_MS ≥ 2d`) and
   * D11's inequality against ADR 2's receipt retention must be enforced by a
   * lint that IMPORTS the receipt constant. POD-371 owns both the constant and
   * that lint; minting a second default in this module is exactly the drift
   * D11.3 warns about.
   */
  readonly maxAgeMs: number
  /**
   * Mints ids for re-issues that may not reuse the old one (D11.4: after
   * `expired`, a receipt may still exist for the original id).
   */
  readonly newMutationId: () => MutationId
  /**
   * Called when the store is unreadable. REQUIRED, not optional: making the one
   * data-loss path a mandatory parameter is how "it must be loud" becomes a
   * compile-time obligation instead of a log line someone forgets to wire.
   */
  readonly onStoreUnreadable: (error: unknown) => void
  /**
   * A listener registered BEFORE `open()` does anything. `subscribe()` cannot see
   * the events open emits — the unreadable-store report and the crash
   * reconciliation both happen before any caller has a handle — and an event
   * nobody can observe is not a report.
   */
  readonly onEvent?: (event: OutboxEvent) => void
  /**
   * Optional: join the Replica's commit so entity rows, the cursor advance and an
   * outbox retirement are ONE atomic span (ADR 2 D10 / ADR 6 D4.1). Absent, every
   * write is its own transaction — exactly the previous behaviour, which is why
   * wiring this changes no kernel contract.
   */
  readonly unitOfWork?: SyncUnitOfWork
}

/**
 * The shared unit-of-work seam for the crash window ADR 2 D10 forbids.
 *
 * The defect it closes is invisible from inside either kernel module: the Replica
 * commits entity + cursor and retires its overlay post-commit, while the Outbox
 * retires an applied entry in a separate write. Each is correct against its own
 * ADR clauses; the torn state exists only in the JOIN — a crash between them
 * leaves a replica past a revision whose command the outbox still believes is in
 * flight, or the reverse.
 *
 * **Shape agreed by POD-370 and POD-369** (coordinator ruling, POD-279 fan-out;
 * POD-369's three amendments to POD-370's opening proposal were accepted):
 *
 * 1. **Enrollment is EXPLICIT.** The span is threaded into the participant call
 *    and on into the store write — `outbox.retireApplied(id, span)` →
 *    `store.write(records, span)`. POD-369's objection to the original ambient
 *    shape is decisive: wrapping unchanged kernel methods in `transact` does not
 *    make their inner store calls join the native transaction, and there is no
 *    portable ambient transaction in a browser runtime. A seam that silently
 *    fails to enroll is worse than one that changes a signature. Both span
 *    parameters are OPTIONAL, so no existing caller breaks.
 * 2. **`onCommit` as well as `onAbort`.** Participants STAGE their in-memory
 *    effects and publish them from `onCommit`; `onAbort` is the escape hatch for
 *    state that had to mutate eagerly. Without `onCommit` an observation escapes
 *    to an external subscriber before the outer span commits, and an emitted
 *    event cannot be un-emitted. Commit callbacks run in registration order after
 *    the durable commit; abort callbacks in reverse order after the durable
 *    abort; a callback failure is surfaced but cannot rewrite the already-decided
 *    durable outcome.
 * 3. **No silent per-write fallback on the durable path.** Leaving each write in
 *    its own transaction IS the D10 non-compliance, so it is legal only as ADR 2's
 *    explicitly surfaced degraded mode, never as normal POD-373 wiring. The
 *    in-memory adapter implements a real unit of work (see
 *    `InMemoryUnitOfWork`). The transaction body is constrained to same-span
 *    LOCAL STORAGE work: every authority/network await finishes before the span
 *    opens, because an IndexedDB transaction auto-closes on an unrelated await.
 *
 * Other properties: it is a PORT with no concrete storage in it, and neither
 * kernel module imports the other — both import only the neutral span type. It
 * carries no cause, rung, rescope or re-bootstrap parameter, and it never will:
 * it is not a place to smuggle back the replica→outbox edge that POD-369 and
 * POD-370 deliberately removed, and it is not a licence to widen either module's
 * authority. The Replica still never arbitrates; the Outbox still holds no
 * authorization state. Cache-only discard stays a separate capability and never
 * receives an outbox mutation.
 *
 * POD-305 (Authority) and POD-373 (cross-hop conformance) WIRE it; the kernel
 * modules only declare it and enroll into it. The crash-between-writes case
 * belongs in POD-373's suite against a real transaction — see
 * `docs/design/outbox-lifecycle-state-machine.md` for the case both halves owe it.
 */
export interface SyncUnitOfWork {
  /**
   * Run `body` as ONE atomic span over the local store. Every write enrolled with
   * the span it receives is durable together or not at all. Nested calls join the
   * ambient span rather than opening a second one.
   *
   * The body does LOCAL STORAGE WORK ONLY: an authority round trip inside it
   * would let an IndexedDB transaction auto-close (POD-369's amendment 3).
   */
  transact<T>(body: (span: SyncSpan) => Promise<T>): Promise<T>
}

export interface SyncSpan {
  /**
   * Publish in-memory effects (state adoption, event emission) that must become
   * visible only once the span is durably committed. Runs in registration order
   * after the commit.
   */
  onCommit(effect: () => void): void
  /**
   * Revert in-memory state a participant had to mutate eagerly. Runs in REVERSE
   * order after a durable abort.
   *
   * Durability alone is not enough: without these, an aborted span leaves the
   * participants consistent on disk and divergent in RAM. The Outbox stages
   * everything and needs only `onCommit`, but it registers an `onAbort` too —
   * a rollback that depends on an adapter calling you back is not a rollback, so
   * it also restores its own snapshot if `transact` rejects.
   */
  onAbort(revert: () => void): void
}

/**
 * NOTE ON ADR 2 D7 ("discard the cache, re-bootstrap, KEEP THE OUTBOX"): there is
 * deliberately **no** port, method or callback here through which a replica could
 * tell the Outbox that it re-bootstrapped, and therefore none through which it
 * could drop the queue.
 *
 * An earlier draft of this module offered `noteReplicaRebootstrapped(cause)` as a
 * contractual no-op, so the rule would be callable rather than only documented.
 * POD-369 (the Replica role) argued that out, and correctly: a no-op that takes
 * the queue as its subject is one edit away from not being a no-op, and under
 * private-by-default a rescope fires whenever anyone's shares change — so that
 * edit would be data loss on the NORMAL path. The Replica's cache-store port has
 * no outbox region at all, so `discardCache()` *cannot* reach the queue rather
 * than merely being forbidden to.
 *
 * The remaining question — should the Outbox re-evaluate stale `expectedRevision`
 * preconditions once new truth installs? — is answered NO by D7 itself: "the
 * replica does not get to decide the command is moot; that is arbitration".
 * A stale precondition is an Authority rejection surfaced through D9. So the
 * Outbox needs no reaction, and the dependency edge stays absent in both
 * directions. If telemetry ever wants the signal, the Replica's
 * `bootstrap-installed` event carries the cause (including the rescope-vs-resync
 * distinction D14.4 requires) and the Outbox can subscribe — Outbox → Replica,
 * never the reverse.
 */

/* The dead-letter surface takes no query object: `Outbox.deadLetters()` is scoped
 * to the instance's bound principal, so there is no caller-chosen `forUser` to
 * supply. The removed `DeadLetterQuery` type existed to be filtered by; a bound
 * view cannot be asked the wrong question in the first place. */
