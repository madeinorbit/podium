import type { IssueViewModel } from '@podium/client-core/replica'
import { issueActivity } from '@podium/client-graph/issue-activity'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMobilePool } from '../client/mobile-pool'
import { useTrpc } from '../client/hooks'
import { loadIssueComments, loadIssueEventsPage, loadIssueMail } from './issue-detail'

const noSubscribe = () => () => {}
const emptyVersion = () => 0
const emptyFeed: import('@podium/client-core/values').ActivityItem[] = []
const emptyMail: import('./issue-detail').IssueMailMessage[] = []

/** Full page and inspector share the same request-owned ID/order history. */
export function useIssueActivity(issue: IssueViewModel) {
  const pool = useMobilePool(), trpc = useTrpc()
  const activity = useMemo(() => pool ? issueActivity(pool, issue.id) : undefined, [pool, issue.id])
  const revision = useSyncExternalStore(activity?.subscribe ?? noSubscribe, activity?.getSnapshot ?? emptyVersion)
  useEffect(() => activity?.retain({ comments: id => loadIssueComments(trpc, id),
    mail: id => loadIssueMail(trpc, id), events: input => loadIssueEventsPage(trpc, input) }), [activity, trpc])
  return { feed: activity?.history.items ?? emptyFeed, mail: activity?.mail ?? emptyMail, revision,
    appendLocalComment: (body: string) => activity?.appendComment(body) }
}
