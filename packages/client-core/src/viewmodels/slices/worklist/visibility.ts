/**
 * POD-330/POD-1496 — worklist VISIBILITY: does a finished issue or session
 * still belong on the live list, or has it decayed into history?
 *
 * Recorded as a non-finding in the ownership map (§3.2) and re-affirmed here:
 * these read like shared worklist/issues state, but every consumer is a
 * worklist row-placement decision, so they stay in worklist.
 */
import type { IssueWire, SessionMeta } from '@podium/model'
import {
  isClosedTopLevelIssue,
  issueAwaitingMerge,
  issueFinishedAt,
  type IssueNavigationModel,
} from '../issues'

export const SIDEBAR_FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** How long an UNREAD finished issue stays visible waiting for acknowledgment.
 *  Bounded so the historical population of never-read done issues (readAt did
 *  not always exist) cannot resurface forever with an unread badge. */
export const SIDEBAR_FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Acknowledgment-gated completion decay for the live sidebar. [spec:SP-6144] */
export function issueVisibleInSidebar(issue: IssueNavigationModel, now: number): boolean {
  const finished = issue.stage === 'done' || issue.closedReason != null
  if (!finished) return true
  // POD-183: closed top-level issues visually decay into a fold; they do not
  // disappear with time. Unread and selected presentation is handled later.
  if (isClosedTopLevelIssue(issue)) return true
  // Review/merge is still a human action. It does not decay like shipped work.
  if (issueAwaitingMerge(issue)) return true
  const finishedAt = issueFinishedAt(issue)
  // Unread keeps a finished row visible only within 7 days of finishing —
  // beyond that it is history, not pending acknowledgment.
  if (issue.unread || !issue.readAt) {
    return now - finishedAt <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  const anchor = Math.max(finishedAt, Date.parse(issue.readAt) || 0)
  return now - anchor <= SIDEBAR_FINISHED_GRACE_MS
}

export function sessionVisibleInSidebar(s: SessionMeta, now: number, issue?: IssueWire): boolean {
  const issueFinished =
    issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
  const agentState = s.agentState
  const idleDone = agentState?.phase === 'idle' && agentState.idle?.kind === 'done'
  const finishedAt =
    s.stoppedAt ??
    (agentState?.phase === 'ended'
      ? agentState.since
      : idleDone && issueFinished
        ? (issue?.closedAt ?? issue?.updatedAt ?? agentState.since)
        : undefined)
  if (!finishedAt) return true
  const finishedAtMs = Date.parse(finishedAt) || 0
  if (s.unread || !s.readAt) {
    return now - finishedAtMs <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  const anchor = Math.max(finishedAtMs, Date.parse(s.readAt) || 0)
  return now - anchor <= SIDEBAR_FINISHED_GRACE_MS
}
