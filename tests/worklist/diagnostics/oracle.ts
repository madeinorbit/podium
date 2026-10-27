/** Comparable fields of the pool's issue and session rows, for the screen
 * snapshots that compare a reference reading with the pool's.
 */
import { rowStatusLine, type UnifiedIssueRow } from '@podium/client-core/values'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'

/** All fields the existing row reads from its own issue. Presentation is kept
 * in that component, including refs, colours, labels and status formatting. */
export const ISSUE_CONTENT_FIELDS = [
  'id', 'seq', 'displayRef', 'linearIdentifier', 'title', 'stage', 'closedReason', 'closedAt', 'updatedAt',
  'audience', 'isDraftVessel', 'pinned', 'tuckedAt', 'readAt', 'unread', 'gitState',
  'repoPath', 'worktreePath', 'branch', 'parentBranch', 'parentId', 'needsHuman', 'blocked',
  'asked', 'intentOrigin',
] as const
const ISSUE_BOOLEAN_FIELDS = new Set(['isDraftVessel', 'pinned', 'needsHuman', 'blocked'])
const pick = (row: unknown, fields: readonly string[]): Record<string, unknown> => Object.fromEntries(fields.map(field => [field,
  ISSUE_BOOLEAN_FIELDS.has(field) ? (row as Record<string, unknown>)[field] === true : (row as Record<string, unknown>)[field] ?? null]))

/** PanelRow/WorkerLabel inputs, including raw attribution and outcome facts
 * whose formatting remains in those components. */
const SESSION_CONTENT_FIELDS = [
  'sessionId', 'issueId', 'displayRef', 'name', 'title', 'createdAt', 'agentKind',
  'agentColor', 'status', 'archived', 'lastActiveAt', 'readAt', 'unread',
  'agentState', 'offer', 'snoozedUntil', 'draftUpdatedAt', 'createdBy',
  'stoppedAt', 'stopReason', 'busy',
] as const
export const sessionComparable = (session: unknown) => pick(session, SESSION_CONTENT_FIELDS)

/** Compare raw compatibility payloads by the fields presentation actually
 * reads. No old record's irrelevant server supplement enters the oracle. */
export function sidebarComparable(value: SidebarRowValues | WorklistIssue): Record<string, unknown> {
  if ('worklist' in value) return {
    idNumber: value.issue.seq, title: value.title,
    timing: value.timing, working: value.visibleWorking, asking: value.visibleAsking,
    originTick: value.origin, decision: value.decision, mergeCommits: value.mergeCommits,
    progress: value.progress, fromChildren: value.hasChildProgress, statusFromChildren: value.showsChildProgress,
    gitState: value.issue.gitState, unread: value.visibleUnread, errorClass: value.errorClass,
    internal: value.issue.audience === 'agent', awaitsTuck: value.canTuck, canBringBack: value.canBringBack,
    unsnoozed: value.returnedFromDefer, deferred: value.issue.deferred, draftAgentOnly: value.sessionOnlyDraft,
    firstSessionId: value.firstSessionId, continuation: value.continuation, fleet: value.visibleFleet,
    issue: { ...pick(value.issue, ISSUE_CONTENT_FIELDS), unread: value.issue.unread },
    sessions: value.sessions.map(sessionComparable), aggregateSessionIds: value.visibleSessionIds,
    awaitingFirstPrompt: value.awaitingFirstPrompt,
  }
  return { ...value, issue: pick(value.issue, ISSUE_CONTENT_FIELDS),
    sessions: value.sessions.map(sessionComparable) }
}

/** Pure legacy formatter on the pool's compatibility payload. This pins the
 * actual status line while leaving copy/formatting in current presentation. */
export function poolStatusLine(input: SidebarRowValues | WorklistIssue, activityAt: number, now: number, seat: (id: string) => unknown): string {
  const value = 'worklist' in input ? sidebarComparable(input) as unknown as SidebarRowValues : input
  const continuation = value.continuation ? `${value.continuation.kind} · ${value.continuation.ref}` : undefined
  const row = { kind: 'issue', issue: value.issue, sessions: value.sessions,
    aggregateSessions: value.aggregateSessionIds.map(seat).filter(Boolean), missionRollup: { progress: value.progress, fromChildren: value.statusFromChildren }, activityAt, continuation } as unknown as UnifiedIssueRow
  return continuation ?? rowStatusLine(row, now, 0)
}
