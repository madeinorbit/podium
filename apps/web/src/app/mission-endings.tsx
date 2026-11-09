import type { Trpc } from '@/app/trpc'
import { useCommands } from '@podium/client-core/react'
import { useUiValue } from '@podium/client-core/react'
import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MissionScreen } from '@podium/client-graph/mission-screen'
import type { SessionModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { IssueCloseDialog, useIssueCloseGuard } from '@/features/issues/issue-lifecycle'
import { useOperatorFocus } from './operator-focus'

/**
 * THE TWO WAYS OUT OF A VACATED TASK, shared by the flight deck and the pane
 * (POD-2043). Going to where the work went, and filing this task away. Both
 * surfaces offer them for the same mission, so they must do the same thing:
 * one implementation, one close guard.
 */
export function useMissionEndings(screen: MissionScreen): {
  openDeparture: (issue: IssueNavigationModel) => void
  tuckResolvedRoot: () => void
  closeReviewedRoot: () => void
  dialog: JSX.Element | null
} {
  const {
    setSelectedWorktree,
    setSelectedIssueId,
    openSessionTab,
    setView,
    markIssueRead,
    markSessionRead,
    setIssueTucked,
    closeIssue,
  } = {
    setSelectedWorktree: useUiValue('setSelectedWorktree'),
    setSelectedIssueId: useUiValue('setSelectedIssueId'),
    openSessionTab: useUiValue('openSessionTab'),
    setView: useUiValue('setView'),
    markIssueRead: useCommands<Trpc>().issues.markRead,
    markSessionRead: useCommands<Trpc>().sessions.markRead,
    setIssueTucked: useCommands<Trpc>().issues.setTucked,
    closeIssue: useCommands<Trpc>().issues.close,
  }
  const { setFocusedIssueId } = useOperatorFocus()
  const rootId = screen.rootId
  /**
   * A departure tick is a way BACK to the work, so it re-roots the deck onto it
   * rather than focusing something this mission no longer contains. Selecting
   * an issue outside `missionMembers` would leave the focus resolver with
   * nothing to resolve and the column showing the same spine.
   *
   * Its tab opens PERMANENT, not as a preview (POD-710): re-rooting the whole
   * deck onto another mission is a deliberate departure from this one, not the
   * glance a preview tab exists to serve.
   */
  const openDeparture = (issue: IssueNavigationModel): void => {
    setSelectedIssueId(issue.id)
    setFocusedIssueId(issue.id)
    void markIssueRead(issue.id)
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    const attached = screen.reader.attached(issue.id)
    const live = (attached === LOADING ? [] : attached)
      .filter((session) => (session as SessionModel).open)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
    if (live) {
      openSessionTab(live.sessionId, { permanent: true })
      void markSessionRead(live.sessionId)
    }
    setView('workspace')
  }
  /**
   * FILING THE SIGNPOST AWAY — recording the ending first when there is one
   * still to record (POD-1212).
   *
   * `issues.setTucked` REFUSES an unfinished issue ("issue … is not finished"),
   * and the sidebar's fold predicate reads the same `closedReason`. So on the
   * mission this card exists for — a hopscotch origin standing at `review`, its
   * work carried on in a spin-off, no session left here — the lone "Tuck away"
   * painted a fold the server threw out and the row came straight back. The
   * unfinished task is therefore closed as `done` and THEN tucked.
   *
   * TWO WRITES, ONE PARTITION. Both are queued outbox kinds routed on
   * `issue:<id>` (wiring.ts), which is what makes the pair safe rather than
   * racy: the close is applied before the tuck reaches the guard that reads it.
   * The `.then` chain is the enqueue order, not a round-trip wait.
   *
   * The guard interrupts only when a close would actually raise something —
   * stranded commits, an open sub-task, a standing decision. POD-1129's rule is
   * that every surface must name the SAME concerns, not that every surface must
   * stop to report none: the button already says what it will do, and a dialog
   * that rises to answer "nothing found" is a tax on the ordinary case.
   */
  // What the confirmed guard runs: the signpost's close-and-tuck, or the
  // review card's plain close (POD-2313), which leaves the finished card to tuck.
  const [closing, setClosing] = useState<'tuck' | 'close' | null>(null)
  const needsCloseGuard = useIssueCloseGuard()
  const closeRoot = (tuck: boolean): void => {
    setClosing(null)
    void closeIssue(rootId, 'done')
      .then(() => (tuck ? setIssueTucked(rootId, true) : undefined))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
  }
  const guardedClose = (tuck: boolean): void => {
    // The same question every close path now asks before raising the guard
    // (POD-1278) — the deck has asked it since POD-1212.
    const rootIssue = screen.reader.issue(rootId)
    if (rootIssue && rootIssue !== LOADING && needsCloseGuard(rootIssue)) {
      setClosing(tuck ? 'tuck' : 'close')
      return
    }
    closeRoot(tuck)
  }
  const tuckResolvedRoot = (): void => {
    if (!screen.continuation && !screen.rootFinished) return
    if (screen.rootFinished) {
      void setIssueTucked(rootId, true)
      return
    }
    guardedClose(true)
  }
  /** A review nobody is on: the user checked it and records it done. */
  const closeReviewedRoot = (): void => guardedClose(false)
  return {
    openDeparture,
    tuckResolvedRoot,
    closeReviewedRoot,
    // The SAME guard every other close path raises (POD-1129), mounted for the
    // one close these surfaces can start: "Done & tuck".
    dialog: closing ? (
      <RootCloseDialog
        screen={screen}
        onOpenChange={(open) => !open && setClosing(null)}
        onConfirm={() => closeRoot(closing === 'tuck')}
      />
    ) : null,
  }
}

const RootCloseDialog = observer(function RootCloseDialog({
  screen,
  onOpenChange,
  onConfirm,
}: {
  screen: MissionScreen
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): JSX.Element | null {
  const issue = screen.reader.issue(screen.rootId)
  if (!issue || issue === LOADING) return null
  return (
    <IssueCloseDialog
      issue={issue}
      sessions={[]}
      reason="done"
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  )
})
