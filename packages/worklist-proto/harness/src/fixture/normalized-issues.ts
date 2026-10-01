/** Synthetic/old-export fixture upgrade. Product readers never use this adapter.
 * Real exports carrying the new kinds keep those rows verbatim. */
import {
  asUserId,
  type IssueGitStateProjection,
  type IssueProjection,
  type IssueUserStateWire,
  type IssueWire,
} from '@podium/model'

export function fixtureMarkers(issues: readonly IssueWire[]): IssueUserStateWire[] {
  return issues.map((issue) => ({
    userId: asUserId('u-bench'),
    entityId: issue.id,
    readAt: issue.readAt ?? null,
    tuckedAt: issue.tuckedAt ?? null,
    pinned: issue.pinned ?? false,
  }))
}
export function fixtureGitStates(issues: readonly IssueWire[]): IssueGitStateProjection[] {
  return issues.flatMap((issue) => (issue.gitState ? [{ id: issue.id, ...issue.gitState }] : []))
}
export function fixtureProjection(issue: IssueWire, projection?: IssueProjection): IssueProjection {
  const {
    draft: _draft,
    origin: _origin,
    humanQuestion: _question,
    humanQuestionOptions: _options,
    humanQuestionAskedAt: _at,
    humanQuestionAskedBy: _by,
    ...row
  } = (projection ?? issue) as unknown as Record<string, unknown>
  return {
    ...row,
    description:
      typeof row.description === 'string'
        ? { value: row.description }
        : (row.description ?? { value: '' }),
    isDraftVessel: projection?.isDraftVessel ?? issue.draft ?? false,
    intentOrigin: projection?.intentOrigin ?? issue.origin ?? 'human',
    asked:
      projection?.asked ??
      (issue.humanQuestion
        ? {
            question: issue.humanQuestion,
            options: issue.humanQuestionOptions,
            at: issue.humanQuestionAskedAt,
            by: issue.humanQuestionAskedBy,
          }
        : undefined),
  } as IssueProjection
}
