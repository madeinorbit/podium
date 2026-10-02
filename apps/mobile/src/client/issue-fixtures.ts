/** Demo/test scaffolding only. Live mobile reads never adapt a legacy row. */
import type { IssueViewModel, Replica } from '@podium/client-core/replica'
import {
  asRepoId,
  type IssueDepProjection,
  type IssueGitStateProjection,
  IssueProjection,
  type IssueUserStateWire,
  issueDepId,
  type RepoProjection,
  type UserId,
} from '@podium/model'

/** Seed all normalized homes alongside the support-window legacy fixtures. */
export function seedIssueFixtures(
  replica: Replica,
  issues: readonly IssueViewModel[],
  userId: UserId,
): void {
  const projections: IssueProjection[] = []
  const markers: IssueUserStateWire[] = []
  const git: IssueGitStateProjection[] = []
  const repos = new Map<string, RepoProjection>()
  const deps: IssueDepProjection[] = []
  for (const issue of issues) {
    const source = issue as unknown as Record<string, unknown>
    const row: Record<string, unknown> = {}
    for (const key of Object.keys(IssueProjection.shape)) {
      const value = source[key]
      if (value != null) row[key] = value
    }
    const repoId = issue.repoId ?? asRepoId(`fixture:${issue.repoPath}`)
    row.repoId = repoId
    row.description = { value: issue.description ?? '' }
    if (issue.notes !== undefined) row.notes = { value: issue.notes }
    row.intentOrigin = issue.intentOrigin
    row.isDraftVessel = issue.isDraftVessel
    projections.push(row as unknown as IssueProjection)
    markers.push({
      userId,
      entityId: issue.id,
      readAt: issue.readAt ?? null,
      tuckedAt: issue.tuckedAt ?? null,
      pinned: issue.pinned ?? false,
    })
    if (issue.gitState) git.push({ ...issue.gitState, id: issue.id })
    repos.set(repoId, {
      id: repoId,
      repoPath: issue.repoPath,
      prefix: issue.prefix ?? issue.displayRef?.match(/^([A-Z][A-Z0-9]*)-/)?.[1],
    } as RepoProjection)
    for (const dep of issue.deps ?? []) {
      deps.push({
        id: issueDepId(issue.id, dep.id, dep.type),
        fromId: issue.id,
        toId: dep.id,
        type: dep.type,
      } as IssueDepProjection)
    }
  }
  replica.applySnapshot('issueProjections', projections)
  replica.applySnapshot('issueUserStates', markers)
  replica.applySnapshot('issueGitStates', git)
  replica.applySnapshot('repos', [...repos.values()])
  replica.applySnapshot('issueDeps', deps)
}
