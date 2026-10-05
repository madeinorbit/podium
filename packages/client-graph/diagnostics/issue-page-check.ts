import { isFinished } from '../src/shared/predicates'
import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** Explicit diagnostic job only. Private values are compared in memory; the
 * report contains counts, opaque row IDs, positions and fixed field names. */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { beginSidebarCheck } from '@podium/client-core/perf'
import { type IssueViewModel } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import type { SessionView } from '@podium/client-core/session-values'
import { groupRelations } from '@podium/client-core/values'
import { runInAction } from 'mobx'
import { knownIds } from '../src/enumerate'
import { issuePages } from '../src/issue-page'
import type { MobxPool } from '../src/pool'
import { LOADING } from '../src/worklist/rollup'

export const ISSUE_PAGE_CHECK_FIELDS = [
  'id', 'seq', 'repoId', 'repoPath', 'prefix', 'displayRef', 'title', 'description',
  'notes', 'brief', 'design', 'acceptance', 'activityNotes', 'notesUpdatedAt',
  'dependencyNote', 'blockedByNotes', 'stage', 'suggestedStage', 'suggestedReason',
  'closedReason', 'closedAt', 'deletedAt', 'archived', 'priority', 'type', 'assignee',
  'labels', 'estimateMin', 'dueAt', 'deferUntil', 'color', 'parentId', 'parentBranch',
  'branch', 'worktreePath', 'machineId', 'defaultAgent', 'defaultModel', 'defaultEffort',
  'needsHuman', 'asked', 'isDraftVessel', 'intentOrigin', 'audience', 'owner',
  'createdBy', 'lastLifecycleActor', 'createdAt', 'updatedAt', 'panel',
  'linearIdentifier', 'linearUrl', 'pinned', 'readAt', 'tuckedAt', 'gitState',
  'deps', 'dependents', 'childIds', 'childCount', 'childDoneCount', 'memberSessionIds',
  'blocked', 'ready', 'deferred', 'unread', 'sessionSummary', 'supersededBy', 'duplicateOf', 'coordinatorSessionId', 'startedBySession',
] as const
export const SESSION_FIELDS = ['sessionId', 'issueId', 'refIssueId', 'displayRef', 'name', 'title',
  'agentKind', 'agentColor', 'headless', 'status', 'archived', 'agentState', 'lastActiveAt',
  'createdAt', 'stoppedAt', 'stopReason', 'handoffTarget', 'offer', 'readAt', 'unread',
  'snoozedUntil', 'createdBy', 'machineId', 'resumable'] as const
const pick = (row: object, fields: readonly string[]) => Object.fromEntries(fields.map(key => [key, Reflect.get(row, key)]))
const sessionSnapshot = (row: SessionView) => pick(row, SESSION_FIELDS)
export interface IssuePageCheckRow {
  id: string
  value: object | typeof LOADING
}
export interface IssuePageDifference { issueId: string; position: number; field: string }
export interface IssuePageCheckResult {
  issues: number; positions: number; differences: number; pending: number; first: IssuePageDifference | null
  acceptedDeadlineDifferences: number
}

function snapshot(issue: IssueViewModel, children: IssueViewModel[], roster: SessionView[], moved: SessionView[]) {
  return { fields: pick(issue, ISSUE_PAGE_CHECK_FIELDS), children: children.map(row => pick(row, ISSUE_PAGE_CHECK_FIELDS)),
    members: (issue.memberSessionIds ?? []).map(id => roster.find(row => row.sessionId === id)).filter(Boolean).map(row => sessionSnapshot(row!)),
    roster: roster.map(sessionSnapshot), moved: moved.map(sessionSnapshot), relations: groupRelations(issue),
  }
}
export function legacyIssuePageSnapshot(issues: readonly IssueViewModel[], sessions: readonly SessionView[]): IssuePageCheckRow[] {
  // This diagnostic owns full input arrays. Build temporary indexes once;
  // checking every page must not turn into pages × sessions on the operator corpus.
  const children = new Map<string, IssueViewModel[]>(), attached = new Map<string, SessionView[]>(), moved = new Map<string, SessionView[]>()
  const append = <T,>(map: Map<string, T[]>, id: string, row: T) => { const bucket = map.get(id); if (bucket) bucket.push(row); else map.set(id, [row]) }
  for (const issue of issues) if (issue.parentId && !issue.deletedAt) append(children, issue.parentId, issue)
  for (const bucket of children.values()) bucket.sort((a, b) => a.seq - b.seq)
  const byId = new Map(sessions.map((seat, position) => [seat.sessionId as string, { seat, position }]))
  for (const seat of sessions) {
    if (seat.issueId) append(attached, seat.issueId, seat)
    if (seat.refIssueId && seat.issueId != null && seat.issueId !== seat.refIssueId && !seat.archived) append(moved, seat.refIssueId, seat)
  }
  return issues.map(issue => {
    const roster = new Map((attached.get(issue.id) ?? []).map(seat => [seat.sessionId as string, seat]))
    for (const id of issue.memberSessionIds ?? []) { const seat = byId.get(id)?.seat; if (seat) roster.set(id, seat) }
    const ordered = [...roster.values()].sort((a, b) => byId.get(a.sessionId)!.position - byId.get(b.sessionId)!.position)
    return { id: issue.id, value: snapshot(issue, children.get(issue.id) ?? [], ordered, moved.get(issue.id) ?? []) }
  })
}
export function poolIssuePageSnapshot(pool: MobxPool): IssuePageCheckRow[] {
  const views = issuePages(pool)
  return knownIds(pool, 'issue').map(id => {
    const issue = views.issue(id), roster = views.attachedSessions(id)
    if (!issue || issue === LOADING || !roster || roster === LOADING) return { id, value: LOADING }
    const children: IssueViewModel[] = []
    for (const childId of pool.graph.many('issue', id, 'treeChildren')) {
      const child = views.issue(childId)
      if (child === LOADING) return { id, value: LOADING }
      if (child && !child.deletedAt) children.push(child)
    }
    children.sort((a, b) => a.seq - b.seq)
    const moved: SessionView[] = []
    for (const sid of [...pool.graph.many('issue', id, 'bornSessions')].sort((a, b) => {
      const left = pool.graph.orderKey('session', a), right = pool.graph.orderKey('session', b)
      return left < right ? -1 : left > right ? 1 : 0
    })) {
      const seat = pool.row('session', sid) as SessionView | typeof LOADING | undefined
      if (seat === LOADING) return { id, value: LOADING }
      if (seat && seat.issueId != null && seat.issueId !== id && !seat.archived) moved.push(seat)
    }
    return { id, value: snapshot(issue, children, roster, moved) }
  })
}

/** Keys are fixed field names or numeric positions; differing values never
 * enter an error message or report. Extra/missing keys fail too. */
export function issuePageFirstDifference(expected: unknown, actual: unknown, at = ''): string | null {
  if (Object.is(expected, actual)) return null
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return at || 'value'
  if (Array.isArray(expected) !== Array.isArray(actual)) return at || 'shape'
  const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])]) {
    const path = at ? `${at}.${key}` : key
    if (Object.hasOwn(left, key) !== Object.hasOwn(right, key)) return path
    const difference = issuePageFirstDifference(left[key], right[key], path)
    if (difference) return difference
  }
  return null
}
export function compareIssuePageSnapshots(expected: readonly IssuePageCheckRow[], actual: readonly IssuePageCheckRow[],
  report?: (difference: IssuePageDifference) => void): IssuePageCheckResult {
  let differences = 0, pending = 0, first: IssuePageDifference | null = null
  const flag = (difference: IssuePageDifference) => { differences++; first ??= difference; report?.(difference) }
  const index = (rows: readonly IssuePageCheckRow[]) => {
    const result = new Map<string, IssuePageCheckRow>()
    for (const [position, row] of rows.entries()) {
      if (result.has(row.id)) flag({ issueId: row.id, position, field: 'duplicateIssue' })
      result.set(row.id, row)
    }
    return result
  }
  const left = index(expected), right = index(actual)
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort()
  for (const [position, issueId] of ids.entries()) {
    const e = left.get(issueId), a = right.get(issueId)
    if (!e || !a) { flag({ issueId, position, field: 'issue' }); continue }
    if (e.value === LOADING || a.value === LOADING) { pending++; continue }
    const field = issuePageFirstDifference(e.value, a.value)
    if (field) flag({ issueId, position, field })
  }
  return { issues: expected.length, positions: ids.length, differences, pending, first, acceptedDeadlineDifferences: 0 }
}
export function checkIssuePages(pool: MobxPool, issues: readonly IssueViewModel[], sessions: readonly SessionView[],
  report?: (difference: IssuePageDifference) => void): IssuePageCheckResult {
  // Operator decision via POD-4286 (2026-10-02): deadlines update without a
  // row publication. The legacy view cache waits for a row/marker change.
  // Compute that one expected change independently of the pool's deadline
  // reader; a broken pool expiry still fails, as does every other field.
  let acceptedDeadlineDifferences = 0
  const expected = issues.map(issue => {
    const deferred = issue.deferUntil != null && Date.parse(issue.deferUntil) > pool.clock.current
    if (deferred === issue.deferred) return issue
    const ready = !issue.blocked && !deferred && !isFinished(issue)
    acceptedDeadlineDifferences += 1 + Number(ready !== issue.ready)
    return { ...issue, deferred, ready }
  })
  return { ...compareIssuePageSnapshots(legacyIssuePageSnapshot(expected, sessions), poolIssuePageSnapshot(pool), report),
    acceptedDeadlineDifferences }
}

export function startIssuePageCheck(runtime: ClientRuntime<PodiumClientApi>, pool: MobxPool,
  report: (result: IssuePageCheckResult & { state: string; checks: number }) => void, intervalMs = 5000): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Page check interval must be positive')
  let checks = 0, disposed = false
  const empty = { issues: 0, positions: 0, differences: 0, pending: 0, first: null, acceptedDeadlineDifferences: 0 }
  report({ ...empty, state: 'waiting', checks })
  const timer = setInterval(() => {
    if (disposed) return
    const finish = beginSidebarCheck(runtime)
    try {
      const store = referenceState(runtime)
      const result = runInAction(() => checkIssuePages(pool,
        allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates), store.sessions))
      report({ ...result, state: result.pending ? 'waiting' : result.differences ? 'different' : 'match', checks: ++checks })
    } catch { report({ ...empty, state: 'error', checks }) }
    finally { finish() }
  }, intervalMs)
  return () => { if (!disposed) { disposed = true; clearInterval(timer); report({ ...empty, state: 'off', checks }) } }
}
