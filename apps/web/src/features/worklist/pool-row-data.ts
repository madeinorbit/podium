import type { SessionView } from '@podium/client-core/session-values'
import {
  errorPhrase,
  type IssueNavigationModel,
  type UnifiedIssueRow,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { SidebarRowValues, SidebarTiming } from '@podium/client-graph/worklist/sidebar-row'
import { ISSUE_STATUS_LABELS, issueLanding, issueStatusLabel, issueStatusOf } from '@podium/model/browser'

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
export type RowTone =
  /** Needs review, waiting on you, ready to merge: bisque dot, bronze word. */
  | 'needs'
  /** An agent is computing: the shared working mark. */
  | 'working'
  /** Started but nobody is computing: hollow blue ring. */
  | 'active'
  /** Planned or queued: hollow grey ring. */
  | 'idle'
  /** Every subtask done, awaiting the parent: soft filled dot. */
  | 'settled'
  /** Finished: a check, muted row. */
  | 'done'
  /** Stopped without finishing: a minus, muted row. */
  | 'closed'
  /** A draft that has not started. */
  | 'draft'
  /** An agent stopped on an error. */
  | 'error'

/** What line 2 says, in the calm design's vocabulary (POD-2074): one tone, one
 * word, and an optional sub-fact. The old status sentence stays the filter's
 * haystack, so typing "needs review" or "2 working" still finds a row. */
export interface RowVoice {
  tone: RowTone
  word: string
  /** The trailing fact after the word: `· 7/7`, or `3/3` on a settled row. */
  sub: string | null
}

export interface RowVoiceInput {
  decision: 'merge' | 'review' | null
  phase: SidebarTiming['phase']
  working: boolean
  awaitingFirstPrompt?: boolean
  showsChildProgress: boolean
  progress: { done: number; total: number } | null
  issue: SidebarRowValues['issue'] | IssueNavigationModel
  continuation?: { kind: string; ref: string } | null
}

export function rowVoice(input: RowVoiceInput): RowVoice {
  const total = input.progress?.total ?? 0
  const done = input.progress?.done ?? 0
  // A lone subtask's `0/1` says nothing the word does not; two or more tally.
  const fraction = total > 1 ? `${done}/${total}` : null
  const sub = fraction ? `· ${fraction}` : null
  const issue = input.issue as unknown as IssueNavigationModel
  const status = issueStatusOf(issue)
  // A closed handoff points FORWARD — where the work continued — and asks
  // nothing here (POD-1193 withdraws its decision).
  if (input.continuation)
    return {
      tone: status === 'done' ? 'done' : 'idle',
      word: `${capitalize(input.continuation.kind)} · ${input.continuation.ref}`,
      sub: null,
    }
  // A finished branch awaiting merge still needs you.
  if (input.decision === 'merge')
    return {
      tone: 'needs',
      word: 'Ready to merge',
      sub,
    }
  if (input.decision === 'review') return { tone: 'needs', word: 'Needs review', sub }
  if (status === 'done') {
    // A merge-action landing names where it went and what (POD-2151).
    const landing = issueLanding(issue)
    if (!landing) return { tone: 'done', word: 'Done', sub: null }
    const facts = [landing.branch, landing.sha].filter(Boolean)
    return { tone: 'done', word: 'Landed', sub: facts.length > 0 ? `· ${facts.join(' · ')}` : null }
  }
  if (status === 'cancelled' || status === 'duplicate' || status === 'superseded')
    return { tone: 'closed', word: ISSUE_STATUS_LABELS[status], sub: null }
  if (input.phase === 'waiting') return { tone: 'needs', word: 'Waiting on you', sub }
  if (input.working) return { tone: 'working', word: 'Working', sub }
  if (input.awaitingFirstPrompt) return { tone: 'draft', word: 'Draft', sub: null }
  if (input.showsChildProgress && total > 0 && done === total)
    return { tone: 'settled', word: 'Subtasks done', sub: fraction }
  if ((issue as { blocked?: boolean }).blocked) return { tone: 'idle', word: 'Blocked', sub }
  if (status === 'in_progress' || status === 'review' || status === 'shipping')
    return {
      tone: 'active',
      word: status === 'review' ? 'In review' : capitalize(issueStatusLabel(issue).toLowerCase()),
      sub,
    }
  return { tone: 'idle', word: capitalize(issueStatusLabel(issue).toLowerCase()), sub }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
