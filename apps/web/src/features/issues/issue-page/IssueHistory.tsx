import { issueObserver as observer } from './issue-observer'
import {
  ISSUE_HISTORY_PAGE,
  IssueHistoryView,
  issueActivity,
} from '@podium/client-graph/issue-activity'
import { useEffect, useMemo, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { useRuntimeSelector, type IssueViewModel } from '@/app/store'
import {
  loadIssueComments,
  loadIssueEventsPage,
  loadIssueMail,
  type IssuePageCommands,
} from '../issue-page-commands'
import { CommentComposer, IssueActivitySection, MailSection } from './IssueActivity'

/** One opening of a history view over the issue's shared history, asking for
 *  the `window` event lines it shows (0 for mail alone). */
export function useIssueHistory(issue: IssueViewModel, window: number) {
  const pool = useWorklistPool()
  const trpc = useRuntimeSelector((store) => store.trpc)
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
const emptyFeed: import('@podium/client-core/values').ActivityItem[] = []
const emptyMail: import('../issue-page-commands').IssueMailMessage[] = []
export const PageMail = observer(function PageMail({ issue }: { issue: IssueViewModel }) {
  const history = useIssueHistory(issue, 0)
  return <MailSection mail={history?.activity.mail ?? emptyMail} />
})
export const PageTimeline = observer(function PageTimeline({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
}) {
  const history = useIssueHistory(issue, ISSUE_HISTORY_PAGE)
  return (
    <IssueActivitySection
      issue={issue}
      busy={busy}
      commands={commands}
      feed={history?.activity.history.items ?? emptyFeed}
      revision={history?.activity.revision ?? 0}
      history={history}
    />
  )
})
export const PageComment = observer(function PageComment({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
}) {
  const pool = useWorklistPool()
  const [body, setBody] = useState('')
  useEffect(() => setBody(''), [issue.id])
  const post = () => {
    const text = body.trim()
    if (!text) return
    commands.postComment(text, (posted) => {
      if (pool) issueActivity(pool, issue.id).appendComment(posted)
      setBody('')
    })
  }
  return (
    <CommentComposer issueId={issue.id} busy={busy} value={body} onChange={setBody} onPost={post} />
  )
})
