/**
 * POD-4446 — pure slice rules, transcribed from the legacy derivation
 * (frozen spec docs/plans/pod-4441-round-two-slice.md; citations inline).
 *
 * One definition shared by the incremental modules AND the from-scratch
 * rebuild: the rebuild oracle then checks the delta plumbing (dirty tracking,
 * chain walks), while parity against the legacy oracle checks these rules.
 * No imports from legacy view-model / slice / mission / presentation code —
 * every rule below is re-expressed from the spec (H4 shape review).
 *
 * Conventions: `now` is always SliceLocals.coarseNow (never Date.now()).
 * Defensive reads (`as {…} | undefined`) cover wire fields the SliceIssue
 * type does not declare but the stream value carries (branch, gitState,
 * supersededBy, dependents): absent on replay rows, present on engine rows.
 */

import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'

export const DAY_MS = 24 * 60 * 60 * 1000
export const SIDEBAR_FINISHED_GRACE_MS = DAY_MS
export const SIDEBAR_FINISHED_UNREAD_WINDOW_MS = 7 * DAY_MS
export const DRAFT_ISSUE_TITLE = 'Draft'
export const DEFER_NEXT_MESSAGE = 'next-message'

const UNSTARTED = new Set(['proposed', 'backlog'])
const UNDERWAY = new Set(['planning', 'in_progress', 'shipping'])

const PANEL_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi',
  shell: 'Shell',
}

export function parseMs(iso: string | null | undefined): number | null {
  if (iso == null) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

// ---------------------------------------------------------------- sessions

type Attention = 'needsYou' | 'idle' | 'working'

function idleKindOf(s: SliceSession): string | undefined {
  return (s.agentState as { idle?: { kind?: string } } | undefined)?.idle?.kind
}

function idleNeedsHuman(kind: string | undefined): boolean {
  return kind === 'question' || kind === 'approval' || kind === 'interrupted'
}

function idleFinishedTurn(kind: string | undefined): boolean {
  return kind === 'done' || kind === 'open_todos'
}

/** attentionGroup (focus.ts:25): offers win; parked/working demotions kept. */
export function attentionGroup(s: SliceSession): Attention {
  if (s.offer) return 'needsYou'
  const phase = s.agentState?.phase
  if (phase === 'needs_user' || phase === 'errored') return 'needsYou'
  if (phase === 'idle') return idleNeedsHuman(idleKindOf(s)) ? 'needsYou' : 'idle'
  if (phase === 'working' || phase === 'compacting') {
    return s.status === 'exited' || s.status === 'hibernated' ? 'idle' : 'working'
  }
  if (s.agentKind === 'shell') {
    return (s as { busy?: boolean }).busy === true ? 'working' : 'idle'
  }
  return s.status === 'live' || s.status === 'starting' || s.status === 'reconnecting'
    ? 'working'
    : 'idle'
}

type BadgeTone = 'working' | 'idle' | 'attention' | 'error' | 'muted' | null

/** agentBadge tone (session-status.ts:154), reduced to the tone. */
function badgeTone(s: SliceSession, issueFinished: boolean): BadgeTone {
  if (s.offer && !issueFinished) return 'attention'
  const state = s.agentState
  if (!state) return null
  if (state.phase === 'unknown') {
    return (state as { observationGap?: boolean }).observationGap === true ? 'muted' : null
  }
  switch (state.phase) {
    case 'working':
    case 'compacting':
      return 'working'
    case 'idle': {
      const kind = idleKindOf(s)
      return kind === 'question' || kind === 'approval' ? 'attention' : 'idle'
    }
    case 'needs_user':
      return 'attention'
    case 'errored':
      return 'error'
    case 'ended':
      return 'muted'
    default:
      return null
  }
}

/** sessionDotTone (session-status.ts:361), reduced to the working verdict. */
export function isSessionWorking(s: SliceSession): boolean {
  if (s.status === 'exited') return false
  if (s.status === 'starting' || s.status === 'reconnecting') return false
  const finished = false
  const badge = badgeTone(s, finished)
  if (badge !== null) {
    if (badge === 'working') return s.status !== 'hibernated'
    return false
  }
  if (s.agentKind === 'shell') return (s as { busy?: boolean }).busy === true
  return false
}

function hasNonOfferNeedsYou(s: SliceSession): boolean {
  if (!s.offer) return attentionGroup(s) === 'needsYou'
  const { offer: _drop, ...rest } = s
  return attentionGroup(rest as SliceSession) === 'needsYou'
}

/** motionPhase (session-status.ts:455): waiting dominates, then working. */
export function motionPhase(s: SliceSession, issue?: SliceIssue): 'queued' | 'working' | 'waiting' | 'done' {
  if (attentionGroup(s) === 'needsYou') {
    const finished = issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
    if (!(finished === true && s.offer !== undefined && !hasNonOfferNeedsYou(s))) return 'waiting'
  }
  const phase = s.agentState?.phase
  if (phase === 'ended' || (phase === 'idle' && idleFinishedTurn(idleKindOf(s)))) return 'done'
  if (isSessionWorking(s)) return 'working'
  return 'queued'
}

/** isOfferOnlyAttention (session-status.ts:484). */
export function isOfferOnlyAttention(s: SliceSession): boolean {
  return s.offer !== undefined && !hasNonOfferNeedsYou(s)
}

/** sessionPresentOnTask (fleet.ts:36): still assigned, whatever it is doing. */
export function openSession(s: SliceSession): boolean {
  return !s.archived && s.status !== 'exited'
}

// ------------------------------------------------------- retention (R-VIS)

/** sessionRetainsWorklistRow (visibility.ts:44). */
export function sessionRetains(
  s: SliceSession,
  now: number,
  issue?: SliceIssue,
): boolean {
  if (s.archived) return false
  const issueFinished =
    issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
  const phase = s.agentState?.phase
  const idleDone = phase === 'idle' && idleFinishedTurn(idleKindOf(s))
  const finishedAt =
    s.stoppedAt ??
    (phase === 'ended'
      ? s.agentState?.since
      : idleDone && issueFinished
        ? (issue?.closedAt ?? issue?.updatedAt ?? s.agentState?.since)
        : undefined)
  if (finishedAt == null) return true
  const ms = parseMs(finishedAt) ?? 0
  if (s.unread === true || s.readAt == null) return now - ms <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  return now - Math.max(ms, parseMs(s.readAt) ?? 0) <= SIDEBAR_FINISHED_GRACE_MS
}

/** sessionVisibleInLiveRoster (visibility.ts:73). */
export function sessionLive(s: SliceSession, now: number, issue?: SliceIssue): boolean {
  return s.status !== 'exited' && sessionRetains(s, now, issue)
}

// ------------------------------------------------------------------ issues

export function issueFinished(issue: SliceIssue): boolean {
  return issue.stage === 'done' || issue.closedReason != null
}

/** issueFinishedAt (slices/issues.ts:310). */
export function issueFinishedAt(issue: Pick<SliceIssue, 'closedAt' | 'updatedAt'>): number {
  return parseMs(issue.closedAt ?? issue.updatedAt) ?? 0
}

/** isClosedTopLevelIssue (slices/issues.ts:318). */
export function isClosedTopLevel(issue: SliceIssue): boolean {
  return issue.closedReason != null && (issue.parentId ?? null) === null && issue.audience === 'human'
}

type CloseOutcome = 'open' | 'completed' | 'cancelled'

function canonicalCloseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  if (!key) return null
  const legacy: Record<string, string> = {
    wontfix: 'cancelled',
    wont_fix: 'cancelled',
    "won't fix": 'cancelled',
    'not planned': 'cancelled',
    canceled: 'cancelled',
    dupe: 'duplicate',
  }
  if (legacy[key] !== undefined) return legacy[key] as string
  return key === 'done' || key === 'cancelled' || key === 'duplicate' || key === 'superseded'
    ? key
    : null
}

/** issueStatusOf + outcome (model issue-status.ts:220,163), reduced. */
function closeOutcome(issue: Pick<SliceIssue, 'stage' | 'closedReason'>): CloseOutcome {
  const reason = canonicalCloseReason(issue.closedReason)
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  switch (status) {
    case 'cancelled':
    case 'duplicate':
    case 'superseded':
      return 'cancelled'
    case 'done':
      return 'completed'
    default:
      return 'open'
  }
}

/** issueAbandoned (slices/issues.ts:338). */
export function issueAbandoned(issue: Pick<SliceIssue, 'stage' | 'closedReason'>): boolean {
  return closeOutcome(issue) === 'cancelled'
}

interface WireExtra {
  supersededBy?: string
  duplicateOf?: string
}

function wireExtra(issue: SliceIssue): WireExtra {
  return issue as SliceIssue & WireExtra
}

/**
 * issueAwaitingMerge (slices/issues.ts:369) is always false in the worklist:
 * it reads `branch`/`gitState`, which the navigation model never carries
 * (deriveIssueViews drops them — replica/issue-views.ts has no such read),
 * so the legacy slice never sees an unmerged delivery. The oracle encodes
 * that; a "better" merge reading would fail parity (spec: legacy wins).
 */
export function issueAwaitingMerge(_issue: SliceIssue): boolean {
  return false
}

export type PendingDecision = 'merge' | 'review' | null

/**
 * issuePendingDecision (slices/issues.ts:391) over model fields: without
 * gitState only the review branch can fire — finished non-review issues
 * hold no open question in the worklist.
 */
export function issuePendingDecision(issue: SliceIssue): PendingDecision {
  if (!issueFinished(issue) && issue.stage !== 'review') return null
  if (issue.blocked === true) return null
  if (issueAbandoned(issue)) return null
  return issue.stage === 'review' ? 'review' : null
}

/** issueVisibleInSidebar (visibility.ts:25). `unread` is the replica rollup
 *  (deriveIssueViews), never the wire field — see derivedUnread below. */
export function issueVisibleInSidebar(issue: SliceIssue, now: number, unread: boolean): boolean {
  if (!issueFinished(issue)) return true
  if (isClosedTopLevel(issue)) return true
  if (issueAwaitingMerge(issue)) return true
  const finishedAt = issueFinishedAt(issue)
  if (unread || issue.readAt == null) {
    return now - finishedAt <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  return now - Math.max(finishedAt, parseMs(issue.readAt) ?? 0) <= SIDEBAR_FINISHED_GRACE_MS
}

/**
 * Replica unread rollup (deriveIssueRollups, replica/issue-views.ts:383):
 * never read without a cursor, updated past the cursor, or with member
 * activity past it. Members are non-shell sessions carrying this issueId —
 * archived included (the rollup index skips shells only). Deleted rows read
 * as read.
 */
export function derivedUnread(issue: SliceIssue, members: SliceSession[]): boolean {
  if (issue.deletedAt != null) return false
  const readAt = issue.readAt ? Date.parse(issue.readAt) : null
  let unread = readAt === null || !Number.isFinite(readAt)
  if (!unread && readAt !== null) {
    const updatedAt = Date.parse(issue.updatedAt)
    unread = Number.isFinite(updatedAt) && (updatedAt as number) > (readAt as number)
  }
  for (const s of members) {
    if (s.agentKind === 'shell') continue
    if (!unread && s.lastActiveAt) {
      const activeAt = Date.parse(s.lastActiveAt)
      if (Number.isFinite(activeAt) && (readAt === null || (activeAt as number) > (readAt as number))) {
        unread = true
      }
    }
  }
  return unread
}

/** System-owned stage (model issue-vocabulary.ts:59): shipping only. */
export function isSystemStage(stage: string): boolean {
  return stage === 'shipping'
}

function deferMs(issue: SliceIssue): number | null {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return null
  return parseMs(issue.deferUntil)
}

/** isIssueDeferred (model issue-stage.ts:42). */
export function isDeferred(issue: SliceIssue, now: number): boolean {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return true
  const until = deferMs(issue)
  return until !== null && until > now
}

/** issueReturnedFromDefer (model issue-stage.ts:70). */
export function returnedFromDefer(issue: SliceIssue, now: number): boolean {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return false
  const until = deferMs(issue)
  return until !== null && until <= now
}

/** unifiedRowBand (row-order.ts:16): pinned/returned 0, snoozed 2, else 1. */
export function bandOf(issue: SliceIssue, now: number): 0 | 1 | 2 {
  if (issue.pinned === true || returnedFromDefer(issue, now)) return 0
  if (isDeferred(issue, now)) return 2
  return 1
}

// ---------------------------------------------------------------- display

/** issueDisplayRef (replica/issue-views.ts:233). */
export function displayRefOf(issue: SliceIssue, prefix: string | null): string {
  return prefix ? `${prefix}-${issue.seq}` : `#${issue.seq}`
}

/** issueDisplayTitle (slices/issues.ts:236): drafts wear the session's name. */
export function displayTitleOf(issue: SliceIssue, firstMember?: SliceSession): string {
  if (issue.draft === true) {
    const title = (issue.title ?? '').trim()
    if (title === DRAFT_ISSUE_TITLE || title === '') {
      if (!firstMember) return 'New agent'
      const name = (firstMember as { name?: string }).name?.trim()
      const kind = firstMember.agentKind ?? 'undefined'
      return name || `New ${PANEL_LABELS[kind] ?? kind} session`
    }
  }
  return issue.title
}

// ---------------------------------------------------------- spin-off graph

export function spinOffOriginId(issue: Pick<SliceIssue, 'deps'>): string | null {
  return issue.deps?.find((dep) => dep.type === 'discovered-from')?.id ?? null
}

export function hasLeftMission(stage: string, origin: string | null): boolean {
  return !UNSTARTED.has(stage) && origin !== null
}

/** Preferred live tip of one spin-off branch (mission.ts:715). */
export function preferredTip(
  candidates: SliceIssue[],
  openByIssue: (id: string) => boolean,
  lastActiveOf: (id: string) => string,
): SliceIssue | null {
  if (candidates.length === 0) return null
  const staffed = candidates.filter((issue) => openByIssue(issue.id))
  const pool =
    staffed.length > 0
      ? staffed
      : candidates.filter((issue) => !issue.closedReason && issue.stage !== 'done')
  const pick = (pool.length > 0 ? pool : candidates).slice()
  pick.sort((a, b) =>
    lastActiveOf(b.id) > lastActiveOf(a.id) ? 1 : lastActiveOf(b.id) < lastActiveOf(a.id) ? -1 : 0,
  )
  return pick[0] ?? null
}

// -------------------------------------------------------------- R-VIS flat

/** Structural exclusion, first clause of buildUnifiedRows (rows.ts:62-69). */
export function structurallyExcluded(issue: SliceIssue): boolean {
  return (
    issue.archived === true ||
    issue.deletedAt != null ||
    issue.stage === 'proposed' ||
    isSystemStage(issue.stage)
  )
}

/**
 * Sessionless keep rule, second clause (rows.ts:90-106): an active human
 * issue carries its own lifecycle; a finished issue stays only awaiting-merge
 * or as a closed top-level, subject to decay.
 */
export function sessionlessKept(issue: SliceIssue, now: number, unread: boolean): boolean {
  const activeHuman =
    issue.audience === 'human' &&
    (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
  if (activeHuman) return true
  if (!issueFinished(issue)) return false
  if (
    !issueAwaitingMerge(issue) &&
    !isClosedTopLevel(issue) &&
    ((issue.parentId ?? null) === null || issue.audience === 'agent')
  ) {
    return false
  }
  return issueVisibleInSidebar(issue, now, unread)
}

/** Rescue eligibility (rows.ts:138-147): live human-audience, unfinished. */
export function rescueEligible(issue: SliceIssue): boolean {
  if (
    issue.archived === true ||
    issue.deletedAt != null ||
    issue.stage === 'proposed' ||
    isSystemStage(issue.stage)
  ) {
    return false
  }
  return issue.audience === 'human' && !issueFinished(issue)
}

// ------------------------------------------------------------ R-ORDER rank

/**
 * WORK-list order (row-order.ts:65): band, manual sortKey among siblings
 * (keyed before unkeyed), creation desc, seq desc, id. Activity never sorts.
 */
export function compareRank(
  a: { band: number; sortKey: string | null; createdAt: string; seq: number; id: string },
  b: { band: number; sortKey: string | null; createdAt: string; seq: number; id: string },
): number {
  if (a.band !== b.band) return a.band - b.band
  const ka = a.sortKey || null
  const kb = b.sortKey || null
  if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -1 : 1
  if (ka !== null && kb === null) return -1
  if (ka === null && kb !== null) return 1
  const dt = (parseMs(b.createdAt) ?? 0) - (parseMs(a.createdAt) ?? 0)
  if (dt !== 0) return dt
  if (a.seq !== b.seq) return b.seq - a.seq
  return a.id.localeCompare(b.id)
}

// ------------------------------------------------------------ R-GROUP fold

/** finishedIssueSettled (folds.ts:93): closed top-level, nothing asked. */
export function settledForFold(args: {
  issue: SliceIssue
  waiting: number
}): boolean {
  return (
    isClosedTopLevel(args.issue) &&
    args.issue.needsHuman !== true &&
    !issueAwaitingMerge(args.issue) &&
    args.waiting === 0
  )
}

/** The timestamp Closed sorts by (folds.ts:82). */
export function closedFoldAt(issue: SliceIssue): number {
  return parseMs(issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt) ?? 0
}

/**
 * rowInClosedFold (folds.ts:118): abandoned folds immediately, tuck folds
 * even while selected, otherwise grace-window auto-fold with the selection
 * latch (a selected open finished row stays open until focus moves).
 */
export function inClosedFold(args: {
  issue: SliceIssue
  waiting: number
  selectedIssueId: string | null
  selectedIssueWasFolded: boolean
  now: number
}): boolean {
  if (!settledForFold(args)) return false
  if (issueAbandoned(args.issue)) return true
  if (args.issue.tuckedAt != null) return true
  if (args.issue.id !== args.selectedIssueId || args.selectedIssueWasFolded) {
    return args.now - issueFinishedAt(args.issue) > SIDEBAR_FINISHED_GRACE_MS
  }
  return false
}

/** Group key + label (folds.ts:194-203): repoId ?? repoPath, path tail. */
export function groupKeyOf(issue: SliceIssue): string {
  return issue.repoId ?? issue.repoPath
}

export function groupLabelOf(issue: SliceIssue): string {
  return issue.repoPath.split('/').pop() || issue.repoPath
}
