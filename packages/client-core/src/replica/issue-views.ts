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

import type { SessionMeta } from '@podium/model'
import type { IssueProjectionRow } from './contract'
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
  /** Incoming dependency edges — the issues that point AT this one, `{ id:
   *  fromId, type }`. The reverse of every other issue's `deps`; derived here in
   *  one O(deps) pass so `dependents` never rode the wire (an edge A→B changing
   *  B's `dependents` with no write on B is the same cross-entity ripple `deps`
   *  and `blocked` are). Real dependency edges only — parent/child is carried by
   *  `childIds`, not synthesized in here (issue_deps stores no parent-child row,
   *  #164). Replaces the legacy `IssueWire.dependents`. */
  dependents: Array<{ id: string; type: string }>
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
  updatedAt: string
  deletedAt?: string | null
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
  // Reverse of every issue's `deps`: an edge A→B (A's dep on B) contributes B a
  // dependent { id: A, type }. Built once here in O(deps) so `dependents` is a
  // local derivation, never a wire field — the same reason `blocked` is (both
  // read OTHER issues' edges, so folding either onto B's row would make an edge
  // touching A rewrite B).
  const dependentsByIssue = new Map<string, { id: string; type: string }[]>()
  for (const issue of issues) {
    const parentId = issue.parentId
    if (parentId) {
      const kids = childrenByParent.get(parentId)
      if (kids) kids.push(issue.id)
      else childrenByParent.set(parentId, [issue.id])
    }
    for (const dep of issue.deps ?? []) {
      const dependent = { id: issue.id, type: dep.type }
      const list = dependentsByIssue.get(dep.id)
      if (list) list.push(dependent)
      else dependentsByIssue.set(dep.id, [dependent])
    }
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
      dependents: dependentsByIssue.get(issue.id) ?? [],
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
  issue: Pick<IssueViewInput, 'readAt' | 'updatedAt' | 'deletedAt'>,
  memberSessionIds: readonly string[],
  sessionById: (id: string) => SessionViewInput | undefined,
): IssueSessionRollups {
  const byPhase: Record<string, number> = {}
  let total = 0
  // Match the server's authoritative email-style rule: the issue's own row is
  // activity too, so a never-read issue is unread even before it has sessions.
  const readAt = issue.readAt ? Date.parse(issue.readAt) : null
  let unread = readAt === null || !Number.isFinite(readAt)
  if (!unread && readAt !== null) {
    const updatedAt = Date.parse(issue.updatedAt)
    unread = Number.isFinite(updatedAt) && updatedAt > readAt
  }
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
  return { unread: issue.deletedAt ? false : unread, sessionSummary: { total, byPhase } }
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

/**
 * Assemble the views' inputs from the replica [POD-822 — THE cutover].
 *
 * Before POD-822 this cast one collection — `rows('issues') as IssueViewInput` —
 * because the legacy `IssueWire` carried `deps` and `prefix` as its own fields.
 * That cast compiled clean against `IssueProjection` too, and THAT was the trap
 * the deleted `ViewFieldsMissingFromProjection` tripwire guarded: the projection
 * carries neither field (an edge belongs to two issues, a prefix to a repo — see
 * model's `issue/dep.ts` and `repo/fields.ts`), so `deps ?? []` read "no
 * dependencies" and every blocked issue derived `blocked: false`.
 *
 * The three-collection JOIN is the fix, and it is where D7.3 actually happens:
 *
 *  - `issueProjections` — the issue's own durable row. The source now.
 *  - `issueDeps` — the edges, indexed by `fromId`. Issue X's `deps` are the
 *    edges leaving X, each `{ id: toId, type }` — exactly what `deriveIssueViews`
 *    reads. An edge add/remove touches ONE row here and re-derives `blocked` on
 *    both endpoints for free; no issue was rewritten to make that happen.
 *  - `repos` — `(id, prefix)`, indexed by `id`. `displayRef` joins
 *    `issue.repoId → repo.prefix`. A prefix change moves one repo row and every
 *    `POD-13` in the repo follows; no issue was rewritten.
 *
 * The join is O(issues + deps + repos), not O(issues × anything): the two
 * indexes below are built once. `deriveIssueViews` and `IssueViewInput` did not
 * change — only their SOURCE did — which is the whole reason the cutover is this
 * one function.
 *
 * Empty collections (the cap not yet flipped) yield empty views, not wrong ones:
 * no issues in, no views out. Nothing renders from these views today; POD-797
 * flips the cap and deletes the legacy `issues` collection this no longer reads.
 */
export function readViewInputs(replica: Replica): {
  issues: IssueViewInput[]
  sessions: SessionViewInput[]
} {
  const projections = replica.rows('issueProjections')
  const prefixByRepoId = new Map<string, string | null>()
  for (const repo of replica.rows('repos')) prefixByRepoId.set(repo.id, repo.prefix ?? null)
  const depsByFrom = new Map<string, { id: string; type: string }[]>()
  for (const dep of replica.rows('issueDeps')) {
    const list = depsByFrom.get(dep.fromId)
    const edge = { id: dep.toId, type: dep.type }
    if (list) list.push(edge)
    else depsByFrom.set(dep.fromId, [edge])
  }
  return {
    issues: projections.map((p) => projectionToViewInput(p, prefixByRepoId, depsByFrom)),
    sessions: replica.rows('sessions') as unknown as SessionViewInput[],
  }
}

/**
 * One `IssueProjection` + the two joins → one `IssueViewInput`.
 *
 * Written as an explicit object rather than a spread-and-override so the return
 * is CHECKED against `IssueViewInput` field by field — this is what replaces the
 * deleted tripwire. If a field the views read leaves `IssueProjection`, this
 * stops compiling HERE, at the join, rather than deriving a wrong answer in a UI.
 * `prefix` and `deps` are supplied by the joins, never read off the projection —
 * the projection has neither, by construction.
 */
function projectionToViewInput(
  p: IssueProjectionRow,
  prefixByRepoId: Map<string, string | null>,
  depsByFrom: Map<string, { id: string; type: string }[]>,
): IssueViewInput {
  return {
    id: p.id,
    seq: p.seq,
    parentId: p.parentId ?? null,
    prefix: p.repoId ? (prefixByRepoId.get(p.repoId) ?? null) : null,
    stage: p.stage,
    deferUntil: p.deferUntil ?? null,
    readAt: p.readAt ?? null,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt ?? null,
    deps: depsByFrom.get(p.id) ?? [],
  }
}

/** Type-level proof that a session row satisfies the view input — the sessions
 *  collection is still cast (sessions are not modelled yet), so this is the one
 *  cast left and the assertion that keeps it honest [POD-796/POD-822]. The
 *  issue side no longer needs a satisfies-assertion: `projectionToViewInput`
 *  builds a checked `IssueViewInput` directly, so the compiler proves the same
 *  property at the construction site. */
export type SessionMetaSatisfiesViewInput = SessionMeta extends SessionViewInput ? true : never
const _sessionMetaSatisfies: SessionMetaSatisfiesViewInput = true
