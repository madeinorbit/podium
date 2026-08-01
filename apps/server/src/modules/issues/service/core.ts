import {
  asIssueId,
  FIRST_ADMIN_USER_ID,
  type Instant,
  type IssueDepProjection,
  type IssueGitState,
  type IssueId,
  type IssuePanel,
  type IssueProjection,
  type IssueUserOverlay,
  type IssueWire,
  isIssueBlocked,
  isIssueClosed,
  isIssueDeferred,
  issueOverlayOf,
  type RepoProjection,
  requireInstant,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { formatIssueRef, parseIssueRef } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch } from '../../../issue-util'
import type { IssueRow, StoredIssueUserState } from '../../../store'
import { decodePanel, fromStorage } from '../../../store/issue-storage'
import { countIssueWireBuild } from '../instrumentation'
import {
  issueDepProjectionRows,
  issueDepToProjection,
  issueProjectionRows,
  issueRowToProjection,
  repoProjectionRows,
} from '../projection'
import type { PublishSpec } from '../publish'
import type { IssueDeps } from './types'

interface IssueWireBatch {
  /** Computed ONCE per multi-issue serialize and shared — per-issue
   *  `deps.listSessions()` calls were the boot-storm hot path. */
  sessions: SessionMeta[]
  labelsByIssue: Map<string, string[]>
  depsByFrom: Map<string, { toId: IssueId; type: string }[]>
  dependentsByTo: Map<string, { fromId: IssueId; type: string }[]>
  childrenByParent: Map<string, IssueRow[]>
  prefixesByRepoPath: Map<string, string | null>
}

/**
 * The one mutable issue store shared by every tracker capability.
 *
 * This owns hydration, wire serialization, ref resolution and the
 * persist/broadcast tail every mutation funnels through. Capability modules are
 * composed over this object; none owns a second row cache.
 */
export class IssueStore {
  /** Hydrated row cache; null until the first {@link init}/lazy access. Kept out
   *  of the constructor so constructing the service can never crash-loop the
   *  server boot on bad data (the composition root calls init() explicitly;
   *  everything else lazily hydrates on first touch). */
  private hydrated: Map<string, IssueRow> | null = null
  /**
   * THE BROADCAST VIEWER'S per-user markers, `issueId → row` (POD-1076).
   *
   * `issues.read_at` / `tucked_at` / `pinned` used to be columns on the shared
   * row, so the projection got them for free and every client saw one person's
   * markers as if they were the issue's. They are now `(userId, issueId)` rows
   * and the projection needs a VIEWER.
   *
   * The feed is still unscoped (ADR 2 D2), so there is exactly one viewer to
   * serve and it is named rather than defaulted: {@link broadcastViewer}. When
   * POD-1077 makes fan-out per-principal, this map becomes per-principal and the
   * constant becomes the request's user — the sites are these two members and
   * nothing else, because no other code holds a marker.
   */
  private viewerState: Map<string, StoredIssueUserState> | null = null
  constructor(readonly deps: IssueDeps) {}

  /**
   * WHOSE per-user markers the broadcast carries. `FIRST_ADMIN_USER_ID` spelled
   * out, never a default: an unidentified principal must fail closed rather than
   * resolve to an operator identity (readiness §3.1.6 S4). POD-1077 replaces the
   * body with the request's principal; every caller already asks the question.
   */
  broadcastViewer(): string {
    return FIRST_ADMIN_USER_ID
  }

  /** One issue's markers for the broadcast viewer, as the wire wants them. */
  issueOverlay(issueId: string): IssueUserOverlay {
    if (this.viewerState === null) {
      this.viewerState = this.deps.store.issues.listIssueUserState(this.broadcastViewer())
    }
    return issueOverlayOf(this.viewerState.get(issueId))
  }

  /** The stored markers, for callers that need `pinnedAt` rather than `pinned`. */
  issueUserState(issueId: string): StoredIssueUserState | undefined {
    if (this.viewerState === null) {
      this.viewerState = this.deps.store.issues.listIssueUserState(this.broadcastViewer())
    }
    return this.viewerState.get(issueId)
  }

  /**
   * Write one of the broadcast viewer's markers, through the store and the cache
   * together. A PARTIAL patch — see the repository method — so marking an issue
   * read cannot silently un-pin it.
   *
   * Bumps `issueInputsGen`: a marker change is an issue-side wire input, and
   * POD-723's memo would otherwise serve the pre-change payload.
   */
  writeIssueUserState(issueId: string, patch: Partial<StoredIssueUserState>): void {
    const user = this.broadcastViewer()
    this.deps.store.issues.setIssueUserState(user, issueId, patch)
    if (this.viewerState === null) {
      this.viewerState = this.deps.store.issues.listIssueUserState(user)
    } else {
      const next = this.deps.store.issues.getIssueUserState(user, issueId)
      if (next) this.viewerState.set(issueId, next)
      else this.viewerState.delete(issueId)
    }
    this.bumpIssueInputs()
  }

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
  readonly gitStates = new Map<string, IssueGitState>()

  /** Signal that some issue-side input feeding {@link toWire} changed, so cached
   *  wire payloads must be rebuilt on the next list() [POD-723]. */
  bumpIssueInputs(): void {
    this.issueInputsGen++
  }

  /** The in-memory row map, lazily hydrated. Row-level quarantine lives in the
   *  store (listIssueRows skips + logs + counts corrupt rows), so hydration is
   *  total: a corrupt row costs that row, never the boot. */
  get rows(): Map<string, IssueRow> {
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
    // The per-user markers are re-read on next touch for the same reason the rows
    // are re-read: a test (or a future external mutator) that wrote them directly
    // must not keep serving a stale overlay.
    this.viewerState = null
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

  now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  /** The service's clock as the model's `Instant` (epoch ms) — the adapter at
   *  this edge (POD-299). The service holds an ISO `now` because that is what it
   *  stamps onto rows; the model's predicates compare instants, never strings. */
  nowInstant(): Instant {
    return requireInstant(this.now())
  }

  isClosed(row: IssueRow): boolean {
    return !!row.deletedAt || isIssueClosed(row)
  }

  isDeferred(row: IssueRow): boolean {
    return isIssueDeferred(row, this.nowInstant())
  }

  /** Email-style unread (issue #124): there is activity THIS READER hasn't seen.
   *  Activity = the latest of the issue's updatedAt and any member session's
   *  lastActiveAt (the same recency notion the sidebar uses). readAt null = never
   *  opened → unread (updatedAt always exists). Kept cheap: no event-log scan, since
   *  every meaningful mutation already bumps updatedAt.
   *
   *  DERIVED, NEVER STORED (POD-1076): it joins one person's `readAt` to a shared
   *  `lastActiveAt`, so it is a fact about a reader AND an issue and belongs to
   *  neither row alone. */
  computeUnread(row: IssueRow, sessions: SessionMeta[]): boolean {
    if (row.deletedAt) return false
    const readAt = this.issueOverlay(row.id).readAt
    if (readAt == null) return true
    const readMs = Date.parse(readAt)
    if (!Number.isFinite(readMs)) return true
    const times = [Date.parse(row.updatedAt), ...sessions.map((s) => Date.parse(s.lastActiveAt))]
    let lastActivity = Number.NEGATIVE_INFINITY
    for (const t of times) if (Number.isFinite(t) && t > lastActivity) lastActivity = t
    return lastActivity > readMs
  }

  /**
   * Is `id` unread FOR THE BROADCAST VIEWER — the derivation above, as a READ.
   *
   * WHY THIS EXISTS [POD-1246]. `unread` left the wire with the session embed
   * (POD-797): it was a function of the issue's own `updatedAt` joined against
   * its member sessions' `lastActiveAt`, which is precisely what made every
   * session change dirty every issue payload. The client derives it now, from
   * the `readAt` it holds and the session list it already has.
   *
   * The DERIVATION did not leave with the field, and that is the whole reason for
   * this method. `sweepAutoArchive` still gates on it — a done-but-re-touched
   * issue must not be archived out from under the operator — so removing the
   * field removed the only place the rule could be OBSERVED while leaving the
   * rule itself load-bearing. A slice that deletes a payload and its oracle in
   * one move leaves behind exactly the shape this codebase keeps getting bitten
   * by: a rule that still runs and can no longer say NO.
   *
   * Returns false for an issue this service does not hold.
   */
  unreadFor(id: IssueId): boolean {
    const row = this.rows.get(id)
    if (row === undefined) return false
    const sessions = sessionsForIssue(row.worktreePath, this.deps.listSessions(), row.id)
    return this.computeUnread(row, sessions)
  }

  /** blocked = open AND ≥1 `blocks` dep whose target issue is not closed. */
  computeBlocked(row: IssueRow): boolean {
    const blocksTargets = this.deps.store.issues
      .listIssueDeps(row.id)
      .filter((d) => d.type === 'blocks')
      .map((d) => this.rows.get(d.toId))
    return isIssueBlocked(row, blocksTargets)
  }

  /** Serialize one issue into the transitional legacy shape.
   *
   *  `commentCounts` batches the comment COUNT (#175): list serializers pass one
   *  GROUP BY map; single-issue paths run one scalar COUNT. Comment BODIES never
   *  ride the wire anymore — fetch via comments(id).
   *
   *  NO SESSION LIST IS READ HERE ANY MORE [POD-797]. `sessions`,
   *  `sessionSummary` and `unread` left the wire, and they were the only reason
   *  this projection ever needed one — so the `listSessions()` call went with
   *  them. That is the O(issues x sessions) coupling the slice exists to remove,
   *  and removing the FIELDS without removing the CALL would have kept every
   *  cost and shipped none of the benefit. `IssueWireBatch.sessions` survives for
   *  the callers that still batch it; nothing in this method reads it.
   *
   *  What a caller wanting membership does instead: read it from the SESSION
   *  side (`sessionId -> issueId`), which is where it is stored. `unreadFor`
   *  above is the one derivation that still joins the two, and it fetches its
   *  own list. */
  toWire(row: IssueRow, commentCounts?: Map<string, number>, batch?: IssueWireBatch): IssueWire {
    // Transitional builds remain observable; the D7.2 membership-scan counter
    // has no increment site after the old membership assembly is deleted.
    countIssueWireBuild()
    // R3 -> R1 -> R4. Every encoding split this projection used to perform inline
    // (raw panel JSON, the stage/type casts, the three D-2 renames, the two
    // 'human' | 'agent' enums, the nullable->optional collapse) now lives in the
    // ONE documented pair (ADR 4 §4.1). `row` is still passed to the predicates
    // and store lookups below, which take rows by design.
    const issue = fromStorage(row)
    const gitState = row.deletedAt ? undefined : this.gitStates.get(row.id)
    const labels = batch
      ? (batch.labelsByIssue.get(row.id) ?? [])
      : this.deps.store.issues.getIssueLabels(row.id)
    const children = batch
      ? (batch.childrenByParent.get(row.id) ?? [])
      : [...this.rows.values()].filter((r) => r.parentId === row.id && !r.deletedAt)
    // Wire deps/dependents keep carrying the parent-child edges for client
    // compatibility, but they are SYNTHESIZED from parent_id / children —
    // issue_deps stores only real dependency types (#164).
    const deps = [
      ...(batch
        ? (batch.depsByFrom.get(row.id) ?? [])
        : this.deps.store.issues.listIssueDeps(row.id)
      ).map((d) => ({ id: d.toId, type: d.type })),
      ...(row.parentId ? [{ id: row.parentId, type: 'parent-child' }] : []),
    ]
    const dependents = [
      ...(batch
        ? (batch.dependentsByTo.get(row.id) ?? [])
        : this.deps.store.issues.listDependents(row.id)
      ).map((d) => ({ id: d.fromId, type: d.type })),
      ...children.map((c) => ({ id: c.id, type: 'parent-child' })),
    ]
    const commentCount = commentCounts
      ? (commentCounts.get(row.id) ?? 0)
      : this.deps.store.issues.countIssueComments(row.id)
    const blocked = batch
      ? isIssueBlocked(
          row,
          (batch.depsByFrom.get(row.id) ?? [])
            .filter((d) => d.type === 'blocks')
            .map((d) => this.rows.get(d.toId)),
        )
      : this.computeBlocked(row)
    const deferred = this.isDeferred(row)
    const ready = row.stage !== 'proposed' && !this.isClosed(row) && !deferred && !blocked
    let prefix = batch?.prefixesByRepoPath.get(row.repoPath)
    if (prefix === undefined) {
      prefix = this.deps.store.repos.prefixForPath(row.repoPath)
      batch?.prefixesByRepoPath.set(row.repoPath, prefix)
    }
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
      // Per-entity revision (ADR 2 D3) — assigned by upsertIssue at the SQL
      // write, so this projection carries the COMMITTED token only when taken
      // after the write. Spread-conditionally like the other optionals: a row
      // that has never been written has no revision, and an absent field is
      // honest where a fabricated 1 would claim a write that never happened.
      ...(issue.revision === undefined ? {} : { revision: issue.revision }),
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
      pinned: this.issueOverlay(row.id).pinned,
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
      tuckedAt: this.issueOverlay(row.id).tuckedAt,
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
      readAt: this.issueOverlay(row.id).readAt,
      ...(issue.deletedAt ? { deletedAt: issue.deletedAt } : {}),
      // NO `sessions` / `sessionSummary` / `unread` [POD-797, taken from main at
      // the POD-1246 catch-up]. Dropping them from the schema alone would not have
      // been enough: zod strips unknown keys, so a producer that kept computing
      // them would keep paying the O(issues x sessions) rollup on every publish
      // and throw the result away — the cost this slice exists to remove, hidden
      // behind a passing wire test. They are removed HERE too, which is what makes
      // the removal real.
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

  list(repoPath?: string): IssueWire[] {
    const commentCounts = this.deps.store.issues.countIssueCommentsByIssue()
    const labelsByIssue = this.deps.store.issues.listIssueLabelsByIssue()
    const depsByFrom = new Map<string, { toId: IssueId; type: string }[]>()
    const dependentsByTo = new Map<string, { fromId: IssueId; type: string }[]>()
    for (const dep of this.deps.store.issues.listAllIssueDeps()) {
      const outgoing = depsByFrom.get(dep.fromId)
      if (outgoing) outgoing.push({ toId: dep.toId, type: dep.type })
      else depsByFrom.set(dep.fromId, [{ toId: dep.toId, type: dep.type }])
      const incoming = dependentsByTo.get(dep.toId)
      if (incoming) incoming.push({ fromId: dep.fromId, type: dep.type })
      else dependentsByTo.set(dep.toId, [{ fromId: dep.fromId, type: dep.type }])
    }
    const childrenByParent = new Map<string, IssueRow[]>()
    for (const row of this.rows.values()) {
      if (!row.parentId || row.deletedAt) continue
      const children = childrenByParent.get(row.parentId)
      if (children) children.push(row)
      else childrenByParent.set(row.parentId, [row])
    }
    // Resolved once per repoPath (few repos) — it rides the memo key because
    // `displayRef` reads it and it changes out-of-band of any issue mutation.
    const prefixByPath = new Map<string, string>()
    const prefixFor = (p: string): string => {
      let v = prefixByPath.get(p)
      if (v === undefined) {
        v = this.deps.store.repos.prefixForPath(p) ?? ''
        prefixByPath.set(p, v)
      }
      return v
    }
    const batch: IssueWireBatch = {
      sessions: this.deps.listSessions(),
      labelsByIssue,
      depsByFrom,
      dependentsByTo,
      childrenByParent,
      prefixesByRepoPath: new Map(),
    }
    return [...this.rows.values()]
      .filter((r) => this.inRepoScope(r, repoPath))
      .sort((a, b) => {
        const ga = a.repoId ?? a.repoPath
        const gb = b.repoId ?? b.repoPath
        return ga === gb ? a.seq - b.seq : ga.localeCompare(gb)
      })
      .map((r) => this.toWireMemo(r, commentCounts, batch, prefixFor(r.repoPath)))
  }

  /**
   * Cached {@link toWire} for the multi-issue list path [POD-723].
   *
   * THE KEY NO LONGER CARRIES A MEMBERSHIP FINGERPRINT [POD-797]. It used to:
   * `IssueWire.sessions` embedded each `SessionMeta` verbatim, so any member
   * field change had to invalidate the payload, and the key joined a per-session
   * projection to catch it. The embed is gone, so the payload is a function of
   * the issue's OWN inputs plus its repo prefix — and keying on membership would
   * now mean rebuilding on a change the output cannot reflect. That rebuild is
   * the O(issues x sessions) coupling this slice removes; keeping the key would
   * have removed the field and kept the cost.
   *
   * What remains in the key is exactly what the payload reads: `issueInputsGen`
   * (bumped by every issue-side mutation — rows, labels, deps, comments, read
   * state, hierarchy, archive, delete) and the repo `prefix`, which feeds
   * `displayRef` and changes out-of-band of any issue mutation.
   *
   * Single-issue `toWire` callers deliberately bypass this — they always want a
   * fresh build.
   */
  private toWireMemo(
    row: IssueRow,
    commentCounts: Map<string, number>,
    batch: IssueWireBatch,
    prefix: string,
  ): IssueWire {
    const key = `${this.issueInputsGen}\u0000${prefix}`
    const cached = this.wireCache.get(row.id)
    if (cached && cached.key === key) return cached.wire
    const wire = this.toWire(row, commentCounts, batch)
    this.wireCache.set(row.id, { key, wire })
    return wire
  }

  /** Parse the stored panel JSON, tolerating legacy/garbage values (empty panel).
   *  The decode itself is an R1 ↔ R3 encoding split and lives in the one pair
   *  (ADR 4 §4.1); this stays as the row-shaped entry point `crud.ts` uses when
   *  it is about to patch the same row AS a row. */
  parsePanel(row: IssueRow): IssuePanel {
    return decodePanel(row.panel)
  }

  /** True when `row` belongs to the repo identified by `repoPath`, compared by the
   *  stable `repo_id` so every checkout of one origin unifies (#140); falls back to
   *  path equality only when a repo_id can't be resolved. `undefined` scope matches all. */
  inRepoScope(row: IssueRow, repoPath: string | undefined): boolean {
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

  allWire(): IssueWire[] {
    return this.list()
  }

  // ---- The normalized issue projection [POD-796, ADR 4 D7.1] ----
  //
  /** The `issueProjection` change ONE issue's write declares.
   *  Returned as an array so a call site can spread it into its `changes()` and
   *  stay a single expression when the flag is off. */
  projectionChanges(
    row: IssueRow,
  ): { entity: 'issueProjection'; id: string; op: 'upsert'; value: IssueProjection }[] {
    return [
      {
        entity: 'issueProjection',
        id: row.id,
        op: 'upsert',
        value: issueRowToProjection(row, this.deps.store.issues.getIssueLabels(row.id)),
      },
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
    const labelsByIssue = this.deps.store.issues.listIssueLabelsByIssue()
    return issueProjectionRows(this.rows.values(), (id) => labelsByIssue.get(id) ?? [])
  }

  // ---- The two kinds the replica JOINS against [POD-822] ----
  //
  // `deps` and `prefix` are the two fields the replica's issue views READ that
  // `IssueProjection` does not carry and — per D7.2 — must not: an edge belongs
  // to two issues, a prefix belongs to a repo, and folding either onto the issue
  // makes a write to something else rewrite issues. So each is its own kind, and
  // `blocked` / `ready` / `dependents` / `displayRef` are joined replica-side
  // (D7.3). The normalized kinds are emitted unconditionally.

  /** The `issueDep` change ONE edge write declares. O(1) per edge —
   *  this is what makes a dep add cost nothing per issue. Returned as an array so
   *  a call site can spread it and stay a single expression when the flag is off. */
  depChanges(
    deps: readonly { fromId: string; toId: string; type: string }[],
    op: 'upsert' | 'remove',
  ): { entity: 'issueDep'; id: string; op: 'upsert' | 'remove'; value?: IssueDepProjection }[] {
    return deps.map((dep) => {
      const value = issueDepToProjection(dep)
      // A remove carries no value (the ledger drops it; the row is gone). An
      // upsert carries the whole edge — there is no partial edge.
      return op === 'upsert'
        ? { entity: 'issueDep' as const, id: value.id, op, value }
        : { entity: 'issueDep' as const, id: value.id, op }
    })
  }

  /** Full LOCAL dep-edge truth for a reconcile. Flag OFF returns
`undefined` means only "cannot project, do not touch the
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
    return issueDepProjectionRows(this.deps.store.issues.listAllIssueDeps())
  }

  /** Full LOCAL repo truth for a reconcile. O(repos) — a handful of
   *  rows, deduped to the LOGICAL repo (several checkouts, one entity). */
  allRepoProjections(): { id: string; value: RepoProjection }[] | undefined {
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
  reconcileAndPublish(spec: PublishSpec): void {
    this.deps.ledger.reconcile('issue', spec.rows)
    const projections = this.allProjections()
    if (projections) this.deps.ledger.reconcile('issueProjection', projections)
    // The edges reconcile on the same full-truth passes [POD-822], for the same
    // reason the projections do: this path exists to catch what no write
    // declared, and a CASCADE delete (an issue removed takes its edges with it)
    // is exactly that.
    const depProjections = this.allDepProjections()
    if (depProjections) this.deps.ledger.reconcile('issueDep', depProjections)
  }
  /** Append to the durable event log. Best-effort: a log failure must never
   *  break the mutation that triggered it. repoPath comes from the subject row. */
  emitEvent(kind: string, subject: string, payload: Record<string, unknown>): void {
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
  persist(row: IssueRow, opts?: { touch?: boolean }): IssueWire {
    return this.persistWith(row, undefined, opts)
  }

  /** persist() plus an extra repository write (labels/comments/deps/mail) that
   *  must land inside the SAME transaction as the row upsert. The ledger's
   *  commit ([spec:SP-3fe2] #255) binds the write and its declared change row
   *  into one transact span — the durable change log can never say something
   *  the issue table doesn't — then the funnel fans the committed changes out. */
  persistWith(
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
    // comment via extraWrite, or read state) — invalidate the wire memo
    // [POD-723]. LOST IN THE POD-1246 MERGE and restored here: without it a
    // label or dep write served the previous payload from cache, which no test
    // outside `wire-memo.test.ts` could see because every other suite reads the
    // single-issue path that bypasses the memo.
    this.bumpIssueInputs()
    // Install into the map only AFTER the commit succeeded (#247): a throw in
    // the transact span (write or change append) rolls the durable state back,
    // and the map must not keep a row the store never accepted — a phantom row
    // would make the next full-list reconcile fabricate an upsert for it.
    // (Update paths mutate the map's own row object in place, so for them this
    // set is a no-op either way; the guard matters for NEW rows, i.e. create.)
    this.rows.set(row.id, row)
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
  broadcastList(): void {
    // Cross-issue derived ripples (a close flipping dependents' blocked/ready,
    // a re-parent moving childCount) change OTHER rows' wire output without a
    // write on them — bump BEFORE allWire so the memo rebuilds every row against
    // the new generation and no ripple is served from stale cache [POD-723].
    this.bumpIssueInputs()
    this.reconcileAndPublish(this.deps.publishSpecs.issuesChanged(this.allWire()))
  }

  /** Cross-issue legacy fields still require a full-list transitional emit. */
  broadcastListForDerivedRipple(): void {
    this.broadcastList()
  }

  /** Publish one write-less derived issue update (for example ephemeral Git
   * state). Unlike broadcastList this does not rebuild every issue merely
   * because one row's computed field changed. The reconcile keeps delta clients
   * and the durable change log aligned with the legacy single-row snapshot. */
  broadcastIssue(row: IssueRow): void {
    // Same restoration as in persist: the write-less derived publish (git state)
    // changes a computed field with no row write behind it, so nothing else bumps
    // the generation and the next list() would serve the stale payload.
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
  }

  /** @internal */
  rowOrThrow(id: string): IssueRow {
    const r = this.rows.get(this.resolveRef(id))
    if (!r) throw new Error(`unknown issue ${id}`)
    return r
  }
  /** @internal */
  persistRow(row: IssueRow): IssueWire {
    return this.persist(row)
  }
  /** @internal */
  get d(): IssueDeps {
    return this.deps
  }
  slug = slugifyBranch
}
