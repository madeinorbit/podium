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
import { applyRuntimeTurnStateTo, markConversationBound, storedSessionInit } from './session-record'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'
import { isResident, type SessionRecordReads, type SessionSubject } from './records'
import { type SessionView, wireRecord } from './view'
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
  /** Sessions read by a durable key, parked ones from the database (POD-6160). */
  records?: Pick<SessionRecordReads, 'referencingIssues'>
  /** Run `fn` with a session resident, restored from its row when parked. */
  withSession?<T>(sessionId: SessionId, reason: string, fn: (session: Session | undefined) => Promise<T>): Promise<T>
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
  /**
   * THE LIVE OBJECT'S INSTALLS INSIDE AN OPEN SPAN (POD-6160 D2f), per session,
   * each with the commit registration that says whether its span will commit
   * and the durable fields it changed.
   *
   * A persist installs its draft on the live `Session` as soon as its write
   * returns, also inside an enclosing span, because code later in the same span
   * reads the session's fields. The baseline waits for the outermost commit
   * (above); the live object cannot, and the executor has no abort hook. So a
   * span that rolled back used to leave its fields on the live object, and the
   * next unrelated persist cut its draft from there and wrote them back.
   *
   * {@link repairRolledBack} finds an install whose span rolled back (its
   * registration is dead) and puts the fields it changed back to the committed
   * baseline, keeping volatile fields that changed since. It runs, cheaply,
   * wherever a session's durable fields are read for someone outside the span:
   * a draft or persist, `settled()`, and every projection (`Session.toMeta`, its
   * facts, the daemon RPC view), which reach it through the session's
   * `freshenDurable` hook. A commit drops the entry.
   */
  /** Restored parked sessions whose transcript has not been replayed yet. */
  private readonly unreplayedTranscripts = new Set<SessionId>()
  private readonly replayingTranscripts = new Map<SessionId, Promise<void>>()
  private readonly liveInstalls = new Map<
    SessionId,
    { registration: ReturnType<BaselineFoldPort['onCommit']>; fields: readonly (keyof SessionDurableState)[] }[]
  >()
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
    session.setDurableRepair(() => this.repairRolledBack(session))
  }

  /**
   * Put back what a rolled-back span installed on this live session (see
   * {@link liveInstalls}). A no-op unless one of its in-span installs belongs to
   * a span that will not commit.
   */
  repairRolledBack(session: Session): void {
    const installs = this.liveInstalls.get(session.sessionId)
    if (!installs || installs.every((install) => install.registration.live())) return
    const dead = installs.filter((install) => !install.registration.live())
    const alive = installs.filter((install) => install.registration.live())
    if (alive.length > 0) this.liveInstalls.set(session.sessionId, alive)
    else this.liveInstalls.delete(session.sessionId)
    // The baseline the rollback left: what the surviving spans staged, else the
    // committed one (the overlay dropped the dead span's own staging).
    const baseline = this.durableBaselineFor(session.sessionId)
    if (!baseline) return
    const fields = new Set(dead.flatMap((install) => install.fields))
    const repaired = { ...session.captureDurableState() } as Record<string, unknown>
    for (const field of fields) repaired[field] = (baseline as unknown as Record<string, unknown>)[field]
    session.restoreDurableState(
      repaired as unknown as SessionDurableState,
      this.pendingVolatileSessions.get(session.sessionId)?.preserve,
    )
    log.info('repaired the fields a rolled-back span installed on a live session', {
      sessionId: session.sessionId,
      fields: [...fields],
    })
  }

  /** Remember an install made inside an open span (see {@link liveInstalls}). */
  private trackLiveInstall(
    sessionId: SessionId,
    before: SessionDurableState | undefined,
    installed: SessionDurableState,
    preserved: ReadonlySet<string> | undefined,
  ): void {
    const fold = this.ports.applyCommit
    if (!fold?.spanOpen()) return
    const fields = (Object.keys(installed) as (keyof SessionDurableState)[]).filter(
      (field) =>
        !preserved?.has(field) && JSON.stringify(installed[field]) !== JSON.stringify(before?.[field]),
    )
    if (fields.length === 0) return
    const entry = {
      registration: undefined as unknown as ReturnType<BaselineFoldPort['onCommit']>,
      fields,
    }
    entry.registration = fold.onCommit(() => {
      const installs = this.liveInstalls.get(sessionId)
      const rest = installs?.filter((install) => install !== entry) ?? []
      if (rest.length > 0) this.liveInstalls.set(sessionId, rest)
      else this.liveInstalls.delete(sessionId)
    }, 'session-live-install')
    this.liveInstalls.set(sessionId, [...(this.liveInstalls.get(sessionId) ?? []), entry])
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
    // The sessions whose birth ref names one of these issues, parked ones read
    // from the database (POD-6160).
    const sessions: SessionSubject[] = this.ports.records
      ? await this.ports.records.referencingIssues(issueIds, 'captureReferenceChanges')
      : [...this.sessions.values()].filter((session) => session.refIssueId && affected.has(session.refIssueId))
    if (sessions.length === 0) return
    const pass = await this.view.buildProjectionPass(sessions)
    await this.ports.ledger.capture(
      sessions.map((session) => ({
        entity: 'session',
        id: session.sessionId,
        op: 'upsert',
        value: isResident(session) ? this.view.wire(session, pass) : wireRecord(session, pass),
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
    await this.enqueueSessionWrite(session.sessionId, () => {
      this.repairRolledBack(session)
      return this.persistDraftUnlocked(
        session,
        session.captureDurableState(),
        additionalWrite,
        additionalChanges,
      )
    })
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
    this.repairRolledBack(session)
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
      const preserved = raced !== undefined && raced.version > installedVersion ? raced.preserve : undefined
      this.trackLiveInstall(session.sessionId, this.durableBaselineFor(session.sessionId), persisted, preserved)
      session.installDurableState(persisted, preserved)
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
    if (hasRuntimeTranscript) await this.replayRuntimeTranscript(session)
    return session
  }

  /** Apply a session's stored runtime transcript items to its terminal. */
  private async replayRuntimeTranscript(session: Session): Promise<void> {
    const events = (await this.ports.store?.events.listRuntimeTranscriptEvents(session.sessionId)) ?? []
    const lastReset = events.findLastIndex((event) => event.t === 'transcript-reset')
    const items = events.slice(Math.max(0, lastReset)).flatMap(
      (event) => runtimeTranscriptDeltaFromEvent(event)?.items ?? [],
    )
    if (items.length > 0 || lastReset >= 0) {
      session.terminal.applyRuntimeDelta(items, { reset: lastReset >= 0 })
    }
  }

  /**
   * THE TRANSCRIPT OF A RESTORED PARKED SESSION, REPLAYED ON FIRST USE (POD-6160).
   * A lease restores a parked session for whatever it does (a rename, a read
   * marker, a kill), and most of that never looks at its transcript, which can
   * be thousands of stored events. So the restore records only whether there is
   * a transcript (one indexed read, the availability its record carries), and
   * the items are replayed here the first time a reader needs them: a viewer
   * attaching or subscribing, a daemon RPC read, the prompt-title fallback.
   * Items that arrived since are in the stored log too, so the replay is the
   * whole transcript. Concurrent readers share one replay.
   */
  async ensureTranscript(session: Session): Promise<void> {
    const id = session.sessionId
    const running = this.replayingTranscripts.get(id)
    if (running) return await running
    if (!this.unreplayedTranscripts.has(id)) return
    const replay = (async () => {
      await this.replayRuntimeTranscript(session)
      this.unreplayedTranscripts.delete(id)
    })().finally(() => this.replayingTranscripts.delete(id))
    this.replayingTranscripts.set(id, replay)
    await replay
  }

  /** A transcript replay is in flight for this session. */
  replayingTranscript(sessionId: SessionId): boolean {
    return this.replayingTranscripts.has(sessionId)
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

  /**
   * RESTORE ONE PARKED SESSION FROM ITS ROW AND INSTALL IT (POD-6160 D2f): what
   * the boot load does for a row, with the satellites read for this session
   * alone, so the object a lease gets is the one a restart would have built
   * (and the one its durable record describes). It writes nothing: a stale
   * offer is not adopted (the boot load also clears its row; a record reads it
   * as absent either way), and a parked row's status is the one it restores.
   * A session that became resident while this read wins and is returned.
   */
  async materializeStoredSession(r: SessionRow): Promise<Session | undefined> {
    const ids = [r.id]
    const offers = await this.store.sessions.offersOf(ids)
    const checkpoint = (await this.store.observationCheckpoints.checkpointsOf(ids)).get(r.id)
    const turnState = (await this.store.events.runtimeTurnStatesOf(ids)).get(r.id)
    await this.state.stageDraftTimes(ids)
    const hasTranscript = (await this.store.events.runtimeTranscriptAvailableOf(ids)).has(r.id)
    // The transcript items wait for their first reader (ensureTranscript); its
    // availability is what the boot replay would have set.
    const session = await this.sessionFromStoredRow(r, 'boot', false)
    if (!session) return undefined
    if (hasTranscript) {
      session.transcriptAvailable = true
      session.terminal.setTranscriptAvailable(true)
      markConversationBound(session)
    }
    const install = await this.prepareStoredSessionInstall(session, offers)
    const raced = this.sessions.get(r.id)
    if (raced) return raced
    install.apply()
    if (hasTranscript) this.unreplayedTranscripts.add(r.id)
    if (checkpoint) session.applyObservationCheckpoint(checkpoint)
    if (turnState) applyRuntimeTurnStateTo(session, turnState)
    return session
  }

  /** Drop a resident session from the process (POD-6160 D2f): memory only. */
  evictResident(session: Session): void {
    if (this.sessions.get(session.sessionId) !== session) return
    session.terminal.setActivityDirtyListener(undefined)
    session.terminal.detachAll()
    this.sessions.delete(session.sessionId)
    this.dirtyActivitySessions.delete(session.sessionId)
    this.state.evictSession(session.sessionId)
    this.forget(session.sessionId)
  }

  /**
   * One-shot boot backfill (#474): name pre-upgrade historical sessions at a
   * deliberate point instead of burst-allocating inside the first listSessions.
   * The candidates are read in created_at, id order so allocation is
   * deterministic (POD-6160: from the table, not the map); a parked one is
   * restored only when it does get a ref.
   *
   * ONLY THE ROWS THAT CAN STILL GET A REF ARE READ (POD-6222). A ref-less row
   * gets one from an existing issue or from a cwd whose repo has a prefix; the
   * rest (sessions in removed worktrees, on another machine than the repo) never
   * do, and reading them on every boot grew with history. The candidates are a
   * superset (`ReposRepository.prefixedPlaces`), so each is still asked here.
   */
  async backfillBirthRefs(): Promise<void> {
    const places = await this.store.repos.prefixedPlaces()
    // Logged so a deployment shows whether the fallback ever runs.
    if (places === 'everywhere') log.info('boot ref backfill reads every ref-less session: a repo prefix no registered root explains')
    const candidates = places === 'everywhere'
      ? await this.store.sessions.sessionsWithoutRef()
      : await this.store.sessions.refBackfillCandidates(places)
    for (const row of candidates) {
      const probe = { refIssueId: null, refDraft: null, issueId: row.issueId ?? undefined, cwd: row.cwd, machineId: row.machineId }
      if (!(await this.view.prepareRefAllocation(probe as unknown as SessionDurableState))) continue
      const allocate = async (session: Session | undefined) => {
        if (!session) return
        // Against the DRAFT [POD-3330]: the allocation assigns the ref inside the
        // transaction, so it has to assign into the state `toRow` reads.
        const draft = this.draft(session)
        const additionalWrite = await this.view.prepareRefAllocation(draft)
        if (additionalWrite) await this.persistDraft(session, draft, additionalWrite)
      }
      const resident = this.sessions.get(row.id)
      if (resident || !this.ports.withSession) await allocate(resident)
      else await this.ports.withSession(row.id, 'bootRefBackfill', allocate)
    }
  }

  /**
   * BOOT RESTORES THE SESSIONS THAT RUN, AND NOTHING ELSE (POD-6160 D2g): the
   * rows whose status says a process runs or is expected back (and the headless
   * ones, which stay resident while their row exists), with their
   * satellites read for those rows alone. A stopped session stays its row
   * until something uses it (`residency.ts`); no draft and no per-user state is
   * loaded here.
   */
  async loadFromStore(): Promise<void> {
    const recoveryStarted = performance.now()
    // The running rows, and every headless one: a headless session is resident
    // for as long as its row exists (its thread is driven turn by turn, and a
    // failed establish, which marks it exited, is retried on machine attach).
    const running = await this.store.sessions.sessionsWithStatuses(['starting', 'live', 'reconnecting'])
    const runningIds = new Set(running.map((r) => r.id))
    const storedRows = [
      ...running,
      ...(await this.store.sessions.headlessSessions()).filter((r) => !runningIds.has(r.id)),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))
    const ids = storedRows.map((r) => r.id)
    const checkpoints = await this.store.observationCheckpoints.checkpointsOf(ids)

    // Shared draft documents hydrate here; viewer rows remain lazy per principal.
    this.state.setDraftSyncEnabled(
      isFeatureEnabled('draft-sync', await this.store.settings.getSettings()),
    )
    await this.state.loadFromStore()
    bootStage('sessions draft hydration', recoveryStarted)
    const rowsStarted = performance.now()
    const offers = await this.store.sessions.offersOf(ids) // [spec:SP-c7f1]
    let rowReadMs = 0
    let installMs = 0
    // The DRAFT stamps of the sessions installed below, in one read (POD-6160:
    // draft documents themselves load when used, never at boot).
    await this.state.stageDraftTimes(ids)
    // A runtime-driven session's turn state, recorded with its last runtime
    // event (POD-6160 D2h): one read for the sessions installed below.
    const runtimeTurnStates = await this.store.events.runtimeTurnStatesOf(ids)
    for (const r of storedRows) {
      let rowStarted = performance.now()
      const session = await this.sessionFromStoredRow(r, 'boot')
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
      const turnState = runtimeTurnStates.get(r.id)
      if (turnState) applyRuntimeTurnStateTo(session, turnState)
      if (r.status !== session.status) await this.persist(session)
    }
    log.info('boot session recovery breakdown', { sessions: storedRows.length, rowReadMs, installMs })
    bootStage('sessions row recovery', rowsStarted)
    const baselineStarted = performance.now()
    await this.backfillBirthRefs()
    bootStage('sessions ref backfill', baselineStarted)
    const queuesStarted = performance.now()
    // Queued rows survive a restart (that's their point) and are counted from
    // the table; delivery re-arms when the daemon reattaches and the sessions
    // bind. Only a queue whose session is gone is dropped (POD-6160: gone from
    // the table; a parked session is not in memory and keeps its queue).
    const queuedFor = [...(await this.store.sync.queuedMessageCounts()).keys()]
    const queueOwners = await this.store.sessions.getSessions(queuedFor)
    for (const sessionId of queuedFor) {
      const owner = queueOwners.get(sessionId)
      if (!owner || owner.deletedAt) await this.store.sync.deleteQueuedMessagesForSession(sessionId)
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
    bootStage('sessions queue sweep', queuesStarted)
    const listStarted = performance.now()
    const sessions = await this.listSessionsForBootBaseline()
    bootStage('sessions baseline listing', listStarted)
    const reconcileStarted = performance.now()
    const recovered = await this.ports.ledger.reconcile(
      'session',
      sessions.map((s) => ({ id: s.sessionId, value: s })),
    )
    // Explicit cleared records must survive a restart: the source tables use
    // absence for never-read/no-snooze, while replica absence means not loaded.
    bootStage('sessions baseline reconcile', reconcileStarted)
    const markersStarted = performance.now()
    const activeUsers = new Set(
      (await this.store.users.list()).filter((user) => !user.disabledAt).map((user) => user.id),
    )
    const stateRows = await this.store.sessions.listSessionUserStateRows(undefined, this.now())
    const priors = ((await this.ports.ledger.authority?.snapshot('sessionUserState')) ?? []) as SessionUserStateWire[]
    // The sessions that still exist, read from the table (POD-6160: a parked
    // session is not in memory).
    const named = await this.store.sessions.getSessions([
      ...new Set([...stateRows, ...priors].map((value) => value.sessionId)),
    ])
    const live = new Set([...named.values()].filter((row) => !row.deletedAt).map((row) => row.id))
    const markers = new Map<string, SessionUserStateWire>()
    for (const value of stateRows) {
      if (live.has(value.sessionId) && activeUsers.has(value.userId))
        markers.set(sessionUserStateRowId(value.userId, value.sessionId), value)
    }
    for (const prior of priors) {
      const id = sessionUserStateRowId(prior.userId, prior.sessionId)
      if (!markers.has(id) && live.has(prior.sessionId) && activeUsers.has(prior.userId))
        markers.set(id, { userId: prior.userId, sessionId: prior.sessionId, readAt: null })
    }
    await this.ports.ledger.reconcile(
      'sessionUserState',
      [...markers].map(([id, value]) => ({ id, value })),
    )
    this.publishSessionProjection(recovered)
    bootStage('sessions user-state reconcile', markersStarted)
    bootStage('sessions baseline', baselineStarted)
  }

  /**
   * NOTHING ABOUT THIS SESSION STILL WAITS TO REACH ITS ROW (POD-6160): no write
   * queued or in flight, no baseline staged against an open span, no volatile
   * capture and no activity flush pending. A durable record read now is what
   * the object holds.
   */
  settled(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId)
    if (session) this.repairRolledBack(session)
    return (
      !this.sessionWriteTail.has(sessionId) &&
      !this.pendingVolatileSessions.has(sessionId) &&
      !this.dirtyActivitySessions.has(sessionId) &&
      this.stagedSessionStates.peek(sessionId) === undefined
    )
  }

  forget(sessionId: SessionId): void {
    this.liveInstalls.delete(sessionId)
    this.unreplayedTranscripts.delete(sessionId)
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
