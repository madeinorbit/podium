import { isIssueBlocked, isIssueClosed, isIssueColorSlot, isIssueDeferred } from '@podium/domain'
import type { IssueDepProjection, IssueProjection, RepoProjection } from '@podium/model'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { formatIssueRef, IssuePanel, parseIssueRef } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from '../../../issue-util'
import type { IssueRow } from '../../../store'
import { countIssueMembershipScan, countIssueWireBuild } from '../instrumentation'
import {
  issueDepProjectionRows,
  issueDepToProjection,
  issueProjectionRows,
  issueRowToProjection,
  repoProjectionRows,
} from '../projection'
import type { PublishSpec } from '../publish'
import type { IssueDeps } from './types'

// Member-session fields that DON'T feed issue wire data [POD-723] — the same
// denylist modules/sessions applies (POD-722). IssueWire.sessions embeds each
// SessionMeta verbatim, so a member's clientCount/controllerId/epoch change must
// NOT invalidate the cached wire: it never surfaces as issue member state, and
// the session broadcast already skips its own publish for that churn (POD-722).
const NON_ISSUE_MEMBER_FIELDS = ['clientCount', 'controllerId', 'epoch'] as const

/**
 * THE FLAG-OFF TRUTH for the three normalized kinds [POD-822]: an EMPTY feed,
 * not "no answer".
 *
 * The distinction is the difference between a rollback that works and one that
 * does not, and it only became load-bearing when POD-822 taught a client to READ
 * these rows. `undefined` means "I cannot state the truth — leave the baseline
 * alone" (an unprojectable row; the service not constructed yet). Flag-off is not
 * that. It is a positive statement: the normalized feed carries nothing.
 *
 * Returning `undefined` for it would leave the rows the flag had already
 * published sitting in the ledger baseline AND in every client's PERSISTENT
 * replica — so flipping the flag off would not restore the legacy path, it would
 * freeze every client on whatever the normalized feed last said, across reloads.
 * A flag whose off position does not roll back is not a flag, and this one is the
 * rollback switch for the whole cutover.
 *
 * POD-796's "flag off ⇒ byte-identical legacy behaviour" survives intact, by
 * construction rather than by assertion: on a server where the flag was never on,
 * the baseline for these kinds is empty, and `reconcile(kind, [])` against an
 * empty baseline stages nothing and appends nothing (ledger.ts `reconcile` →
 * `stage([])` → no `appendChanges`). It is also strictly CHEAPER than before —
 * the rows are never built. The only server that appends anything here is one
 * that HAD the flag on, and what it appends is exactly the removes that undo it,
 * once.
 */
const EMPTY_NORMALIZED_TRUTH: [] = []

/** Issue-relevant fingerprint of one member session, for the wire memo key. */
function memberSessionFingerprint(s: SessionMeta): string {
  const proj: Record<string, unknown> = { ...s }
  for (const f of NON_ISSUE_MEMBER_FIELDS) delete proj[f]
  return JSON.stringify(proj)
}

/**
 * IssueService layer 0 — shared state and primitives (issue #190 split).
 *
 * The service is one class split along its seams into an inheritance chain
 * (core → reads → crud → attention → mail → workflow → IssueService); this
 * layer owns the hydrated row map, the wire serializer, ref resolution and the
 * persist/broadcast tail every mutation funnels through.
 */
export abstract class IssueServiceCore {
  /** Hydrated row cache; null until the first {@link init}/lazy access. Kept out
   *  of the constructor so constructing the service can never crash-loop the
   *  server boot on bad data (the composition root calls init() explicitly;
   *  everything else lazily hydrates on first touch). */
  private hydrated: Map<string, IssueRow> | null = null
  constructor(protected readonly deps: IssueDeps) {}

  // Dirty-scoped issue wire rebuild [POD-723]. One built IssueWire per issue,
  // keyed by a fingerprint of that issue's OWN toWire inputs. On a session-driven
  // publish (the O(issues×sessions) publishIssues path POD-701 measured), no issue
  // row/label/dep/comment changed, so `issueInputsGen` is stable and only issues
  // whose member sessions moved rebuild — everything else reuses its cached
  // payload, skipping toWire's per-issue store queries + O(issues) children scan.
  // Interim until POD-308 deletes the snapshot fan-out.
  private readonly wireCache = new Map<string, { key: string; wire: IssueWire }>()
  // Bumped on EVERY issue-side input change (row upsert, labels, deps, comments,
  // read state, hierarchy, archive, delete). Coarse by design: any issue mutation
  // invalidates the whole memo — that path already rebuilds the full list and is
  // not the hot one. It is NEVER bumped by the session-driven publish, which is
  // exactly where the memo pays off. Cross-issue derived ripples (a close flipping
  // dependents' blocked/ready) are covered because the mutation that caused them
  // bumps this counter, invalidating the affected rows' cache too.
  private issueInputsGen = 0

  /** Signal that some issue-side input feeding {@link toWire} changed, so cached
   *  wire payloads must be rebuilt on the next list() [POD-723]. */
  protected bumpIssueInputs(): void {
    this.issueInputsGen++
  }

  /** The in-memory row map, lazily hydrated. Row-level quarantine lives in the
   *  store (listIssueRows skips + logs + counts corrupt rows), so hydration is
   *  total: a corrupt row costs that row, never the boot. */
  protected get rows(): Map<string, IssueRow> {
    if (this.hydrated === null) this.hydrate()
    return this.hydrated as Map<string, IssueRow>
  }

  /** Explicit hydration for the composition root (relay) — same load the lazy
   *  path performs, done eagerly so boot surfaces load logs immediately. */
  init(): this {
    this.hydrate()
    return this
  }

  /** Clear and re-hydrate the in-memory row map from the store. Lets tests (and
   *  future external mutators) refresh `this.rows` after a direct store write. */
  reload(): void {
    this.hydrate()
  }

  private hydrate(): void {
    const map = new Map<string, IssueRow>()
    for (const r of this.deps.store.issues.listIssueRows()) map.set(r.id, r)
    this.hydrated = map
    // Wholesale row replacement invalidates every cached wire, and dropping the
    // map also prunes entries for purged issues (bounds memory to live issues)
    // [POD-723].
    this.wireCache.clear()
    this.bumpIssueInputs()
  }

  /** Worktree paths of all issues (for cwd-based worker-role resolution). */
  worktreePaths(): string[] {
    return [...this.rows.values()]
      .filter((r) => !r.deletedAt)
      .map((r) => r.worktreePath)
      .filter((p): p is string => !!p)
  }

  protected now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  protected isClosed(row: IssueRow): boolean {
    return !!row.deletedAt || isIssueClosed(row)
  }

  protected isDeferred(row: IssueRow): boolean {
    return isIssueDeferred(row, this.now())
  }

  /** Email-style unread (issue #124): there is activity the operator hasn't seen.
   *  Activity = the latest of the issue's updatedAt and any member session's
   *  lastActiveAt (the same recency notion the sidebar uses). readAt null = never
   *  opened → unread (updatedAt always exists). Kept cheap: no event-log scan, since
   *  every meaningful mutation already bumps updatedAt. */
  protected computeUnread(row: IssueRow, sessions: SessionMeta[]): boolean {
    if (row.deletedAt) return false
    if (row.readAt == null) return true
    const readMs = Date.parse(row.readAt)
    if (!Number.isFinite(readMs)) return true
    const times = [Date.parse(row.updatedAt), ...sessions.map((s) => Date.parse(s.lastActiveAt))]
    let lastActivity = Number.NEGATIVE_INFINITY
    for (const t of times) if (Number.isFinite(t) && t > lastActivity) lastActivity = t
    return lastActivity > readMs
  }

  /** blocked = open AND ≥1 `blocks` dep whose target issue is not closed. */
  protected computeBlocked(row: IssueRow): boolean {
    const blocksTargets = this.deps.store.issues
      .listIssueDeps(row.id)
      .filter((d) => d.type === 'blocks')
      .map((d) => this.rows.get(d.toId))
    return isIssueBlocked(row, blocksTargets)
  }

  /** Serialize one issue. `sessionList` lets multi-issue serializers (list/allWire/
   *  search/stats/…) compute the session list ONCE and share it — per-issue
   *  `deps.listSessions()` calls were the boot-storm hot path (66 sessions × 60
   *  issues per broadcast). Omitting it (single-issue paths) fetches a fresh list.
   *  `commentCounts` is the same batching for the comment COUNT (#175): list
   *  serializers pass one GROUP BY map; single-issue paths run one scalar COUNT.
   *  Comment BODIES never ride the wire anymore — fetch via comments(id). */
  toWire(
    row: IssueRow,
    sessionList: SessionMeta[] = this.deps.listSessions(),
    commentCounts?: Map<string, number>,
  ): IssueWire {
    // The D7.2 evidence seam [POD-796]. This line is the reason the bypass is
    // provable rather than merely plausible: it counts the per-issue LEGACY wire
    // build — the one that embeds SessionMeta[] and therefore couples issues to
    // session churn. Diagnostic only; nothing branches on it.
    countIssueWireBuild()
    const sessions = row.deletedAt ? [] : sessionsForIssue(row.worktreePath, sessionList, row.id)
    const labels = this.deps.store.issues.getIssueLabels(row.id)
    const children = [...this.rows.values()].filter((r) => r.parentId === row.id && !r.deletedAt)
    // Wire deps/dependents keep carrying the parent-child edges for client
    // compatibility, but they are SYNTHESIZED from parent_id / children —
    // issue_deps stores only real dependency types (#164).
    const deps = [
      ...this.deps.store.issues.listIssueDeps(row.id).map((d) => ({ id: d.toId, type: d.type })),
      ...(row.parentId ? [{ id: row.parentId, type: 'parent-child' }] : []),
    ]
    const dependents = [
      ...this.deps.store.issues.listDependents(row.id).map((d) => ({ id: d.fromId, type: d.type })),
      ...children.map((c) => ({ id: c.id, type: 'parent-child' })),
    ]
    const commentCount = commentCounts
      ? (commentCounts.get(row.id) ?? 0)
      : this.deps.store.issues.countIssueComments(row.id)
    const blocked = this.computeBlocked(row)
    const deferred = this.isDeferred(row)
    const ready = !this.isClosed(row) && !deferred && !blocked
    const prefix = this.deps.store.repos.prefixForPath(row.repoPath)
    const displayRef = prefix ? formatIssueRef(prefix, row.seq) : `#${row.seq}`
    return {
      id: row.id,
      repoPath: row.repoPath,
      ...(row.repoId ? { repoId: row.repoId } : {}),
      ...(prefix ? { prefix } : {}),
      displayRef,
      // Per-entity revision (ADR 2 D3) — assigned by upsertIssue at the SQL
      // write, so this projection carries the COMMITTED token only when taken
      // after the write. Spread-conditionally like the other optionals: a row
      // that has never been written has no revision, and an absent field is
      // honest where a fabricated 1 would claim a write that never happened.
      ...(row.revision === undefined ? {} : { revision: row.revision }),
      seq: row.seq,
      title: row.title,
      description: row.description,
      stage: row.stage as IssueWire['stage'],
      worktreePath: row.worktreePath,
      branch: row.branch,
      parentBranch: row.parentBranch,
      defaultAgent: row.defaultAgent,
      defaultModel: row.defaultModel,
      defaultEffort: row.defaultEffort,
      ...(row.machineId ? { machineId: row.machineId } : {}),
      ...(row.linearId ? { linearId: row.linearId } : {}),
      ...(row.linearIdentifier ? { linearIdentifier: row.linearIdentifier } : {}),
      ...(row.linearUrl ? { linearUrl: row.linearUrl } : {}),
      ...(row.activityNotes ? { activityNotes: row.activityNotes } : {}),
      ...(row.notesUpdatedAt ? { notesUpdatedAt: row.notesUpdatedAt } : {}),
      ...(row.suggestedStage ? { suggestedStage: row.suggestedStage as IssueWire['stage'] } : {}),
      ...(row.suggestedReason ? { suggestedReason: row.suggestedReason } : {}),
      blockedBy: row.blockedBy,
      ...(row.dependencyNote ? { dependencyNote: row.dependencyNote } : {}),
      ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      priority: row.priority,
      type: row.type as IssueWire['type'],
      pinned: row.pinned,
      // Guarded so a corrupt/unknown stored value degrades to "no colour"
      // rather than failing the whole issue's wire parse [spec:SP-b4d1].
      ...(isIssueColorSlot(row.color) ? { color: row.color } : {}),
      needsHuman: row.needsHuman,
      ...(row.humanQuestion ? { humanQuestion: row.humanQuestion } : {}),
      ...(row.humanQuestionOptions?.length
        ? { humanQuestionOptions: row.humanQuestionOptions }
        : {}),
      ...(row.humanQuestionAskedBy ? { humanQuestionAskedBy: row.humanQuestionAskedBy } : {}),
      ...(row.humanQuestionAskedAt ? { humanQuestionAskedAt: row.humanQuestionAskedAt } : {}),
      ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
      ...(row.duplicateOf ? { duplicateOf: row.duplicateOf } : {}),
      ...(row.assignee ? { assignee: row.assignee } : {}),
      ...(row.parentId ? { parentId: row.parentId } : {}),
      ...(row.design ? { design: row.design } : {}),
      ...(row.acceptance ? { acceptance: row.acceptance } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.dueAt ? { dueAt: row.dueAt } : {}),
      ...(row.deferUntil ? { deferUntil: row.deferUntil } : {}),
      ...(row.closedReason ? { closedReason: row.closedReason } : {}),
      ...(row.estimateMin != null ? { estimateMin: row.estimateMin } : {}),
      ...(row.panel ? { panel: this.parsePanel(row) } : {}),
      labels,
      deps,
      dependents,
      commentCount,
      ready,
      blocked,
      deferred,
      childCount: children.length,
      childDoneCount: children.filter((c) => this.isClosed(c)).length,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived,
      readAt: row.readAt ?? null,
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
      unread: this.computeUnread(row, sessions),
      sessions,
      sessionSummary: summarizeSessions(sessions),
      origin: row.origin === 'agent' ? 'agent' : 'human',
      audience: row.audience === 'agent' ? 'agent' : 'human',
      draft: row.draft ?? false,
    }
  }

  list(repoPath?: string): IssueWire[] {
    const sessionList = this.deps.listSessions()
    const commentCounts = this.deps.store.issues.countIssueCommentsByIssue()
    // POD-723 memo inputs, computed ONCE per list() so the per-issue key stays
    // cheap. Each session is projected to its issue-relevant slice (the same trio
    // POD-722 ignores is dropped, so pure attach/detach churn can't force a
    // rebuild). Prefixes feed displayRef and change out-of-band of any issue
    // mutation, so they ride the key too — resolved once per repoPath (few repos).
    const projById = new Map<string, string>()
    for (const s of sessionList) projById.set(s.sessionId, memberSessionFingerprint(s))
    const prefixByPath = new Map<string, string>()
    const prefixFor = (p: string): string => {
      let v = prefixByPath.get(p)
      if (v === undefined) {
        v = this.deps.store.repos.prefixForPath(p) ?? ''
        prefixByPath.set(p, v)
      }
      return v
    }
    return [...this.rows.values()]
      .filter((r) => this.inRepoScope(r, repoPath))
      .sort((a, b) => {
        // Group by repo_id (not path) so the unified list of an origin checked out at
        // two paths reads as one seq-ordered run rather than splitting per path (#140).
        const ga = a.repoId ?? a.repoPath
        const gb = b.repoId ?? b.repoPath
        return ga === gb ? a.seq - b.seq : ga.localeCompare(gb)
      })
      .map((r) => this.toWireMemo(r, sessionList, commentCounts, projById, prefixFor(r.repoPath)))
  }

  /** Cached {@link toWire} for the multi-issue list path [POD-723]. Reuses the last
   *  built payload when this issue's own inputs (issueInputsGen + its member
   *  sessions' issue-relevant projections + its repo prefix) are unchanged; only
   *  the dirty issues pay the full per-issue store-query rebuild. Single-issue
   *  toWire callers deliberately bypass this — they always want a fresh build. */
  private toWireMemo(
    row: IssueRow,
    sessionList: SessionMeta[],
    commentCounts: Map<string, number>,
    projById: Map<string, string>,
    prefix: string,
  ): IssueWire {
    // The D7.2 unit: this issue is being TOUCHED by the list path, and the scan
    // below filters the whole session list. Counted even on a memo HIT, because
    // the scan happens either way — that is the point (POD-723 removes the
    // rebuild, not the O(issues × sessions) scan). See instrumentation.ts.
    countIssueMembershipScan()
    const members = row.deletedAt ? [] : sessionsForIssue(row.worktreePath, sessionList, row.id)
    // sessionList order is stable, so the joined projection is a stable per-issue
    // membership fingerprint (captures joins/leaves AND any member field change).
    const memberKey = members.map((s) => projById.get(s.sessionId) ?? '').join('\u0001')
    const key = `${this.issueInputsGen}\u0000${prefix}\u0000${memberKey}`
    const cached = this.wireCache.get(row.id)
    if (cached && cached.key === key) return cached.wire
    const wire = this.toWire(row, sessionList, commentCounts)
    this.wireCache.set(row.id, { key, wire })
    return wire
  }

  /** Parse the stored panel JSON, tolerating legacy/garbage values (empty panel). */
  protected parsePanel(row: IssueRow): IssuePanel {
    if (!row.panel) return { todos: [], artifacts: [], deferred: [] }
    try {
      return IssuePanel.parse(JSON.parse(row.panel))
    } catch {
      return { todos: [], artifacts: [], deferred: [] }
    }
  }

  /** True when `row` belongs to the repo identified by `repoPath`, compared by the
   *  stable `repo_id` so every checkout of one origin unifies (#140); falls back to
   *  path equality only when a repo_id can't be resolved. `undefined` scope matches all. */
  protected inRepoScope(row: IssueRow, repoPath: string | undefined): boolean {
    if (!repoPath) return true
    const scope = this.deps.store.repos.resolveRepoIdForPath(repoPath)
    const rowRepoId = row.repoId ?? this.deps.store.repos.resolveRepoIdForPath(row.repoPath)
    return rowRepoId === scope
  }

  /** Resolve an issue reference to the internal id. Accepts the internal `iss_…` id
   *  (passthrough), a display seq (`10` / `#10` — what list/prime/search print), or a
   *  repo-qualified ref (`<repoPath>#10`, the form the ambiguity error prints; a
   *  trailing path suffix like `podium#10` works when it matches exactly one repo).
   *  Seq is unique per repo_id; when several repos share a bare seq the caller may
   *  pass `scopeRepoPath` to narrow to its own repo (so an agent's own `#N` resolves
   *  without the full id, #140). Still-ambiguous refs throw; unresolvable refs return
   *  the input unchanged so the caller's normal unknown-issue error fires. */
  resolveRef(ref: string, scopeRepoPath?: string): string {
    if (ref.startsWith('iss_') || this.rows.has(ref)) return ref
    // Human-facing nice id `PREFIX-seq` (#474). The prefix identifies the repo
    // server-wide, so this resolves without a path qualifier. A prefix that no
    // repo owns falls through to the other branches (and ultimately returns the
    // input unchanged so the caller's unknown-issue error fires).
    // CLI courtesy: `pod-13` reads as `POD-13` (prefixes are uppercase by grammar).
    const nice = parseIssueRef(ref.trim().toUpperCase())
    if (nice) {
      const repo = this.deps.store.repos.repoForPrefix(nice.prefix)
      if (repo) {
        const repoId = repo.repoId ?? this.deps.store.repos.resolveRepoIdForPath(repo.path)
        const matches = [...this.rows.values()].filter(
          (r) =>
            r.seq === nice.seq &&
            (r.repoId ?? this.deps.store.repos.resolveRepoIdForPath(r.repoPath)) === repoId,
        )
        if (matches.length >= 1) return matches[0]!.id
      }
    }
    const qualified = /^(.+)#(\d+)$/.exec(ref.trim())
    if (qualified) {
      const [, repo, seqStr] = qualified
      const seq = Number(seqStr)
      // Repo qualifier matches the display path (exact or trailing suffix like
      // `podium#10`) OR the stable repo_id (#164) — path stays a lookup attribute.
      const matches = [...this.rows.values()].filter(
        (r) =>
          r.seq === seq &&
          (r.repoPath === repo || r.repoPath.endsWith(`/${repo}`) || r.repoId === repo),
      )
      if (matches.length === 1) return matches[0]!.id
      if (matches.length > 1) {
        const where = matches.map((r) => `${r.repoPath}#${r.seq} (${r.id})`).join(', ')
        throw new Error(`ambiguous issue ref ${ref} (matches ${where})`)
      }
      return ref
    }
    const m = /^#?(\d+)$/.exec(ref.trim())
    if (!m) return ref
    const seq = Number(m[1])
    let matches = [...this.rows.values()].filter((r) => r.seq === seq)
    if (matches.length > 1 && scopeRepoPath) {
      const scoped = matches.filter((r) => this.inRepoScope(r, scopeRepoPath))
      if (scoped.length > 0) matches = scoped
    }
    if (matches.length === 1) return matches[0]!.id
    if (matches.length > 1) {
      const where = matches.map((r) => `${r.repoPath}#${r.seq}`).join(', ')
      throw new Error(
        `ambiguous issue ref #${seq} (matches ${where}); qualify it as <repoPath>#${seq}`,
      )
    }
    return ref
  }

  allWire(): IssueWire[] {
    return this.list()
  }

  // ---- The normalized issue projection [POD-796, ADR 4 D7.1] ----
  //
  // ADDITIVE, and flag-gated at every seam below: with `issues-normalized-wire`
  // off, `projectionChanges`/`projectionRows` return nothing and this whole
  // vertical is inert — not a branch that behaves differently, but zero extra
  // rows appended and zero extra work done, which is what makes "flag off ⇒
  // byte-identical legacy behaviour" a property rather than a hope.
  //
  // Both build from the ROW, never from the `IssueWire`. That is the D7.2
  // discipline and not a stylistic preference: `IssueProjection` is a pure
  // function of the issue's own durable row, so deriving it from the legacy wire
  // would re-acquire the O(issues × sessions) dependency the projection exists
  // to shed — and would quietly make the bypass in `runSessionsBroadcast`
  // impossible. It is also cheap: O(1) per issue, no session list in sight.

  /** True when this server emits normalized projections. Absent dep ⇒ off (test
   *  deps literals predate the flag; off is the legacy path, so absent must mean
   *  the old behaviour). */
  protected get normalizedWire(): boolean {
    return this.deps.issuesNormalizedWire?.() ?? false
  }

  /** The `issueProjection` change ONE issue's write declares, flag-gated.
   *  Returned as an array so a call site can spread it into its `changes()` and
   *  stay a single expression when the flag is off. */
  protected projectionChanges(
    row: IssueRow,
  ): { entity: 'issueProjection'; id: string; op: 'upsert'; value: IssueProjection }[] {
    if (!this.normalizedWire) return []
    return [
      { entity: 'issueProjection', id: row.id, op: 'upsert', value: issueRowToProjection(row) },
    ]
  }

  /** Full LOCAL projection truth for a reconcile. `undefined` = do not reconcile
   *  this kind (a row that cannot be projected — see {@link issueProjectionRows}
   *  on why that is all-or-nothing). Flag off returns EMPTY, not undefined, and
   *  the difference is the rollback — see {@link EMPTY_NORMALIZED_TRUTH}.
   *
   *  The normalized parallel to {@link allWire}, and public for the same reason:
   *  the relay's write-less publish tail needs it. LOCAL only — like allWire(),
   *  hub-mirrored issues are the publisher's union to make, and it cannot make
   *  it here (see IssuePublisherDeps.allProjections). */
  allProjections(): { id: string; value: IssueProjection }[] | undefined {
    if (!this.normalizedWire) return EMPTY_NORMALIZED_TRUTH
    return issueProjectionRows(this.rows.values())
  }

  // ---- The two kinds the replica JOINS against [POD-822] ----
  //
  // `deps` and `prefix` are the two fields the replica's issue views READ that
  // `IssueProjection` does not carry and — per D7.2 — must not: an edge belongs
  // to two issues, a prefix belongs to a repo, and folding either onto the issue
  // makes a write to something else rewrite issues. So each is its own kind, and
  // `blocked` / `ready` / `dependents` / `displayRef` are joined replica-side
  // (D7.3). Same flag gate as the projection: with `issues-normalized-wire` off
  // these emit nothing at all.

  /** The `issueDep` change ONE edge write declares, flag-gated. O(1) per edge —
   *  this is what makes a dep add cost nothing per issue. Returned as an array so
   *  a call site can spread it and stay a single expression when the flag is off. */
  protected depChanges(
    deps: readonly { fromId: string; toId: string; type: string }[],
    op: 'upsert' | 'remove',
  ): { entity: 'issueDep'; id: string; op: 'upsert' | 'remove'; value?: IssueDepProjection }[] {
    if (!this.normalizedWire) return []
    return deps.map((dep) => {
      const value = issueDepToProjection(dep)
      // A remove carries no value (the ledger drops it; the row is gone). An
      // upsert carries the whole edge — there is no partial edge.
      return op === 'upsert'
        ? { entity: 'issueDep' as const, id: value.id, op, value }
        : { entity: 'issueDep' as const, id: value.id, op }
    })
  }

  /** Full LOCAL dep-edge truth for a reconcile, flag-gated. Flag OFF returns
   *  EMPTY truth (the reconcile runs and removes previously-published rows —
   *  the rollback); `undefined` means only "cannot project, do not touch the
   *  kind" (an edge that cannot be projected — all-or-nothing, see
   *  {@link issueDepProjectionRows}).
   *
   *  O(edges), and it runs only on the full-truth paths (boot, write-less
   *  rebroadcast) that are already O(issues) — never per dep change, which
   *  declares its one row through {@link depChanges} instead. This is also what
   *  catches the removes no write declares: `issue_deps` has `ON DELETE CASCADE`
   *  from `issues`, so deleting an issue silently vaporises its edges, and only a
   *  full-truth diff can notice rows that left without anyone saying so. */
  allDepProjections(): { id: string; value: IssueDepProjection }[] | undefined {
    if (!this.normalizedWire) return EMPTY_NORMALIZED_TRUTH
    return issueDepProjectionRows(this.deps.store.issues.listAllIssueDeps())
  }

  /** Full LOCAL repo truth for a reconcile, flag-gated. O(repos) — a handful of
   *  rows, deduped to the LOGICAL repo (several checkouts, one entity). */
  allRepoProjections(): { id: string; value: RepoProjection }[] | undefined {
    if (!this.normalizedWire) return EMPTY_NORMALIZED_TRUTH
    return repoProjectionRows(this.deps.store.repos.listRepos())
  }

  /**
   * Publish the repo truth [POD-822] — called by the repo registry after a
   * prefix write, which is the ONLY thing that moves this entity today.
   *
   * A prefix change has no issue write to ride along with, and without this the
   * replica's `displayRef`s would not move until someone happened to touch an
   * issue — a bug that would look like caching and would in fact be a missing
   * emitter. Reconcile rather than a declared change because the registry writes
   * through the store directly (no ledger commit to hang a declaration on), and
   * because at O(repos) the full-truth diff is cheaper than the machinery to
   * avoid it. The ledger's byte-equality dedup means a no-op prefix write
   * appends nothing.
   *
   * NOT a D7.2 breach, and worth being precise about why: this is O(repos), not
   * O(issues). Materializing `displayRef` onto issues instead — the D7.4 option
   * this slice rejected — is what would make a prefix change O(repo's issues) on
   * the write path. The whole point of the repo entity is that this stays one row.
   */
  publishRepos(): void {
    const repos = this.allRepoProjections()
    if (!repos) return
    try {
      this.deps.ledger.reconcile('repo', repos)
    } catch (err) {
      console.warn('[podium:issues] repo projection publish failed', err)
    }
  }

  /** THE full-list reconcile + fan-out tail every write-less issue publish runs
   *  (broadcastList, purgeEmptyDraft). Both kinds reconcile against the same
   *  truth in the same pass, so the legacy feed and the normalized feed can
   *  never disagree about which issues exist. */
  protected reconcileAndPublish(spec: PublishSpec): void {
    this.deps.ledger.reconcile('issue', spec.rows)
    const projections = this.allProjections()
    if (projections) this.deps.ledger.reconcile('issueProjection', projections)
    // The edges reconcile on the same full-truth passes [POD-822], for the same
    // reason the projections do: this path exists to catch what no write
    // declared, and a CASCADE delete (an issue removed takes its edges with it)
    // is exactly that. Skipped entirely when the flag is off.
    const depProjections = this.allDepProjections()
    if (depProjections) this.deps.ledger.reconcile('issueDep', depProjections)
    this.deps.funnel.publishComputed(spec.snapshot)
  }
  /** Append to the durable event log. Best-effort: a log failure must never
   *  break the mutation that triggered it. repoPath comes from the subject row. */
  protected emitEvent(kind: string, subject: string, payload: Record<string, unknown>): void {
    try {
      this.deps.store.events.appendEvent({
        ts: this.now(),
        kind,
        subject,
        repoPath: this.rows.get(subject)?.repoPath ?? null,
        payload,
      })
    } catch {}
  }
  /** Persist ONE row and broadcast it as a single-issue delta (issue #22).
   *  Historically every persist() also broadcast the FULL allWire() list —
   *  N × toWire (4 store queries each + an O(N) children scan) per mutation,
   *  O(N²) under load. Mutations whose effect stays within the row now cost one
   *  toWire; mutations that change OTHER issues' derived wire data (closed flips
   *  → dependents' blocked/ready + parent childDoneCount, hierarchy/dep edits,
   *  membership changes) additionally call {@link broadcastList}. */
  protected persist(row: IssueRow, opts?: { touch?: boolean }): IssueWire {
    return this.persistWith(row, undefined, opts)
  }

  /** persist() plus an extra repository write (labels/comments/deps/mail) that
   *  must land inside the SAME transaction as the row upsert. The ledger's
   *  commit ([spec:SP-3fe2] #255) binds the write and its declared change row
   *  into one transact span — the durable change log can never say something
   *  the issue table doesn't — then the funnel fans the committed changes out. */
  protected persistWith(
    row: IssueRow,
    extraWrite?: () => void,
    opts?: {
      touch?: boolean
      /**
       * Extra entity changes this write declares, beyond the issue's own two
       * kinds [POD-822]. Today: the `issueDep` rows an edge write touches, built
       * by {@link depChanges} (empty when the flag is off).
       *
       * They ride the SAME `changes()` callback, so they land in the SAME
       * transact span as the row upsert and the `extraWrite` that produced them.
       * That is the whole point rather than a tidiness preference: `addIssueDep`
       * and the edge's change row must commit or roll back together, or the feed
       * can claim an edge the store rejected — a permanently `blocked` issue on
       * every replica, healed by nothing.
       */
      extraChanges?: readonly {
        entity: 'issueDep'
        id: string
        op: 'upsert' | 'remove'
        value?: IssueDepProjection
      }[]
    },
  ): IssueWire {
    // In-place rollback seam (#247): for an EXISTING issue, `row` is the
    // MAP-OWNED object and every mutation path (update()'s Object.assign,
    // setState/panelApply/markIssueRead/undefer/workflow's field writes, plus
    // the updatedAt stamp below) mutates it in place BEFORE the commit. A
    // commit throw rolls the durable write back, but the object would keep the
    // new fields — and the next full-list reconcile would durably publish the
    // phantom. Snapshot the last-COMMITTED field state (the store's current
    // row — exactly what sqlite rolls back to; it also covers mutations the
    // caller made before entering this seam) and, on a throw, restore it INTO
    // THE SAME object reference so every holder of the row sees the rollback.
    // A brand-new row has no committed state (backup null): the post-commit
    // rows.set() below is what keeps a failed create out of the map.
    const backup = this.deps.store.issues.getIssue(row.id)
    // touch:false = read-tracking writes (markIssueRead/Unread): reading is not
    // activity, so it must not bump updatedAt — the stamp would land a tick AFTER
    // markIssueRead's readAt and computeUnread (lastActivity > readAt) would flip
    // the issue straight back to unread. It also must not reorder sidebar recency.
    if (opts?.touch !== false) row.updatedAt = this.now()
    let wire: IssueWire
    try {
      wire = this.deps.ledger.commit({
        write: () => {
          extraWrite?.()
          this.deps.store.issues.upsertIssue(row)
          // toWire never looks `row` itself up in the map (children/blocked scan
          // OTHER rows), so it is safe to serialize before the map install below.
          return this.toWire(row)
        },
        // Both kinds are declared by the SAME commit, so they land in one
        // transact span: a cap client and a legacy client can never observe an
        // issue at two different truths, and neither feed can record a write
        // the other rolled back. The projection is built from `row` (post-write,
        // so it carries the revision upsertIssue just assigned — the same
        // ordering `w` depends on), not from `w`.
        changes: (w) => [
          { entity: 'issue', id: row.id, op: 'upsert', value: w },
          ...this.projectionChanges(row),
          ...(opts?.extraChanges ?? []),
        ],
      }).result
    } catch (err) {
      if (backup) Object.assign(row, backup)
      throw err
    }
    // The commit changed an issue-side input feeding toWire (row / label / dep /
    // comment via extraWrite, or read state) — invalidate the wire memo [POD-723].
    this.bumpIssueInputs()
    // Install into the map only AFTER the commit succeeded (#247): a throw in
    // the transact span (write or change append) rolls the durable state back,
    // and the map must not keep a row the store never accepted — a phantom row
    // would make the next full-list reconcile fabricate an upsert for it.
    // (Update paths mutate the map's own row object in place, so for them this
    // set is a no-op either way; the guard matters for NEW rows, i.e. create.)
    this.rows.set(row.id, row)
    // Delta clients got the committed change via the funnel's onAppended pipe;
    // this carries only the legacy single-issue snapshot (#256).
    this.deps.funnel.publishComputed(this.deps.publishSpecs.issueUpdated(wire).snapshot)
    return wire
  }

  /** Full-list broadcast for mutations with cross-issue effects (see persist).
   *  No repository write of its own. Runs a ledger RECONCILE over the full wire
   *  list rather than per-write declarations because the full-list path exists
   *  exactly to catch DERIVED ripples: closing issue X flips ready/blocked on
   *  its dependents' wire rows (and childDoneCount on its parent) without any
   *  write touching those rows — a per-write declaration alone would miss
   *  them. Every site that mutates-then-broadcastLists keeps exactly this
   *  shape ([spec:SP-3fe2] #255). The reconciled rows are the ones the
   *  snapshot carries (local ∪ hub-mirrored, unioned by the publisher), so the
   *  change log records exactly what legacy clients see. */
  protected broadcastList(): void {
    // Cross-issue derived ripples (a close flipping dependents' blocked/ready,
    // a re-parent moving childCount) change OTHER rows' wire output without a
    // write on them — bump BEFORE allWire so the memo rebuilds every row against
    // the new generation and no ripple is served from stale cache [POD-723].
    this.bumpIssueInputs()
    this.reconcileAndPublish(this.deps.publishSpecs.issuesChanged(this.allWire()))
  }

  /**
   * THE D7.2 BYPASS for dep-edge ripples [POD-822], the issue-side twin of
   * POD-796's session-broadcast bypass.
   *
   * `broadcastList()` after an edge write exists for ONE reason: on the legacy
   * wire, `deps` / `dependents` / `blocked` / `ready` are fields of the ISSUE, so
   * an edge between A and B changes B's payload with no write on B — and only a
   * full-list rebuild finds that. The rebuild is O(issues), and every one of them
   * scans its member sessions (see instrumentation.ts on why a memo does not save
   * it), so a single `depAdd` costs O(issues × sessions).
   *
   * A replica that reads the 'issueDep' kind derives all four itself from the
   * edge set it holds, keyed by the two endpoints — so the edge row IS the
   * ripple, already declared by the write, already O(1). When no connected client
   * still needs the legacy shape, the rebuild recomputes a payload nobody will
   * read: pure waste, and precisely the "work O(number of entities) per change"
   * D7.2 forbids.
   *
   * The skip is safe in the same way POD-796's is, and unsafe in none of the ways
   * that matter: `legacyIssueWireNeeded()` answers TRUE for every uncertainty
   * (flag off, dep absent, a pre-hello client), so this only ever skips when
   * every connected client has positively said it reads the normalized shape. A
   * client attaching later takes a freshly built list at attach; a delta client
   * re-bases through `sync.changesSince`. What a skip leaves behind is at most a
   * stale 'issue' baseline in the ledger, which costs one extra reconcile diff on
   * the next publish — never a lost update.
   */
  protected broadcastListForDerivedRipple(): void {
    if (this.deps.legacyIssueWireNeeded?.() ?? true) this.broadcastList()
  }
  /** @internal */
  protected rowOrThrow(id: string): IssueRow {
    const r = this.rows.get(this.resolveRef(id))
    if (!r) throw new Error(`unknown issue ${id}`)
    return r
  }
  /** @internal */
  protected persistRow(row: IssueRow): IssueWire {
    return this.persist(row)
  }
  /** @internal */
  protected get d(): IssueDeps {
    return this.deps
  }
  protected slug = slugifyBranch
}
