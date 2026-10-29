import type { SessionView } from '../../../session-values'
/**
 * POD-330/POD-1496 — worklist row SHAPE: what a unified work-list row is, and
 * the one question answerable from the row alone (which sessions it speaks
 * for). Ordering, attention and folding are separate questions with their own
 * modules; nothing here reads them, so this module is the leaf of the worklist
 * graph.
 *
 * A row carries NO urgency rank. The sidebar stopped ordering by urgency in
 * #64 — attention is carried per-row by the square language, never by
 * reordering (see row-order.ts's header) — so the rank the row used to hold
 * had no reader anywhere in the tree and is gone (POD-1501).
 */

import type { MissionRollup } from '../../mission'
import { subtreeUnread } from '../../unread'
import type { IssueNavigationModel } from '../issues'
import type { WorktreeNavView } from './nav'

/** One issue row in the unified WORK LIST. Optional `startedByChildren` holds
 *  top-level agent-started issues nested under this one via `startedBySession`
 *  (M6 started-by tree — not a formal parentId edge). */
export type UnifiedIssueRow = {
  kind: 'issue'
  issue: IssueNavigationModel
  sessions: SessionView[]
  activityAt: number
  /** Formal parentId children plus agent-started provenance children. [spec:SP-6144] */
  startedByChildren?: UnifiedIssueRow[]
  /** Own + descendant sessions, used only for bubbled status/attention. */
  aggregateSessions?: SessionView[]
  /** Canonical task progress and whether the root is a child-derived container. */
  missionRollup?: MissionRollup
  /**
   * Where this row's work went, when it went somewhere else (POD-1193) — the
   * compact phrase, `continued · POD-1192`. Present IFF the work carried on
   * elsewhere, so it is both the verdict and the words.
   *
   * Stamped at construction because the question needs the whole issue graph
   * and every session in the replica ({@link issueContinuation}), which a row
   * on its own has neither of — and because the row's DESCENDANTS need the
   * same verdict when a parent sums attention over its branch.
   */
  continuation?: string
}

/** One row of the unified sidebar's WORK LIST: a human-origin issue (drafts
 *  included) or a with-session worktree not owned by any issue. */
export type UnifiedWorkRow =
  | UnifiedIssueRow
  | { kind: 'worktree'; worktree: WorktreeNavView; activityAt: number }

/** The sessions a row speaks for. An issue row prefers its bubbled aggregate
 *  (own + descendants) so status and attention read the WHOLE branch. */
export function rowSessions(row: UnifiedWorkRow): SessionView[] {
  return row.kind === 'issue' ? (row.aggregateSessions ?? row.sessions) : row.worktree.sessions
}

/** Descendants hidden behind a sidebar mission row. */
function descendantIssues(row: UnifiedIssueRow): IssueNavigationModel[] {
  const out: IssueNavigationModel[] = []
  const stack = [...(row.startedByChildren ?? [])]
  while (stack.length > 0) {
    const child = stack.pop()
    if (!child) continue
    out.push(child.issue)
    stack.push(...(child.startedByChildren ?? []))
  }
  return out
}

/** Whether a unified WORK/WORKING row should render with unread (email-style)
 *  emphasis. An issue row follows the replica-derived `unread` rollup for its
 *  own activity, then rolls descendant issue/session activity against THIS
 *  issue's readAt — so a collapsed mission stays unread until the click that
 *  opened it covers the whole tree. A worktree row owns no `unread` field of
 *  its own, so it's unread iff any of its sessions is. (#126, #124, POD-912.) */
function isRowUnread(row: UnifiedWorkRow): boolean {
  if (row.kind !== 'issue') return row.worktree.sessions.some((s) => s.unread)
  if (row.issue.unread) return true
  // Fixtures inject `unread: false` with no readAt. Honor that — never-read is
  // already represented by the replica's unread flag. Only a real cursor can
  // cover (or fail to cover) descendant activity.
  if (!row.issue.readAt) return false
  const children = descendantIssues(row)
  if (children.length === 0) return false
  return subtreeUnread({
    readAt: row.issue.readAt,
    updatedAt: row.issue.updatedAt,
    descendantUpdatedAts: children.map((issue) => issue.updatedAt),
    sessions: row.aggregateSessions ?? row.sessions,
  })
}

/** Whether a row has unseen activity. Working state alone says nothing
 * about whether the operator has actually viewed it. */
export function rowUnreadEmphasized(row: UnifiedWorkRow): boolean {
  return isRowUnread(row)
}
