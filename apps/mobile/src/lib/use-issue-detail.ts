import type { IssueViewModel } from '@podium/client-core/replica'
import { IssueHistoryView, issueActivity } from '@podium/client-graph/issue-activity'
import { useLayoutEffect, useMemo } from 'react'
import { useTrpc } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
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
  // Start the shared loading state before the first native frame can paint an
  // empty feed. The view, rather than a phone-only flag, owns its readiness.
  useLayoutEffect(() => view?.open(), [view])
  return view
}
