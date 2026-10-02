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
  // The provider is fixed for this mounted component tree, like the startup switch.
  if (value) return value.data.issues
  if (world) return world.issues
  return useReplicaIssues()
}
export function useIssuePageSessions(): SessionView[] {
  const value = useIssuePageData()
  const world = useContext(IssuePageWorldContext)
  if (value) return value.data.sessions
  if (world) return world.sessions
  return useStoreSelector(store => store.sessions) ?? []
}
