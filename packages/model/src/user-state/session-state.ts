/**
 * PER-USER STATE FAMILY — the members POD-380's presence-class writes address.
 *
 * ---------------------------------------------------------------------------
 * WHOSE FILE THIS IS
 * ---------------------------------------------------------------------------
 * POD-1076 owns this family and enumerates eleven members
 * (`docs/rearch-field-schema-inventory.md` §7.1). POD-1076 has NOT landed and is
 * still blocked, so POD-380 SEEDS the reserved home with the four members its own
 * acceptance criteria require, and only those. This is not a parallel keying
 * scheme: every member composes {@link perUserKey}, POD-365's ONE `(userId,
 * entityId)` fragment, and the encoding is POD-301's `userEntityKey`. POD-1076
 * EXTENDS this file with the remaining seven and adds the matrix rows; it does not
 * have to reconcile a second convention.
 *
 * Why seed rather than wait: POD-380's brief forbids the alternative in as many
 * words — *"do not land any of these as instance-wide singletons 'for now': that
 * is a later table migration plus a wire change plus a replica migration"*. A
 * facade over singleton tables IS an instance-wide singleton.
 *
 * ---------------------------------------------------------------------------
 * THE ONE MEMBER POD-380 DOES NOT MOVE, AND WHY
 * ---------------------------------------------------------------------------
 * `readAt` is absent from this file. It is not an oversight and not a shortcut:
 *
 *  - Unlike snooze / pins / tab order, `readAt` has NO query surface. Its only
 *    read path is the session wire projection, which is BROADCAST to every
 *    attached client (ADR 2 D2's unscoped feed). A per-user `readAt` therefore has
 *    nowhere correct to be delivered until POD-1077's watermarked scoped feed
 *    makes fan-out per-principal — re-keying the row first would produce a value
 *    the wire actively misrepresents to every client but one.
 *  - It is a field on the canonical Session aggregate and drives the derived
 *    `unread` flag, so moving it is a Session + projection + boot-seed change,
 *    which is Phase 1 work (POD-1076's §7.1 moves the three `readAt` members
 *    together for exactly that reason).
 *
 * `sessions.markRead` / `markUnread` still declare `policy.scope: 'self'` on their
 * contracts, so the command layer is per-user-correct today and POD-1076's move is
 * a storage + projection change with no contract or wire change. The gap is
 * reported explicitly rather than papered over.
 */

import { z } from 'zod'
import { perUserKey } from '../fields/per-user-key'
import { SessionIdField } from '../ids'

/**
 * SNOOZE — `(userId, sessionId)` → when the session stops being hidden.
 *
 * `snoozedUntil: null` is MEANINGFUL and is not "no snooze": it is
 * "until-next-message", a snooze that never lapses by time. Absence of the row is
 * "not snoozed". `../clock.ts` settled this representation; moving the row here is
 * a RE-KEY, not a change to what the snooze predicates compute.
 */
export const SessionSnoozeState = perUserKey(SessionIdField).extend({
  snoozedUntil: z.string().nullable(),
})
export type SessionSnoozeState = z.infer<typeof SessionSnoozeState>

/** What a pin can point at. Structural here (the store's `PinKind` is the same
 *  three literals); the family needs the value, not the server's type. */
export const PinKind = z.enum(['panel', 'worktree', 'repo'])
export type PinKind = z.infer<typeof PinKind>

/**
 * PIN — `(userId, entityId)` where the entity is a panel/session id, a worktree
 * path or a repo path, disambiguated by `kind`.
 *
 * The entity half is NOT `SessionIdField`: a pin's target is one of three kinds,
 * two of which are filesystem paths. `perUserKeyOfString` keeps the fragment while
 * being honest that the brand cannot apply — see the note on the export.
 */
export const PinState = perUserKeyOfString().extend({ kind: PinKind })
export type PinState = z.infer<typeof PinState>

/**
 * TAB ORDER — `(userId, worktreePath)` → the manual session order for that
 * worktree. An ABSENT row means "never reordered"; the shipped behaviour is that
 * an empty list DELETES the row rather than storing an empty order, so an empty
 * `sessionIds` is not representable as stored state.
 */
export const TabOrderState = perUserKeyOfString().extend({
  sessionIds: z.array(z.string()),
})
export type TabOrderState = z.infer<typeof TabOrderState>

/**
 * The fragment with an UNBRANDED entity half, for the two members whose entity is
 * a filesystem path or a multi-kind id rather than one entity's id.
 *
 * Deliberately a wrapper over {@link perUserKey} and not a second `z.object({
 * userId, entityId })`: the point of the shared fragment is that the user half has
 * one definition and one position. `perUserKey(z.string())` is exactly that
 * fragment with the brand declined, so a reader asking "how do I key this" still
 * finds one answer.
 */
export function perUserKeyOfString() {
  return perUserKey(z.string())
}

/**
 * The family members POD-380 landed — a list, so a totality test can assert the
 * set rather than trusting this docstring, and so POD-1076 can see at a glance
 * what is already keyed.
 */
export const POD380_USER_STATE_MEMBERS = [
  { name: 'sessionSnooze', schema: SessionSnoozeState, table: 'snoozes' },
  { name: 'pin', schema: PinState, table: 'pins' },
  { name: 'tabOrder', schema: TabOrderState, table: 'tab_order' },
] as const

/**
 * THE SOLE USER, until POD-1075 mints real accounts.
 *
 * Podium authenticates with one shared password that resolves to `OPERATOR`, and
 * `client_sessions` has no user column — a client session is a DEVICE, not a
 * person (docs/multi-user-readiness.md §3.2). So every per-user row written today
 * belongs to one identity, and that identity needs a NAME rather than an implicit
 * empty string, for three reasons:
 *
 *  1. the rows are keyed `(userId, entityId)` NOW, so the migration POD-1075
 *     performs is "give this row a real owner", not "add a column";
 *  2. a self-scoping check needs something to compare against — with no principal
 *     identity a `self` policy would be vacuously true, which is worse than absent;
 *  3. it is greppable. Every site that will need a real principal is
 *     `SOLE_USER_ID`, so POD-1075's work is enumerable instead of archaeological.
 *
 * It is NOT a fallback. A principal that arrives without an identity must be
 * refused, never defaulted to this — that is the §3.1.6 S4 rule ("unknown chats
 * must fail closed, never fall back to an operator identity") applied here.
 */
export const SOLE_USER_ID = 'user:sole' as const
