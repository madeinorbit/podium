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

import type { AgentKind, IssueId, IssueWire, SessionId, SessionMeta } from '@podium/model'
import { asIssueId, asSessionId, dedupeSessionsByResume } from '@podium/model'
import type { PodiumClientApi } from '../api'
import { randomUUID } from '../id'
import type { OutboxEntry } from '../outbox'
import type { IssueProjectionRow } from '../replica/contract'
import { assertSpawnPlacement, createDraftAgent, type SpawnTarget } from '../spawn-agent'
import {
  optimisticDraftIssue,
  optimisticDraftSortKey,
  optimisticStartingSession,
} from '../viewmodels'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  foldOverlays,
  insertOverlay,
  legacyIssueReadOverlay,
  type OverlayEntity,
  overlayForOutboxEntry,
  type PendingOverlay,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'
import type { EngineState } from './state'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

/** How long a FAILED spawn create waits for the session broadcast before it is
 *  treated as definitive (#263 review finding 4): the create can reach the
 *  server and mint the row while the HTTP response is lost — rolling back /
 *  toasting on such a rejection cries wolf over a session that exists. */
export const SPAWN_CONFIRM_GRACE_MS = 2000

/** The replica's unpainted rows — server truth for this principal's slice. */
export interface OptimismBase {
  sessions: SessionMeta[]
  issues: IssueWire[]
  issueProjections: IssueProjectionRow[]
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
  private awaitingTruth: AwaitingTruth[] = []
  /** TTL sweep for the awaiting-truth stage (#263 review finding 3): prunes run
   *  on recomputes, which only fire on replica/outbox changes — a row that
   *  never changes again would otherwise keep a stuck entry painted forever. */
  private awaitingSweepTimer: ReturnType<typeof setTimeout> | null = null
  /** Live spawn-confirm grace timers (#263 review round 2). Cleared in
   *  dispose(): a replaced runtime's late timer must not roll back overlays or
   *  toast after its successor took over the same storage/session state. */
  private readonly spawnConfirmTimers = new Set<ReturnType<typeof setTimeout>>()

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
    if (this.awaitingSweepTimer !== null) {
      clearTimeout(this.awaitingSweepTimer)
      this.awaitingSweepTimer = null
    }
    for (const t of this.spawnConfirmTimers) clearTimeout(t)
    this.spawnConfirmTimers.clear()
  }

  /** The pending overlays for one entity, in application order: resolved
   *  patches awaiting truth first (they were sent earliest), then the queued
   *  outbox entries FIFO — so two pending mutations on the same row compose in
   *  queue order — plus the #119 spawn placeholder inserts (order-independent:
   *  folding applies inserts before any patch). Derived fresh each recompute:
   *  the outbox itself is the queued-overlay state, never a second copy. */
  overlaysFor(entity: OverlayEntity): PendingOverlay[] {
    const out: PendingOverlay[] = []
    const include = (overlay: PendingOverlay): void => {
      if (overlay.entity === entity) out.push(overlay)
      if (entity === 'issues') {
        const compatibility = legacyIssueReadOverlay(overlay)
        if (compatibility) out.push(compatibility)
      }
    }
    for (const overlay of this.spawnOverlays) include(overlay)
    for (const awaiting of this.awaitingTruth) include(awaiting.overlay)
    for (const entry of this.ports.outbox.pending()) {
      const overlay = overlayForOutboxEntry(entry)
      if (overlay) include(overlay)
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
      for (const a of dropped) this.ports.outbox.retireAwaiting(a.overlay.key)
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
    this.ports.publish({ sessions: rows, pendingSpawnIds: pendingInsertIds })
  }

  recomputeIssues(): void {
    const base = this.ports.base().issues
    const keyOf = (i: IssueWire): string => i.id
    this.retireCovered('issues', base, keyOf)
    const { rows } = foldOverlays(base, this.overlaysFor('issues'), keyOf)
    this.ports.publish({ issues: rows })
  }

  recomputeIssueProjections(): void {
    const { issues, issueProjections: base } = this.ports.base()
    const keyOf = (i: IssueProjectionRow): string => i.id
    // During the additive cutover a legacy row can arrive before its normalized
    // projection. Keep a resolved read overlay alive against that row instead
    // of treating the temporarily absent projection as deletion.
    const normalizedIds = new Set(base.map(keyOf))
    const retirementBase: IssueProjectionRow[] = [
      ...base,
      ...issues.filter((issue) => !normalizedIds.has(issue.id)).map(projectionOfIssue),
    ]
    this.retireCovered('issueProjections', retirementBase, keyOf)
    const { rows } = foldOverlays(base, this.overlaysFor('issueProjections'), keyOf)
    this.ports.publish({ issueProjections: rows })
  }

  recomputeFor(entity: OverlayEntity | undefined): void {
    if (entity === 'sessions') this.recomputeSessions()
    else if (entity === 'issues') this.recomputeIssues()
    else if (entity === 'issueProjections') {
      this.batched(() => {
        this.recomputeIssueProjections()
        this.recomputeIssues()
      })
    }
  }

  /** Drain success (#263): hand the entry's overlay to the awaiting-truth
   *  stage. Called by the outbox BEFORE it notifies subscribers of the
   *  shrunken queue, so no intermediate snapshot ever lacks the overlay.
   *  Returns true to keep the entry DURABLY in storage (finding 1) until
   *  covering truth retires it. */
  mutationApplied(entry: OutboxEntry): boolean {
    const overlay = overlayForOutboxEntry(entry)
    if (overlay?.op !== 'patch') return false
    const { sessions, issues, issueProjections } = this.ports.base()
    const row =
      overlay.entity === 'sessions'
        ? sessions.find((s) => s.sessionId === overlay.id)
        : overlay.entity === 'issues'
          ? issues.find((i) => i.id === overlay.id)
          : (issueProjections.find((i) => i.id === overlay.id) ??
            issues
              .filter((i) => i.id === overlay.id)
              .map(projectionOfIssue)
              .at(0))
    // Hold the overlay until covering truth lands. Nothing to hold when the
    // row is gone, already reflects the mutation (the broadcast echo raced
    // ahead of the response), or moved past the ENQUEUE-time baseline without
    // covering it (finding 2: covering-or-competing truth already landed — a
    // resolution-time fingerprint of that final row would never "move" again
    // and the overlay would mask server truth forever).
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
      const moved = entry.baseline !== undefined && rowFingerprint(row) !== entry.baseline
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
    return hold
  }

  /** Definitive failure — retirement rule (b): the wiring already surfaced the
   *  poison toast; repaint without the dropped entry's overlay. */
  mutationDropped(entry: OutboxEntry): void {
    this.recomputeFor(overlayForOutboxEntry(entry)?.entity)
  }

  /** Enqueue + repaint: the queued entry IS the optimistic apply (#263). */
  async enqueueOverlayed<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
  ): Promise<void> {
    // Enqueue-time baseline (#263 review finding 2): fingerprint the target
    // row's REPLICA truth (unpainted — the replica is server truth only) so
    // resolution can tell whether truth already moved while in flight.
    const probe = overlayForOutboxEntry({ mutationId: '', kind, input, queuedAt: 0 })
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
      // (queued or awaiting) means ITS echo will move the row past this
      // baseline while this mutation is in flight — resolution must not read
      // that movement as a competing writer (see mutationApplied).
      const sameRow = (o: PendingOverlay | null): boolean =>
        o?.op === 'patch' && o.entity === probe.entity && o.id === probe.id
      chained =
        this.awaitingTruth.some((a) => sameRow(a.overlay)) ||
        this.ports.outbox.pending().some((e) => sameRow(overlayForOutboxEntry(e)))
    }
    const entry = await this.ports.outbox.enqueue(kind, input, {
      ...(baseline !== undefined ? { baseline } : {}),
      ...(chained ? { chained } : {}),
    })
    this.recomputeFor(overlayForOutboxEntry(entry)?.entity)
  }

  /** The #119 placeholder pair: paint a starting session and its draft issue
   *  before the create round-trips, and settle them when it answers. */
  spawnDraftAgent(args: { target: SpawnTarget; agentKind: AgentKind; firstPrompt?: string }): {
    sessionId: SessionId
    issueId: IssueId
  } {
    // Machine USE is a code-execution boundary. Refuse before minting ids or
    // painting optimistic rows: a forbidden target must never appear as a
    // temporarily-created session/issue while the async network seam rejects.
    assertSpawnPlacement(args.target)
    const sessionId = asSessionId(randomUUID())
    const issueId = asIssueId(`iss_${randomUUID()}`)
    const nowIso = new Date().toISOString()
    const sortKey = optimisticDraftSortKey(
      this.ports.paintedIssues(),
      args.target.repoPath,
      args.target.repoId,
    )
    this.spawnOverlays = [
      ...this.spawnOverlays,
      insertOverlay(
        'sessions',
        sessionId,
        optimisticStartingSession({
          sessionId,
          issueId,
          agentKind: args.agentKind,
          cwd: args.target.path,
          nowIso,
        }),
      ),
      insertOverlay(
        'issues',
        issueId,
        optimisticDraftIssue({
          issueId,
          repoPath: args.target.repoPath,
          repoId: args.target.repoId,
          sortKey,
          agentKind: args.agentKind,
          nowIso,
        }),
      ),
    ]
    this.batched(() => {
      this.recomputeSessions()
      this.recomputeIssues()
    })
    void createDraftAgent({
      trpc: this.ports.api,
      sessionId,
      issueId,
      target: args.target,
      agentKind: args.agentKind,
      firstPrompt: args.firstPrompt,
    }).catch((error) => {
      const arrived = (): boolean =>
        this.ports.base().sessions.some((row) => row.sessionId === sessionId)
      const settleFailure = (): void => {
        if (arrived()) {
          console.debug(
            '[podium] spawn transport failed after the session was created — treating as success',
            sessionId,
            error,
          )
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
          `Couldn't start the agent — ${error instanceof Error ? error.message : 'unknown error'}`,
        )
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
    })
    return { sessionId, issueId }
  }
}

/** Collapse duplicate session rows for the same underlying conversation (e.g. a
 *  Codex thread surfaced twice on resume). */
export function dedupeSessions(rows: SessionMeta[]): SessionMeta[] {
  return rows.length === 0 ? rows : dedupeSessionsByResume(rows)
}

/** The legacy issue row seen as a projection — the additive-cutover shim. */
function projectionOfIssue(issue: IssueWire): IssueProjectionRow {
  return {
    id: issue.id,
    readAt:
      (issue as IssueWire & { unread?: boolean }).unread === true ? null : (issue.readAt ?? null),
  } as IssueProjectionRow
}
