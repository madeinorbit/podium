import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { type PageIssue, type IssuePageViews } from '@podium/client-graph/issue-page'
import { createContext, useCallback, useContext } from 'react'
import { useIssueViews } from './opening-context'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

/** Nested controls reuse their page's addressed values. Other pool surfaces
 * read the declared catalog; attachment never falls back to a store slice. */
export const IssuePageContext = createContext<{
  issue: PageIssue
  views: IssuePageViews
} | null>(null)
export const IssuePageWorldContext = createContext<{
  issues: IssueViewModel[]
  sessions: SessionView[]
} | null>(null)
export function useIssuePageContext() {
  return useContext(IssuePageContext)
}

const EMPTY_ISSUES: IssueViewModel[] = []
const EMPTY_SESSIONS: SessionView[] = []
/** A closed selector owns no catalog derivation or row subscriptions. */
export function useIssuePageCatalog(open: boolean): IssueViewModel[] {
  const views = useIssueViews(open)
  const read = useCallback(
    (pool: MobxPool) => (open ? views?.issues() : EMPTY_ISSUES),
    [open, views],
  )
  const value = useWorklistPoolProjection(read, EMPTY_ISSUES)
  return value && typeof value !== 'symbol' ? value : EMPTY_ISSUES
}
function usePoolSessions(): SessionView[] {
  const views = useIssueViews()
  const readSessions = useCallback((_pool: MobxPool) => views?.explorer(), [views])
  const value = useWorklistPoolProjection(readSessions, undefined)
  return value && typeof value !== 'symbol' ? value.sessions : EMPTY_SESSIONS
}
export function useIssuePageSessions(): SessionView[] {
  const page = useIssuePageContext()
  const world = useContext(IssuePageWorldContext)
  // biome-ignore lint/correctness/useHookAtTopLevel: Pool page/world bodies unmount before their provider disappears.
  const sessions = page
    ? page.views.row(page.issue.id).activeSessions
    : (world?.sessions ?? usePoolSessions())
  if (sessions === LOADING) throw LOADING
  return sessions ?? EMPTY_SESSIONS
}
