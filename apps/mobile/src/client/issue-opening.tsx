import { createIssuePageViews, type IssuePageViews } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import { createContext, useContext, type ReactNode } from 'react'
import { useMobilePool } from './mobile-pool'

const IssueOpeningContext = createContext<IssuePageViews | null>(null)

export function IssueOpening({
  children,
  pool: suppliedPool,
  open = true,
}: {
  children: ReactNode
  pool?: MobxPool | null
  open?: boolean
}) {
  const attached = useMobilePool()
  const views = useOpeningView(
    suppliedPool === undefined ? attached : suppliedPool,
    createIssuePageViews,
    open,
  )
  return <IssueOpeningContext.Provider value={views}>{children}</IssueOpeningContext.Provider>
}

export function useIssueOpening() {
  return useContext(IssueOpeningContext)
}
