/**
 * Pure (React-free) issue view models [ADR 4 D7.3].
 *
 * `use-issue-views.ts` is the React binding over this file. The published
 * worklist also reads these models — it cannot import the hook without pulling
 * React into a platform-neutral slice, and it must not restate unread
 * derivation (POD-843).
 */
import {
  type IssueExecutionProjection,
  type IssueId,
  type IssueMarksWire,
  type IssueProjection,
  type IssueWire,
  joinIssueExecution,
  joinIssueMarks,
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
): IssueViewsSnapshot {
  const { issues, sessions } = readViewInputs(replica)
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
 * ONE issue's flat render model, or `undefined` when the row is not yet
 * publishable.
 *
 * Split out of {@link buildIssueViewModels} for POD-1053. The whole-map builder
 * used to be the only entry point, so the shared model cache had no way to
 * rebuild the ONE row a single-field mutation touched — it re-ran every issue in
 * the project and then deep-compared its way back to row identity. Everything a
 * model depends on is named in this signature: the snapshot (the replica-derived
 * world), the projection row, and the retained legacy row. Nothing else is read,
 * which is what lets the cache decide reuse by comparing exactly those three.
 */
export function buildIssueViewModel(
  snapshot: IssueViewsSnapshot,
  projection: IssueProjection,
  legacy: IssueWire | undefined,
  /**
   * THE OWNER-SCOPED PRIVATE HALF [B4, PDM-136], or `undefined` for an issue
   * this principal does not own.
   *
   * `undefined` is the ORDINARY case and must never be treated as missing data.
   * The four keys it carries left the broadcast payloads because a machine-local
   * path is not something a shared task exposes (ADR 9 Am.1 D13); a non-owner
   * therefore renders a complete task whose worktree path is simply unset, which
   * is byte-for-byte the state an unstarted issue has always presented. That is
   * why no reader downstream of this function needed changing: they all already
   * handle absence, because absence was always reachable.
   */
  execution?: IssueExecutionProjection,
  /**
   * THIS READER'S OWN marks for this issue (PDM-408), or `undefined`.
   *
   * `undefined` is the ORDINARY case here too, and for a plainer reason than
   * `execution`'s: most people have not touched most issues, and the store only
   * holds a row for an issue somebody has actually marked. It resolves to
   * `NEUTRAL_ISSUE_MARKS` — unpinned, unfolded, never read — which is what an
   * untouched issue has always looked like.
   *
   * IT IS NOT OPTIONAL IN THE SENSE `execution` IS. Skipping the join does not
   * leave the reader with less; it leaves them with the values `IssueWire` still
   * carries, which are now NEUTRAL for everybody and were, until PDM-408, the
   * EARLIEST ADMIN'S. That is why {@link joinIssueMarks} overwrites rather than
   * defaults: it is the last gate, and a producer that regressed and baked a
   * viewer's marks back into the broadcast would be caught here.
   */
  marks?: IssueMarksWire,
): IssueViewModel | undefined {
  const view = snapshot.views.get(projection.id)
  if (!view) return undefined
  // The additive cutover still gets several render-critical supplements from
  // IssueWire (repoPath among them). A projection can briefly outlive that row
  // while replica scopes/bootstrap state converge; publishing it as an
  // IssueViewModel would turn absent supplements into runtime `undefined`
  // behind a type that promises strings. Keep the partial row out of rich
  // surfaces until both halves of the model are present.
  if (!legacy) return undefined
  const { id: _id, ...derived } = view
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
  } = legacy
  // The retained issue row is the one cursor home: persistence and optimistic
  // overlays both write it, and unread is derived from that exact value.
  // THIS READER'S OWN marks, over the broadcast's neutral ones (PDM-408).
  // Applied to the legacy supplement BEFORE `readAt` is taken from it, because
  // `readAt` is the one cursor home — persistence, optimistic overlays and the
  // derived `unread` all key off this exact value, so taking it from the
  // unjoined row would leave every rollup below describing nobody's marks.
  const held = joinIssueMarks(legacySupplement, marks)
  const readAt = held.readAt ?? null
  return {
    ...held,
    // The private half goes on FIRST, under the projection's legacy spelling,
    // so the `?? null` normalisation below still decides the final value of
    // `worktreePath` — otherwise an owner's path would arrive as `undefined`
    // where every reader downstream expects `string | null`.
    ...projectionOnLegacySpelling(joinIssueExecution(projection, execution)),
    ...derived,
    readAt,
    ...deriveIssueRollups(
      { readAt, updatedAt: projection.updatedAt, deletedAt: projection.deletedAt },
      view.memberSessionIds,
      (id) => snapshot.sessionById.get(id),
    ),
  } as IssueViewModel
}

/**
 * Flat render models keyed by id. Same merge the React hook uses: legacy
 * supplement + projection spelling + derived view + session rollups (`unread`).
 */
export function buildIssueViewModels(
  snapshot: IssueViewsSnapshot,
  projectionRows: readonly IssueProjection[],
  legacyRows: readonly IssueWire[],
  executionRows: readonly IssueExecutionProjection[] = [],
  marksRows: readonly IssueMarksWire[] = [],
): Map<string, IssueViewModel> {
  const models = new Map<string, IssueViewModel>()
  const legacyById = new Map(legacyRows.map((issue) => [issue.id, issue]))
  // Indexed once per pass rather than scanned per issue: this builder is the
  // O(world) path POD-1053 split `buildIssueViewModel` out of, and a linear find
  // inside it would put the shape back.
  const executionByIssue = new Map(executionRows.map((row) => [row.issueId as string, row]))
  // Indexed once per pass, same reason as the line above.
  const marksByIssue = new Map(marksRows.map((row) => [row.issueId as string, row]))
  for (const projection of projectionRows) {
    const model = buildIssueViewModel(
      snapshot,
      projection,
      legacyById.get(projection.id),
      executionByIssue.get(projection.id),
      marksByIssue.get(projection.id),
    )
    if (model) models.set(projection.id, model)
  }
  return models
}

export function issueViewModelsFromReplica(
  replica: Replica,
  projectionRows: readonly IssueProjection[] = replica.rows('issueProjections'),
  legacyRows: readonly IssueWire[] = replica.rows('issues'),
  executionRows: readonly IssueExecutionProjection[] = replica.rows('issueExecutions'),
  marksRows: readonly IssueMarksWire[] = replica.rows('issueMarks'),
): Map<string, IssueViewModel> {
  return buildIssueViewModels(
    deriveIssueViewsSnapshot(replica),
    projectionRows,
    legacyRows,
    executionRows,
    marksRows,
  )
}
