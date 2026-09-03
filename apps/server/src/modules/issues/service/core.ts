import { createLogger } from '@podium/logger'
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
  type MachineId,
  isIssueBlocked,
  isIssueClosed,
  isIssueDeferred,
  isIssueStage,
  isReadyIssueStage,
  isSystemOwnedIssueStage,
  issueOverlayOf,
  type RepoProjection,
  requireInstant,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import { formatIssueRef, parseIssueRef } from '@podium/protocol'
import type { EntityChangeSpec } from '@podium/sync'
import { sessionsForIssue, slugifyBranch } from '../../../issue-util'
import type { IssueRow, StoredIssueUserState } from '../../../store'
import { decodePanel, fromStorage } from '../../../store/issue-storage'
import { normalizeBlankIssueText } from '../blank-text'
import { countIssueWireBuild } from '../instrumentation'
import {
  issueDepProjectionRows,
  issueDepToProjection,
  issueProjectionRows,
  issueRowToProjection,
  repoProjectionRows,
} from '../projection'
import type { PublishSpec } from '../publish'
import { IssueNotFound } from './not-found'
import type { IssueDeps } from './types'

const log = createLogger('server:issues')

export interface IssueWireBatch {
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
   * Freeze the machine choice an implicit operation would otherwise make inside
   * DaemonRpcService. Explicit pins already bypass that resolver and keep winning.
   * The fallback preserves lightweight test fixtures that do not wire the port;
   * the relay always supplies MachinesService.resolveMachine.
   */
  resolveWorktreeMachine(machineId: MachineId | null | undefined, cwd: string): MachineId {
    return (
      machineId ??
      this.deps.resolveMachine?.(undefined, cwd) ??
      this.deps.store.hostMachineId
    )
  }

  /**
   * WHOSE per-user markers the broadcast carries. `FIRST_ADMIN_USER_ID` spelled
   * out, never a default: an unidentified principal must fail closed rather than
   * resolve to an operator identity (readiness §3.1.6 S4). POD-1077 replaces the
   * body with the request's principal; every caller already asks the question.
   */
  broadcastViewer(): UserId {
    return FIRST_ADMIN_USER_ID
  }

  /**
   * THE MEMBER SESSIONS OF ONE ISSUE — the narrow read [POD-1639].
   *
   * Every caller here used to spell `sessionsForIssue(row.worktreePath,
   * deps.listSessions(), row.id)`: build the reader-scoped projection for all
   * 1119 sessions on the live corpus, then keep the two that belong to this
   * issue. `listSessionsForIssue` asks the question directly, so the projection
   * is built for members only.
   *
   * The fallback is not decoration. `IssueDeps` is satisfied by a dozen test
   * fixtures that supply `listSessions` and nothing else, and by definition the
   * fallback computes the identical answer — same predicate, applied after the
   * pass instead of before. A fixture that never wired the narrow port is slow,
   * not wrong.
   */
  sessionsFor(row: Pick<IssueRow, 'id' | 'worktreePath' | 'stage'>): SessionMeta[] {
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) return []
    const narrow = this.deps.listSessionsForIssue
    if (narrow) return narrow(row.worktreePath, row.id)
    return sessionsForIssue(row.worktreePath, this.deps.listSessions(), row.id)
  }

  /** One issue's markers for the broadcast viewer, as the wire wants them. */
  issueOverlay(issueId: IssueId): IssueUserOverlay {
    return issueOverlayOf(this.requireHydrated().viewerState.get(issueId))
  }

  /** The stored markers, for callers that need `pinnedAt` rather than `pinned`. */
  issueUserState(issueId: IssueId): StoredIssueUserState | undefined {
    return this.requireHydrated().viewerState.get(issueId)
  }

  /**
   * Write one of the broadcast viewer's markers, through the store and the cache
   * together. A PARTIAL patch — see the repository method — so marking an issue
   * read cannot silently un-pin it.
   *
   * Bumps `issueInputsGen`: a marker change is an issue-side wire input, and
   * POD-723's memo would otherwise serve the pre-change payload.
   */
  writeIssueUserState(issueId: IssueId, patch: Partial<StoredIssueUserState>): void {
    const user = this.broadcastViewer()
    this.deps.store.issues.setIssueUserState(user, issueId, patch)
    const viewerState = this.requireHydrated().viewerState
    const next = this.deps.store.issues.getIssueUserState(user, issueId)
    if (next) viewerState.set(issueId, next)
    else viewerState.delete(issueId)
    this.bumpIssueInputs()
  }

  // Dirty-scoped issue wire rebuild [POD-723]. One built IssueWire per issue,
  // keyed by a fingerprint of that issue's OWN toWire inputs. It was sized for a
  // session-driven publish — the O(issues×sessions) republish path POD-701
  // measured, deleted at POD-1574/POD-1576 — where no issue row/label/dep/comment
  // changed, so `issueInputsGen` stayed stable and only issues whose member
  // sessions moved rebuilt. That caller is gone; the memo still pays for itself
  // on {@link broadcastList}, where one write's ripple rebuilds a few rows and
  // every untouched issue reuses its cached payload, skipping toWire's per-issue
  // store queries + O(issues) children scan.
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

  /** The in-memory row map. Row-level quarantine lives in the store
   *  (listIssueRows skips + logs + counts corrupt rows), so hydration is total:
   *  a corrupt row costs that row, never the boot.
   *
   *  The getter used to hydrate on first touch. It does not any more (POD-3256):
   *  a getter cannot await, so the load is an explicit step {@link init} that
   *  the factory runs, and this getter only serves what that step loaded. */
  get rows(): Map<string, IssueRow> {
    return this.requireHydrated().rows
  }

  /**
   * DRAFT-THEN-INSTALL, THE ISSUE REGISTRY'S MODEL [POD-3259, spec §3.6 (b)].
   *
   * `rows` is process-owned mutable state, and until this issue every mutation
   * path took the MAP'S OWN object, assigned onto it, and persisted it — so the
   * uncommitted field set was visible to every other holder of that row for as
   * long as the write took, and a failed commit had to be undone by assigning a
   * backup back over it. That is correct only because nothing can run between
   * the assignment and the commit. With awaits in the picture it has two
   * failure modes, neither of which any test could see today:
   *
   *  - a reader between the mutation and the commit observes fields no
   *    committed row backs, and if the commit then fails it observed a value
   *    that never existed;
   *  - two updates read the same row, both mutate it, one commits, and the
   *    loser's rollback-by-assignment writes the WINNER's row back to a stale
   *    value — silently, with both callers told they succeeded.
   *
   * So a mutation path takes a DRAFT: a copy, pinned to the revision it was cut
   * from. The draft is what gets persisted, and it is installed into the map
   * only after the commit — which is what {@link IssueLifecyclePlan} (the
   * soft-delete and restore paths) has done all along; this generalises it to
   * every write. Nothing is rolled back on failure because the shared object was
   * never touched.
   *
   * The pin is checked ONCE, and durably: `upsertIssue`'s `expectedRevision`
   * precondition refuses inside the transaction, so a loser's write rolls back
   * instead of overwriting the winner's columns. A second check at install time
   * was written first and then removed — it can never fire (the install follows
   * the write that would already have been refused) and it CAN fire wrongly,
   * because `reload()` landing in the gap re-hydrates the map to the revision
   * this write just committed. See {@link StaleIssueRevisionError}.
   */
  private readonly draftOrigins = new WeakMap<IssueRow, number | null>()

  /** A draft of the committed row for `id`, or undefined when there is none. */
  draft(id: string): IssueRow | undefined {
    const committed = this.rows.get(this.resolveRef(id))
    return committed ? this.draftOf(committed) : undefined
  }

  /** {@link draft}, refusing an unknown issue the way {@link rowOrThrow} does. */
  draftOrThrow(id: string): IssueRow {
    const draft = this.draft(id)
    if (!draft) throw new IssueNotFound(id)
    return draft
  }

  /** A draft of a row already in hand. The arrays are copied too: a shallow
   *  spread would share them, and an in-place `blockedBy` edit would then be
   *  exactly the shared mutation drafting exists to prevent. */
  draftOf(committed: IssueRow): IssueRow {
    const copy: IssueRow = {
      ...committed,
      blockedBy: [...committed.blockedBy],
      ...(Array.isArray(committed.humanQuestionOptions)
        ? { humanQuestionOptions: [...committed.humanQuestionOptions] }
        : {}),
    }
    this.draftOrigins.set(copy, committed.revision ?? null)
    return copy
  }

  /** Pin a row that has NEVER been written — a create. Its expected revision is
   *  `null`, so a second create of the same id is refused durably instead of
   *  overwriting the first. */
  registerNewDraft(row: IssueRow): IssueRow {
    this.draftOrigins.set(row, null)
    return row
  }

  /** The revision this row was drafted from, or undefined when the caller built
   *  it outside the draft seam (a row literal, a direct repository test). Such a
   *  row still installs after the commit; it just carries no precondition. */
  private draftPin(row: IssueRow): number | null | undefined {
    return this.draftOrigins.get(row)
  }

  /** The one thing the model forbids outright: persisting the map's own object.
   *  Refused rather than tolerated because it is invisible in every other way —
   *  the write succeeds, the rows are right, and the shared object carried
   *  uncommitted fields the whole time. */
  private refuseMapOwnedRow(row: IssueRow): void {
    if (this.rows.get(row.id) !== row) return
    throw new Error(
      `persist(${row.id}): the map-owned row was mutated in place. Take a draft ` +
        `(IssueRegistry.draft/draftOrThrow) and persist that instead [POD-3259, spec §3.6].`,
    )
  }

  /**
   * Install a committed draft.
   *
   * What goes into the map is a SNAPSHOT of the draft, not the draft itself, and
   * that is load-bearing rather than defensive copying. Several paths persist
   * one draft more than once — `cleanup()` writes it four times as each git step
   * settles, and `inspectRemovableWorktree` writes its caller's row before
   * handing control back. If the caller's object became the map's object, the
   * second write would be a mutation of shared state again, and every write
   * after the first would be refused by {@link refuseMapOwnedRow}. Snapshotting
   * keeps the caller's row private for its whole sequence; re-pinning it to the
   * revision just committed is what lets its next write carry a precondition
   * that is true rather than three writes stale.
   */
  private installDraft(row: IssueRow, pin: number | null | undefined): void {
    this.rows.set(row.id, this.draftOf(row))
    if (pin !== undefined) this.draftOrigins.set(row, row.revision ?? null)
  }

  /** Explicit hydration, run by `IssueService.create` before any reader exists
   *  (POD-3256) — the same load the lazy path performs, done eagerly so boot
   *  surfaces load logs immediately. */
  init(): this {
    this.hydrate()
    return this
  }

  /**
   * The loaded state, or a refusal naming the missing step.
   *
   * Reaching a reader before hydration is a composition mistake, not a
   * recoverable condition: the only two ways to get an IssueStore are the
   * factory (which hydrates) and {@link reload}, so a null here means somebody
   * built the object by a route that no longer exists.
   */
  private requireHydrated(): {
    rows: Map<string, IssueRow>
    viewerState: Map<string, StoredIssueUserState>
  } {
    if (this.hydrated === null || this.viewerState === null) {
      throw new Error(
        'IssueStore read before init(): the issue service hydrates through its factory',
      )
    }
    return { rows: this.hydrated, viewerState: this.viewerState }
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
    // The per-user markers are re-read for the same reason the rows are re-read:
    // a test (or a future external mutator) that wrote them directly must not
    // keep serving a stale overlay. They are re-read HERE rather than on next
    // touch (POD-3256) — `issueOverlay` is called from the synchronous wire
    // serializer, so its read has to have happened already.
    this.viewerState = this.deps.store.issues.listIssueUserState(this.broadcastViewer())
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
    const sessions = this.sessionsFor(row)
    return this.computeUnread(row, sessions)
  }

  /** blocked = open AND ≥1 `blocks` dep whose target issue is not closed. */
  computeBlocked(row: IssueRow, batch?: IssueWireBatch): boolean {
    // With a batch this reads nothing: the outgoing deps for the whole set were
    // fetched once by {@link wireBatch}. Without one it is the single-row case
    // and asks for its own row's deps, as it always did (POD-3257).
    const outgoing = batch
      ? (batch.depsByFrom.get(row.id) ?? [])
      : this.deps.store.issues.listIssueDeps(row.id)
    const blocksTargets = outgoing
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
   *  cost and shipped none of the benefit. `IssueWireBatch.sessions` is GONE too
   *  as of POD-3257 — it was a `listSessions()` per batch that no reader had
   *  wanted since POD-797, and handing the batch to every list serializer would
   *  have bought it once per call instead of once.
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
    const blocked = this.computeBlocked(row, batch)
    const deferred = this.isDeferred(row)
    const ready =
      isIssueStage(row.stage) &&
      isReadyIssueStage(row.stage) &&
      !this.isClosed(row) &&
      !deferred &&
      !blocked
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
      // No cast (POD-1144 resolved POD-362's reported misbrand): the wire field
      // now IS `IssueGraphRefs.shape.blockedByNotes`, so a branch name reaches
      // the client as the string it is. Assign it straight — a cast reappearing
      // here would mean the two types have drifted apart again.
      //
      // POD-1530 renamed the wire KEY to match, so this is no longer a rename at
      // all — it is the same name on both sides. v1 peers still read `blockedBy`;
      // `gateway/legacy-wire-v1-adapter.ts` renames it back for them.
      blockedByNotes: issue.blockedByNotes,
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

  /**
   * The joins {@link toWire} would otherwise re-run PER ROW — labels, deps in
   * both directions, and the children scan — fetched once for a whole set.
   *
   * Extracted from `list` so any multi-row path can have it (POD-1102). Without
   * it a write touching hundreds of rows pays hundreds of label queries and
   * hundreds of O(N) children scans, which is most of how a scope compaction
   * spent eight seconds blocking the event loop.
   *
   * PUBLIC AND USED BY EVERY MULTI-ROW READ SINCE POD-3257. `list` was the only
   * caller, so every other list serializer paid four per-row queries — 120 of
   * the 371 the issue-frame baseline measured. On a networked backend each one
   * is a round trip, so a serializer that does not take a batch is an N+1 by
   * construction; the two reads here answer for the whole set.
   *
   * `sessions` LEFT THE BATCH with POD-3257: `toWire` stopped reading it at
   * POD-797 and nothing else ever did, so it was a `listSessions()` per batch
   * bought for nobody — and handing the batch to more callers would have bought
   * it once per call.
   */
  wireBatch(): IssueWireBatch {
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
    return {
      labelsByIssue,
      depsByFrom,
      dependentsByTo,
      childrenByParent,
      prefixesByRepoPath: new Map(),
    }
  }

  list(repoPath?: string): IssueWire[] {
    const commentCounts = this.deps.store.issues.countIssueCommentsByIssue()
    const batch = this.wireBatch()
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
    const inScope = this.repoScopeFilter(repoPath)
    return [...this.rows.values()]
      .filter((r) => inScope(r))
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
    return this.repoScopeFilter(repoPath)(row)
  }

  /**
   * {@link inRepoScope} as ONE predicate for a whole pass: the scope id and the
   * path->repo_id resolver are read before the loop, so the per-row test is
   * arithmetic over rows already in hand (POD-3257).
   *
   * Every list serializer used to hand `.filter` a lambda calling
   * `resolveRepoIdForPath` per row — two store calls per row, and the second one
   * re-materialized the whole `repos` table each time, which is the shape
   * POD-1638 measured at 24206 reads of a 13-row table in one second.
   *
   * It is also why this is a filter FACTORY rather than a cheaper `inRepoScope`:
   * an array callback may not contain a store call AT ALL once the store is
   * async, because `.filter` cannot await one (spec section 2.5 item 5).
   * Hoisting the read is the fix; memoizing it would not be.
   *
   * `inRepoScope` is the single-row case of this one, so the two cannot drift.
   */
  repoScopeFilter(repoPath: string | undefined): (row: IssueRow) => boolean {
    if (!repoPath) return () => true
    const resolve = this.deps.store.repos.repoIdResolver()
    const scope = resolve(repoPath)
    return (row: IssueRow) => (row.repoId ?? resolve(row.repoPath)) === scope
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
        // One registry read for the scan, not one per row (POD-3257): every row
        // without a stored repo_id used to re-resolve its path through the store
        // from inside the filter.
        const resolve = this.deps.store.repos.repoIdResolver()
        const repoId = repo.repoId ?? resolve(repo.path)
        const matches = [...this.rows.values()].filter(
          (r) => r.seq === nice.seq && (r.repoId ?? resolve(r.repoPath)) === repoId,
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
      const inScope = this.repoScopeFilter(scopeRepoPath)
      const scoped = matches.filter((r) => inScope(r))
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
   *  The normalized parallel to {@link allWire}. Public because it predates
   *  POD-1576, when the relay's write-less publish tail was its outside caller;
   *  {@link reconcileAndPublish} is the only caller left, so this is the
   *  service's own truth now and no publisher unions anything into it. */
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
    op: EntityChangeSpec['op'],
  ): EntityChangeSpec[] {
    return deps.map((dep) => {
      const value = issueDepToProjection(dep)
      // A remove carries no value (the ledger drops it; the row is gone). An
      // upsert carries the whole edge — there is no partial edge.
      // Shape is {@link EntityChangeSpec} — the ledger's composed change spec —
      // not a hand-restated issueDep field list (POD-1251).
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
      log.warn('repo projection publish failed', { err })
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
      /** Extra entity changes this write declares — {@link EntityChangeSpec}, composed. */
      extraChanges?: readonly EntityChangeSpec[] | (() => readonly EntityChangeSpec[])
    },
  ): IssueWire {
    // DRAFT-THEN-INSTALL (#247 rebuilt for the async store, POD-3259). `row` is
    // a DRAFT — a copy pinned to the revision it was cut from — never the
    // map-owned object, which is what {@link refuseMapOwnedRow} enforces. There
    // is therefore nothing to roll back on a throw: no holder of the committed
    // row ever saw this write, the map still has the row sqlite still has, and
    // the install below is what publishes both at once. What replaced the
    // backup-and-restore is the pin: `expectedRevision` refuses the write
    // durably, inside the transaction, if the row moved after the draft was cut.
    this.refuseMapOwnedRow(row)
    const pin = this.draftPin(row)
    // One spelling for absent (POD-820): `''` on a nullable text column is a
    // second encoding of `null` that no reader can tell apart. Collapsed here —
    // the choke point every row write passes through — and BEFORE the backup is
    // consulted on rollback, so a failed commit restores the committed spelling
    // rather than leaving the normalization behind.
    normalizeBlankIssueText(row)
    // touch:false = non-activity writes: (1) read-tracking (markIssueRead/Unread)
    // and (2) organizational-only patches (pinned/sortKey via update). Those must
    // not bump updatedAt — the stamp would land a tick AFTER readAt and
    // computeUnread (lastActivity > readAt) would flip the issue straight back to
    // unread. It also must not reorder sidebar recency.
    if (opts?.touch !== false) row.updatedAt = this.now()
    // NO try/catch: there is nothing to undo on a throw, which is the whole
    // point of the draft above. The commit stands unguarded and the caller sees
    // the ledger's own failure.
    const wire = this.deps.ledger.commit({
      write: () => {
        extraWrite?.()
        this.deps.store.issues.upsertIssue(row, pin === undefined ? undefined : { expectedRevision: pin })
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
        ...(typeof opts?.extraChanges === 'function'
          ? opts.extraChanges()
          : (opts?.extraChanges ?? [])),
      ],
    }).result
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
    // would make the next full-list reconcile fabricate an upsert for it. Since
    // POD-3259 this is the ONLY way an update becomes visible in memory too, so
    // it is no longer a no-op for anything.
    this.installDraft(row, pin)
    return wire
  }

  /** Multi-row variant: every affected issue row, its normalized write, and
   * every declared projection change share ONE ledger commit. Built for
   * shipping; also the seam a sort-scope compaction writes through, which is why
   * `touch` is an option — see {@link persist} for what `false` means, and
   * POD-1102 for why a scope repair must not mark a whole repo unread. */
  persistManyWith<T>(
    rows: IssueRow[],
    write: () => T,
    extraChanges: (result: T) => readonly EntityChangeSpec[],
    events: (result: T) => readonly {
      kind: string
      subject: string
      payload: Record<string, unknown>
    }[] = () => [],
    opts?: { touch?: boolean },
  ): { issues: IssueWire[]; result: T } {
    // DRAFT-THEN-INSTALL, same model as {@link persistWith} (POD-3259): every
    // row here is a draft pinned to the revision it was cut from, so the
    // backup-and-restore loop this replaced has nothing left to undo.
    const pins = new Map<string, number | null | undefined>()
    for (const row of rows) {
      this.refuseMapOwnedRow(row)
      pins.set(row.id, this.draftPin(row))
      normalizeBlankIssueText(row)
      if (opts?.touch !== false) row.updatedAt = this.now()
    }
    // The events below read `repoPath` off the map, which still holds the
    // PRE-commit rows while the drafts are in flight. Read the drafts first so a
    // write that moves an issue between repos stamps its events with where the
    // issue is going rather than where it was.
    const drafted = new Map<string, IssueRow>(rows.map((row) => [row.id, row] as const))
    let result!: T
    let wires!: IssueWire[]
    let eventIds: number[] = []
    // NO try/catch — see persistWith: the drafts are the only objects that
    // carry this write, so a throw has nothing to undo.
    const committed = this.deps.ledger.commit({
      write: () => {
        result = write()
        for (const row of rows) {
          const pin = pins.get(row.id)
          this.deps.store.issues.upsertIssue(
            row,
            pin === undefined ? undefined : { expectedRevision: pin },
          )
        }
        // Beyond a handful of rows the per-row joins dominate — see
        // `wireBatch`. Built HERE, after `write` and the upserts, so it can
        // never serve a projection from before the mutation it describes; the
        // threshold keeps the shipping paths (a few rows) off an
        // O(all issues) prefetch they would not amortize.
        const batch = rows.length > 8 ? this.wireBatch() : undefined
        wires = rows.map((row) => this.toWire(row, undefined, batch))
        eventIds = events(result).map((event) =>
          this.deps.store.events.appendEvent(
            {
              ts: this.now(),
              kind: event.kind,
              subject: event.subject,
              repoPath:
                drafted.get(event.subject)?.repoPath ??
                this.rows.get(event.subject)?.repoPath ??
                null,
              payload: event.payload,
            },
            { announce: false },
          ),
        )
        return { result, wires }
      },
      changes: ({ result: value, wires: committedWires }) => [
        ...rows.flatMap((row, index) => [
          {
            entity: 'issue' as const,
            id: row.id,
            op: 'upsert' as const,
            value: committedWires[index]!,
          },
          ...this.projectionChanges(row),
        ]),
        ...extraChanges(value),
      ],
    }).result
    result = committed.result
    wires = committed.wires
    this.bumpIssueInputs()
    for (const row of rows) this.installDraft(row, pins.get(row.id))
    for (const eventId of eventIds) this.deps.store.events.announceEvent(eventId)
    return { issues: wires, result }
  }

  /** Full-list broadcast for mutations with cross-issue effects (see persist).
   *  No repository write of its own. Runs a ledger RECONCILE over the full wire
   *  list rather than per-write declarations because the full-list path exists
   *  exactly to catch DERIVED ripples: closing issue X flips ready/blocked on
   *  its dependents' wire rows (and childDoneCount on its parent) without any
   *  write touching those rows — a per-write declaration alone would miss
   *  them. Every site that mutates-then-broadcastLists keeps exactly this
   *  shape ([spec:SP-3fe2] #255). The reconciled rows ARE the rows the snapshot
   *  carries — local only, with no publisher-side union left since POD-309
   *  retired the hub mirror — so the change log records exactly what legacy
   *  clients see. */
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
    if (!r) throw new IssueNotFound(id)
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
