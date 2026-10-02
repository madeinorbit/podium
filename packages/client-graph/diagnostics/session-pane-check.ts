/** Optional pane differential, using sidebar-check's positions-only report.
 * Legacy input is diagnostic-only; it never enters the switched read path. */
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { attentionGroup } from '@podium/client-core/focus'
import { sessionWaking, resumeCommand, sessionUrgencyRank, exitedRecovery } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import type { IssueViewModel } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-core/replica'
import type { MobxPool } from '../src/pool'
import { paneSession, paneWindow, paneMachines, paneStampIssue, paneIssueColor } from '../src/session-pane'
import { SESSION_PANE_SCHEMA } from '../src/session-pane-schema'
import { LOADING } from '../src/worklist/rollup'
import { compareSidebarSnapshots, type CheckRow } from './sidebar-check'

export function paneComparable(row: SessionView | undefined, now: number): Record<string, unknown> {
  if (!row) return { present: false }
  const phase = row.agentState?.phase
  return {
    present: true,
    ...Object.fromEntries(SESSION_PANE_SCHEMA.session.fields.map(key => [key, Reflect.get(row, key)])),
    attention: attentionGroup(row), urgency: sessionUrgencyRank(row, now), waking: sessionWaking(row),
    resumeCommand: resumeCommand(row),
    recovery: exitedRecovery({ exitCode: row.exitCode, spawnFailure: row.spawnFailure,
      isShell: row.agentKind === 'shell', resumable: row.resumable === true, neverBound: row.neverBound === true }),
    canEnd: ['live', 'starting', 'reconnecting'].includes(row.status),
    canHibernate: row.status === 'live' && row.resumable === true && phase !== 'working' && phase !== 'compacting',
    dockDead: row.archived || row.status === 'exited', dockParked: !row.archived && row.status === 'hibernated',
  }
}
export function checkSessionPanes(pool: MobxPool, state: Pick<Store, 'sessions' | 'machines' | 'panelMode' | 'dockShells' | 'reposLoaded' | 'pendingSpawnIds' | 'coarseNow' | 'selectedIssueId'>,
  ids = state.sessions.map(row => row.sessionId as string), issues: readonly IssueViewModel[] = [],
  hex: (color: string | null | undefined) => string | undefined = color => color ?? undefined) {
  let pending = 0
  let acceptedOwnershipDifferences = 0
  const expected = ids.map((id): CheckRow => {
    const row = state.sessions.find(row => row.sessionId === id)
    const eligible = issues.filter(issue => !issue.archived && !issue.deletedAt)
    const candidates = eligible.filter(issue => row && (row.issueId === issue.id ||
      (issue.worktreePath !== null && (row.cwd === issue.worktreePath || row.cwd.startsWith(`${issue.worktreePath}/`)))))
    const approved = row && (eligible.find(issue => issue.id === row.issueId) ??
      [...candidates].sort((a, b) => (b.worktreePath?.length ?? 0) - (a.worktreePath?.length ?? 0))[0])
    if (candidates[0]?.id !== approved?.id) acceptedOwnershipDifferences++
    return { id, fields: { ...paneComparable(row, state.coarseNow), stamp: approved ? { id: approved.id, branch: approved.branch, gitState: approved.gitState } : undefined } }
  })
  const actual = ids.map((id): CheckRow => {
    const row = paneSession(pool, id)
    const stamp = row === LOADING ? LOADING : paneStampIssue(pool, row)
    const loading = row === LOADING || stamp === LOADING
    if (loading) pending++
    return { id, pending: loading, fields: loading ? {} : { ...paneComparable(row === LOADING ? undefined : row, state.coarseNow),
      stamp: stamp && stamp !== LOADING ? { id: stamp.id, branch: stamp.branch, gitState: stamp.gitState } : undefined } }
  })
  const window = paneWindow(pool)
  const windowPending = window === LOADING
  if (windowPending) pending++
  const controls = (input: typeof window) => !input || input === LOADING ? {} : {
    panelMode: input.panelMode, dockShells: input.dockShells, reposLoaded: input.reposLoaded,
    pendingSpawnIds: [...input.pendingSpawnIds].sort(),
  }
  const machineRows = (rows: typeof state.machines) => rows.map((row): CheckRow => ({ id: row.id, fields: { row } }))
  const expectedColor = () => {
    let row = issues.find(row => row.id === state.selectedIssueId && !row.archived && !row.deletedAt)
    const seen = new Set<string>()
    while (row) {
      const own = hex(row.color)
      if (own) return own
      if (!row.parentId || seen.has(row.parentId)) return undefined
      seen.add(row.parentId)
      row = issues.find(candidate => candidate.id === row?.parentId)
    }
    return undefined
  }
  const selectedIssueId = pool.selection.keys().next().value ?? null
  const issueHex = paneIssueColor(pool, selectedIssueId, hex)
  if (issueHex === LOADING) pending++
  const result = compareSidebarSnapshots({ sections: [
    { key: 'sessions', fields: {}, rows: expected },
    { key: 'controls', fields: controls(state), rows: [] },
    { key: 'machines', fields: {}, rows: machineRows(state.machines) },
    { key: 'ownership', fields: { selectedIssueId: state.selectedIssueId, issueHex: expectedColor() }, rows: [] },
  ], pending: 0 }, { sections: [
    { key: 'sessions', fields: {}, rows: actual },
    { key: 'controls', fields: controls(window), pendingFields: windowPending ? ['panelMode', 'dockShells', 'reposLoaded', 'pendingSpawnIds'] : [], rows: [] },
    { key: 'machines', fields: {}, rows: machineRows(paneMachines(pool)) },
    { key: 'ownership', fields: { selectedIssueId, issueHex: issueHex === LOADING ? undefined : issueHex },
      pendingFields: issueHex === LOADING ? ['issueHex'] : [], rows: [] },
  ], pending })
  return { differences: result.differences, pending: result.pending, positions: result.rows, acceptedOwnershipDifferences,
    first: result.first ? { section: result.first.sectionIndex, index: result.first.rowIndex, field: result.first.field } : null }
}
export function installSessionPaneCheck(pool: MobxPool, runtime: ClientRuntime,
  hex?: (color: string | null | undefined) => string | undefined): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => {
    const state = runtime.getSnapshot()
    return checkSessionPanes(pool, state, undefined, allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates), hex)
  }
  Object.assign(window, { __sessionPaneCheck: check })
  return () => { if (Reflect.get(window, '__sessionPaneCheck') === check) Reflect.deleteProperty(window, '__sessionPaneCheck') }
}
