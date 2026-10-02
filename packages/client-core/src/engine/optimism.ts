import type { IssueViewModel } from '../replica/issue-view-models'
import { sessionById } from '../session-index'
import { type SessionView, sessionValues, sessionView } from '../session-values'
/**
 * THE OPTIMISTIC LEDGER (POD-404, split out of the old `engine.ts`).
 *
 * ONE optimistic mechanism (#263, see `overlay.ts`): the replica holds server
 * truth only, and every painted-but-unconfirmed row is an OVERLAY folded over
 * it at recompute time. There are exactly three overlay populations and this
 * module owns all three:
 *
 *  - QUEUED — derived fresh from the outbox on every recompute. The queue IS
 *    that state; there is deliberately no second copy of it here.
 *  - AWAITING TRUTH — resolved patches whose covering server row has not landed
 *    in the replica yet (retirement rule (a)). Durable: restored at construction
 *    so a reload inside the resolution→truth window keeps painting.
 *  - SPAWN INSERTS — the #119 placeholder session/issue pair, whose transport is
 *    direct tRPC but whose bookkeeping is unified with the rest.
 *
 * MULTI-USER (docs/multi-user-readiness.md §3.1): the base rows are the
 * PRINCIPAL'S SLICE. A row can leave the slice under an `evict` without being
 * deleted and the whole slice can be rebuilt under a `rescope`. Both look
 * identical to this module — "the row is not in `base`" — and both are already
 * handled the same way: a spawn insert retires when its id appears, an awaiting
 * patch retires when the row is gone, covered, or has moved past its enqueue
 * baseline, and the TTL is the backstop for a row that never speaks again. No
 * retirement here waits for an absent row to arrive.
 *
 * THE LEDGER IS PRINCIPAL-SCOPED BY CONSTRUCTION, NOT BY RESET. It holds one
 * principal's queued writes and painted rows; a principal change disposes it
 * along with the whole runtime rather than clearing it in place (POD-404 AC:
 * no module may cache a principal-derived value across that boundary).
 */

import { createLogger } from '@podium/logger'
import type {
  AgentKind,
  IssueId,
  IssueUserStateWire,
  MutationId,
  SessionId,
  SessionMeta,
  SessionUserStateWire,
  UserId,
} from '@podium/model'
import {
  asIssueId,
  asMutationId,
  asSessionId,
  dedupeSessionsByResume,
  IssueProjection,
  issueUserStateRowId,
  sessionUserStateRowId,
} from '@podium/model'
import type { PodiumClientApi } from '../api'
import { randomUUID } from '../id'
import type { OutboxEntry } from '../outbox'
import {
  assertSpawnPlacement,
  createDraftAgent,
  createIssueAgent,
  type SpawnDraftAgentArgs,
  type SpawnTarget,
  type TaskSpawnOutcome,
} from '../spawn-agent'
import { shallowEqual } from '../store'
import {
  optimisticDraftIssue,
  optimisticDraftSortKey,
  optimisticSessionUserState,
  optimisticStartedIssue,
  optimisticStartingSession,
  type StartingSessionRow,
} from '../viewmodels'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  foldOverlays,
  insertOverlay,
  type OverlayRow,
  type OverlayTarget,
  overlaysForOutboxEntry,
  type PendingOverlay,
  patchedCellsMovedPast,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'
import type { EngineState } from './state'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

const log = createLogger('client-core:optimism')

/** How long a FAILED spawn create waits for the session broadcast before it is
 *  treated as definitive (#263 review finding 4): the create can reach the
 *  server and mint the row while the HTTP response is lost — rolling back /
 *  toasting on such a rejection cries wolf over a session that exists. */
export const SPAWN_CONFIRM_GRACE_MS = 2000

/**
 * When to sweep {@link OptimismLedger}'s press-time overlay map. A queued entry
 * can leave the outbox without an applied/dropped callback (POD-785 collapses a
 * redundant predecessor inside the enqueue transaction), so lifecycle deletes
 * alone cannot be complete. Above this many live entries the map is reconciled
 * against the queue; below it, a handful of stale patches is not worth the scan.
 */
const LOCAL_OVERLAY_SWEEP_AT = 16

/**
 * An overlay minted at the press and kept as the overlay OF RECORD for the life
 * of its queued entry (POD-1053).
 *
 * `input` is held for one check: the recovery surface can EDIT a queued entry,
 * and an edited entry must paint what it now says, not what it said when it was
 * pressed. `edit` replaces the input object, so identity is the whole test.
 */
interface LocalOverlay {
  input: unknown
  overlays: PendingOverlay[]
  /** True until the durable enqueue settles. While it holds, the overlay paints
   *  on its own — there is no queue entry to carry it yet. */
  unqueued: boolean
}

/** The replica's unpainted rows — server truth for this principal's slice. */
export interface OptimismBase {
  /** Session views over UNPAINTED per-user truth (`session-values.ts`): the
   *  ledger joins its painted per-user rows over them (POD-4974 S3). */
  sessions: SessionView[]
  /** The per-user session markers, raw. As for issues, the ledger only ever
   *  paints the rows whose `userId` is {@link OptimismPorts.userId}. */
  sessionUserStates: SessionUserStateWire[]
  issueProjections: IssueProjection[]
  /** The per-user issue markers. The ledger only ever paints the rows whose
   *  `userId` is {@link OptimismPorts.userId}. */
  issueUserStates: IssueUserStateWire[]
}

type PatchOverlay = Extract<PendingOverlay, { op: 'patch' }>

/** Durable issue fields and this principal's markers repaint together. */
const ISSUE_TARGETS: readonly OverlayTarget[] = ['issueProjections', 'issueUserStates']
const PROJECTION_KEYS: readonly string[] = Object.keys(IssueProjection.shape)

/** Convert a temporary spawn render model to the normalized replicated shape. */
export function placeholderProjection(issue: IssueViewModel): IssueProjection {
  const source = issue as unknown as Record<string, unknown>
  const row: Record<string, unknown> = {}
  for (const key of PROJECTION_KEYS) {
    const value = source[key]
    if (value !== undefined && value !== null) row[key] = value
  }
  row.description = { value: issue.description ?? '' }
  if (typeof source.notes === 'string') row.notes = { value: source.notes }
  return row as unknown as IssueProjection
}

export interface OptimismPorts<TApi extends PodiumClientApi> {
  readonly api: TApi
  readonly outbox: EngineOutbox
  readonly notices: StoreNotices
  /** The principal this ledger paints for. Per-user overlays land on this
   *  user's `(user, issue)` rows and on no one else's. */
  readonly userId: UserId
  /** Server truth, read fresh — the runtime owns these lists. */
  readonly base: () => OptimismBase
  /** The PAINTED issue list, for the draft's sort-key placement. */
  readonly paintedIssues: () => IssueViewModel[]
  /** The runtime's state choke point. */
  readonly publish: (patch: Partial<EngineState>) => void
  /** Coalesce every `publish` inside `fn` into ONE snapshot (POD-1645). Optional
   *  so a test harness can wire the ledger without one; the default runs `fn`
   *  unchanged, which is correct but publishes once per recompute. */
  readonly batch?: (fn: () => void) => void
  readonly spawnConfirmGraceMs?: number
}

export class OptimismLedger<TApi extends PodiumClientApi> {
  private keyedFolds = false
  private readonly basePositions = new Map<
    OverlayTarget,
    {
      base: object[]
      positions: Map<string, number>
      unique: boolean
    }
  >()

  enableKeyedFolds(): void {
    this.keyedFolds = true
  }

  /** An index of the writer's current base array, not a second row store. */
  private positionsFor<T extends object>(
    entity: OverlayTarget,
    base: T[],
    keyOf: (row: T) => string,
  ) {
    const previous = this.basePositions.get(entity)
    if (previous?.base === base) return previous
    const positions = new Map<string, number>()
    let unique = true
    for (let i = 0; i < base.length; i++) {
      const id = keyOf(base[i]!)
      if (positions.has(id)) unique = false
      positions.set(id, i)
    }
    const next = { base, positions, unique }
    this.basePositions.set(entity, next)
    return next
  }

  /** Fold only addressed bases, then copy the legacy snapshot array if a cell
   * moved. Inserts and absent-user markers still use the original fold rules. */
  private foldKeyed<T extends object>(
    entity: OverlayTarget,
    base: T[],
    overlays: PendingOverlay[],
    keyOf: (row: T) => string,
  ) {
    if (!overlays.length) return foldOverlays(base, overlays, keyOf)
    const index = this.positionsFor(entity, base, keyOf)
    if (!index.unique) return foldOverlays(base, overlays, keyOf)
    const positions = [
      ...new Set(
        overlays.flatMap((o) => {
          const position = index.positions.get(o.id)
          return position === undefined ? [] : [position]
        }),
      ),
    ].sort((a, b) => a - b)
    const subset = positions.map((position) => base[position]!)
    const folded = foldOverlays(subset, overlays, keyOf)
    const moved =
      folded.rows.length > subset.length ||
      positions.some((position, i) => base[position] !== folded.rows[i])
    if (!moved) return { rows: base, pendingInsertIds: folded.pendingInsertIds }
    const rows = base.slice()
    for (let i = 0; i < positions.length; i++) rows[positions[i]!] = folded.rows[i]!
    rows.push(...folded.rows.slice(subset.length))
    return { rows, pendingInsertIds: folded.pendingInsertIds }
  }
  private readonly ports: OptimismPorts<TApi>
  private readonly spawnConfirmGraceMs: number
  private spawnOverlays: PendingOverlay[] = []
  // One bounded fold per entity. Retirement still runs on every recompute;
  // only the pure paint is reusable across press → queue → awaiting truth.
  private readonly folds = new Map<
    OverlayTarget,
    {
      base: object[]
      overlays: PendingOverlay[]
      result: { rows: object[]; pendingInsertIds: ReadonlySet<string> }
    }
  >()
  /** First turns keyed by optimistic session id. ChatView seeds its own pending
   * reconciliation state from this map before the transcript exists. */
  private spawnPrompts: ReadonlyMap<string, string> = new Map()
  private awaitingTruth: AwaitingTruth[] = []
  /** Overlays minted at the press (POD-1053), by the mutationId their entry
   *  carries. The paint runs ahead of the durable commit, so these exist before
   *  the queue does and stay the overlay of record for the entry's queued life. */
  private readonly localOverlays = new Map<string, LocalOverlay>()
  /** TTL sweep for the awaiting-truth stage (#263 review finding 3): prunes run
   *  on recomputes, which only fire on replica/outbox changes — a row that
   *  never changes again would otherwise keep a stuck entry painted forever. */
  private awaitingSweepTimer: ReturnType<typeof setTimeout> | null = null
  /** Live spawn-confirm grace timers (#263 review round 2). Cleared in
   *  dispose(): a replaced runtime's late timer must not roll back overlays or
   *  toast after its successor took over the same storage/session state. */
  private readonly spawnConfirmTimers = new Set<ReturnType<typeof setTimeout>>()
  /**
   * Waiters for {@link waitForSpawnConfirmed}. A first chat send during the
   * optimistic-spawn window used to hit the server before `sessions.create`
   * landed; the authority dead-lettered the unknown id and the outbox treated
   * HTTP 200 as applied — the prompt vanished while the agent sat idle
   * (POD-546, same class as the POD-1613 terminal-attach race).
   */
  private readonly spawnConfirmWaiters = new Map<string, Set<() => void>>()
  /** Projected overlays per queued entry object, so a re-projection between
   *  recomputes hands back the SAME patch objects (a document cell is an object,
   *  and a fresh one per recompute would re-mint the painted row each time).
   *  `input` identity guards a recovery-surface edit. */
  private readonly projected = new WeakMap<
    OutboxEntry,
    { input: unknown; overlays: PendingOverlay[] }
  >()
  /** The issue ids in the normalized slice, cached per base array. */
  private sliceIds: { base: readonly IssueProjection[]; ids: ReadonlySet<string> } | null = null
  /** The session list with painted per-user rows joined in, per input pair. */
  private joined: {
    sessions: readonly SessionView[]
    users: readonly SessionUserStateWire[]
    rows: SessionView[]
  } | null = null

  constructor(ports: OptimismPorts<TApi>) {
    this.ports = ports
    this.spawnConfirmGraceMs = ports.spawnConfirmGraceMs ?? SPAWN_CONFIRM_GRACE_MS
    // Restore the DURABLE awaiting-truth stage (#263 review finding 1): a
    // reload inside the resolution→covering-truth window must keep painting
    // resolved overlays — the retirement check against hydrated replica rows
    // (retireCovered, on the first recompute) drops the ones whose truth
    // already landed. Unprojectable leftovers have nothing to await: retire.
    const restored: AwaitingTruth[] = []
    for (const e of ports.outbox.awaiting()) {
      const overlays = overlaysForOutboxEntry(e).filter((o): o is PatchOverlay => o.op === 'patch')
      if (overlays.length === 0) {
        ports.outbox.retireAwaiting(e.mutationId)
        continue
      }
      for (const overlay of overlays) {
        restored.push({
          overlay,
          // A chained entry (enqueued behind a same-row sibling, #263 review
          // round 2) never uses the moved-past escape: its sibling's echo may
          // have landed while we were unloaded, and the stale enqueue baseline
          // would retire it on the first prune — coveredBy/TTL bound it instead.
          baseline: e.chained === true ? undefined : e.baseline,
          resolvedAt: e.resolvedAt ?? Date.now(),
        })
      }
    }
    this.awaitingTruth = restored
  }

  /** Clear every timer this ledger armed. Called from the runtime's dispose so
   *  a superseded principal's grace timer cannot fire into its successor. */
  dispose(): void {
    // A pressed-but-undurable overlay belongs to the runtime being replaced; its
    // successor reads the queue from storage and paints whatever committed.
    this.localOverlays.clear()
    this.folds.clear()
    this.basePositions.clear()
    this.spawnPrompts = new Map()
    if (this.awaitingSweepTimer !== null) {
      clearTimeout(this.awaitingSweepTimer)
      this.awaitingSweepTimer = null
    }
    for (const t of this.spawnConfirmTimers) clearTimeout(t)
    this.spawnConfirmTimers.clear()
    // Resolve waiters so a held resumeAndSend does not hang forever after the
    // runtime is replaced; the successor owns the next send.
    for (const waiters of this.spawnConfirmWaiters.values()) {
      for (const resolve of waiters) resolve()
    }
    this.spawnConfirmWaiters.clear()
  }

  /**
   * Resolves once this session id is no longer a spawn-insert placeholder —
   * either the server row arrived (create succeeded) or the optimistic pair
   * was rolled back (create failed). Immediate when the id was never pending.
   *
   * Used by `resumeAndSend` so a mobile/web composer send during "Starting…"
   * does not dead-letter against an id the authority has not heard of yet.
   */
  waitForSpawnConfirmed(sessionId: SessionId): Promise<void> {
    const pending = this.spawnOverlays.some(
      (overlay) => overlay.entity === 'sessions' && overlay.id === sessionId,
    )
    if (!pending) return Promise.resolve()
    return new Promise((resolve) => {
      let waiters = this.spawnConfirmWaiters.get(sessionId)
      if (!waiters) {
        waiters = new Set()
        this.spawnConfirmWaiters.set(sessionId, waiters)
      }
      waiters.add(resolve)
    })
  }

  private notifySpawnConfirmWaiters(pendingInsertIds: ReadonlySet<string>): void {
    if (this.spawnConfirmWaiters.size === 0) return
    for (const [sessionId, waiters] of [...this.spawnConfirmWaiters]) {
      if (pendingInsertIds.has(sessionId)) continue
      this.spawnConfirmWaiters.delete(sessionId)
      for (const resolve of waiters) resolve()
    }
  }

  /**
   * The overlays one queued entry paints.
   *
   * Normally that is `overlaysForOutboxEntry`, a pure function of the entry. The
   * exception is an entry this ledger enqueued itself (POD-1053): it painted
   * before the durable commit, so the overlays of record are the ones minted at
   * the press — carrying the PRESS's clock rather than the storage commit's.
   * Without that, the five clock-stamped kinds (`issueSetTucked`,
   * `issueMarkRead`, `sessionMarkRead`, `issueDelete`, `issueUndefer`) would
   * repaint a millisecond-different timestamp when the entry landed, and a
   * repaint is not cheap here: a moved cell is a new row identity, and a new row
   * identity re-derives the whole worklist. The press instant is also the more
   * honest value — it is when the user acted.
   */
  private entryOverlays(entry: OutboxEntry): PendingOverlay[] {
    const local = this.localOverlays.get(entry.mutationId)
    if (local !== undefined && local.input === entry.input) return local.overlays
    const cached = this.projected.get(entry)
    if (cached !== undefined && cached.input === entry.input) return cached.overlays
    const overlays = overlaysForOutboxEntry(entry)
    this.projected.set(entry, { input: entry.input, overlays })
    return overlays
  }

  /** Drop press-time overlays for entries the queue no longer holds. See
   *  {@link LOCAL_OVERLAY_SWEEP_AT} for why lifecycle deletes are not enough. */
  private sweepLocalOverlays(): void {
    if (this.localOverlays.size <= LOCAL_OVERLAY_SWEEP_AT) return
    const queued = new Set<string>(this.ports.outbox.pending().map((e) => e.mutationId))
    for (const [mutationId, held] of [...this.localOverlays]) {
      // An unqueued entry is not in the queue YET — that is the whole point of it.
      if (!held.unqueued && !queued.has(mutationId)) this.localOverlays.delete(mutationId)
    }
  }

  /** The issue ids of the normalized slice, plus pending spawn placeholders:
   *  the issues whose per-user row may be absent and still mean "nothing set". */
  private inSlice(issueId: IssueId): boolean {
    const base = this.ports.base().issueProjections
    if (this.sliceIds?.base !== base) {
      this.sliceIds = { base, ids: new Set(base.map((row) => row.id)) }
    }
    return (
      this.sliceIds.ids.has(issueId) ||
      this.spawnOverlays.some((o) => o.entity === 'issueProjections' && o.id === issueId)
    )
  }

  /**
   * What an absent per-user row means for this principal (POD-4969): a row of
   * three nulls, the state the server deletes the row for. Only for an issue
   * still in the slice — once the issue has left it, absence is real and an
   * overlay on it retires like any other whose row is gone.
   */
  private absentUserState(issueId: IssueId): IssueUserStateWire | undefined {
    if (!this.inSlice(issueId)) return undefined
    return {
      userId: this.ports.userId,
      entityId: issueId,
      readAt: null,
      tuckedAt: null,
      pinned: false,
    }
  }

  /** The fold key of a per-user row: the issue id for THIS principal's rows,
   *  and the full composite id for anyone else's — which no overlay ever
   *  targets, so another principal's row is never painted (principal isolation). */
  private readonly userStateKey = (row: IssueUserStateWire): string =>
    row.userId === this.ports.userId ? row.entityId : issueUserStateRowId(row.userId, row.entityId)

  /** {@link userStateKey} for the per-user session rows. */
  private readonly sessionUserStateKey = (row: SessionUserStateWire): string =>
    row.userId === this.ports.userId
      ? row.sessionId
      : sessionUserStateRowId(row.userId, row.sessionId)

  /** A missing personal source row has a null read cursor and no snooze.
   * A pending edit can paint that row while it waits for truth. Retired
   * fields in an old cached session never supply another user's markers.
   * Undefined once the session itself has left the slice. */
  private absentSessionUserState(sessionId: string): SessionUserStateWire | undefined {
    const session =
      sessionById(this.ports.base().sessions).get(sessionId) ??
      this.spawnOverlays.find(
        (o): o is Extract<PendingOverlay, { op: 'insert' }> =>
          o.op === 'insert' && o.entity === 'sessions' && o.id === sessionId,
      )?.insert
    if (session === undefined || !('sessionId' in session)) return undefined
    const { readAt, snoozedUntil } = sessionValues(session)
    return {
      userId: this.ports.userId,
      sessionId: asSessionId(sessionId),
      readAt,
      ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
    }
  }

  /** The current server-truth row an overlay of record is judged against. */
  private truthRow(entity: OverlayTarget, id: string): OverlayRow | undefined {
    const base = this.ports.base()
    switch (entity) {
      case 'sessions':
        return sessionById(base.sessions).get(id)
      case 'issueProjections':
        return base.issueProjections.find((i) => i.id === id)
      case 'issueUserStates':
        return (
          base.issueUserStates.find((row) => this.userStateKey(row) === id) ??
          this.absentUserState(asIssueId(id))
        )
      case 'sessionUserStates':
        return (
          base.sessionUserStates.find((row) => this.sessionUserStateKey(row) === id) ??
          this.absentSessionUserState(id)
        )
    }
  }

  /** The pending overlays for one entity, in application order: resolved
   *  patches awaiting truth first (they were sent earliest), then the queued
   *  outbox entries FIFO — so two pending mutations on the same row compose in
   *  queue order — then anything pressed but not yet durable (the newest writes
   *  there are), plus the #119 spawn placeholder inserts (order-independent:
   *  folding applies inserts before any patch). Derived fresh each recompute:
   *  the outbox itself is the queued-overlay state, never a second copy. */
  overlaysFor(entity: OverlayTarget): PendingOverlay[] {
    const out: PendingOverlay[] = []
    const include = (overlay: PendingOverlay): void => {
      if (overlay.entity !== entity) return
      // An absent per-user row is "nothing set" while the issue is in the slice,
      // and an explicit neutral personal row while the session is.
      const absent =
        overlay.op !== 'patch'
          ? undefined
          : entity === 'issueUserStates'
            ? this.absentUserState(asIssueId(overlay.id))
            : entity === 'sessionUserStates'
              ? this.absentSessionUserState(overlay.id)
              : undefined
      out.push(overlay.op === 'patch' && absent !== undefined ? { ...overlay, absent } : overlay)
    }
    for (const overlay of this.spawnOverlays) include(overlay)
    for (const awaiting of this.awaitingTruth) include(awaiting.overlay)
    const queued = new Set<string>()
    for (const entry of this.ports.outbox.pending()) {
      queued.add(entry.mutationId)
      for (const overlay of this.entryOverlays(entry)) include(overlay)
    }
    // Pressed, painted, not yet committed: nothing in the queue carries these
    // yet. A synchronous enqueue notifies before its await settles: queue
    // membership already carries that paint, even while unqueued is true.
    for (const [id, held] of this.localOverlays) {
      if (held.unqueued && !queued.has(id)) for (const overlay of held.overlays) include(overlay)
    }
    return out
  }

  /** {@link overlaysFor} grouped by target row id, each list in fold order
   *  (POD-4553). O(pending entries), never the entity's row count: a per-row
   *  reader looks one row's overlays up here and folds them with
   *  `foldRowOverlays` instead of diffing the folded arrays. */
  pendingByRow(entity: OverlayTarget): ReadonlyMap<string, readonly PendingOverlay[]> {
    const byRow = new Map<string, PendingOverlay[]>()
    for (const overlay of this.overlaysFor(entity)) {
      const list = byRow.get(overlay.id)
      if (list) list.push(overlay)
      else byRow.set(overlay.id, [overlay])
    }
    return byRow
  }

  /** Fold the seed (construction-time) lists without publishing — the very
   *  first snapshot must already carry queued optimism. */
  foldSeed<T extends object>(
    entity: OverlayTarget,
    base: T[],
    keyOf: (row: T) => string,
  ): { rows: T[]; pendingInsertIds: ReadonlySet<string> } {
    return this.foldStable(entity, base, keyOf)
  }

  /** {@link foldSeed} for the per-user rows, keyed for this principal. */
  foldSeedUserStates(base: IssueUserStateWire[]): IssueUserStateWire[] {
    return this.foldStable('issueUserStates', base, this.userStateKey).rows
  }

  /** {@link foldSeed} for the session list: per-user rows joined, then the
   *  session's own overlays (see {@link paintSessions}). */
  foldSeedSessions(): { rows: SessionView[]; pendingInsertIds: ReadonlySet<string> } {
    return this.paintSessions()
  }

  private foldStable<T extends object>(
    entity: OverlayTarget,
    base: T[],
    keyOf: (row: T) => string,
    overlays: PendingOverlay[] = this.overlaysFor(entity),
  ): { rows: T[]; pendingInsertIds: ReadonlySet<string> } {
    // A scope replacement must release the former base even when the new
    // slice has no pending overlay that would ask for an index.
    if (this.keyedFolds && this.basePositions.get(entity)?.base !== base)
      this.basePositions.delete(entity)
    const previous = this.folds.get(entity)
    // Membership/stage and coverage predicates do not affect the pure fold.
    // Compare the ordered paint, including edits to an existing queued entry.
    if (
      previous?.base === base &&
      previous.overlays.length === overlays.length &&
      overlays.every((o, i) => {
        const old = previous.overlays[i]!
        return (
          o.id === old.id &&
          (o.op === 'patch' && old.op === 'patch'
            ? shallowEqual(o.patch, old.patch) &&
              (o.absent === undefined) === (old.absent === undefined)
            : o.op === 'insert' && old.op === 'insert' && o.insert === old.insert)
        )
      })
    ) {
      return previous.result as { rows: T[]; pendingInsertIds: ReadonlySet<string> }
    }
    const result = this.keyedFolds
      ? this.foldKeyed(entity, base, overlays, keyOf)
      : foldOverlays(base, overlays, keyOf)
    // Changed inputs can still compose to the same effective rows. Retain
    // their identity without comparing serialized data or hiding new cells.
    if (
      previous &&
      previous.result.rows.length === result.rows.length &&
      (this.keyedFolds && previous.base === base
        ? this.samePaint(
            entity,
            base,
            keyOf,
            previous.overlays,
            overlays,
            result.rows,
            previous.result.rows,
          )
        : result.rows.every((row, i) => shallowEqual(row, previous.result.rows[i])))
    ) {
      result.rows = previous.result.rows as T[]
    }
    if (
      previous &&
      previous.result.pendingInsertIds.size === result.pendingInsertIds.size &&
      [...result.pendingInsertIds].every((id) => previous.result.pendingInsertIds.has(id))
    ) {
      result.pendingInsertIds = previous.result.pendingInsertIds
    }
    this.folds.set(entity, { base, overlays, result })
    return result
  }

  private samePaint<T extends object>(
    entity: OverlayTarget,
    base: T[],
    keyOf: (row: T) => string,
    before: PendingOverlay[],
    after: PendingOverlay[],
    rows: T[],
    previous: object[],
  ): boolean {
    const index = this.positionsFor(entity, base, keyOf)
    if (!index.unique) return rows.every((row, i) => shallowEqual(row, previous[i]))
    for (const overlay of [...before, ...after]) {
      const position = index.positions.get(overlay.id)
      if (position !== undefined && !shallowEqual(rows[position], previous[position])) return false
    }
    for (let i = base.length; i < rows.length; i++)
      if (!shallowEqual(rows[i], previous[i])) return false
    return true
  }

  /** Arm (once) a timer that forces a recompute shortly after the earliest
   *  awaiting entry's TTL expires, so pruneAwaiting's backstop actually fires
   *  even when the replica goes quiet. Re-arms itself while entries remain. */
  armAwaitingSweep(): void {
    if (this.awaitingSweepTimer !== null || this.awaitingTruth.length === 0) return
    const earliest = Math.min(...this.awaitingTruth.map((a) => a.resolvedAt))
    const delay = Math.max(0, earliest + AWAITING_TRUTH_TTL_MS - Date.now()) + 25
    this.awaitingSweepTimer = setTimeout(() => {
      this.awaitingSweepTimer = null
      this.recomputeAll()
      this.armAwaitingSweep()
    }, delay)
  }

  /** Run `fn` under the runtime's snapshot batch when one is wired. */
  private batched(fn: () => void): void {
    if (this.ports.batch) this.ports.batch(fn)
    else fn()
  }

  recomputeAll(): void {
    this.batched(() => {
      this.recomputeSessions()
      this.recomputeIssueProjections()
      this.recomputeIssueUserStates()
    })
  }

  /** Retirement rule (a) (#263, overlay.ts): spawn inserts retire when server
   *  truth (same id) landed in the replica; resolved patches retire when the
   *  row covers the mutation, moved past the enqueue baseline (oldest per row),
   *  or outlived the TTL. Retiring an awaiting patch also deletes its durable
   *  storage entry (finding 1: deletion happens at retirement, not resolution)
   *  once no other overlay of the same entry still awaits. */
  private retireCovered<T extends object>(
    entity: OverlayTarget,
    base: T[],
    keyOf: (row: T) => string,
    absentRow?: (id: string) => T | undefined,
  ): void {
    if (this.spawnOverlays.some((o) => o.entity === entity)) {
      const known = new Set(base.map(keyOf))
      const keep = this.spawnOverlays.filter((o) => {
        if (o.entity !== entity) return true
        // The per-user placeholder lives exactly as long as its issue's: the
        // server writes no marker on create, so its own row may never come.
        if (entity === 'issueUserStates') {
          return this.spawnOverlays.some((p) => p.entity === 'issueProjections' && p.id === o.id)
        }
        // The same for a session's (POD-4974 S3c).
        if (entity === 'sessionUserStates') {
          return this.spawnOverlays.some((p) => p.entity === 'sessions' && p.id === o.id)
        }
        return !known.has(o.id)
      })
      if (keep.length !== this.spawnOverlays.length) this.spawnOverlays = keep
    }
    const awaiting = this.keyedFolds
      ? this.awaitingTruth.filter((a) => a.overlay.entity === entity)
      : []
    const checkedBase =
      awaiting.length > 0
        ? (() => {
            const index = this.positionsFor(entity, base, keyOf)
            if (!index.unique) return base
            return [
              ...new Set(
                awaiting.flatMap((a) => {
                  const position = index.positions.get(a.overlay.id)
                  return position === undefined ? [] : [position]
                }),
              ),
            ].map((position) => base[position]!)
          })()
        : base
    const pruned = pruneAwaiting(
      this.awaitingTruth,
      entity,
      checkedBase,
      keyOf,
      Date.now(),
      undefined,
      absentRow,
    )
    if (pruned !== this.awaitingTruth) {
      const dropped = this.awaitingTruth.filter((a) => !pruned.includes(a))
      // Assign BEFORE the durable retire, so any re-entrant recompute already
      // sees the pruned stage.
      this.awaitingTruth = pruned
      for (const a of dropped) {
        const key = a.overlay.key
        if (!pruned.some((other) => other.overlay.key === key)) {
          this.ports.outbox.retireAwaiting(asMutationId(key))
        }
      }
    }
  }

  /**
   * The painted session list, in two folds (POD-4974 S3). First this
   * principal's per-user rows (`readAt`, `snoozedUntil`), then the session
   * views with those painted rows joined in, then the session's own overlays
   * (rename, archive, offer, wake) and the spawn placeholder.
   *
   * The join is a view over the base view (`sessionView` with only the user
   * row), so refs, machine labels and handoff labels pass through unchanged,
   * and `unread` is derived from the painted cursor. Only sessions whose
   * per-user row the fold moved are re-viewed; with nothing painted the base
   * list itself is folded. A spawn placeholder is joined the same way, so an
   * edit pressed during its "Starting…" window shows on it too.
   */
  private paintSessions(): { rows: SessionView[]; pendingInsertIds: ReadonlySet<string> } {
    const { sessions, sessionUserStates } = this.ports.base()
    const users = this.foldStable(
      'sessionUserStates',
      sessionUserStates,
      this.sessionUserStateKey,
    ).rows
    const painted = new Map<string, SessionUserStateWire>()
    if (users !== sessionUserStates) {
      const truth = new Map(
        sessionUserStates
          .filter((row) => row.userId === this.ports.userId)
          .map((row) => [row.sessionId as string, row]),
      )
      for (const row of users) {
        if (row.userId === this.ports.userId && truth.get(row.sessionId) !== row) {
          painted.set(row.sessionId, row)
        }
      }
    }
    const join = (session: SessionMeta): SessionView => {
      const userState = painted.get(session.sessionId)
      return sessionView(session, userState === undefined ? {} : { userState })
    }
    if (this.joined?.sessions !== sessions || this.joined.users !== users) {
      this.joined = {
        sessions,
        users,
        rows: painted.size === 0 ? sessions : sessions.map(join),
      }
    }
    const overlays = this.overlaysFor('sessions').map((o) =>
      o.op === 'insert' && painted.has(o.id) ? { ...o, insert: join(o.insert as SessionMeta) } : o,
    )
    return this.foldStable('sessions', this.joined.rows, (s) => s.sessionId, overlays)
  }

  /** Fold `replica rows + pending mutations' overlays` into the snapshot's
   *  session list, and derive pendingSpawnIds — the ids AgentPanel must not
   *  attach to yet (#119). The per-user session overlays retire here too:
   *  their only reader is this list's join. */
  recomputeSessions(): void {
    const { sessions, sessionUserStates } = this.ports.base()
    // Sessions first: a spawn placeholder's per-user row lives as long as the
    // session placeholder, so both leave in the same recompute.
    this.retireCovered('sessions', sessions, (s: SessionMeta): string => s.sessionId)
    this.retireCovered('sessionUserStates', sessionUserStates, this.sessionUserStateKey, (id) =>
      this.absentSessionUserState(id),
    )
    const { rows, pendingInsertIds } = this.paintSessions()
    if ([...this.spawnPrompts.keys()].some((id) => !pendingInsertIds.has(id))) {
      this.spawnPrompts = new Map([...this.spawnPrompts].filter(([id]) => pendingInsertIds.has(id)))
    }
    this.ports.publish({
      sessions: rows,
      pendingSpawnIds: pendingInsertIds,
      pendingSpawnPrompts: this.spawnPrompts,
    })
    this.notifySpawnConfirmWaiters(pendingInsertIds)
  }

  recomputeIssueProjections(): void {
    const base = this.ports.base().issueProjections
    const keyOf = (i: IssueProjection): string => i.id
    this.retireCovered('issueProjections', base, keyOf)
    const { rows } = this.foldStable('issueProjections', base, keyOf)
    this.ports.publish({ issueProjections: rows })
  }

  recomputeIssueUserStates(): void {
    const base = this.ports.base().issueUserStates
    this.retireCovered('issueUserStates', base, this.userStateKey, (id) =>
      this.absentUserState(asIssueId(id)),
    )
    const { rows } = this.foldStable('issueUserStates', base, this.userStateKey)
    this.ports.publish({ issueUserStates: rows })
  }

  /** Repaint the given targets, in one snapshot. */
  recomputeFor(targets: Iterable<OverlayTarget>): void {
    const set = new Set(targets)
    if (set.size === 0) return
    this.batched(() => {
      if (set.has('sessions') || set.has('sessionUserStates')) this.recomputeSessions()
      if (set.has('issueProjections')) this.recomputeIssueProjections()
      if (set.has('issueUserStates')) this.recomputeIssueUserStates()
    })
  }

  /** Drain success (#263): hand the entry's overlays to the awaiting-truth
   *  stage. Called by the outbox BEFORE it notifies subscribers of the
   *  shrunken queue, so no intermediate snapshot ever lacks the overlay.
   *  Returns true to keep the entry DURABLY in storage (finding 1) until
   *  covering truth retires every overlay it holds. */
  mutationApplied(entry: OutboxEntry): boolean {
    const overlays = this.entryOverlays(entry).filter((o): o is PatchOverlay => o.op === 'patch')
    if (overlays.length === 0) {
      this.localOverlays.delete(entry.mutationId)
      return false
    }
    let hold = false
    for (const overlay of overlays) {
      const row = this.truthRow(overlay.entity, overlay.id)
      // Hold the overlay until covering truth lands. Nothing to hold when the
      // row is gone, already reflects the mutation (the broadcast echo raced
      // ahead of the response), or a patched cell left the ENQUEUE-time baseline
      // for a value that is not this mutation's (finding 2: a competing write on
      // the same field already landed — a resolution-time fingerprint of that
      // final row would never "move" again and the overlay would mask it).
      //
      // EXCEPT (#263 review round 2): when an OLDER same-row entry exists — this
      // entry was enqueued behind a sibling (`chained`), or a sibling is still
      // awaiting truth — the movement is almost certainly the PREDECESSOR'S echo,
      // not a competing writer. Dropping here would flash the predecessor's value
      // until this entry's own echo lands. Hold instead, WITHOUT the moved-past
      // escape (baseline undefined — the stale enqueue baseline would trip on the
      // sibling's echo at the very next prune pass); coveredBy / row-gone / the
      // TTL retire it, exactly the bounds the oldest-first rule already relies on.
      if (row === undefined || overlay.coveredBy(row)) continue
      const olderSameRow =
        entry.chained === true ||
        this.awaitingTruth.some(
          (a) => a.overlay.entity === overlay.entity && a.overlay.id === overlay.id,
        )
      const moved = patchedCellsMovedPast(overlay, row, entry.baseline)
      // Competing truth won while the mutation was in flight — server wins.
      if (moved && !olderSameRow) continue
      hold = true
      this.awaitingTruth = [
        ...this.awaitingTruth,
        { overlay, baseline: olderSameRow ? undefined : entry.baseline, resolvedAt: Date.now() },
      ]
    }
    if (hold) this.armAwaitingSweep()
    this.recomputeFor(overlays.map((o) => o.entity))
    // AFTER the recompute: the outbox fires this before subscribers see the
    // shrunken queue, so the entry can still be in `pending()` above — and the
    // queued copy must keep painting the same values as the awaiting one it was
    // just handed to.
    this.localOverlays.delete(entry.mutationId)
    return hold
  }

  /** Definitive failure — retirement rule (b): the wiring already surfaced the
   *  poison toast; repaint without the dropped entry's overlays. */
  mutationDropped(entry: OutboxEntry): void {
    const targets = this.entryOverlays(entry).map((o) => o.entity)
    this.localOverlays.delete(entry.mutationId)
    this.recomputeFor(targets)
  }

  /**
   * Enqueue + repaint: the queued entry IS the optimistic apply (#263).
   *
   * THE PAINT RUNS AHEAD OF THE DURABLE COMMIT (POD-1053). This used to await
   * `outbox.enqueue` — an IndexedDB transaction on `Outbox.mutate`'s serial
   * chain — before folding anything, so a press waited on whatever transaction
   * that chain happened to be running. The network submit was already outside
   * the chain (`outbox.ts: attempt()`), so this was never a round trip; it is
   * milliseconds, and the point is the SHAPE rather than the number: storage is
   * not something an interaction should queue behind.
   *
   * What is given up is bounded and already the case: an overlay is optimism,
   * and a tab that dies between the paint and the commit loses the write — as it
   * would have lost anything else in flight. Nothing downstream of the paint
   * assumes durability; retirement is judged against server truth either way.
   *
   * The overlays are minted ONCE, filed under the id the entry WILL carry, and
   * never re-projected — so the fold that runs when the entry lands paints the
   * SAME VALUES the press already painted. That is what keeps splitting the
   * press in two from costing anything: the shared view-model cache compares the
   * rebuilt row against the previous one, finds nothing visible moved, and the
   * published worklist does not derive a second time. Re-projecting from the
   * entry instead would stamp a different clock on the five clock-stamped kinds
   * (`issueSetTucked`, `issueMarkRead`, `sessionMarkRead`, `issueDelete`,
   * `issueUndefer`) and pay the whole fan-out again for a millisecond nobody can
   * see. The id has to be minted here rather than read off the enqueue's result
   * because the drain can fire `onApplied` before that promise resolves.
   * See {@link entryOverlays}.
   *
   * `opts.mutationId` lets a caller that must know the id synchronously name it
   * (POD-4554: a round-three prototype returns it from its `edit()` as the
   * transaction id). Omitted, it is minted here, as before.
   */
  async enqueueOverlayed<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
    enqueueOpts?: { mutationId?: MutationId },
  ): Promise<void> {
    // Enqueue-time baseline (#263 review finding 2): fingerprint the target
    // rows' REPLICA truth (unpainted — the replica is server truth only) so
    // resolution can tell whether truth already moved while in flight.
    const mutationId = enqueueOpts?.mutationId ?? asMutationId(randomUUID())
    const queuedAt = Date.now()
    const probe = overlaysForOutboxEntry({ mutationId, kind, input, queuedAt }).filter(
      (o): o is PatchOverlay => o.op === 'patch',
    )
    let baseline: string | undefined
    let chained = false
    if (probe.length > 0) {
      // One baseline over disjoint normalized cells: durable issue fields and
      // personal markers each have one home.
      // A per-user SESSION row merges over its session view (POD-4974 S3). The
      // row carries no activity clock, and mark-read paints at least the
      // session's `lastActiveAt`; the per-user cells are the per-user row's own.
      // That is also the shape older builds stored (a session-row fingerprint),
      // so an entry from before S3 reads the same cells off its baseline.
      const rows = probe
        .flatMap((o) => [
          ...(o.entity === 'sessionUserStates' ? [this.truthRow('sessions', o.id)] : []),
          this.truthRow(o.entity, o.id),
        ])
        .filter((row): row is OverlayRow => row !== undefined)
      if (rows.length > 0) baseline = rowFingerprint(Object.assign({}, ...rows))
      // Chained stamp (#263 review round 2): a same-row entry already pending
      // (queued, awaiting, or pressed and not yet durable) means ITS echo will
      // move the row past this baseline while this mutation is in flight —
      // resolution must not read that movement as a competing writer (see
      // mutationApplied).
      const sameRow = (o: PendingOverlay): boolean =>
        o.op === 'patch' && probe.some((p) => o.entity === p.entity && o.id === p.id)
      chained =
        this.awaitingTruth.some((a) => sameRow(a.overlay)) ||
        [...this.localOverlays.values()].some((l) => l.unqueued && l.overlays.some(sameRow)) ||
        this.ports.outbox.pending().some((e) => this.entryOverlays(e).some(sameRow))
    }
    const opts = {
      mutationId,
      ...(baseline !== undefined ? { baseline } : {}),
      ...(chained ? { chained } : {}),
    }
    // The overlays OF RECORD, projected from the entry as it will be stored —
    // baseline included. `probe` above could not carry it (the baseline is
    // derived FROM the probe), and a baseline-less `coveredBy` is not merely
    // approximate: `issueMarkRead` judges coverage as "the cursor moved past the
    // enqueue-time one", so an absent baseline retires the overlay on its own
    // resolution and the paint vanishes.
    const overlays =
      probe.length === 0 ? [] : overlaysForOutboxEntry({ ...opts, kind, input, queuedAt })
    const targets = overlays.map((o) => o.entity)
    // PAINT, then persist.
    if (overlays.length > 0) {
      this.localOverlays.set(mutationId, { input, overlays, unqueued: true })
      this.recomputeFor(targets)
    }
    let entry: OutboxEntry
    try {
      entry = await this.ports.outbox.enqueue(kind, input, opts)
    } catch (error) {
      if (overlays.length > 0) {
        this.localOverlays.delete(mutationId)
        this.recomputeFor(targets)
      }
      throw error
    }
    // The queue now carries it — unless the drain already applied or dropped it,
    // which deletes the entry here and leaves nothing to hand over.
    const held = this.localOverlays.get(mutationId)
    if (held !== undefined) held.unqueued = false
    this.sweepLocalOverlays()
    this.recomputeFor(this.entryOverlays(entry).map((o) => o.entity))
  }

  private paintSpawn(args: {
    sessionId: SessionId
    issueId: IssueId
    session: StartingSessionRow
    issue: IssueViewModel
    prompt?: string
    create: () => Promise<void>
    failureSubject: 'agent' | 'task'
    recognizePartialIssue?: boolean
  }): {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
  } {
    const { sessionId, issueId } = args
    // A temporary issue projection and personal markers accompany the starting
    // session. Markers retire with their issue: create need not publish a row
    // whose markers are all unset.
    this.spawnOverlays = [
      ...this.spawnOverlays,
      insertOverlay('sessions', sessionId, args.session as SessionMeta),
      insertOverlay(
        'sessionUserStates',
        sessionId,
        optimisticSessionUserState({
          userId: this.ports.userId,
          sessionId,
          nowIso: args.session.lastActiveAt,
        }),
      ),
      insertOverlay('issueProjections', issueId, placeholderProjection(args.issue)),
      insertOverlay('issueUserStates', issueId, {
        userId: this.ports.userId,
        entityId: issueId,
        readAt: args.issue.readAt ?? null,
        tuckedAt: args.issue.tuckedAt ?? null,
        pinned: args.issue.pinned === true,
      }),
    ]
    if (args.prompt) this.spawnPrompts = new Map(this.spawnPrompts).set(sessionId, args.prompt)
    this.recomputeFor(['sessions', ...ISSUE_TARGETS])
    let settle: (outcome: TaskSpawnOutcome) => void = () => {}
    const outcome = new Promise<TaskSpawnOutcome>((resolve) => {
      settle = resolve
    })
    const settled = outcome.then((value) => value === 'started')
    void args.create().then(
      () => settle('started'),
      (error) => {
        const arrived = (): boolean =>
          this.ports.base().sessions.some((row) => row.sessionId === sessionId)
        const issueArrived = (): boolean =>
          this.ports.base().issueProjections.some((row) => row.id === issueId)
        const settleFailure = (): void => {
          if (arrived()) {
            log.debug(
              'spawn transport failed after the session was created — treating as success',
              {
                sessionId,
                err: error,
              },
            )
            settle('started')
            return
          }
          if (args.recognizePartialIssue === true && issueArrived()) {
            this.spawnOverlays = this.spawnOverlays.filter(
              (overlay) => overlay.id !== sessionId && overlay.id !== issueId,
            )
            this.recomputeFor(['sessions', ...ISSUE_TARGETS])
            this.ports.notices.error(
              `The task was saved, but its agent couldn't start — ${error instanceof Error ? error.message : 'unknown error'}`,
            )
            settle('issue-only')
            return
          }
          this.spawnOverlays = this.spawnOverlays.filter(
            (overlay) => overlay.id !== sessionId && overlay.id !== issueId,
          )
          this.recomputeFor(['sessions', ...ISSUE_TARGETS])
          this.ports.notices.error(
            `Couldn't start the ${args.failureSubject} — ${error instanceof Error ? error.message : 'unknown error'}`,
          )
          settle('failed')
        }
        if (arrived()) {
          settleFailure()
        } else {
          const timer = setTimeout(() => {
            this.spawnConfirmTimers.delete(timer)
            settleFailure()
          }, this.spawnConfirmGraceMs)
          this.spawnConfirmTimers.add(timer)
        }
      },
    )
    return { sessionId, issueId, settled, outcome }
  }

  /** The #119 placeholder pair: paint a starting session and its draft issue
   *  before the create round-trips, and settle them when it answers. */
  spawnDraftAgent(args: SpawnDraftAgentArgs): {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
  } {
    assertSpawnPlacement(args.target)
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issueId = args.issueId ?? asIssueId(`iss_${randomUUID()}`)
    const nowIso = new Date().toISOString()
    const sortKey = optimisticDraftSortKey(
      this.ports.paintedIssues(),
      args.target.repoPath,
      args.target.repoId,
    )
    return this.paintSpawn({
      sessionId,
      issueId,
      session: optimisticStartingSession({
        sessionId,
        issueId,
        agentKind: args.agentKind,
        cwd: args.target.path,
        ...(args.target.machineId !== undefined ? { machineId: args.target.machineId } : {}),
        nowIso,
      }),
      issue: optimisticDraftIssue({
        userId: this.ports.userId,
        issueId,
        repoPath: args.target.repoPath,
        repoId: args.target.repoId,
        sortKey,
        agentKind: args.agentKind,
        nowIso,
      }),
      ...(args.firstPrompt ? { prompt: args.firstPrompt } : {}),
      failureSubject: 'agent',
      create: () =>
        createDraftAgent({
          trpc: this.ports.api,
          sessionId,
          issueId,
          ...(args.mutationId ? { mutationId: args.mutationId } : {}),
          ...(args.draftArtifacts?.length ? { draftArtifacts: args.draftArtifacts } : {}),
          target: args.target,
          agentKind: args.agentKind,
          firstPrompt: args.firstPrompt,
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.requestedDriverId !== undefined
            ? { requestedDriverId: args.requestedDriverId }
            : {}),
        }),
    })
  }

  /** Paint a real named task, its first session and its first chat turn before
   * the create-and-start mutation leaves this client. */
  spawnIssueAgent(args: {
    issueId?: IssueId
    sessionId?: SessionId
    mutationId?: MutationId
    target: SpawnTarget
    title: string
    description: string
    brief?: string
    parentBranch?: string
    agentKind: AgentKind
    model?: string
    effort?: string
  }): {
    sessionId: SessionId
    issueId: IssueId
    mutationId: MutationId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
  } {
    assertSpawnPlacement(args.target)
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issueId = args.issueId ?? asIssueId(`iss_${randomUUID()}`)
    const mutationId = args.mutationId ?? asMutationId(randomUUID())
    const nowIso = new Date().toISOString()
    const sortKey = optimisticDraftSortKey(
      this.ports.paintedIssues(),
      args.target.repoPath,
      args.target.repoId,
    )
    const painted = this.paintSpawn({
      sessionId,
      issueId,
      session: optimisticStartingSession({
        sessionId,
        issueId,
        agentKind: args.agentKind,
        cwd: args.target.path,
        ...(args.target.machineId !== undefined ? { machineId: args.target.machineId } : {}),
        nowIso,
      }),
      issue: optimisticStartedIssue({
        userId: this.ports.userId,
        issueId,
        repoPath: args.target.repoPath,
        repoId: args.target.repoId,
        sortKey,
        title: args.title,
        description: args.description,
        ...(args.target.machineId !== undefined ? { machineId: args.target.machineId } : {}),
        ...(args.brief !== undefined ? { brief: args.brief } : {}),
        ...(args.parentBranch !== undefined ? { parentBranch: args.parentBranch } : {}),
        agentKind: args.agentKind,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        nowIso,
      }),
      prompt: args.description,
      failureSubject: 'task',
      recognizePartialIssue: true,
      create: () =>
        createIssueAgent({
          trpc: this.ports.api,
          sessionId,
          issueId,
          mutationId,
          target: args.target,
          title: args.title,
          description: args.description,
          ...(args.brief !== undefined ? { brief: args.brief } : {}),
          ...(args.parentBranch !== undefined ? { parentBranch: args.parentBranch } : {}),
          agentKind: args.agentKind,
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
        }),
    })
    return { ...painted, mutationId }
  }
}

/** Collapse duplicate session rows for the same underlying conversation (e.g. a
 *  Codex thread surfaced twice on resume). */
export function dedupeSessions<T extends SessionMeta>(rows: T[]): T[] {
  return rows.length === 0 ? rows : dedupeSessionsByResume(rows)
}
