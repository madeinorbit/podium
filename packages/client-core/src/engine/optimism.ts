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
  IssueProjection,
  IssueWire,
  MutationId,
  SessionId,
  SessionMeta,
} from '@podium/model'
import { asIssueId, asMutationId, asSessionId, dedupeSessionsByResume } from '@podium/model'
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
import {
  optimisticDraftIssue,
  optimisticDraftSortKey,
  optimisticStartedIssue,
  optimisticStartingSession,
} from '../viewmodels'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  foldOverlays,
  insertOverlay,
  type OverlayEntity,
  overlayForOutboxEntry,
  type PendingOverlay,
  patchedCellsMovedPast,
  projectionCurationOverlay,
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
  overlay: PendingOverlay
  /** True until the durable enqueue settles. While it holds, the overlay paints
   *  on its own — there is no queue entry to carry it yet. */
  unqueued: boolean
}

/** The replica's unpainted rows — server truth for this principal's slice. */
export interface OptimismBase {
  sessions: SessionMeta[]
  issues: IssueWire[]
  issueProjections: IssueProjection[]
}

export interface OptimismPorts<TApi extends PodiumClientApi> {
  readonly api: TApi
  readonly outbox: EngineOutbox
  readonly notices: StoreNotices
  /** Server truth, read fresh — the runtime owns these lists. */
  readonly base: () => OptimismBase
  /** The PAINTED issue list, for the draft's sort-key placement. */
  readonly paintedIssues: () => IssueWire[]
  /** The runtime's state choke point. */
  readonly publish: (patch: Partial<EngineState>) => void
  /** Coalesce every `publish` inside `fn` into ONE snapshot (POD-1645). Optional
   *  so a test harness can wire the ledger without one; the default runs `fn`
   *  unchanged, which is correct but publishes once per recompute. */
  readonly batch?: (fn: () => void) => void
  readonly spawnConfirmGraceMs?: number
}

export class OptimismLedger<TApi extends PodiumClientApi> {
  private readonly ports: OptimismPorts<TApi>
  private readonly spawnConfirmGraceMs: number
  private spawnOverlays: PendingOverlay[] = []
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
      const overlay = overlayForOutboxEntry(e)
      if (overlay?.op === 'patch') {
        restored.push({
          overlay,
          // A chained entry (enqueued behind a same-row sibling, #263 review
          // round 2) never uses the moved-past escape: its sibling's echo may
          // have landed while we were unloaded, and the stale enqueue baseline
          // would retire it on the first prune — coveredBy/TTL bound it instead.
          baseline: e.chained === true ? undefined : e.baseline,
          resolvedAt: e.resolvedAt ?? Date.now(),
        })
      } else {
        ports.outbox.retireAwaiting(e.mutationId)
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
   * The overlay one queued entry paints.
   *
   * Normally that is `overlayForOutboxEntry`, a pure function of the entry. The
   * exception is an entry this ledger enqueued itself (POD-1053): it painted
   * before the durable commit, so the overlay of record is the one minted at the
   * press — carrying the PRESS's clock rather than the storage commit's. Without
   * that, the five clock-stamped kinds (`issueSetTucked`, `issueMarkRead`,
   * `sessionMarkRead`, `issueDelete`, `issueUndefer`) would repaint a
   * millisecond-different timestamp when the entry landed, and a repaint is not
   * cheap here: a moved cell is a new row identity, and a new row identity
   * re-derives the whole worklist. The press instant is also the more honest
   * value — it is when the user acted.
   */
  private overlayFor(entry: OutboxEntry): PendingOverlay | null {
    const local = this.localOverlays.get(entry.mutationId)
    if (local !== undefined && local.input === entry.input) return local.overlay
    return overlayForOutboxEntry(entry)
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

  /** The pending overlays for one entity, in application order: resolved
   *  patches awaiting truth first (they were sent earliest), then the queued
   *  outbox entries FIFO — so two pending mutations on the same row compose in
   *  queue order — then anything pressed but not yet durable (the newest writes
   *  there are), plus the #119 spawn placeholder inserts (order-independent:
   *  folding applies inserts before any patch). Derived fresh each recompute:
   *  the outbox itself is the queued-overlay state, never a second copy. */
  overlaysFor(entity: OverlayEntity): PendingOverlay[] {
    const out: PendingOverlay[] = []
    const include = (overlay: PendingOverlay): void => {
      if (overlay.entity === entity) out.push(overlay)
      // The curation mirror (POD-781): curation writes overlay the retained issue
      // row, and the BOARD reads the normalized projection over it.
      // Without this the sidebar moved on the press and the board did not.
      if (entity === 'issueProjections') {
        const curation = projectionCurationOverlay(overlay)
        if (curation) out.push(curation)
      }
    }
    for (const overlay of this.spawnOverlays) include(overlay)
    for (const awaiting of this.awaitingTruth) include(awaiting.overlay)
    for (const entry of this.ports.outbox.pending()) {
      const overlay = this.overlayFor(entry)
      if (overlay) include(overlay)
    }
    // Pressed, painted, not yet committed: nothing in the queue carries these
    // yet. The flag clears the moment the enqueue settles, so an entry never
    // paints from both here and the loop above.
    for (const held of this.localOverlays.values()) {
      if (held.unqueued) include(held.overlay)
    }
    return out
  }

  /** Fold the seed (construction-time) session/issue/projection lists without
   *  publishing — the very first snapshot must already carry queued optimism. */
  foldSeed<T extends object>(
    entity: OverlayEntity,
    base: T[],
    keyOf: (row: T) => string,
  ): { rows: T[]; pendingInsertIds: ReadonlySet<string> } {
    return foldOverlays(base, this.overlaysFor(entity), keyOf)
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
      this.recomputeIssues()
      this.recomputeIssueProjections()
    })
  }

  /** Retirement rule (a) (#263, overlay.ts): spawn inserts retire when server
   *  truth (same id) landed in the replica; resolved patches retire when the
   *  row covers the mutation, moved past the enqueue baseline (oldest per row),
   *  or outlived the TTL. Retiring an awaiting patch also deletes its durable
   *  storage entry (finding 1: deletion happens at retirement, not resolution). */
  private retireCovered<T extends object>(
    entity: OverlayEntity,
    base: T[],
    keyOf: (row: T) => string,
  ): void {
    if (this.spawnOverlays.some((o) => o.entity === entity)) {
      const known = new Set(base.map(keyOf))
      const keep = this.spawnOverlays.filter((o) => o.entity !== entity || !known.has(o.id))
      if (keep.length !== this.spawnOverlays.length) this.spawnOverlays = keep
    }
    const pruned = pruneAwaiting(this.awaitingTruth, entity, base, keyOf)
    if (pruned !== this.awaitingTruth) {
      const dropped = this.awaitingTruth.filter((a) => !pruned.includes(a))
      // Assign BEFORE the durable retire, so any re-entrant recompute already
      // sees the pruned stage.
      this.awaitingTruth = pruned
      for (const a of dropped) this.ports.outbox.retireAwaiting(asMutationId(a.overlay.key))
    }
  }

  /** Fold `replica rows + pending mutations' overlays` into the snapshot's
   *  session list, and derive pendingSpawnIds — the ids AgentPanel must not
   *  attach to yet (#119). */
  recomputeSessions(): void {
    const base = this.ports.base().sessions
    const keyOf = (s: SessionMeta): string => s.sessionId
    this.retireCovered('sessions', base, keyOf)
    const { rows, pendingInsertIds } = foldOverlays(base, this.overlaysFor('sessions'), keyOf)
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

  recomputeIssues(): void {
    const base = this.ports.base().issues
    const keyOf = (i: IssueWire): string => i.id
    this.retireCovered('issues', base, keyOf)
    const { rows } = foldOverlays(base, this.overlaysFor('issues'), keyOf)
    this.ports.publish({ issues: rows })
  }

  recomputeIssueProjections(): void {
    const base = this.ports.base().issueProjections
    const keyOf = (i: IssueProjection): string => i.id
    this.retireCovered('issueProjections', base, keyOf)
    const { rows } = foldOverlays(base, this.overlaysFor('issueProjections'), keyOf)
    this.ports.publish({ issueProjections: rows })
  }

  recomputeFor(entity: OverlayEntity | undefined): void {
    if (entity === 'sessions') this.recomputeSessions()
    // Curation writes on the issue row mirror into the projection for normalized
    // issue surfaces, so an issue recompute also refreshes that derived mirror.
    else if (entity === 'issues') {
      this.batched(() => {
        this.recomputeIssues()
        this.recomputeIssueProjections()
      })
    } else if (entity === 'issueProjections') {
      this.recomputeIssueProjections()
    }
  }

  /** Drain success (#263): hand the entry's overlay to the awaiting-truth
   *  stage. Called by the outbox BEFORE it notifies subscribers of the
   *  shrunken queue, so no intermediate snapshot ever lacks the overlay.
   *  Returns true to keep the entry DURABLY in storage (finding 1) until
   *  covering truth retires it. */
  mutationApplied(entry: OutboxEntry): boolean {
    const overlay = this.overlayFor(entry)
    if (overlay?.op !== 'patch') {
      this.localOverlays.delete(entry.mutationId)
      return false
    }
    const { sessions, issues, issueProjections } = this.ports.base()
    const row =
      overlay.entity === 'sessions'
        ? sessions.find((s) => s.sessionId === overlay.id)
        : overlay.entity === 'issues'
          ? issues.find((i) => i.id === overlay.id)
          : issueProjections.find((i) => i.id === overlay.id)
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
    let hold = false
    if (row !== undefined && !overlay.coveredBy(row)) {
      const olderSameRow =
        entry.chained === true ||
        this.awaitingTruth.some(
          (a) => a.overlay.entity === overlay.entity && a.overlay.id === overlay.id,
        )
      const moved = patchedCellsMovedPast(overlay, row, entry.baseline)
      if (moved && !olderSameRow) {
        // Competing truth won while the mutation was in flight — server wins.
      } else {
        hold = true
        this.awaitingTruth = [
          ...this.awaitingTruth,
          { overlay, baseline: olderSameRow ? undefined : entry.baseline, resolvedAt: Date.now() },
        ]
        this.armAwaitingSweep()
      }
    }
    this.recomputeFor(overlay.entity)
    // AFTER the recompute: the outbox fires this before subscribers see the
    // shrunken queue, so the entry can still be in `pending()` above — and the
    // queued copy must keep painting the same values as the awaiting one it was
    // just handed to.
    this.localOverlays.delete(entry.mutationId)
    return hold
  }

  /** Definitive failure — retirement rule (b): the wiring already surfaced the
   *  poison toast; repaint without the dropped entry's overlay. */
  mutationDropped(entry: OutboxEntry): void {
    const entity = this.overlayFor(entry)?.entity
    this.localOverlays.delete(entry.mutationId)
    this.recomputeFor(entity)
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
   * The overlay is minted ONCE, filed under the id the entry WILL carry, and
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
   * See {@link overlayFor}.
   */
  async enqueueOverlayed<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
  ): Promise<void> {
    // Enqueue-time baseline (#263 review finding 2): fingerprint the target
    // row's REPLICA truth (unpainted — the replica is server truth only) so
    // resolution can tell whether truth already moved while in flight.
    const mutationId = asMutationId(randomUUID())
    const queuedAt = Date.now()
    const probe = overlayForOutboxEntry({ mutationId, kind, input, queuedAt })
    let baseline: string | undefined
    let chained = false
    if (probe?.op === 'patch') {
      const { sessions, issues, issueProjections } = this.ports.base()
      const row =
        probe.entity === 'sessions'
          ? sessions.find((s) => s.sessionId === probe.id)
          : probe.entity === 'issues'
            ? issues.find((i) => i.id === probe.id)
            : issueProjections.find((i) => i.id === probe.id)
      if (row !== undefined) baseline = rowFingerprint(row)
      // Chained stamp (#263 review round 2): a same-row entry already pending
      // (queued, awaiting, or pressed and not yet durable) means ITS echo will
      // move the row past this baseline while this mutation is in flight —
      // resolution must not read that movement as a competing writer (see
      // mutationApplied).
      const sameRow = (o: PendingOverlay | null): boolean =>
        o?.op === 'patch' && o.entity === probe.entity && o.id === probe.id
      chained =
        this.awaitingTruth.some((a) => sameRow(a.overlay)) ||
        [...this.localOverlays.values()].some((l) => l.unqueued && sameRow(l.overlay)) ||
        this.ports.outbox.pending().some((e) => sameRow(this.overlayFor(e)))
    }
    const opts = {
      mutationId,
      ...(baseline !== undefined ? { baseline } : {}),
      ...(chained ? { chained } : {}),
    }
    // The overlay OF RECORD, projected from the entry as it will be stored —
    // baseline included. `probe` above could not carry it (the baseline is
    // derived FROM the probe), and a baseline-less `coveredBy` is not merely
    // approximate: `issueMarkRead` judges coverage as "the cursor moved past the
    // enqueue-time one", so an absent baseline retires the overlay on its own
    // resolution and the paint vanishes.
    const overlay =
      probe === null ? null : overlayForOutboxEntry({ ...opts, kind, input, queuedAt })
    // PAINT, then persist.
    if (overlay !== null) {
      this.localOverlays.set(mutationId, { input, overlay, unqueued: true })
      this.recomputeFor(overlay.entity)
    }
    let entry: OutboxEntry
    try {
      entry = await this.ports.outbox.enqueue(kind, input, opts)
    } catch (error) {
      if (overlay !== null) {
        this.localOverlays.delete(mutationId)
        this.recomputeFor(overlay.entity)
      }
      throw error
    }
    // The queue now carries it — unless the drain already applied or dropped it,
    // which deletes the entry here and leaves nothing to hand over.
    const held = this.localOverlays.get(mutationId)
    if (held !== undefined) held.unqueued = false
    this.sweepLocalOverlays()
    this.recomputeFor(this.overlayFor(entry)?.entity)
  }

  private paintSpawn(args: {
    sessionId: SessionId
    issueId: IssueId
    session: SessionMeta
    issue: IssueWire
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
    this.spawnOverlays = [
      ...this.spawnOverlays,
      insertOverlay('sessions', sessionId, args.session),
      insertOverlay('issues', issueId, args.issue),
    ]
    if (args.prompt) this.spawnPrompts = new Map(this.spawnPrompts).set(sessionId, args.prompt)
    this.batched(() => {
      this.recomputeSessions()
      this.recomputeIssues()
    })
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
          this.ports.base().issues.some((row) => row.id === issueId)
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
            this.batched(() => {
              this.recomputeSessions()
              this.recomputeIssues()
            })
            this.ports.notices.error(
              `The task was saved, but its agent couldn't start — ${error instanceof Error ? error.message : 'unknown error'}`,
            )
            settle('issue-only')
            return
          }
          this.spawnOverlays = this.spawnOverlays.filter(
            (overlay) => overlay.id !== sessionId && overlay.id !== issueId,
          )
          this.batched(() => {
            this.recomputeSessions()
            this.recomputeIssues()
          })
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
          ...(args.runtimeContract !== undefined
            ? { runtimeContract: args.runtimeContract }
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
export function dedupeSessions(rows: SessionMeta[]): SessionMeta[] {
  return rows.length === 0 ? rows : dedupeSessionsByResume(rows)
}
