import type { IssueViewModel } from '@podium/client-core/replica'
import { IssueHistoryView, issueActivity } from '@podium/client-graph/issue-activity'
import { useEffect, useMemo } from 'react'
import { useMobilePool } from '../client/mobile-pool'
import { useTrpc } from '../client/hooks'
import { loadIssueComments, loadIssueEventsPage, loadIssueMail } from './issue-detail'

/** One opening of a history view over the issue's shared history (full page
 *  and inspector share it), asking for the `window` event lines it shows (0 for
 *  mail alone). */
export function useIssueActivity(issue: IssueViewModel, window: number) {
  const pool = useMobilePool(),
    trpc = useTrpc()
  const view = useMemo(
    () =>
      pool
        ? new IssueHistoryView(
            issueActivity(pool, issue.id),
            {
              comments: (id) => loadIssueComments(trpc, id),
              mail: (id) => loadIssueMail(trpc, id),
              events: (input) => loadIssueEventsPage(trpc, input),
            },
            window,
          )
        : undefined,
    [pool, issue.id, trpc, window],
  )
  useEffect(() => view?.open(), [view])
  return view
}
