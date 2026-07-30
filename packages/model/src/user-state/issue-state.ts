/**
 * PER-USER STATE FAMILY — the issue half (POD-1076).
 *
 * Three facts that ADR 1's matrix has always declared `per-user-state` and that
 * storage has always kept as singleton columns on the shared entity row:
 * `issues.read_at`, `issues.tucked_at` and `issues.pinned`, plus
 * `issue_messages.read_at`. ADR 1's own `conflictNote` on the
 * `issue-message-read-at` row says so in as many words — *"Two more SINGLETON
 * `read_at` columns today; the same re-key as the session one"* — and POD-311
 * pinned the divergence with a tripwire rather than a comment so that landing
 * this file would turn it red.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW PER (USER, ISSUE), NOT THREE
 * ---------------------------------------------------------------------------
 * `readAt`, `tuckedAt` and `pinnedAt` share a key, are written by the same
 * principal, and are read together by exactly one caller (the issue projection).
 * Three tables would be three joins on every issue list for no invariant gained:
 * they are independent VALUES, but they are not independent ROWS, and the
 * `single-writer` rule the family gets from having the user in the key applies to
 * the row either way.
 *
 * The session half is deliberately NOT folded in with them. `session_user_state`
 * and `snoozes` stay two tables because `snoozes` already exists, is already
 * keyed `(user_id, session_id)` (POD-380), and merging it would be a data move
 * with no reader asking for one.
 *
 * ---------------------------------------------------------------------------
 * `pinnedAt` IS A TIMESTAMP, WHERE `issues.pinned` WAS A FLAG
 * ---------------------------------------------------------------------------
 * The column was `integer NOT NULL DEFAULT 0`. Per-user it becomes a nullable
 * timestamp, matching `pins.pinned_at` — because the eventual collapse of the two
 * pin mechanisms (inventory §7.1: *"note it is a **second** pin mechanism;
 * POD-1076 should collapse the two"*) needs both sides to carry the same value,
 * and a boolean cannot be widened into an ordering later without a second
 * migration. The wire projection keeps `pinned: boolean` — `pinnedAt != null` —
 * so no client changes.
 *
 * The collapse ITSELF is not done here. It is a wire and UI change across the
 * `pins` table's three kinds, and POD-1076 closes without it: both mechanisms are
 * correctly keyed per user after this. It is filed as a spin-off with a
 * `discovered-from` edge rather than absorbed into a migration issue's diff.
 */

import { z } from 'zod'
import { perUserKey } from '../fields/per-user-key'
import { IssueIdField } from '../ids'
import { perUserKeyOfString } from './session-state'

/**
 * ISSUE PER-USER STATE — `(userId, issueId)` → this person's read marker, tuck
 * marker and pin.
 *
 * All three are nullable and all three mean the same thing when null: this
 * person has not done that. An absent ROW is equivalent to a row of three nulls,
 * and the storage deletes rather than storing one — same rule as the session
 * half, for the same reason.
 */
export const IssueUserState = perUserKey(IssueIdField).extend({
  /** When this person last opened the issue. `null` = never. */
  readAt: z.string().nullable(),
  /** When this person tucked it away. `null` = not tucked. */
  tuckedAt: z.string().nullable(),
  /** When this person pinned it. `null` = not pinned. See the header on why this
   *  is a timestamp and the wire keeps a boolean. */
  pinnedAt: z.string().nullable(),
})
export type IssueUserState = z.infer<typeof IssueUserState>

/**
 * TRACKER-MAIL READ STATE — `(userId, issueMessageId)` → when this person read
 * that message.
 *
 * The entity half declines the brand: there is no `IssueMessageId` in the POD-301
 * family and inventing one here would mint a brand mid-phase for a single
 * consumer, which `ids/brands.ts` is explicit is the wrong move. It is still
 * validated as a string rather than left `any` — "unbranded" must not become
 * "unvalidated".
 *
 * DISTINCT FROM `issue_messages.status`. `status` ('unread' | 'read' | 'claimed')
 * is the mail's DELIVERY state — a shared fact about the message, which is why it
 * stays on the message row — while `read_at` is a fact about a reader. POD-311's
 * `mailInbox` consuming arm writes both, and only the second one moves.
 */
export const IssueMessageReadState = perUserKeyOfString().extend({
  readAt: z.string().nullable(),
})
export type IssueMessageReadState = z.infer<typeof IssueMessageReadState>

/** The issue-half members. See `./family.ts` for the union. */
export const ISSUE_USER_STATE_MEMBERS = [
  { name: 'issueUserState', schema: IssueUserState, table: 'issue_user_state' },
  {
    name: 'issueMessageReadState',
    schema: IssueMessageReadState,
    table: 'issue_message_user_state',
  },
] as const

/**
 * THE PER-USER VALUES AN ISSUE PROJECTION NEEDS FROM ONE VIEWER.
 *
 * The issue twin of `SessionUserOverlay`, and it exists for the same reason: the
 * projection needs a viewer, so the viewer's values arrive as an ARGUMENT rather
 * than as fields on the shared row. `pinned` is the boolean the wire has always
 * carried, derived here so the derivation has exactly one home.
 */
export interface IssueUserOverlay {
  readonly readAt: string | null
  readonly tuckedAt: string | null
  readonly pinned: boolean
}

/** The overlay of a user who has never touched an issue. */
export const NO_ISSUE_USER_STATE: IssueUserOverlay = {
  readAt: null,
  tuckedAt: null,
  pinned: false,
}

/** Project a stored row onto the overlay the wire wants. One function, so
 *  `pinnedAt != null` is spelled once and cannot drift between the issue list,
 *  the single-issue read and the CLI. */
export const issueOverlayOf = (
  row: Pick<IssueUserState, 'readAt' | 'tuckedAt' | 'pinnedAt'> | undefined,
): IssueUserOverlay =>
  row === undefined
    ? NO_ISSUE_USER_STATE
    : { readAt: row.readAt, tuckedAt: row.tuckedAt, pinned: row.pinnedAt != null }
