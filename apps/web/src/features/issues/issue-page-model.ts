import type { SessionView } from '@podium/client-core/session-values'
import { machinePathBasename } from '@podium/model'
/**
 * Viewmodel for the issue page (P5d, issue #264): the busy/error mutation
 * runner, the lazy comment thread, the event-log drain, and the pure
 * "what to show" derivations — everything IssuePage renders but none of the
 * JSX. Extracted verbatim from IssuePage.tsx; behavior is unchanged.
 */

import { shallowEqual } from '@podium/client-core'
import {
  type ActivityComment,
  type ActivityItem,
  buildActivityFeed,
  type IssueEvent,
} from '@podium/client-core/values'
import type { IssueId, SessionId, UserId } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Store } from '@/app/store'
import { type IssueViewModel, useRuntimeSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import type { PropertyOption } from '@/lib/PropertyMenu'
import { issueNeighbors } from './issue-page'
import { useIssuePageData, useIssuePageIssues } from './issue-page/issue-page-data'
import {
  type IssueMailMessage,
  loadIssueComments,
  loadIssueEventsPage,
  loadIssueMail,
  loadMergeStyle,
  type MergeStyle,
  type RunMutation,
} from './issue-page-commands'

/** Page size for the subject-narrowed event drain. One issue's whole history is
 *  normally far below this, so the drain is a single round trip; a full page is
 *  the signal that more remain. */
const EVENTS_PAGE = 200

export interface IssuePageModel {
  trpc: Trpc
  issueWrites: Pick<Store, 'updateIssue' | 'deleteIssue' | 'closeIssue' | 'deferIssue' | 'undeferIssue' | 'setIssueLabels' | 'restoreIssue'>
  busy: boolean
  run: RunMutation
  prev?: IssueId
  next?: IssueId
  repoName: string
  openSession: (sessionId: SessionId) => void
}

/** Navigation and command ports only. History/editor/roster state belongs to
 * the section that uses it, so typing and clock ticks never rebuild the page. */
export function useIssuePageModel(issue: IssueViewModel, orderedIds: IssueId[]): IssuePageModel {
  const ports = useRuntimeSelector(s => ({ trpc: s.trpc, updateIssue: s.updateIssue,
    deleteIssue: s.deleteIssue, closeIssue: s.closeIssue, deferIssue: s.deferIssue,
    undeferIssue: s.undeferIssue, setIssueLabels: s.setIssueLabels, restoreIssue: s.restoreIssue,
    navigateToSession: s.navigateToSession }), shallowEqual)
  const [busy, setBusy] = useState(false)
  const run: RunMutation = async fn => {
    setBusy(true)
    try { await fn() } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return { trpc: ports.trpc, issueWrites: ports, busy, run,
    ...issueNeighbors(orderedIds, issue.id), repoName: machinePathBasename(issue.repoPath),
    openSession: ports.navigateToSession }
}

/** The configured merge style, loaded once per mount ('ff-only' is the safe
 *  default primary while loading / on error). */
export function useMergeStyle(trpc: Trpc): MergeStyle {
  const [mergeStyle, setMergeStyle] = useState<MergeStyle>('ff-only')
  useEffect(() => {
    let cancelled = false
    loadMergeStyle(trpc)
      .then((style) => {
        if (!cancelled) setMergeStyle(style)
      })
      .catch(() => {
        // best-effort — ff-only is a safe default primary
      })
    return () => {
      cancelled = true
    }
  }, [trpc])
  return mergeStyle
}

// ---------------------------------------------------------------------------
// Pure derivations shared by the page, its overflow menu, and the properties
// aside (extracted verbatim from the former inline computations).
// ---------------------------------------------------------------------------

/** Repo-mates: sibling issues in the same repo excluding self, seq-ordered —
 *  the pool for relations, parent, and supersede/duplicate targets. */
export function repoMatesOf(issues: IssueViewModel[], issue: IssueViewModel): IssueViewModel[] {
  return issues
    .filter((i) => i.repoPath === issue.repoPath && i.id !== issue.id)
    .sort((a, b) => a.seq - b.seq)
}

export function mateOptionsOf(repoMates: IssueViewModel[]): PropertyOption[] {
  return repoMates.map((i) => ({ value: i.id, label: `${issueDisplayRef(i)} ${i.title}` }))
}

/** Sentinel option value for "no assignee" in the assignee menu. */
export const UNASSIGNED = '__unassigned__'

/** Distinct assignees across all issues — the suggestion pool. */
export function assigneeOptionsOf(issues: IssueViewModel[]): PropertyOption[] {
  return [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...[...new Set(issues.map((i) => i.assignee).filter((a): a is UserId => !!a))]
      .sort()
      .map((a) => ({ value: a, label: a })),
  ]
}

/** Distinct labels across all issues not already on this one. */
export function labelPoolOf(issues: IssueViewModel[], issue: IssueViewModel): string[] {
  return [...new Set(issues.flatMap((i) => i.labels))]
    .filter((l) => !issue.labels.includes(l))
    .sort()
}
