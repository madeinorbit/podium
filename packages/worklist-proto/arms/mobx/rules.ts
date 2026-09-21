/**
 * POD-4447 — pure slice predicates for the MobX arm. Every rule is a plain
 * function over borrowed rows (never a computed, never stateful), cited to
 * the frozen spec (`docs/plans/pod-4441-round-two-slice.md`). Models call
 * these from computed getters; MobX owns the invalidation, this module owns
 * the truth. No imports from legacy view-model / slice / mission /
 * presentation / replica-view code.
 */

import type { SliceIssue, SlicePhase, SliceSession } from '../../shared/src/slice-types'

export const DAY_MS = 24 * 60 * 60 * 1000
/** Finished rows stay open through this grace before folding (spec §3 R-GROUP). */
export const SIDEBAR_FINISHED_GRACE_MS = DAY_MS
/** Unread-or-never-read finished rows keep a 7-day window (spec §3 R-VIS). */
export const SIDEBAR_FINISHED_UNREAD_WINDOW_MS = 7 * DAY_MS
export const DRAFT_ISSUE_TITLE = 'Draft'
export const DEFER_NEXT_MESSAGE = 'next-message'

const UNSTARTED = new Set(['proposed', 'backlog'])

const PANEL_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi',
  shell: 'Shell',
}

/** ISO string to epoch ms; null on missing/unparseable (spec: absent reads as absent). */
export function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function trimLower(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return key.length > 0 ? key : null
}

// ---------------------------------------------------------- session attention

type AgentState = NonNullable<SliceSession['agentState']>

function idleKindOf(session: SliceSession): string | null {
  const kind = (session.agentState as (AgentState & { idle?: { kind?: unknown } }) | undefined)?.idle
    ?.kind
  return typeof kind === 'string' ? kind : null
}

function idleNeedsHuman(kind: string | null): boolean {
  return kind === 'question' || kind === 'approval' || kind === 'interrupted'
}

function idleFinishedTurn(kind: string | null): boolean {
  return kind === 'done' || kind === 'open_todos'
}

function phaseOf(session: SliceSession): string | null {
  const phase = session.agentState?.phase
  return typeof phase === 'string' ? phase : null
}

/** Which sessions ask the operator for something (spec §3 R-SUM). */
export function attentionGroup(session: SliceSession): 'needsYou' | 'working' | 'idle' {
  if (session.offer !== undefined && session.offer !== null) return 'needsYou'
  const phase = phaseOf(session)
  if (phase === 'needs_user' || phase === 'errored') return 'needsYou'
  if (phase === 'idle') return idleNeedsHuman(idleKindOf(session)) ? 'needsYou' : 'idle'
  if (phase === 'working' || phase === 'compacting') {
    return session.status === 'exited' || session.status === 'hibernated' ? 'idle' : 'working'
  }
  if (session.agentKind === 'shell') {
    return readBusy(session) ? 'working' : 'idle'
  }
  return session.status === 'live' || session.status === 'starting' || session.status === 'reconnecting'
    ? 'working'
    : 'idle'
}

function readBusy(session: SliceSession): boolean {
  return (session as unknown as { busy?: unknown }).busy === true
}

/** Badge tone of one session; always computed unfinished (spec §3 R-SUM). */
export function badgeTone(session: SliceSession, issueFinished: boolean): string | null {
  if (session.offer !== undefined && session.offer !== null && !issueFinished) return 'attention'
  if (session.agentState === undefined || session.agentState === null) return null
  const phase = phaseOf(session)
  if (phase === 'unknown') {
    const gap = (session.agentState as { observationGap?: unknown }).observationGap
    return gap === true ? 'muted' : null
  }
  switch (phase) {
    case 'working':
    case 'compacting':
      return 'working'
    case 'idle':
      return idleKindOf(session) === 'question' || idleKindOf(session) === 'approval'
        ? 'attention'
        : 'idle'
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

/** Whether an agent on this session is computing right now (spec §3 R-SUM). */
export function isSessionWorking(session: SliceSession): boolean {
  if (session.status === 'exited') return false
  if (session.status === 'starting' || session.status === 'reconnecting') return false
  const badge = badgeTone(session, false)
  if (badge !== null) return badge === 'working' ? session.status !== 'hibernated' : false
  return session.agentKind === 'shell' ? readBusy(session) : false
}

function hasNonOfferNeedsYou(session: SliceSession): boolean {
  if (session.offer === undefined || session.offer === null) {
    return attentionGroup(session) === 'needsYou'
  }
  const { offer: _dropped, ...rest } = session
  return attentionGroup(rest as SliceSession) === 'needsYou'
}

/** One session's motion phase; waiting dominates working (spec §3 R-SUM). */
export function motionPhase(session: SliceSession, issue?: SliceIssue): SlicePhase {
  if (attentionGroup(session) === 'needsYou') {
    const finished =
      issue !== undefined && (issue.stage === 'done' || issue.closedReason !== null)
    const offerOnly =
      finished === true &&
      session.offer !== undefined &&
      session.offer !== null &&
      !hasNonOfferNeedsYou(session)
    if (!offerOnly) return 'waiting'
  }
  const phase = phaseOf(session)
  if (phase === 'ended' || (phase === 'idle' && idleFinishedTurn(idleKindOf(session)))) return 'done'
  if (isSessionWorking(session)) return 'working'
  return 'queued'
}

/** Offer-attention with no other ask: deduped against pending decisions (spec §3 R-SUM). */
export function isOfferOnlyAttention(session: SliceSession): boolean {
  return (
    session.offer !== undefined && session.offer !== null && !hasNonOfferNeedsYou(session)
  )
}

/** Sessions still assigned whatever they are doing (spec §3 R-SUM). */
export function openSession(session: SliceSession): boolean {
  return !session.archived && session.status !== 'exited'
}

// ------------------------------------------------------------- session decay

/**
 * The finish instant of one session, without the clock: `undefined` means
 * unfinished (retains unconditionally). Models use this to decide whether
 * the coarse clock must be read at all — `sessionRetains` below is exact for
 * `finishedAt == null → true`, so skipping the clock read there subscribes
 * nothing and ticks invalidate nothing (spec §3 R-VIS).
 */
export function sessionFinishedAt(
  session: SliceSession,
  issue?: SliceIssue,
): string | undefined {
  const phase = phaseOf(session)
  const idleDone = phase === 'idle' && idleFinishedTurn(idleKindOf(session))
  const issueFinished =
    issue !== undefined && (issue.stage === 'done' || issue.closedReason !== null)
  return (
    session.stoppedAt ??
    (phase === 'ended'
      ? session.agentState?.since
      : idleDone && issueFinished
        ? (issue?.closedAt ?? issue?.updatedAt ?? session.agentState?.since)
        : undefined)
  )
}

/**
 * Whether a session keeps its row on screen: unfinished retains; finished
 * runs decay after 24h, unread after 7d (spec §3 R-VIS).
 */
export function sessionRetains(
  session: SliceSession,
  now: number,
  issue?: SliceIssue,
): boolean {
  if (session.archived) return false
  const finishedAt = sessionFinishedAt(session, issue)
  if (finishedAt === null || finishedAt === undefined) return true
  const ms = parseMs(finishedAt) ?? 0
  if (session.unread === true || session.readAt === null || session.readAt === undefined) {
    return now - ms <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  return now - Math.max(ms, parseMs(session.readAt) ?? 0) <= SIDEBAR_FINISHED_GRACE_MS
}

/** Live sessions: not exited and retained (spec §3 R-VIS). */
export function sessionLive(session: SliceSession, now: number, issue?: SliceIssue): boolean {
  return session.status !== 'exited' && sessionRetains(session, now, issue)
}

// ------------------------------------------------------------- issue standing

/** Finished issues: done stage or any close reason (spec §3 R-ROLL). */
export function issueFinished(issue: SliceIssue): boolean {
  return issue.stage === 'done' || issue.closedReason !== null
}

/** Finish anchor for decay and fold windows (spec §3 R-ROLL). */
export function issueFinishedAt(issue: SliceIssue): number {
  return parseMs(issue.closedAt ?? issue.updatedAt) ?? 0
}

/** Closed top-level human issues: decay-exempt, fold candidates (spec §3 R-GROUP). */
export function isClosedTopLevel(issue: SliceIssue): boolean {
  return (
    issue.closedReason !== null &&
    (issue.parentId ?? null) === null &&
    issue.audience === 'human'
  )
}

const LEGACY_CLOSE_REASONS: Record<string, string> = {
  wontfix: 'cancelled',
  wont_fix: 'cancelled',
  "won't fix": 'cancelled',
  'not planned': 'cancelled',
  canceled: 'cancelled',
  dupe: 'duplicate',
}

function canonicalCloseReason(value: unknown): string | null {
  const key = trimLower(value)
  if (key === null) return null
  if (Object.hasOwn(LEGACY_CLOSE_REASONS, key)) return LEGACY_CLOSE_REASONS[key] as string
  return key === 'done' || key === 'cancelled' || key === 'duplicate' || key === 'superseded'
    ? key
    : null
}

/** completed | cancelled | open — abandoned folds immediately (spec §3 R-GROUP). */
export function closeOutcome(issue: SliceIssue): 'completed' | 'cancelled' | 'open' {
  const reason = canonicalCloseReason(issue.closedReason)
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  if (status === 'cancelled' || status === 'duplicate' || status === 'superseded') {
    return 'cancelled'
  }
  return status === 'done' ? 'completed' : 'open'
}

/** Abandoned issues fold immediately (spec §3 R-GROUP). */
export function issueAbandoned(issue: SliceIssue): boolean {
  return closeOutcome(issue) === 'cancelled'
}

/**
 * Merge delivery never fires in the worklist: it reads branch/gitState the
 * navigation model never carries. Unconditional `false`; legacy wins over
 * shorthand (spec §3 R-GROUP).
 */
export function issueAwaitingMerge(_issue: SliceIssue): boolean {
  return false
}

/** Pending decisions: only `review` ever fires here (spec §3 R-ROLL). */
export function issuePendingDecision(issue: SliceIssue): 'review' | null {
  if (!issueFinished(issue) && issue.stage !== 'review') return null
  if (issue.blocked === true) return null
  if (issueAbandoned(issue)) return null
  return issue.stage === 'review' ? 'review' : null
}

/**
 * Finished-row sidebar visibility: unfinished, closed-top-level and
 * awaiting-merge stay; the rest decay (spec §3 R-VIS). `unread` is the
 * replica rollup, never the wire field.
 */
export function issueVisibleInSidebar(
  issue: SliceIssue,
  now: number,
  unread: boolean,
): boolean {
  if (!issueFinished(issue)) return true
  if (isClosedTopLevel(issue)) return true
  if (issueAwaitingMerge(issue)) return true
  const finishedAt = issueFinishedAt(issue)
  if (unread || issue.readAt === null || issue.readAt === undefined) {
    return now - finishedAt <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  return now - Math.max(finishedAt, parseMs(issue.readAt) ?? 0) <= SIDEBAR_FINISHED_GRACE_MS
}

/**
 * Replica unread rollup, replayed exactly: no/invalid readAt, updated past
 * the cursor, or member activity past it. Members are explicit non-shell
 * seats, archived included; deleted reads as read (spec §3 R-VIS).
 */
export function derivedUnread(issue: SliceIssue, members: SliceSession[]): boolean {
  if (issue.deletedAt !== null && issue.deletedAt !== undefined) return false
  const rawReadAt = typeof issue.readAt === 'string' ? Date.parse(issue.readAt) : NaN
  let unread = issue.readAt === null || issue.readAt === undefined || !Number.isFinite(rawReadAt)
  if (!unread && Number.isFinite(rawReadAt)) {
    const updatedAt = Date.parse(issue.updatedAt)
    unread = Number.isFinite(updatedAt) && updatedAt > rawReadAt
  }
  for (const member of members) {
    if (member.agentKind === 'shell') continue
    if (!unread && member.lastActiveAt) {
      const activeAt = Date.parse(member.lastActiveAt)
      if (Number.isFinite(activeAt) && (Number.isNaN(rawReadAt) || activeAt > rawReadAt)) {
        unread = true
      }
    }
  }
  return unread
}

// ------------------------------------------------------------------ defer

function deferMs(issue: SliceIssue): number | null {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return null
  return parseMs(issue.deferUntil)
}

/** Snoozed rows sink to band 2 (spec §3 R-ORDER). */
export function isDeferred(issue: SliceIssue, now: number): boolean {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return true
  const until = deferMs(issue)
  return until !== null && until > now
}

/** Returned-from-defer rows float to band 0; the sentinel never returns (spec §3 R-ORDER). */
export function returnedFromDefer(issue: SliceIssue, now: number): boolean {
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return false
  const until = deferMs(issue)
  return until !== null && until <= now
}

/** Order band: 0 pinned/returned, 1 middle, 2 snoozed (spec §3 R-ORDER). */
export function bandOf(issue: SliceIssue, now: number): 0 | 1 | 2 {
  if (issue.pinned === true || returnedFromDefer(issue, now)) return 0
  if (isDeferred(issue, now)) return 2
  return 1
}

// ----------------------------------------------------------------- display

/** `prefix-seq` else `#seq` (spec §3 R-SUM). */
export function displayRefOf(issue: SliceIssue, prefix: string | null): string {
  return prefix ? `${prefix}-${issue.seq}` : `#${issue.seq}`
}

/** Draft-titled issues wear their first member session's name (spec §3 R-SUM). */
export function displayTitleOf(issue: SliceIssue, firstMember?: SliceSession): string {
  if (issue.draft === true && (issue.title.trim() === '' || issue.title.trim() === DRAFT_ISSUE_TITLE)) {
    if (!firstMember) return 'New agent'
    const name = (
      (firstMember as unknown as { name?: unknown }).name as string | undefined
    )?.trim?.()
    if (name) return name
    const kind = firstMember.agentKind ?? 'undefined'
    return `New ${PANEL_LABELS[kind] ?? kind} session`
  }
  return issue.title
}

/** The single `discovered-from` edge names the spin-off origin (spec §3 R-ORIGIN). */
export function spinOffOriginId(issue: SliceIssue): string | null {
  return issue.deps?.find((edge) => edge.type === 'discovered-from')?.id ?? null
}

/** Spin-offs that left the mission: underway stages with an origin (spec §3 R-ROLL). */
export function hasLeftMission(stage: string, origin: string | null): boolean {
  return !UNSTARTED.has(stage) && origin !== null
}

/**
 * Preferred continuation tip: staffed (open explicit session) preferred,
 * else unfinished, else all; latest explicit activity first (spec §3 R-ROLL).
 */
export function preferredTip<T extends { id: string }>(
  candidates: T[],
  hasOpen: (id: string) => boolean,
  lastActiveOf: (id: string) => string,
): T | null {
  if (candidates.length === 0) return null
  const staffed = candidates.filter((candidate) => hasOpen(candidate.id))
  const pool =
    staffed.length > 0
      ? staffed
      : candidates.filter((candidate) => {
          const row = (candidate as unknown as { closedReason?: unknown; stage?: unknown }).closedReason
          const stage = (candidate as unknown as { stage?: unknown }).stage
          return !row && stage !== 'done'
        })
  const pick = (pool.length > 0 ? pool : candidates).slice()
  pick.sort((a, b) => {
    const la = lastActiveOf(a.id)
    const lb = lastActiveOf(b.id)
    return lb > la ? 1 : lb < la ? -1 : 0
  })
  return pick[0] ?? null
}

// ------------------------------------------------------------ flat visibility

function isSystemStage(stage: string): boolean {
  return stage === 'shipping'
}

/** Rows the slice can never show (spec §3 R-VIS). */
export function structurallyExcluded(issue: SliceIssue): boolean {
  return (
    issue.archived === true ||
    (issue.deletedAt !== null && issue.deletedAt !== undefined) ||
    issue.stage === 'proposed' ||
    isSystemStage(issue.stage)
  )
}

/**
 * Sessionless keep without the clock: `'keep'` / `'drop'` decide without
 * `coarseNow`; `'decay'` needs it (`issueVisibleInSidebar`). Models read the
 * clock only on `'decay'` so ticks invalidate only decay-gated rows
 * (spec §3 R-VIS).
 */
export function sessionlessGate(issue: SliceIssue): 'keep' | 'drop' | 'decay' {
  const activeHuman =
    issue.audience === 'human' &&
    (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
  if (activeHuman) return 'keep'
  if (!issueFinished(issue)) return 'drop'
  if (
    !issueAwaitingMerge(issue) &&
    !isClosedTopLevel(issue) &&
    ((issue.parentId ?? null) === null || issue.audience === 'agent')
  ) {
    return 'drop'
  }
  return 'decay'
}

/**
 * Sessionless keep: active humans carry their own lifecycle; finished rows
 * stay only awaiting-merge or closed-top-level, subject to decay (spec §3 R-VIS).
 */
export function sessionlessKept(issue: SliceIssue, now: number, unread: boolean): boolean {
  const gate = sessionlessGate(issue)
  if (gate === 'keep') return true
  if (gate === 'drop') return false
  return issueVisibleInSidebar(issue, now, unread)
}

/**
 * `sessionlessKept` with a lazy clock: `getNow` runs only on the decay
 * branch, so non-decay rows never subscribe to `coarseNow` and ticks never
 * invalidate them. Same truth, narrower subscriptions.
 */
export function flatSessionless(
  issue: SliceIssue,
  unread: boolean,
  getNow: () => number,
): boolean {
  const gate = sessionlessGate(issue)
  if (gate === 'keep') return true
  if (gate === 'drop') return false
  return issueVisibleInSidebar(issue, getNow(), unread)
}

/** Rescue eligibility: live human unfinished rows only (spec §3 R-VIS). */
export function rescueEligible(issue: SliceIssue): boolean {
  if (
    issue.archived === true ||
    (issue.deletedAt !== null && issue.deletedAt !== undefined) ||
    issue.stage === 'proposed' ||
    isSystemStage(issue.stage)
  ) {
    return false
  }
  return issue.audience === 'human' && !issueFinished(issue)
}

// -------------------------------------------------------------------- order

export interface RankInput {
  band: 0 | 1 | 2
  sortKey: string | null
  createdAt: string
  seq: number
  id: string
}

/** Banded order; activity never sorts (spec §3 R-ORDER). */
export function compareRank(a: RankInput, b: RankInput): number {
  if (a.band !== b.band) return a.band - b.band
  const ka = a.sortKey || null
  const kb = b.sortKey || null
  if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -1 : 1
  if (ka !== null && kb === null) return -1
  if (ka === null && kb !== null) return 1
  const dt = (parseMs(b.createdAt) ?? 0) - (parseMs(a.createdAt) ?? 0)
  if (dt !== 0) return dt
  if (a.seq !== b.seq) return b.seq - a.seq
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// -------------------------------------------------------------------- groups

/** Group key merges same-repo paths: `repoId ?? repoPath` (spec §3 R-GROUP). */
export function groupKeyOf(issue: SliceIssue): string {
  return issue.repoId ?? issue.repoPath
}

/** Group label is the repo path tail (spec §3 R-GROUP). */
export function groupLabelOf(issue: SliceIssue): string {
  return issue.repoPath.split('/').pop() || issue.repoPath
}

/** Settled closures: closed top-level, nothing asked (spec §3 R-GROUP). */
export function settledForFold(issue: SliceIssue, waiting: boolean): boolean {
  return (
    isClosedTopLevel(issue) &&
    issue.needsHuman !== true &&
    !issueAwaitingMerge(issue) &&
    !waiting
  )
}

/** Closed-fold sort key: newest tucked (or finished) first (spec §3 R-GROUP). */
export function closedFoldAt(issue: SliceIssue): number {
  return parseMs(issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt) ?? 0
}

export interface FoldInput {
  issue: SliceIssue
  waiting: boolean
  selectedIssueId: string | null
  selectedIssueWasFolded: boolean
  now: number
}

/**
 * One closed fold per group: abandoned folds immediately, tucked folds even
 * while selected, the rest fold past the 24h grace — except the selected open
 * row, which the latch holds open until focus moves (spec §3 R-GROUP).
 */
export function inClosedFold(input: FoldInput): boolean {
  const { issue, waiting, selectedIssueId, selectedIssueWasFolded, now } = input
  if (!settledForFold(issue, waiting)) return false
  if (issueAbandoned(issue)) return true
  if (issue.tuckedAt !== null && issue.tuckedAt !== undefined) return true
  if (issue.id !== selectedIssueId || selectedIssueWasFolded) {
    return now - issueFinishedAt(issue) > SIDEBAR_FINISHED_GRACE_MS
  }
  return false
}
