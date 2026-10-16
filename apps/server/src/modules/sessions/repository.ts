import { bootStage } from '../../boot-timing'
import type { IssueId, MachineId, SessionId, SessionMeta, SessionUserStateWire } from '@podium/model'
import { sessionUserStateRowId } from '@podium/model'

/**
 * WHO a session wire projection is being built for — the explicit argument
 * `sessionWire()` takes so a future suppression rule has exactly one home
 * (POD-366; policy is Phase 3 / POD-290).
 *
 * It is POD-365's `ActorRef` and NOT a new type, deliberately. ActorRef is
 * already the closed discriminated union over ADR 9 D1's four principal kinds
 * (user / agent / machine / system), and this issue's brief forbids introducing a
 * parallel identity field ahead of POD-323. Reusing it also means a scoped
 * projection can later distinguish "a human reading their own session" from "an
 * agent reading on someone's behalf" without a second vocabulary — and, per
 * `fields/README.md` rule 2, a redacted arm can be added to the union rather than
 * overloading `null`.
 */
export type SessionWirePrincipal = SessionStatePrincipal

import { firstAdminMemberId } from '@podium/model'
import type { DaemonPtyInputBatch, MetadataChange } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { type BaselineFoldPort, type EntityChangeSpec, StagedOverlay } from '@podium/sync'
import type { AutoContinueController } from '../../auto-continue'
import { isFeatureEnabled } from '../../features'
import type { SessionRow, SessionStore } from '../../store'
import type { WriteFunnel } from '../funnel'
import type { MemoryService } from '../memory/service'
import { DEPLOYMENT, perf } from '../perf/registry'
import type { SessionLedger } from './lifecycle'
export interface SessionProjectionEvent {
  generation: number
  changes: MetadataChange[]
  ledgerCursor: number
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { createLogger } from '@podium/logger'
import { Session, type SessionDurableState, type SessionVolatileField } from './session'
import { storedSessionInit } from './session-record'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'
import type { SessionView } from './view'
import { runtimeTranscriptDeltaFromEvent } from './runtime-transcript'

const log = createLogger('server:sessions')

/**
 * Overlay a whole-state draft onto live committed fields [POD-3720].
 *
 * Each writer still cuts a full snapshot. When two persistDrafts overlap, the
 * later snapshot still carries the earlier writer's previous values for fields
 * it did not touch. After the previous persist has installed, unchanged fields
 * are taken from live so a stale draft cannot clobber them.
 *
 * Nested object fields (offer, agentState, resume) are compared by reference
 * against the shallow origin `draft()` recorded. Writers replace those values
 * rather than mutating them in place.
 */
function overlayChangedDurableFields(
  origin: SessionDurableState,
  draft: SessionDurableState,
  live: SessionDurableState,
): SessionDurableState {
  const merged: SessionDurableState = { ...live }
  const assign = <K extends keyof SessionDurableState>(key: K): void => {
    if (!Object.is(draft[key], origin[key])) merged[key] = draft[key]
  }
  for (const key of Object.keys(draft) as (keyof SessionDurableState)[]) assign(key)
  return merged
}

interface PendingVolatileState {
  version: number
  preserve: Set<SessionVolatileField>
  issueRelevant: boolean
  enqueuedAt: number
}

export interface VolatileSliceBudget {
  maxItems?: number
  maxCpuMs?: number
  now?: () => number
}

export interface VolatileSliceResult {
  changes: MetadataChange[]
  remaining: number
}

export interface SessionRepositoryPorts {
  sessions: Map<SessionId, Session>
  store: SessionStore
  memory: Pick<MemoryService, 'conversationPodiumId'>
  ledger: SessionLedger
  /**
   * Where the committed durable baseline waits for the OUTERMOST commit
   * [POD-3361, spec §3.3 mechanism 1] — the same port and the same seam
   * POD-3328 gave the change baseline.
   *
   * Unset means "there is no unit of work to wait for", which is what a unit
   * test with a pass-through ledger wants: the baseline installs as soon as the
   * commit returns, exactly as it did before this port existed.
   */
  applyCommit?: BaselineFoldPort
  funnel: WriteFunnel
  view: SessionView
  state: SessionStateService
  autoContinue(): AutoContinueController
  toMachine(machineId: MachineId, message: ControlMessage): void
  toPtyInput(machineId: MachineId, input: DaemonPtyInputBatch): void
  broadcastSessions(): void
  flushBroadcasts(): Promise<void>
  runScheduledBroadcast(): Promise<void>
  /** THE CLIENT-VISIBLE SESSION BASELINE, for the boot ledger reconcile.
   *  Genuinely the reader-scoped projection: `sync.changesSince` is served from
   *  what this publishes, so a cheaper read here would ship a different value to
   *  every client [POD-3857]. Once per server start. */
  listSessionsForBootBaseline(): Promise<SessionMeta[]>
  now(): number
  appliedMutationMaxAgeMs: number
  /**
   * A committed write changed what delivery routing reads off the session —
   * its explicit issue or its cwd (POD-6160). `previous` is what the row said
   * before the write; the wiring publishes it as `session.routingChanged`.
   */
  onRoutingChanged?(sessionId: SessionId, previous: { issueId?: IssueId; cwd: string }): void
}

export class SessionRepository {
  private sessionsGeneration_ = 0
  private readonly sessionProjectionListeners = new Set<(event: SessionProjectionEvent) => void>()
  private volatileSessionMutationVersion = 0
  private readonly pendingVolatileSessions = new Map<SessionId, PendingVolatileState>()
  /**
   * PER-SESSION WRITE TAIL [POD-3720]. Sibling persistDraft/write/persist calls
   * on one session queue here so the later writer sees the earlier install (or,
   * for a draft already cut, overlays onto it). Nested writes from inside a
   * commit hook re-enter via {@link sessionWriteScope} instead of waiting on
   * themselves.
   */
  private readonly sessionWriteTail = new Map<SessionId, Promise<void>>()
  private readonly sessionWriteScope = new AsyncLocalStorage<ReadonlySet<SessionId>>()
  /** Shallow origin recorded by {@link draft}, keyed by the draft bag. */
  private readonly draftOrigins = new WeakMap<SessionDurableState, SessionDurableState>()
  /**
   * THE COMMITTED DURABLE SNAPSHOT PER SESSION [POD-3259, spec §3.6].
   *
   * A `Session` is process-owned mutable state with TWO halves, and the model
   * for this registry is the line between them:
   *
   *  - the DURABLE METADATA half — everything {@link Session.captureDurableState}
   *    returns — is what a row is built from. It is snapshotted BEFORE the write
   *    that persists it, that snapshot is what gets installed as the committed
   *    baseline once the commit returns, and a failed commit rolls the live
   *    object back to the previous baseline. It may not be treated as settled
   *    while a persist is in flight.
   *  - the LIVE TERMINAL half — frames, the cursor, geometry, the activity
   *    counters, and the four {@link SessionVolatileField}s a rollback preserves
   *    (`geometry`, `status`, `machineId`, `handoffTargetMachineId`) — MAY change while
   *    persistence is awaiting, and deliberately does: a pty does not stop
   *    producing output because a metadata row is being written. Those fields
   *    are re-captured by the volatile sweep rather than rolled back, which is
   *    why {@link Session.restoreDurableState} takes a preserve set at all.
   *
   * A ROLLBACK RESTORES THE LATEST BASELINE, NOT THE ONE ITS WRITE PINNED, and
   * that is worth stating because the opposite is the tempting answer. A
   * version-pinned rollback — "stand down if another persist committed while I
   * was in flight" — was written here first and removed: this map holds the
   * LATEST committed state, so restoring it is right whether or not somebody
   * else committed in the gap, while standing down leaves the failed write's own
   * uncommitted fields on the live object. Two writers touching different fields
   * is what separates the two, and the refusing version loses that case.
   */
  private readonly capturedSessionStates = new Map<SessionId, SessionDurableState>()
  /**
   * BASELINES STAGED AGAINST AN OPEN SPAN, in install order [POD-3361].
   *
   * A SAVEPOINT RELEASE IS NOT A COMMIT. `persist` commits through the ledger,
   * whose `transact` degrades to a savepoint whenever a caller already has a
   * span open — `IssueAttachOrchestrator` wraps a whole attach in one, and the
   * write funnel opens one around every `mutateSessionMeta`. Installing the
   * draft when that savepoint releases makes memory claim a row the enclosing
   * span can still roll back: `committedDurableState` then reports a state no
   * commit kept, and the next failed persist restores the live object to it —
   * "a state no commit ever saw", which is exactly what {@link persist}'s draft
   * comment says must not happen.
   *
   * So a baseline installed inside a span lands here and reaches
   * {@link capturedSessionStates} only through the commit application
   * registered on the OUTERMOST commit (spec §3.3 mechanism 1). A span that
   * rolls back never promotes, and {@link freshenDurableBaselines} clears what
   * it left behind the next time this map is used with no span open.
   *
   * READS SEE THE STAGED LAYER, and that is the same answer POD-3328 reached
   * for the change baseline rather than a copy of its shape. The in-window
   * reader here is `persist`'s own catch arm: a second persist failing inside
   * the same enclosing span restores the live object from this map. Without the
   * overlay it would restore the state from BEFORE the span — undoing the
   * earlier nested write's fields on the live object while the enclosing span
   * may still go on to commit them, so the next persist would write the stale
   * fields back over the committed row. The overlay keeps that reader seeing
   * exactly what it sees today; only the committed map waits. It was the SECOND
   * of four distinct in-window readers the programme found, each with its own
   * argument, which is what makes the read-through the cost of deferring an
   * install rather than a trick that worked twice.
   *
   * THE LAYER IS NO LONGER HAND-ROLLED HERE [POD-3366]. `StagedOverlay` owns
   * the staging, the promotion and the drop-on-the-way-in; this class keeps only
   * what a promotion MEANS for its committed map. The copy this replaced
   * promoted by looking its own entry up again at drain time — and its own
   * freshen path empties that array whenever `spanOpen()` is false, which is
   * exactly what the drain looks like. A co-batched commit application that
   * merely READ a baseline first would have emptied it, the `findIndex` would
   * have returned -1, and the install would have been dropped with no error.
   * Latent rather than active — no live ordering reaches it today — but latent
   * and unreachable are different claims and only one survives a new caller, so
   * the shared promotion closes over its value instead.
   */
  private readonly stagedSessionStates: StagedOverlay<SessionId, SessionDurableState>
  /** True while an activity flush is running — see {@link flushActivity}. */
  private flushingActivity = false
  private activityMutationVersion = 0
  private readonly dirtyActivitySessions = new Map<SessionId, number>()
  private volatileSessionCaptureTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly VOLATILE_CAPTURE_RETRY_MS = 1_000
  static readonly VOLATILE_SLICE_MAX_ITEMS = 32
  static readonly VOLATILE_SLICE_MAX_CPU_MS = 8

  constructor(private readonly ports: SessionRepositoryPorts) {
    this.stagedSessionStates = new StagedOverlay<SessionId, SessionDurableState>(
      ports.applyCommit,
      (sessionId, state) => {
        if (state) this.capturedSessionStates.set(sessionId, state)
        else this.capturedSessionStates.delete(sessionId)
      },
      'session-durable-baseline-fold',
    )
    // Initial resident sessions need one enrollment pass, never a timer sweep.
    for (const session of ports.sessions.values()) this.observeSessionActivity(session)
  }

  private observeSessionActivity(session: Session): void {
    session.terminal.setActivityDirtyListener(() => {
      this.dirtyActivitySessions.set(session.sessionId, ++this.activityMutationVersion)
    })
  }

  registerSession(session: Session): void {
    this.sessions.get(session.sessionId)?.terminal.setActivityDirtyListener(undefined)
    this.dirtyActivitySessions.delete(session.sessionId)
    this.sessions.set(session.sessionId, session)
    this.observeSessionActivity(session)
  }

  private get sessions(): Map<SessionId, Session> {
    return this.ports.sessions
  }
  private get store(): SessionStore {
    return this.ports.store
  }
  private get funnel(): WriteFunnel {
    return this.ports.funnel
  }
  private get view(): SessionView {
    return this.ports.view
  }
  private get state(): SessionStateService {
    return this.ports.state
  }
  private get autoContinue(): AutoContinueController {
    return this.ports.autoContinue()
  }
  private readonly toMachine = (machineId: MachineId, message: ControlMessage): void =>
    this.ports.toMachine(machineId, message)
  private readonly broadcastSessions = (): void => this.ports.broadcastSessions()
  private readonly listSessionsForBootBaseline = (): Promise<SessionMeta[]> =>
    this.ports.listSessionsForBootBaseline()
  private readonly now = (): number => this.ports.now()

  hasPendingVolatile(): boolean {
    return this.pendingVolatileSessions.size > 0
  }

  sessionsGeneration(): number {
    return this.sessionsGeneration_
  }

  /** Ordered post-capture patches for projection workers [spec:SP-c29e]. */
  onSessionProjection(listener: (event: SessionProjectionEvent) => void): () => void {
    this.sessionProjectionListeners.add(listener)
    return () => this.sessionProjectionListeners.delete(listener)
  }

  publishSessionProjection(
    changes: MetadataChange[],
    ledgerCursor: number | undefined = changes.at(-1)?.seq,
    _issueRelevant = true,
  ): void {
    const sessionChanges = changes.filter((change) => change.entity === 'session')
    if (sessionChanges.length === 0 || ledgerCursor === undefined) return
    const event: SessionProjectionEvent = {
      generation: ++this.sessionsGeneration_,
      changes: sessionChanges,
      ledgerCursor,
    }
    for (const listener of this.sessionProjectionListeners) {
      try {
        listener(event)
      } catch (err) {
        log.error('projection listener threw', { err })
      }
    }
  }

  /** Explicit non-row capture seam [spec:SP-c29e]. */
  private async captureSessionSpecs(
    specs: EntityChangeSpec[],
    issueRelevant = true,
  ): Promise<MetadataChange[]> {
    if (specs.length === 0) return []
    const changes = await this.ports.ledger.capture(specs)
    this.publishSessionProjection(changes, undefined, issueRelevant)
    return changes
  }

  markVolatileSessionDirty(
    sessionId: SessionId,
    preserve: SessionVolatileField[] = ['handoffTargetMachineId'],
    issueRelevant = true,
  ): void {
    const previous = this.pendingVolatileSessions.get(sessionId)
    this.pendingVolatileSessions.set(sessionId, {
      version: ++this.volatileSessionMutationVersion,
      preserve: new Set([...(previous?.preserve ?? []), ...preserve]),
      issueRelevant: (previous?.issueRelevant ?? false) || issueRelevant,
      enqueuedAt: previous?.enqueuedAt ?? this.now(),
    })
    this.scheduleVolatileSessionCapture()
  }

  scheduleVolatileSessionCapture(delayMs = 0): void {
    if (this.volatileSessionCaptureTimer) return
    this.volatileSessionCaptureTimer = setTimeout(async () => {
      this.volatileSessionCaptureTimer = null
      try {
        await this.ports.runScheduledBroadcast()
      } catch (err) {
        log.warn('volatile session capture failed', { err })
      }
    }, delayMs)
    this.volatileSessionCaptureTimer.unref?.()
  }

  private clearVolatileSessionCaptureTimer(): void {
    if (!this.volatileSessionCaptureTimer) return
    clearTimeout(this.volatileSessionCaptureTimer)
    this.volatileSessionCaptureTimer = null
  }

  /** Drain a bounded prefix; budget checks happen only between candidates. */
  async drainVolatileCaptureSlice(budget: VolatileSliceBudget = {}): Promise<VolatileSliceResult> {
    const startedAt = performance.now()
    const clock = budget.now ?? (() => performance.now())
    const budgetStartedAt = clock()
    const maxItems = budget.maxItems ?? SessionRepository.VOLATILE_SLICE_MAX_ITEMS
    const maxCpuMs = budget.maxCpuMs ?? SessionRepository.VOLATILE_SLICE_MAX_CPU_MS
    const pending: [SessionId, PendingVolatileState][] = []
    try {
      for (const entry of this.pendingVolatileSessions) {
        if (pending.length >= maxItems) break
        if (pending.length > 0 && clock() - budgetStartedAt >= maxCpuMs) break
        pending.push(entry)
      }
      const changes = await this.captureVolatileEntries(pending)
      const remaining = this.pendingVolatileSessions.size
      log.debug('drained volatile session capture slice', {
        candidates: pending.length,
        captured: changes.filter((change) => change.entity === 'session').length,
        remaining,
      })
      return { changes, remaining }
    } finally {
      perf.record('phase', 'volatileCapture.slice', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  private async captureVolatileEntries(
    pending: readonly [SessionId, PendingVolatileState][],
  ): Promise<MetadataChange[]> {
    if (pending.length === 0) return []
    const issueRelevant = pending.some(([, state]) => state.issueRelevant)
    const candidates = pending.flatMap(([id]) => {
      const session = this.sessions.get(id)
      return session ? [session] : []
    })
    const pass = await this.view.buildProjectionPass(candidates)
    const specs: EntityChangeSpec[] = []
    for (const [sessionId] of pending) {
      const session = this.sessions.get(sessionId)
      if (!session) continue
      specs.push({
        entity: 'session',
        id: sessionId,
        op: 'upsert',
        value: await this.view.wire(session, pass),
      })
    }
    try {
      const changes = await this.captureSessionSpecs(specs, issueRelevant)
      // A volatile A→B→A batch legitimately dedups to no durable patch, but it
      // still invalidates the legacy snapshot pipeline once. Do not fabricate a
      // projection event: patch consumers need only the captured final truth.
      if (!changes.some((change) => change.entity === 'session')) {
        this.sessionsGeneration_++
      }
      for (const [sessionId, pendingState] of pending) {
        const session = this.sessions.get(sessionId)
        if (session) this.commitDurableBaseline(sessionId, session.captureDurableState())
        if (this.pendingVolatileSessions.get(sessionId)?.version === pendingState.version) {
          this.pendingVolatileSessions.delete(sessionId)
        }
      }
      return changes
    } catch (err) {
      const oldestEnqueuedAt = Math.min(...pending.map(([, state]) => state.enqueuedAt))
      perf.record('phase', 'volatileCapture.retry', 0, DEPLOYMENT)
      log.warn('volatile session capture slice failed', {
        sliceSize: pending.length,
        pendingCount: this.pendingVolatileSessions.size,
        oldestPendingAgeMs: Math.max(0, this.now() - oldestEnqueuedAt),
        err,
      })
      this.scheduleVolatileSessionCapture(SessionRepository.VOLATILE_CAPTURE_RETRY_MS)
      throw err
    }
  }

  /**
   * Install a durable snapshot as the session's new baseline — after the commit
   * that made it durable, which is NOT always the commit that just returned
   * [POD-3361]. With a span open the snapshot is staged and promoted by the
   * outermost commit; with none open this is the outermost commit, so it
   * installs at once, which is where it happens today.
   */
  private commitDurableBaseline(sessionId: SessionId, state: SessionDurableState): void {
    // One call. The overlay decides whether a span is open, stages or installs
    // accordingly, registers the promotion, and drops what a rollback left — the
    // four things this method used to do in order, and the ones the two other
    // copies of this layer each got slightly differently [POD-3366].
    this.stagedSessionStates.set(sessionId, state)
  }

  /** The durable baseline this session would be rolled back to: the staged
   *  state if this span installed one, else the committed one. */
  private durableBaselineFor(sessionId: SessionId): SessionDurableState | undefined {
    return (
      this.stagedSessionStates.peek(sessionId)?.value ?? this.capturedSessionStates.get(sessionId)
    )
  }

  /** The committed durable baseline for a session, for tests and diagnostics.
   *  Reads the staged layer for the reason the field's doc gives. */
  committedDurableState(sessionId: SessionId): SessionDurableState | undefined {
    return this.durableBaselineFor(sessionId)
  }

  /** Async dispose/test barrier: drain the complete pending set. */
  async flushVolatileSessionCaptures(): Promise<MetadataChange[]> {
    const startedAt = performance.now()
    this.clearVolatileSessionCaptureTimer()
    try {
      return await this.captureVolatileEntries([...this.pendingVolatileSessions])
    } finally {
      perf.record('phase', 'volatileCapture.barrier', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /** Central volatile Session-view mutation seam. The latest value is captured
   * once per session by the coalesced broadcast flush, keeping interaction paths
   * free of synchronous SQLite writes [spec:SP-c29e]. */
  mutateSessionView(
    sessionId: SessionId,
    mutate: (session: Session) => void,
    issueRelevant = true,
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    mutate(session)
    this.markVolatileSessionDirty(sessionId, undefined, issueRelevant)
    return true
  }

  /** Rare birth-ref repairs declare affected session rows inside the issue
   * repair's commit. Reattached sessions still follow their birth issue. */
  async captureReferenceChanges(issueIds: readonly IssueId[]): Promise<void> {
    const affected = new Set(issueIds)
    const sessions = [...this.sessions.values()].filter(
      (session) => session.refIssueId && affected.has(session.refIssueId),
    )
    if (sessions.length === 0) return
    const pass = await this.view.buildProjectionPass(sessions)
    await this.ports.ledger.capture(
      sessions.map((session) => ({
        entity: 'session',
        id: session.sessionId,
        op: 'upsert',
        value: this.view.wire(session, pass),
      })),
    )
  }


  /**
   * Queue one session's durable writes so a sibling cannot cut or persist
   * against a snapshot the previous sibling has not yet installed [POD-3720].
   * Re-entrant for the same session: a nested write from inside a commit hook
   * (the state-model fixture, and any additionalWrite that itself persists)
   * proceeds immediately rather than waiting on its own tail.
   */
  private enqueueSessionWrite<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    return this.enqueueSessionsWrite([sessionId], fn)
  }

  /**
   * {@link enqueueSessionWrite} for several sessions at once [POD-6175]: `fn`
   * runs once every one of them has had its earlier writes, and every later
   * write to any of them waits for `fn`. All the tails are taken in one
   * synchronous step, so two such calls cannot each hold half of the other's
   * sessions.
   *
   * A session the calling write already holds is neither waited for nor
   * re-queued: its tail is the caller's own, so waiting on it would wait on
   * itself, and replacing it would let a later writer start before the caller
   * finishes. The nested write's scope keeps the caller's sessions for the
   * same reason, so a write nested inside it re-enters rather than waiting.
   */
  private enqueueSessionsWrite<T>(sessionIds: readonly SessionId[], fn: () => Promise<T>): Promise<T> {
    const held = this.sessionWriteScope.getStore()
    const queued = held ? sessionIds.filter((id) => !held.has(id)) : sessionIds
    if (queued.length === 0) return fn()
    const scope: ReadonlySet<SessionId> = new Set([...(held ?? []), ...sessionIds])
    const tails = queued.map((id) => this.sessionWriteTail.get(id) ?? Promise.resolve())
    // One session waits on its tail itself, so the common path keeps its timing.
    const prev = tails.length === 1 ? tails[0]! : Promise.all(tails)
    const run = prev.then(
      () => this.sessionWriteScope.run(scope, fn),
      () => this.sessionWriteScope.run(scope, fn),
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    for (const id of queued) this.sessionWriteTail.set(id, settled)
    // DRAIN THE TAIL WHEN IT IS THIS WRITE'S. Every other per-session map here
    // is dropped when the session is removed; this one is keyed by every session
    // ever written and would otherwise hold an entry for the process's life.
    //
    // The identity check is what makes draining safe, and it takes THREE writers
    // to observe: if a sibling has already queued behind us it has overwritten
    // the entry, so an unconditional delete clears ITS tail and a third writer
    // finds none and runs concurrently with it. Two-writer cases cannot see
    // that — `still serializes a third write arriving after the first drains
    // its tail` is the one that goes red.
    void settled.then(() => {
      for (const id of queued) {
        if (this.sessionWriteTail.get(id) === settled) this.sessionWriteTail.delete(id)
      }
    })
    return run
  }

  private resolvePersistedDraft(session: Session, draft: SessionDurableState): SessionDurableState {
    const origin = this.draftOrigins.get(draft)
    if (!origin) return draft
    return overlayChangedDurableFields(origin, draft, session.captureDurableState())
  }

  /**
   * THE session write seam ([spec:SP-3fe2] #256): every persist commits the
   * row write and its declared session change through the write-seam Ledger —
   * one transact span, so "the row changed" and "the change log says so"
   * commit or roll back together. All ~15 persisting handlers inherit this,
   * including the ones that persist WITHOUT a session broadcast (agentState,
   * title, derived-title, flushActivity): their persisted truth reaches the
   * change log at write time instead of leaking until the next full broadcast.
   *
   * Change volume: the per-frame path never lands here (frames only mark
   * activityDirty; flushActivity persists on a 12s tick), and the ledger's
   * byte-dedup drops persists whose WIRE meta didn't change — notably the
   * frequent counter-only flushes, whose lastOutputAt/lastInputAt live in the
   * row but not in SessionMeta. lastActiveAt IS wire-visible and deliberately
   * NOT projected away (unlike the conversation projection): it advances only
   * on semantic activity (agentState transitions, shell busy flips) and is the
   * authoritative recency delta clients order the sidebar by.
   */
  async persist(
    session: Session,
    additionalWrite: () => void | Promise<void> = async () => {},
    additionalChanges: () => Promise<EntityChangeSpec[]> = async () => [],
  ): Promise<void> {
    // NOTHING DURABLE CHANGED, so the draft is the live state [POD-3330]. This
    // is the write the activity flush, the volatile sweep and the boot install
    // make: they advance the live half (or nothing at all) and want the row
    // restated. A write that CHANGES a durable field goes through {@link write}
    // instead, so that its change is never on the shared object before it is
    // committed. Same body, same commit tail — the difference is only where the
    // fields being written came from.
    //
    // Capture INSIDE the per-session queue [POD-3720]: a persist that sampled
    // live state before a sibling write installed would restate the previous
    // snapshot and clobber it.
    await this.enqueueSessionWrite(session.sessionId, () =>
      this.persistDraftUnlocked(
        session,
        session.captureDurableState(),
        additionalWrite,
        additionalChanges,
      ),
    )
  }

  /**
   * A DRAFT OF THE DURABLE HALF [POD-3330], cut from the live object.
   *
   * The session-side twin of `IssueRegistry.draft`. The bag is a copy, so the
   * caller's assignments are invisible to every other reader — including a
   * second writer that commits inside this one's span, which used to capture
   * this writer's uncommitted fields off the shared object and make them
   * durable. Cut it, mutate it, persist it, and do not let it outlive a
   * suspension it will be persisted after (spec rule 26).
   *
   * The shallow origin recorded here is what {@link persistDraft} uses to tell
   * a field this writer changed from one it merely copied [POD-3720].
   */
  draft(session: Session): SessionDurableState {
    const draft = session.captureDurableState()
    this.draftOrigins.set(draft, { ...draft })
    return draft
  }

  /**
   * THE session mutation seam [POD-3330]: mutate a DRAFT, commit it, install it.
   *
   * `mutate` runs against a copy of the durable half and may return an extra
   * write to land inside the same transaction (the shape `persist` already
   * had). Nothing it assigns reaches the live `Session` until the commit
   * returns, so a reader in the window sees only committed state and a failed
   * commit has nothing to undo.
   *
   * Cut, mutate and persist share one per-session turn [POD-3720] so a sibling
   * `write` sees this install rather than the snapshot it was cut from.
   */
  async write(
    session: Session,
    mutate: (draft: SessionDurableState) => void | (() => void | Promise<void>),
    additionalWrite: () => void | Promise<void> = async () => {},
  ): Promise<void> {
    await this.enqueueSessionWrite(session.sessionId, async () => {
      const draft = this.draft(session)
      const extra = mutate(draft)
      await this.persistDraftUnlocked(session, draft, extra ?? additionalWrite)
    })
  }

  /** {@link write} for a draft the caller already holds. */
  async persistDraft(
    session: Session,
    draft: SessionDurableState,
    additionalWrite: () => void | Promise<void> = async () => {},
  ): Promise<void> {
    await this.enqueueSessionWrite(session.sessionId, () =>
      this.persistDraftUnlocked(session, draft, additionalWrite),
    )
  }

  /** {@link persistDraft} once this session's write turn is held. */
  private async persistDraftUnlocked(
    session: Session,
    draft: SessionDurableState,
    additionalWrite: () => void | Promise<void> = async () => {},
    additionalChanges: () => Promise<EntityChangeSpec[]> = async () => [],
  ): Promise<void> {
    await this.persistDraftsUnlocked([{ session, draft }], additionalWrite, additionalChanges)
  }

  /**
   * {@link persistDraftUnlocked} for several sessions in ONE commit [POD-6175]:
   * one row write for all of them, one projection pass and one change append,
   * with the changes in the order of `entries`. Every session's write turn must
   * be held. The commit is all or nothing. A failed one-session write restores
   * its session; a failed batch leaves every session as it was, for its caller
   * to retry one session at a time (see {@link persistBatch}), where each
   * failure restores its own session.
   */
  private async persistDraftsUnlocked(
    entries: readonly { session: Session; draft: SessionDurableState }[],
    additionalWrite: () => void | Promise<void> = async () => {},
    additionalChanges: () => Promise<EntityChangeSpec[]> = async () => [],
  ): Promise<void> {
    if (entries.length === 0) return
    const pending = entries.map(({ session }) => this.pendingVolatileSessions.get(session.sessionId))
    // THE DRAFT IS WHAT THIS WRITE PERSISTS [POD-3259, POD-3330], overlayed
    // onto live for fields it did not change [POD-3720]. The row and the
    // declared change are projected from that resolved bag rather than from
    // the live object, so the write describes what its caller asked for and
    // nothing a concurrent writer left on the shared session — and also
    // nothing a concurrent writer committed that this draft merely copied.
    // It becomes the committed baseline once the commit returns: re-reading
    // the live object afterwards would bake whatever changed DURING the write
    // into the baseline, and the next rollback would restore a state no commit
    // ever saw.
    const installedVersion = this.volatileSessionMutationVersion
    let toPersist = entries.map(({ draft }) => draft)
    let changes: MetadataChange[]
    try {
      const committed = await this.ports.ledger.commit({
        write: async () => {
          await additionalWrite()
          // AFTER additionalWrite: D-txn sites assign into `draft` inside the
          // span. AFTER the previous sibling has installed, because this body
          // runs on the per-session turn [POD-3720].
          toPersist = entries.map(({ session, draft }) => this.resolvePersistedDraft(session, draft))
          const rows = entries.map(({ session }, index) => session.toRow(toPersist[index]!))
          if (rows.length === 1) await this.store.sessions.upsertSession(rows[0]!)
          else await this.store.sessions.upsertSessions(rows)
        },
        changes: async () => {
          const extra = await additionalChanges()
          const pass = await this.view.buildProjectionPass(
            entries.map(({ session }, index) => ({ ...toPersist[index]!, sessionId: session.sessionId })),
          )
          const specs = [...extra]
          for (const [index, { session }] of entries.entries()) {
            specs.push({
              entity: 'session',
              id: session.sessionId,
              op: 'upsert',
              value: await this.view.wire(session, pass, toPersist[index]),
            })
          }
          return specs
        },
      })
      changes = committed.changes
    } catch (err) {
      // A batch restores nothing: one bad row fails the whole commit, and the
      // retry of each session on its own decides which session it was.
      if (entries.length > 1) throw err
      entries.forEach(({ session }, index) => {
        const captured = this.durableBaselineFor(session.sessionId)
        // The LATEST committed baseline, deliberately — see the field's doc for
        // why a version-pinned refusal is the wrong answer here. The live
        // terminal half survives this either way. A drafted write has nothing of
        // its own to undo (that is the point of the draft); what this restores
        // is the state of a live object that some OTHER path left ahead of the
        // durable row.
        if (captured) session.restoreDurableState(captured, pending[index]?.preserve)
        else this.sessions.delete(session.sessionId)
      })
      throw err
    }
    entries.forEach(({ session }, index) => {
      const inherited = pending[index]
      if (
        inherited !== undefined &&
        this.pendingVolatileSessions.get(session.sessionId)?.version === inherited.version
      ) {
        this.pendingVolatileSessions.delete(session.sessionId)
        if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
      }
      // INSTALL THE DRAFT ON THE LIVE OBJECT, now that it is durable — the
      // write's fields become visible in memory at the same moment they become
      // visible in the row, and not one statement earlier.
      //
      // THE PRESERVE SET IS THE VOLATILE WORK THAT LANDED DURING THIS WRITE, not
      // the pending entry this write inherited. A sweep that marked `status` or
      // `machineId` dirty while the commit was in flight knows something newer
      // than this draft about those four fields, so it keeps them; everything
      // this write changed is installed regardless, because the draft was cut
      // from the same live object one statement before the commit. Nothing
      // suspends today, so the version cannot move and this installs the whole
      // draft — which is exactly what assigning onto the live object did before.
      const raced = this.pendingVolatileSessions.get(session.sessionId)
      const persisted = toPersist[index]!
      // The live object still holds the previous committed routing fields.
      if (persisted.issueId !== session.issueId || persisted.cwd !== session.cwd) {
        this.ports.onRoutingChanged?.(session.sessionId, {
          ...(session.issueId ? { issueId: session.issueId } : {}),
          cwd: session.cwd,
        })
      }
      session.installDurableState(
        persisted,
        raced !== undefined && raced.version > installedVersion ? raced.preserve : undefined,
      )
      this.commitDurableBaseline(session.sessionId, persisted)
    })
    this.publishSessionProjection(changes)
  }

  /**
   * {@link persist} for every session in `sessions` in ONE commit [POD-6175]:
   * the activity flush's write, which restates the live state of each busy
   * session. It takes every session's write turn at once, so it waits for
   * each one's earlier writes and every later write to any of them waits for
   * it. `sessions` must not repeat a session.
   *
   * ONE BAD ROW MUST NOT STALL THE OTHERS. When the batched commit fails, each
   * session is written again on its own, so only the session that cannot be
   * written stays unwritten; it would otherwise fail every tick for every
   * session. Returns the sessions that failed, with their errors.
   */
  async persistBatch(sessions: readonly Session[]): Promise<Map<SessionId, unknown>> {
    const failed = new Map<SessionId, unknown>()
    if (sessions.length === 0) return failed
    try {
      await this.enqueueSessionsWrite(
        sessions.map((session) => session.sessionId),
        () =>
          this.persistDraftsUnlocked(
            sessions.map((session) => ({ session, draft: session.captureDurableState() })),
          ),
      )
      return failed
    } catch (err) {
      // One session is already the one-session write; retrying would only
      // repeat it.
      if (sessions.length === 1) {
        failed.set(sessions[0]!.sessionId, err)
        return failed
      }
      log.warn('batched session write failed; writing each session on its own', {
        sessions: sessions.length,
        err,
      })
    }
    for (const session of sessions) {
      try {
        await this.persist(session)
      } catch (err) {
        log.error('session write failed', { sessionId: session.sessionId, err })
        failed.set(session.sessionId, err)
      }
    }
    return failed
  }

  /** Persist activity only while this store can accept synchronous writes. */
  /** Persist activity unless the physical transfer fence is up.
   *  Async because `persist` is: a bare call here would drop the write
   *  silently, which is exactly what the branch merge would have shipped. */
  async persistActivityIfWritable(session: Session): Promise<boolean> {
    if (this.store.transferFenceActive) return false
    await this.persist(session)
    return true
  }

  /**
   * Drain only the IDs dirty at entry; newer activity stays queued for the next
   * tick. Every busy session is written in one commit [POD-6175], so the tick
   * costs the same statements however many sessions printed output. A session
   * that cannot be written stays dirty for the next tick, the others are
   * written, and the flush rejects with the first failure.
   */
  async flushActivity(): Promise<void> {
    if (this.flushingActivity) return
    this.flushingActivity = true
    try {
      const due: { session: Session; version: number | undefined }[] = []
      for (const sessionId of [...this.dirtyActivitySessions.keys()]) {
        const session = this.sessions.get(sessionId)
        if (!session || !session.terminal.activityDirty) {
          this.dirtyActivitySessions.delete(sessionId)
          continue
        }
        due.push({ session, version: this.dirtyActivitySessions.get(sessionId) })
      }
      if (due.length === 0 || this.store.transferFenceActive) return
      const failed = await this.persistBatch(due.map(({ session }) => session))
      for (const { session, version } of due) {
        if (failed.has(session.sessionId)) continue
        if (this.dirtyActivitySessions.get(session.sessionId) === version) {
          session.terminal.clearActivityDirty()
          this.dirtyActivitySessions.delete(session.sessionId)
        }
      }
      if (failed.size > 0) throw failed.values().next().value
    } finally {
      this.flushingActivity = false
    }
  }

  /** Materialize one persisted row without exposing it until the caller installs it.
   *  Restored tombstones always come back as exited: deletion killed their runtime,
   *  so retaining a prior live/starting status would claim a PTY that no longer exists. */
  async sessionFromStoredRow(r: SessionRow, mode: 'boot' | 'restore', hasRuntimeTranscript = true): Promise<Session | null> {
    const init = storedSessionInit(
      r,
      mode,
      r.ownerUserId ?? (await firstAdminMemberId(this.store)),
    )
    if (!init) {
      log.warn('skipping a persisted session with an invalid agentKind', {
        sessionId: r.id,
        agentKind: r.agentKind,
      })
      return null
    }
    if (r.originKind === 'resume' && !r.conversationId) {
      log.warn('a persisted resume session has no conversationId', { sessionId: r.id })
    }
    const machineId = r.machineId
    let session!: Session
    session = new Session({
      ...init,
      toDaemon: (msg) => this.toMachine(this.sessions.get(r.id)?.machineId ?? machineId, msg),
      sendInput: (input) =>
        this.ports.toPtyInput(this.sessions.get(r.id)?.machineId ?? machineId, input),
      onActivity: () => {
        void this.persistActivityIfWritable(session)
          .then((written) => {
            if (written) this.broadcastSessions()
          })
          .catch((error) =>
            log.error('failed to persist restored session activity', {
              sessionId: session.sessionId,
              error,
            }),
          )
      },
    })
    // Re-seed runtime-backed transcript items before the session reaches clients.
    // Terminal drivers use this durable bridge when the legacy observation path
    // is fenced; provider-file deltas can still overlap and upsert by cursor/id.
    const events = hasRuntimeTranscript
      ? await this.ports.store?.events.listRuntimeTranscriptEvents(session.sessionId) ?? []
      : []
    const lastReset = events.findLastIndex((event) => event.t === 'transcript-reset')
    const items = events.slice(Math.max(0, lastReset)).flatMap(
      (event) => runtimeTranscriptDeltaFromEvent(event)?.items ?? [],
    )
    if (items.length > 0 || lastReset >= 0) {
      session.terminal.applyRuntimeDelta(items, { reset: lastReset >= 0 })
    }
    return session
  }

  /** Prepare off-row reads without exposing a partially installed runtime. */
  async prepareStoredSessionInstall(
    session: Session,
    offers: Awaited<ReturnType<SessionStore['sessions']['listOffers']>>,
  ): Promise<{ write(): Promise<void>; apply(): void }> {
    const offer = offers[session.sessionId]
    const staleOffer = !!offer && session.terminal.lastInputAtMs > Date.parse(offer.createdAt)
    session.offer = staleOffer ? undefined : offer
    if (session.resume?.value) {
      session.conversationPodiumId = await this.ports.memory.conversationPodiumId(
        { kind: 'system', id: 'session-boot-reconcile' },
        session.machineId,
        session.resume.value,
      )
    }
    return {
      write: async () => {
        if (staleOffer) await this.store.sessions.clearOffer(session.sessionId)
      },
      apply: () => {
        this.registerSession(session)
        this.state.installSession(session.sessionId)
        this.commitDurableBaseline(session.sessionId, session.captureDurableState())
      },
    }
  }

  async installStoredSession(
    session: Session,
    offers: Awaited<ReturnType<SessionStore['sessions']['listOffers']>>,
  ): Promise<void> {
    const install = await this.prepareStoredSessionInstall(session, offers)
    await install.write()
    install.apply()
  }

  async loadFromStore(): Promise<void> {
    const recoveryStarted = performance.now()
    const checkpoints = await this.store.observationCheckpoints.checkpointsOfLiveSessions()

    // Shared draft documents hydrate here; viewer rows remain lazy per principal.
    this.state.setDraftSyncEnabled(
      isFeatureEnabled('draft-sync', await this.store.settings.getSettings()),
    )
    await this.state.loadFromStore()
    bootStage('sessions draft hydration', recoveryStarted)
    const rowsStarted = performance.now()
    const offers = await this.store.sessions.listOffers() // [spec:SP-c7f1]
    let rowReadMs = 0
    let installMs = 0
    const runtimeSessions = await this.store.events.runtimeTranscriptSessionIds()
    const storedRows = await this.store.sessions.loadSessions()
    for (const r of storedRows) {
      let rowStarted = performance.now()
      const session = await this.sessionFromStoredRow(r, 'boot', runtimeSessions.has(r.id))
      rowReadMs += performance.now() - rowStarted
      rowStarted = performance.now()
      if (!session) continue
      await this.installStoredSession(session, offers)
      installMs += performance.now() - rowStarted
      const checkpoint = checkpoints.get(r.id)
      if (checkpoint) {
        session.applyObservationCheckpoint(checkpoint)
        // Only the current state of a durably accepted LIVE cursor may restore
        // retry behavior. Bootstrap/replay snapshots can remain visibly errored,
        // but must never create effects merely because the server restarted.
        if (
          checkpoint.lastAcceptedLiveCursor !== null &&
          JSON.stringify(checkpoint.providerCursor) ===
            JSON.stringify(checkpoint.lastAcceptedLiveCursor) &&
          checkpoint.turnState.phase === 'errored' &&
          checkpoint.turnState.error?.retryable === true
        ) {
          this.autoContinue.onSessionRestored(session.sessionId, checkpoint.turnState)
        }
      }
      if (r.status !== session.status) await this.persist(session)
    }
    log.info('boot session recovery breakdown', { sessions: storedRows.length, rowReadMs, installMs })
    bootStage('sessions row recovery', rowsStarted)
    const baselineStarted = performance.now()
    // One-shot boot backfill (#474): name pre-upgrade historical sessions at a
    // deliberate point instead of burst-allocating inside the first listSessions.
    // loadSessions returns created_at order, so allocation is deterministic; the
    // loop is a no-op once every session carries a ref.
    for (const session of this.sessions.values()) {
      // Against the DRAFT [POD-3330]: the allocation assigns the ref inside the
      // transaction, so it has to assign into the state `toRow` reads.
      const draft = this.draft(session)
      const additionalWrite = await this.view.prepareRefAllocation(draft)
      if (additionalWrite) await this.persistDraft(session, draft, additionalWrite)
    }
    // Queued rows survive a restart (that's their point) and are counted from
    // the table; delivery re-arms when the daemon reattaches and the sessions
    // bind. Only a queue whose session is gone is dropped.
    for (const sessionId of (await this.store.sync.queuedMessageCounts()).keys()) {
      if (!this.sessions.has(sessionId)) await this.store.sync.deleteQueuedMessagesForSession(sessionId)
    }
    await this.store.sync.pruneAppliedMutations({
      maxAgeMs: this.ports.appliedMutationMaxAgeMs,
      now: this.now(),
    })
    // Boot reconciliation ([spec:SP-3fe2] #256): diff the restored full truth
    // against the ledger baseline — INCLUDING removes (rows deleted or
    // quarantined while the server was down) — so a cursor-holding client that
    // reconnects heals via changesSince instead of silently missing the gap.
    // No fan-out: there are no clients at boot. Conversations are deliberately
    // NOT reconciled at boot: they are daemon-fed, and an empty list at boot
    // means "not scanned yet", not "all gone".
    // Boot ordering (#247), SETTLED by POD-318: rows carry a real machine id before
    // this runs. `SessionStore` folds any pre-POD-318 sentinel rows onto this host's
    // minted id as it OPENS — ahead of this reconcile, and ahead of the registry that
    // calls it — so there is no stale machine baseline here to be captured later.
    const sessions = await this.listSessionsForBootBaseline()
    const recovered = await this.ports.ledger.reconcile(
      'session',
      sessions.map((s) => ({ id: s.sessionId, value: s })),
    )
    // Explicit cleared records must survive a restart: the source tables use
    // absence for never-read/no-snooze, while replica absence means not loaded.
    const activeUsers = new Set(
      (await this.store.users.list()).filter((user) => !user.disabledAt).map((user) => user.id),
    )
    const markers = new Map<string, SessionUserStateWire>()
    for (const value of await this.store.sessions.listSessionUserStateRows(undefined, this.now())) {
      if (this.sessions.has(value.sessionId) && activeUsers.has(value.userId))
        markers.set(sessionUserStateRowId(value.userId, value.sessionId), value)
    }
    for (const prior of ((await this.ports.ledger.authority?.snapshot('sessionUserState')) ??
      []) as SessionUserStateWire[]) {
      const id = sessionUserStateRowId(prior.userId, prior.sessionId)
      if (!markers.has(id) && this.sessions.has(prior.sessionId) && activeUsers.has(prior.userId))
        markers.set(id, { userId: prior.userId, sessionId: prior.sessionId, readAt: null })
    }
    await this.ports.ledger.reconcile(
      'sessionUserState',
      [...markers].map(([id, value]) => ({ id, value })),
    )
    this.publishSessionProjection(recovered)
    bootStage('sessions baseline', baselineStarted)
  }

  /**
   * NOTHING ABOUT THIS SESSION STILL WAITS TO REACH ITS ROW (POD-6160): no write
   * queued or in flight, no baseline staged against an open span, no volatile
   * capture and no activity flush pending. A durable record read now is what
   * the object holds.
   */
  settled(sessionId: SessionId): boolean {
    return (
      !this.sessionWriteTail.has(sessionId) &&
      !this.pendingVolatileSessions.has(sessionId) &&
      !this.dirtyActivitySessions.has(sessionId) &&
      this.stagedSessionStates.peek(sessionId) === undefined
    )
  }

  forget(sessionId: SessionId): void {
    this.pendingVolatileSessions.delete(sessionId)
    this.capturedSessionStates.delete(sessionId)
    // Memory-only, and the staged layer goes with it: this drops a session from
    // the process, so a baseline still waiting for a commit has nothing left to
    // be the baseline OF [POD-3361]. Staged as a REMOVAL, which is how the
    // overlay spells "gone" — the in-window readers see it absent, exactly as
    // the splice this replaced made them, and the promotion's delete is a no-op
    // against the line above.
    if (this.stagedSessionStates.peek(sessionId)) this.stagedSessionStates.set(sessionId, undefined)
    if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
  }
}
