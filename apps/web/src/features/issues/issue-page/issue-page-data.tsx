import type { SessionView } from '@podium/client-core/session-values'
import type { IssuePageData, IssuePageViews } from '@podium/client-graph/issue-page'
import { createContext, useContext } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'

/** One page read owner. Nested controls reuse its pool values; controls on
 * other screens keep their existing data subscriptions. */
export const IssuePageDataContext = createContext<{ data: IssuePageData; views: IssuePageViews } | null>(null)
export function useIssuePageData() { return useContext(IssuePageDataContext) }

export function useIssuePageIssues() {
  const value = useIssuePageData()
  // The provider is fixed for this mounted component tree, like the startup switch.
  if (value) return value.data.issues
  return useReplicaIssues()
}
export function useIssuePageSessions(): SessionView[] {
  const value = useIssuePageData()
  if (value) return value.data.sessions
  return useStoreSelector(store => store.sessions) ?? []
}
