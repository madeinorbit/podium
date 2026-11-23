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
 * ONE ROW PER (USER, ISSUE), NOT ONE PER MARKER
 * ---------------------------------------------------------------------------
 * `readAt` and `tuckedAt` (and the personal records below) share a key, are
 * written by the same principal, and are read together by exactly one caller
 * (the issue projection). Separate tables would be joins on every issue list
 * for no invariant gained.
 *
 * The session half is deliberately NOT folded in with them. `session_user_state`
 * and `snoozes` stay two tables because `snoozes` already exists, is already
 * keyed `(user_id, session_id)` (POD-380), and merging it would be a data move
 * with no reader asking for one.
 *
 * ---------------------------------------------------------------------------
 * AN ISSUE'S PIN IS A PIN RECORD (POD-6692)
 * ---------------------------------------------------------------------------
 * The pin was a third marker here (`pinned_at`) beside the `pins` table that
 * held every other pin. Since POD-6692 it is a `pin` record of kind 'issue'
 * (`synced-records.ts`), so one rule covers all pins: pin = create, unpin =
 * remove. This row carries no pin, and its wire has no `pinned`.
 */

import { z } from 'zod'
import { parseUserEntityKey, perUserKey, userEntityKey } from '../fields/per-user-key'
import { asIssueId, type IssueId, IssueIdField, type UserId } from '../ids'
import { perUserKeyOfString } from './session-state'

/**
 * HOW A PERSON CAME TO A TASK (POD-6290). The first reason is kept.
 * - `start`: the person started work on it themselves (created it, or started a
 *   session of their own on it).
 * - `agent`: one of their agents did (a session their agent spawned landed on it,
 *   or their agent created or joined it): their own agent's elevation.
 * - `join`: they joined it explicitly.
 */
export const IssueJoinVia = z.enum(['start', 'agent', 'join'])
export type IssueJoinVia = z.infer<typeof IssueJoinVia>

/**
 * ISSUE PER-USER STATE — `(userId, issueId)` → this person's read marker, tuck
 * marker and personal records.
 *
 * All are nullable and all mean the same thing when null: this person has not
 * done that. An absent ROW is equivalent to a row of nulls,
 * and the storage deletes rather than storing one — same rule as the session
 * half, for the same reason.
 */
export const IssueUserState = perUserKey(IssueIdField).extend({
  /** When this person last opened the issue. `null` = never. */
  readAt: z.string().nullable(),
  /** When this person tucked it away. `null` = not tucked. */
  tuckedAt: z.string().nullable(),
  /**
   * PERSONAL RECORDS (POD-6290; docs/design/multi-user-instance.md §2.2, §4.4).
   * When this person first started or joined the task, and how. Opening,
   * searching or reading a task writes only `readAt`, never these. Optional on
   * the wire so a row from an older server reads as "no record".
   */
  joinedAt: z.string().nullable().optional(),
  joinedVia: IssueJoinVia.nullable().optional(),
  /** The removable "assigned to you by X" row: when the task was assigned to this
   *  person, and by whom. Cleared when it is reassigned away or dismissed. */
  assignedAt: z.string().nullable().optional(),
  assignedBy: z.string().nullable().optional(),
})
export type IssueUserState = z.infer<typeof IssueUserState>

/** A task is in a person's personal set when they started or joined it, or it
 *  carries their assigned row. One function, so the server and every client
 *  spell it the same way. */
export const inPersonalSet = (
  row: Pick<IssueUserState, 'joinedAt' | 'assignedAt'> | undefined,
): boolean => row != null && (row.joinedAt != null || row.assignedAt != null)

/** A collaborator is a person with a start or join record (design §2.2). An
 *  assignment alone does not make one, and being one grants no access. */
export const isCollaboratorRecord = (row: Pick<IssueUserState, 'joinedAt'> | undefined): boolean =>
  row?.joinedAt != null

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
 * than as fields on the shared row.
 */
export interface IssueUserOverlay {
  readonly readAt: string | null
  readonly tuckedAt: string | null
}

/** The overlay of a user who has never touched an issue. */
export const NO_ISSUE_USER_STATE: IssueUserOverlay = {
  readAt: null,
  tuckedAt: null,
}

/** Project a stored row onto the overlay the wire wants. One function, so the
 *  issue list, the single-issue read and the CLI cannot drift. */
export const issueOverlayOf = (
  row: Pick<IssueUserState, 'readAt' | 'tuckedAt'> | undefined,
): IssueUserOverlay =>
  row === undefined ? NO_ISSUE_USER_STATE : { readAt: row.readAt, tuckedAt: row.tuckedAt }

/** R4 personal issue markers: the stored row as it is. An absent row means none. */
export const IssueUserStateWire = IssueUserState
export type IssueUserStateWire = z.infer<typeof IssueUserStateWire>

export const issueUserStateToWire = (row: IssueUserState): IssueUserStateWire => ({
  userId: row.userId,
  entityId: row.entityId,
  ...issueOverlayOf(row),
  // The personal records ride the same row (POD-6290), present only when set
  // so a row without them keeps its exact former shape.
  ...(row.joinedAt != null ? { joinedAt: row.joinedAt, joinedVia: row.joinedVia ?? null } : {}),
  ...(row.assignedAt != null
    ? { assignedAt: row.assignedAt, assignedBy: row.assignedBy ?? null }
    : {}),
})

/** The family's canonical composite encoding, also used for removes/evictions. */
export const issueUserStateRowId = (userId: UserId, issueId: IssueId): string =>
  userEntityKey(userId, { kind: 'issue', id: issueId })

export function parseIssueUserStateRowId(id: string): Pick<IssueUserState, 'userId' | 'entityId'> {
  const key = parseUserEntityKey(id)
  if (key.kind !== 'issue') throw new Error('issue user-state key must name an issue')
  return { userId: key.user, entityId: asIssueId(key.id) }
}
