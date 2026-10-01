/** POD-4953: the current real sidebar, as its rows and sections read it.
 * Only this oracle imports the legacy derivations. Product code never does.
 */
import {
  deriveFleetPresence, groupUnifiedWorkRows, splitPinnedWork, isDraftAgentVessel, isUnstartedSession, issueDisplayTitle,
  missionRollup, orderProjectItems, orderedSidebarProjects, partitionStaleSessions,
  rowAwaitsTuck, rowCanBringBack, rowErrorLine, rowMotionPhase, rowMotionTiming,
  rowPendingDecision, rowUnreadEmphasized, rowStatusLine,
  type UnifiedIssueRow,
} from '@podium/client-core/viewmodels'
import { issueReturnedFromDefer, isIssueDeferred, asIssueId } from '@podium/model'
import { isDeepStrictEqual } from 'node:util'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import type { SidebarSections, SidebarState } from '@podium/client-graph/worklist/sidebar'
import type { LegacyDerivation } from './oracle'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'

/** All fields the existing row reads from its own issue. Presentation is kept
 * in that component, including refs, colours, labels and status formatting. */
export const ISSUE_CONTENT_FIELDS = [
  'id', 'seq', 'color', 'title', 'stage', 'closedReason', 'closedAt', 'updatedAt',
  'audience', 'draft', 'pinned', 'tuckedAt', 'readAt', 'unread', 'gitState',
  'repoPath', 'worktreePath', 'branch', 'parentBranch', 'needsHuman', 'blocked',
  'humanQuestion', 'humanQuestionOptions', 'origin', 'commentCount',
] as const
const pick = (row: unknown, fields: readonly string[]): Record<string, unknown> => Object.fromEntries(fields.map(field => [field, (row as Record<string, unknown>)[field] ?? null]))

/** Compare raw compatibility payloads by the fields presentation actually
 * reads. No old record's irrelevant server supplement enters the oracle. */
export function sidebarComparable(value: SidebarRowValues): Record<string, unknown> {
  const session = (s: unknown) => pick(s, ['sessionId', 'issueId', 'name', 'title', 'createdAt', 'agentKind', 'status', 'archived', 'lastActiveAt', 'readAt', 'unread', 'agentState', 'offer', 'snoozedUntil'])
  return { ...value, issue: pick(value.issue, ISSUE_CONTENT_FIELDS),
    sessions: value.sessions.map(session), aggregateSessions: value.aggregateSessions.map(session) }
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
  return sidebarComparable({
    idNumber: issue.seq, color: issue.color ?? null,
    title: issueDisplayTitle(issue, derivation.sessions, derivation.allWorktreePaths),
    timing: rowMotionTiming(row), decision,
    mergeCommits: decision === 'merge' ? issue.gitState?.ahead ?? 0 : 0,
    progress: rollup.progress, fromChildren: rollup.fromChildren,
    gitState: issue.gitState, unread: rowUnreadEmphasized(row),
    errorClass: errorSession ? errorSession.agentState?.error?.class ?? 'unknown' : null,
    internal: issue.audience === 'agent', unsnoozed: issueReturnedFromDefer(issue, now),
    deferred: isIssueDeferred(issue, now), awaitsTuck: rowAwaitsTuck(row, null, false, now),
    canBringBack: rowCanBringBack(row, now), draftAgentOnly: isDraftAgentVessel(issue, row.sessions),
    firstSessionId: row.sessions[0]?.sessionId ?? null,
    continuation: continuation ? { kind: continuation[0] === 'duplicate' ? 'duplicate' : 'continued', ref: continuation.slice(1).join(' · ') } : null,
    fleet: { total: fleet.present.length, parkedCount: fleet.parkedCount, nativeCount: fleet.nativeCount, tiles: fleet.tiles },
    issue: issue as unknown as SidebarRowValues['issue'], sessions: row.sessions,
    aggregateSessions: aggregate, awaitingFirstPrompt: issue.draft === true && rowMotionPhase(row) === 'queued' && aggregate.length > 0 && aggregate.every(isUnstartedSession),
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
    const value = pool.sidebar.worktree(row.worktree.path, state)
    if (!value) { differences.push(`${row.worktree.path}: roster absent`); continue }
    const partition = partitionStaleSessions(row.worktree.sessions, now)
    for (const [field, actual, expected] of [
      ['sessions', value.sessions, row.worktree.sessions], ['visible', value.visible, partition.visible], ['stale', value.stale, partition.stale],
    ] as const) if (!isDeepStrictEqual(actual.map(s => s.sessionId), expected.map(s => s.sessionId))) differences.push(`${row.worktree.path}.${field}: ${actual.map(s => s.sessionId)} expected ${expected.map(s => s.sessionId)}`)
    if (value.activityAt !== row.activityAt) differences.push(`${row.worktree.path}.activityAt: ${value.activityAt} expected ${row.activityAt}`)
    if ((value.worktree.branch ?? null) !== (row.worktree.branch ?? null)) differences.push(`${row.worktree.path}.branch`)
    if (value.worktree.repoName !== row.worktree.repoName) differences.push(`${row.worktree.path}.repoName`)
  }
  return differences
}

/** Pure legacy formatter on the pool's compatibility payload. This pins the
 * actual status line while leaving copy/formatting in current presentation. */
export function poolStatusLine(value: SidebarRowValues, activityAt: number, now: number): string {
  const continuation = value.continuation ? `${value.continuation.kind} · ${value.continuation.ref}` : undefined
  const row = { kind: 'issue', issue: value.issue, sessions: value.sessions,
    aggregateSessions: value.aggregateSessions, missionRollup: { progress: value.progress, fromChildren: value.fromChildren }, activityAt, continuation } as unknown as UnifiedIssueRow
  return continuation ?? rowStatusLine(row, now, 0)
}

export function sidebarDiff(pool: MobxPool, derivation: LegacyDerivation, rows: readonly UnifiedIssueRow[], now: number): string[] {
  const differences: string[] = []
  for (const row of rows) {
    const value = pool.sidebar.row(row.issue.id)
    if (value === undefined || value === LOADING) { differences.push(`${row.issue.id}: sidebar absent/loading`); continue }
    const expected = legacySidebarRow(row, derivation, now), actual = sidebarComparable(value)
    for (const field of Object.keys(expected)) if (!isDeepStrictEqual(actual[field], expected[field])) differences.push(`${row.issue.id}.${field}: ${JSON.stringify(actual[field])} expected ${JSON.stringify(expected[field])}`)
    const line = row.continuation ?? rowStatusLine(row, now, 0)
    if (poolStatusLine(value, pool.issue(row.issue.id)?.activityAt ?? 0, now) !== line) differences.push(`${row.issue.id}.statusLine: ${poolStatusLine(value, pool.issue(row.issue.id)?.activityAt ?? 0, now)} expected ${line}`)
  }
  return differences
}
