/**
 * POD-330/POD-1496 — worklist row CONSTRUCTION: which work earns a row, how
 * provenance nests it, and the WORKING move-out split.
 *
 * The invariant: replica state in, a row list out. Ordering lives in
 * `row-order.ts`, attention in `row-attention.ts`, fold placement in
 * `folds.ts`; this module reads the first and neither of the others.
 */
import { type IssueId, type IssueWire, type SessionMeta } from '@podium/model'
import { isSessionWorking } from '../../session-status'
import {
  issueIdOwningSession,
  sessionsForIssueNav,
  type SessionOwnershipIndex,
} from '../../session-ownership'
import { elevateCoordinatorSession, sortSessionsForSidebar } from '../../session-urgency'
import {
  isClosedTopLevelIssue,
  isDraftAgentVessel,
  issueAwaitingMerge,
  type IssueNavigationModel,
} from '../issues'
import type { SidebarSections } from './nav'
import { compareManualOrder, sortUnifiedWorkRows } from './row-order'
import {
  rowRank,
  rowSessions,
  UNIFIED_ROW_EMPTY_RANK,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
} from './row-types'
import { issueVisibleInSidebar, sessionVisibleInSidebar } from './visibility'

/**
 * Build the unified WORK LIST rows (unsorted). Contents:
 *   - non-archived human-origin issues (drafts included) that have ≥1 live
 *     (non-archived, non-shell) member session — a worktree or a non-backlog
 *     stage alone is NOT enough; the unified list is live work, not a tree;
 *   - nav worktrees owned by no issue that have ≥1 (non-shell) session.
 * Sessions attached to a live issue only render under that issue's row, so an
 * agent-created worktree whose issue never stamped worktreePath won't show twice.
 * After the flat pass, top-level agent-started issues nest under the starter
 * session's issue via {@link nestStartedByIssues} (M6 started-by tree).
 */
function buildUnifiedRows(
  sections: SidebarSections,
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number,
  ownership?: SessionOwnershipIndex,
): UnifiedWorkRow[] {
  const rows: UnifiedWorkRow[] = []
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || issue.stage === 'proposed') continue
    const mine = elevateCoordinatorSession(
      sortSessionsForSidebar(
        sessionsForIssueNav(issue, sessions, allWorktreePaths, {}, ownership).filter((s) =>
          sessionVisibleInSidebar(s, now, issue),
        ),
        now,
      ),
      issue.coordinatorSessionId,
    )
    // Once human work has started, retiring its last session must not erase the
    // issue from the sidebar. Backlog/proposed issues still need execution to
    // earn a live row; planning/in-progress/review issues carry their own work
    // lifecycle independently of any particular session. Finished milestone
    // children, awaiting-merge work, and explicitly closed top-level issues use
    // their existing completion visibility rules. [spec:SP-6144]
    if (mine.length === 0) {
      const finished = issue.stage === 'done' || issue.closedReason != null
      const activeHumanIssue =
        issue.audience === 'human' &&
        (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
      const awaitingMerge = issueAwaitingMerge(issue)
      const closedTopLevel = isClosedTopLevelIssue(issue)
      if (!activeHumanIssue) {
        if (
          !finished ||
          (!awaitingMerge && !closedTopLevel && (!issue.parentId || issue.audience === 'agent'))
        ) {
          continue
        }
        if (!issueVisibleInSidebar(issue, now)) continue
      }
    }
    const lastSession = mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
    rows.push({
      kind: 'issue',
      issue,
      sessions: mine,
      activityAt: lastSession || Date.parse(issue.updatedAt) || 0,
      rank: rowRank(mine, now),
    })
  }
  // Keep a tracked human parent visible when only its descendants are running;
  // its aggregate status is filled by the nesting pass. [spec:SP-6144]
  const presentIssueIds = new Set(
    rows.filter((row): row is UnifiedIssueRow => row.kind === 'issue').map((row) => row.issue.id),
  )
  // Walk each row's FULL ancestor chain (not just the direct parent) and
  // materialize every missing live human-audience ancestor, so a live session
  // deep under internal bookkeeping nodes always surfaces under its nearest
  // visible ancestor — and that ancestor renders under ITS tracked root rather
  // than posing as one. Finished (done/closed) ancestors are never resurrected
  // as rescue rows: a live descendant belongs under the nearest LIVE ancestor.
  const issueById = new Map(issues.map((issue) => [issue.id, issue]))
  for (const child of [...rows]) {
    if (child.kind !== 'issue') continue
    let parentId = child.issue.parentId
    const walked = new Set<string>([child.issue.id])
    while (parentId && !walked.has(parentId)) {
      walked.add(parentId)
      const parent = issueById.get(parentId)
      if (!parent || parent.archived || parent.deletedAt || parent.stage === 'proposed') break
      const parentFinished = parent.stage === 'done' || parent.closedReason != null
      if (!presentIssueIds.has(parent.id) && parent.audience === 'human' && !parentFinished) {
        rows.push({
          kind: 'issue',
          issue: parent,
          sessions: [],
          activityAt: Date.parse(parent.updatedAt) || 0,
          rank: UNIFIED_ROW_EMPTY_RANK,
        })
        presentIssueIds.add(parent.id)
      }
      parentId = parent.parentId
    }
  }
  // The work sidebar is issue-only. Unattached and orphaned sessions remain
  // available through session/history surfaces, but a repository branch is
  // never promoted into a pseudo-issue row (for example "podium · main").
  return nestStartedByIssues(rows, sessions, allWorktreePaths, issues, now, ownership)
}

/**
 * Nest top-level agent-started issues under the issue that owns their
 * `startedBySession` (M6 started-by tree). Formal `parentId` edges are left
 * alone — this is provenance grouping, not sub-issue hierarchy. Spin-offs
 * (issues with an outgoing `discovered-from` edge) are also left alone: their
 * provenance renders as the ⤷ origin tick, not nesting (POD-85/POD-117), so
 * started-by nesting survives only as a fallback for agent-started issues that
 * carry no explicit edge. If the starter session or its issue is not in the
 * current sidebar view, the issue stays top-level (never hidden). Cycle-safe.
 */
export function nestStartedByIssues(
  rows: UnifiedWorkRow[],
  sessions: readonly SessionMeta[],
  allWorktreePaths: string[],
  allIssues: readonly IssueWire[] = rows
    .filter((row): row is UnifiedIssueRow => row.kind === 'issue')
    .map((row) => row.issue),
  now: number = Date.now(),
  ownership?: SessionOwnershipIndex,
): UnifiedWorkRow[] {
  const issueRows = rows.filter((r): r is UnifiedIssueRow => r.kind === 'issue')
  if (issueRows.length === 0) return rows
  const visibleIssues = issueRows.map((r) => r.issue)
  const byId = new Map(issueRows.map((r) => [r.issue.id, r]))
  const allById = new Map(allIssues.map((issue) => [issue.id, issue]))
  const parentOf = new Map<IssueId, IssueId>()

  for (const row of issueRows) {
    const issue = row.issue
    // A formal tree edge always wins over provenance. Walk to the nearest visible
    // ancestor so a session-less internal bookkeeping node cannot orphan live work.
    let parentId = issue.parentId
    const seenParents = new Set<IssueId>([issue.id])
    while (parentId && !byId.has(parentId)) {
      if (seenParents.has(parentId)) {
        parentId = undefined
        break
      }
      seenParents.add(parentId)
      parentId = allById.get(parentId)?.parentId
    }
    // A spin-off (outgoing `discovered-from` edge) is deliberately TOP-LEVEL:
    // the sidebar renders its provenance as the ⤷ origin tick (POD-85), so the
    // startedBySession fallback must not re-nest it under the origin — which
    // would also bubble its sessions into the origin's aggregate agent count.
    const isSpinOff = issue.deps?.some((dep) => dep.type === 'discovered-from')
    if (!parentId && !issue.parentId && !isSpinOff && issue.startedBySession) {
      const candidate = issueIdOwningSession(
        issue.startedBySession,
        sessions,
        visibleIssues,
        allWorktreePaths,
        ownership,
      )
      const candidateRow = candidate ? byId.get(candidate) : undefined
      // Nesting under a draft vessel ERASES the issue: that row is the agent
      // itself and renders no children, so the child has no path to the screen.
      // Provenance is never worth losing the work — a draft keeps its spawned
      // issues top-level until it becomes real work of its own (POD-282).
      if (candidateRow && !isDraftAgentVessel(candidateRow.issue, candidateRow.sessions)) {
        parentId = candidateRow.issue.id
      }
    }
    if (!parentId || parentId === issue.id || !byId.has(parentId)) continue
    let walk: IssueId | undefined = parentId
    const cycle = new Set<IssueId>([issue.id])
    while (walk && !cycle.has(walk)) {
      cycle.add(walk)
      walk = parentOf.get(walk)
    }
    if (walk) continue
    parentOf.set(issue.id, parentId)
  }

  const childrenOf = new Map<IssueId, IssueId[]>()
  for (const [childId, parentId] of parentOf) {
    const children = childrenOf.get(parentId) ?? []
    children.push(childId)
    childrenOf.set(parentId, children)
  }
  const attach = (row: UnifiedIssueRow): UnifiedIssueRow => {
    const children = (childrenOf.get(row.issue.id) ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is UnifiedIssueRow => child !== undefined)
      .map(attach)
      // A parent's children are their own sibling scope (POD-168): manual
      // sortKey order, same comparator as top level.
      .sort(compareManualOrder)
    const aggregateSessions = [
      ...row.sessions,
      ...children.flatMap((child) => child.aggregateSessions ?? child.sessions),
    ]
    return {
      ...row,
      ...(children.length ? { startedByChildren: children } : {}),
      aggregateSessions,
      rank: rowRank(aggregateSessions, now),
      activityAt: aggregateSessions.reduce(
        (max, session) => Math.max(max, Date.parse(session.lastActiveAt) || 0),
        row.activityAt,
      ),
    }
  }

  const nested = new Set(parentOf.keys())
  const out: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'worktree') {
      out.push(row)
      continue
    }
    if (nested.has(row.issue.id)) continue
    // Internal issues are operational detail: nested only, never top-level.
    if (row.issue.audience === 'agent') continue
    out.push(attach(row))
  }
  return out
}

/**
 * The unified WORK LIST — one flat list in fixed newest-first creation order
 * (#64). Pinned and just-unsnoozed issues float to the top; still-snoozed
 * issues sink to the bottom; inside each band rows read newest-created first
 * and never reorder on agent activity or attention.
 * (For the WORKING move-out split, see {@link partitionUnifiedWork}.)
 */
export function unifiedWorkList(
  sections: SidebarSections,
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkRow[] {
  return sortUnifiedWorkRows(
    buildUnifiedRows(sections, issues, sessions, allWorktreePaths, now, sections.sessionOwnership),
    now,
  )
}

/** One entry in the WORKING section (move-out semantics): a fully-working issue
 *  or worktree row, or an individual working session lifted out of a partially-
 *  working row. */
export type WorkingEntry =
  | { kind: 'issue'; row: Extract<UnifiedWorkRow, { kind: 'issue' }> }
  | { kind: 'worktree'; row: Extract<UnifiedWorkRow, { kind: 'worktree' }> }
  | { kind: 'session'; session: SessionMeta }

export interface UnifiedWorkPartition {
  /** WORKING rows/sessions, preserving the unified list's manual row order. */
  working: WorkingEntry[]
  /** The WORK list (banded order), minus whatever moved to WORKING. */
  work: UnifiedWorkRow[]
}

/** Rebuild a WORK row around a filtered session set, recomputing its rank +
 *  activity so ordering stays coherent after working sessions are lifted out. */
function rowWithSessions(row: UnifiedWorkRow, keep: SessionMeta[], now: number): UnifiedWorkRow {
  const activityAt = keep.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
  if (row.kind === 'issue') {
    // Recompute the bubbled aggregate too — a stale aggregate would keep
    // counting a lifted session in the row's status. [spec:SP-6144]
    const aggregate = [
      ...keep,
      ...(row.startedByChildren ?? []).flatMap(
        (child) => child.aggregateSessions ?? child.sessions,
      ),
    ]
    return {
      ...row,
      sessions: keep,
      aggregateSessions: aggregate,
      rank: rowRank(keep, now),
      activityAt: activityAt || Date.parse(row.issue.updatedAt) || 0,
    }
  }
  return {
    ...row,
    worktree: { ...row.worktree, sessions: keep },
    rank: rowRank(keep, now),
    activityAt,
  }
}

/**
 * Split the unified work into a WORKING section (move-out) and the WORK list:
 *   - an issue/worktree whose EVERY member session is working moves whole into
 *     WORKING (as its row) and out of WORK;
 *   - a partially-working row stays in WORK holding only its non-working
 *     sessions, and its working sessions are lifted into WORKING as individual
 *     rows — no duplication, a session shows in exactly one place;
 *   - a pinned issue is EXEMPT from move-out: pinning floats it to the top of
 *     WORK, so it stays there whole; when it has any working session it ALSO
 *     appears in WORKING as its row (the one row shown in both places).
 * Both partitions preserve the unified list's banded/manual row order. Lifted
 * standalone sessions retain their deterministic per-row sidebar order.
 */
export function partitionUnifiedWork(
  sections: SidebarSections,
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkPartition {
  const rows = sortUnifiedWorkRows(
    buildUnifiedRows(sections, issues, sessions, allWorktreePaths, now),
    now,
  )
  const working: WorkingEntry[] = []
  const work: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'issue' && row.issue.pinned) {
      work.push(row)
      // Aggregate-aware mirror: a working nested child lights the pinned row up
      // in WORKING too (it's the same row shown twice by design).
      if (rowSessions(row).some(isSessionWorking)) working.push({ kind: 'issue', row })
      continue
    }
    // Lift decisions run over OWN sessions only [spec:SP-6144]: a descendant's
    // working session already renders under its own nested child row, so
    // lifting it here (or moving the whole subtree out because a descendant
    // works) would show the same session twice. Descendant activity reaches
    // the row through its bubbled aggregate status instead.
    const own = row.kind === 'issue' ? row.sessions : row.worktree.sessions
    const hasNestedChildren = row.kind === 'issue' && (row.startedByChildren?.length ?? 0) > 0
    const runningNow = own.filter(isSessionWorking)
    if (!hasNestedChildren && runningNow.length > 0 && runningNow.length === own.length) {
      working.push(row.kind === 'issue' ? { kind: 'issue', row } : { kind: 'worktree', row })
    } else if (runningNow.length > 0) {
      work.push(
        rowWithSessions(
          row,
          own.filter((s) => !isSessionWorking(s)),
          now,
        ),
      )
      for (const s of runningNow) working.push({ kind: 'session', session: s })
    } else {
      work.push(row)
    }
  }
  return { working, work }
}
