/**
 * THIS INSTANCE'S FIRST ADMIN — the answer that used to be a literal
 * [spec, hosted sign-in §8 "The solo user retired", A2].
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACED WHAT
 * ---------------------------------------------------------------------------
 *
 * `FIRST_ADMIN_USER_ID` was `'user:sole'`: one string, compiled in, the same on
 * every installation on earth. It could be a constant because the POD-1075
 * migration wrote that exact string into the one account row, so "the first
 * admin" was knowable without opening a database.
 *
 * A2's migration mints the first member an ordinary `mem_` id instead, one per
 * installation, so the answer is now a FACT OF THIS DATABASE and no longer a
 * fact of this build. Every site that spelled the constant spells
 * {@link firstAdminMemberId} instead — a function, so the ~46 places the
 * ambient-principal census counts stay countable (`scripts/audit-ambient-
 * principals.ts`), and so a site that assumes a principal is still visibly
 * different from one that resolves the caller.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VALUE IS PRIMED RATHER THAN READ
 * ---------------------------------------------------------------------------
 *
 * The rule — the EARLIEST ADMIN MEMBER of this workspace — is a query, and this
 * package may not run one: `packages/model` is the L0 root whose only dependency
 * is zod. So the store resolves it once, when it opens the database, and hands
 * it here; `SessionStore.open` is the single writer, and the schema builder does
 * the same for the tests and tools that never construct a store.
 *
 * That is sound because of a property of the row rather than of this module: no
 * product code UPDATEs or DELETEs `users` (see `store/users.ts`'s frame-cache
 * note, which rests on the same fact), so the earliest admin of an open instance
 * cannot change under a running process.
 *
 * UNPRIMED THROWS, and does not fall back to the retired literal. A fallback
 * would put `'user:sole'` — an id that names NO ROW after the migration — into
 * an owner column, where it would read as a valid principal nobody can log in as
 * and no query returns. The throw names the fix instead; `session-state.ts`'s
 * rule ("a principal that arrives without an identity must be refused, never
 * defaulted") is the same rule one layer down.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SLOT IS ON `globalThis`
 * ---------------------------------------------------------------------------
 *
 * Because a module-level `let` is per COPY of this package, and this repository
 * has measured a second copy being loaded — POD-746 records the migrator failing
 * to recognise a database handle for exactly that reason, when a lane resolves
 * `@podium/runtime` outside the checkout. A second copy of a module-level `let`
 * would be unprimed, so the store would prime one slot and an authorization
 * check read the other and throw. One well-known symbol is the same value to
 * every copy.
 */

import { type UserId, asUserId } from '../ids/brands'

/** The one slot, shared across any duplicate copy of this package. */
const SLOT = Symbol.for('podium.identity.firstAdminMember')

type SlotHolder = { [SLOT]?: UserId }

/**
 * The member every ambient-principal site acts as: the earliest admin member of
 * the open instance.
 *
 * Throws when no instance has been opened, because there is no honest answer —
 * see the header. The message names both ways in, since the two callers that
 * get this wrong are a test that builds a schema without a store and a tool that
 * opens a database by hand.
 */
export function firstAdminMemberId(): UserId {
  const primed = (globalThis as SlotHolder)[SLOT]
  if (primed === undefined) {
    throw new Error(
      'the first admin member is not resolved: nothing has opened this instance yet. ' +
        'Open the store (SessionStore.open) or build the schema (applyBaselineSchema), ' +
        'either of which resolves the earliest admin member and primes it.',
    )
  }
  return primed
}

/** The primed value, or `undefined` — for the one caller that must ASK rather
 *  than assume: the priming path itself, deciding whether it has work to do. */
export function firstAdminMemberIdOrUndefined(): UserId | undefined {
  return (globalThis as SlotHolder)[SLOT]
}

/**
 * Record which member this instance's first admin is. Called by whatever opened
 * the database, with the row the earliest-admin rule selected.
 *
 * IDEMPOTENT BUT NOT SILENT ABOUT DISAGREEMENT: re-priming the same id is the
 * ordinary case (a process opens a store more than once), while priming a
 * DIFFERENT id means two instances are open in one process and every ambient
 * site is now ambiguous. That is a real state in this repository's multi-
 * instance tests, so it is not an error — the newest open wins, exactly as it
 * did when both instances spelled the same literal — but the caller can compare
 * the return value to know it happened.
 */
export function primeFirstAdminMember(id: UserId | string): UserId | undefined {
  const holder = globalThis as SlotHolder
  const previous = holder[SLOT]
  holder[SLOT] = asUserId(id)
  return previous
}

/** Forget the primed value. For tests that must prove the unprimed behaviour. */
export function clearFirstAdminMember(): void {
  delete (globalThis as SlotHolder)[SLOT]
}
