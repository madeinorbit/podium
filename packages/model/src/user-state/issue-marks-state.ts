/**
 * **ONE PERSON'S MARKS ON ONE ISSUE** — PDM-408, the read half of the port
 * PDM-402 opened.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * `pinned`, `tuckedAt` and `readAt` have been keyed `(user_id, issue_id)` in the
 * store since POD-1076. PDM-402 made the WRITES land on the right person's row.
 * They were still READ for one named viewer — `IssueService.broadcastViewer()`,
 * the earliest admin — and baked into the `IssueWire` every client receives, so
 * every member was shown that person's pins, folds and unread dots.
 *
 * A value that differs per reader cannot honestly be a field of a payload
 * broadcast to many readers. `entities/issue.ts`'s own header has said so since
 * POD-1076 and named the feed as the remaining gap; it also said POD-1077 would
 * close it, which is an orphan — POD-1077 scopes WHICH rows a principal
 * receives and never what a row SAYS. So the marks move to a row of their own
 * with an audience of one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WIRE KEEPS THE THREE KEYS, AT NEUTRAL VALUES
 * ---------------------------------------------------------------------------
 *
 * B4 (PDM-136) could OMIT its four private keys from the shared payload, because
 * their absence reads as "this task was never started" and every existing reader
 * already handled it. Coordinator ruling for this issue: do NOT narrow
 * `IssueWire` the same way. Narrowing buys one thing — the type stops lying —
 * and costs the protocol arms, the arm-count gates and a wire-golden
 * regeneration, on a wire several other landings are touching. The three keys
 * stay and carry {@link NEUTRAL_ISSUE_MARKS}: unpinned, unfolded, never read.
 *
 * Neutral is what a client that has not joined the sidecar must render anyway,
 * and it is already strictly better than the defect, where that client renders a
 * STRANGER'S marks.
 *
 * **AND NEUTRAL HAS A FAILURE MODE, WHICH IS WHY THIS PARAGRAPH EXISTS.** A
 * neutral value is indistinguishable from "genuinely unmarked". If the join
 * silently stops working — the kind never registered, the feed arm never
 * matching, the client never subscribing — every user sees no marks and nothing
 * is red. That is a false green of exactly the shape this epic keeps shipping.
 * The guard is a deliberate-removal witness over the REGISTRATION rather than
 * the data: see `issue-marks.projection.test.ts`, which deletes the join and
 * requires a named test to redden.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS `per-user-state` AND NOT A NEW KIND OF THING
 * ---------------------------------------------------------------------------
 *
 * This is the THIRD instance of a shipped pattern, not a new one. `userLayout`
 * (POD-1350) and `userReadPosition` (POD-1380) are both rows whose id encodes
 * the owning user, classified `per-user-state` in `feed-visibility.ts`, and
 * delivered by `keyedUserOf` rather than by `mayRead`. The class means: never
 * grantable, and the filter is the key itself.
 *
 * That is the right class here for the reason the `userReadPosition` comment
 * gives about cursors — "share my read state" is not a verb. A pin or a fold
 * that fell through to `personal` would become grantable, which is the privacy
 * defect the class exists to prevent.
 *
 * Deliberately NOT B4's `issueExecution` arm, which resolves the ISSUE's owner
 * and would hand one person's marks to whoever owns the task.
 */

import { z } from 'zod'
import { IssueWire } from '../entities/issue'
import { type UserId, UserIdField } from '../ids'
import { compositeRowId, parseCompositeRowId } from './composite-row-id'

/**
 * **The three marks, as one person holds them for one issue.**
 *
 * The value fields are `.pick()`ed off `IssueWire` rather than retyped, so the
 * sidecar and the wire cannot drift about what a mark IS: if `pinned` ever stops
 * being a boolean, both halves change in one edit. A retyped field list here
 * would be a second hand-maintained copy of the assumption under test.
 *
 * `userId` and `issueId` are carried IN the value as well as in the row id, for
 * the reason `ReadPositionWire` carries its own `userId`: a client that somehow
 * received a foreign row can drop it rather than render it as its own, and a
 * lagging client that only sees the payload still knows whose row it is.
 */
export const IssueMarksWire = z.object({
  userId: UserIdField,
  issueId: IssueWire.shape.id,
  ...IssueWire.pick({ pinned: true, tuckedAt: true, readAt: true }).shape,
})
export type IssueMarksWire = z.infer<typeof IssueMarksWire>

/** The marks half, without the identity half — what the join spreads. */
export type IssueMarks = Omit<IssueMarksWire, 'userId' | 'issueId'>

/**
 * **NOBODY'S MARKS** — what the broadcast payload carries now that it cannot
 * honestly carry one person's.
 *
 * Spelled once, here, rather than as three literals at the three `toWire` sites:
 * three literals are three places to forget, and "the wire says unpinned" is one
 * decision, not three. `tuckedAt` is `null` and not omitted because the wire
 * declares it optional-with-catch and an absent key and a null mean the same
 * thing to every reader — writing it makes the neutrality visible in the bytes.
 */
export const NEUTRAL_ISSUE_MARKS: IssueMarks = Object.freeze({
  pinned: false,
  tuckedAt: null,
  readAt: null,
})

/**
 * **THE JOIN** — the client's side of the split, and the only place the two
 * halves are put back together.
 *
 * Written here, beside the split, rather than in the client, for the reason
 * {@link joinIssueExecution} gives: a client-side re-assembly is a second
 * statement of which keys are per-user, and the day the two disagree the payload
 * grows a key nobody notices.
 *
 * `marks` absent is the NORMAL case — most people have not touched most issues,
 * and the table only holds rows somebody has actually marked. It LEAVES THE
 * SHARED ROW ALONE, exactly as {@link joinIssueExecution} does for its own
 * absent half.
 *
 * IT USED TO OVERWRITE WITH {@link NEUTRAL_ISSUE_MARKS}, and that was wrong.
 * The idea was to make this the last gate — a producer that regressed and baked
 * a viewer's marks back into the broadcast would be caught here rather than
 * rendered. What it actually caught was THE CLIENT'S OWN OPTIMISTIC OVERLAY:
 * pressing "mark read" writes `readAt` onto the issue row immediately, and a
 * join that unconditionally forced neutral wiped that stamp on the next
 * derivation, so the unread dot flicked straight back on under the cursor. The
 * runtime suite said so by name.
 *
 * The producer is guarded where the producer is — `issue-marks.projection.test.ts`
 * asserts the broadcast carries nobody's marks, with a deliberate break that
 * reddens it. A guard here as well would have been belt-and-braces; it was
 * instead a second, wrong answer to "whose marks is this row carrying", applied
 * to a row whose values the reader had just written themselves.
 */
export function joinIssueMarks<T extends object>(
  shared: T,
  marks: IssueMarksWire | undefined,
): T & IssueMarks {
  if (marks === undefined) return shared as T & IssueMarks
  const { userId: _userId, issueId: _issueId, ...held } = marks
  return { ...shared, ...held }
}

// ---------------------------------------------------------------------------
// Feed row identity — `(userId, issueId)` as one change-log entityId
// ---------------------------------------------------------------------------

/**
 * Change-log / feed id for one marks row.
 *
 * Escaped join through {@link compositeRowId}, the same rule `layoutRowId` and
 * `readPositionRowId` spell out separately: a userId containing the separator
 * must not be able to collide with another pair. Shared rather than copied,
 * because `feed-visibility.ts` decides DELIVERY by parsing this id — a parser
 * that disagreed with its writer by one escape would hand a row to the wrong
 * person, which is the whole defect this file exists to fix.
 */
export function issueMarksRowId(userId: UserId, issueId: string): string {
  return compositeRowId(userId, issueId)
}

/** Inverse of {@link issueMarksRowId}. Throws on a malformed id. */
export function parseIssueMarksRowId(id: string): { userId: UserId; issueId: string } {
  const [userId, issueId] = parseCompositeRowId(id, 'issue marks')
  return { userId: userId as UserId, issueId }
}
