import type { IssueViewModel } from '@podium/client-core/replica'
import { type Replica } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { PinState } from '@podium/client-core/values'
import { issueViewModelsFromReplica } from '../../../diagnostics/reference/issue-view-models'
/** Synthetic/old-export fixture upgrade. Product readers never use this adapter.
 * Real exports carrying the new kinds keep those rows verbatim. */
import {
  asUserId,
  type GitRepositoryWire,
  type IssueDepProjection,
  type IssueGitStateProjection,
  IssueProjection,
  type IssueUserStateWire,
  type MachineWire,
  type PinWire,
  type RepoProjection,
} from '@podium/model'

/** The collections as the web client holds them. */
export interface LiveCollections {
  issueUserStates?: IssueUserStateWire[]
  issueGitStates?: IssueGitStateProjection[]
  issues: IssueViewModel[]
  issueProjections: IssueProjection[]
  sessions: SessionView[]
  repoProjections: RepoProjection[]
  issueDeps: IssueDepProjection[]
  /** The machine scan (`GitRepositoryWire`): repo roots and their worktrees. */
  repos: GitRepositoryWire[]
  machines: MachineWire[]
  pins: PinState
}

export function fixtureMarkers(issues: readonly IssueViewModel[]): IssueUserStateWire[] {
  return issues.map((issue) => ({
    userId: asUserId('u-bench'),
    entityId: issue.id,
    readAt: issue.readAt ?? null,
    tuckedAt: issue.tuckedAt ?? null,
  }))
}
/** A pinned fixture issue is my `pin` record of kind 'issue' (POD-6692). */
export function fixtureIssuePins(
  issues: readonly IssueViewModel[],
  userId = asUserId('u-bench'),
): PinWire[] {
  return issues.flatMap((issue) =>
    issue.pinned
      ? [{ userId, kind: 'issue' as const, entityId: issue.id, pinnedAt: issue.createdAt }]
      : [],
  )
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
