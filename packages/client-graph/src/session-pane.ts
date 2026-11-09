import type { SessionView } from '@podium/client-core/session-values'
import type { MachineFacts } from '@podium/model/browser'
import { headerView } from './header-views'
import { here, omitGone } from './lookup'
import type { MobxPool } from './pool'
import type { SessionPaneRows } from './session-pane-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export function paneSession(pool: MobxPool, id: string | undefined): Loaded<SessionView> {
  return id === undefined ? undefined : (omitGone(pool.row('session', id)) as Loaded<SessionView>)
}
export function paneWindow(pool: MobxPool): Loaded<SessionPaneRows['sessionPaneWindow']> {
  return omitGone(pool.row('sessionPaneWindow', 'window'))
}
/** My fleet's machine models: online is the LiveStore's (POD-6644). */
export function paneMachines(pool: MobxPool): MachineFacts[] {
  return headerView(pool).machines()
}
/**
 * The machine a move still on its way is taking this session to, by name
 * (POD-6422): from its `session.handoff` record, so the pane shows the move from
 * the press, before the server paints its own overlay (`handoffTarget`).
 */
export function paneHandingOffTo(pool: MobxPool, id: string): string | undefined {
  const machineId = pool.sessionObject(id).handingOffTo
  if (machineId === undefined) return undefined
  const machine = here(pool.model('machine', machineId))
  return machine?.name || machineId
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
  branch?: string | null
  gitState?: import('@podium/client-core/replica').IssueViewModel['gitState']
}
export function eligiblePaneIssue(pool: MobxPool, id: string): Loaded<PaneIssue> {
  // An unknown ID has no summary yet; its addressed read requests the batch.
  // Removed and failed-load answers remain gone and never restart that load.
  const summary = (omitGone(pool.row('issue', id, 'summary')) ??
    omitGone(pool.row('issue', id))) as Loaded<PaneIssue>
  if (summary === LOADING) return LOADING
  return summary && !summary.archived && !summary.deletedAt ? summary : undefined
}
export function loadedPaneSession(pool: MobxPool, id: string | undefined): SessionView | undefined {
  const row = paneSession(pool, id)
  return row === LOADING ? undefined : row
}
