import { createIssuePageViews, type IssuePageViews } from '@podium/client-graph/issue-page'
import { useOpeningView } from '@podium/client-graph/react'
import { createContext, useContext } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'

export const IssueViewsContext = createContext<IssuePageViews | null>(null)

/** Detail roots provide their opening to every nested section. Standalone
 * menus own a smaller opening until their visible choices close. */
export function useIssueViews(open = true) {
  const inherited = useContext(IssueViewsContext)
  const pool = useWorklistPool()
  const own = useOpeningView(pool, createIssuePageViews, !inherited && open)
  return inherited ?? own
}
