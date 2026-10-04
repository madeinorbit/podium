import type { SessionView } from '@podium/client-core/session-values'
import { allTabIds } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { useCallback } from 'react'
import { useRuntimeActions, useRuntimeList, useRuntimeLocal } from './keyed-runtime'
import { useWorklistPoolProjection } from './store-worklist-pool'

const ACTIONS = [
  'closeFileTab',
  'markSessionRead',
  'workspaceKey',
  'openSessionTab',
  'promoteWorkspaceTab',
  'activateWorkspaceTab',
  'closeWorkspaceTab',
  'moveWorkspaceTab',
  'splitWorkspacePane',
  'closeWorkspacePane',
  'focusWorkspacePane',
  'resizeWorkspaceSplit',
] as const
const EMPTY_SESSIONS: SessionView[] = []

/** The existing source query preserves resume collapse and source order. Only
 * the current tabs demand full rows; the warm/orphan universe uses summaries. */
export function workspaceSessions(pool: MobxPool, fullIds: ReadonlySet<string>): SessionView[] {
  const ids = pool.queries
    .ids({ kind: 'shellSessions' })
    .filter((id) => !pool.queries.collapsed(id))
    .sort((a, b) => {
      const left = pool.queries.orderKey(a),
        right = pool.queries.orderKey(b)
      return left < right ? -1 : left > right ? 1 : a.localeCompare(b)
    })
  return ids.flatMap((id) => {
    const detail = fullIds.has(id) ? pool.row('session', id) : undefined
    const row =
      detail && typeof detail !== 'symbol' ? detail : pool.row('session', id, 'summary-fields')
    return row && typeof row !== 'symbol' ? [row as SessionView] : []
  })
}

export function useWorkspaceInputs() {
  const actions = useRuntimeActions(ACTIONS)
  const selectedWorktree = useRuntimeLocal('selectedWorktree')
  const paneA = useRuntimeLocal('paneA')
  const selectedIssueId = useRuntimeLocal('selectedIssueId')
  const dockShells = useRuntimeLocal('dockShells')
  const workspaces = useRuntimeLocal('workspaces')
  const fileTabs = useRuntimeList('fileTabs')
  const repos = useRuntimeList('repos')
  // Use the engine's resolver, including its pool navigation provider.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed selection changes invalidate the stable engine resolver.
  const keyRead = useCallback(
    () => actions.workspaceKey(),
    [actions, selectedIssueId, selectedWorktree],
  )
  const workspaceKey = useWorklistPoolProjection(
    keyRead,
    'none' as ReturnType<typeof actions.workspaceKey>,
  )
  const layout = workspaces[workspaceKey]
  const read = useCallback(
    (pool: MobxPool) =>
      workspaceSessions(
        pool,
        new Set([...(layout ? allTabIds(layout) : []), ...(paneA ? [paneA] : [])]),
      ),
    [layout, paneA],
  )
  const sessions = useWorklistPoolProjection(read, EMPTY_SESSIONS)
  return {
    ...actions,
    sessions,
    selectedWorktree,
    paneA,
    fileTabs,
    repos,
    selectedIssueId,
    dockShells,
    workspaces,
    workspaceKey,
  }
}
