import {
  asIssueId,
  isIssueBlocked,
  isIssueClosed,
  isIssueDeferred,
  requireInstant,
  type Instant,
  type IssueDepWire,
  type IssueGitState,
  type IssueId,
  type IssuePanel,
  type SessionId,
  type IssueWire,
  type SessionMeta,
} from '@podium/model'
import { formatIssueRef, parseIssueRef } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from '../../../issue-util'
import { decodePanel, fromStorage } from '../../../store/issue-storage'
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

  /** Git status of each issue's checkout [POD-98] — EPHEMERAL (like the wire's
   *  `sessions`): probed on the working→idle edge, joined in toWire, never a
   *  column. Lost on restart by design — the next turn end re-probes, and the
   *  attribution ledger's absence is what flips `fallback` on. Writers must
   *  broadcast via {@link broadcastList} so the POD-723 memo invalidates. */
  protected readonly gitStates = new Map<string, IssueGitState>()

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

  /** The service's clock as the model's `Instant` (epoch ms) — the adapter at
   *  this edge (POD-299). The service holds an ISO `now` because that is what it
   *  stamps onto rows; the model's predicates compare instants, never strings. */
  protected nowInstant(): Instant {
    return requireInstant(this.now())
  }

  protected isClosed(row: IssueRow): boolean {
    return !!row.deletedAt || isIssueClosed(row)
  }

  protected isDeferred(row: IssueRow): boolean {
    return isIssueDeferred(row, this.nowInstant())
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
    // R3 -> R1 -> R4. Every encoding split this projection used to perform inline
    // (raw panel JSON, the stage/type casts, the three D-2 renames, the two
    // 'human' | 'agent' enums, the nullable->optional collapse) now lives in the
    // ONE documented pair (ADR 4 §4.1). `row` is still passed to the predicates
    // and store lookups below, which take rows by design.
    const issue = fromStorage(row)
    const sessions = row.deletedAt ? [] : sessionsForIssue(row.worktreePath, sessionList, row.id)
    const gitState = row.deletedAt ? undefined : this.gitStates.get(row.id)
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
    // Either shape of the needs-human quartet projects the same four wire keys;
    // `askedLegacy` is a pre-#53 row whose asker was never recorded, and dropping
    // it here would delete an open question from the wire.
    const asked = issue.asked ?? issue.askedLegacy
    return {
      id: issue.id,
      repoPath: row.repoPath,
      ...(issue.repoId ? { repoId: issue.repoId } : {}),
      ...(prefix ? { prefix } : {}),
      displayRef,
      seq: issue.seq,
      title: issue.title,
      description: issue.description.value,
      ...(issue.brief ? { brief: issue.brief } : {}),
      stage: issue.stage,
      worktreePath: issue.worktreePath,
      branch: issue.branch,
      parentBranch: issue.parentBranch,
      defaultAgent: issue.defaultAgent,
      defaultModel: issue.defaultModel,
      defaultEffort: issue.defaultEffort,
      ...(issue.machineId ? { machineId: issue.machineId } : {}),
      ...(issue.linearId ? { linearId: issue.linearId } : {}),
      ...(issue.linearIdentifier ? { linearIdentifier: issue.linearIdentifier } : {}),
      ...(issue.linearUrl ? { linearUrl: issue.linearUrl } : {}),
      ...(issue.activityNotes ? { activityNotes: issue.activityNotes } : {}),
      ...(issue.notesUpdatedAt ? { notesUpdatedAt: issue.notesUpdatedAt } : {}),
      ...(issue.suggestedStage ? { suggestedStage: issue.suggestedStage } : {}),
      ...(issue.suggestedReason ? { suggestedReason: issue.suggestedReason } : {}),
      // A MODEL MISBRAND, not a POD-362 adapter cast — and it is being reported,
      // not absorbed. `IssueWire.blockedBy` is `z.array(IssueIdField)`, but the
      // value is `blockedByNotes`: LLM-authored PROSE that `store/types.ts`
      // documents as "often BRANCH names rather than issue ids" and explicitly NOT
      // the dependency graph (real edges live in issue_deps). So the brand on the
      // wire field asserts an id space this value is not in. POD-308 owns the wire
      // rename; branding cannot fix a field whose CONTENT is not an id, and
      // widening the wire here would be a wire change this issue must not make.
      blockedBy: issue.blockedByNotes as IssueId[],
      ...(issue.dependencyNote ? { dependencyNote: issue.dependencyNote } : {}),
      ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
      priority: issue.priority,
      type: issue.type,
      pinned: row.pinned,
      ...(issue.sortKey ? { sortKey: issue.sortKey } : {}),
      // A corrupt/unknown stored slot already degraded to "no colour" in
      // `fromStorage` [spec:SP-b4d1] — one tolerant decode, not two.
      ...(issue.color ? { color: issue.color } : {}),
      needsHuman: issue.needsHuman,
      ...(asked?.question ? { humanQuestion: asked.question } : {}),
      ...(asked?.options?.length ? { humanQuestionOptions: asked.options } : {}),
      ...(asked?.by ? { humanQuestionAskedBy: asked.by as SessionId } : {}),
      ...(asked?.at ? { humanQuestionAskedAt: asked.at } : {}),
      ...(issue.supersededBy ? { supersededBy: issue.supersededBy } : {}),
      ...(issue.duplicateOf ? { duplicateOf: issue.duplicateOf } : {}),
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      ...(issue.parentId ? { parentId: issue.parentId } : {}),
      ...(issue.design ? { design: issue.design } : {}),
      ...(issue.acceptance ? { acceptance: issue.acceptance } : {}),
      ...(issue.notes?.value ? { notes: issue.notes.value } : {}),
      ...(issue.dueAt ? { dueAt: issue.dueAt } : {}),
      ...(issue.deferUntil ? { deferUntil: issue.deferUntil } : {}),
      ...(issue.closedReason ? { closedReason: issue.closedReason } : {}),
      ...(issue.closedAt ? { closedAt: issue.closedAt } : {}),
      // Always on the wire (like readAt, not spread-when-truthy): the client
      // reads absence as "not tucked", and an untuck must be able to say so.
      tuckedAt: row.tuckedAt ?? null,
      ...(issue.estimateMin != null ? { estimateMin: issue.estimateMin } : {}),
      ...(issue.panel ? { panel: issue.panel } : {}),
      labels,
      deps,
      dependents,
      commentCount,
      ready,
      blocked,
      deferred,
      childCount: children.length,
      childDoneCount: children.filter((c) => this.isClosed(c)).length,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      archived: issue.archived,
      readAt: row.readAt ?? null,
      ...(issue.deletedAt ? { deletedAt: issue.deletedAt } : {}),
      unread: this.computeUnread(row, sessions),
      sessions,
      sessionSummary: summarizeSessions(sessions),
      ...(gitState ? { gitState } : {}),
      // D-2's two renames, read back: the wire keeps the unqualified names until
      // POD-308, and this pair is the one place they map.
      origin: issue.intentOrigin,
      audience: issue.audience,
      draft: issue.isDraftVessel,
      // Bare session ids (same format as humanQuestionAskedBy) — no `session:` prefix.
      ...(issue.coordinatorSessionId ? { coordinatorSessionId: issue.coordinatorSessionId } : {}),
      ...(issue.startedBySession ? { startedBySession: issue.startedBySession } : {}),
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

  /** Parse the stored panel JSON, tolerating legacy/garbage values (empty panel).
   *  The decode itself is an R1 ↔ R3 encoding split and lives in the one pair
   *  (ADR 4 §4.1); this stays as the row-shaped entry point `crud.ts` uses when
   *  it is about to patch the same row AS a row. */
  protected parsePanel(row: IssueRow): IssuePanel {
    return decodePanel(row.panel)
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
   *  the input unchanged so the caller's normal unknown-issue error fires.
   *
   *  THE ISSUE-ID PARSE BOUNDARY (POD-362). This is where a caller-supplied
   *  STRING becomes a branded `IssueId`, which is why this service's public
   *  methods keep taking `id: string`: their parameter is a REF (`POD-13`,
   *  `repo#13`, a bare seq, or the internal id), and branding it would claim a
   *  guarantee the caller cannot make. Everything downstream reads `row.id`,
   *  which IS branded. The unresolvable case is branded too, deliberately: it is
   *  handed straight to `rows.get()`, which misses, so the caller's unknown-issue
   *  error fires carrying the text the user actually typed. The brand asserts
   *  which id SPACE a value belongs to, never that the row exists — existence is
   *  the throw's job, not the type's. */
  resolveRef(ref: string, scopeRepoPath?: string): IssueId {
    if (ref.startsWith('iss_') || this.rows.has(ref)) return asIssueId(ref)
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
      return asIssueId(ref)
    }
    const m = /^#?(\d+)$/.exec(ref.trim())
    if (!m) return asIssueId(ref)
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
    return asIssueId(ref)
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
    // touch:false = non-activity writes: (1) read-tracking (markIssueRead/Unread)
    // and (2) organizational-only patches (pinned/sortKey via update). Those must
    // not bump updatedAt — the stamp would land a tick AFTER readAt and
    // computeUnread (lastActivity > readAt) would flip the issue straight back to
    // unread. It also must not reorder sidebar recency.
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

  /** Publish one write-less derived issue update (for example ephemeral Git
   * state). Unlike broadcastList this does not rebuild every issue merely
   * because one row's computed field changed. The reconcile keeps delta clients
   * and the durable change log aligned with the legacy single-row snapshot. */
  protected broadcastIssue(row: IssueRow): void {
    this.bumpIssueInputs()
    const spec = this.deps.publishSpecs.issueUpdated(this.toWire(row))
    // capture, NOT reconcile: reconcile treats its rows as the FULL truth for
    // the entity kind and diffs removes against the whole baseline — fed a
    // single row it would journal a remove for every OTHER issue, which the
    // next full-list broadcast re-upserts (the POD-210 ledger flapping: ~185
    // remove+upsert pairs per targeted git-state publish). capture dedups the
    // one row against the baseline and never diffs the list.
    this.deps.ledger.capture(
      spec.rows.map((r) => ({
        entity: 'issue' as const,
        id: r.id,
        op: 'upsert' as const,
        value: r.value,
      })),
    )
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
