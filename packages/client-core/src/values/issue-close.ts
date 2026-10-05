import type { SessionView } from '../session-values'
import { isSessionWorking } from './session-status'
import type { IssueNavigationModel } from './compose/issues'

/**
 * WHAT A CLOSE WOULD COST, DERIVED ONCE FOR EVERY SURFACE [POD-1129].
 *
 * This lived in `apps/web/src/features/issues/issue-lifecycle.tsx`, typed over
 * the web's `IssueViewModel` and sitting in the same file as the `AlertDialog`
 * that renders it. The phone therefore could not read it, and both of its close
 * paths — the task inspector's status sheet and the task page's `selectStatus` —
 * called `closeIssue` straight through. Marking a task Done from a phone retired
 * pending agent decisions and walked away from uncommitted work without saying
 * either had happened.
 *
 * The fix is NOT a second set of checks shaped like a phone. The facts here are
 * platform-neutral by construction — an issue row and the sessions attached to
 * it, nothing else — so they move here whole and each surface presents them in
 * its own idiom: an `AlertDialog` on the desktop, a `BottomSheet` on the phone.
 * A guard that lists different things depending on which screen you closed from
 * is worse than no guard, because it teaches that the list is advisory.
 *
 * Platform-neutral: no DOM, no React, no icon components — `icon` is a NAME the
 * caller maps to its own icon set (`lucide-react` on the web, platform symbols
 * through `expo-symbols` on the phone).
 */

export interface IssueCloseConcern {
  key: string
  label: string
  detail: string
  blocking: boolean
  icon: 'attention' | 'sessions' | 'children' | 'git'
}

/**
 * The issue fields the guard reads, and only those.
 *
 * Spelled as a `Pick` rather than the web's `IssueViewModel` so the phone can
 * pass a bare `IssueNavigationModel` and the desktop can keep passing its richer model:
 * both satisfy this, and neither surface gets to quietly widen what a close
 * decision is allowed to depend on.
 */
export type IssueCloseSubject = Pick<
  IssueNavigationModel,
  'needsHuman' | 'asked' | 'childCount' | 'childDoneCount' | 'parentBranch' | 'gitState'
>

/**
 * Facts that should be visible before an issue is closed. This is deliberately
 * presentation-only: the server remains permissive while the UI makes every
 * issue-owned consequence explicit. Unattributed checkout state is deliberately
 * absent: it belongs to workspace Git surfaces, not an issue close decision.
 *
 * `members` is the issue's OWN sessions, already resolved by the caller — the
 * desktop holds them as `memberSessionIds` against the store, the phone matches
 * `session.issueId`, and neither spelling belongs in a derivation. Archived rows
 * are dropped here rather than at each call site, so "who counts" stays one
 * answer. Shells count exactly as `isSessionWorking` counts them (#115): a
 * terminal with a command running is work in flight, whatever launched it.
 */
export function issueCloseConcerns(
  issue: IssueCloseSubject,
  members: readonly SessionView[] = [],
): IssueCloseConcern[] {
  let offers = 0, working = 0
  for (const session of members) {
    if (session.archived) continue
    if (session.offer) offers++
    if (isSessionWorking(session)) working++
  }
  return issueCloseConcernsFromCounts(issue, { offers, working })
}

/** Pool answers maintain these two contributions at ingestion, so a close
 * action does not have to materialize the issue's session history. */
export interface IssueCloseMemberCounts {
  readonly offers: number
  readonly working: number
}
/** A close reader needs counts and attributed git totals, never commit/file
 * payloads or the rest of a question object. */
export interface IssueCloseScalarSubject {
  needsHuman: boolean
  asked?: { question?: string } | null
  childCount: number
  childDoneCount: number
  parentBranch: string
  git?: { dirty: number; delivery: number; shared: boolean; merged?: boolean }
}

export function issueCloseConcernsFromCounts(
  issue: IssueCloseSubject | IssueCloseScalarSubject,
  members: IssueCloseMemberCounts,
): IssueCloseConcern[] {
  const concerns: IssueCloseConcern[] = []
  const { offers, working } = members
  if (offers > 0) {
    concerns.push({
      key: 'offers',
      label: `${offers} pending decision${offers === 1 ? '' : 's'}`,
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
      detail: issue.asked?.question || 'A question or approval is still waiting for a response.',
      blocking: true,
      icon: 'attention',
    })
  }
  if (working > 0) {
    concerns.push({
      key: 'working',
      label: `${working} agent${working === 1 ? ' is' : 's are'} still working`,
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

  const fullGit = 'gitState' in issue ? issue.gitState : undefined
  const git = fullGit ? {
    dirty: fullGit.dirtyOwn ?? (!fullGit.shared && !fullGit.fallback ? fullGit.dirtyFiles : 0),
    delivery: fullGit.shared ? (fullGit.commits?.length ?? 0) : (fullGit.ahead ?? 0),
    shared: !!fullGit.shared,
    merged: fullGit.merged,
  } : 'git' in issue ? issue.git : undefined
  if (git) {
    const attributedDirty = git.dirty
    if (attributedDirty > 0) {
      concerns.push({
        key: 'dirty',
        label: `${attributedDirty} dirty file${attributedDirty === 1 ? '' : 's'} attributed to this issue`,
        detail: 'Commit, discard, or explicitly accept leaving this work behind.',
        blocking: true,
        icon: 'git',
      })
    }
    const delivery = git.delivery
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

/**
 * The subset that must be READ before a close, not merely noted beside it.
 *
 * One definition because it now decides two different things: what the desktop
 * dialog styles as a warning, and whether the phone interrupts at all. On the
 * phone a close with no blocker fires on the press — the guard exists to name
 * what is at stake, and a sheet that rises to report nothing at stake is a tax
 * on the most ordinary action there is (POD-1129). Split the predicate and the
 * two surfaces eventually disagree about what "still needs attention" means.
 */
export function blockingCloseConcerns(concerns: readonly IssueCloseConcern[]): IssueCloseConcern[] {
  return concerns.filter((concern) => concern.blocking)
}
