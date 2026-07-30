/**
 * The Outbox lifecycle state machine — ADR 3 D9, which is the SOLE owner of this
 * vocabulary (`docs/adr/0003-command-security.md`). Every state name below is
 * D9's; none is minted here, and none is imported from another document. ADR 6
 * D4.3 only fixes the DURABILITY CLASS of these records (user intent not yet
 * accepted by the Authority is durable on the same footing as entity rows —
 * losing it on crash is a correctness bug, not degraded UX) and defers the names
 * to D9.
 *
 * This module is pure data + pure functions: the table IS the specification, so
 * "the transition table matches the ADR" is a diffable claim rather than a
 * property of control flow buried in a drain loop. `outbox.ts` is the only thing
 * that drives it.
 */

/** D9's eight states, in the ADR's own order. */
export const OUTBOX_STATES = [
  'queued',
  'sending',
  'accepted',
  'applied',
  'rejected',
  'expired',
  'dead-letter',
  'cancelled',
] as const
export type OutboxState = (typeof OUTBOX_STATES)[number]

/**
 * The four states D9 sets in bold. "Terminal" there means *the delivery attempt
 * is over* — it does NOT mean "no outgoing edge": D9 invariant 2 requires
 * `rejected` and `expired` to ALWAYS continue into `dead-letter`, and invariant
 * 3's recovery actions leave `dead-letter` again. So this set answers "will the
 * Authority do anything more with this envelope?", not "is this a sink?".
 */
export const TERMINAL_OUTBOX_STATES = ['rejected', 'expired', 'dead-letter', 'cancelled'] as const
export type TerminalOutboxState = (typeof TERMINAL_OUTBOX_STATES)[number]

export const isTerminalOutboxState = (state: OutboxState): state is TerminalOutboxState =>
  (TERMINAL_OUTBOX_STATES as readonly OutboxState[]).includes(state)

/**
 * The causes that move an entry. Named for what HAPPENED, not for the state it
 * lands in, so the table below reads as "cause × state → state" and a cause
 * that is illegal in a state is a missing cell rather than a silent no-op.
 */
export const OUTBOX_TRANSITIONS = [
  /** A drain attempt started (`queued` → `sending`). */
  'drain-started',
  /**
   * The Authority could not be reached, or reached and never reported back.
   * D9 invariant 4: network / unreachable-authority failures stay in `queued`
   * (or RETURN to `queued` from `sending`) — they are NOT `rejected`.
   *
   * `accepted` → `queued` is included deliberately. D9 invariant 4 names only
   * `sending`, but an `accepted` entry whose apply notification is lost has
   * suffered exactly the same class of failure, and the alternative is an entry
   * that waits forever — which is invariant 1's "gone" hazard wearing the
   * opposite coat (work the user can neither see resolved nor recover). The
   * replay is safe because the `mutationId` is unchanged: inside the receipt
   * window D11.7 returns the stored result without re-running, and outside it
   * D11.8/expiry is what refuses the send.
   */
  'transport-failed',
  /** The Authority accepted the envelope for processing but has not applied it
   *  (D9's optional hop; collapses into `applied` when accept and apply are
   *  atomic — then `authority-applied` fires straight out of `sending`). */
  'authority-accepted',
  /** The Authority applied the command and recorded a receipt. */
  'authority-applied',
  /** A DEFINITIVE refusal: validation, policy (including an apply-time
   *  re-authorization denial per D8/D16), or conflict. Never a transport
   *  failure. D10: zero automatic retries. */
  'authority-rejected',
  /** D10: the entry exceeded its max age before a successful apply. */
  'aged-out',
  /** D9 invariant 2: a rejected or expired entry enters the recovery surface. */
  'parked',
  /** D9 invariant 3 recovery: retry (after a user edit or a RIGHTS FIX) or edit
   *  (revise input → new attempt) puts the work back in the queue. */
  'user-retried',
  /** D9 invariant 3 recovery: discard. Also reachable straight from `queued` —
   *  invariant 1 licenses "gone" on USER ACTION, and cancelling a write you can
   *  still see pending is the plainest form of that. */
  'user-discarded',
] as const
export type OutboxTransition = (typeof OUTBOX_TRANSITIONS)[number]

/**
 * ADR 3 D9's transition table. Every cell cites the decision that puts it here;
 * an absent cell is an ILLEGAL transition, and `applyOutboxTransition` refuses
 * it rather than coercing the state.
 */
export const OUTBOX_TRANSITION_TABLE: {
  readonly [S in OutboxState]: { readonly [T in OutboxTransition]?: OutboxState }
} = {
  queued: {
    'drain-started': 'sending',
    'aged-out': 'expired', // D10: "Age exceeded | queued/sending → expired"
    'user-discarded': 'cancelled', // D9 invariant 1: gone on user action
  },
  sending: {
    'transport-failed': 'queued', // D9 invariant 4
    'authority-accepted': 'accepted',
    'authority-applied': 'applied', // accept ≡ apply when the hop is atomic
    'authority-rejected': 'rejected',
    'aged-out': 'expired', // D10
  },
  accepted: {
    'transport-failed': 'queued', // see 'transport-failed' above
    'authority-applied': 'applied',
    'authority-rejected': 'rejected',
  },
  // `applied` leaves the store by RETIREMENT, not by transition: D9 invariant 1
  // permits "gone" only on user action or "successful `applied` retirement after
  // covering truth". Today's `awaiting-truth` is that sub-stage of `applied`,
  // not a ninth state.
  applied: {},
  rejected: {
    parked: 'dead-letter', // D9 invariant 2
  },
  expired: {
    parked: 'dead-letter', // D9 invariant 2
  },
  'dead-letter': {
    'user-retried': 'queued', // D9 invariant 3
    'user-discarded': 'cancelled', // D9 invariant 3
  },
  // `cancelled` is the user's own decision, already recorded. Nothing may move
  // an entry out of it; removal is a purge, not a transition.
  cancelled: {},
}

/** The states a drain pass may pick up. `accepted` is absent: it is resolved by
 *  an apply notification or returned to `queued` by `transport-failed` first. */
export const isDrainable = (state: OutboxState): boolean => state === 'queued'

export const nextOutboxState = (
  from: OutboxState,
  transition: OutboxTransition,
): OutboxState | undefined => OUTBOX_TRANSITION_TABLE[from][transition]

/**
 * Apply one transition. Throws on an illegal cell — a state machine that
 * silently ignores an impossible move is how an entry ends up "gone" without
 * anybody deciding it, which is the exact failure D9 invariant 1 forbids
 * (POD-279 finding 8).
 */
export const applyOutboxTransition = (
  from: OutboxState,
  transition: OutboxTransition,
): OutboxState => {
  const next = nextOutboxState(from, transition)
  if (next === undefined) {
    throw new Error(`illegal outbox transition: ${from} --${transition}-->`)
  }
  return next
}
