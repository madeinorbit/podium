import {
  actorUser,
  asRepoId,
  asUserId,
  IssueProjection,
  type IssueUserStateWire,
  type RepoProjection,
  type SessionMeta,
} from '@podium/model'
import type { IssueViewModel } from '../replica/issue-view-models'
import { createReplica, memoryStorage } from '../replica/replica'

/** Test-only fixture decomposition. Every runtime input is a normalized kind. */
export function normalizedIssueFixture(
  issues: readonly IssueViewModel[],
  sessions: readonly SessionMeta[] = [],
) {
  const userId = asUserId('fixture-user')
  const issueProjections = issues.map(
    (issue): IssueProjection =>
      ({
        ...Object.fromEntries(
          Object.entries(issue).filter(([key]) => Object.hasOwn(IssueProjection.shape, key)),
        ),
        owner: userId,
        visibility: 'personal',
        createdBy: { actor: actorUser(userId), onBehalfOf: userId },
        repoId: asRepoId(issue.repoPath),
        description: { value: issue.description },
        ...(issue.notes === undefined ? {} : { notes: { value: issue.notes } }),
      }) as IssueProjection,
  )
  const issueUserStates: IssueUserStateWire[] = issues.map((issue) => ({
    userId,
    entityId: issue.id,
    readAt: issue.readAt ?? null,
    tuckedAt: issue.tuckedAt ?? null,
    pinned: issue.pinned ?? false,
  }))
  const replica = createReplica({ storage: memoryStorage() })
  replica.applySnapshot('issueProjections', issueProjections)
  replica.applySnapshot('issueUserStates', issueUserStates)
  replica.applySnapshot('sessions', [...sessions])
  replica.applySnapshot(
    'repos',
    [...new Set(issues.map((issue) => issue.repoPath))].map(
      (repoPath) =>
        ({
          id: asRepoId(repoPath),
          repoPath,
        }) as RepoProjection,
    ),
  )
  return { replica, issueProjections, issueUserStates }
}
