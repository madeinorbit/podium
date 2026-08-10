/**
 * POD-330/POD-1496 — worklist row ATTENTION: what a row is doing, what it is
 * waiting for, and the words and clock it wears while it waits.
 *
 * The invariant: a row in, a presentation value out (phase, count, line,
 * timing). No ordering, no fold placement, no row construction. This is where
 * the worklist → issues edge lands — `issuePendingDecision`,
 * `pendingDecisionLabel` and `issueFinishedAt` are read from the issues slice,
 * one way.
 */
import type { IssueWire, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import {
  agentBadge,
  isSessionWorking,
  isUnstartedSession,
  motionPhase,
  type MotionPhase,
  type MotionTiming,
} from '../../session-status'
import { mostUrgentSession } from '../../session-urgency'
import {
  issueFinishedAt,
  issuePendingDecision,
  pendingDecisionLabel,
  type IssueNavigationModel,
  type IssuePendingDecision,
} from '../issues'
import { rowSessions, type UnifiedIssueRow, type UnifiedWorkRow } from './row-types'

/**
 * Aggregate motion phase for one unified WORK row (#41): the row wears the most
 * human-relevant of its member sessions' phases. `waiting` dominates (stillness
 * is the signal — a row that needs you must read amber even while other agents
 * grind on), then `working`, then `done` when every member finished; a row
 * whose sessions are merely idle/ready reads motion `queued` (dimmed stillness
 * — status copy surfaces this as "idle", not "queued").
 */
export function rowMotionPhase(row: UnifiedWorkRow): MotionPhase {
  if (row.kind === 'issue' && pendingDecisionStats(row).count > 0) return 'waiting'
  const sessions = rowSessions(row)
  if (
    sessions.length === 0 &&
    row.kind === 'issue' &&
    (row.issue.stage === 'done' || row.issue.closedReason != null)
  ) {
    return 'done'
  }
  return aggregateMotionPhase(sessions, row.kind === 'issue' ? row.issue : undefined)
}

/** The same waiting > working > all-done > queued aggregation over any member
 *  session set — for squares fed by `issue.sessions` directly (#65 right rail). */
export function aggregateMotionPhase(
  sessions: SessionMeta[],
  issue?: IssueNavigationModel,
): MotionPhase {
  const phases = sessions.map((s) => motionPhase(s, issue))
  if (phases.includes('waiting')) return 'waiting'
  if (phases.includes('working')) return 'working'
  if (phases.length > 0 && phases.every((p) => p === 'done')) return 'done'
  return 'queued'
}

/**
 * Is an agent on this row computing RIGHT NOW?
 *
 * Separate from {@link rowMotionPhase} on purpose. The phase is one value and
 * `waiting` outranks `working` in it — correctly: an unanswered ask must not be
 * hidden by a sibling agent grinding on. But since the worklist flattened to one
 * row per mission (POD-516 §1.1) that row is the ONLY place a running agent can
 * appear, so letting the ask swallow the phase left a mission with a live agent
 * reading as pure stillness — no spinner, no sweeping meter, nothing (POD-703).
 *
 * This is the predicate DESIGN.md §Motion licenses perpetual motion on: "an
 * agent is computing right now", read over the row's whole bubbled session set.
 * Surfaces gate their working texture on THIS, and the amber ask keeps the
 * phase — so a row can honestly say both things at once.
 */
export function rowHasWorkingSession(row: UnifiedWorkRow): boolean {
  return rowSessions(row).some(isSessionWorking)
}

/** How many member sessions are waiting on the human — drives the amber count
 *  pill on wide rows and the numbered corner badge on rail squares (#41).
 *  Issue rows count their `aggregateSessions` (via {@link rowSessions}), so the
 *  pill sums needs-you across the WHOLE branch — visible children and rolled-up
 *  depth alike. Nothing yellow ⇒ nothing needs you (POD-100 L3). */
export function rowWaitingCount(row: UnifiedWorkRow): number {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const sessions = rowSessions(row).filter((s) => motionPhase(s, issue) === 'waiting').length
  return sessions + (row.kind === 'issue' ? pendingDecisionStats(row).count : 0)
}

/**
 * The decision this ROW is waiting on, if any (POD-279). Issue-level classification
 * plus the one piece of context the issue itself can't see: a review-stage issue
 * whose own agent is running again (sent back, follow-up turn) is not waiting on
 * the human — its decision returns when the turn settles. A finished issue keeps
 * its awaiting-merge reading regardless, since nothing is going to re-decide it.
 */
export function rowPendingDecision(row: UnifiedIssueRow): IssuePendingDecision | null {
  const decision = issuePendingDecision(row.issue)
  if (decision === null) return null
  const finished = row.issue.stage === 'done' || row.issue.closedReason != null
  if (!finished && row.sessions.some(isSessionWorking)) return null
  return decision
}

/** Count issues awaiting a human decision in a visible row's full formal subtree
 *  and find the oldest anchor for the static waiting-age stamp. Cycle-safe. */
function pendingDecisionStats(row: UnifiedIssueRow): { count: number; sinceMs?: number } {
  let count = 0
  let sinceMs: number | undefined
  const seen = new Set<string>()
  const stack: UnifiedIssueRow[] = [row]
  while (stack.length > 0) {
    const current = stack.pop() as UnifiedIssueRow
    if (seen.has(current.issue.id)) continue
    seen.add(current.issue.id)
    if (rowPendingDecision(current) !== null) {
      count += 1
      // Finished work anchors on closedAt; a review-stage issue has no closure
      // stamp, so its last update is when it came to rest asking.
      const at = issueFinishedAt(current.issue)
      if (at > 0 && (sinceMs === undefined || at < sinceMs)) sinceMs = at
    }
    for (const child of current.startedByChildren ?? []) stack.push(child)
  }
  return { count, ...(sinceMs !== undefined ? { sinceMs } : {}) }
}

/** The deepest descendant row whose OWN sessions include one waiting on the
 *  human — the source the parent's sub-line whispers when depth would otherwise
 *  hide a request ('deep: POD-224 needs you', POD-100 L3). Depth is relative to
 *  `row` (1 = direct child). Null when no descendant is waiting. */
export function deepAttentionSource(
  row: UnifiedIssueRow,
): { issue: IssueWire; depth: number; kind: 'session' | IssuePendingDecision } | null {
  let best: { issue: IssueWire; depth: number; kind: 'session' | IssuePendingDecision } | null =
    null
  const stack: Array<{ row: UnifiedIssueRow; depth: number }> = [{ row, depth: 0 }]
  while (stack.length > 0) {
    const { row: r, depth } = stack.shift() as { row: UnifiedIssueRow; depth: number }
    const kind =
      rowPendingDecision(r) ??
      (r.sessions.some((s) => motionPhase(s, r.issue) === 'waiting') ? 'session' : null)
    if (depth > 0 && kind !== null) {
      // Breadth-first + `>=` keeps the LAST deepest hit, so ties resolve to the
      // later sibling deterministically; any deepest source serves the whisper.
      if (best === null || depth >= best.depth) best = { issue: r.issue, depth, kind }
    }
    for (const child of r.startedByChildren ?? []) stack.push({ row: child, depth: depth + 1 })
  }
  return best
}

/** Is any session waiting within `depth` levels of `row` (0 = own sessions
 *  only)? Distinguishes a visible yellow (the child row explains itself) from
 *  one hidden behind the roll-up (the parent must whisper the source). */
function waitingWithinDepth(row: UnifiedIssueRow, depth: number): boolean {
  if (row.sessions.some((s) => motionPhase(s, row.issue) === 'waiting')) return true
  if (rowPendingDecision(row) !== null) return true
  if (depth <= 0) return false
  return (row.startedByChildren ?? []).some((child) => waitingWithinDepth(child, depth - 1))
}

/**
 * The row's second line (#41): a compact status phrase in the handoff's copy
 * grammar. Waiting rows surface WHAT is being waited for (the most urgent
 * session's badge label — "needs answer", "plan ready"); working/done rows
 * read as their phase; multi-agent rows carry the head-count. Quiet rows
 * (motion bucket `queued` — dimmed stillness, nothing working or needing you)
 * read **idle**, never "queued": "queued" sounds like pending work and
 * confused temporary pinned desks that were simply done for now.
 */
export function rowStatusLine(
  row: UnifiedWorkRow,
  now: number = Date.now(),
  /** How many descendant levels render beneath this row (POD-100 L4 cap):
   *  1 for a top-level row (children visible), 0 for a depth-capped child. */
  visibleDepth: number = 1,
): string {
  const sessions = rowSessions(row)
  const phase = rowMotionPhase(row)
  // A draft vessel whose sessions were never prompted isn't idle work —
  // nothing was asked yet. Say so instead of the phase word.
  if (
    row.kind === 'issue' &&
    row.issue.draft &&
    phase === 'queued' &&
    sessions.length > 0 &&
    sessions.every(isUnstartedSession)
  ) {
    return 'awaiting first prompt'
  }
  let head = sessions.length > 1 ? `${sessions.length} agents · ` : ''
  // Child progress speaks of subtasks, not a bare "N/M done" — appended to the
  // phase word that used to read "done · 0/1 done" (POD-85).
  const children = row.kind === 'issue' && row.issue.childCount > 0 ? row.issue : null
  const progress = children ? ` · ${children.childDoneCount}/${children.childCount} subtasks` : ''
  if (phase === 'waiting') {
    // A waiting row can still have an agent computing on it, and since the row
    // is the mission's only line in this column, silence about that is a lie
    // (POD-703). The ask keeps the row's phase and its amber; the work says so
    // in the words, in the same `working · ` grammar the deep-attention whisper
    // below has always used.
    //
    // AND IT SPENDS THE HEAD-COUNT TO DO IT. Line 2 is ~22 mono characters wide
    // in the sidebar, so "2 agents · working · waiting on decision" ellipsized
    // away the very ask it was supposed to keep. The head-count is the cheapest
    // of the three: the fleet stack on line 1 already shows the tiles AND the
    // number, and it is the only one of the three that is stated twice.
    const working = rowHasWorkingSession(row)
    const own = working ? 'working · ' : ''
    if (working) head = ''
    if (row.kind === 'issue') {
      const decision = rowPendingDecision(row)
      if (decision !== null) {
        return `${head}${own}${pendingDecisionLabel(row.issue, decision)}${progress}`
      }
    }
    // Branch attention whisper (POD-100 L3): the yellow comes from a descendant
    // hidden behind the depth cap — no visible row explains the pill, so the
    // sub-line names the deepest source instead of a bare "needs you".
    if (row.kind === 'issue') {
      const deep = deepAttentionSource(row)
      if (deep && deep.depth > visibleDepth && !waitingWithinDepth(row, visibleDepth)) {
        const request =
          deep.kind === 'session' ? 'needs you' : pendingDecisionLabel(deep.issue, deep.kind)
        return `${head}${own}deep: ${issueDisplayRef(deep.issue)} ${request}${progress}`
      }
    }
    const issue = row.kind === 'issue' ? row.issue : undefined
    const urgent = mostUrgentSession(
      sessions.filter((s) => motionPhase(s, issue) === 'waiting'),
      now,
    )
    const label = urgent ? (agentBadge(urgent, issue)?.label ?? 'needs you') : 'needs you'
    return head + own + label + progress
  }
  if (phase === 'working') return head + 'working' + progress
  if (phase === 'done') {
    // A parent whose own sessions are done but whose subtasks aren't is not
    // "done" — the open subtasks ARE its status.
    if (children && children.childDoneCount < children.childCount) {
      return head + `${children.childDoneCount}/${children.childCount} subtasks done`
    }
    return head + 'done'
  }
  // Motion still uses the `queued` bucket for dim stillness; the human-facing
  // word is idle — quiet, not waiting in line.
  return head + 'idle' + progress
}

/**
 * Timer inputs for a row's line-2 meta (#41): the member session whose clock
 * the row shows. Working rows count from the EARLIEST working start (same rule
 * as the old WORKING timer); waiting rows freeze at the longest wait; done rows
 * sum every member's cumulative compute for the `∑` stamp.
 */
export function rowMotionTiming(row: UnifiedWorkRow): MotionTiming {
  const sessions = rowSessions(row)
  const phase = rowMotionPhase(row)
  const since = (s: SessionMeta): number => Date.parse(s.agentState?.since ?? s.lastActiveAt)
  const earliest = (list: SessionMeta[]): SessionMeta | undefined =>
    list.reduce<SessionMeta | undefined>(
      (best, s) => (best === undefined || since(s) < since(best) ? s : best),
      undefined,
    )
  if (phase === 'working') {
    const anchor = earliest(sessions.filter(isSessionWorking))
    if (anchor) {
      const base = anchor.agentState?.workingMsTotal
      return { phase, sinceMs: since(anchor), ...(base !== undefined ? { baseMs: base } : {}) }
    }
  }
  if (phase === 'waiting') {
    const issue = row.kind === 'issue' ? row.issue : undefined
    const anchor = earliest(sessions.filter((s) => motionPhase(s, issue) === 'waiting'))
    if (anchor) {
      return { phase, sinceMs: Date.parse(anchor.offer?.createdAt ?? '') || since(anchor) }
    }
    if (row.kind === 'issue') {
      const pending = pendingDecisionStats(row)
      if (pending.sinceMs !== undefined) return { phase, sinceMs: pending.sinceMs }
    }
  }
  if (phase === 'done') {
    const totals = sessions
      .map((s) => s.agentState?.workingMsTotal)
      .filter((t): t is number => t !== undefined)
    const sinceMs = sessions.reduce((max, s) => Math.max(max, since(s) || 0), 0)
    if (totals.length > 0) {
      return { phase, sinceMs, totalMs: totals.reduce((a, b) => a + b, 0) }
    }
    return { phase, sinceMs }
  }
  return { phase, sinceMs: row.activityAt }
}
