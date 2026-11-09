/** Optional pane differential, using sidebar-check's positions-only report.
 * Legacy input is diagnostic-only; it never enters the switched read path. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { attentionGroup } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { defaultChatCapable, deriveGitStamp, exitedRecovery, resumeCommand, sessionTerminalOutlook, sessionUrgencyRank, sessionWaking } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { paneMachines, paneSession, paneWindow } from '@podium/client-graph/session-pane'
import { SESSION_PANE_SCHEMA } from '@podium/client-graph/session-pane-schema'
import { sessionPaneView } from '@podium/client-graph/session-pane-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { allIssueViewModels } from './reference/issue-view-models'
import type { ReferenceState as Store } from './reference-state'
import { referenceState } from './reference-state'
import { type CheckRow, compareSidebarSnapshots } from './sidebar-check'

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
    terminalOutlook: sessionTerminalOutlook(row), chatCapable: row.transcriptAvailable ?? defaultChatCapable(row.agentKind),
    canEnd: ['live', 'starting'].includes(row.status),
    canHibernate: row.status === 'live' && row.resumable === true && phase !== 'working' && phase !== 'compacting',
    dockDead: row.archived || row.status === 'exited', dockParked: !row.archived && row.status === 'hibernated',
  }
}
export function checkSessionPanes(pool: MobxPool, state: Pick<Store, 'sessions' | 'machines' | 'panelMode' | 'dockShells' | 'coarseNow' | 'selectedIssueId'>,
  ids = state.sessions.map(row => row.sessionId as string), issues: readonly IssueViewModel[] = []) {
  let pending = 0
  let acceptedOwnershipDifferences = 0
  const eligible = issues.filter(issue => !issue.archived && !issue.deletedAt)
  const stampFields = (issue: { id: string; branch?: string | null; gitState?: IssueViewModel['gitState'] | null } | undefined) =>
    issue ? { id: issue.id, branch: issue.branch ?? null, gitState: issue.gitState, view: deriveGitStamp(issue.branch, issue.gitState) } : undefined
  const expected = ids.map((id, index): CheckRow => {
    const at = state.sessions[index]
    const row = at?.sessionId === id ? at : state.sessions.find(row => row.sessionId === id)
    const candidates = eligible.filter(issue => row && (row.issueId === issue.id ||
      (issue.worktreePath !== null && (row.cwd === issue.worktreePath || row.cwd.startsWith(`${issue.worktreePath}/`)))))
    const approved = row && (candidates.find(issue => issue.id === row.issueId) ??
      [...candidates].sort((a, b) => (b.worktreePath?.length ?? 0) - (a.worktreePath?.length ?? 0))[0])
    if (candidates[0]?.id !== approved?.id) acceptedOwnershipDifferences++
    return { id, fields: { ...paneComparable(row, state.coarseNow), stamp: stampFields(approved) } }
  })
  const actual = ids.map((id): CheckRow => {
    const row = paneSession(pool, id)
    const stamp = row === LOADING ? LOADING : sessionPaneView(pool).loaded(id)?.stampIssue
    const loading = row === LOADING || stamp === LOADING
    if (loading) pending++
    return { id, pending: loading, fields: loading ? {} : { ...paneComparable(row, state.coarseNow),
      stamp: stampFields(stamp) } }
  })
  const window = paneWindow(pool)
  const windowPending = window === LOADING
  if (windowPending) pending++
  const controls = (input: typeof window) => !input || input === LOADING ? {} : {
    panelMode: input.panelMode, dockShells: input.dockShells,

  }
  // What the pane reads of a machine: its name, online (the LiveStore's) and logged-out harnesses.
  const machineRows = (rows: readonly import('@podium/model').MachineFacts[]) => rows.map((row): CheckRow => ({ id: row.id,
    fields: { name: row.name, online: row.online, loggedOutHarnesses: row.loggedOutHarnesses ?? [] } }))
  const selectedIssueId = sessionPaneView(pool).selectedIssueId
  const differenceFields: Record<string, number> = {}
  const result = compareSidebarSnapshots({ sections: [
    { key: 'sessions', fields: {}, rows: expected },
    { key: 'controls', fields: controls(state), rows: [] },
    { key: 'machines', fields: {}, rows: machineRows(state.machines) },
    { key: 'ownership', fields: { selectedIssueId: state.selectedIssueId }, rows: [] },
  ], pending: 0 }, { sections: [
    { key: 'sessions', fields: {}, rows: actual },
    { key: 'controls', fields: controls(window), pendingFields: windowPending ? ['panelMode', 'dockShells'] : [], rows: [] },
    { key: 'machines', fields: {}, rows: machineRows(paneMachines(pool)) },
    { key: 'ownership', fields: { selectedIssueId },
      rows: [] },
  ], pending }, difference => { differenceFields[difference.field] = (differenceFields[difference.field] ?? 0) + 1 })
  return { differences: result.differences, pending: result.pending, positions: result.rows, acceptedOwnershipDifferences,
    first: result.first ? { section: result.first.sectionIndex, index: result.first.rowIndex, field: result.first.field } : null, differenceFields }
}
export function installSessionPaneCheck(pool: MobxPool, runtime: ClientRuntime): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => {
    const state = referenceState(runtime)
    return checkSessionPanes(pool, state, undefined, allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates))
  }
  Object.assign(window, { __sessionPaneCheck: check })
  return () => { if (Reflect.get(window, '__sessionPaneCheck') === check) Reflect.deleteProperty(window, '__sessionPaneCheck') }
}
