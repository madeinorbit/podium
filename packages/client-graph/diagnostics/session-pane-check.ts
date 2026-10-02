/** Optional pane differential, using sidebar-check's positions-only report.
 * Legacy input is diagnostic-only; it never enters the switched read path. */
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { attentionGroup } from '@podium/client-core/focus'
import { sessionWaking, resumeCommand, sessionUrgencyRank, exitedRecovery } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '../src/pool'
import { paneSession, paneWindow, paneMachines } from '../src/session-pane'
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
export function checkSessionPanes(pool: MobxPool, state: Pick<Store, 'sessions' | 'machines' | 'panelMode' | 'dockShells' | 'reposLoaded' | 'pendingSpawnIds' | 'coarseNow'>,
  ids = state.sessions.map(row => row.sessionId as string)) {
  let pending = 0
  const expected = ids.map((id): CheckRow => ({ id, fields: paneComparable(state.sessions.find(row => row.sessionId === id), state.coarseNow) }))
  const actual = ids.map((id): CheckRow => {
    const row = paneSession(pool, id)
    if (row === LOADING) pending++
    return { id, pending: row === LOADING, fields: row === LOADING ? {} : paneComparable(row, state.coarseNow) }
  })
  const window = paneWindow(pool)
  const windowPending = window === LOADING
  if (windowPending) pending++
  const controls = (input: typeof window) => !input || input === LOADING ? {} : {
    panelMode: input.panelMode, dockShells: input.dockShells, reposLoaded: input.reposLoaded,
    pendingSpawnIds: [...input.pendingSpawnIds].sort(),
  }
  const machineRows = (rows: typeof state.machines) => rows.map((row): CheckRow => ({ id: row.id, fields: { row } }))
  const result = compareSidebarSnapshots({ sections: [
    { key: 'sessions', fields: {}, rows: expected },
    { key: 'controls', fields: controls(state), rows: [] },
    { key: 'machines', fields: {}, rows: machineRows(state.machines) },
  ], pending: 0 }, { sections: [
    { key: 'sessions', fields: {}, rows: actual },
    { key: 'controls', fields: controls(window), pendingFields: windowPending ? ['panelMode', 'dockShells', 'reposLoaded', 'pendingSpawnIds'] : [], rows: [] },
    { key: 'machines', fields: {}, rows: machineRows(paneMachines(pool)) },
  ], pending })
  return { differences: result.differences, pending: result.pending, positions: result.rows,
    first: result.first ? { section: result.first.sectionIndex, index: result.first.rowIndex, field: result.first.field } : null }
}
export function installSessionPaneCheck(pool: MobxPool, runtime: ClientRuntime): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => checkSessionPanes(pool, runtime.getSnapshot())
  Object.assign(window, { __sessionPaneCheck: check })
  return () => { if (Reflect.get(window, '__sessionPaneCheck') === check) Reflect.deleteProperty(window, '__sessionPaneCheck') }
}
