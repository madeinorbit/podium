import type { IssueViewModel } from '@podium/client-core/replica'
import { type Replica } from '@podium/client-core/replica'
import { issueViewModelsFromReplica } from '@podium/client-graph/diagnostics/reference/issue-view-models'
/** Synthetic/old-export fixture upgrade. Product readers never use this adapter.
 * Real exports carrying the new kinds keep those rows verbatim. */
import {
  asUserId,
  type IssueGitStateProjection,
  IssueProjection,
  type IssueUserStateWire,
} from '@podium/model'
import type { LiveCollections } from './live-snapshot'

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
export function fixtureProjection(
  issue: IssueViewModel,
  projection?: IssueProjection,
): IssueProjection {
  const row = { ...issue, ...projection } as unknown as Record<string, unknown>
  const own = Object.fromEntries(
    Object.entries(row).filter(([key]) => Object.hasOwn(IssueProjection.shape, key)),
  )
  return {
    ...own,
    description: projection?.description ?? { value: issue.description },
    isDraftVessel: projection?.isDraftVessel ?? issue.isDraftVessel,
    intentOrigin: projection?.intentOrigin ?? issue.intentOrigin,
    asked: projection?.asked ?? issue.asked,
    ...(issue.notes === undefined ? {} : { notes: { value: issue.notes } }),
  } as IssueProjection
}

/** Render inputs are derived from the same normalized collections the apps use. */
export function fixtureViewModels(input: Omit<LiveCollections, 'issues'>): IssueViewModel[] {
  const rows: Record<string, unknown[]> = {
    issueProjections: input.issueProjections,
    issueUserStates: input.issueUserStates ?? [],
    issueGitStates: input.issueGitStates ?? [],
    issueDeps: input.issueDeps,
    sessions: input.sessions,
    repos: input.repoProjections,
  }
  return [
    ...issueViewModelsFromReplica({ rows: (kind: string) => rows[kind] ?? [] } as Replica).values(),
  ]
}
