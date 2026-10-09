/** The workspace's mission answers, as ids and scalars (no React). */
import type { MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { missionView, settled } from '@podium/client-graph/mission-view'
import { settingsHasFirstTask } from '@podium/client-graph/settings-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'

type Loaded<T> = T | typeof LOADING

/** The mission the selection belongs to, when the selected issue is visible. */
export function rootOf(pool: MobxPool, selectedId: string | null): Loaded<string | undefined> {
  if (!selectedId) return undefined
  const row = pool.row('issue', selectedId)
  if (row === LOADING) return LOADING
  if (!row) return undefined
  const visible = settled(() => pool.issueObject(selectedId).visible)
  if (visible === LOADING) return LOADING
  if (!visible) return undefined
  const rootId = missionView(pool).rootFor(selectedId)
  if (rootId === LOADING) return LOADING
  if (!rootId) return undefined
  const root = pool.row('issue', rootId)
  return root === LOADING ? LOADING : root ? rootId : undefined
}

/** The workspace's issue: the focused mission member, else the mission root. */
export function issueOf(pool: MobxPool, selectedId: string | null, focusedId: string | null): Loaded<string | undefined> {
  const rootId = rootOf(pool, selectedId)
  if (rootId === LOADING || !rootId) return rootId
  if (!focusedId) return rootId
  const members = missions(pool).members(rootId)
  if (members === LOADING) return LOADING
  if (!members.has(focusedId)) return rootId
  const focused = pool.row('issue', focusedId)
  return focused === LOADING ? LOADING : focused ? focusedId : rootId
}

/** The mission's designated coordinator sessions, as one stable key. */
export function coordinatorsOf(pool: MobxPool, selectedId: string | null): Loaded<string> {
  const rootId = rootOf(pool, selectedId)
  if (rootId === LOADING) return LOADING
  if (!rootId) return ''
  const members = missions(pool).members(rootId)
  if (members === LOADING) return LOADING
  const ids = new Set<string>()
  let pending = false
  for (const id of members) {
    const coordinator = settled(() => pool.issueObject(id).coordinatorSessionId)
    if (coordinator === LOADING) pending = true
    else if (typeof coordinator === 'string') ids.add(coordinator)
  }
  return pending ? LOADING : [...ids].sort().join('\n')
}

/** One stored field of the workspace's issue. */
export function fieldOf(pool: MobxPool, id: string | undefined, field: 'worktreePath' | 'repoPath'): string | null {
  if (!id) return null
  const value = settled(() => pool.issueObject(id)[field])
  return typeof value === 'string' ? value : null
}

/** Whether the selection opens a mission on screen. */
export function onScreenOf(pool: MobxPool, selectedId: string | null): Loaded<boolean> {
  const root = missionView(pool).selectedRoot(selectedId)
  return root === LOADING ? LOADING : root !== undefined
}

export { settingsHasFirstTask as hasAnyTaskOf }
