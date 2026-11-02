import type { SessionView } from '@podium/client-core/session-values'
import {
  errorPhrase,
  type IssueNavigationModel,
  type UnifiedIssueRow,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { SidebarRowValues, SidebarTiming } from '@podium/client-graph/worklist/sidebar-row'
import { issueStatusLabel } from '@podium/model/browser'

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
  mergeCommits: number
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
    sessions: value.sessions as SessionView[],
    // No subtree session rows (POD-5423): the row's fleet glyphs come from
    // the supplied summary (`display.fleet`), so none is drawn from them.
    activityAt: value.timing.sinceMs,
    ...(value.continuation
      ? { continuation: `${value.continuation.kind} · ${value.continuation.ref}` }
      : {}),
  }
}

/** Same status vocabulary as the current row, formatted from pool facts.
 * No legacy attention, rollup, membership or worklist selector runs here. */
export function poolIssueStatus(value: SidebarRowValues): string {
  return formatIssueStatus(value)
}

export function worklistIssueStatus(value: WorklistIssue): string {
  return formatIssueStatus(value)
}

// One vocabulary for the live companion and its frozen departure paint.
function formatIssueStatus(value: WorklistIssue | SidebarRowValues): string {
  if (value.awaitingFirstPrompt) return 'awaiting first prompt'
  if ('showsChildProgress' in value ? value.showsChildProgress : value.statusFromChildren) {
    const progressValue = value.progress
    if (progressValue === LOADING) return 'no active subtasks'
    const { total, done, working, waiting, todo } = progressValue
    if (total === 0) return 'no active subtasks'
    const progress = `${done}/${total} ${total === 1 ? 'subtask' : 'subtasks'} done`
    if (done === total) return progress
    const next =
      working > 0
        ? `${working} working`
        : waiting > 0
          ? `${waiting} waiting`
          : todo > 0
            ? `${todo} to do`
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
    mergeCommits: value.mergeCommits,
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

/** Freeze the departing row's last paint. Live rows always read their companion. */
export function sidebarExitSnapshot(value: WorklistIssue): SidebarRowValues {
  const issue = value.issue
  const progress = value.progress
  if (progress === LOADING) throw LOADING
  return {
    idNumber: issue.seq, title: value.title,
    timing: value.timing, working: value.visibleWorking, asking: value.visibleAsking,
    originTick: value.origin, decision: value.decision, mergeCommits: value.mergeCommits,
    progress, fromChildren: value.hasChildProgress, statusFromChildren: value.showsChildProgress,
    gitState: issue.gitState, unread: value.visibleUnread, errorClass: value.errorClass,
    internal: issue.audience === 'agent', unsnoozed: value.returnedFromDefer, deferred: issue.deferred,
    awaitsTuck: value.canTuck, canBringBack: value.canBringBack, draftAgentOnly: value.sessionOnlyDraft,
    firstSessionId: value.firstSessionId, continuation: value.continuation, fleet: value.visibleFleet,
    issue: {
      id: issue.id, seq: issue.seq, displayRef: issue.displayRef, linearIdentifier: issue.linearIdentifier,
      title: issue.title, audience: issue.audience, branch: issue.branch,
      gitState: issue.gitState, stage: issue.stage, closedReason: issue.closedReason, closedAt: issue.closedAt,
      landedAt: issue.landedAt, landedSha: issue.landedSha, parentBranch: issue.parentBranch,
      needsHuman: issue.needsHuman, asked: issue.asked, updatedAt: issue.updatedAt,
      tuckedAt: issue.tuckedAt, deferUntil: issue.deferUntil, worktreePath: issue.worktreePath,
      isDraftVessel: issue.isDraftVessel, pinned: issue.pinned, parentId: issue.parentId,
      repoPath: issue.repoPath, createdAt: issue.createdAt, blocked: issue.blocked, readAt: issue.readAt,
    } as SidebarRowValues['issue'],
    sessions: value.sessions.map(session => ({ sessionId: session.sessionId })) as unknown as SidebarRowValues['sessions'],
    aggregateSessionIds: value.visibleSessionIds, awaitingFirstPrompt: value.awaitingFirstPrompt,
  }
}

export function worklistIssueHaystack(value: WorklistIssue): string {
  return [value.issue.title, value.issue.seq, value.issue.displayRef, worklistIssueStatus(value)].join(' ').toLowerCase()
}

/**
 * THE ROW'S ONE STATUS VOICE (POD-2074, the calm design's `S` map).
 *
 * Every row says its state once, as a mark plus a word on line 2. Two inks are
 * reserved: bronze for "this needs you" and blue for "an agent is computing".
 * Everything else sits on the neutral ramp, so a column of thirty rows reads as
 * quiet with a few bronze lines in it.
 */
export { rowVoice, type RowTone, type RowVoice, type RowVoiceInput } from '@podium/client-graph/worklist/voice'
