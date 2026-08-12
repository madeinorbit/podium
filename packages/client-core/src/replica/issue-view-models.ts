/**
 * Pure (React-free) issue view models [ADR 4 D7.3].
 *
 * `use-issue-views.ts` is the React binding over this file. The published
 * worklist also reads these models — it cannot import the hook without pulling
 * React into a platform-neutral slice, and it must not restate unread
 * derivation (POD-843).
 */
import type { IssueId, IssueProjection, IssueWire, SessionId } from '@podium/model'
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
  rollupsFor: (issueId: IssueId) => IssueSessionRollups
}

const EMPTY_ROLLUPS: IssueSessionRollups = {
  unread: false,
  sessionSummary: { total: 0, byPhase: {} },
}

type LegacyIssueSupplement = Omit<IssueWire, 'commentCount'>
type ProjectionOnly = Partial<Omit<IssueProjection, keyof IssueWire>>

/** UI contract during the additive cutover: legacy relation/provenance fields
 * remain available from the retained issue kind, while embedded sessions and
 * commentCount are structurally absent. The builder always supplies member ids. */
export type IssueViewModel = LegacyIssueSupplement &
  ProjectionOnly &
  Partial<IssueSessionRollups> & { childIds?: string[]; memberSessionIds?: SessionId[] }

/**
 * The projection's three keys that DISAGREE in shape with the legacy wire,
 * rewritten to the legacy spelling before the spread.
 *
 * The projection is spread OVER the legacy supplement, so wherever the two
 * representations of a field disagree the projection's value is the one the
 * model actually carries — while `IssueViewModel` declares the legacy type.
 * MEASURED rather than assumed: comparing `IssueWire.shape` against
 * `IssueProjection.shape` key by key returns exactly three, and this function is
 * total over them.
 *
 *   `description`   R1 carries the ADR 1 Am1 D12 op-stream DOCUMENT
 *                   (`fields/op-stream.ts`: a required materialized `value` with
 *                   room for a bounded op tail); the wire and every UI reading
 *                   this model carry the materialized string. `value` IS the
 *                   text — that is what it is required for — so the model takes
 *                   it. Left alone, an object would land where a string is
 *                   declared and render as `[object Object]` rather than fail.
 *   `worktreePath`  R1 spells "unset" as ABSENT (model's `shape.ts` convention);
 *   `branch`        the legacy wire spells it `null`. Same fact, and the UI's
 *                   `?? null` readers only see one of the two.
 *
 * Rewriting them here rather than widening `IssueViewModel` keeps ONE spelling
 * in front of the UI during the additive cutover: POD-797 deletes the legacy
 * collection, and at that point this function is what changes, not every reader.
 */
function projectionOnLegacySpelling(projection: IssueProjection): Omit<
  IssueProjection,
  'description' | 'worktreePath' | 'branch'
> & {
  description: string
  worktreePath: string | null
  branch: string | null
} {
  return {
    ...projection,
    description: projection.description.value,
    worktreePath: projection.worktreePath ?? null,
    branch: projection.branch ?? null,
  }
}

/** Replica-derived issue world. One pass; the React binding caches this. */
export function deriveIssueViewsSnapshot(replica: Replica): IssueViewsSnapshot {
  const { issues, sessions } = readViewInputs(replica)
  const views = deriveIssueViews(issues, sessions)
  const sessionIndex = new Map(sessions.map((s) => [s.sessionId, s]))
  const issueIndex = new Map(issues.map((i) => [i.id, i]))
  const rollupCache = new Map<string, IssueSessionRollups>()
  return {
    views,
    tree: buildIssueTree(views, issues),
    issues,
    sessions,
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

/**
 * Flat render models keyed by id. Same merge the React hook uses: legacy
 * supplement + projection spelling + derived view + session rollups (`unread`).
 */
export function buildIssueViewModels(
  snapshot: IssueViewsSnapshot,
  projectionRows: readonly IssueProjection[],
  legacyRows: readonly IssueWire[],
): Map<string, IssueViewModel> {
  const models = new Map<string, IssueViewModel>()
  const legacyById = new Map(legacyRows.map((issue) => [issue.id, issue]))
  const sessionById = new Map(snapshot.sessions.map((session) => [session.sessionId, session]))
  for (const projection of projectionRows) {
    const view = snapshot.views.get(projection.id)
    if (!view) continue
    const { id: _id, ...derived } = view
    const legacy = legacyById.get(projection.id)
    const {
      commentCount: _commentCount,
      displayRef: _displayRef,
      ready: _ready,
      blocked: _blocked,
      deferred: _deferred,
      childCount: _childCount,
      childDoneCount: _childDoneCount,
      dependents: _dependents,
      ...legacySupplement
    } = legacy ?? ({} as IssueWire)
    models.set(projection.id, {
      ...legacySupplement,
      ...projectionOnLegacySpelling(projection),
      ...derived,
      ...deriveIssueRollups(projection, view.memberSessionIds, (id) => sessionById.get(id)),
    } as IssueViewModel)
  }
  return models
}

export function issueViewModelsFromReplica(
  replica: Replica,
  projectionRows: readonly IssueProjection[] = replica.rows('issueProjections'),
  legacyRows: readonly IssueWire[] = replica.rows('issues'),
): Map<string, IssueViewModel> {
  return buildIssueViewModels(deriveIssueViewsSnapshot(replica), projectionRows, legacyRows)
}
