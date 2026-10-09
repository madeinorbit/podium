import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback, useMemo } from 'react'
import { useWorklistPoolProjection } from './store-worklist-pool'
import { coordinatorsOf, fieldOf, hasAnyTaskOf, issueOf, onScreenOf, rootOf } from './workspace-mission-reads'

/**
 * Which mission and issue the workspace is about, as ids and scalars. The
 * workspace reads each one separately, so an edit to a member's title or
 * stage does not redraw the workspace.
 */
export function useWorkspaceMission(selectedId: string | null, focusedId: string | null) {
  const readRoot = useCallback((pool: MobxPool) => rootOf(pool, selectedId), [selectedId])
  const readIssue = useCallback((pool: MobxPool) => issueOf(pool, selectedId, focusedId), [selectedId, focusedId])
  const readCoordinators = useCallback((pool: MobxPool) => coordinatorsOf(pool, selectedId), [selectedId])
  const readOnScreen = useCallback((pool: MobxPool) => onScreenOf(pool, selectedId), [selectedId])
  const readHasAnyTask = useCallback((pool: MobxPool) => hasAnyTaskOf(pool), [])
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
