/** Frozen pre-change eager rules: independent answer control for POD-5942. */
import { machinePathKey } from '@podium/model/browser'
import type { IssueSessionFactReader } from '../shared/issue-session-facts'
import type { SliceIssue } from '../shared/slice-types'
import { refs } from '../shared/links'
import { isExcluded, isFinished } from '../shared/predicates'
import { awaitingMergeOf } from '../shared/schema'
import { parseMs, isClosedTopLevel, closedOf, bandOf, foldAtOf, issueAbandoned,
  type OwnPart, type ViewInputs, type CloseFacts } from '../views'
import type { Standing } from './visible'

export function standingBefore(issue: SliceIssue, facts?: Pick<Standing,
  'excluded' | 'finished' | 'awaitingMerge' | 'parentId' | 'finishedMs' | 'updatedMs' | 'formalParent' |
  'replicaActivityMs' | 'headlessStaffed'>, sessionFact?: IssueSessionFactReader): Standing {
  const excluded = facts ? facts.excluded : isExcluded(issue)
  const finished = facts ? facts.finished : isFinished(issue)
  const human = issue.audience === 'human'
  const activeHuman =
    human &&
    (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
  const awaitingMerge = facts ? facts.awaitingMerge : !excluded && awaitingMergeOf(issue)
  // `issueAwaitingMerge` reads branch and git state off the composed row: the
  // wire carries both, so the verdict is available here (it used to read as
  // never true because no slice field spelled it).
  const sessionless = activeHuman
    ? 'keep'
    : !finished
      ? 'drop'
      : isClosedTopLevel(issue)
        ? 'fold'
        : !issue.parentId || issue.audience === 'agent'
          ? 'drop'
          : 'decay'
  const spinOff = issue.deps?.some((dep) => dep.type === 'discovered-from') === true
  // No `readAt`: the cursor lives in the read-state lane
  // (`VisibleInputs.issueRead`), so a mark-read never re-runs this.
  return {
    excluded,
    finished,
    agent: issue.audience === 'agent',
    activeHuman,
    awaitingMerge,
    sessionless,
    rescuable: human && !finished,
    parentId: facts ? facts.parentId : issue.parentId || null,
    startedBy:
      !issue.parentId && !spinOff && issue.startedBySession ? issue.startedBySession : null,
    draftVessel: issue.isDraftVessel === true && !issue.worktreePath,
    finishedMs: facts ? facts.finishedMs : parseMs(issue.closedAt ?? issue.updatedAt) ?? 0,
    updatedMs: facts ? facts.updatedMs : parseMs(issue.updatedAt),
    replicaActivityMs: facts ? facts.replicaActivityMs : parseMs(sessionFact?.(issue.id, 'replicaActivityAt')),
    headlessStaffed: facts ? facts.headlessStaffed : sessionFact?.(issue.id, 'headlessStaffed') === true,
    deleted: issue.deletedAt != null,
    pinned: issue.pinned === true,
    formalParent: facts ? facts.formalParent : refs.issue.parent(issue),
  }
}

export function ownBefore(issue: SliceIssue, input: Pick<ViewInputs, 'passed' | 'reached'>, facts?: CloseFacts): OwnPart {
  const closed = closedOf(issue, false, input, facts)
  return {
    band: bandOf(issue, input),
    repoKey: issue.repoId ?? machinePathKey(issue.repoPath),
    closed,
    dismissed: closed && (issueAbandoned(issue) || issue.tuckedAt != null),
    pinned: issue.pinned === true,
    sortKey: issue.sortKey ?? null,
    createdAt: issue.createdAt,
    seq: issue.seq,
    foldAt: foldAtOf(issue),
  }
}
