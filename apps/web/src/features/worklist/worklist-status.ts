/**
 * THE COLUMN'S STATUS LINE (POD-516 round 2, left sidebar item 1).
 *
 * The artifact carries a `progress()` over its mission and draws it as a
 * segmented bar in the Flight Deck's head. The operator asked for that same
 * instrument at the top of column 1 — "how many issues are done, waiting,
 * progressing" — which is the SAME picture at a different scope: not one
 * mission, but every mission the worklist is showing.
 *
 * ---------------------------------------------------------------------------
 * SCOPE: THE COLUMN, NOT THE PORTFOLIO
 * ---------------------------------------------------------------------------
 *
 * Round 1 shipped "a badge that disagreed with the column it summarised", so
 * the scope here is defined by the rendered rows and nothing else: the pinned
 * lane plus each project group's OPEN rows. Snoozed and closed rows are
 * deliberately out — they are tucked away precisely because the operator has
 * finished with them, and folding a long archive of settled work into `done`
 * would make the meter a history of the past rather than a picture of the
 * present.
 *
 * Each of those rows is a mission ROOT (§1.1: one flat row per mission), so the
 * column's work is the union of their missions — the subtasks under a root are
 * real work even though the flat column gives them no row of their own.
 *
 * ---------------------------------------------------------------------------
 * ONE PREDICATE, REUSED
 * ---------------------------------------------------------------------------
 *
 * The done / run / block / wait classification is `missionProgress`'s and is not
 * restated here; this module only sums it per root and stops the same issue
 * being counted twice. Double counting is a real hazard rather than a
 * hypothetical: `missionIssueIds` follows `startedBySession` provenance, so an
 * agent-started issue that ALSO has its own top-level row in the worklist
 * belongs to two roots' missions. Walking the roots with a set of already-
 * counted ids means the first root that claims it wins, and the meter can never
 * exceed 100%.
 */
import {
  type IssueNavigationModel,
  motionPhase,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { missionIssueIds, missionProgress } from '@/lib/mission'

export interface WorklistStatus {
  /** Tasks across every mission the column is showing. */
  total: number
  done: number
  run: number
  block: number
  wait: number
  /**
   * Whether at least one agent on this work is COMPUTING right now.
   *
   * The braille spinner is the only perpetual motion in the product
   * (DESIGN.md §5) and may turn only while an agent actually computes — so the
   * status line asks this question separately rather than driving the animation
   * off `run`. A task can sit in `in_progress` for an hour with nothing
   * running, and a spinner over that is the one lie this grammar must not tell.
   */
  working: boolean
}

const EMPTY: WorklistStatus = { total: 0, done: 0, run: 0, block: 0, wait: 0, working: false }

const openSession = (session: SessionMeta): boolean =>
  !session.archived && session.status !== 'exited'

export function worklistStatus(
  rows: readonly UnifiedWorkRow[],
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
): WorklistStatus {
  const counted = new Set<string>()
  let total = 0
  let done = 0
  let run = 0
  let block = 0
  let wait = 0
  for (const row of rows) {
    // A worktree row is a checkout with sessions on it, not a task — it
    // contributes no issue to count and no mission to walk.
    if (row.kind !== 'issue') continue
    if (counted.has(row.issue.id)) continue
    const progress = missionProgress(issues, sessions, row.issue.id)
    for (const id of missionIssueIds(issues, row.issue.id, sessions)) counted.add(id)
    total += progress.total
    done += progress.done
    run += progress.run
    block += progress.block
    wait += progress.wait
  }
  if (total === 0) return EMPTY

  // Membership is read the way `missionSessions` reads it — the owning issue OR
  // an explicit member listing — so a session attached to a mission by
  // membership alone still counts as life in this column.
  const memberSessionIds = new Set<string>()
  for (const issue of issues) {
    if (!counted.has(issue.id)) continue
    for (const sessionId of issue.memberSessionIds ?? []) memberSessionIds.add(sessionId)
  }
  const working = sessions.some(
    (session) =>
      openSession(session) &&
      motionPhase(session) === 'working' &&
      ((session.issueId !== undefined &&
        session.issueId !== null &&
        counted.has(session.issueId)) ||
        memberSessionIds.has(session.sessionId)),
  )
  return { total, done, run, block, wait, working }
}
