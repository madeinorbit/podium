import { ISSUE_STATUS_LABELS, type IssueId, type IssueStage, type IssueWire } from '@podium/model'
import { issueDisplayRef, parseAnyRef } from '@podium/protocol'

/** Human labels for the workflow glyph family. Kept with the reference model so
 * every adapter (web, terminal, native) announces the same state.
 *
 * The STAGE-shaped view of `ISSUE_STATUS_LABELS` (POD-1074): the words now live
 * once, in the model, beside the close reasons they share a picker with. This
 * name stays because ~30 call sites read a stage and only a stage; reach for
 * the model's table directly when the closed outcome matters too. */
export const ISSUE_STAGE_LABELS: Readonly<Record<IssueStage, string>> = {
  proposed: ISSUE_STATUS_LABELS.proposed,
  backlog: ISSUE_STATUS_LABELS.backlog,
  planning: ISSUE_STATUS_LABELS.planning,
  in_progress: ISSUE_STATUS_LABELS.in_progress,
  review: ISSUE_STATUS_LABELS.review,
  shipping: ISSUE_STATUS_LABELS.shipping,
  done: ISSUE_STATUS_LABELS.done,
}

/** The issue fields a compact reference is allowed to read. */
export type IssueReferenceSource = Pick<IssueWire, 'id' | 'seq' | 'title' | 'stage'> &
  Partial<Pick<IssueWire, 'prefix' | 'displayRef' | 'archived' | 'deletedAt'>>

export type IssueReferenceAvailability = 'present' | 'archived' | 'deleted' | 'unavailable'

/** Surface-independent presentation of one issue reference. */
export interface IssueReferenceModel {
  ref: string
  issueId: IssueId | null
  title: string | null
  stage: IssueStage | null
  availability: IssueReferenceAvailability
  accessibleLabel: string
}

/** Project a visible issue row into the canonical compact-reference model. */
export function issueReferenceModel(issue: IssueReferenceSource): IssueReferenceModel {
  const ref = issueDisplayRef(issue)
  if (issue.deletedAt) {
    return {
      ref,
      issueId: issue.id,
      title: issue.title,
      stage: null,
      availability: 'deleted',
      accessibleLabel: `Deleted task ${ref}: ${issue.title}`,
    }
  }
  const stageLabel = ISSUE_STAGE_LABELS[issue.stage]
  // Archive is a soft hide: keep the live workflow stage so glyphs, chat chips,
  // and terminal underlines still show correct status for POD-N mentions.
  if (issue.archived) {
    return {
      ref,
      issueId: issue.id,
      title: issue.title,
      stage: issue.stage,
      availability: 'archived',
      accessibleLabel: `Archived ${stageLabel} task ${ref}: ${issue.title}`,
    }
  }
  return {
    ref,
    issueId: issue.id,
    title: issue.title,
    stage: issue.stage,
    availability: 'present',
    accessibleLabel: `${stageLabel} task ${ref}: ${issue.title}`,
  }
}

/**
 * Resolve a canonical `PREFIX-N` token against the caller's current issue
 * projection. A parseable token with no visible row is deliberately
 * `unavailable`: absence cannot distinguish late, hidden, removed, or unknown.
 * Session refs and malformed strings are not issue references and return null.
 */
export function resolveIssueReference(
  refToken: string,
  issues: readonly IssueReferenceSource[],
): IssueReferenceModel | null {
  const token = refToken.trim()
  const parsed = parseAnyRef(token)
  if (parsed?.kind !== 'issue') return null
  const issue = issues.find(
    (candidate) =>
      candidate.displayRef === token ||
      (candidate.prefix === parsed.prefix && candidate.seq === parsed.seq),
  )
  if (issue) return issueReferenceModel(issue)
  return {
    ref: token,
    issueId: null,
    title: null,
    stage: null,
    availability: 'unavailable',
    accessibleLabel: `Task ${token} is unavailable`,
  }
}
