import { useUiValue } from '@podium/client-core/react'
import { issueRepoName } from '@podium/client-core/values'
/**
 * Navigation and mutation ports for the issue page. Record facts are read by
 * observer sections; the activity section owns its shared request history.
 */

import { shallowEqual } from '@podium/client-core'
import type { IssueId, SessionId, UserId } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { useState } from 'react'
import { toast } from 'sonner'
import type { Store } from '@/app/store'
import { type IssueViewModel, useRuntimeSelector } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import type { PropertyOption } from '@/lib/PropertyMenu'
import { tellIssueActionEnding } from './issue-action-ending'
import { issueNeighbors } from './issue-page'
import type { RunMutation } from './issue-page-commands'

export interface IssuePageModel {
  trpc: Trpc
  issueWrites: Pick<
    Store,
    | 'updateIssue'
    | 'setPinned'
    | 'deleteIssue'
    | 'closeIssue'
    | 'deferIssue'
    | 'undeferIssue'
    | 'setIssueLabels'
    | 'restoreIssue'
    | 'startIssueSession'
    | 'issueAction'
  >
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
  const ports = {
    trpc: useRuntimeSelector((s) => s.trpc),
    updateIssue: useRuntimeSelector((s) => s.updateIssue),
    setPinned: useRuntimeSelector((s) => s.setPinned),
    deleteIssue: useRuntimeSelector((s) => s.deleteIssue),
    closeIssue: useRuntimeSelector((s) => s.closeIssue),
    deferIssue: useRuntimeSelector((s) => s.deferIssue),
    undeferIssue: useRuntimeSelector((s) => s.undeferIssue),
    setIssueLabels: useRuntimeSelector((s) => s.setIssueLabels),
    restoreIssue: useRuntimeSelector((s) => s.restoreIssue),
    startIssueSession: useRuntimeSelector((s) => s.startIssueSession),
    issueAction: useRuntimeSelector((s) => s.issueAction),
    navigateToSession: useUiValue('navigateToSession'),
  }
  const pool = useWorklistPool()
  const [busy, setBusy] = useState(false)
  const run: RunMutation = async (fn) => {
    setBusy(true)
    try {
      await fn()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return {
    trpc: ports.trpc,
    issueWrites: {
      ...ports,
      // The action answers on its record; this device says how it ended.
      issueAction: async (id, action, opts) => {
        const effectId = await ports.issueAction(id, action, opts)
        tellIssueActionEnding(pool, effectId, action)
        return effectId
      },
    },
    busy,
    run,
    ...issueNeighbors(orderedIds, issue.id),
    repoName: issueRepoName(issue),
    openSession: ports.navigateToSession,
  }
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
