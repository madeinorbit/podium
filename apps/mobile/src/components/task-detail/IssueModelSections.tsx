import type { IssueViewModel } from '@podium/client-core/replica'
import { ISSUE_HISTORY_PAGE } from '@podium/client-graph/issue-activity'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { type ComponentProps, useState } from 'react'
import { issueObserver as observer } from '../../client/issue-observer'
import { useIssueOpening } from '../../client/issue-opening'
import { useMobilePool } from '../../client/mobile-pool'
import { resolveEdgeFromPool } from '../../client/use-issue-model'
import type { IssueCommands } from '../../lib/issue-detail'
import { useIssueActivity } from '../../lib/use-issue-detail'
import { Disclosure } from './chrome'
import { IssueActivitySection, MailSection } from './IssueActivity'
import { IssueNow } from './IssueNow'
import { IssueProperties } from './IssueProperties'

const emptyMail: import('../../lib/issue-detail').IssueMailMessage[] = []

export const PhoneMail = observer(function PhoneMail({ issue }: { issue: IssueViewModel }) {
  const history = useIssueActivity(issue, 0)
  const [open, setOpen] = useState(false)
  const mail = history?.activity.mail ?? emptyMail
  if (mail.length === 0) return null
  return (
    <Disclosure
      label="Mail"
      count={String(mail.length)}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      testID="issue-mail-fold"
    >
      <MailSection mail={mail} headless />
    </Disclosure>
  )
})
export const PhoneTimeline = observer(function PhoneTimeline({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssueCommands
}) {
  const history = useIssueActivity(issue, ISSUE_HISTORY_PAGE)
  return (
    <IssueActivitySection
      issue={issue}
      busy={busy}
      commands={commands}
      feed={
        !history || (history.loading && history.activity.history.items.length === 0)
          ? LOADING
          : history.activity.history.items
      }
      revision={history?.activity.revision ?? 0}
      history={history}
    />
  )
})
export const PhoneNow = observer(function PhoneNow({
  issue,
  onOpenSession,
}: Pick<ComponentProps<typeof IssueNow>, 'issue' | 'onOpenSession'>) {
  const views = useIssueOpening()
  const sessions = views ? views.row(issue.id).phoneSessions : []
  if (typeof sessions === 'symbol') throw sessions
  return (
    <IssueNow
      issue={issue}
      sessions={(sessions ?? []).filter((session) => session.agentKind !== 'shell')}
      onOpenSession={onOpenSession}
    />
  )
})

export const PhoneProperties = observer(function PhoneProperties(
  props: Omit<ComponentProps<typeof IssueProperties>, 'sessions' | 'parent' | 'resolveEdge'>,
) {
  const pool = useMobilePool()
  const views = useIssueOpening()
  if (!props.open)
    return (
      <Disclosure label="Details" open={false} onToggle={props.onToggle} testID="issue-details">
        {null}
      </Disclosure>
    )
  const sessions = views ? views.row(props.issue.id).phoneSessions : []
  if (typeof sessions === 'symbol') throw sessions
  const resolveEdge = (id: string | null | undefined) => resolveEdgeFromPool(pool, id)
  const parentEdge = resolveEdge(props.issue.parentId)
  const parent = parentEdge.render === 'issue' ? parentEdge.resolution.value : undefined
  return (
    <IssueProperties
      {...props}
      sessions={sessions ?? []}
      parent={parent}
      resolveEdge={resolveEdge}
    />
  )
})
