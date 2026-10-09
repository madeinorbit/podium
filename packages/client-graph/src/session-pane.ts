import { here, omitGone } from './lookup'
import type { SessionView } from '@podium/client-core/session-values'
import type { MachineWire } from '@podium/model/browser'
import { headerIds } from './enumerate'
import type { MobxPool } from './pool'
import type { SessionPaneRows } from './session-pane-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export function paneSession(pool: MobxPool, id: string | undefined): Loaded<SessionView> {
  return id === undefined ? undefined : (omitGone(pool.row('session', id)) as Loaded<SessionView>)
}
export function paneWindow(pool: MobxPool): Loaded<SessionPaneRows['sessionPaneWindow']> {
  return omitGone(pool.row('sessionPaneWindow', 'window'))
}
export function paneMachines(pool: MobxPool): MachineWire[] {
  return headerIds(pool, 'machine').flatMap(id => {
    const row = here(pool.row('machine', id)) as MachineWire | undefined
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
export function eligiblePaneIssue(pool: MobxPool, id: string): Loaded<PaneIssue> {
  const summary = omitGone(pool.row('issue', id, 'summary')) as Loaded<PaneIssue>
  if (summary === LOADING) return LOADING
  return summary && !summary.archived && !summary.deletedAt ? summary : undefined
}
export function paneIssueColor(pool: MobxPool, id: string | null, hex: (color: string | null | undefined) => string | undefined): Loaded<string> {
  if (!id) return undefined
  const selected = eligiblePaneIssue(pool, id)
  if (!selected || selected === LOADING) return selected
  const seen = new Set<string>()
  let row: Loaded<PaneIssue> = selected
  while (row && row !== LOADING) {
    const own = hex(row.color)
    if (own) return own
    if (!row.parentId || seen.has(row.parentId)) return undefined
    seen.add(row.parentId)
    row = omitGone(pool.row('issue', row.parentId, 'summary')) as Loaded<PaneIssue>
  }
  return row === LOADING ? LOADING : undefined
}

export function loadedPaneSession(pool: MobxPool, id: string | undefined): SessionView | undefined {
  const row = paneSession(pool, id)
  return row === LOADING ? undefined : row
}
