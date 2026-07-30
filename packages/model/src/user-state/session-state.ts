/**
 * PER-USER STATE FAMILY — the session half.
 *
 * ---------------------------------------------------------------------------
 * WHOSE FILE THIS IS
 * ---------------------------------------------------------------------------
 * POD-380 seeded this home with snooze, pins and tab order — the three whose
 * state already lived in its own table — and recorded `readAt` as the one member
 * it deliberately did not move. **POD-1076 moves it.** The issue half of the
 * family is `./issue-state.ts`; the union of both files is
 * {@link PER_USER_STATE_FAMILY}, which is what a totality test reads.
 *
 * This is not a parallel keying scheme: every member composes {@link perUserKey},
 * POD-365's ONE `(userId, entityId)` fragment, and the encoding is POD-301's
 * `userEntityKey`.
 *
 * ---------------------------------------------------------------------------
 * WHY `readAt` COULD MOVE NOW, WHEN POD-380 SAID IT COULD NOT
 * ---------------------------------------------------------------------------
 * POD-380's stated blocker was real and is answered rather than waived. Its
 * argument: `readAt`'s only read path is the session wire projection, which is
 * BROADCAST to every attached client (ADR 2 D2's unscoped feed), so a per-user
 * row *"has nowhere correct to be delivered until POD-1077's watermarked scoped
 * feed makes fan-out per-principal"*.
 *
 * What that argument actually establishes is that the PROJECTION needs a viewer,
 * not that the STORAGE must stay a singleton. So POD-1076 gives the projection a
 * viewer: `Session.toMeta()` takes a {@link SessionUserOverlay} argument, and the
 * unscoped broadcast supplies the overlay of one named user
 * (`FIRST_ADMIN_USER_ID`) instead of reading a mirror field off the session. The
 * wire is byte-identical, the durable row is per-user, and POD-1077's remaining
 * work at each site is to pass the real principal instead of the named constant —
 * a change the type system now demands an argument for, rather than one that
 * requires finding a mirror nobody remembers is there.
 *
 * The mirror was the actual defect. A `readAt` / `snoozedUntil` field on the live
 * session IS an instance-wide singleton however per-user the table behind it is,
 * which is why `per-user-singletons` counted it, and why deleting the fields —
 * not the columns alone — is what clears the ratchet.
 */

import { z } from 'zod'
import { perUserKey } from '../fields/per-user-key'
import { SessionIdField } from '../ids'

/**
 * SESSION READ STATE — `(userId, sessionId)` → when this person last opened it.
 *
 * `readAt: null` and an ABSENT ROW are the same thing ("never opened"), which is
 * why `markUnread` deletes the row rather than writing a null: two spellings of
 * one fact is how a per-user table acquires a second meaning nobody documented.
 * The derived `unread` flag (`readAt == null || lastActiveAt > readAt`) is
 * computed at PROJECTION time from this row plus the session's shared
 * `lastActiveAt` — it is not stored, because it is a fact about a reader and a
 * session together.
 */
export const SessionReadState = perUserKey(SessionIdField).extend({
  readAt: z.string().nullable(),
})
export type SessionReadState = z.infer<typeof SessionReadState>

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
 * The session-half members, as a list so a totality test can assert the SET
 * rather than trusting a docstring. The whole family — this plus the issue
 * half — is {@link PER_USER_STATE_FAMILY} in `./family.ts`.
 */
export const SESSION_USER_STATE_MEMBERS = [
  { name: 'sessionReadState', schema: SessionReadState, table: 'session_user_state' },
  { name: 'sessionSnooze', schema: SessionSnoozeState, table: 'snoozes' },
  { name: 'pin', schema: PinState, table: 'pins' },
  { name: 'tabOrder', schema: TabOrderState, table: 'tab_order' },
] as const

/**
 * THE PER-USER VALUES A SESSION PROJECTION NEEDS FROM ONE VIEWER.
 *
 * The argument that replaces the mirror fields (see this file's header). It is a
 * VIEW-time input, never a durable shape: `readAt` comes from
 * `session_user_state` and `snoozedUntil` from `snoozes`, two different rows for
 * the same `(userId, sessionId)` key, assembled per viewer at projection time.
 *
 * `snoozedUntil: undefined` means "no snooze row"; `null` means the row exists
 * and says until-next-message. That three-valued shape is
 * {@link SessionSnoozeState}'s semantics carried intact, not a new convention.
 */
export interface SessionUserOverlay {
  readonly readAt: string | null
  readonly snoozedUntil: string | null | undefined
}

/** The overlay of a user with no per-user rows for a session at all — never
 *  opened, never snoozed. A named constant rather than an inline literal so a
 *  caller cannot express "no overlay" as `readAt: undefined`, which the derived
 *  `unread` rule would then read as "read at an unknown time". */
export const NO_SESSION_USER_STATE: SessionUserOverlay = {
  readAt: null,
  snoozedUntil: undefined,
}

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
