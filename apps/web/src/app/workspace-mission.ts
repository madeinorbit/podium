import type { MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { missionView, settled } from '@podium/client-graph/mission-view'
import { settingsHasFirstTask } from '@podium/client-graph/settings-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback, useMemo } from 'react'
import { useWorklistPoolProjection } from './store-worklist-pool'

type Loaded<T> = T | typeof LOADING

/** The mission the selection belongs to, when the selected issue is visible. */
function rootOf(pool: MobxPool, selectedId: string | null): Loaded<string | undefined> {
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
function issueOf(pool: MobxPool, selectedId: string | null, focusedId: string | null): Loaded<string | undefined> {
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
function coordinatorsOf(pool: MobxPool, selectedId: string | null): Loaded<string> {
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
function fieldOf(pool: MobxPool, id: string | undefined, field: 'worktreePath' | 'repoPath'): string | null {
  if (!id) return null
  const value = settled(() => pool.issueObject(id)[field])
  return typeof value === 'string' ? value : null
}

/**
 * Which mission and issue the workspace is about, as ids and scalars. The
 * workspace reads each one separately, so an edit to a member's title or
 * stage does not redraw the workspace.
 */
export function useWorkspaceMission(selectedId: string | null, focusedId: string | null) {
  const readRoot = useCallback((pool: MobxPool) => rootOf(pool, selectedId), [selectedId])
  const readIssue = useCallback((pool: MobxPool) => issueOf(pool, selectedId, focusedId), [selectedId, focusedId])
  const readCoordinators = useCallback((pool: MobxPool) => coordinatorsOf(pool, selectedId), [selectedId])
  const readOnScreen = useCallback((pool: MobxPool): Loaded<boolean> => {
    const root = missionView(pool).selectedRoot(selectedId)
    return root === LOADING ? LOADING : root !== undefined
  }, [selectedId])
  const readHasAnyTask = useCallback((pool: MobxPool) => settingsHasFirstTask(pool), [])
  const rootId = useWorklistPoolProjection(readRoot, LOADING)
  const issueId = useWorklistPoolProjection(readIssue, LOADING)
  const coordinators = useWorklistPoolProjection(readCoordinators, LOADING)
  const onScreen = useWorklistPoolProjection(readOnScreen, LOADING)
  const hasAnyTask = useWorklistPoolProjection(readHasAnyTask, LOADING)
  const shownIssueId = issueId === LOADING ? undefined : issueId
  const readWorktree = useCallback((pool: MobxPool) => fieldOf(pool, shownIssueId, 'worktreePath'), [shownIssueId])
  const readRepo = useCallback((pool: MobxPool) => fieldOf(pool, shownIssueId, 'repoPath'), [shownIssueId])
  const worktreePath = useWorklistPoolProjection(readWorktree, null)
  const repoPath = useWorklistPoolProjection(readRepo, null)
  const coordinatorIds = useMemo(
    () => new Set(coordinators === LOADING || !coordinators ? [] : coordinators.split('\n')),
    [coordinators],
  )
  const issue = useMemo(
    () => (shownIssueId ? { id: shownIssueId, worktreePath, repoPath: repoPath ?? '' } : undefined),
    [shownIssueId, worktreePath, repoPath],
  )
  return {
    loading: [rootId, issueId, coordinators, onScreen, hasAnyTask].includes(LOADING),
    rootId: rootId === LOADING ? undefined : rootId,
    issue,
    coordinatorIds,
    onScreen: onScreen === true,
    hasAnyTask: hasAnyTask === true,
  }
}
