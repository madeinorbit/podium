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
