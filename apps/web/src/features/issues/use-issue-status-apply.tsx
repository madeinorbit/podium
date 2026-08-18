import { parseIssueStatusValue } from '@podium/model/browser'
import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
import { IssueCloseDialog, type IssueCloseReason } from './issue-lifecycle'

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

  // Stable across renders: the flight deck's rows are memoized, and a fresh
  // closure per render would re-render every strip in the column on every store
  // tick just to hand them a function that does the same thing.
  const pick = useCallback(
    (issue: IssueViewModel, value: string): void => {
      const intent = parseIssueStatusValue(value)
      if (!intent) return
      if (intent.kind === 'close') {
        setPending({ issue, reason: intent.reason })
        return
      }
      updateIssue(issue.id, { stage: intent.stage }).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    [updateIssue],
  )

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
