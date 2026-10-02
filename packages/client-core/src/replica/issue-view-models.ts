/**
 * Pure (React-free) issue view models [ADR 4 D7.3].
 *
 * `use-issue-views.ts` is the React binding over this file. The published
 * worklist also reads these models — it cannot import the hook without pulling
 * React into a platform-neutral slice, and it must not restate unread
 * derivation (POD-843).
 */
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
import type { Replica } from './replica'

export interface IssueViewsSnapshot {
  views: Map<string, IssueView>
  tree: IssueTreeNode[]
  issues: IssueViewInput[]
  sessions: SessionViewInput[]
  /** The same sessions, indexed. Carried on the snapshot rather than rebuilt per
   *  model pass because the per-issue builder below needs it for ONE issue
   *  (POD-1053): re-indexing 530 sessions to rebuild a single row would put an
   *  O(world) step back in front of the incremental path. */
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

/** Replica-side render model. Durable facts retain the normalized spellings;
 * personal markers, git observations and repo facts come from their own kinds.
 * Description is materialized for rendering, and unset checkout paths are null. */
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

/**
 * Replica-derived issue world. One pass; the React binding caches this.
 *
 * `previous` is the last snapshot derived from this same replica, and it buys
 * per-issue view IDENTITY, not a skipped pass — see `deriveIssueViews`'s note on
 * why the derivation stays whole and why handing it back is safe under evict and
 * rescope. Passing nothing derives a snapshot whose every view is new, which is
 * the correct answer for a caller with no previous generation to speak of.
 */
export function deriveIssueViewsSnapshot(
  replica: Replica,
  previous?: IssueViewsSnapshot,
  projections: readonly IssueProjection[] = replica.rows('issueProjections'),
  issueUserStates: readonly IssueUserStateWire[] = replica.rows('issueUserStates'),
): IssueViewsSnapshot {
  const { issues, sessions } = readViewInputs(replica, projections, issueUserStates)
  const views = deriveIssueViews(issues, sessions, { previous: previous?.views })
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

/** One flat render model, including a projection whose other kinds have not
 * arrived yet. Missing personal state means untouched; missing git is unknown;
 * a missing repo has an empty path and no prefix. */
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

/** Flat render models keyed by id; the optional markers are the runtime's
 * optimistic fold over the principal-bound issueUserState kind. */
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
