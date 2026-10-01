import {
  errorPhrase,
  type IssueNavigationModel,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import type { SidebarWorktree } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues, SidebarTiming } from '@podium/client-graph/worklist/sidebar-row'
import { issueStatusLabel, type SessionMeta } from '@podium/model/browser'

/** The real row's displayed extension of ROW_DISPLAYED_FIELDS. Placement
 * keys, the raw roster and menu-only records do not repaint a flat mission. */
export function poolIssuePaint(value: SidebarRowValues) {
  const issue = value.issue
  return {
    display: poolIssueDisplay(value),
    title: value.title,
    progress: value.progress,
    origin: value.originTick,
    awaitsTuck: value.awaitsTuck,
    firstSessionId: value.firstSessionId,
    issue: {
      id: issue.id,
      seq: issue.seq,
      displayRef: issue.displayRef,
      linearIdentifier: issue.linearIdentifier,
      title: issue.title,
      audience: issue.audience,
      color: issue.color,
      branch: issue.branch,
      gitState: issue.gitState,
      stage: issue.stage,
      closedReason: issue.closedReason,
      closedAt: issue.closedAt,
      needsHuman: issue.needsHuman,
      asked: issue.asked,
    },
  }
}

/** Presentation facts supplied by the pool. The existing row owns all markup. */
export interface PoolIssueDisplay {
  timing: SidebarTiming
  working: boolean
  decision: 'merge' | 'review' | null
  unread: boolean
  errorLine: string | null
  draftAgentOnly: boolean
  statusLine: string
  unsnoozed: boolean
  deferred: boolean
  fleet: SidebarRowValues['fleet']
}

/** The pool supplies normalized facts through the shared navigation port. */
export function navigationIssue(value: SidebarRowValues['issue']): IssueNavigationModel {
  return value as unknown as IssueNavigationModel
}

export function poolIssueRow(value: SidebarRowValues): UnifiedIssueRow {
  return {
    kind: 'issue',
    issue: navigationIssue(value.issue),
    sessions: value.sessions as SessionMeta[],
    aggregateSessions: value.aggregateSessions as SessionMeta[],
    activityAt: value.timing.sinceMs,
    ...(value.continuation
      ? { continuation: `${value.continuation.kind} · ${value.continuation.ref}` }
      : {}),
  }
}

export function poolWorktreeRow(
  value: SidebarWorktree,
): Extract<UnifiedWorkRow, { kind: 'worktree' }> {
  return {
    kind: 'worktree',
    activityAt: value.activityAt,
    worktree: {
      ...value.worktree,
      isMain: value.worktree.isMain === true,
      sessions: value.sessions as SessionMeta[],
      issues: value.issues as unknown as IssueNavigationModel[],
    } as Extract<UnifiedWorkRow, { kind: 'worktree' }>['worktree'],
  }
}

/** Same status vocabulary as the current row, formatted from pool facts.
 * No legacy attention, rollup, membership or worklist selector runs here. */
export function poolIssueStatus(value: SidebarRowValues): string {
  if (value.awaitingFirstPrompt) return 'awaiting first prompt'
  if (value.statusFromChildren) {
    const { total, done, run, review, stall, block, wait } = value.progress
    if (total === 0) return 'no active subtasks'
    const progress = `${done}/${total} ${total === 1 ? 'subtask' : 'subtasks'} done`
    if (done === total) return progress
    const next =
      block > 0
        ? `${block} blocked`
        : review > 0
          ? `${review} in review`
          : run > 0
            ? `${run} underway`
            : stall > 0
              ? `${stall} stalled`
              : wait > 0
                ? `${wait} to go`
                : null
    return next ? `${progress} · ${next}` : progress
  }
  if (value.decision === 'merge')
    return value.mergeCommits > 0 ? `ready to merge · ${value.mergeCommits}` : 'ready to merge'
  if (value.decision === 'review') return 'needs review'
  if (value.continuation) return `${value.continuation.kind} · ${value.continuation.ref}`
  if (value.issue.blocked) return 'blocked'
  return issueStatusLabel(navigationIssue(value.issue)).toLowerCase()
}

export function poolIssueDisplay(value: SidebarRowValues): PoolIssueDisplay {
  return {
    timing: value.timing,
    working: value.working,
    decision: value.decision,
    unread: value.unread,
    errorLine: value.errorClass === null ? null : errorPhrase(value.errorClass, 'lower'),
    draftAgentOnly: value.draftAgentOnly,
    statusLine: value.continuation
      ? `${value.continuation.kind} · ${value.continuation.ref}`
      : poolIssueStatus(value),
    unsnoozed: value.unsnoozed,
    deferred: value.deferred,
    fleet: value.fleet,
  }
}

export function poolIssueHaystack(value: SidebarRowValues): string {
  return [value.issue.title, value.idNumber, value.issue.displayRef, poolIssueStatus(value)]
    .join(' ')
    .toLowerCase()
}

/** PanelRow's displayed extension: transport geometry and bookkeeping do not
 * redraw a guest. The pool retains the borrowed row for its existing menu. */
export function poolSessionPaint(s: SessionMeta) {
  return {
    sessionId: s.sessionId,
    agentKind: s.agentKind,
    name: s.name,
    title: s.title,
    machineId: s.machineId,
    handoffTarget: s.handoffTarget,
    displayRef: s.displayRef,
    issueId: s.issueId,
    status: s.status,
    agentState: s.agentState,
    busy: s.busy,
    snoozedUntil: s.snoozedUntil,
    stoppedAt: s.stoppedAt,
    stopReason: s.stopReason,
    unread: s.unread,
    draft: !!s.draftUpdatedAt,
    createdBy: s.createdBy,
    agentColor: s.agentColor,
  }
}
