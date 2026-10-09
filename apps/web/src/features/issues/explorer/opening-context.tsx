import { createExplorerViews, type ExplorerViews } from '@podium/client-graph/issue-board-cards'
import { useOpeningView } from '@podium/client-graph/react'
import { createContext, useContext } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'

export const ExplorerViewsContext = createContext<ExplorerViews | null>(null)

/** The dock shares one companion owner across its list frames. A standalone
 * fallback list owns its own opening, including every row it draws. */
export function useExplorerViews() {
  const inherited = useContext(ExplorerViewsContext)
  const pool = useWorklistPool()
  const own = useOpeningView(pool, createExplorerViews, !inherited)
  return inherited ?? own
}
