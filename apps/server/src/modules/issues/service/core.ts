import { isIssueBlocked, isIssueClosed, isIssueColorSlot, isIssueDeferred } from '@podium/domain'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { formatIssueRef, IssuePanel, parseIssueRef } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from '../../../issue-util'
import type { IssueRow } from '../../../store'
import type { IssueDeps } from './types'

// Member-session fields that DON'T feed issue wire data [POD-723] — the same
// denylist modules/sessions applies (POD-722). IssueWire.sessions embeds each
// SessionMeta verbatim, so a member's clientCount/controllerId/epoch change must
// NOT invalidate the cached wire: it never surfaces as issue member state, and
// the session broadcast already skips its own publish for that churn (POD-722).
const NON_ISSUE_MEMBER_FIELDS = ['clientCount', 'controllerId', 'epoch'] as const

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
    const ready = row.stage !== 'proposed' && !this.isClosed(row) && !deferred && !blocked
    const prefix = this.deps.store.repos.prefixForPath(row.repoPath)
    const displayRef = prefix ? formatIssueRef(prefix, row.seq) : `#${row.seq}`
    return {
      id: row.id,
      repoPath: row.repoPath,
      ...(row.repoId ? { repoId: row.repoId } : {}),
      ...(prefix ? { prefix } : {}),
      displayRef,
      seq: row.seq,
      title: row.title,
      description: row.description,
      ...(row.brief ? { brief: row.brief } : {}),
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
      ...(row.closedAt ? { closedAt: row.closedAt } : {}),
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
      // Bare session ids (same format as humanQuestionAskedBy) — no `session:` prefix.
      ...(row.coordinatorSessionId ? { coordinatorSessionId: row.coordinatorSessionId } : {}),
      ...(row.startedBySession ? { startedBySession: row.startedBySession } : {}),
    }
  }

  list(repoPath?: string, sessionList: SessionMeta[] = this.deps.listSessions()): IssueWire[] {
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

  allWire(sessionList?: SessionMeta[]): IssueWire[] {
    return this.list(undefined, sessionList)
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
    opts?: { touch?: boolean },
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
        changes: (w) => [{ entity: 'issue', id: row.id, op: 'upsert', value: w }],
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
    const spec = this.deps.publishSpecs.issuesChanged(this.allWire())
    this.deps.ledger.reconcile('issue', spec.rows)
    this.deps.funnel.publishComputed(spec.snapshot)
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
