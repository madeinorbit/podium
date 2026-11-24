import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { IssuePageViews, PageIssue } from '@podium/client-graph/issue-page'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { createContext, useCallback, useContext } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { readIssueSearchChoices } from '../issue-search-choices'
import { useIssueViews } from './opening-context'

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
export function useIssuePageCatalog(
  open: boolean,
  query = '',
  repoPath?: string,
): IssueViewModel[] {
  const views = useIssueViews(open)
  const read = useCallback(
    (pool: MobxPool) =>
      open && views ? readIssueSearchChoices(pool, views, query, repoPath) : EMPTY_ISSUES,
    [open, views, query, repoPath],
  )
  const value = useWorklistPoolProjection(read, EMPTY_ISSUES)
  return value && typeof value !== 'symbol' ? value : EMPTY_ISSUES
}
/** The page issue's active sessions, or LOADING while the device fetches
 *  them (POD-7579). A hook, so it answers rather than throws: the caller
 *  throws LOADING after its own hooks, keeping their order the same on every
 *  render inside an `issueObserver` section. */
export function useIssuePageSessions(): SessionView[] | typeof LOADING {
  const page = useIssuePageContext()
  const world = useContext(IssuePageWorldContext)
  // Outside an issue page there is no issue whose sessions to read; a test
  // world supplies its own. No reader walks every session (POD-7088).
  const sessions = page ? page.views.row(page.issue.id).activeSessions : world?.sessions
  return sessions === LOADING ? LOADING : (sessions ?? EMPTY_SESSIONS)
}
