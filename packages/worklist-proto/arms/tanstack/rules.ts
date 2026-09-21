/**
 * POD-4448 — pure slice rules, transcribed from the frozen spec
 * (docs/plans/pod-4441-round-two-slice.md; citations inline). The TanStack
 * arm's query `fn` bodies and the rollup sync share these; nothing here
 * reads a collection, so every rule stays a pure function of its inputs.
 * No imports from legacy view-model / slice / mission / presentation code.
 * Conventions: `now` is always SliceLocals.coarseNow, never Date.now().
 */

import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'

export const DAY_MS = 24 * 60 * 60 * 1000
export const SIDEBAR_FINISHED_GRACE_MS = DAY_MS
export const SIDEBAR_FINISHED_UNREAD_WINDOW_MS = 7 * DAY_MS
export const DRAFT_ISSUE_TITLE = 'Draft'
export const DEFER_NEXT_MESSAGE = 'next-message'

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

/** sessionDotTone verdict (session-status.ts:361), reduced to working. */
export function isSessionWorking(s: SliceSession): boolean {
  if (s.status === 'exited') return false
  if (s.status === 'starting' || s.status === 'reconnecting') return false
  const badge = badgeTone(s, false)
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

/**
 * motionPhase (session-status.ts:455). Root-dependent only through
 * `finished`: precompute the root-independent verdict (needsYou, offerOnly,
 * endedDone, workingNow) in the query and apply the finished override here.
 */
export function motionPhaseFromParts(parts: {
  needsYou: boolean
  offerOnly: boolean
  endedDone: boolean
  workingNow: boolean
  finished: boolean
}): 'queued' | 'working' | 'waiting' | 'done' {
  if (parts.needsYou && !(parts.finished && parts.offerOnly)) return 'waiting'
  if (parts.endedDone) return 'done'
  if (parts.workingNow) return 'working'
  return 'queued'
}

/** motionPhase (session-status.ts:455): waiting dominates, then working. */
export function motionPhase(s: SliceSession, issue?: SliceIssue): 'queued' | 'working' | 'waiting' | 'done' {
  const finished = issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
  if (attentionGroup(s) === 'needsYou') {
    if (!(finished && s.offer !== undefined && !hasNonOfferNeedsYou(s))) return 'waiting'
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

/** sessionPresentOnTask (fleet.ts:36): still assigned, whatever it does. */
export function openSession(s: SliceSession): boolean {
  return !s.archived && s.status !== 'exited'
}

/** sessionRetainsWorklistRow (visibility.ts:44). */
export function sessionRetains(s: SliceSession, now: number, issue?: SliceIssue): boolean {
  if (s.archived) return false
  const finished = issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
  const phase = s.agentState?.phase
  const idleDone = phase === 'idle' && idleFinishedTurn(idleKindOf(s))
  const finishedAt =
    s.stoppedAt ??
    (phase === 'ended'
      ? s.agentState?.since
      : idleDone && finished
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

/** issueAbandoned (slices/issues.ts:338): cancelled/duplicate/superseded. */
export function issueAbandoned(issue: Pick<SliceIssue, 'stage' | 'closedReason'>): boolean {
  const reason = canonicalCloseReason(issue.closedReason)
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}

/** issueAwaitingMerge (slices/issues.ts:369): always false in the worklist —
 *  it reads branch/gitState, which the navigation model never carries. */
export function issueAwaitingMerge(_issue: SliceIssue): boolean {
  return false
}

export type PendingDecision = 'merge' | 'review' | null

/** issuePendingDecision (slices/issues.ts:391): without gitState only the
 *  review branch can fire. */
export function issuePendingDecision(issue: SliceIssue): PendingDecision {
  if (!issueFinished(issue) && issue.stage !== 'review') return null
  if (issue.blocked === true) return null
  if (issueAbandoned(issue)) return null
  return issue.stage === 'review' ? 'review' : null
}

/** issueVisibleInSidebar (visibility.ts:25). `unread` is the replica rollup,
 *  never the wire field. */
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
 * unread without a cursor, updated past it, or with member activity past it.
 * `maxActiveMs` is the max lastActiveAt over explicit non-shell members
 * (archived included); 0 when there are none.
 */
export function derivedUnreadFromMax(
  issue: SliceIssue,
  maxActiveMs: number,
): boolean {
  if (issue.deletedAt != null) return false
  const readAt = issue.readAt ? Date.parse(issue.readAt) : null
  let unread = readAt === null || !Number.isFinite(readAt)
  if (!unread && readAt !== null) {
    const updatedAt = Date.parse(issue.updatedAt)
    unread = Number.isFinite(updatedAt) && updatedAt > readAt
    if (!unread && maxActiveMs > 0) unread = maxActiveMs > readAt
  }
  return unread
}

/** System-owned stage (model issue-vocabulary.ts:59): shipping only. */
export function isSystemStage(stage: string): boolean {
  return stage === 'shipping'
}

/** isIssueDeferred (model issue-stage.ts:42). */
export function isDeferred(issue: Pick<SliceIssue, 'deferUntil'>, now: number): boolean {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return true
  const until = parseMs(issue.deferUntil)
  return until !== null && until > now
}

/** issueReturnedFromDefer (model issue-stage.ts:70). */
export function returnedFromDefer(issue: Pick<SliceIssue, 'deferUntil'>, now: number): boolean {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return false
  const until = parseMs(issue.deferUntil)
  return until !== null && until <= now
}

/** unifiedRowBand (row-order.ts:16): pinned/returned 0, snoozed 2, else 1. */
export function bandOf(issue: Pick<SliceIssue, 'pinned' | 'deferUntil'>, now: number): 0 | 1 | 2 {
  if (issue.pinned === true || returnedFromDefer(issue, now)) return 0
  if (isDeferred(issue, now)) return 2
  return 1
}

// ---------------------------------------------------------------- display

/** issueDisplayRef (replica/issue-views.ts:233). */
export function displayRefOf(issue: Pick<SliceIssue, 'seq'>, prefix: string | null): string {
  return prefix ? `${prefix}-${issue.seq}` : `#${issue.seq}`
}

/** issueDisplayTitle (slices/issues.ts:236): drafts wear the session's name. */
export function displayTitleOf(
  issue: Pick<SliceIssue, 'draft' | 'title'>,
  firstName: string | null,
  firstKind: string | null,
): string {
  if (issue.draft === true) {
    const title = (issue.title ?? '').trim()
    if (title === DRAFT_ISSUE_TITLE || title === '') {
      if (firstName === null) return 'New agent'
      const name = firstName.trim()
      const kind = firstKind ?? 'undefined'
      return name || `New ${PANEL_LABELS[kind] ?? kind} session`
    }
  }
  return issue.title
}

// ---------------------------------------------------------- spin-off graph

export function spinOffOriginId(issue: Pick<SliceIssue, 'deps'>): string | null {
  return plainDeps(issue).find((dep) => dep.type === 'discovered-from')?.id ?? null
}

/**
 * Collection rows arrive as reactive proxies: scalar and optional-object
 * reads behave, but array methods (find/map/…) do not exist on the proxy.
 * All dep-edge reads go through here, once per issue change — never on the
 * hot per-row path.
 */
export function plainDeps(issue: Pick<SliceIssue, 'deps'>): Array<{ id: string; type: string }> {
  const deps = issue.deps as unknown
  if (deps === undefined || deps === null) return []
  if (Array.isArray(deps)) return deps as Array<{ id: string; type: string }>
  const length = (deps as { length?: unknown }).length
  if (typeof length === 'number') {
    const out: Array<{ id: string; type: string }> = []
    for (let i = 0; i < length; i += 1) {
      const edge = (deps as Array<{ id: string; type: string }>)[i]
      if (edge !== undefined) out.push({ id: edge.id, type: edge.type })
    }
    return out
  }
  return []
}

export function hasLeftMission(stage: string, origin: string | null): boolean {
  return stage !== 'proposed' && stage !== 'backlog' && origin !== null
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

/** Sessionless keep rule, second clause (rows.ts:90-106). */
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

/** WORK-list order (row-order.ts:65): band, manual sortKey, creation desc. */
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

/**
 * sortKey encoding for orderBy (nulls sort first in the IVM; legacy wants
 * keyed-before-unkeyed, i.e. nulls last). '\uffff' is above any real key.
 */
export function encodeSortKey(sortKey: string | null | undefined): string {
  return sortKey ?? '\uffff'
}

// ------------------------------------------------------------ R-GROUP fold

/** finishedIssueSettled (folds.ts:93): closed top-level, nothing asked. */
export function settledForFold(args: { issue: SliceIssue; waiting: boolean }): boolean {
  return (
    isClosedTopLevel(args.issue) &&
    args.issue.needsHuman !== true &&
    !issueAwaitingMerge(args.issue) &&
    !args.waiting
  )
}

/** The timestamp Closed sorts by (folds.ts:82). */
export function closedFoldAt(issue: SliceIssue): number {
  return parseMs(issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt) ?? 0
}

/** rowInClosedFold (folds.ts:118): abandoned/tucked fold at once, otherwise
 *  the grace window, with the selection latch for the clicked row. */
export function inClosedFold(args: {
  issue: SliceIssue
  waiting: boolean
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
export function groupKeyOf(issue: Pick<SliceIssue, 'repoId' | 'repoPath'>): string {
  return issue.repoId ?? issue.repoPath
}

export function groupLabelOf(issue: Pick<SliceIssue, 'repoPath'>): string {
  return issue.repoPath.split('/').pop() || issue.repoPath
}

// ---------------------------------------------------------- member order

/**
 * Numeric session index parsed from `s123`-style ids; non-numeric ids sort
 * last (they arrive as late appends, matching bucket-append order).
 */
export function sessionOrd(sessionId: string): number {
  const match = /^s(\d+)$/.exec(sessionId)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

/**
 * First-member pick composite: zero-padded numeric order + agentKind + name,
 * so the group min() is the earliest member's naming inputs. `name` rides the
 * composite after two \x00 separators (names containing \x00 are pathological
 * and read back truncated — noted in NOTES.md).
 */
export function firstPickOf(sessionId: string, agentKind: string | null, name: string | null): string {
  const ord = sessionOrd(sessionId)
  const pad = Number.isFinite(ord) ? String(ord).padStart(10, '0') : '~~~~~~~~~~'
  return `${pad}\x00${agentKind ?? ''}\x00${name ?? ''}`
}

export function parseFirstPick(pick: string | null): { name: string | null; kind: string | null } {
  if (pick === null) return { name: null, kind: null }
  const parts = pick.split('\x00')
  return { name: parts[2] ?? null, kind: parts[1] ?? null }
}
