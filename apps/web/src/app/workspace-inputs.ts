import type { SessionView } from '@podium/client-core/session-values'
import { allTabIds, orphanSessionFor } from '@podium/client-core/values'
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
    const summary = pool.row('session', id, 'summary-fields')
    if (!summary || typeof summary === 'symbol') return []
    const detail = fullIds.has(id) ? pool.row('session', id) : undefined
    return [(detail && typeof detail !== 'symbol' ? detail : summary) as SessionView]
  })
}

/** Only the missing-worktree fallback needs source-order discovery. Keeping
 * it in the fallback's own subscription leaves normal issue switches addressed. */
export function readOrphanWorkspaceSession(
  pool: MobxPool,
  selectedWorktree: string | null,
  paneA: string | null,
): SessionView | null {
  if (!selectedWorktree) return null
  const ids = pool.queries.ids({ kind: 'shellSessions' }).sort((a, b) => {
    const left = pool.queries.orderKey(a),
      right = pool.queries.orderKey(b)
    return left < right ? -1 : left > right ? 1 : a.localeCompare(b)
  })
  return orphanSessionFor({
    selectedWorktree,
    paneA,
    sessions: workspaceSessions(pool, new Set(), ids),
  })
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
