/**
 * THE EARLIEST ADMIN MEMBER — one statement of the rule that replaced the solo
 * user [spec, hosted sign-in §8, A2].
 *
 * Open mode acts as this member. The break-glass CLI mints for this member. The
 * server resolves `firstAdminMemberId(store)` from this store, and the janitor
 * resolves this same rule from its own database handle. Those four used to spell one
 * literal, `'user:sole'`, and agreed because a constant cannot disagree with
 * itself; now that the id is minted per installation they agree because they ask
 * the same QUESTION, and the question is written down exactly once — here.
 *
 * WHY THE RULE IS "EARLIEST", AND WHAT IT IS EARLIEST BY. `created_at` ascending,
 * with the id as the tie-break. A fresh install has exactly one admin and every
 * order agrees; the rule matters on an instance that has since invited others,
 * where the answer must stay the member the existing rows already belong to —
 * that is the FIRST one, and it is the first one under any clock that has not
 * been rewound. The id tie-break is not decoration: two members created in the
 * same millisecond would otherwise resolve in whatever order the b-tree felt
 * like, which is a non-deterministic principal, and a `mem_` id sorts by mint
 * time anyway (`packages/model/src/ids/ksuid.ts`), so the tie-break is the same
 * ordering one resolution finer.
 *
 * DISABLED ADMINS ARE NOT ANSWERS. ADR 9's disable-before-remove keeps the row
 * and takes away the ability to produce a principal, so an instance whose first
 * admin has been disabled must resolve to the next one rather than to a member
 * nothing may act as — the same verdict `UsersRepository.get` reaches by
 * returning `undefined` for a disabled row.
 *
 * WHY THE TEXT IS A CONSTANT AND NOT A QUERY BUILDER. Two callers, two drivers:
 * the server runs it through drizzle on the store's connection, and this package
 * runs it on the raw handle a CLI opened, where there is no drizzle. A builder
 * would mean writing the rule twice in two dialects of the same idea, which is
 * how the two constants POD-1172 reconciled came to disagree.
 */

import type { UserId } from '@podium/model'
import { asUserId } from '@podium/model'

/**
 * The rule, as one statement. Runs on any SQLite connection holding the `users`
 * table; a database too old to have one is handled by the callers, which is the
 * only place that knows what to do without an answer.
 */
export const EARLIEST_ADMIN_MEMBER_SQL =
  "SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1"

/** The narrow view of a database handle this needs — `bun:sqlite` and the
 *  node driver both satisfy it, and naming only `prepare` keeps this module
 *  importable from either runtime. */
export interface EarliestAdminReader {
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

/**
 * The earliest admin member of the instance behind this handle, or `undefined`
 * when there is none — a database from before accounts existed, or one whose
 * every admin is disabled. Both are states a caller must decide about rather
 * than be defaulted through, so neither is smoothed over here.
 */
export function earliestAdminMember(db: EarliestAdminReader): UserId | undefined {
  // The table check is not defensive: a database from before POD-1075 has no
  // `users` at all, and the two "no answer" cases are one answer to this
  // function's callers. A caller that must tell them apart — the break-glass
  // mint does, because a pre-accounts instance still has exactly one human —
  // asks {@link instanceModelsAccounts} first.
  if (!instanceModelsAccounts(db)) return undefined
  const row = db.prepare(EARLIEST_ADMIN_MEMBER_SQL).get() as { id?: unknown } | undefined
  return typeof row?.id === 'string' && row.id.length > 0 ? asUserId(row.id) : undefined
}

/**
 * Can this database name a person at all? False for a schema from before
 * accounts existed, where "can write the state dir" and "owns everything" were
 * still the same statement.
 */
export function instanceModelsAccounts(db: EarliestAdminReader): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() !==
    undefined
  )
}
