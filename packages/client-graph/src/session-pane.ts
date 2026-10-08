import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, type MachineWire, machinePathAncestors, machinePathSeparator } from '@podium/model/browser'
import { headerIds } from './enumerate'
import type { MobxPool } from './pool'
import type { SessionPaneRows } from './session-pane-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export function paneSession(pool: MobxPool, id: string | undefined): Loaded<SessionView> {
  return id === undefined ? undefined : (pool.row('session', id) as Loaded<SessionView>)
}
export function paneWindow(pool: MobxPool): Loaded<SessionPaneRows['sessionPaneWindow']> {
  return pool.row('sessionPaneWindow', 'window')
}
export function paneMachines(pool: MobxPool): MachineWire[] {
  return headerIds(pool, 'machine').flatMap(id => {
    const row = pool.row('machine', id) as MachineWire | undefined
    return row ? [row] : []
  })
}
export function paneHasSessions(pool: MobxPool): boolean {
  return pool.queries.count('session') > 0
}
export function paneSpawnConfirmed(pool: MobxPool, id: string): boolean {
  const window = paneWindow(pool)
  if (!window || window === LOADING) return false
  // Confirmation belongs to the principal's pool transaction log.
  const placeholders = pool.spawnPlaceholders()
  return placeholders !== null && !placeholders.has(id)
}

export interface PaneIssue {
  id: string
  seq: number
  archived?: boolean
  deletedAt?: string | null
  worktreePath?: string | null
  parentId?: string | null
  color?: string | null
  branch?: string | null
  gitState?: import('@podium/client-core/replica').IssueViewModel['gitState']
}
function eligibleIssue(pool: MobxPool, id: string): Loaded<PaneIssue> {
  const summary = pool.row('issue', id, 'summary') as Loaded<PaneIssue>
  if (summary === LOADING) return LOADING
  return summary && !summary.archived && !summary.deletedAt ? summary : undefined
}
/** Explicit attachment wins. Checkout candidates are reached through the
 * schema's existing inverse buckets, never a scan or a separate ownership map.
 * These are the same exact slash boundaries the old pane tested. */
export function paneStampIssue(pool: MobxPool, session: SessionView | undefined): Loaded<PaneIssue> {
  if (!session) return undefined
  if (session.issueId) {
    const attached = eligibleIssue(pool, session.issueId)
    if (attached === LOADING) return LOADING
    if (attached) return pool.row('issue', session.issueId) as Loaded<PaneIssue>
  }
  const paths = machinePathSeparator(session.cwd) === '\\' ? machinePathAncestors(session.cwd) : [session.cwd]
  if (machinePathSeparator(session.cwd) === '/') for (let at = session.cwd.lastIndexOf('/'); at >= 0; at = session.cwd.lastIndexOf('/', at - 1)) {
    paths.push(session.cwd.slice(0, at))
    if (at === 0) break
  }
  for (const path of paths) {
    for (const id of pool.relations.many('worktree', path, 'issues')) {
      const candidate = eligibleIssue(pool, id)
      if (candidate === LOADING) return LOADING
      if (candidate) return pool.row('issue', id) as Loaded<PaneIssue>
    }
  }
  return undefined
}
export function paneIssueColor(pool: MobxPool, id: string | null, hex: (color: string | null | undefined) => string | undefined): Loaded<string> {
  if (!id) return undefined
  const selected = eligibleIssue(pool, id)
  if (!selected || selected === LOADING) return selected
  const seen = new Set<string>()
  let row: Loaded<PaneIssue> = selected
  while (row && row !== LOADING) {
    const own = hex(row.color)
    if (own) return own
    if (!row.parentId || seen.has(row.parentId)) return undefined
    seen.add(row.parentId)
    row = pool.row('issue', row.parentId, 'summary') as Loaded<PaneIssue>
  }
  return row === LOADING ? LOADING : undefined
}

const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = { panelMode: {}, dockShells: {}, reposLoaded: false }
/** Runtime implementations stay in the lazily imported pool. Web hooks import
 * only this API's types, so a legacy startup loads no graph/MobX implementation. */
export function createSessionPaneReader(pool: MobxPool) {
  const session = (id: string | undefined) => {
    const row = paneSession(pool, id)
    return row === LOADING ? undefined : row
  }
  const window = () => {
    const value = paneWindow(pool)
    return !value || value === LOADING ? EMPTY_WINDOW : value
  }
  return {
    session, window,
    machines: () => paneMachines(pool),
    spawnConfirmed: (id: string) => paneSpawnConfirmed(pool, id),
    dock(cwd: string, pending: string | null) {
      const controls = window()
      const mapped = controls.dockShells[cwd]
      const row = paneSession(pool, mapped)
      const pendingRow = paneSession(pool, pending ?? undefined)
      return { mapped, session: row === LOADING ? undefined : row,
        pendingPresent: !!pendingRow && pendingRow !== LOADING,
        hasSessions: paneHasSessions(pool), reposLoaded: controls.reposLoaded, loading: row === LOADING }
    },
    ownership(row: SessionView | undefined, hex: (color: string | null | undefined) => string | undefined) {
      const selected = pool.selection.keys().next().value
      const selectedIssueId = selected === undefined ? null : asIssueId(selected)
      const stamp = paneStampIssue(pool, row), color = paneIssueColor(pool, selectedIssueId, hex)
      return { selectedIssueId, stampIssue: stamp === LOADING ? undefined : stamp, issueHex: color === LOADING ? undefined : color }
    },
  }
}

/** Shared service view, owned by the screen rather than the core pool. */
export function sessionPaneView(pool: MobxPool): ReturnType<typeof createSessionPaneReader> {
  return pool.sources.view('sessionPanes', () => createSessionPaneReader(pool))
}
