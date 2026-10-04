/** Independent, stateless fixture oracle for pool parity. */
import {
  asIssueId,
  type IssueGitState,
  type IssueGitStateProjection,
  type IssueId,
  type IssueProjection,
  type IssueUserStateWire,
  type RepoProjection,
  type SessionId,
} from '@podium/model'
import {
  buildIssueTree,
  deriveIssueRollups,
  deriveIssueViews,
  type IssueSessionRollups,
  type IssueTreeNode,
  type IssueView,
  type IssueViewInput,
  readViewInputs,
  type SessionViewInput,
} from './issue-views'
import type { Replica } from '@podium/client-core/replica'

export interface IssueViewsSnapshot {
  views: Map<string, IssueView>
  tree: IssueTreeNode[]
  issues: IssueViewInput[]
  sessions: SessionViewInput[]

  sessionById: Map<SessionId, SessionViewInput>
  issueInputById: Map<string, IssueViewInput>
  issueUserStates: readonly IssueUserStateWire[]
  userStateByIssueId: Map<string, IssueUserStateWire>
  gitStateByIssueId: Map<string, IssueGitStateProjection>
  repoById: Map<string, RepoProjection>
  rollupsFor: (issueId: IssueId) => IssueSessionRollups
}

const EMPTY_ROLLUPS: IssueSessionRollups = {
  unread: false,
  sessionSummary: { total: 0, byPhase: {} },
}

export type IssueViewModel = Omit<
  IssueProjection,
  'description' | 'notes' | 'worktreePath' | 'branch'
> &
  Omit<IssueView, 'id'> &
  Partial<IssueSessionRollups> & {
    description: string
    notes?: string
    worktreePath: string | null
    branch: string | null
    readAt: string | null
    tuckedAt: string | null
    pinned: boolean
    gitState?: IssueGitState
    repoPath: string
    prefix?: string
    deps: Array<{ id: IssueId; type: string }>
  }

export function deriveIssueViewsSnapshot(
  replica: Replica,
  previous?: IssueViewsSnapshot,
  projections: readonly IssueProjection[] = replica.rows('issueProjections'),
  issueUserStates: readonly IssueUserStateWire[] = replica.rows('issueUserStates'),
  dependencyStage?: (id: string) => string | undefined,
): IssueViewsSnapshot {
  const { issues, sessions } = readViewInputs(replica, projections, issueUserStates)
  const views = deriveIssueViews(issues, sessions, { previous: previous?.views, dependencyStage })
  const sessionIndex = new Map(sessions.map((s) => [s.sessionId, s]))
  const issueIndex = new Map(issues.map((i) => [i.id, i]))
  const rollupCache = new Map<string, IssueSessionRollups>()
  return {
    views,
    tree: buildIssueTree(views, issues),
    issues,
    sessions,
    sessionById: sessionIndex,
    issueInputById: issueIndex,
    issueUserStates,
    userStateByIssueId: new Map(issueUserStates.map((row) => [row.entityId, row])),
    gitStateByIssueId: new Map(replica.rows('issueGitStates').map((row) => [row.id, row])),
    repoById: new Map(replica.rows('repos').map((row) => [row.id, row])),
    rollupsFor: (issueId) => {
      const hit = rollupCache.get(issueId)
      if (hit) return hit
      const issue = issueIndex.get(issueId)
      const view = views.get(issueId)
      if (!issue || !view) return EMPTY_ROLLUPS
      const rollups = deriveIssueRollups(issue, view.memberSessionIds, (id) => sessionIndex.get(id))
      rollupCache.set(issueId, rollups)
      return rollups
    },
  }
}

export function buildIssueViewModel(
  snapshot: IssueViewsSnapshot,
  projection: IssueProjection,
  userState: IssueUserStateWire | undefined,
): IssueViewModel | undefined {
  const view = snapshot.views.get(projection.id)
  if (!view) return undefined
  const { id: _id, ...derived } = view
  const observation = snapshot.gitStateByIssueId.get(projection.id)
  const gitState = observation && (({ id: _gitId, ...state }) => state)(observation)
  const repo = projection.repoId ? snapshot.repoById.get(projection.repoId) : undefined
  const readAt = userState?.readAt ?? null
  return {
    ...projection,
    description: projection.description.value,
    notes: projection.notes?.value,
    worktreePath: projection.worktreePath ?? null,
    branch: projection.branch ?? null,
    ...derived,
    readAt,
    tuckedAt: userState?.tuckedAt ?? null,
    pinned: userState?.pinned ?? false,
    gitState,
    repoPath: repo?.repoPath ?? '',
    prefix: repo?.prefix ?? undefined,
    deps: (snapshot.issueInputById.get(projection.id)?.deps ?? []).map((dep) => ({
      ...dep,
      id: asIssueId(dep.id),
    })),
    ...deriveIssueRollups(
      { readAt, updatedAt: projection.updatedAt, deletedAt: projection.deletedAt },
      view.memberSessionIds,
      (id) => snapshot.sessionById.get(id),
    ),
  }
}

export function buildIssueViewModels(
  snapshot: IssueViewsSnapshot,
  projectionRows: readonly IssueProjection[],
  userStateRows: readonly IssueUserStateWire[] = snapshot.issueUserStates,
): Map<string, IssueViewModel> {
  const models = new Map<string, IssueViewModel>()
  const userStateById = new Map(userStateRows.map((row) => [row.entityId, row]))
  for (const projection of projectionRows) {
    const model = buildIssueViewModel(snapshot, projection, userStateById.get(projection.id))
    if (model) models.set(projection.id, model)
  }
  return models
}

export function issueViewModelsFromReplica(
  replica: Replica,
  projectionRows: readonly IssueProjection[] = replica.rows('issueProjections'),
  userStateRows: readonly IssueUserStateWire[] = replica.rows('issueUserStates'),
): Map<string, IssueViewModel> {
  return buildIssueViewModels(
    deriveIssueViewsSnapshot(replica, undefined, projectionRows, userStateRows),
    projectionRows,
    userStateRows,
  )
}

export const allIssueViewModels = (replica: Replica, projections = replica.rows('issueProjections'), markers = replica.rows('issueUserStates')) => [...issueViewModelsFromReplica(replica, projections, markers).values()]
export const issueViewModelById = (replica: Replica, id: string) => issueViewModelsFromReplica(replica).get(id)
