import { issueObserver as observer } from '@podium/client-graph/issue-observer'
import type { IssueViewModel } from '@podium/client-core/replica'
import { issuePages } from '@podium/client-graph/issue-page'
import { useMobilePool } from '../../client/mobile-pool'
import { resolveEdgeFromPool } from '../../client/use-issue-model'
import { useIssueActivity } from '../../lib/use-issue-detail'
import type { IssueCommands } from '../../lib/issue-detail'
import { MailSection, IssueActivitySection } from './IssueActivity'
import { IssueNow } from './IssueNow'
import { IssueProperties } from './IssueProperties'
import { Disclosure } from './chrome'
import type { ComponentProps } from 'react'

export const PhoneMail = observer(function PhoneMail({ issue }: { issue: IssueViewModel }) {
  const activity = useIssueActivity(issue)
  return <MailSection mail={activity.mail} />
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
  const activity = useIssueActivity(issue)
  return (
    <IssueActivitySection
      issue={issue}
      busy={busy}
      commands={commands}
      feed={activity.feed}
      revision={activity.revision}
    />
  )
})
export const PhoneNow = observer(function PhoneNow({
  issue,
  onOpenSession,
}: Pick<ComponentProps<typeof IssueNow>, 'issue' | 'onOpenSession'>) {
  const pool = useMobilePool()
  const sessions = pool ? issuePages(pool).row(issue.id).phoneSessions : []
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
  if (!props.open)
    return (
      <Disclosure label="Details" open={false} onToggle={props.onToggle} testID="issue-details">
        {null}
      </Disclosure>
    )
  const sessions = pool ? issuePages(pool).row(props.issue.id).phoneSessions : []
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
