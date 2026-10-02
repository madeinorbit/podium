import type { SessionView } from '@podium/client-core/session-values'
import type { IssuePageData, IssuePageViews } from '@podium/client-graph/issue-page'
import { createContext, useContext } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import type { IssueViewModel } from '@podium/client-core/replica'

/** One page read owner. Nested controls reuse its pool values; controls on
 * other screens keep their existing data subscriptions. */
export const IssuePageDataContext = createContext<{ data: IssuePageData; views: IssuePageViews } | null>(null)
export const IssuePageWorldContext = createContext<{ issues: IssueViewModel[]; sessions: SessionView[] } | null>(null)
export function useIssuePageData() { return useContext(IssuePageDataContext) }

export function useIssuePageIssues() {
  const value = useIssuePageData()
  const world = useContext(IssuePageWorldContext)
  // PoolIssuePage/PoolIssuePanelView and the explorer choose this provider at
  // their mounting boundary; it cannot appear or disappear within a mounted
  // legacy reader. Keep the legacy addressed subscription exactly as before.
  if (value) return value.data.issues
  if (world) return world.issues
  // biome-ignore lint/correctness/useHookAtTopLevel: the mounting boundary fixes this branch; the pool body unmounts before its provider disappears.
  return useReplicaIssues()
}
export function useIssuePageSessions(): SessionView[] {
  const value = useIssuePageData()
  const world = useContext(IssuePageWorldContext)
  const provided = value?.data.sessions ?? world?.sessions
  return useStoreSelector(store => provided ?? store.sessions) ?? []
}
