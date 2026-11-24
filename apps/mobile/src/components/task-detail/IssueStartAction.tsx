import type { IssueViewModel } from '@podium/client-core/replica'
import { isFinished } from '@podium/model/browser'
import { issueObserver as observer } from '../../client/issue-observer'
import { useMobilePool } from '../../client/mobile-pool'
import { DetailPrimaryRow } from './DetailList'

/** The same visibility gate LaunchBox reads. The existing native launch sheet
 * owns agent settings, validation and the shared start command. */
export const IssueStartAction = observer(function IssueStartAction({
  issue,
  onStart,
}: {
  issue: IssueViewModel
  onStart: () => void
}) {
  const pool = useMobilePool()
  if (!pool || isFinished(issue) || issue.archived || issue.deletedAt) return null
  if (pool.issueObject(issue.id).workBegun) return null
  return (
    <DetailPrimaryRow
      label="Start with agent"
      systemImage="play.fill"
      onPress={onStart}
      testID="issue-start-agent"
    />
  )
})
