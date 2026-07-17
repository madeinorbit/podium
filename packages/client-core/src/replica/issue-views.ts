/**
 * Issue views, derived AT THE REPLICA [ADR 4 D7.3].
 *
 * This module is the pilot's payoff. POD-791 removed nine fields from the issue
 * wire — `sessions`, `sessionSummary`, `unread`, `ready`, `blocked`, `deferred`,
 * `childCount`, `childDoneCount`, `commentCount`, `displayRef` — not because the
 * UI stopped needing them but because every one of them is a function of
 * something OTHER than the issue's own durable row, and computing them
 * server-side put cross-entity work on the write path. D7.2 states the rule: *a
 * change to entity X may trigger recomputation only of projections of X.* The
 * measured cost of breaking it was p50 711ms ×2 per switch at 530-session scale
 * (POD-701/772), because one session's phase change rebuilt every issue's wire
 * payload.
 *
 * They are all re-derived here instead, and here the join is free: the client
 * already holds the world, so membership is an index over sessions it has rather
 * than a fan-out over issues it must rebuild.
 *
 * ## Two derivation shapes, and why they are not the same shape
 *
 * **Membership** (which sessions work this issue) is a live query with
 * `includes` — a subquery nested inside `.select()`. Measured O(delta) and FLAT:
 * session-delta p50 0.0185ms at 600 issues / 500 sessions, 0.0441ms at 600 /
 * 8000 (POD-794). Sixteen times the sessions does not move it.
 *
 * **Rollups over session CONTENT** (`unread`, `sessionSummary`) are NOT computed
 * in that query, and the reason is a measured event-semantics finding rather
 * than a preference: **a child change emits ZERO events on the parent row** (1 on
 * the nested collection). That is exactly what makes the tree O(delta) — no
 * parent churn — and it means a binding subscribed only to the tree would show
 * an `unread` that never moves. It would fail SILENTLY: no error, no warning,
 * just a number that is wrong. So content rollups are computed by the BINDING,
 * which subscribes to the issues and the sessions collections separately, from
 * the ids the tree hands it. See `deriveIssueRollups` and the pin in
 * `issue-views.test.ts` ("a session change moves the issue's unread").
 *
 * ## Zero embedded SessionMeta — anywhere
 *
 * No view model in this file carries a `SessionMeta`. They carry
 * `memberSessionIds`, and a consumer that needs a session resolves it by id
 * against the sessions the client already holds. That is D7.1's "references
 * other entities by branded id only" applied one layer up: the wire stopped
 * embedding sessions, and a view that re-embedded them would put the same
 * O(world) rebuild back, just on the client.
 */

import type { IssueProjection } from '@podium/model'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import type { Replica } from './replica'

/**
 * One issue, as a view.
 *
 * Everything here is either the issue's own durable field or a derivation that
 * is O(this issue's neighbourhood) — never O(world).
 */
export interface IssueView {
  id: string
  /** Sessions working this issue, BY ID. Never the sessions themselves. */
  memberSessionIds: string[]
  /** `POD-13`, or `#13` before a repo has a prefix. Derived from (prefix, seq) —
   *  server-side this meant a repo's prefix change recomputed every issue in it. */
  displayRef: string
  /** Direct children (`parentId === this.id`). */
  childIds: string[]
  childCount: number
  childDoneCount: number
  /** An open issue that something unfinished `blocks`. Reads OTHER issues'
   *  stages, which is why it cannot live on the wire: closing B recomputes A. */
  blocked: boolean
  /** Not blocked, not deferred, not done — pickable now. */
  ready: boolean
  /** Snoozed into the future. */
  deferred: boolean
}

/** Rollups over member sessions' CONTENT. Split from {@link IssueView} because
 *  they invalidate on a different signal — see the module note. */
export interface IssueSessionRollups {
  unread: boolean
  sessionSummary: { total: number; byPhase: Record<string, number> }
}

/** The issue fields these derivations read. Structural rather than `IssueWire`
 *  so the POD-796 cutover to `IssueProjection` re-points ONE type alias: every
 *  field named here exists under both spellings, which is the whole reason the
 *  cutover can be mechanical. */
export interface IssueViewInput {
  id: string
  seq: number
  parentId?: string | null
  prefix?: string | null
  stage: string
  status?: string
  deferUntil?: string | null
  readAt?: string | null
  deps?: Array<{ id: string; type: string }>
}

/** The session fields these derivations read. Ids and scalars only. */
export interface SessionViewInput {
  sessionId: string
  issueId?: string | null
  phase?: string | null
  lastActiveAt?: string | null
}

/**
 * Membership, derived the way the wire cannot: an index over `session.issueId`.
 *
 * POD-791 shipped `IssueProjection.memberSessionIds` with an explicit
 * self-destruct condition — *"If POD-795 finds the local index sufficient, this
 * field should be deleted rather than maintained"* — and this function is that
 * finding. Two independent reasons, recorded because the field's author asked
 * for the decision to be made deliberately rather than inherited:
 *
 * 1. **It is free.** POD-794 measured the tree built this way round: session
 *    delta p50 0.0185ms → 0.0441ms across a 16× growth in sessions. A local
 *    index is not merely "sufficient", it costs nothing.
 * 2. **It is one spelling of the edge, not two.** `session.issue_id` is where
 *    membership is STORED. A `memberSessionIds` on the issue is a second source
 *    of truth for the same edge, and nothing in the model arbitrates between
 *    them: a replica can hold an issue claiming session S while S claims another
 *    issue, and neither the vocabulary nor the mapping pair says which wins.
 *
 * The one rationale that survived scrutiny was bootstrap ordering — a replica
 * holding issues but not yet sessions cannot derive membership from an index
 * over sessions it lacks. ADR 2 D6 closes it: bootstrap installs every kind in
 * ONE atomic swap, so "issues without sessions" is not a state a replica can
 * observe. The transient does not exist, so the field defending it need not.
 */
export function indexSessionsByIssue(sessions: readonly SessionViewInput[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const session of sessions) {
    const issueId = session.issueId
    if (issueId === undefined || issueId === null || issueId === '') continue
    const ids = index.get(issueId)
    if (ids) ids.push(session.sessionId)
    else index.set(issueId, [session.sessionId])
  }
  return index
}

/** `POD-13` — or `#13` when the repo has no prefix yet. */
export function issueDisplayRef(issue: Pick<IssueViewInput, 'seq' | 'prefix'>): string {
  return issue.prefix ? `${issue.prefix}-${issue.seq}` : `#${issue.seq}`
}

/**
 * Build every issue's view in one pass.
 *
 * O(issues + sessions + deps), not O(issues × sessions): the three indexes below
 * are what keep it linear, and a nested scan would reintroduce exactly the
 * O(world) shape D7.2 exists to forbid — just on the client instead of the
 * server, which is not an improvement.
 */
export function deriveIssueViews(
  issues: readonly IssueViewInput[],
  sessions: readonly SessionViewInput[],
  opts: { now?: () => number } = {},
): Map<string, IssueView> {
  const now = opts.now ?? Date.now
  const sessionsByIssue = indexSessionsByIssue(sessions)
  const stageById = new Map(issues.map((i) => [i.id, i.stage]))
  const childrenByParent = new Map<string, string[]>()
  for (const issue of issues) {
    const parentId = issue.parentId
    if (!parentId) continue
    const kids = childrenByParent.get(parentId)
    if (kids) kids.push(issue.id)
    else childrenByParent.set(parentId, [issue.id])
  }

  const views = new Map<string, IssueView>()
  for (const issue of issues) {
    const childIds = childrenByParent.get(issue.id) ?? []
    const childDoneCount = childIds.filter((id) => stageById.get(id) === 'done').length
    // `blocked`: something this issue depends on is not done yet. An unknown
    // dep id counts as NOT blocking — the alternative is that a replica which
    // has not yet seen a dependency renders every issue blocked, which is worse
    // than briefly rendering one ready.
    const blocked = (issue.deps ?? []).some(
      (dep) => dep.type === 'blocks' && stageById.has(dep.id) && stageById.get(dep.id) !== 'done',
    )
    const deferred = issue.deferUntil != null && Date.parse(issue.deferUntil) > now()
    views.set(issue.id, {
      id: issue.id,
      memberSessionIds: sessionsByIssue.get(issue.id) ?? [],
      displayRef: issueDisplayRef(issue),
      childIds,
      childCount: childIds.length,
      childDoneCount,
      blocked,
      deferred,
      ready: !blocked && !deferred && issue.stage !== 'done',
    })
  }
  return views
}

/**
 * Rollups over member sessions' content, for ONE issue.
 *
 * Takes ids + a session lookup rather than an issue and the session world: the
 * cost is proportional to this issue's members, which is what makes a session
 * change cheap to react to.
 */
export function deriveIssueRollups(
  issue: Pick<IssueViewInput, 'readAt'>,
  memberSessionIds: readonly string[],
  sessionById: (id: string) => SessionViewInput | undefined,
): IssueSessionRollups {
  const byPhase: Record<string, number> = {}
  let total = 0
  let unread = false
  const readAt = issue.readAt ? Date.parse(issue.readAt) : null
  for (const id of memberSessionIds) {
    const session = sessionById(id)
    // A member id with no session is normal, not an error: the session may be
    // mid-arrival. Counting it would report a total the user cannot see.
    if (!session) continue
    total++
    const phase = session.phase ?? 'unknown'
    byPhase[phase] = (byPhase[phase] ?? 0) + 1
    if (!unread && session.lastActiveAt) {
      const activeAt = Date.parse(session.lastActiveAt)
      if (Number.isFinite(activeAt) && (readAt === null || activeAt > readAt)) unread = true
    }
  }
  return { unread, sessionSummary: { total, byPhase } }
}

/** One node of the issue tree. Children nest; sessions do NOT. */
export interface IssueTreeNode {
  view: IssueView
  children: IssueTreeNode[]
}

/**
 * The issue tree — D7.3's worked example.
 *
 * Roots are issues with no parent, PLUS issues whose parent this replica does not
 * hold. The second half is not an edge case: an issue whose parent is filtered
 * out, not yet arrived, or archived would otherwise vanish from the tree
 * entirely — visible in no view, reachable from nothing. An orphan surfaces at
 * the root; it never disappears.
 */
export function buildIssueTree(
  views: Map<string, IssueView>,
  issues: readonly IssueViewInput[],
): IssueTreeNode[] {
  const parentById = new Map(issues.map((i) => [i.id, i.parentId ?? null]))
  const nodeById = new Map<string, IssueTreeNode>()
  for (const [id, view] of views) nodeById.set(id, { view, children: [] })

  const roots: IssueTreeNode[] = []
  for (const [id, node] of nodeById) {
    const parentId = parentById.get(id) ?? null
    const parent = parentId === null ? undefined : nodeById.get(parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** The board: issues grouped by stage. Every stage gets a key, including the
 *  empty ones — a board that hides its empty columns rearranges itself as work
 *  moves, which is not a board. */
export function buildIssueBoard(
  views: Map<string, IssueView>,
  issues: readonly IssueViewInput[],
  stages: readonly string[],
): Map<string, IssueView[]> {
  const board = new Map<string, IssueView[]>(stages.map((s) => [s, []]))
  for (const issue of issues) {
    const view = views.get(issue.id)
    if (!view) continue
    const column = board.get(issue.stage)
    if (column) column.push(view)
  }
  return board
}

/** Read the replica's issue + session rows as view inputs. The casts are the one
 *  place the wire shape meets the view shape; POD-796 re-points them at
 *  `IssueProjection` and nothing else in this file moves. */
export function readViewInputs(replica: Replica): {
  issues: IssueViewInput[]
  sessions: SessionViewInput[]
} {
  return {
    issues: replica.rows('issues') as unknown as IssueViewInput[],
    sessions: replica.rows('sessions') as unknown as SessionViewInput[],
  }
}

/** Type-level proof that the view inputs are satisfied by today's wire shapes —
 *  so the POD-796 cutover breaks compilation here rather than at runtime in a
 *  view. */
export type IssueWireSatisfiesViewInput = IssueWire extends IssueViewInput ? true : never
export type SessionMetaSatisfiesViewInput = SessionMeta extends SessionViewInput ? true : never

// The two aliases above were DECLARED but never instantiated, and a bare
// `type X = A extends B ? true : never` reports nothing when the condition is
// false — it silently becomes `never`. So the "breaks compilation here" the
// comment promises did not happen. These two lines are what make them fire
// [POD-796].
const _issueWireSatisfies: IssueWireSatisfiesViewInput = true
const _sessionMetaSatisfies: SessionMetaSatisfiesViewInput = true

/**
 * THE POD-796 CUTOVER GAP, pinned as a type [POD-822].
 *
 * Instantiating the assertions above is necessary but NOT sufficient, and the
 * difference is the whole trap: `prefix` and `deps` are OPTIONAL on
 * `IssueViewInput`, so `IssueProjection` — which carries neither — satisfies it
 * anyway. Re-pointing `ReplicaRows.issues` at the projection therefore compiles
 * clean and then quietly derives the WRONG ANSWER: `deps ?? []` reads a missing
 * relation as "no dependencies", so every blocked issue reports `blocked: false,
 * ready: true`, and `issueDisplayRef` falls back to `#13` for issues that should
 * read `POD-13`. Both are demonstrated in `issue-views.test.ts`.
 *
 * Making the two fields REQUIRED would state the dependency honestly, but it
 * cannot be done yet: nothing replica-side can supply them. `prefix` is a
 * function of the REPO (there is no 'repo' entity kind on the feed at all) and
 * `deps` is a relation in `issue_deps` that the feed does not carry. Until one
 * of those arrives, the views must keep reading `IssueWire`.
 *
 * So this records the gap instead, and it is deliberately a TRIPWIRE: the moment
 * `IssueProjection` gains `prefix` or `deps`, this stops compiling and whoever
 * added it is told to finish the cutover here rather than discovering the
 * fallback behaviour in a UI six months later.
 */
export type ViewFieldsMissingFromProjection = Exclude<'prefix' | 'deps', keyof IssueProjection>
const _cutoverGapIsExactlyPrefixAndDeps: 'prefix' | 'deps' =
  null as unknown as ViewFieldsMissingFromProjection
const _gapHasNotSilentlyClosed: ViewFieldsMissingFromProjection = null as unknown as
  | 'prefix'
  | 'deps'
