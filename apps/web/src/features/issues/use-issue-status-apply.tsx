import { parseIssueStatusValue } from '@podium/model/browser'
import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
import { IssueCloseDialog, type IssueCloseReason, useIssueCloseGuard } from './issue-lifecycle'

/**
 * THE HOST HALF OF {@link IssueStatusPicker} — one issue, one picked value, the
 * mutation it stands for.
 *
 * Applying a status is two different mutations wearing one menu (POD-1074): the
 * open lanes are a stage patch, the endings are a CLOSE with a reason, and a
 * close has to pass the shared guard so standing offers and unfinished children
 * are named before the work is called finished. Every surface that grew a
 * clickable glyph needs both arms; none of them should spell the fork itself,
 * which is exactly how "Close: wontfix" once ended up written four ways.
 *
 * THE GUARD IS RAISED ONLY WHEN IT HAS SOMETHING TO SAY (POD-1278). A dialog
 * that rises to report "nothing found" is a tax on the most ordinary ending
 * there is — and this surface is the one where that would hurt most, since
 * picking Done off a row is meant to be the fast way to finish a task.
 *
 * THE DIALOG IS RETURNED, NOT MOUNTED HERE. A hook cannot render, and the guard
 * has to hang off the host rather than off the row — rows in these lists are
 * virtualized, and a dialog owned by a row that scrolls out of the window goes
 * with it. Hosts mount `dialog` once, beside their list; it is `null` until
 * something is actually pending, so a list of 140 rows costs nothing for it.
 */
export interface IssueStatusApply {
  /** Apply one picked value to one issue. */
  pick: (issue: IssueViewModel, value: string) => void
  /** Mount this once in the host. `null` while no close is pending. */
  dialog: JSX.Element | null
}

export function useIssueStatusApply(): IssueStatusApply {
  const updateIssue = useStoreSelector((store) => store.updateIssue)
  const closeIssue = useStoreSelector((store) => store.closeIssue)
  const needsCloseGuard = useIssueCloseGuard()
  // The ISSUE is held with the reason, not just its id: these lists repaint
  // under the open dialog, and the guard reads the row it was opened for.
  const [pending, setPending] = useState<{
    issue: IssueViewModel
    reason: IssueCloseReason
  } | null>(null)
  const [closing, setClosing] = useState(false)

  const fail = (error: unknown): void => {
    toast.error(error instanceof Error ? error.message : String(error))
  }

  const pick = (issue: IssueViewModel, value: string): void => {
    const intent = parseIssueStatusValue(value)
    if (!intent) return
    if (intent.kind === 'close') {
      if (needsCloseGuard(issue)) {
        setPending({ issue, reason: intent.reason })
        return
      }
      closeIssue(issue.id, intent.reason).catch(fail)
      return
    }
    updateIssue(issue.id, { stage: intent.stage }).catch(fail)
  }

  const dialog = pending ? (
    <IssueCloseDialog
      issue={pending.issue}
      reason={pending.reason}
      busy={closing}
      onOpenChange={(open) => {
        if (!open) setPending(null)
      }}
      onConfirm={(reason) => {
        setClosing(true)
        closeIssue(pending.issue.id, reason)
          .then(() => setPending(null))
          .catch(fail)
          .finally(() => setClosing(false))
      }}
    />
  ) : null

  return { pick, dialog }
}
