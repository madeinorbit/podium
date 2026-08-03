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

import {
  type ActorRef,
  type AgentActor,
  type Attribution,
  agentIdentityFromSessionId,
  sessionIdFromAgentIdentity,
} from '@podium/model'
import type { MutationId, SessionId } from '@podium/protocol'
import type { OutboxRejectionReason, RecoveryPlan } from './reasons'
import type { OutboxState } from './states'

/**
 * A user, as the parts of this package that are NOT the attribution pair still
 * spell one: grant tables, send queues, audiences, and the principal an Outbox
 * is bound to.
 *
 * IT NO LONGER DESCRIBES EITHER HALF OF THE PAIR, and that is the POD-1148
 * change. Both halves are now the model's `UserId` — branded — because the pair
 * below is composed from `@podium/model`'s `Attribution` rather than restated
 * here. The old comment on this alias ("a plain string until POD-1075 lands the
 * model's `UserId` brand … this module must not mint a second brand for the
 * same identity") was right about the rule and is now satisfied by IMPORTING the
 * brand instead of waiting for it.
 *
 * What is still deliberately unbranded is everything else: `FeedPrincipal`, the
 * grant sets, the bounded send queues. POD-1075 owns sweeping that surface in
 * one pass (readiness §3.2: a schema is not swept twice), and branding it as a
 * side effect of an attribution change would be exactly that second sweep. A
 * `UserId` reads as a `UserRef` on the way out, so the two coexist without a
 * cast until then. See `docs/agents/pod-1148-one-attribution-vocabulary.md`.
 */
export type UserRef = string

/**
 * The actor half of the attribution pair (amendment D17.1) — THE MODEL'S
 * `ActorRef`, narrowed, not a second union.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A NARROWING AND NOT A DELETION (POD-1148)
 * ---------------------------------------------------------------------------
 *
 * This used to be a locally-declared two-arm union whose agent arm was
 * `{ kind: 'agent-session'; sessionId: SessionId }`, against the model's
 * `{ kind: 'agent'; id: AgentIdentityId }`. That looked like two facts — a
 * session is not an agent identity — so the two pairs could not simply be
 * merged on the strength of a shared name.
 *
 * **POD-1164 measured it and they are one fact.** For a Podium agent session
 * `AgentIdentityId` and `SessionId` are the SAME minted string: the sole
 * production mint is `asAgentIdentityId(sessionId)` at every spawn / receipt
 * path in `apps/daemon/src/binding-store.ts`. The brands distinguish ROLE
 * (axis-2 actor vs axis-1 work), not a second id space. So neither spelling was
 * wrong and neither is a "loser" — the model's is the FIELD SCHEMA
 * (`packages/model/src/fields/attribution.ts` says so in its own header), this
 * is a projection of it, and `sessionIdFromAgentIdentity` below is the seam
 * that recovers the session spelling for the consumers that need it.
 *
 * The narrowing itself is a POLICY, in the same sense `inbox.ts`'s narrower pair
 * is one: the Outbox is a CLIENT-side queue of a principal's own intent, so only
 * the two arms that have a human behind them can author an entry. A `machine`
 * observation and a `system` job never queue client work, which is also what
 * makes `onBehalfOf` below non-nullable here while it is nullable on the
 * durable field. Adding an arm is an ADR 9 D1 question, not a convenience — and
 * because this is `Extract` over the model's union rather than a copy of two of
 * its members, a fifth kind there cannot silently appear here.
 */
export type OutboxActor = Extract<ActorRef, { kind: 'user' | 'agent' }>

/**
 * The session spelling of an agent actor — `Capability.actorSessionId` is the
 * existing seam for the actor half (amendment D17.4), and this is how a consumer
 * that walks sessions gets there from the stored pair.
 *
 * A named reclassification, never a cast and never a lookup: POD-1164's whole
 * point is that call sites must not be able to invent a second id space by
 * accident. Returns `null` for a human actor, who has no session.
 */
export const actorSessionIdOf = (actor: OutboxActor): SessionId | null =>
  actor.kind === 'agent' ? sessionIdFromAgentIdentity(actor.id) : null

/**
 * The inverse, for the producers that hold a `SessionId` — the transport knows
 * the connection, and this is the one supported way to spell it as an actor.
 */
export const agentActorOfSession = (sessionId: SessionId): AgentActor => ({
  kind: 'agent',
  id: agentIdentityFromSessionId(sessionId),
})

/**
 * Attribution is a PAIR and is always shaped like one (amendment D17.2): for a
 * human on `trpc` the actor and the on-behalf-of are the same person, and the
 * pair is still recorded as a pair so consumers never branch on shape.
 *
 * Both halves come from the authenticated transport (D7/D14). Nothing in this
 * package derives either from `input`.
 *
 * It EXTENDS the model's `Attribution` rather than restating it, which is what
 * makes "one definition" load-bearing instead of a comment: an `OutboxAttribution`
 * is assignable to an `Attribution` by construction, and a change to the field
 * schema that this narrowing cannot satisfy is a compile error here rather than
 * a drift nobody notices. `onBehalfOf` is non-nullable for the reason given on
 * `OutboxActor`: both arms an outbox entry may carry have a human behind them.
 */
export interface OutboxAttribution extends Attribution {
  readonly actor: OutboxActor
  readonly onBehalfOf: NonNullable<Attribution['onBehalfOf']>
}

/** True when the actor is an agent acting for a human — the case where the two
 *  halves are genuinely different identities (readiness §3.1.3 A3). */
export const isDelegated = (attribution: OutboxAttribution): boolean =>
  attribution.actor.kind === 'agent'

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

/** POD-785's collapse key, carried the same way and for the same reason as the
 *  revision precondition above: absent-vs-present is meaningful (absent means
 *  NEVER collapse), so it must not serialise as a key with an `undefined` value. */
export type CollapseKey = { readonly collapseKey?: string }

export const collapseKeyOf = (source: CollapseKey): CollapseKey =>
  source.collapseKey === undefined ? {} : { collapseKey: source.collapseKey }

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
  /**
   * POD-785. Present only on a write whose contract declares that a LATER write
   * bearing the same key, in the same partition, fully subsumes it — a read
   * receipt for one issue, say. Absent means "never collapse", which is the
   * default for every command and the only setting a content-bearing one may
   * have.
   *
   * The key is the STATE CELL the write lands on, not the command: `markRead`
   * and `markUnread` for the same issue both write that issue's read state, so
   * they share a key and the newest wins — which is exactly what the user's last
   * click meant. It is computed by the contract's target extractor beside the
   * partition key, never inferred from `input` by this package.
   */
  readonly collapseKey?: string
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
