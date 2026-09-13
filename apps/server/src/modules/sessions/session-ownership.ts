/**
 * The shape `SessionAuthz.sessionOwner` answers with, and the reason it is a
 * type rather than a convention (PDM-355).
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * B1 (PDM-133) made session grants INACTIVE HISTORY: the rows stay in the store,
 * nothing is deleted, and they no longer confer access to a session. B2
 * (PDM-251) then routed the session read decisions through the model, where
 * `AuthTarget`'s private member carries its evidence at the {@link LegacyGrant}
 * brand so that `legacyGrants.includes(someUserId)` does not compile.
 *
 * THAT SECURED THE MODEL'S DECISION AND NOTHING ELSE, and it was measured rather
 * than assumed: `sessionOwner` returned `{ owner: UserId; grants: string[] }`, a
 * bare array, so restoring a hand-rolled `target.grants.includes(reader.userId)`
 * at any of its seven consumers typechecked at exit 0. Five such comparisons
 * were still written by hand when this file was added, and they admitted nobody
 * only because that one function happens to return an empty list — a convention
 * held in one place, one edit from being undone, and invisible to the compiler.
 *
 * So the evidence is typed AT ITS SOURCE. Every `.includes(someUserId)` against
 * it now fails the build, INCLUDING at call sites nobody has written yet, which
 * is the whole point: a census derived from the authorization model cannot see a
 * site that declines to ask the model, and two live cross-user leaks in this
 * phase were exactly that. A type at the source does not have to be re-run.
 *
 * ── AND THE HALF THAT IS EASY TO GET WRONG ───────────────────────────────────
 *
 * TYPING THE SOURCE IS NECESSARY AND NOT SUFFICIENT. A `readonly string[]`
 * ANYWHERE ON THE PATH LAUNDERS THE BRAND BACK TO A COMPARABLE TYPE — a
 * `LegacyGrant` IS a `string`, so it flows into `readonly string[]` silently and
 * the next `.includes(userId)` downstream compiles again. `SessionControlContext`
 * was exactly that: `contextFromOwnership` took the branded list and stored it in
 * `watchGrantees: readonly string[]`, three lines from a `grantees.includes(human)`
 * that would have compiled clean. Carry the brand all the way to the comparison,
 * or the source typing buys nothing past its first hop.
 *
 * The field is NOT dropped. The `grants` edge table is real, and a reader that
 * silently discarded its rows would be making a second, unstated policy out of an
 * omission. It is carried, shown, and refused.
 */

import type { LegacyGrant, UserId } from '@podium/model'

/** Ownership of one session, as every authorization path reads it. */
export interface SessionOwnership {
  readonly owner: UserId
  /**
   * Legacy grant edges standing against this session, carried as EVIDENCE and
   * unusable as a permission. Empty since B1/PDM-133 — but that is now a
   * property of the type and not only of the function that fills it.
   */
  readonly legacyGrants: readonly LegacyGrant[]
}

/** {@link SessionOwnership} where an absent owner is representable rather than
 *  collapsed to `undefined` — `session-state/service.ts`'s port, deliberately
 *  wider so a null owner column reaches the model as a denial (§3.1.1
 *  default-closed) instead of being read as "no such session". */
export interface NullableSessionOwnership {
  readonly owner: UserId | null
  readonly legacyGrants: readonly LegacyGrant[]
}
