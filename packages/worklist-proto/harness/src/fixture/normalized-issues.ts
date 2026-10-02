import type { IssueViewModel } from '@podium/client-core/replica'
/** Synthetic/old-export fixture upgrade. Product readers never use this adapter.
 * Real exports carrying the new kinds keep those rows verbatim. */
import {
  asUserId,
  type IssueGitStateProjection,
  IssueProjection,
  type IssueUserStateWire,
  } from '@podium/model'

export function fixtureMarkers(issues: readonly IssueViewModel[]): IssueUserStateWire[] {
  return issues.map((issue) => ({
    userId: asUserId('u-bench'),
    entityId: issue.id,
    readAt: issue.readAt ?? null,
    tuckedAt: issue.tuckedAt ?? null,
    pinned: issue.pinned ?? false,
  }))
}
export function fixtureGitStates(issues: readonly IssueViewModel[]): IssueGitStateProjection[] {
  return issues.flatMap((issue) => (issue.gitState ? [{ id: issue.id, ...issue.gitState }] : []))
}
export function fixtureProjection(issue: IssueViewModel, projection?: IssueProjection): IssueProjection {
  if (projection) return projection
  const row = issue as unknown as Record<string, unknown>
  const own = Object.fromEntries(Object.entries(row).filter(([key]) => Object.hasOwn(IssueProjection.shape, key)))
  return {
    ...own,
    description: { value: issue.description },
    ...(issue.notes === undefined ? {} : { notes: { value: issue.notes } }),
  } as IssueProjection
}
