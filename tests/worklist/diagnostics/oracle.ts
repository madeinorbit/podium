import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
/** POD-4953: the current real sidebar, as its rows and sections read it.
 * Only this oracle imports the legacy derivations. Product code never does.
 */
import { deriveFleetPresence, splitPinnedWork, isDraftAgentVessel, isUnstartedSession, issueDisplayTitle, missionRollup, orderProjectItems, orderedSidebarProjects, partitionStaleSessions, rowAwaitsTuck, rowCanBringBack, rowErrorLine, rowMotionPhase, rowMotionTiming, rowPendingDecision, rowUnreadEmphasized, rowStatusLine, rowHasWorkingSession, rowWaitingCount, type UnifiedIssueRow } from '@podium/client-core/values'
import { groupUnifiedWorkRows } from '../legacy-values/index'
import { issueReturnedFromDefer, isIssueDeferred, asIssueId } from '@podium/model'
import { compareStructural as isDeepStrictEqual } from 'mobx'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import type { SidebarSections, SidebarState } from '@podium/client-graph/worklist/sidebar'
import type { LegacyDerivation } from './legacy'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'



/** All fields the existing row reads from its own issue. Presentation is kept
 * in that component, including refs, colours, labels and status formatting. */
export const ISSUE_CONTENT_FIELDS = [
  'id', 'seq', 'displayRef', 'linearIdentifier', 'color', 'title', 'stage', 'closedReason', 'closedAt', 'updatedAt',
  'audience', 'isDraftVessel', 'pinned', 'tuckedAt', 'readAt', 'unread', 'gitState',
  'repoPath', 'worktreePath', 'branch', 'parentBranch', 'parentId', 'needsHuman', 'blocked',
  'asked', 'intentOrigin',
] as const
const ISSUE_BOOLEAN_FIELDS = new Set(['isDraftVessel', 'pinned', 'needsHuman', 'blocked'])
const pick = (row: unknown, fields: readonly string[]): Record<string, unknown> => Object.fromEntries(fields.map(field => [field,
  ISSUE_BOOLEAN_FIELDS.has(field) ? (row as Record<string, unknown>)[field] === true : (row as Record<string, unknown>)[field] ?? null]))

/** PanelRow/WorkerLabel inputs, including raw attribution and outcome facts
 * whose formatting remains in those components. */
const SESSION_CONTENT_FIELDS = [
  'sessionId', 'issueId', 'displayRef', 'name', 'title', 'createdAt', 'agentKind',
  'agentColor', 'status', 'archived', 'lastActiveAt', 'readAt', 'unread',
  'agentState', 'offer', 'snoozedUntil', 'draftUpdatedAt', 'createdBy',
  'stoppedAt', 'stopReason', 'busy',
] as const
export const sessionComparable = (session: unknown) => pick(session, SESSION_CONTENT_FIELDS)

/** Compare raw compatibility payloads by the fields presentation actually
 * reads. No old record's irrelevant server supplement enters the oracle. */
export function sidebarComparable(value: SidebarRowValues | WorklistIssue): Record<string, unknown> {
  if ('worklist' in value) return {
    idNumber: value.issue.seq, color: value.issue.color ?? null, title: value.title,
    timing: value.timing, working: value.visibleWorking, asking: value.visibleAsking,
    originTick: value.origin, decision: value.decision, mergeCommits: value.mergeCommits,
    progress: value.progress, fromChildren: value.hasChildProgress, statusFromChildren: value.showsChildProgress,
    gitState: value.issue.gitState, unread: value.visibleUnread, errorClass: value.errorClass,
    internal: value.issue.audience === 'agent', unsnoozed: value.returnedFromDefer, deferred: value.issue.deferred,
    awaitsTuck: value.canTuck, canBringBack: value.canBringBack, draftAgentOnly: value.sessionOnlyDraft,
    firstSessionId: value.firstSessionId, continuation: value.continuation, fleet: value.visibleFleet,
    issue: { ...pick(value.issue, ISSUE_CONTENT_FIELDS), unread: value.unread },
    sessions: value.sessions.map(sessionComparable), aggregateSessionIds: value.visibleSessionIds,
    awaitingFirstPrompt: value.awaitingFirstPrompt,
  }
  return { ...value, issue: pick(value.issue, ISSUE_CONTENT_FIELDS),
    sessions: value.sessions.map(sessionComparable) }
}

export function legacySidebarRow(row: UnifiedIssueRow, derivation: LegacyDerivation, now: number): Record<string, unknown> {
  const issue = row.issue
  const aggregate = row.aggregateSessions ?? row.sessions
  const decision = rowPendingDecision(row)
  const rollup = row.missionRollup ?? missionRollup(derivation.models, derivation.sessions, issue.id)
  const fleet = deriveFleetPresence(aggregate)
  const continuation = row.continuation?.split(' · ')
  const error = rowErrorLine(row)
  const errorSession = error ? aggregate.find(s => !s.archived && s.status !== 'exited' && s.agentState?.phase === 'errored') : undefined
  const originId = issue.deps?.find(dep => dep.type === 'discovered-from')?.id
  const origin = originId ? derivation.models.find(model => model.id === originId) : undefined
  return sidebarComparable({
    idNumber: issue.seq, color: issue.color ?? null,
    title: issueDisplayTitle(issue, derivation.sessions, derivation.allWorktreePaths),
    timing: rowMotionTiming(row), decision,
    working: rowHasWorkingSession(row), asking: rowWaitingCount(row) > 0,
    originTick: origin ? { id: origin.id, seq: origin.seq, title: origin.title, ref: origin.displayRef ?? `#${origin.seq}` } : null,
    mergeCommits: decision === 'merge' ? issue.gitState?.ahead ?? 0 : 0,
    progress: rollup.progress, fromChildren: rollup.fromChildren, statusFromChildren: row.missionRollup?.fromChildren === true,
    gitState: issue.gitState, unread: rowUnreadEmphasized(row),
    errorClass: errorSession ? errorSession.agentState?.error?.class ?? 'unknown' : null,
    internal: issue.audience === 'agent', unsnoozed: issueReturnedFromDefer(issue, now),
    deferred: isIssueDeferred(issue, now), awaitsTuck: rowAwaitsTuck(row, null, false, now),
    canBringBack: rowCanBringBack(row, now), draftAgentOnly: isDraftAgentVessel(issue, row.sessions),
    firstSessionId: row.sessions[0]?.sessionId ?? null,
    continuation: continuation ? { kind: continuation[0] === 'duplicate' ? 'duplicate' : 'continued', ref: continuation.slice(1).join(' · ') } : null,
    fleet: { total: fleet.present.length, parkedCount: fleet.parkedCount, nativeCount: fleet.nativeCount, tiles: fleet.tiles },
    issue: issue as unknown as SidebarRowValues['issue'], sessions: row.sessions,
    aggregateSessionIds: aggregate.map(s => s.sessionId), awaitingFirstPrompt: issue.isDraftVessel === true && rowMotionPhase(row) === 'queued' && aggregate.length > 0 && aggregate.every(isUnstartedSession),
  })
}

export function legacySidebarSections(derivation: LegacyDerivation, state: SidebarState, selectedId: string | null = null, selectedClosed = false, now = Date.now()): SidebarSections {
  const slice = derivation.slice
  const { pinned, rest } = splitPinnedWork(slice.work)
  const groups = groupUnifiedWorkRows(rest, selectedId === null ? null : asIssueId(selectedId), selectedClosed, now)
  const projects = orderedSidebarProjects(slice.sections, groups, state.projectOrder ?? [])
  const bands = groups.map(group => {
    const project = projects.find(p => p.aliases.includes(group.key))
    const repo = [...slice.sections.pinnedRepos, ...slice.sections.repos].find(r => (r.repoId ?? r.path) === group.key)
    const foldKey = `podium:sidebar:project-fold:${group.key}`
    const snoozedFoldKey = `podium:sidebar:snoozed-fold:${group.key}`
    const closedFoldKey = `podium:sidebar:closed-fold:${group.key}`
    return { key: group.key, label: group.label, aliases: project?.aliases ?? [group.key], repoPath: repo?.path ?? group.rows.find(r => r.kind === 'issue')?.issue.repoPath ?? group.key,
      rowIds: group.rows.flatMap(r => r.kind === 'issue' ? [r.issue.id] : []),
      worktreeIds: group.rows.flatMap(r => r.kind === 'worktree' ? [r.worktree.path] : []),
      snoozedIds: group.snoozedRows.map(r => r.issue.id), closedIds: group.closedRows.map(r => r.issue.id),
      foldKey, snoozedFoldKey, closedFoldKey, collapsed: state.collapsed?.[foldKey] === true,
      snoozedCollapsed: state.collapsed?.[snoozedFoldKey] !== false, closedCollapsed: state.collapsed?.[closedFoldKey] !== false, startFirstTask: false }
  })
  for (const repo of [...slice.sections.pinnedRepos, ...slice.sections.repos]) {
    const key = repo.repoId ?? repo.path
    if (bands.some(b => b.key === key)) continue
    const project = projects.find(p => p.key === key)
    const foldKey = `podium:sidebar:project-fold:${key}`, snoozedFoldKey = `podium:sidebar:snoozed-fold:${key}`, closedFoldKey = `podium:sidebar:closed-fold:${key}`
    bands.push({ key, label: repo.name, repoPath: repo.path, aliases: project?.aliases ?? [key], rowIds: [], worktreeIds: [], snoozedIds: [], closedIds: [],
      foldKey, snoozedFoldKey, closedFoldKey, collapsed: state.collapsed?.[foldKey] === true, snoozedCollapsed: state.collapsed?.[snoozedFoldKey] !== false,
      closedCollapsed: state.collapsed?.[closedFoldKey] !== false, startFirstTask: true })
  }
  return { pinnedIds: pinned.flatMap(r => r.kind === 'issue' ? [r.issue.id] : []), bands: orderProjectItems(bands, projects, b => b.key),
    pinnedFoldKey: 'podium:sidebar:pinned-fold', pinnedCollapsed: state.collapsed?.['podium:sidebar:pinned-fold'] === true }
}

/** The roster's session partition is presentation-independent data too. */
export function worktreeDiff(pool: MobxPool, derivation: LegacyDerivation, state: SidebarState, now: number): string[] {
  const differences: string[] = []
  for (const row of derivation.slice.work) {
    if (row.kind !== 'worktree') continue
    const value = sidebarView(pool).worktree(row.worktree.path, state)
    if (!value) { differences.push(`${row.worktree.path}: roster absent`); continue }
    const partition = partitionStaleSessions(row.worktree.sessions, now)
    for (const [field, actual, expected] of [
      ['sessions', value.sessions, row.worktree.sessions], ['visible', value.visible, partition.visible], ['stale', value.stale, partition.stale],
    ] as const) if (!isDeepStrictEqual(actual.map(sessionComparable), expected.map(sessionComparable))) differences.push(`${row.worktree.path}.${field}: session payload/order differs`)
    if (value.activityAt !== row.activityAt) differences.push(`${row.worktree.path}.activityAt: ${value.activityAt} expected ${row.activityAt}`)
    if ((value.worktree.branch ?? null) !== (row.worktree.branch ?? null)) differences.push(`${row.worktree.path}.branch`)
    if (value.worktree.repoName !== row.worktree.repoName) differences.push(`${row.worktree.path}.repoName`)
    const active = worklistView(pool).selectedId === null && state.selectedWorktree === row.worktree.path
    if (value.active !== active) differences.push(`${row.worktree.path}.active`)
    for (const session of row.worktree.sessions) {
      if (!session.issueId) continue
      const actual = value.issues.find(issue => issue.id === session.issueId)
      const expected = derivation.models.find(issue => issue.id === session.issueId)
      if (!isDeepStrictEqual(actual ? pick(actual, ['id', 'seq', 'displayRef', 'archived', 'deletedAt']) : null,
        expected ? pick(expected, ['id', 'seq', 'displayRef', 'archived', 'deletedAt']) : null)) differences.push(`${row.worktree.path}.${session.sessionId}.ownerRef/provenance`)
    }
  }
  return differences
}

/** Pure legacy formatter on the pool's compatibility payload. This pins the
 * actual status line while leaving copy/formatting in current presentation. */
export function poolStatusLine(input: SidebarRowValues | WorklistIssue, activityAt: number, now: number, seat: (id: string) => unknown): string {
  const value = 'worklist' in input ? sidebarComparable(input) as unknown as SidebarRowValues : input
  const continuation = value.continuation ? `${value.continuation.kind} · ${value.continuation.ref}` : undefined
  const row = { kind: 'issue', issue: value.issue, sessions: value.sessions,
    aggregateSessions: value.aggregateSessionIds.map(seat).filter(Boolean), missionRollup: { progress: value.progress, fromChildren: value.statusFromChildren }, activityAt, continuation } as unknown as UnifiedIssueRow
  return continuation ?? rowStatusLine(row, now, 0)
}

export function sidebarDiff(pool: MobxPool, derivation: LegacyDerivation, rows: readonly UnifiedIssueRow[], now: number): string[] {
  const differences: string[] = []
  for (const row of rows) {
    const value = sidebarView(pool).row(row.issue.id)
    if (value === undefined || value === LOADING) { differences.push(`${row.issue.id}: sidebar absent/loading`); continue }
    const expected = legacySidebarRow(row, derivation, now), actual = sidebarComparable(value)
    for (const field of Object.keys(expected)) {
      if (isDeepStrictEqual(actual[field], expected[field])) continue
      if (field === 'issue') {
        for (const key of ISSUE_CONTENT_FIELDS) {
          const a = (actual.issue as Record<string, unknown>)[key], e = (expected.issue as Record<string, unknown>)[key]
          if (!isDeepStrictEqual(a, e)) differences.push(`${row.issue.id}.issue.${key}: ${JSON.stringify(a)} expected ${JSON.stringify(e)}`)
        }
      } else {
        const short = (value: unknown) => (JSON.stringify(value) ?? String(value)).slice(0, 500)
        differences.push(`${row.issue.id}.${field}: ${short(actual[field])} expected ${short(expected[field])}`)
      }
    }
    const line = row.continuation ?? rowStatusLine(row, now, 0)
    const seat = (id: string) => pool.row('session', id)
    if (poolStatusLine(value, pool.worklistRow(row.issue.id)?.activityAt ?? 0, now, seat) !== line) differences.push(`${row.issue.id}.statusLine: ${poolStatusLine(value, pool.worklistRow(row.issue.id)?.activityAt ?? 0, now, seat)} expected ${line}`)
  }
  return differences
}
