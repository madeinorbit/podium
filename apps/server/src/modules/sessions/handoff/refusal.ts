/**
 * WHY A HANDOFF WAS REFUSED, AS A CLASSIFIED ANSWER (POD-1079, from POD-643's
 * requirement; ADR 9 D6 M1/M5, ADR 1 Am1 D13.7).
 *
 * POD-643 landed the vocabulary — `HandoffRefusalReason` in `@podium/model`, an
 * optional `refusal` field on both handoff result frames — and stated in writing
 * that nothing populates it and the enforcement is this issue's. This is that
 * enforcement, at the point where the refusal is DECIDED rather than at the frame
 * where it is eventually reported: the server refuses before it ever dispatches
 * to a daemon, so a refusal that only existed on the daemon's result frame could
 * never carry the server's own denials.
 *
 * ---------------------------------------------------------------------------
 * THREE ARMS, AND THE THIRD IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 *
 *   unauthorized   — visible, reachable, no `use`. Asking again will not help;
 *                    someone must grant. NOT a retry condition.
 *   unreachable    — may use it, the daemon is offline. Retrying later is right.
 *   unknown-target — the FAIL-IDENTICALLY arm: a machine OUTSIDE the principal's
 *                    `see` set and a machine id that never existed produce THE
 *                    SAME reason and the SAME message.
 *
 * Collapse the three into two and the refusal becomes an existence oracle over a
 * colleague's fleet (readiness §3.1.2, the rule `mailSend` already follows);
 * collapse into one and M5 is broken, because "denied" and "offline" produce the
 * same empty answer and the user retries forever against a machine that will
 * never accept.
 *
 * `unauthorized` and `unreachable` are distinguishable ONLY INSIDE the `see`
 * set, where existence is already disclosed — which is exactly what makes the
 * two rules compatible instead of contradictory.
 *
 * AND NEVER RETARGET. There is deliberately no fallback-machine path anywhere
 * near this: picking a machine the principal MAY use is the failure M5 exists to
 * prevent, and it would turn "you may not run this there" into "we ran it
 * somewhere else".
 */

import type { HandoffRefusalReason } from '@podium/model'
import type { MachineAccessFailure } from '../../../machine-access'

/**
 * An Error that also says WHICH KIND of refusal it is.
 *
 * An Error subclass rather than a result union because every existing caller of
 * the handoff gate handles a throw, and a result type would have been a second
 * refusal path that the paths already written would ignore — mechanism with no
 * coverage. The MESSAGE is unchanged from what each site threw before, so the
 * human-readable half is byte-identical and the classification is purely
 * additive (the same reason POD-643 could land the field as optional).
 */
export class HandoffRefusalError extends Error {
  constructor(
    message: string,
    readonly refusal: HandoffRefusalReason,
  ) {
    super(message)
    this.name = 'HandoffRefusalError'
  }
}

/**
 * The machine-access verdict, in POD-643's vocabulary.
 *
 * `absent` maps to `unknown-target` and NOT to `unauthorized`, which is the
 * whole point of the third arm: `machine-access.ts` already answers `absent` for
 * both "no such machine" and "outside your see set", with one message, so this
 * mapping preserves that rather than re-deriving a distinction the layer below
 * deliberately refuses to make.
 */
export const refusalForMachineAccess = (
  failure: MachineAccessFailure,
): HandoffRefusalReason => (failure === 'absent' ? 'unknown-target' : 'unauthorized')

/** The refusal reason on an error, when it carries one. */
export const handoffRefusalOf = (error: unknown): HandoffRefusalReason | undefined =>
  error instanceof HandoffRefusalError ? error.refusal : undefined
