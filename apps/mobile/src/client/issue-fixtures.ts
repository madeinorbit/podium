/** Demo/test scaffolding only. Live mobile reads never adapt a legacy row. */
import type { IssueViewModel, Replica } from '@podium/client-core/replica'
import { LOADING } from '@podium/client-graph/loading'
import {
  asIssuePanelItemId,
  asRepoId,
  type IssueDepProjection,
  type IssueGitStateProjection,
  IssueProjection,
  type IssueUserStateWire,
  issueDepId,
  type PinWire,
  type RepoProjection,
  type UserId,
} from '@podium/model'

/** Seed all normalized homes alongside the support-window legacy fixtures. */
export function seedIssueFixtures(
  replica: Replica,
  issues: readonly IssueViewModel[],
  userId: UserId,
): void {
  let panelId = 0
  const todos: import('@podium/model').IssuePanelTodoWire[] = []
  const artifacts: import('@podium/model').IssuePanelArtifactWire[] = []
  const deferred: import('@podium/model').IssuePanelDeferredWire[] = []
  const states: import('@podium/model').IssuePanelStateWire[] = []
  const projections: IssueProjection[] = []
  const markers: IssueUserStateWire[] = []
  const pins: PinWire[] = []
  const git: IssueGitStateProjection[] = []
  const repos = new Map<string, RepoProjection>()
  const deps: IssueDepProjection[] = []
  for (const issue of issues) {
    const panel = issue.panel
    const activityNotes = issue.activityNotes
    const notesUpdatedAt = issue.notesUpdatedAt
    if (
      panel === LOADING ||
      activityNotes === LOADING ||
      notesUpdatedAt === LOADING ||
      issue.description === LOADING
    )
      throw new Error('Issue fixtures must supply loaded bodies')
    const source = issue as unknown as Record<string, unknown>
    const row: Record<string, unknown> = {}
    for (const key of Object.keys(IssueProjection.shape)) {
      const value = source[key]
      if (value != null) row[key] = value
    }
    const repoId = issue.repoId ?? asRepoId(`fixture:${issue.repoPath}`)
    row.repoId = repoId
    // A fixture paints its bodies on the row; a painted text wins over the
    // issueBrief / issueDescription records (POD-6921).
    row.description = { value: issue.description ?? '' }
    row.intentOrigin = issue.intentOrigin
    row.isDraftVessel = issue.isDraftVessel
    delete row.panel
    delete row.activityNotes
    delete row.notesUpdatedAt
    projections.push(row as unknown as IssueProjection)
    const identity = (position: number) => ({
      id: asIssuePanelItemId(`00000000-0000-4000-8000-${String(++panelId).padStart(12, '0')}`),
      issueId: issue.id,
      position,
    })
    for (const [position, value] of (panel?.todos ?? []).entries())
      todos.push({ ...value, ...identity(position) })
    for (const [position, value] of (panel?.artifacts ?? []).entries())
      artifacts.push({ ...value, ...identity(position) })
    for (const [position, value] of (panel?.deferred ?? []).entries())
      deferred.push({ ...value, ...identity(position) })
    if (activityNotes)
      states.push({
        id: issue.id,
        text: activityNotes,
        updatedAt: notesUpdatedAt ?? issue.updatedAt,
      })
    markers.push({
      userId,
      entityId: issue.id,
      readAt: issue.readAt ?? null,
      tuckedAt: issue.tuckedAt ?? null,
    })
    // A pinned task is my pin record (POD-6692), never a marker.
    if (issue.pinned) {
      pins.push({ userId, kind: 'issue', entityId: issue.id, pinnedAt: issue.createdAt })
    }
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
  replica.applySnapshot('issuePanelTodos', todos)
  replica.applySnapshot('issuePanelArtifacts', artifacts)
  replica.applySnapshot('issuePanelDeferreds', deferred)
  replica.applySnapshot('issuePanelStates', states)
  replica.applySnapshot('issueUserStates', markers)
  replica.applySnapshot('pins', pins)
  replica.applySnapshot('issueGitStates', git)
  replica.applySnapshot('repos', [...repos.values()])
  replica.applySnapshot('issueDeps', deps)
}
