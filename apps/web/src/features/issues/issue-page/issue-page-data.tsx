import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import {
  type IssuePageData,
  type IssuePageViews,
  issuePages,
} from '@podium/client-graph/issue-page'
import { createContext, useContext } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

/** Nested controls reuse their page's addressed values. Other pool surfaces
 * read the declared catalog; attachment never falls back to a store slice. */
export const IssuePageDataContext = createContext<{
  data: IssuePageData
  views: IssuePageViews
} | null>(null)
export const IssuePageWorldContext = createContext<{
  issues: IssueViewModel[]
  sessions: SessionView[]
} | null>(null)
export function useIssuePageData() {
  return useContext(IssuePageDataContext)
}

const EMPTY_ISSUES: IssueViewModel[] = []
const EMPTY_SESSIONS: SessionView[] = []
const readIssues = (pool: MobxPool) => issuePages(pool).issues()
const readSessions = (pool: MobxPool) => issuePages(pool).explorer()
function usePoolIssues(): IssueViewModel[] {
  const value = useWorklistPoolProjection(readIssues, undefined)
  return value && typeof value !== 'symbol' ? value : EMPTY_ISSUES
}
function usePoolSessions(): SessionView[] {
  const value = useWorklistPoolProjection(readSessions, undefined)
  return value && typeof value !== 'symbol' ? value.sessions : EMPTY_SESSIONS
}
export function useIssuePageIssues(): IssueViewModel[] {
  const page = useIssuePageData()
  const world = useContext(IssuePageWorldContext)
  // The host fixes the context for this component's lifetime.
  // biome-ignore lint/correctness/useHookAtTopLevel: Pool page/world bodies unmount before their provider disappears.
  return page?.data.issues ?? world?.issues ?? usePoolIssues()
}
export function useIssuePageSessions(): SessionView[] {
  const page = useIssuePageData()
  const world = useContext(IssuePageWorldContext)
  // biome-ignore lint/correctness/useHookAtTopLevel: Pool page/world bodies unmount before their provider disappears.
  return page?.data.sessions ?? world?.sessions ?? usePoolSessions()
}
