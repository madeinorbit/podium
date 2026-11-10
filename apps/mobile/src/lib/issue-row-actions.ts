import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/values'
import { parseIssueStatusValue } from '@podium/model'
import { useCallback } from 'react'
import { useStoreActions } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
import { useIssueCloseGuard } from '../client/use-issue-close'
import type { WorkMenuSheet } from '../components/WorkIssueMenu'
import type { WorkMenuActionId } from './work-menu'

/**
 * What a task row's native menu, swipe and status picker DO: one dispatch for
 * every list that offers Work's row acts. Direct acts (read state, placement,
 * a status change, a clean close) write through the store; the ones that need
 * a sheet (rename, delete, a guarded close) hand back to the caller's
 * `WorkIssueMenu` with the sheet to open.
 */
export function useIssueRowActions({
  openMenu,
  onError,
}: {
  openMenu: (id: string, sheet: WorkMenuSheet) => void
  onError: (message: string) => void
}) {
  const store = useStoreActions()
  const pool = useMobilePool()
  const hasCloseBlockers = useIssueCloseGuard()
  const run = useCallback(
    (action: Promise<unknown>) =>
      void action.catch((error) => onError(error instanceof Error ? error.message : String(error))),
    [onError],
  )
  const onAction = useCallback(
    (id: string, action: WorkMenuActionId) => {
      if (!pool) return
      const issue = pool.issueObject(id) as unknown as IssueNavigationModel
      if (action === 'read') run(issue.unread ? store.markIssueRead(id) : store.markIssueUnread(id))
      else if (action === 'undefer') run(store.undeferIssue(id))
      else if (action === 'bringBack') run(store.setIssueTucked(id, false))
      else if (action === 'placement') {
        const placement = discoveredPlacement(issue)
        if (placement?.originId)
          run(
            store.setIssuePlacement(
              id,
              placement.placement === 'mission' ? 'own' : 'mission',
              placement.originId,
            ),
          )
      } else openMenu(id, { kind: action === 'delete' ? 'confirm-delete' : action })
    },
    [openMenu, pool, run, store],
  )
  /** A status menu value (`issueStatusMenuEntries`): a stage move, or an ending. */
  const onStatus = useCallback(
    (id: string, value: string) => {
      const intent = parseIssueStatusValue(value)
      if (!intent) return
      if (intent.kind === 'stage') run(store.updateIssue(id, { stage: intent.stage }))
      else if (hasCloseBlockers(id)) openMenu(id, { kind: 'confirm-close', reason: intent.reason })
      else run(store.closeIssue(id, intent.reason))
    },
    [hasCloseBlockers, openMenu, run, store],
  )
  /** The swipe's Close: the Done ending, through the same guard. */
  const onClose = useCallback((id: string) => onStatus(id, 'close:done'), [onStatus])
  return { onAction, onStatus, onClose }
}
