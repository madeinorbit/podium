/**
 * PER-USER STATE FAMILY — ONE PERSON'S READ MARK AND SNOOZE FOR ONE SESSION,
 * as a row of its own on the feed (PDM-424).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: A LEDGER ROW CANNOT HOLD TWO PEOPLE'S ANSWERS
 * ---------------------------------------------------------------------------
 * POD-1076 already made the STORAGE per-user (`session_user_state`, `snoozes`)
 * and gave the projection a viewer argument: `Session.toMeta()` takes a
 * `SessionUserOverlay` and `SessionView.project()` takes a principal. That is
 * genuinely per-member and it is why `sessions.list(principal)` answers
 * correctly today.
 *
 * The BROADCAST cannot use it. `SessionRepository` publishes one
 * `entity: 'session'` value per session id into the change log
 * (`repository.ts`'s `buildProjectionPass(candidates)` with NO principal, then
 * `view.wire(session, pass)`), and every subscriber reads that one value. The
 * feed scopes WHO receives a row; it does not give two recipients two payloads.
 * So a principal-less pass falls through to `internalOverlayUser()` — the
 * earliest admin — and her `readAt`, derived `unread` and `snoozedUntil` go to
 * everybody.
 *
 * The answer is the one PDM-408 built for `issueMarks` and B4 built for
 * `issueExecution`: SPLIT THE PAYLOAD. The shared session row keeps every fact
 * about the session, the per-person half moves to a row addressed to its owner,
 * and {@link joinSessionMarks} puts them back together on the client.
 *
 * ---------------------------------------------------------------------------
 * WHY `unread` IS NOT CARRIED, WHERE `issueMarks` CARRIES ALL THREE OF ITS KEYS
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE REAL DIFFERENCE FROM THE ISSUE TWIN, and it is not a
 * simplification. `issueMarks` carries `pinned` / `tuckedAt` / `readAt`, three
 * stored values. A session's `unread` is DERIVED, and it is derived from BOTH
 * halves of the split:
 *
 *     unread = readAt == null || lastActiveAt > readAt      (`Session.toMeta`)
 *
 * `readAt` is per-person and `lastActiveAt` is a shared fact about the session.
 * The rule itself is `isSessionUnread` in `./session-state.ts`, called by BOTH
 * this join and the server's `Session.toMeta()` so the two cannot drift.
 * Storing `unread` in this row would freeze a value whose other input keeps
 * moving: the session goes active, the shared row updates, and a cached
 * `unread: false` would say "you have seen this" about activity that arrived
 * afterwards. The person would be told they are up to date by a row written
 * before the thing they have not seen.
 *
 * So the row carries the per-person INPUTS and {@link joinSessionMarks}
 * re-derives, against the shared row it is joining onto — which is the same
 * expression, in the same package, one place. A client-side reimplementation of
 * the rule is what this avoids.
 *
 * ---------------------------------------------------------------------------
 * THE THREE-VALUED SNOOZE IS CARRIED INTACT
 * ---------------------------------------------------------------------------
 * `snoozedUntil` is `SessionSnoozeState`'s semantics, not a new convention:
 * `undefined` means NO SNOOZE ROW, `null` means the row exists and says
 * until-next-message, and a string is a deadline. Three states, and flattening
 * `undefined` into `null` would turn "not snoozed" into "snoozed until the next
 * message" for every person who never snoozed anything.
 */

import { z } from 'zod'
import { asUserId, type UserId, UserIdField } from '../ids'
import { compositeRowId, parseCompositeRowId } from './composite-row-id'
import { isSessionUnread } from './session-state'

/**
 * Wire value of one marks row on the metadata feed (entity kind
 * `sessionMarks`).
 *
 * Carries the owning `userId` and the `sessionId` in the PAYLOAD as well as in
 * the row id, for the reason `ReadPositionWire` states: a client that only sees
 * the payload still knows whose row it is, and one that somehow received a
 * foreign row can drop it rather than render it as its own. Delivery is decided
 * server-side from the row ID (`feed-visibility.ts`'s `keyedUserOf`); this is
 * the reader's own check, not the gate.
 */
export const SessionMarksWire = z.object({
  userId: UserIdField,
  sessionId: z.string(),
  /** When this person last opened the session. `null` — and an absent ROW — both
   *  mean "never opened"; see `SessionReadState`, which has the same rule. */
  readAt: z.string().nullable(),
  /** Three-valued; see this file's header. `.optional()` IS the `undefined`
   *  state and must not be tightened to `.nullable()` alone. */
  snoozedUntil: z.string().nullable().optional(),
})
export type SessionMarksWire = z.infer<typeof SessionMarksWire>

/** The per-person half alone — what the join contributes to a session row. */
export type SessionMarks = Omit<SessionMarksWire, 'userId' | 'sessionId'>

/**
 * WHAT THE BROADCAST CARRIES INSTEAD OF SOMEBODY'S MARKS.
 *
 * The same values `NO_SESSION_USER_STATE` describes, in the shape a neutral WIRE
 * row has — see the omitted key below, which is where those two shapes differ.
 * A person with no row is a person who has never opened and never snoozed, which
 * is exactly what a stranger should be shown.
 *
 * NOTE FOR ANYONE WRITING A TEST AGAINST IT: on an instance whose only member is
 * the earliest admin, these values and HER values are the same bytes. An
 * assertion over an untouched session therefore passes whether the wire is
 * neutral or is still reading her overlay. Set a non-default first — see
 * `session-overlay.broadcast.test.ts`, which asserts that as a precondition.
 */
export const NEUTRAL_SESSION_MARKS: SessionMarks = Object.freeze({
  readAt: null,
  // `snoozedUntil` IS OMITTED, NOT SET TO `undefined`, and the distinction is
  // not cosmetic. The producer (`Session.toMeta`) spreads the key only when the
  // overlay has one, so a neutral row on the wire has NO `snoozedUntil` key at
  // all. A constant that declared it present-and-undefined would be a second,
  // different spelling of the neutral row — and `'snoozedUntil' in row` is a
  // real question here, because `undefined` and absent are the SAME state while
  // `null` is a different one. Caught by this constant's own witness in
  // `session-marks-join.test.ts`, which built its broadcast fixture by spreading
  // this object and then asked whether the key was there.
})

/**
 * **THE JOIN** — the client's side of the split, and the only place the two
 * halves are put back together.
 *
 * Written here, beside the split, rather than in the client, for the reason
 * `joinIssueExecution` and `joinIssueMarks` both give: a client-side
 * re-assembly is a second statement of which keys are per-user, and the day the
 * two disagree the payload grows a key nobody notices.
 *
 * `marks` ABSENT IS THE NORMAL CASE — the tables hold rows only for people who
 * have actually opened or snoozed something. It LEAVES THE SHARED ROW ALONE
 * rather than forcing {@link NEUTRAL_SESSION_MARKS} onto it. PDM-408 learned
 * that the hard way on the issue twin: an unconditional neutral overwrite there
 * wiped THE CLIENT'S OWN OPTIMISTIC OVERLAY — pressing "mark read" stamps the
 * row immediately, and the next derivation erased it, so the dot flicked back on
 * under the cursor. The producer is guarded at the producer
 * (`session-overlay.broadcast.test.ts`), which is where a regression would be.
 *
 * `lastActiveAt` comes from the SHARED row being joined onto, which is the point
 * of re-deriving here rather than carrying `unread` — see the header.
 */
export function joinSessionMarks<T extends { lastActiveAt?: string }>(
  shared: T,
  marks: SessionMarksWire | undefined,
): T {
  if (marks === undefined) return shared
  const { userId: _userId, sessionId: _sessionId, ...held } = marks
  // ONE definition, shared with the server's projection — see `isSessionUnread`.
  const unread = isSessionUnread(held.readAt, shared.lastActiveAt)
  return {
    ...shared,
    readAt: held.readAt,
    unread,
    // Preserve the three-valued shape: an absent key, not `snoozedUntil:
    // undefined`, so a joined row is byte-comparable with a server-wired one.
    ...(held.snoozedUntil !== undefined ? { snoozedUntil: held.snoozedUntil } : {}),
  }
}

// ---------------------------------------------------------------------------
// Feed row identity — `(userId, sessionId)` as one change-log entityId
// ---------------------------------------------------------------------------

/**
 * Change-log / feed id for one session-marks row.
 *
 * Escaped join through {@link compositeRowId}. Shared rather than copied because
 * `feed-visibility.ts` decides DELIVERY by parsing this id: a parser that
 * disagreed with its writer by one escape would hand one person's read state to
 * another, which is the defect this file exists to fix, one layer down.
 */
export function sessionMarksRowId(userId: UserId, sessionId: string): string {
  return compositeRowId(userId, sessionId)
}

/** Inverse of {@link sessionMarksRowId}. Throws on a malformed id. */
export function parseSessionMarksRowId(id: string): { userId: UserId; sessionId: string } {
  const [userId, sessionId] = parseCompositeRowId(id, 'session marks')
  return { userId: asUserId(userId), sessionId }
}
