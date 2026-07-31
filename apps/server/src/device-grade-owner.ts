/**
 * THE PLACEHOLDER, NAMED HONESTLY (POD-1079; the pattern POD-1077 established
 * with `DeviceGradeUnscopedPolicy`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ISSUE SHIPPED, AND WHAT IT DID NOT
 * ---------------------------------------------------------------------------
 *
 * POD-1079 shipped the see/use/manage grant MECHANISM: machines carry a real
 * owner column, grants are real rows, and every fleet command and every
 * placement decision resolves them LIVE. What it did NOT ship is a transport
 * that can tell two people apart. `packages/runtime/src/auth-store.ts` is still
 * ONE SHARED PASSWORD and `CLIENT_PRINCIPAL_GRADE` is still `'device'`, so every
 * authenticated connection resolves to the same `UserId`.
 *
 * POD-1075's qualifier is the one that bounds the claim: *a column that CAN name
 * a person is not an authenticator that DOES.* The honest description of today's
 * deployment is therefore "one human, who owns everything" — not "per-user
 * machine ownership". Two connections presenting that one password are the same
 * person to every check in this repository, including the ones this issue added.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLACEHOLDER IS A NAMED FUNCTION AND NOT A CONSTANT INLINE
 * ---------------------------------------------------------------------------
 *
 * Every site that must invent an owner because the transport cannot name one
 * calls THIS, and `bun run audit:machine-grants` holds the call sites to a
 * declared allowlist. That is what makes the placeholder's spread a gate failure
 * rather than an archaeology exercise: a new pairing path that quietly assigns
 * `FIRST_ADMIN_USER_ID` would be invisible; one that calls
 * {@link deviceGradeSoleOwner} is a finding.
 *
 * WHEN PER-USER LOGIN LANDS (Phase 3, POD-315) THIS MODULE IS DELETED OUTRIGHT.
 * Not deprecated, not defaulted — deleted, so every call site becomes a compile
 * error and has to name the authenticated principal it should have named all
 * along. A default would let a site keep resolving to one account forever with
 * nothing failing.
 */

import { FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'

/**
 * The user to record when a connection this build cannot attribute to a specific
 * person acts as one — a machine paired or provisioned, or (POD-1080) a Telegram
 * claim code minted, which needs the SAME fact and deliberately does not get a
 * fourth name for it. One name is one deletion when POD-315 lands, and the
 * allowlist is the census of what that deletion has to visit.
 *
 * A FUNCTION rather than a re-exported constant, for the reason
 * `soleHumanPrincipal` is one: the call site is what the audit counts, and a
 * constant is indistinguishable from any other use of the same id.
 *
 * ADR 9 D6 M3 says a newly paired machine is private to its pairer. On a
 * one-account instance the pairer IS this account, so recording it is M3
 * evaluated in that world rather than a widening of it — the machine is private
 * to exactly one person, and that person is everyone who can log in, which is
 * the honest statement of what a shared password means.
 */
export function deviceGradeSoleOwner(): UserId {
  return FIRST_ADMIN_USER_ID
}
