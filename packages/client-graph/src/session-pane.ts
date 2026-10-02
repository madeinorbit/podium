import type { SessionView } from '@podium/client-core/session-values'
import type { MachineWire } from '@podium/model/browser'
import type { MobxPool } from './pool'
import { headerIds } from './enumerate'
import { LOADING, type Loaded } from './worklist/rollup'
import type { SessionPaneRows } from './session-pane-schema'

export function paneSession(pool: MobxPool, id: string | undefined): Loaded<SessionView> {
  return id === undefined ? undefined : pool.row('session', id) as Loaded<SessionView>
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
  return pool.tables.session.size > 0 || (pool.residency?.ids('session', true).length ?? 0) > 0
}
export function paneSpawnConfirmed(pool: MobxPool, id: string): boolean {
  const window = paneWindow(pool)
  return !!window && window !== LOADING && !window.pendingSpawnIds.has(id as SessionView['sessionId'])
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
  const paths = [session.cwd]
  for (let at = session.cwd.lastIndexOf('/'); at >= 0; at = session.cwd.lastIndexOf('/', at - 1)) {
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
