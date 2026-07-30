/**
 * What one Outbox entry IS: the durable record, the attribution pair it carries,
 * and the dead-letter projection POD-316 recovers from.
 *
 * The record is the user's intent made durable (ADR 6 D4.3), so its field set is
 * governed by three decisions that pull in different directions and must all
 * hold at once:
 *
 * - **ADR 3 D7 / amendment D14, D17** — every entry records the principal it was
 *   authored under, as a PAIR: actor (which agent) and on-behalf-of (which
 *   human). The Outbox STORES this; it never computes it, and it never reads it
 *   from a command payload.
 * - **ADR 3 D8 / amendment D16** — and yet the record must carry NO capability,
 *   no "allow" bit and no rights snapshot, because rights are resolved LIVE over
 *   the delegation chain at every apply, including every replay. There is
 *   deliberately nowhere in this type to put one.
 * - **ADR 3 D4 / D5 + POD-352** — a secret never sits in an outbox payload. The
 *   structural guard is the delivery class (see `OutboxCommand`): `secret`
 *   policy ⇒ `online-sensitive` ⇒ not offline-eligible ⇒ cannot be enqueued at
 *   all.
 */

import type { MutationId, SessionId } from '@podium/protocol'
import type { OutboxRejectionReason, RecoveryPlan } from './reasons'
import type { OutboxState } from './states'

/**
 * The human a write is on behalf of. A plain string until POD-1075 lands the
 * model's `UserId` brand (ADR 4 Amendment 1 D9.1 owns that shape) — this module
 * must not mint a second brand for the same identity, and the pair below is what
 * carries the semantics in the meantime.
 */
export type UserRef = string

/**
 * The actor half of the attribution pair (amendment D17.1). Typed by KIND rather
 * than by a single id string: D17's rejected alternatives call out that one
 * `actor` field holding either a user or an agent forces every consumer into
 * prefix-typing an id, and the human-vs-agent question
 * (`humanQuestionAskedBy`, `nameSource` per [spec:SP-eb60]) must stay
 * answerable.
 */
export type OutboxActor =
  | { readonly kind: 'user'; readonly userId: UserRef }
  /** `Capability.actorSessionId` is the existing seam for the actor half
   *  (amendment D17.4). */
  | { readonly kind: 'agent-session'; readonly sessionId: SessionId }

/**
 * Attribution is a PAIR and is always shaped like one (amendment D17.2): for a
 * human on `trpc` the actor and the on-behalf-of are the same person, and the
 * pair is still recorded as a pair so consumers never branch on shape.
 *
 * Both halves come from the authenticated transport (D7/D14). Nothing in this
 * package derives either from `input`.
 */
export interface OutboxAttribution {
  readonly actor: OutboxActor
  readonly onBehalfOf: UserRef
}

/** True when the actor is an agent acting for a human — the case where the two
 *  halves are genuinely different identities (readiness §3.1.3 A3). */
export const isDelegated = (attribution: OutboxAttribution): boolean =>
  attribution.actor.kind === 'agent-session'

/**
 * ADR 3 D4's delivery classes. The Outbox may hold exactly one of them.
 * `online-only` and `online-sensitive` "must not list `outbox` in exposure"
 * (D4 rule 3), and D4 rule 1 makes `secret` policy imply `online-sensitive` —
 * which is what makes "secrets are never queued" a structural property here
 * rather than a convention someone remembers.
 */
export const OUTBOX_DELIVERY_CLASSES = [
  'offline-eligible',
  'online-only',
  'online-sensitive',
] as const
export type OutboxDeliveryClass = (typeof OUTBOX_DELIVERY_CLASSES)[number]

/** The only delivery class an entry may be enqueued under. */
export const ENQUEUEABLE_DELIVERY: OutboxDeliveryClass = 'offline-eligible'

/**
 * What the caller asks the Outbox to deliver. `delivery` is the contract's class
 * (POD-311 owns contracts; the Outbox only consumes the classification) and is
 * narrowed at the type level, so an `online-sensitive` contract cannot even be
 * spelled into `enqueue` — with a runtime refusal behind it for the untyped
 * boundaries.
 */
export interface OutboxCommand {
  /** Dotted contract name, e.g. `issues.close` (ADR 3 D1). */
  readonly name: string
  /** Contract version (ADR 3 D1). Stored so a replay is judged against the
   *  version the user authored under. */
  readonly version: number
  readonly delivery: typeof ENQUEUEABLE_DELIVERY
}

/**
 * The durable user confirmation for a deliberately out-of-scope write (ADR 3 D2
 * confirmation rules / D8 outcome 3: "`confirm-required` WITHOUT a durable user
 * confirmation on the envelope → `rejected`").
 *
 * **The NAME is provisional and POD-311 owns it**; the SEMANTICS are decided —
 * the confirmation rides the envelope, and therefore has to be durable with the
 * entry, because an offline out-of-scope write that lost its confirmation would
 * be refused at apply.
 *
 * It is declared exactly ONCE, as a key constant plus a mapped type, so the
 * rename POD-311 will make is a one-line change here rather than a hunt through
 * the record, the envelope, the enqueue request and the recovery path. Production
 * code reads and writes it through `confirmationOf` / `CONFIRMED` and never spells
 * the key; tests spell it deliberately, because pinning the wire shape is their
 * job.
 */
export const CONFIRMATION_FIELD = 'confirmed' as const
export type EnvelopeConfirmation = { readonly [K in typeof CONFIRMATION_FIELD]?: true }

/** Carry the confirmation across, or nothing at all — never a key with an
 *  `undefined` value, which would serialise into the durable record. */
export const confirmationOf = (source: EnvelopeConfirmation): EnvelopeConfirmation =>
  source[CONFIRMATION_FIELD] === undefined ? {} : { [CONFIRMATION_FIELD]: true }

export const CONFIRMED: EnvelopeConfirmation = { [CONFIRMATION_FIELD]: true }

/**
 * The expected-revision precondition (ADR 3 D13), carried the same way as the
 * confirmation above: through a helper whose RETURN TYPE is the narrow type.
 *
 * Not a conditional spread at the call site, and the reason is a soundness hole
 * rather than taste. TypeScript excess-property checking does not reach a key
 * supplied INSIDE a conditional spread — `{ req, ...(cond ? { bogus: 1 } : {}) }`
 * compiles clean, and `satisfies` does not rescue it — while a key written directly
 * IS checked, and a type MISMATCH inside a spread still is. So a producer built from
 * conditional spreads keeps emitting a field the model has renamed or deleted with
 * nothing going red: exactly the drift this programme exists to delete. Verified in
 * this module, not assumed (POD-279 fan-out, corrected rule).
 *
 * Inside this helper the literal is checked against the declared return type, and at
 * the call site spreading a `RevisionPrecondition` cannot introduce a key that type
 * does not have. Absent-vs-present still matters — an entry with no precondition
 * must not serialise one — which is why this is a helper and not simply a required
 * field.
 */
export type RevisionPrecondition = { readonly expectedRevision?: number }

export const revisionOf = (source: RevisionPrecondition): RevisionPrecondition =>
  source.expectedRevision === undefined ? {} : { expectedRevision: source.expectedRevision }

export const revisionOfValue = (expectedRevision: number | undefined): RevisionPrecondition =>
  expectedRevision === undefined ? {} : { expectedRevision }

/**
 * One durable Outbox entry.
 *
 * `input` is the author's own intent, verbatim — it is what makes dead-letter
 * recovery possible (D9 invariant 1: user-authored work is never silently
 * discarded) and it is also the ONLY payload the record holds: no Authority
 * state, no target content, nothing the author did not already have.
 */
export interface OutboxRecord extends EnvelopeConfirmation {
  /** Client-minted idempotency key; also the dedupe key at the Authority
   *  (ADR 2 D8 / ADR 3 D11). */
  readonly mutationId: MutationId
  readonly command: OutboxCommand
  readonly input: unknown
  /** ADR 3 D13 / ADR 2 D3: the expected-revision precondition, when the
   *  contract's ownership-matrix row uses expected-revision concurrency. A
   *  stale value is an Authority REJECTION surfaced through this state machine,
   *  never a replica-side drop. */
  readonly expectedRevision?: number
  /** ADR 3 D12: FIFO within this key, concurrent across keys. The Outbox stores
   *  the key; the contract's target extractor computes it (POD-311/POD-371). */
  readonly partitionKey: string
  readonly attribution: OutboxAttribution
  // The out-of-scope confirmation arrives via `EnvelopeConfirmation` above —
  // declared once so POD-311's rename is one line.
  readonly state: OutboxState
  readonly queuedAt: number
  /** Number of drain attempts so far. It drives D10's exponential backoff and is
   *  deliberately NOT a ceiling: D10 forbids a global attempt limit, because a
   *  limit turns user work into silent failure. The age limit is the only bound. */
  readonly attempts: number
  readonly lastAttemptAt?: number
  /**
   * Earliest time the next attempt may be made — D10's exponential backoff, set
   * when a TRANSIENT failure requeues the entry (`backoffDelayMs`).
   *
   * Durable rather than in-memory on purpose: a reconnect burst or a process
   * restart would otherwise reset the spacing to zero and hammer an Authority
   * that is already struggling, which is the failure mode backoff exists to
   * prevent. It never extends the entry's life — `isAgedOut` measures from
   * `queuedAt`, so an entry whose next attempt falls beyond the horizon expires
   * instead of sleeping through it.
   */
  readonly nextAttemptAt?: number
  readonly acceptedAt?: number
  readonly appliedAt?: number
  /** Set when the entry reached `rejected` or `expired`. */
  readonly reason?: OutboxRejectionReason
  readonly deadLetteredAt?: number
  readonly cancelledAt?: number
  /** Which of D9's two paths parked it — the only thing a dead-letter record
   *  says about how it got there beyond the reason code. */
  readonly parkedFrom?: 'rejected' | 'expired'
}

/**
 * The dead-letter record POD-316 recovers from: enough to REBUILD THE USER'S
 * INTENT, and deliberately nothing more.
 *
 * Privacy (readiness §3.1.1, brief point 4): a dead-letter entry is personal
 * state belonging to the principal who authored it. It may be parked against an
 * entity its author can no longer see — the record still lets them recover their
 * own text, because everything in it is either their own input or a code, and
 * none of it is target content.
 */
export interface DeadLetterRecord {
  readonly mutationId: MutationId
  readonly command: OutboxCommand
  /** The author's own input, verbatim: this is the recoverable intent. */
  readonly input: unknown
  readonly expectedRevision?: number
  readonly attribution: OutboxAttribution
  readonly queuedAt: number
  readonly deadLetteredAt: number
  readonly parkedFrom: 'rejected' | 'expired'
  readonly reason: OutboxRejectionReason
  /** Derived from `reason.code` alone (see `recoveryPlanFor`) — so two entries
   *  with the same code offer the same affordances, which is what keeps the
   *  recovery surface free of an existence oracle. */
  readonly recovery: RecoveryPlan
  readonly attempts: number
}

/** Is this record visible in `forUser`'s recovery UI? Ownership of a
 *  dead-letter entry is the on-behalf-of half: the actor may be a retired agent
 *  session, the human is who the work belongs to (readiness §3.1.3 A4). */
export const belongsTo = (record: OutboxRecord, forUser: UserRef): boolean =>
  record.attribution.onBehalfOf === forUser
