import type { IssueWire } from '@podium/protocol'
import { AlertTriangle, GitBranch, GitCommit, MessageCircleQuestion, Users } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { isSessionWorking } from '@/lib/derive'

export type IssueCloseReason = 'done' | 'wontfix'

export interface IssueCloseConcern {
  key: string
  label: string
  detail: string
  blocking: boolean
  icon: 'attention' | 'sessions' | 'children' | 'git'
}

/**
 * Facts that should be visible before an issue is closed. This is deliberately
 * presentation-only: the server remains permissive while the UI makes every
 * issue-owned consequence explicit. Unattributed checkout state is deliberately
 * absent: it belongs to workspace Git surfaces, not an issue close decision.
 */
export function issueCloseConcerns(issue: IssueWire): IssueCloseConcern[] {
  const concerns: IssueCloseConcern[] = []
  const offers = issue.sessions.filter((session) => !session.archived && session.offer)
  if (offers.length > 0) {
    concerns.push({
      key: 'offers',
      label: `${offers.length} pending decision${offers.length === 1 ? '' : 's'}`,
      detail: 'Resolve or explicitly dismiss the agent offer before closing.',
      blocking: true,
      icon: 'attention',
    })
  }
  if (issue.needsHuman) {
    concerns.push({
      key: 'question',
      label: 'Human input is still needed',
      detail: issue.humanQuestion || 'A question or approval is still waiting for a response.',
      blocking: true,
      icon: 'attention',
    })
  }
  const working = issue.sessions.filter((session) => !session.archived && isSessionWorking(session))
  if (working.length > 0) {
    concerns.push({
      key: 'working',
      label: `${working.length} agent${working.length === 1 ? ' is' : 's are'} still working`,
      detail: 'Closing the issue does not silently explain or retire active execution.',
      blocking: true,
      icon: 'sessions',
    })
  }
  const openChildren = Math.max(0, issue.childCount - issue.childDoneCount)
  if (openChildren > 0) {
    concerns.push({
      key: 'children',
      label: `${openChildren} open sub-task${openChildren === 1 ? '' : 's'}`,
      detail: 'The child issues remain open and independently visible.',
      blocking: true,
      icon: 'children',
    })
  }

  const git = issue.gitState
  if (git) {
    const attributedDirty = git.dirtyOwn ?? (!git.shared && !git.fallback ? git.dirtyFiles : 0)
    if (attributedDirty > 0) {
      concerns.push({
        key: 'dirty',
        label: `${attributedDirty} dirty file${attributedDirty === 1 ? '' : 's'} attributed to this issue`,
        detail: 'Commit, discard, or explicitly accept leaving this work behind.',
        blocking: true,
        icon: 'git',
      })
    }
    const delivery = git.shared ? (git.commits?.length ?? 0) : (git.ahead ?? 0)
    if (delivery > 0 && git.merged !== true) {
      concerns.push({
        key: 'delivery',
        label: `${delivery} commit${delivery === 1 ? '' : 's'} awaiting delivery`,
        detail: git.shared
          ? 'Attributed commits have not yet been reconciled with issue completion.'
          : `The issue branch has not been merged into ${issue.parentBranch}.`,
        blocking: true,
        icon: 'git',
      })
    }
  }
  return concerns
}

const concernIcons: Record<IssueCloseConcern['icon'], ReactNode> = {
  attention: <MessageCircleQuestion size={15} aria-hidden="true" />,
  sessions: <Users size={15} aria-hidden="true" />,
  children: <GitBranch size={15} aria-hidden="true" />,
  git: <GitCommit size={15} aria-hidden="true" />,
}

/** Shared in-place guard for the compact surfaces and canonical full page. */
export function IssueCloseDialog({
  issue,
  reason,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  issue: IssueWire
  reason: IssueCloseReason | null
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: IssueCloseReason) => void
}): JSX.Element {
  const concerns = issueCloseConcerns(issue)
  const blockers = concerns.filter((concern) => concern.blocking)
  return (
    <AlertDialog open={reason !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="mb-1 flex size-8 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
            <AlertTriangle size={16} aria-hidden="true" />
          </div>
          <AlertDialogTitle>
            {blockers.length > 0 ? 'This issue still needs attention' : 'Close this issue?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {blockers.length > 0
              ? 'Review what remains. Closing is still available, but it should be an explicit decision.'
              : 'No unresolved decisions, active work, open sub-tasks, or attributable delivery work were found.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {concerns.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="issue-close-concerns">
            {concerns.map((concern) => (
              <div
                key={concern.key}
                className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5"
              >
                <span
                  className={
                    concern.blocking ? 'mt-0.5 text-amber-500' : 'mt-0.5 text-muted-foreground'
                  }
                >
                  {concernIcons[concern.icon]}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-foreground">
                    {concern.label}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                    {concern.detail}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep open</AlertDialogCancel>
          <AlertDialogAction
            variant={blockers.length > 0 ? 'destructive' : 'default'}
            disabled={busy || reason === null}
            onClick={() => reason && onConfirm(reason)}
          >
            {busy
              ? 'Closing…'
              : blockers.length > 0
                ? reason === 'wontfix'
                  ? 'Close as not planned'
                  : 'Close anyway'
                : reason === 'wontfix'
                  ? 'Close as not planned'
                  : 'Close issue'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
