import { useUiValue } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { allTabIds } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { omitGone } from '@podium/client-graph/lookup'
import { useCallback } from 'react'
import { useRuntimeActions, useRuntimeList } from './keyed-runtime'
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
const EMPTY_INPUTS = { sessions: EMPTY_SESSIONS, pendingIssueHasSession: false }

/** Tabs and previously visited sessions are the only workspace consumers.
 * Reading their identities directly avoids rebuilding the whole session
 * catalogue on every layout change. Resume collapse still belongs to the source. */
export function workspaceSessions(
  pool: MobxPool,
  fullIds: ReadonlySet<string>,
  retainedIds: readonly string[] = [],
): SessionView[] {
  return [...new Set([...fullIds, ...retainedIds])].flatMap((id) => {
    if (pool.queries.collapsed(id)) return []
    // Known cold tabs still demand their full row before summary fields arrive.
    // Addressed presence excludes file ids without delaying the load request.
    const present = fullIds.has(id) ? omitGone(pool.row('session', id, 'mark')) : undefined
    if (fullIds.has(id) && !present) return []
    const detail = fullIds.has(id) ? omitGone(pool.row('session', id)) : undefined
    const row =
      detail && typeof detail !== 'symbol'
        ? detail
        : omitGone(pool.row('session', id, 'summary-fields'))
    return row && typeof row !== 'symbol' ? [row as unknown as SessionView] : []
  })
}

/** The missing-worktree fallback asks the maintained path index for one winner.
 * It never loads a session catalogue to choose the single pane it displays. */
export function readOrphanWorkspaceSession(
  pool: MobxPool,
  selectedWorktree: string | null,
  paneA: string | null,
): SessionView | null {
  if (!selectedWorktree) return null
  const id = pool.queries.workspaceSessionWithin(selectedWorktree, paneA)
  return id ? (workspaceSessions(pool, new Set(), [id])[0] ?? null) : null
}

export function useOrphanWorkspaceSession(selectedWorktree: string | null, paneA: string | null) {
  const read = useCallback(
    (pool: MobxPool) => readOrphanWorkspaceSession(pool, selectedWorktree, paneA),
    [selectedWorktree, paneA],
  )
  return useWorklistPoolProjection(read, null)
}

export function pendingWorkspaceIssueHasSession(pool: MobxPool, issueId: string): boolean {
  return (
    issueId !== '' &&
    pool.queries
      .ids({ kind: 'commandIssueSessions', issueId, includeShells: true })
      .some((id) => !pool.queries.collapsed(id))
  )
}

export function useWorkspaceInputs(retainedIds: readonly string[] = [], pendingIssueId = '') {
  const actions = useRuntimeActions(ACTIONS)
  const selectedWorktree = useUiValue('selectedWorktree')
  const paneA = useUiValue('paneA')
  const selectedIssueId = useUiValue('selectedIssueId')
  const dockShells = useUiValue('dockShells')
  const workspaces = useUiValue('workspaces')
  const fileTabs = useUiValue('fileTabList')
  const repos = useRuntimeList('repos')
  const workspaceKey = useUiValue('workspaceKeyValue')
  const workspaceLoading = useUiValue('workspaceLoading')
  const layout = workspaceLoading ? undefined : workspaces[workspaceKey]
  const read = useCallback(
    (pool: MobxPool) => ({
      sessions: workspaceSessions(
        pool,
        new Set([...(layout ? allTabIds(layout) : []), ...(paneA ? [paneA] : [])]),
        retainedIds,
      ),
      pendingIssueHasSession: pendingWorkspaceIssueHasSession(pool, pendingIssueId),
    }),
    [layout, paneA, retainedIds, pendingIssueId],
  )
  const inputs = useWorklistPoolProjection(read, EMPTY_INPUTS)
  return {
    ...actions,
    ...inputs,
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
