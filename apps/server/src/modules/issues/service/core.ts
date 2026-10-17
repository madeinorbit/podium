import { createLogger } from '@podium/logger'
import {
  asIssueId,
  firstAdminMemberId,
  type Instant,
  type IssueDepProjection,
  type IssueGitState,
  IssueGitStateProjection,
  type IssueId,
  type IssuePanel,
  type IssueProjection,
  type IssueUserOverlay,
  isIssueBlocked,
  isIssueClosed,
  isIssueDeferred,
  isIssueStage,
  isReadyIssueStage,
  isSystemOwnedIssueStage,
  issueOverlayOf,
  issueUserStateRowId,
  issueUserStateToWire,
  type MachineId,
  machinePathHasSuffix,
  type RepoProjection,
  requireInstant,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import { parseIssueRef } from '@podium/protocol'
import type { EntityChangeSpec } from '@podium/sync'
import { slugifyBranch } from '../../../issue-util'
import type { IssueRow, StoredIssueUserState } from '../../../store'
import { afterCommit } from '../../../store/executor/executor'
import { currentOperation, operationSlot } from '../../../store/executor/operation-scope'
import { readScopeSlot, currentReadScope } from '../../../store/executor/read-scope'
import { decodePanel } from '../../../store/issue-storage'
import type { SessionFacts } from '../../sessions/facts'
import { normalizeBlankIssueText } from '../blank-text'
import {
  issueDepProjectionRows,
  issueDepToProjection,
  issueProjectionRows,
  issueRowToProjection,
  repoProjectionRows,
} from '../projection'
import { IssueNotFound } from './not-found'
import { IssueRefusal } from './refusal'
import type { IssueDeps } from './types'

const log = createLogger('server:issues')

/** The columns a repository-scope test reads off a row. */
type IssueScopeRow = Pick<IssueRow, 'repoId' | 'repoPath' | 'machineId'>

/** A reference's row inside one repository: the row stamped with its id, or a
 *  legacy row (no repo id yet) whose path resolves to it. First by repository
 *  path, then id. */
function referenceInRepoOf(
  atSeq: readonly { id: IssueId; repoId: string | null; repoPath: string; machineId: MachineId | null }[],
  repoId: string,
  resolve: ((path: string, machineId?: MachineId | null) => string | null) | undefined,
): IssueId | null {
  const matches = atSeq.filter(
    (row) =>
      row.repoId === repoId ||
      (row.repoId === null && resolve !== undefined && resolve(row.repoPath, row.machineId) === repoId),
  )
  matches.sort((a, b) =>
    a.repoPath === b.repoPath ? (a.id < b.id ? -1 : 1) : Buffer.compare(Buffer.from(a.repoPath), Buffer.from(b.repoPath)),
  )
  return matches[0]?.id ?? null
}

/**
 * The one mutable issue store shared by every tracker capability.
 *
 * This owns hydration, wire serialization, ref resolution and the
 * persist/broadcast tail every mutation funnels through. Capability modules are
 * composed over this object; none owns a second row cache.
 */
export class IssueStore {
  constructor(readonly deps: IssueDeps) {}

  /**
   * Freeze the machine choice an implicit operation would otherwise make inside
   * DaemonRpcService. Explicit pins already bypass that resolver and keep winning.
   * The fallback preserves lightweight test fixtures that do not wire the port;
   * the relay always supplies MachinesService.resolveMachine.
   */
  async resolveWorktreeMachine(
    machineId: MachineId | null | undefined,
    cwd: string,
  ): Promise<MachineId> {
    return (
      machineId ??
      (await this.deps.resolveMachine?.(undefined, cwd)) ??
      this.deps.store.hostMachineId
    )
  }

  /**
   * WHOSE per-user markers the broadcast carries. `firstAdminMemberId()` spelled
   * out, never a default: an unidentified principal must fail closed rather than
   * resolve to an operator identity (readiness §3.1.6 S4). POD-1077 replaces the
   * body with the request's principal; every caller already asks the question.
   */
  async broadcastViewer(): Promise<UserId> {
    // Asked once per row by a report pass and before and after a marker write;
    // one answer per operation (or read pass). Only a change of administrators
    // moves it, which no issue operation makes.
    const held = currentOperation()?.slot(this.viewerOfOperation) ?? currentReadScope().slot(this.viewerSlot)
    held.viewer ??= firstAdminMemberId(this.deps.store)
    return await held.viewer
  }

  private readonly viewerSlot = readScopeSlot<{ viewer?: Promise<UserId> }>(() => ({}))
  private readonly viewerOfOperation = operationSlot<{ viewer?: Promise<UserId> }>(() => ({}))

  /**
   * THE MEMBER SESSIONS OF ONE ISSUE — the narrow read [POD-1639].
   *
   * Every caller here used to spell `sessionsForIssue(row.worktreePath,
   * deps.listSessions(), row.id)`: build the reader-scoped projection for all
   * 1119 sessions on the live corpus, then keep the two that belong to this
   * issue. `listSessionsForIssue` asks the question directly, so the projection
   * is built for members only.
   *
   * WIRED, and only the callers that hand these sessions to a reader should be
   * here [POD-3857]: the members carry `displayRef`, which exists only on the
   * projection. Everything the service decides for ITSELF asks
   * {@link factsFor} instead.
   */
  async sessionsFor(row: Pick<IssueRow, 'id' | 'worktreePath' | 'stage'>): Promise<SessionMeta[]> {
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) return []
    return await this.deps.listSessionsForIssue(row.worktreePath, row.id)
  }

  /** The same membership question as facts — see {@link SessionFacts}. No
   *  visibility check and no wire fields; read from the database since
   *  POD-6160, so it answers for sessions that are not resident. */
  async factsFor(row: Pick<IssueRow, 'id' | 'worktreePath' | 'stage'>): Promise<SessionFacts[]> {
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) return []
    return await this.deps.readSessionFactsByIssue(row.worktreePath, row.id)
  }

  /** One issue's markers for the broadcast viewer, as the wire wants them. */
  async issueOverlay(issueId: IssueId): Promise<IssueUserOverlay> {
    return issueOverlayOf(await this.issueUserState(issueId))
  }

  /** The stored markers, for callers that need `pinnedAt` rather than `pinned`.
   *  Read from the database, batched per operation (POD-6158). */
  async issueUserState(issueId: IssueId): Promise<StoredIssueUserState | undefined> {
    return await this.deps.store.issues.loadIssueUserState(await this.broadcastViewer(), issueId)
  }

  /** {@link issueUserState} for many issues: one batched read (POD-6191). */
  async issueUserStates(ids: Iterable<string>): Promise<Map<string, StoredIssueUserState | undefined>> {
    return await this.deps.store.issues.loadIssueUserStates(await this.broadcastViewer(), [...new Set(ids)])
  }

  /**
   * Write one of the broadcast viewer's markers. A PARTIAL patch — see the
   * repository method — so marking an issue read cannot silently un-pin it.
   */
  async writeIssueUserState(issueId: IssueId, patch: Partial<StoredIssueUserState>): Promise<void> {
    const user = await this.broadcastViewer()
    await this.deps.ledger.commit({
      write: async () => {
        await this.deps.store.issues.setIssueUserState(user, issueId, patch)
        return await this.deps.store.issues.getIssueUserState(user, issueId)
      },
      changes: (state) => [
        {
          entity: 'issueUserState',
          id: issueUserStateRowId(user, issueId),
          ...(state
            ? {
                op: 'upsert' as const,
                value: issueUserStateToWire({ userId: user, entityId: issueId, ...state }),
              }
            : { op: 'remove' as const }),
        },
      ],
    })
  }

  /** Ephemeral observations, published only as issueGitState rows. */
  readonly gitStates = new Map<string, IssueGitState>()

  /**
   * DRAFTS, THE ISSUE REGISTRY'S MODEL [POD-3259, spec §3.6 (b)].
   *
   * A mutation path takes a DRAFT: a private copy of the row, pinned to the
   * revision it was cut from. The draft is what gets persisted, and the pin is
   * checked ONCE, durably: `upsertIssue`'s `expectedRevision` precondition
   * refuses inside the transaction, so of two writes cut from one revision the
   * loser rolls back instead of overwriting the winner's columns. See
   * {@link StaleIssueRevisionError}. Since POD-6158 there is no in-memory copy
   * of the issues to install a committed draft into: every reader asks the
   * database.
   */
  private readonly draftOrigins = new WeakMap<IssueRow, number | null>()
  /** Where each draft's issue had its worktree when the draft was cut (or
   *  last committed), so a write can tell that it moved one (POD-6158). */
  private readonly draftWorktrees = new WeakMap<IssueRow, string | null>()

  /** A draft of the committed row for `id`, or undefined when there is none. */
  async draft(id: string): Promise<IssueRow | undefined> {
    const committed = await this.liveRow(await this.resolveRef(id))
    return committed ? this.draftOf(committed) : undefined
  }

  /**
   * One issue row from the database, read now (POD-6158): the row a write is
   * drafted from or a command acts on. Never the operation's memo, so a draft
   * is cut from the latest commit.
   */
  async liveRow(id: string): Promise<IssueRow | undefined> {
    return (await this.deps.store.issues.getIssueLive(id)) ?? undefined
  }

  /**
   * One issue row for a READ (POD-6158): batched with the other loads of its
   * tick and memoized for the operation, write spans included (the loader is
   * exact across writes, POD-6189). Deleted rows included.
   */
  async row(id: string): Promise<IssueRow | undefined> {
    return await this.deps.store.issues.loadIssue(id)
  }

  /** {@link row} for many ids in one statement per 500; absent ids are absent. */
  async rowsByIds(ids: Iterable<string>): Promise<Map<string, IssueRow>> {
    return await this.deps.store.issues.loadIssues([...new Set(ids)])
  }

  /** {@link draft}, refusing an unknown issue the way {@link rowOrThrow} does. */
  async draftOrThrow(id: string): Promise<IssueRow> {
    const draft = await this.draft(id)
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
    this.draftWorktrees.set(copy, worktreeOf(committed))
    return copy
  }

  /** Pin a row that has NEVER been written — a create. Its expected revision is
   *  `null`, so a second create of the same id is refused durably instead of
   *  overwriting the first. */
  registerNewDraft(row: IssueRow): IssueRow {
    this.draftOrigins.set(row, null)
    this.draftWorktrees.set(row, null)
    return row
  }

  /** Where this row's issue had its worktree before the write in flight: the
   *  draft's record, or, for a row that was not drafted, the database's. */
  private async worktreeBefore(row: IssueRow): Promise<string | null> {
    const drafted = this.draftWorktrees.get(row)
    if (drafted !== undefined) return drafted
    const current = await this.deps.store.issues.getIssueLive(row.id)
    return current ? worktreeOf(current) : null
  }

  /**
   * Announce that a write in this span moved an issue's worktree (POD-6158,
   * for POD-6160's message routing). The hook runs after the OUTERMOST commit,
   * so a write that rolls back announces nothing. Nothing when the worktree
   * did not change.
   */
  announceWorktreeMove(issueId: IssueId, previous: string | null, next: string | null): void {
    const hook = this.deps.onIssueWorktreeMoved
    if (!hook || previous === next) return
    afterCommit(async () => {
      try {
        hook({ issueId, previousWorktreePath: previous, worktreePath: next })
      } catch (err) {
        log.warn('issue worktree move announcement failed', { issueId, err })
      }
    }, 'issue-worktree-moved')
  }

  /** The revision this row was drafted from, or undefined when the caller built
   *  it outside the draft seam (a row literal, a direct repository test). Such a
   *  row still installs after the commit; it just carries no precondition. */
  private draftPin(row: IssueRow): number | null | undefined {
    return this.draftOrigins.get(row)
  }

  /**
   * Re-pin a committed draft to the revision just written. It records, on the
   * caller's own private draft object, which revision the database now holds
   * for it, so a draft persisted again carries a precondition that is true of
   * the row inside this span rather than one that is a write stale. If the
   * enclosing span then rolls back, the pin is ahead of the restored row and the
   * draft's NEXT write is refused by its own precondition: fail-closed, the safe
   * direction.
   */
  private repinDraft(row: IssueRow, pin: number | null | undefined): void {
    if (pin !== undefined) {
      this.draftOrigins.set(row, row.revision ?? null)
      this.draftWorktrees.set(row, worktreeOf(row))
    }
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
  /** Generic over the row: archive checks need only each session's activity time. */
  computeUnread(
    row: IssueRow,
    sessions: readonly { lastActiveAt: string }[],
    readAt: string | null | undefined,
  ): boolean {
    if (row.deletedAt) return false
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
  async unreadFor(id: IssueId): Promise<boolean> {
    const row = await this.row(id)
    if (row === undefined) return false
    const sessions = await this.sessionsFor(row)
    return this.computeUnread(row, sessions, (await this.issueOverlay(row.id)).readAt)
  }

  // ---- hierarchy reads from the database (POD-6192) ------------------------

  /**
   * A parent's children from the database, in repository order (repository
   * path, then sequence). `live` leaves out deleted ones, `unarchived`
   * archived ones.
   */
  async childRows(parentId: string, opts: { live?: boolean; unarchived?: boolean } = {}): Promise<IssueRow[]> {
    return await this.deps.store.issues.listIssueRowsWhere(
      {
        repo: false,
        readable: false,
        live: opts.live === true,
        ...(opts.unarchived ? { unarchived: true } : {}),
        parents: 1,
        order: 'path-seq',
      },
      { parents: [parentId] },
    )
  }

  /**
   * Every descendant of `rootId`, read one level per statement (the depth
   * bounds the count, not the number of issues), depth first with each level in
   * sequence order. `live` leaves out deleted ones and their subtrees. Parent
   * cycles stop at the first repeat.
   */
  async descendantRows(rootId: string, opts: { live?: boolean } = {}): Promise<IssueRow[]> {
    const byParent = new Map<string, IssueRow[]>()
    const seen = new Set<string>([rootId])
    let level = [rootId]
    while (level.length > 0) {
      const rows = await this.deps.store.issues.listIssueRowsWhere(
        { repo: false, readable: false, live: opts.live === true, parents: 1, order: 'path-seq' },
        { parents: level },
      )
      level = []
      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        const siblings = byParent.get(row.parentId!)
        if (siblings) siblings.push(row)
        else byParent.set(row.parentId!, [row])
        level.push(row.id)
      }
    }
    const out: IssueRow[] = []
    const walk = (parentId: string): void => {
      for (const child of [...(byParent.get(parentId) ?? [])].sort((a, b) => a.seq - b.seq)) {
        out.push(child)
        walk(child.id)
      }
    }
    walk(rootId)
    return out
  }

  /**
   * Which of these rows are ready (`isReady`), with their dependencies and
   * their blockers' closure read once for the set (POD-6192).
   */
  async readyAmong(rows: readonly IssueRow[]): Promise<Set<string>> {
    const issues = this.deps.store.issues
    const deps = await issues.depsFromIssues(rows.map((row) => row.id))
    const closure = await issues.closureOf(deps.filter((d) => d.type === 'blocked-by').map((d) => d.toId))
    const ready = new Set<string>()
    for (const row of rows) {
      const blocked = isIssueBlocked(
        row,
        deps.filter((d) => d.fromId === row.id && d.type === 'blocked-by').map((d) => closure.get(d.toId)),
      )
      if (isIssueStage(row.stage) && isReadyIssueStage(row.stage) && !this.isClosed(row) && !this.isDeferred(row) && !blocked) {
        ready.add(row.id)
      }
    }
    return ready
  }

  /** Only this issue's own fields and labels enter its publication. */
  async projection(row: IssueRow): Promise<IssueProjection> {
    return issueRowToProjection(row, await this.deps.store.issues.getIssueLabels(row.id))
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
  async inRepoScope(row: IssueScopeRow, repoPath: string | undefined): Promise<boolean> {
    return (await this.repoScopeFilter(repoPath))(row)
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
  async repoScopeFilter(repoPath: string | undefined): Promise<(row: IssueScopeRow) => boolean> {
    if (!repoPath) return () => true
    const resolve = await this.deps.store.repos.issueRepoIdResolver()
    const scope = resolve(repoPath)
    return (row: IssueScopeRow) =>
      scope !== null && (row.repoId ?? resolve(row.repoPath, row.machineId)) === scope
  }

  /**
   * The chip batch: display refs and unambiguous #N, as before. One statement
   * for every sequence number the batch names (POD-6158), then each ref is
   * decided over the rows at its number; prefix lookups are shared within the
   * batch.
   */
  async resolveRefs(refs: readonly string[]): Promise<Array<{ ref: string; id: IssueId | null }>> {
    const parsed = [...new Set(refs)].map((ref) => {
      const nice = parseIssueRef(ref.trim().toUpperCase())
      const numeric = nice ? null : /^#(\d+)$/.exec(ref.trim())
      return { ref, nice, seq: nice ? nice.seq : numeric ? Number(numeric[1]) : undefined }
    })
    const seqs = parsed.flatMap((entry) => (entry.seq === undefined ? [] : [entry.seq]))
    const bySeq = await this.deps.store.issues.issueRefsAtSeqs(seqs)
    const prefixes = new Map<string, ReturnType<IssueDeps['store']['repos']['repoForPrefix']>>()
    let resolver: Promise<Awaited<ReturnType<IssueDeps['store']['repos']['issueRepoIdResolver']>>> | undefined
    return await Promise.all(
      parsed.map(async ({ ref, nice, seq }) => {
        const atSeq = seq === undefined ? [] : (bySeq.get(seq) ?? [])
        if (nice) {
          let lookup = prefixes.get(nice.prefix)
          if (!lookup) {
            lookup = this.deps.store.repos.repoForPrefix(nice.prefix)
            prefixes.set(nice.prefix, lookup)
          }
          const repo = await lookup
          if (!repo) return { ref, id: null }
          const legacy = atSeq.some((row) => row.repoId === null)
          const resolve = legacy ? await (resolver ??= this.deps.store.repos.issueRepoIdResolver()) : undefined
          return { ref, id: referenceInRepoOf(atSeq, repo.repoId, resolve) }
        }
        return { ref, id: atSeq.length === 1 ? (atSeq[0]?.id ?? null) : null }
      }),
    )
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
  async resolveRef(ref: string, scopeRepoPath?: string): Promise<IssueId> {
    // The internal id needs no lookup; any other existing id passes through too.
    if (ref.startsWith('iss_') || (await this.deps.store.issues.hasIssue(ref))) return asIssueId(ref)
    // Human-facing nice id `PREFIX-seq` (#474), read over the rows at its
    // sequence number (POD-6158). The prefix identifies the repo server-wide, so
    // this resolves without a path qualifier; a prefix no repo owns falls
    // through. CLI courtesy: `pod-13` reads as `POD-13`.
    const nice = parseIssueRef(ref.trim().toUpperCase())
    if (nice) {
      const repo = await this.deps.store.repos.repoForPrefix(nice.prefix)
      if (repo) {
        const atSeq = await this.deps.store.issues.issueRefsAt(nice.seq, repo.repoId)
        const resolve = atSeq.some((row) => row.repoId === null)
          ? await this.deps.store.repos.issueRepoIdResolver()
          : undefined
        const id = referenceInRepoOf(atSeq, repo.repoId, resolve)
        if (id) return id
      }
    }
    const qualified = /^(.+)#(\d+)$/.exec(ref.trim())
    if (qualified) {
      const [, repo, seqStr] = qualified
      const seq = Number(seqStr)
      const matches = (await this.deps.store.issues.issueRefsAt(seq)).filter(
        (r) => machinePathHasSuffix(r.repoPath, repo!) || r.repoId === repo,
      )
      if (matches.length === 1) return matches[0]!.id
      if (matches.length > 1) {
        const where = matches.map((r) => `${r.repoPath}#${r.seq} (${r.id})`).join(', ')
        throw new IssueRefusal(`ambiguous issue ref ${ref} (matches ${where})`)
      }
      return asIssueId(ref)
    }
    const m = /^#?(\d+)$/.exec(ref.trim())
    if (!m) return asIssueId(ref)
    const seq = Number(m[1])
    let matches = await this.deps.store.issues.issueRefsAt(seq)
    if (matches.length > 1 && scopeRepoPath) {
      const inScope = await this.repoScopeFilter(scopeRepoPath)
      const scoped = matches.filter((r) => inScope(r))
      if (scoped.length > 0) matches = scoped
    }
    if (matches.length === 1) return matches[0]!.id
    if (matches.length > 1) {
      const where = matches.map((r) => `${r.repoPath}#${r.seq}`).join(', ')
      throw new IssueRefusal(
        `ambiguous issue ref #${seq} (matches ${where}); qualify it as <repoPath>#${seq}`,
      )
    }
    return asIssueId(ref)
  }

  // ---- The normalized issue projection [POD-796, ADR 4 D7.1] ----
  //
  /** An issue's own row and independently keyed companions in the same commit. */
  async companionChanges(row: IssueRow, projection?: IssueProjection): Promise<EntityChangeSpec[]> {
    const states = await this.deps.store.issues.listIssueUserStateRows(row.id)
    return [
      {
        entity: 'issueProjection',
        id: row.id,
        op: 'upsert',
        value: projection ?? (await this.projection(row)),
      },
      this.gitStateChange(row),
      ...states.map((state) => ({
        entity: 'issueUserState' as const,
        id: issueUserStateRowId(state.userId, state.entityId),
        op: 'upsert' as const,
        value: issueUserStateToWire(state),
      })),
    ]
  }

  private gitStateChange(row: IssueRow): EntityChangeSpec {
    const state = row.deletedAt ? undefined : this.gitStates.get(row.id)
    return state
      ? {
          entity: 'issueGitState',
          id: row.id,
          op: 'upsert',
          value: IssueGitStateProjection.parse({ id: row.id, ...state }),
        }
      : { entity: 'issueGitState', id: row.id, op: 'remove' }
  }

  /** Ephemeral git observations and durable personal markers share the feed's
   * recovery path. Boot removes prior-process git observations; purge removes
   * personal rows whose issue was deleted. */
  async reconcileCompanions(): Promise<void> {
    // The observed issues are read by id, in repository order, and diffed in
    // the same span (POD-6158).
    await this.deps.store.transact(async () => {
      const observed = await this.deps.store.issues.getIssues([...this.gitStates.keys()])
      const gitRows = inRepositoryOrder([...observed.values()], (row) => row).flatMap((row) => {
        const change = this.gitStateChange(row)
        return change.op === 'upsert' ? [{ id: change.id, value: change.value }] : []
      })
      await this.deps.ledger.reconcile('issueGitState', gitRows)
    })
    const states = await this.deps.store.issues.listIssueUserStateRows()
    await this.deps.ledger.reconcile(
      'issueUserState',
      states.map((state) => ({
        id: issueUserStateRowId(state.userId, state.entityId),
        value: issueUserStateToWire(state),
      })),
    )
  }

  /** Full LOCAL projection truth for a reconcile. `undefined` = do not reconcile
   *  this kind (a row that cannot be projected — see {@link issueProjectionRows}
   *  on why that is all-or-nothing). Flag off returns EMPTY, not undefined, and
   *  the difference is the rollback — see {@link EMPTY_NORMALIZED_TRUTH}.
   *
   *  Used only by boot reconciliation and explicit normalized truth reads.
   *
   *  Read from the database a page at a time, each page's labels by id, and
   *  returned in repository order (POD-6158). Still a read of every issue;
   *  {@link reconcileProjections} reads and diffs in one span. */
  async allProjections(): Promise<{ id: string; value: IssueProjection }[] | undefined> {
    const projected: { row: IssueRow; projection: { id: IssueId; value: IssueProjection } }[] = []
    for await (const page of this.deps.store.issues.issueRowPages()) {
      const labels = await this.deps.store.issues.labelsOfIssues(page.map((row) => row.id))
      const projections = issueProjectionRows(page, (id) => labels.get(id) ?? [])
      if (!projections) return undefined
      projections.forEach((projection, index) => projected.push({ row: page[index]!, projection }))
    }
    return inRepositoryOrder(projected, (entry) => entry.row).map((entry) => entry.projection)
  }

  /** Reconcile the issueProjection kind against the database's full truth,
   *  read and diffed in one span, so no write commits between the read and the
   *  diff it would undo. */
  async reconcileProjections(): Promise<void> {
    await this.deps.store.transact(async () => {
      const projections = await this.allProjections()
      if (projections) await this.deps.ledger.reconcile('issueProjection', projections)
    })
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
  async allDepProjections(): Promise<{ id: string; value: IssueDepProjection }[] | undefined> {
    return issueDepProjectionRows(await this.deps.store.issues.listAllIssueDeps())
  }

  /** Full LOCAL repo truth for a reconcile. O(repos) — a handful of
   *  rows, deduped to the LOGICAL repo (several checkouts, one entity). */
  async allRepoProjections(): Promise<{ id: string; value: RepoProjection }[] | undefined> {
    return repoProjectionRows(await this.deps.store.repos.listRepos())
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
  async publishRepos(): Promise<void> {
    const repos = await this.allRepoProjections()
    if (!repos) return
    try {
      await this.deps.ledger.reconcile('repo', repos)
    } catch (err) {
      log.warn('repo projection publish failed', { err })
    }
  }

  /** Reconcile own rows and companions at boot or after a hard delete. */
  async reconcileAndPublish(): Promise<void> {
    await this.reconcileProjections()
    await this.reconcileCompanions()
    // The edges reconcile on the same full-truth passes [POD-822], for the same
    // reason the projections do: this path exists to catch what no write
    // declared, and a CASCADE delete (an issue removed takes its edges with it)
    // is exactly that.
    const depProjections = await this.allDepProjections()
    if (depProjections) await this.deps.ledger.reconcile('issueDep', depProjections)
  }
  /** Append to the durable event log. Best-effort: a log failure must never
   *  break the mutation that triggered it. repoPath comes from the subject row. */
  async emitEvent(kind: string, subject: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.store.events.appendEvent({
        ts: this.now(),
        kind,
        subject,
        repoPath: (await this.row(subject))?.repoPath ?? null,
        payload,
      })
    } catch {}
  }
  /** Persist one row and publish only its normalized data. */
  async persist(row: IssueRow, opts?: { touch?: boolean }): Promise<IssueProjection> {
    return await this.persistWith(row, undefined, opts)
  }

  /** persist() plus an extra repository write (labels/comments/deps/mail) that
   *  must land inside the SAME transaction as the row upsert. The ledger's
   *  commit ([spec:SP-3fe2] #255) binds the write and its declared change row
   *  into one transact span — the durable change log can never say something
   *  the issue table doesn't — then the funnel fans the committed changes out. */
  async persistWith(
    row: IssueRow,
    extraWrite?: () => unknown | Promise<unknown>,
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
      extraChanges?:
        | readonly EntityChangeSpec[]
        | (() => readonly EntityChangeSpec[] | Promise<readonly EntityChangeSpec[]>)
    },
  ): Promise<IssueProjection> {
    // `row` is a DRAFT (POD-3259) — a private copy pinned to the revision it was
    // cut from — so there is nothing to roll back on a throw. The pin is the
    // guard: `expectedRevision` refuses the write durably, inside the
    // transaction, if the row moved after the draft was cut.
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
    let committedProjectionChanges: readonly EntityChangeSpec[] = []
    let committedExtraChanges: readonly EntityChangeSpec[] = []
    const wire = (
      await this.deps.ledger.commit({
        write: async () => {
          await extraWrite?.()
          const worktreeWas = await this.worktreeBefore(row)
          await this.deps.store.issues.upsertIssue(
            row,
            pin === undefined ? undefined : { expectedRevision: pin },
          )
          this.announceWorktreeMove(row.id, worktreeWas, worktreeOf(row))
          // The projection depends only on the committed draft and its labels.
          const committedWire = await this.projection(row)
          committedProjectionChanges = await this.companionChanges(row, committedWire)
          committedExtraChanges =
            typeof opts?.extraChanges === 'function'
              ? await opts.extraChanges()
              : (opts?.extraChanges ?? [])
          return committedWire
        },
        // Own facts and companions commit and roll back together.
        changes: () => [...committedProjectionChanges, ...committedExtraChanges],
      })
    ).result
    // Re-pinned only AFTER the commit succeeded: a throw rolls the write back,
    // and the draft must still carry the revision the database holds.
    this.repinDraft(row, pin)
    return wire
  }

  /** Multi-row variant: every affected issue row, its normalized write, and
   * every declared projection change share ONE ledger commit. Built for
   * shipping; also the seam a sort-scope compaction writes through, which is why
   * `touch` is an option — see {@link persist} for what `false` means, and
   * POD-1102 for why a scope repair must not mark a whole repo unread. */
  async persistManyWith<T>(
    rows: IssueRow[],
    write: () => T | Promise<T>,
    extraChanges: (result: T) => readonly EntityChangeSpec[] | Promise<readonly EntityChangeSpec[]>,
    events: (result: T) =>
      | readonly {
          kind: string
          subject: string
          payload: Record<string, unknown>
        }[]
      | Promise<
          readonly {
            kind: string
            subject: string
            payload: Record<string, unknown>
          }[]
        > = () => [],
    opts?: { touch?: boolean },
  ): Promise<{ issues: IssueProjection[]; result: T }> {
    // Drafts, as in {@link persistWith} (POD-3259): every row here is pinned to
    // the revision it was cut from, so a throw has nothing to undo.
    const pins = new Map<string, number | null | undefined>()
    for (const row of rows) {
      pins.set(row.id, this.draftPin(row))
      normalizeBlankIssueText(row)
      if (opts?.touch !== false) row.updatedAt = this.now()
    }
    // The events below take `repoPath` from the drafts first, so a write that
    // moves an issue between repos stamps its events with where the issue is
    // going rather than where it was.
    const drafted = new Map<string, IssueRow>(rows.map((row) => [row.id, row] as const))
    let result!: T
    let wires!: IssueProjection[]
    let eventIds: number[] = []
    let committedProjectionChanges: readonly EntityChangeSpec[][] = []
    let committedExtraChanges: readonly EntityChangeSpec[] = []
    // NO try/catch — see persistWith: the drafts are the only objects that
    // carry this write, so a throw has nothing to undo.
    const committed = (
      await this.deps.ledger.commit({
        write: async () => {
          result = await write()
          for (const row of rows) {
            const pin = pins.get(row.id)
            const worktreeWas = await this.worktreeBefore(row)
            await this.deps.store.issues.upsertIssue(
              row,
              pin === undefined ? undefined : { expectedRevision: pin },
            )
            this.announceWorktreeMove(row.id, worktreeWas, worktreeOf(row))
          }
          wires = await Promise.all(rows.map((row) => this.projection(row)))
          committedProjectionChanges = await Promise.all(
            rows.map(async (row, index) => await this.companionChanges(row, wires[index])),
          )
          committedExtraChanges = await extraChanges(result)
          const committedEvents = await events(result)
          const undrafted = await this.rowsByIds(
            committedEvents.flatMap((event) => (drafted.has(event.subject) ? [] : [event.subject])),
          )
          eventIds = await Promise.all(
            committedEvents.map(
              async (event) =>
                await this.deps.store.events.appendEvent(
                  {
                    ts: this.now(),
                    kind: event.kind,
                    subject: event.subject,
                    repoPath:
                      drafted.get(event.subject)?.repoPath ??
                      undrafted.get(event.subject)?.repoPath ??
                      null,
                    payload: event.payload,
                  },
                  { announce: false },
                ),
            ),
          )
          return { result, wires }
        },
        changes: () => [...committedProjectionChanges.flat(), ...committedExtraChanges],
      })
    ).result
    result = committed.result
    wires = committed.wires
    for (const row of rows) this.repinDraft(row, pins.get(row.id))
    // THE ANNOUNCEMENT WAITS FOR THE OUTERMOST COMMIT [POD-3366]: the events
    // were appended with `announce: false` and are announced here, after the
    // commit, so a span that rolls back announces nothing.
    afterCommit(async () => {
      for (const eventId of eventIds) await this.deps.store.events.announceEvent(eventId)
    }, 'issue-persist-many-events')
    return { issues: wires, result }
  }

  /** A git observation changes only its independently keyed companion. */
  async broadcastIssue(row: IssueRow): Promise<void> {
    await this.deps.ledger.capture([this.gitStateChange(row)])
  }

  /** @internal */
  async rowOrThrow(id: string): Promise<IssueRow> {
    const r = await this.liveRow(await this.resolveRef(id))
    if (!r) throw new IssueNotFound(id)
    return r
  }
  /** @internal */
  async persistRow(row: IssueRow): Promise<IssueProjection> {
    return await this.persist(row)
  }
  /** @internal */
  get d(): IssueDeps {
    return this.deps
  }
  slug = slugifyBranch
}

/**
 * Repository order, `ORDER BY repo_path, seq` in SQLite's BINARY collation
 * (UTF-8 byte order), then id: the order the full-truth reconcile appends in,
 * kept from when it read the in-memory issue map (POD-6158).
 */
function inRepositoryOrder<T>(entries: readonly T[], rowOf: (entry: T) => IssueRow): T[] {
  const keyed = entries.map((entry) => ({ entry, row: rowOf(entry) }))
  keyed.sort((a, b) =>
    byCodePoint(a.row.repoPath, b.row.repoPath) || a.row.seq - b.row.seq || byCodePoint(a.row.id, b.row.id))
  return keyed.map(({ entry }) => entry)
}

/** UTF-8 byte order, which is code point order. UTF-16 code units differ from
 *  it only where a surrogate (a code point above U+FFFF) meets U+E000..U+FFFF. */
function byCodePoint(a: string, b: string): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    const xSurrogate = x >= 0xd800 && x <= 0xdfff
    const ySurrogate = y >= 0xd800 && y <= 0xdfff
    if (xSurrogate !== ySurrogate) return xSurrogate ? 1 : -1
    return x - y
  }
  return a.length - b.length
}

/** Where an issue's worktree is, for the move announcement: a deleted issue
 *  has none (POD-6158). */
export function worktreeOf(row: Pick<IssueRow, 'worktreePath' | 'deletedAt'>): string | null {
  return row.deletedAt ? null : (row.worktreePath ?? null)
}
