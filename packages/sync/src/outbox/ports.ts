/**
 * The Outbox role's ports and its observable events. Everything the Outbox needs
 * from the world is injected here, so the kernel stays infrastructure-neutral
 * (ADR 6 D3: one storage port, platform adapters behind it; the kernel never
 * imports IndexedDB or SQLite) and the whole lifecycle is testable in memory.
 */

import type { MutationId } from '@podium/protocol'
import type { SyncSpan } from '../span'
import type { BackoffPolicy } from './limits'
import type { AuthorityRefusal, OutboxRejectionReason } from './reasons'
import type { DeadLetterRecord, EnvelopeConfirmation, OutboxRecord, UserRef } from './records'
import type { OutboxState } from './states'

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
 * Writes are RECORD-LEVEL (`apply`), not whole-snapshot — see the note on
 * `apply` for why that distinction is a data-loss bug and not a taste. D4.3 puts
 * these records in the same durability class as entity rows, and adapters that
 * batch the outbox with entity rows, cursor and overlay enroll them in one
 * transaction through the span (POD-374/375).
 */
export interface OutboxStorePort {
  /** Reject (or throw) when the store is genuinely unreadable. That is the ONE
   *  case where user work is lost (ADR 2 D7), and the Outbox makes it loud
   *  rather than starting quietly empty. */
  read(): Promise<readonly OutboxRecord[]>
  /**
   * Apply RECORD-LEVEL changes. Not a whole-snapshot write, and the difference is
   * a data-loss bug rather than a style preference: a snapshot write expresses
   * "the store now contains exactly these records", so any writer holding a
   * stale base silently deletes rows it never knew about. Two principal-bound
   * instances over one physical store (which the privacy model explicitly
   * supports) then clobber each other's queued work, and two retirements
   * enrolled in one span resurrect the first one.
   *
   * `put` inserts or replaces by `mutationId`; `remove` deletes by id. Everything
   * the store holds and the mutation does not mention is untouched.
   *
   * **Insertion order is part of the contract**: a first `put` appends, a
   * replacing `put` keeps the record's existing position. FIFO within an ordering
   * partition (ADR 3 D12) is expressed as record order, so an adapter must keep it
   * — an autoincrement column, or IndexedDB key order.
   *
   * Enroll in `span` when one is supplied, so this lands in the same native
   * transaction as the entity rows and the cursor advance (ADR 2 D10). Without a
   * span it is its own transaction — see `SyncUnitOfWork` rule 3 on why that is a
   * surfaced degraded mode rather than the normal path.
   */
  apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<OutboxApplyResult>
}

/**
 * Record-level changes for `OutboxStorePort.apply`, with the PRECONDITIONS that
 * make validate-and-apply one operation.
 *
 * Why preconditions and not just a delta: a delta stops a stale writer from
 * deleting rows it never knew about, but it does NOT stop two writers from
 * interleaving a read-modify-write of the SAME row. Per-instance serialization
 * cannot help — the other writer is another Outbox instance or another browser
 * tab. ADR 6 D4.6 asks for exactly this: "adapters SHOULD use a single-writer or
 * VERSION-CHECK pattern so two tabs do not interleave non-transactional
 * read-modify-write of the same logical record."
 *
 * So every mutation declares what it believed when it staged, and the adapter
 * checks those beliefs ATOMICALLY with the write. A stale mutation is refused,
 * not applied — and the kernel then re-stages against fresh truth before any
 * local ack or event escapes.
 */
export interface OutboxStoreMutation {
  readonly put?: readonly OutboxRecord[]
  readonly remove?: readonly MutationId[]
  /**
   * Checked atomically with the write; an unmet expectation is a conflict.
   *
   * REQUIRED, and it must cover every key in `put` and `remove`. Optional would be
   * a hole: a future caller could reintroduce an unconditional apply through a
   * perfectly well-typed mutation, and the adapter would read the omission as "no
   * checks" — which is exactly the race this field exists to close. An empty array
   * is legal only for a mutation that touches nothing.
   */
  readonly expect: readonly OutboxRecordExpectation[]
}

/**
 * What the mutation believed about one record when it staged: the state it was in,
 * or `'absent'` when it must not exist yet (which is how `mutationId` uniqueness
 * becomes a real guarantee rather than a check that races).
 */
export interface OutboxRecordExpectation {
  readonly mutationId: MutationId
  readonly expect: OutboxState | 'absent'
}

/**
 * The outcome of an apply. A conflict is a RESULT, not an exception: it is an
 * ordinary concurrent-writer outcome the kernel resolves by re-staging, and
 * typing it as a value keeps it distinguishable from a storage failure (quota,
 * closed database) which is a throw.
 */
export type OutboxApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly conflicts: readonly MutationId[] }

/**
 * ADR 2 D10's unit of work is defined ONCE, in `../span`, and re-exported here so
 * the Outbox's own modules keep importing it from their ports file (POD-1146).
 *
 * It used to be declared here as well, under the same name and with a different
 * shape — `onCommit(adopt)` against the Replica's `join(participant)`. Both were
 * this seam; neither was a whole port. See `../span` for the role and phase split
 * that made them one, and for why the outbox's `onCommit`-only asymmetry survives
 * intact next to a participant `discard` hook.
 */
export type { OwnedSyncSpan, SyncSpan, SyncSpanParticipant, SyncUnitOfWork } from '../span'
export { SyncCommitConflict } from '../span'

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
   * D10's per-command override, keyed by contract name (`command.name`). It may
   * only SHORTEN — a lock acquire that is worthless after a minute has no
   * business sitting in a queue for two weeks. A value ABOVE `maxAgeMs` is
   * refused at `open()` rather than clamped: lengthening is legal only in the
   * same change that raises ADR 2's receipt retention, so a config that asks for
   * it is asking to break D11's inequality and must hear about it.
   *
   * The kernel holds no table of its own. Which contract gets which age is
   * contract vocabulary (POD-311); this is the seam that carries it.
   */
  readonly commandMaxAgeMs?: Readonly<Record<string, number>>
  /**
   * D10's transient-retry spacing. Defaults to `TRANSIENT_BACKOFF` (start 1s,
   * factor 2, cap 60s) — a spacing choice with no cross-ADR constraint on it,
   * unlike `maxAgeMs`, which participates in an inequality against a constant
   * this package cannot see and therefore has no default.
   */
  readonly backoff?: BackoffPolicy
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
  // There is deliberately NO `unitOfWork` here. Enrollment in a transaction is a
  // per-call decision expressed by passing a `SyncSpan` to `retireApplied` /
  // `retireAllApplied` — see `SyncUnitOfWork`. A configured coordinator would be a
  // port with no reads: the kernel opens no transaction of its own, so wiring one
  // here would have no effect while the config told an integrator otherwise.
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
