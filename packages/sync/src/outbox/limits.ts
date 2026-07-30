/**
 * ADR 3 D10 and D11's NUMBERS, and the two policies derived from them: how long
 * an entry may live, and how a transient failure is spaced out.
 *
 * This module exists because those numbers needed exactly one home. D10 is the
 * SOLE owner of the outbox age (ADR 2 D11 deliberately restates no value — an
 * earlier draft of ADR 2 named its own number and that over-reach was
 * withdrawn), and the kernel in `outbox.ts` deliberately mints no default of its
 * own, so a second literal `14 * 24 * …` anywhere would be the drift D11.3 warns
 * about with nothing to notice it.
 *
 * ## What is NOT here, and why
 *
 * **Receipt retention.** That number is ADR 2's, and it lives at its prune site
 * (`APPLIED_MUTATIONS_MAX_AGE_MS` in `apps/server/src/modules/sessions/service.ts`).
 * D11.3 requires the inequality to IMPORT it rather than copy it: a hard-coded
 * `30d` here would be a comment that fails open the day someone tunes the
 * service constant. `packages/*` may not import `apps/*` (boundary rule 4), so
 * this module exports the PREDICATE and the assertion, and the invariant test
 * that supplies the real receipt constant lives on the server side of that
 * boundary — see `apps/server/src/modules/sessions/receipt-retention.test.ts`.
 *
 * **Command names.** A per-command override may SHORTEN an entry's age (D10:
 * "e.g. lock acquire"). The table of which contract gets which age is contract
 * vocabulary and POD-311 owns it, so what lives here is the shorten-only RULE
 * (`resolveMaxAgeMs`) and not a list of command names the kernel would then be
 * the second owner of.
 */

import type { OutboxSubmitOutcome } from './ports'

const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND

/**
 * D10: **14 days** from `queuedAt`. The default an integrator passes as
 * `OutboxConfig.maxAgeMs`.
 *
 * Measured from `queuedAt` and never from the last attempt — a horizon a busy
 * entry could renew on every retry would never expire, which is exactly the send
 * D11 exists to refuse.
 */
export const OUTBOX_MAX_AGE_MS = 14 * DAY

/**
 * D10: `SKEW_MARGIN_MS ≥ 2 days` — clock skew between replica and Authority plus
 * drain delay. It is not subtracted from the entry's own age; it is the slack in
 * D11's inequality, so that an entry which expires "just in time" by the
 * client's clock is still comfortably inside the Authority's receipt window by
 * the Authority's clock.
 */
export const SKEW_MARGIN_MS = 2 * DAY

/**
 * The worst case a queued entry can present to the Authority: it was authored
 * `OUTBOX_MAX_AGE_MS` ago by a client whose clock is `SKEW_MARGIN_MS` behind.
 * This is the left-hand side of D11's inequality.
 */
export const OUTBOX_HORIZON_MS = OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS

/**
 * D10's two failure classes, plus the `progress` arm so the classifier is total
 * over the submit outcome and a new outcome kind cannot be added without
 * deciding its class.
 *
 * - `transient` — D9 invariant 4: back to `queued`, unlimited attempts, spaced
 *   by `backoffDelayMs`, until the age limit ends it.
 * - `definitive` — D10: **zero** automatic retries, dead-letter immediately.
 *   Every `AuthorityRefusal` is in this class, and the one the multi-user
 *   amendment cares most about is `unauthorized`: ADR 3 D8 resolves the
 *   delegation chain LIVE, so a denial after a share was revoked is PERMANENT.
 *   Retrying it would burn the age limit on an entry that can never succeed and
 *   would hold the head of its partition against writes that could have gone
 *   through — D10's "never wedge the partition", arriving at the authz site.
 */
export type OutboxFailureClass = 'transient' | 'definitive' | 'progress'

export const failureClassOf = (outcome: OutboxSubmitOutcome): OutboxFailureClass => {
  switch (outcome.kind) {
    case 'applied':
    case 'accepted':
      return 'progress'
    case 'rejected':
      // Includes `unauthorized`. `OutboxSubmitOutcome.rejected` is DEFINED as a
      // definitive refusal (see its doc), so there is no refusal kind to branch
      // on here — the adapter's transient/definitive call is the `unreachable`
      // arm, and this is the other side of it.
      return 'definitive'
    case 'unreachable':
      return 'transient'
  }
}

/** The narrowing form the drain uses, so the classification above is the code
 *  that DECIDES rather than a parallel description of it. */
export const isDefinitiveFailure = (
  outcome: OutboxSubmitOutcome,
): outcome is Extract<OutboxSubmitOutcome, { kind: 'rejected' }> =>
  failureClassOf(outcome) === 'definitive'

/** D10's transient-retry spacing. `start 1s, factor 2, cap 60s`. */
export interface BackoffPolicy {
  readonly startMs: number
  readonly factor: number
  readonly capMs: number
}

/**
 * D10's implementation default. Unlike the age, this one MAY be defaulted inside
 * the kernel: it is a spacing choice with no cross-ADR constraint attached,
 * whereas the age participates in an inequality against a constant this package
 * cannot see.
 */
export const TRANSIENT_BACKOFF: BackoffPolicy = { startMs: SECOND, factor: 2, capMs: 60 * SECOND }

/**
 * How long to wait before attempt number `attempts + 1`, given how many attempts
 * have already failed.
 *
 * `attempts` is the record's own counter AFTER the failure, so the first failure
 * waits `startMs`. There is deliberately NO ceiling on `attempts`: D10 forbids a
 * global attempt limit, because a limit converts user work into silent failure
 * while the age limit is the one bound that ends an entry's life. The growth is
 * therefore clamped rather than the attempt count — including the arm where
 * `factor ** attempts` overflows to `Infinity`, which `Math.min` resolves to the
 * cap.
 */
export const backoffDelayMs = (attempts: number, policy: BackoffPolicy = TRANSIENT_BACKOFF): number => {
  if (attempts <= 0) return 0
  return Math.min(policy.capMs, policy.startMs * policy.factor ** (attempts - 1))
}

/**
 * A per-command age override may only SHORTEN (D10). Lengthening is refused
 * LOUDLY rather than clamped: a silent clamp would let a config express an
 * intent D11's inequality forbids and then quietly not honour it, so the
 * integrator would believe their queue lives longer than it does. Lengthening is
 * legal only in the same change that raises receipt retention — which is an ADR
 * 2 amendment plus a new `maxAgeMs`, not an override.
 */
export class OutboxAgeOverrideError extends Error {}

export const resolveMaxAgeMs = (
  baseMs: number,
  command: string,
  overrideMs: number | undefined,
): number => {
  if (overrideMs === undefined) return baseMs
  if (overrideMs > baseMs) {
    throw new OutboxAgeOverrideError(
      `per-command max age for ${command} (${overrideMs}ms) exceeds the base ${baseMs}ms; D10 lets an override SHORTEN only — lengthening requires raising receipt retention (ADR 2) in the same change`,
    )
  }
  return overrideMs
}

/**
 * D11's inequality: `OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS < RECEIPT_RETENTION_MS`.
 *
 * STRICTLY below, not at-or-below: equality means an entry can reach the
 * Authority in the same instant its receipt is pruned, and past the dedupe
 * horizon a replay is a FRESH command — `sessions.sendText` double-types into a
 * live PTY, so "idempotent-ish" is not a property we may lean on.
 */
export const holdsAgainstReceiptRetention = (
  receiptRetentionMs: number,
  horizonMs: number = OUTBOX_HORIZON_MS,
): boolean => horizonMs < receiptRetentionMs

export class OutboxHorizonError extends Error {}

/** The assertion form, for the invariant test that imports the real receipt
 *  constant (D11.3) and for any integrator that configures a non-default age. */
export const assertUnderReceiptRetention = (
  receiptRetentionMs: number,
  horizonMs: number = OUTBOX_HORIZON_MS,
): void => {
  if (!holdsAgainstReceiptRetention(receiptRetentionMs, horizonMs)) {
    throw new OutboxHorizonError(
      `outbox horizon ${horizonMs}ms is not strictly below receipt retention ${receiptRetentionMs}ms (ADR 3 D11): an entry that outlives its receipt replays as a FRESH command past the dedupe horizon`,
    )
  }
}
