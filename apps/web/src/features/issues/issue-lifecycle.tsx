import { isSessionWorking } from '@podium/client-core/viewmodels'
import { ISSUE_STATUS_LABELS, type IssueCloseReason, type SessionMeta } from '@podium/model/browser'
import { AlertTriangle, GitBranch, GitCommit, MessageCircleQuestion, Users } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
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
import { issueRefLabel } from '@/lib/issue-labels'

/** Re-exported from the model (POD-1074), where the vocabulary now lives with
 *  its labels and its legacy `wontfix` → `cancelled` canonicalization. Kept as a
 *  name here because every close call site in this feature already imports it. */
export type { IssueCloseReason }

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
export function issueCloseConcerns(
  issue: IssueViewModel,
  sessions: readonly SessionMeta[] = [],
): IssueCloseConcern[] {
  const concerns: IssueCloseConcern[] = []
  const memberIds = new Set(issue.memberSessionIds ?? [])
  const members = sessions.filter((session) => memberIds.has(session.sessionId))
  const offers = members.filter((session) => !session.archived && session.offer)
  if (offers.length > 0) {
    concerns.push({
      key: 'offers',
      label: `${offers.length} pending decision${offers.length === 1 ? '' : 's'}`,
      // Closing retires standing offers (POD-290); surface them so "Close anyway"
      // is an explicit choice rather than a silent drop.
      detail: 'Closing retires these pending agent decisions.',
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
  const working = members.filter((session) => !session.archived && isSessionWorking(session))
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

/** What a batch close is about to do, issue by issue. `flagged` keeps the input
 *  order so the list reads like the selection it came from. */
export interface IssueBulkCloseSummary {
  /** `lead` is the first of `concerns` — the icon the row is drawn with, carried
   *  rather than re-indexed so the row cannot be rendered from an empty list. */
  flagged: Array<{ issue: IssueViewModel; lead: IssueCloseConcern; concerns: IssueCloseConcern[] }>
  /** Issues in the batch with nothing unresolved — a count, not a list: they are
   *  the ordinary case and naming forty of them would bury the ones that matter. */
  clear: number
}

/**
 * The batch form of {@link issueCloseConcerns}. One close decision is being taken
 * over many issues, so the guard cannot ask about one of them: it names the ones
 * that still hold unresolved work and counts the rest.
 */
export function issueBulkCloseSummary(
  issues: readonly IssueViewModel[],
  sessions: readonly SessionMeta[] = [],
): IssueBulkCloseSummary {
  const flagged: IssueBulkCloseSummary['flagged'] = []
  let clear = 0
  for (const issue of issues) {
    const concerns = issueCloseConcerns(issue, sessions).filter((concern) => concern.blocking)
    const [lead] = concerns
    if (lead) flagged.push({ issue, lead, concerns })
    else clear += 1
  }
  return { flagged, clear }
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
  issue: IssueViewModel
  reason: IssueCloseReason | null
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: IssueCloseReason) => void
}): JSX.Element {
  const sessions = useStoreSelector((store) => store.sessions)
  const concerns = issueCloseConcerns(issue, sessions)
  const blockers = concerns.filter((concern) => concern.blocking)
  return (
    <AlertDialog open={reason !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="mb-1 flex size-8 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
            <AlertTriangle size={16} aria-hidden="true" />
          </div>
          <AlertDialogTitle>
            {/* The ending is named only when it is NOT the ordinary one:
                "Close this issue?" already means done, and spelling that out
                would make the common path read like a special case. */}
            {blockers.length > 0
              ? 'This issue still needs attention'
              : reason && reason !== 'done'
                ? `Close this issue as ${ISSUE_STATUS_LABELS[reason].toLowerCase()}?`
                : 'Close this issue?'}
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
            {/* The button says which ENDING is being recorded, not just "close"
                — the menu now offers three of them and the dialog is the last
                place to catch a mispick. `done` keeps the plain wording so the
                common path stays a plain sentence. */}
            {busy
              ? 'Closing…'
              : reason && reason !== 'done'
                ? `Close as ${ISSUE_STATUS_LABELS[reason].toLowerCase()}`
                : blockers.length > 0
                  ? 'Close anyway'
                  : 'Close issue'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The same guard for a whole selection (POD-1126). The board's bulk status bar
 * closes every selected issue at once, and {@link IssueCloseDialog} is
 * single-issue by construction — it renders ONE issue's concerns and its footer
 * speaks about "this issue". So the batch gets its own shape: which of the
 * selected issues still hold unresolved work, and what each of them holds.
 *
 * A selection of one is handed to the single dialog, which says strictly more:
 * it carries each concern's detail line, and a one-row batch has no batch to
 * describe.
 */
export function IssueBulkCloseDialog({
  issues,
  reason,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  issues: readonly IssueViewModel[]
  reason: IssueCloseReason | null
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: IssueCloseReason) => void
}): JSX.Element | null {
  const sessions = useStoreSelector((store) => store.sessions)
  const summary = issueBulkCloseSummary(issues, sessions)
  const first = issues[0]
  if (!first) return null
  if (issues.length === 1)
    return (
      <IssueCloseDialog
        issue={first}
        reason={reason}
        busy={busy}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    )
  const count = issues.length
  const ending = reason && reason !== 'done' ? ISSUE_STATUS_LABELS[reason].toLowerCase() : null
  return (
    <AlertDialog open={reason !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="mb-1 flex size-8 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
            <AlertTriangle size={16} aria-hidden="true" />
          </div>
          <AlertDialogTitle>
            {/* The headline counts what is WRONG when something is, because that
                is the number the decision turns on — "3 of 12" is a different
                press from "12 of 12". */}
            {summary.flagged.length > 0
              ? `${summary.flagged.length} of ${count} tasks still need attention`
              : ending
                ? `Close ${count} tasks as ${ending}?`
                : `Close ${count} tasks?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {summary.flagged.length > 0
              ? 'Review what remains. Closing is still available, but it should be an explicit decision.'
              : 'No unresolved decisions, active work, open sub-tasks, or attributable delivery work were found in the selection.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {summary.flagged.length > 0 && (
          <div
            className="flex max-h-64 flex-col gap-2 overflow-y-auto"
            data-testid="issue-bulk-close-concerns"
          >
            {summary.flagged.map(({ issue, lead, concerns }) => (
              <div
                key={issue.id}
                className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5"
              >
                <span className="mt-0.5 text-amber-500">{concernIcons[lead.icon]}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    <span className="text-muted-foreground tabular-nums">
                      {issueRefLabel(issue)}
                    </span>{' '}
                    {issue.title}
                  </span>
                  {/* The batch names each issue's concerns but drops their detail
                      lines: the same sentence repeated down a list of twelve
                      stops being read. The single dialog still carries them. */}
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                    {concerns.map((concern) => concern.label).join(' · ')}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {summary.flagged.length > 0 && summary.clear > 0 && (
          <p className="text-[11.5px] text-muted-foreground">
            The other {summary.clear} {summary.clear === 1 ? 'task has' : 'tasks have'} nothing
            unresolved.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep open</AlertDialogCancel>
          <AlertDialogAction
            variant={summary.flagged.length > 0 ? 'destructive' : 'default'}
            disabled={busy || reason === null}
            onClick={() => reason && onConfirm(reason)}
          >
            {busy
              ? 'Closing…'
              : ending
                ? `Close ${count} as ${ending}`
                : summary.flagged.length > 0
                  ? `Close ${count} anyway`
                  : `Close ${count} tasks`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
