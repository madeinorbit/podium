/**
 * The Outbox role's ports and its observable events. Everything the Outbox needs
 * from the world is injected here, so the kernel stays infrastructure-neutral
 * (ADR 6 D3: one storage port, platform adapters behind it; the kernel never
 * imports IndexedDB or SQLite) and the whole lifecycle is testable in memory.
 */

import type { MutationId } from '@podium/protocol'
import type { AuthorityRefusal, OutboxRejectionReason } from './reasons'
import type { DeadLetterRecord, OutboxRecord, UserRef } from './records'

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
export interface OutboxEnvelope {
  readonly mutationId: MutationId
  readonly command: string
  readonly version: number
  readonly input: unknown
  readonly expectedRevision?: number
  /** ADR 3 D8 outcome 3 / D2: the durable confirmation for a deliberately
   *  out-of-scope write. Not identity — a decision the user made, which is why
   *  it may ride the envelope while a principal may not. */
  readonly confirmed?: true
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
  write(records: readonly OutboxRecord[]): Promise<void>
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

/** Everything a caller may ask for by user — the dead-letter surface is
 *  principal-scoped by construction (see `Outbox.deadLetters`). */
export type DeadLetterQuery = { readonly forUser: UserRef }
