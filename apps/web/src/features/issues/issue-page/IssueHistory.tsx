import { issueObserver as observer } from '@podium/client-graph/issue-observer'
import { issueActivity } from '@podium/client-graph/issue-activity'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { useRuntimeSelector, type IssueViewModel } from '@/app/store'
import { loadIssueComments, loadIssueEventsPage, loadIssueMail, type IssuePageCommands } from '../issue-page-commands'
import { CommentComposer, IssueActivitySection, MailSection } from './IssueActivity'

export function useIssueHistory(issue: IssueViewModel) {
  const pool = useWorklistPool()
  const trpc = useRuntimeSelector(store => store.trpc)
  const activity = useMemo(() => pool ? issueActivity(pool, issue.id) : undefined, [pool, issue.id])
  useSyncExternalStore(activity?.subscribe ?? noSubscribe, activity?.getSnapshot ?? emptyVersion)
  useEffect(() => activity?.retain({ comments: id => loadIssueComments(trpc, id),
    mail: id => loadIssueMail(trpc, id), events: input => loadIssueEventsPage(trpc, input) }), [activity, trpc])
  return activity
}
const noSubscribe = () => () => {}
const emptyVersion = () => 0
const emptyFeed: import('@podium/client-core/values').ActivityItem[] = []
const emptyMail: import('../issue-page-commands').IssueMailMessage[] = []
export const PageMail = observer(function PageMail({ issue }: { issue: IssueViewModel }) {
  const history = useIssueHistory(issue)
  return <MailSection mail={history?.mail ?? emptyMail} />
})
export const PageTimeline = observer(function PageTimeline({ issue, busy, commands }: { issue: IssueViewModel; busy: boolean; commands: IssuePageCommands }) {
  const history = useIssueHistory(issue)
  return <IssueActivitySection issue={issue} busy={busy} commands={commands} feed={history?.history.items ?? emptyFeed} revision={history?.getSnapshot() ?? 0} />
})
export const PageComment = observer(function PageComment({ issue, busy, commands }: { issue: IssueViewModel; busy: boolean; commands: IssuePageCommands }) {
  const pool = useWorklistPool()
  const [body, setBody] = useState('')
  useEffect(() => setBody(''), [issue.id])
  const post = () => {
    const text = body.trim()
    if (!text) return
    commands.postComment(text, posted => {
      if (pool) issueActivity(pool, issue.id).appendComment(posted)
      setBody('')
    })
  }
  return <CommentComposer issueId={issue.id} busy={busy} value={body} onChange={setBody} onPost={post} />
})
