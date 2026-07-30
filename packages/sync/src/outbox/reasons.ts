/**
 * Rejection reason codes and the recovery affordances they license — ADR 3 D9
 * invariants 2 and 3, D10, and the amendment's D16.4 / property 15.
 *
 * Two rules shape everything here:
 *
 * 1. **A rights denial must be distinguishable from a conflict** (D16.4): their
 *    recovery differs — a conflict can be rebased or edited and retried, an
 *    authorization denial can only be retried after a RIGHTS FIX. POD-316's
 *    reject-and-rebase UX consumes that distinction, and under multi-user it is
 *    a routine path, not a rare one.
 * 2. **There is no existence oracle in the failure surface** (amendment D20.2/3,
 *    property 15, readiness §3.1.5): a command targeting an entity the principal
 *    cannot see must fail IDENTICALLY to one targeting a nonexistent id. That
 *    indistinguishability has to survive all the way out — the reason stored on
 *    the entry, the dead-letter record, and whatever POD-316 renders. So the
 *    normalization happens HERE, inside the kernel, rather than depending on
 *    every adapter remembering to blur its own error.
 */

/**
 * What the Authority told us, before normalization. Adapters map their transport
 * errors onto this union; the Outbox is what decides which of them are allowed
 * to remain distinguishable.
 *
 * `unauthorized` and `target-not-found` are separate arms on purpose: an
 * adapter can report honestly what it saw (and telemetry may need it), while the
 * DURABLE record and every user-visible projection collapse both to one code.
 */
export type AuthorityRefusal =
  /** Policy denial: apply-time re-authorization refused it (D8 / D16 — rights
   *  revoked, delegation chain collapsed, agent scope does not cover the
   *  target, or the target is invisible to this principal). */
  | { readonly kind: 'unauthorized' }
  /** No such id. Collapses into the same stored code as `unauthorized`. */
  | { readonly kind: 'target-not-found' }
  /** D13: stale `expectedRevision` — precondition failed. */
  | { readonly kind: 'conflict' }
  /** Validation poison (D10). `details` are paths in the caller's OWN input, so
   *  they disclose nothing about the target. */
  | { readonly kind: 'invalid'; readonly details?: readonly string[] }
  /** D8 outcome 3: an out-of-scope write arrived without a durable confirmation. */
  | { readonly kind: 'confirmation-required' }

/**
 * The reason codes a durable record may carry. Closed set: POD-316 renders these
 * and nothing else.
 *
 * `unauthorized` deliberately covers three situations the user might tell apart
 * but the system must not: rights denied, target invisible, target nonexistent.
 * That merge is the closed behavior property 15 requires. WHICH existence facts
 * may legitimately leak is still OPEN (ADR 3 amendment §3 O1 / readiness
 * §3.1.2); if that opens, it opens THERE — this module implements the closed
 * behavior and nothing here decides it.
 */
export const OUTBOX_REJECTION_CODES = [
  'unauthorized',
  'conflict',
  'invalid',
  'confirmation-required',
  'max-age',
] as const
export type OutboxRejectionCode = (typeof OUTBOX_REJECTION_CODES)[number]

/** The durable, renderable reason. `details` exist for exactly one code. */
export interface OutboxRejectionReason {
  readonly code: OutboxRejectionCode
  /** Paths in the author's own input. Present only for `invalid` — see
   *  `normalizeRefusal`: for every other code they are dropped, because any
   *  free-form detail is a channel through which an existence fact could
   *  escape. */
  readonly details?: readonly string[]
}

/**
 * Collapse an Authority refusal into a durable reason. This is the single point
 * where the no-oracle rule is enforced:
 *
 * - `unauthorized` and `target-not-found` produce a BYTE-IDENTICAL reason;
 * - no code but `invalid` keeps any accompanying detail.
 */
export const normalizeRefusal = (refusal: AuthorityRefusal): OutboxRejectionReason => {
  switch (refusal.kind) {
    case 'unauthorized':
    case 'target-not-found':
      return { code: 'unauthorized' }
    case 'conflict':
      return { code: 'conflict' }
    case 'confirmation-required':
      return { code: 'confirmation-required' }
    case 'invalid':
      return refusal.details === undefined
        ? { code: 'invalid' }
        : { code: 'invalid', details: [...refusal.details] }
  }
}

/** The reason an entry that aged out carries (D10: "Age exceeded … `expired` →
 *  `dead-letter` with reason `max-age`"). */
export const MAX_AGE_REASON: OutboxRejectionReason = { code: 'max-age' }

/**
 * What must be true before the SAME input may be retried. D9 invariant 3 allows
 * retry "only after user edit or rights fix"; the value here says which, per
 * code, so POD-316 does not have to re-derive it (and cannot derive it
 * differently).
 */
export type RetryPrecondition =
  /** The principal's rights must change (or the user edits the target). An
   *  authz denial retried as-is just denies again — D10: zero automatic
   *  retries. */
  | 'rights-fix'
  /** A fresh `expectedRevision`: rebase onto the truth that moved (D13.3). */
  | 'rebase'
  /** A durable confirmation on the envelope (D8 outcome 3 / D2). */
  | 'confirmation'
  /** D11.4: after `expired` (or `cancelled`) a re-issue MUST mint a new
   *  `mutationId` — the old one may still have a receipt. */
  | 'new-mutation-id'
  /** Nothing can make this input succeed; only an edit can (validation poison). */
  | 'never'

/**
 * The recovery surface for one dead-lettered entry (D9 invariant 3).
 *
 * `edit` and `discard` are ALWAYS available, which is not laziness — it is what
 * keeps the affordance set free of an existence oracle. If, say, `edit` were
 * withheld for an authz denial, then an invisible target would offer a
 * different set of buttons than a mistyped id, and the oracle would leak through
 * the UI after we had carefully blurred the reason code.
 */
export interface RecoveryPlan {
  readonly retry: RetryPrecondition
  readonly edit: true
  readonly discard: true
}

/** Derived purely from the code — so two situations with the same code are
 *  guaranteed to offer the same recovery, byte for byte. */
export const recoveryPlanFor = (code: OutboxRejectionCode): RecoveryPlan => {
  const retry: RetryPrecondition =
    code === 'unauthorized'
      ? 'rights-fix'
      : code === 'conflict'
        ? 'rebase'
        : code === 'confirmation-required'
          ? 'confirmation'
          : code === 'max-age'
            ? 'new-mutation-id'
            : 'never'
  return { retry, edit: true, discard: true }
}

/**
 * What the caller offers to satisfy a `RetryPrecondition`. `retry()` refuses a
 * mismatch: an authz denial cannot be waved through with a rebase.
 *
 * These keys describe WHAT THE USER DID in the recovery UI, and are deliberately
 * a separate vocabulary from the envelope's field names — so `confirmed` here is
 * not the envelope's confirmation field (`CONFIRMATION_FIELD` in records.ts,
 * whose name POD-311 owns) and is not renamed with it.
 */
export type RetrySatisfaction =
  | { readonly rightsFixed: true }
  | { readonly expectedRevision: number }
  | { readonly confirmed: true }
  | { readonly mutationId: string }

export const satisfies = (
  precondition: RetryPrecondition,
  satisfaction: RetrySatisfaction,
): boolean => {
  switch (precondition) {
    case 'rights-fix':
      return 'rightsFixed' in satisfaction
    case 'rebase':
      return 'expectedRevision' in satisfaction
    case 'confirmation':
      return 'confirmed' in satisfaction
    case 'new-mutation-id':
      return 'mutationId' in satisfaction
    case 'never':
      return false
  }
}
