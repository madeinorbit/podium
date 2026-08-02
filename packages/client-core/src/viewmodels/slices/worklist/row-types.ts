/**
 * POD-330/POD-1496 — worklist row SHAPE: what a unified work-list row is, and
 * the two questions answerable from the row alone (which sessions it speaks
 * for, and how urgently). Ordering, attention and folding are separate
 * questions with their own modules; nothing here reads them, so this module is
 * the leaf of the worklist graph.
 */
import { type SessionMeta } from '@podium/model'
import { isSessionWorking } from '../../session-status'
import { sessionUrgencyRank } from '../../session-urgency'
import type { IssueNavigationModel } from '../issues'
import type { WorktreeNavView } from './nav'

/** Rank of rows with NO sessions — sinks below every session-bearing row. */
export const UNIFIED_ROW_EMPTY_RANK = 4

/** One issue row in the unified WORK LIST. Optional `startedByChildren` holds
 *  top-level agent-started issues nested under this one via `startedBySession`
 *  (M6 started-by tree — not a formal parentId edge). */
export type UnifiedIssueRow = {
  kind: 'issue'
  issue: IssueNavigationModel
  sessions: SessionMeta[]
  activityAt: number
  rank: number
  /** Formal parentId children plus agent-started provenance children. [spec:SP-6144] */
  startedByChildren?: UnifiedIssueRow[]
  /** Own + descendant sessions, used only for bubbled status/attention. */
  aggregateSessions?: SessionMeta[]
}

/** One row of the unified sidebar's WORK LIST: a human-origin issue (drafts
 *  included) or a with-session worktree not owned by any issue. `rank` is the
 *  min of the child sessions' urgency ranks (UNIFIED_ROW_EMPTY_RANK when none). */
export type UnifiedWorkRow =
  | UnifiedIssueRow
  | { kind: 'worktree'; worktree: WorktreeNavView; activityAt: number; rank: number }

/** The sessions a row speaks for. An issue row prefers its bubbled aggregate
 *  (own + descendants) so status and attention read the WHOLE branch. */
export function rowSessions(row: UnifiedWorkRow): SessionMeta[] {
  return row.kind === 'issue' ? (row.aggregateSessions ?? row.sessions) : row.worktree.sessions
}

/** A row's urgency rank: the most urgent of its sessions, or the empty rank. */
export function rowRank(sessions: SessionMeta[], now: number): number {
  return sessions.reduce((min, s) => Math.min(min, sessionUrgencyRank(s, now)), UNIFIED_ROW_EMPTY_RANK)
}

/** Whether a unified WORK/WORKING row should render with unread (email-style)
 *  emphasis. An issue row follows the replica-derived `unread` rollup
 *  (which already aggregates member-session activity), so marking the issue read
 *  clears it. A worktree row owns no `unread` field of its own, so it's unread
 *  iff any of its sessions is. (#126, built on the #124 unread foundation.) */
export function isRowUnread(row: UnifiedWorkRow): boolean {
  return row.kind === 'issue'
    ? (row.issue.unread ?? false)
    : row.worktree.sessions.some((s) => s.unread)
}

/** Whether a unified row should actually RENDER the unread (email-style) emphasis.
 *  Extends `isRowUnread` with the #138 rule: a row that has a currently-working
 *  session is active work, not "new unseen work" — and a working session re-flips
 *  `unread` on every output — so its emphasis is suppressed wherever it renders
 *  (WORK or WORKING). Read rows and rows with only idle/waiting sessions are
 *  unaffected. Applies to the row LABEL; child session rows gate on
 *  `isSessionWorking` in PanelRow. */
export function rowUnreadEmphasized(row: UnifiedWorkRow): boolean {
  if (!isRowUnread(row)) return false
  return !rowSessions(row).some(isSessionWorking)
}
