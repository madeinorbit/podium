import type { IssueNavigationModel } from '@podium/client-core/values'
import { ISSUE_STATUS_LABELS, type IssueCloseReason } from '@podium/model'

export interface IssueCloseSheetProps {
  issue: IssueNavigationModel
  reason: IssueCloseReason | null
  busy?: boolean
  onConfirm: (reason: IssueCloseReason) => void
  onClose: () => void
}

export function closeTitle(
  reason: IssueCloseReason | null,
  count: number,
  pending: boolean,
): string {
  if (pending) return 'Checking this task…'
  if (count > 0) return 'This task still needs attention'
  return reason && reason !== 'done'
    ? `Close this task as ${ISSUE_STATUS_LABELS[reason].toLowerCase()}?`
    : 'Close this task?'
}

export function closeSubtitle(count: number, pending: boolean): string {
  if (pending) return 'Waiting for the latest task status.'
  return count > 0
    ? 'Closing is still available, but it should be an explicit decision.'
    : 'Nothing unresolved is left on it.'
}

export function closeConfirmLabel(
  reason: IssueCloseReason | null,
  blocked: boolean,
  busy: boolean,
): string {
  if (busy) return 'Closing…'
  if (reason && reason !== 'done') return `Close as ${ISSUE_STATUS_LABELS[reason].toLowerCase()}`
  return blocked ? 'Close anyway' : 'Close task'
}
