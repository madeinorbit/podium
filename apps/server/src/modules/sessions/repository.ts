import { CAP_DAEMON_GEOMETRY_APPLIED } from '@podium/protocol'
import type { MachineId, SessionId, SessionMeta } from '@podium/model'
import { AgentKind } from '@podium/model'

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

import { FIRST_ADMIN_USER_ID } from '@podium/model'
import type { DaemonPtyInputBatch, MetadataChange } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { EntityChangeSpec } from '@podium/sync'
import type { AutoContinueController } from '../../auto-continue'
import { isFeatureEnabled } from '../../features'
import type { SessionRow, SessionStore } from '../../store'
import type { WriteFunnel } from '../funnel'
import type { MemoryService } from '../memory/service'
import { DEPLOYMENT, perf } from '../perf/registry'
import type { SessionLedger } from './lifecycle'
import type { SessionObservationLeases } from './observation-leases'
export interface SessionProjectionEvent {
  generation: number
  changes: MetadataChange[]
  ledgerCursor: number
}

import { createLogger } from '@podium/logger'
import { Session, type SessionDurableState, type SessionVolatileField } from './session'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'
import type { SessionView } from './view'
import { runtimeTranscriptItemFromEvent } from './runtime-transcript'

const log = createLogger('server:sessions')

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
  funnel: WriteFunnel
  view: SessionView
  state: SessionStateService
  observationLeases: SessionObservationLeases
  autoContinue(): AutoContinueController
  toMachine(machineId: MachineId, message: ControlMessage): void
  toPtyInput(machineId: MachineId, input: DaemonPtyInputBatch): void
  /** Does the daemon attached for this machine RIGHT NOW have `cap`? Live, per
   *  socket — see `MachineService.daemonSupports` (POD-3239). */
  machineSupports(machineId: MachineId, cap: string): boolean
  broadcastSessions(): void
  flushBroadcasts(): void
  runScheduledBroadcast(): void
  listSessions(): SessionMeta[]
  now(): number
  appliedMutationMaxAgeMs: number
}

export class SessionRepository {
  private sessionsGeneration_ = 0
  private readonly sessionProjectionListeners = new Set<(event: SessionProjectionEvent) => void>()
  private volatileSessionMutationVersion = 0
  private readonly pendingVolatileSessions = new Map<SessionId, PendingVolatileState>()
  private readonly capturedSessionStates = new Map<SessionId, SessionDurableState>()
  /** True while an activity flush is running — see {@link flushActivity}. */
  private flushingActivity = false
  private volatileSessionCaptureTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly VOLATILE_CAPTURE_RETRY_MS = 1_000
  static readonly VOLATILE_SLICE_MAX_ITEMS = 32
  static readonly VOLATILE_SLICE_MAX_CPU_MS = 8

  constructor(private readonly ports: SessionRepositoryPorts) {}

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
  private get observationLeases(): SessionObservationLeases {
    return this.ports.observationLeases
  }
  private get autoContinue(): AutoContinueController {
    return this.ports.autoContinue()
  }
  private readonly toMachine = (machineId: MachineId, message: ControlMessage): void =>
    this.ports.toMachine(machineId, message)
  private readonly broadcastSessions = (): void => this.ports.broadcastSessions()
  private readonly listSessions = (): SessionMeta[] => this.ports.listSessions()
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
  private captureSessionSpecs(specs: EntityChangeSpec[], issueRelevant = true): MetadataChange[] {
    if (specs.length === 0) return []
    const changes = this.ports.ledger.capture(specs)
    this.publishSessionProjection(changes, undefined, issueRelevant)
    return changes
  }

  markVolatileSessionDirty(
    sessionId: SessionId,
    preserve: SessionVolatileField[] = ['geometry', 'handoffTarget'],
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
    this.volatileSessionCaptureTimer = setTimeout(() => {
      this.volatileSessionCaptureTimer = null
      try {
        this.ports.runScheduledBroadcast()
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
  drainVolatileCaptureSlice(budget: VolatileSliceBudget = {}): VolatileSliceResult {
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
      const changes = this.captureVolatileEntries(pending)
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

  private captureVolatileEntries(
    pending: readonly [SessionId, PendingVolatileState][],
  ): MetadataChange[] {
    if (pending.length === 0) return []
    const issueRelevant = pending.some(([, state]) => state.issueRelevant)
    const specs: EntityChangeSpec[] = []
    for (const [sessionId] of pending) {
      const session = this.sessions.get(sessionId)
      if (!session) continue
      specs.push({
        entity: 'session',
        id: sessionId,
        op: 'upsert',
        value: this.view.wire(session),
      })
    }
    try {
      const changes = this.captureSessionSpecs(specs, issueRelevant)
      // A volatile A→B→A batch legitimately dedups to no durable patch, but it
      // still invalidates the legacy snapshot pipeline once. Do not fabricate a
      // projection event: patch consumers need only the captured final truth.
      if (!changes.some((change) => change.entity === 'session')) {
        this.sessionsGeneration_++
      }
      for (const [sessionId, pendingState] of pending) {
        const session = this.sessions.get(sessionId)
        if (session) this.capturedSessionStates.set(sessionId, session.captureDurableState())
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

  /** Synchronous dispose/test barrier: drain the complete pending set. */
  flushVolatileSessionCaptures(): MetadataChange[] {
    const startedAt = performance.now()
    this.clearVolatileSessionCaptureTimer()
    try {
      return this.captureVolatileEntries([...this.pendingVolatileSessions])
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

  /** Machine-owned derived fields changed (machineId and/or machineName). */
  sessionsChangedForMachine(machineId: MachineId): void {
    for (const session of this.sessions.values()) {
      if (session.machineId === machineId)
        this.markVolatileSessionDirty(session.sessionId, ['machineId'])
    }
    this.broadcastSessions()
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
  persist(session: Session, additionalWrite: () => void = () => {}): void {
    const pending = this.pendingVolatileSessions.get(session.sessionId)
    let changes: MetadataChange[]
    try {
      const committed = this.ports.ledger.commit({
        write: () => {
          additionalWrite()
          this.store.sessions.upsertSession(session.toRow())
        },
        changes: () => [
          {
            entity: 'session',
            id: session.sessionId,
            op: 'upsert',
            value: this.view.wire(session),
          },
        ],
      })
      changes = committed.changes
    } catch (err) {
      const captured = this.capturedSessionStates.get(session.sessionId)
      if (captured) session.restoreDurableState(captured, pending?.preserve)
      else this.sessions.delete(session.sessionId)
      throw err
    }
    if (
      pending !== undefined &&
      this.pendingVolatileSessions.get(session.sessionId)?.version === pending.version
    ) {
      this.pendingVolatileSessions.delete(session.sessionId)
      if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
    }
    this.capturedSessionStates.set(session.sessionId, session.captureDurableState())
    this.publishSessionProjection(changes)
  }

  /** Persist every session whose activity counters advanced since the last flush.
   *  Keeps the per-frame / per-keystroke path off the DB — the timer above calls
   *  this on a coarse interval, so a busy session writes at most once per tick. */
  flushActivity(): void {
    // SINGLE-FLIGHT (POD-3258). The dirty flag is cleared AFTER the persist, so
    // it is only a fence while the pair is one uninterrupted turn. Once the
    // persist awaits, an overlapping flush walks the same map, finds the same
    // session still marked dirty, and persists the row a second time — two
    // ledger commits and two projections for one counter advance. Skipped, not
    // queued: `activityDirty` is the durable-ish record of what still needs
    // writing, so anything this pass does not reach stays marked and goes out on
    // the next 12 s tick.
    if (this.flushingActivity) return
    this.flushingActivity = true
    try {
      for (const s of this.sessions.values()) {
        if (s.terminal.activityDirty) {
          this.persist(s)
          s.terminal.clearActivityDirty()
        }
      }
    } finally {
      this.flushingActivity = false
    }
  }

  /** Materialize one persisted row without exposing it until the caller installs it.
   *  Restored tombstones always come back as exited: deletion killed their runtime,
   *  so retaining a prior live/starting status would claim a PTY that no longer exists. */
  sessionFromStoredRow(r: SessionRow, mode: 'boot' | 'restore'): Session | null {
    const kind = AgentKind.safeParse(r.agentKind)
    if (!kind.success) {
      log.warn('skipping a persisted session with an invalid agentKind', {
        sessionId: r.id,
        agentKind: r.agentKind,
      })
      return null
    }
    const reloadStatus =
      mode === 'restore'
        ? 'exited'
        : r.headless
          ? r.status
          : r.status === 'live' || r.status === 'starting'
            ? 'reconnecting'
            : r.status
    const exitCode = mode === 'restore' || r.status !== 'exited' ? null : r.exitCode
    if (r.originKind === 'resume' && !r.conversationId) {
      log.warn('a persisted resume session has no conversationId', { sessionId: r.id })
    }
    const machineId = r.machineId
    let session!: Session
    session = new Session({
      sessionId: r.id,
      ownerUserId: r.ownerUserId ?? FIRST_ADMIN_USER_ID,
      agentKind: kind.data,
      cwd: r.cwd,
      title: r.title,
      origin:
        r.originKind === 'resume'
          ? { kind: 'resume', conversationId: r.conversationId ?? '' }
          : { kind: 'spawn' },
      createdAt: r.createdAt,
      geometry: { ...(r.geometry ?? { cols: 80, rows: 24 }) },
      machineId,
      toDaemon: (msg) => this.toMachine(this.sessions.get(r.id)?.machineId ?? machineId, msg),
      daemonReportsGeometry: () =>
        this.ports.machineSupports(
          this.sessions.get(r.id)?.machineId ?? machineId,
          CAP_DAEMON_GEOMETRY_APPLIED,
        ),
      sendInput: (input) =>
        this.ports.toPtyInput(this.sessions.get(r.id)?.machineId ?? machineId, input),
      onActivity: () => {
        this.persist(session)
        this.broadcastSessions()
      },
      durableLabel: r.durableLabel,
      lastActiveAt: r.lastActiveAt,
      ...(r.workingMsTotal != null ? { workingMsTotal: r.workingMsTotal } : {}),
      inputCount: r.inputCount ?? 0,
      outputCount: r.outputCount ?? 0,
      activityCount: r.activityCount ?? 0,
      lastOutputAt: r.lastOutputAt,
      lastInputAt: r.lastInputAt,
      lastResumedAt: r.lastResumedAt,
      status: reloadStatus,
      exitCode: exitCode ?? undefined,
      ...(exitCode === -1 && r.spawnFailure ? { spawnFailure: r.spawnFailure } : {}),
      ...(r.name ? { name: r.name } : {}),
      // Survives a restart — otherwise a reboot would forget that the USER named this
      // session and the next agent title would sail straight through (#490).
      ...(r.name && r.nameSource ? { nameSource: r.nameSource } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      /**
       * THE RUNTIME REQUEST SURVIVES THE RESTART (POD-3081). Without this line
       * the columns are written and never read back, which is worse than not
       * having them: a reconfigured session comes back displaying the model it
       * was LAUNCHED with while its driver — whose own journal did survive —
       * goes on answering as the one it was configured to. That is the
       * requested-vs-observed split saying the thing it exists to prevent.
       *
       * Absent on the row = never configured, which is different from
       * "configured back to the launch value" and must stay different.
       */
      ...(r.requestedModel ? { requestedModel: r.requestedModel } : {}),
      ...(r.requestedEffort ? { requestedEffort: r.requestedEffort } : {}),
      ...(r.accountId ? { accountId: r.accountId } : {}),
      ...(r.loginHarness ? { loginHarness: r.loginHarness } : {}),
      ...(r.spawnedBy ? { spawnedBy: r.spawnedBy } : {}),
      // The pair survives a restart. Absent on the row = none was ever recorded
      // (a session from before the columns existed); it is not reconstructed here
      // from ownerUserId or spawnedBy, which would invent one.
      ...(r.createdBy ? { createdBy: r.createdBy } : {}),
      ...(r.headless ? { headless: true } : {}),
      ...(r.issueId ? { issueId: r.issueId } : {}),
      ...(r.refIssueId ? { refIssueId: r.refIssueId } : {}),
      ...(r.refLetter ? { refLetter: r.refLetter } : {}),
      ...(r.refDraft != null ? { refDraft: r.refDraft } : {}),
      ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
      ...(r.workflowStepId ? { workflowStepId: r.workflowStepId } : {}),
      ...(r.executionProfileId ? { executionProfileId: r.executionProfileId } : {}),
      archived: r.archived,
      stoppedAt: r.stoppedAt ?? null,
      stopReason: r.stopReason ?? null,
      ...(Session.parseWorkState(r.workState)
        ? { workState: Session.parseWorkState(r.workState) }
        : {}),
      ...(r.resumeKind && r.resumeValue
        ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
        : {}),
      /**
       * THE FIX THIS COLUMN EXISTS FOR (POD-2290 round 2). `reloadStatus` above
       * turns a persisted live/starting row into `reconnecting`, and a
       * reconnecting row with no driver family is exactly where the panel falls
       * back to "assume a terminal" — the original bug's screen, driven live by
       * the reviewer with the daemon held down. `driverId` is deliberately NOT
       * restored beside it: that one names a live handle, and this row has none
       * until a daemon rebinds.
      */
      ...(r.selectedDriverId ? { selectedDriverId: r.selectedDriverId } : {}),
      ...(r.requestedDriverId ? { requestedDriverId: r.requestedDriverId } : {}),
      // Passed through, never defaulted: a row from before this column exists
      // makes no claim about whether its launch ever had a conversation, and
      // inventing `'never'` for it would authorize discarding one.
      ...(r.conversationBinding ? { conversationBinding: r.conversationBinding } : {}),
    })
    // Re-seed runtime-backed transcript items before the session reaches clients.
    // Terminal drivers use this durable bridge when the legacy observation path
    // is fenced; provider-file deltas can still overlap and upsert by cursor/id.
    const runtimeItems =
      this.ports.store?.events
        .listRuntimeTranscriptEvents(session.sessionId)
        .flatMap((event) => {
          const item = runtimeTranscriptItemFromEvent(event)
          return item ? [item] : []
        }) ?? []
    if (runtimeItems.length > 0) session.terminal.applyRuntimeDelta(runtimeItems)
    return session
  }

  installStoredSession(
    session: Session,
    offers: Record<
      string,
      { message: string; actions: { label: string; prompt: string }[]; createdAt: string }
    >,
  ): void {
    this.sessions.set(session.sessionId, session)
    // Offer replay [spec:SP-c7f1] with boot reconciliation: user input AFTER the
    // offer was posted means the conversation moved past it while we were down —
    // drop it instead of resurrecting a dead suggestion. (Live continuations are
    // handled by the working-transition clear; this covers what happened while
    // the server wasn't watching.)
    if (session.sessionId in offers) {
      const offer = offers[session.sessionId]
      if (offer && session.terminal.lastInputAtMs > Date.parse(offer.createdAt)) {
        this.store.sessions.clearOffer(session.sessionId)
      } else {
        session.offer = offer
      }
    }
    this.state.installSession(session.sessionId)
    if (session.resume?.value) {
      session.conversationPodiumId = this.ports.memory.conversationPodiumId(
        { kind: 'system', id: 'session-boot-reconcile' },
        session.machineId,
        session.resume.value,
      )
    }
    this.capturedSessionStates.set(session.sessionId, session.captureDurableState())
  }

  loadFromStore(): void {
    this.observationLeases.hydrate(this.store.observationCheckpoints.loadAll())

    // Shared draft documents hydrate here; viewer rows remain lazy per principal.
    this.state.setDraftSyncEnabled(
      isFeatureEnabled('draft-sync', this.store.settings.getSettings()),
    )
    this.state.loadFromStore()
    const offers = this.store.sessions.listOffers() // [spec:SP-c7f1]
    for (const r of this.store.sessions.loadSessions()) {
      const session = this.sessionFromStoredRow(r, 'boot')
      if (!session) continue
      this.installStoredSession(session, offers)
      const checkpoint = this.observationLeases.checkpointOf(r.id)
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
      if (r.status !== session.status) this.persist(session)
    }
    // One-shot boot backfill (#474): name pre-upgrade historical sessions at a
    // deliberate point instead of burst-allocating inside the first listSessions.
    // loadSessions returns created_at order, so allocation is deterministic; the
    // loop is a no-op once every session carries a ref.
    for (const session of this.sessions.values()) {
      const additionalWrite = this.view.prepareRefAllocation(session)
      if (additionalWrite) this.persist(session, additionalWrite)
    }
    // Re-seed the transient queued-send counts from the durable queue — the rows
    // survived the restart (that's their point); delivery re-arms when the daemon
    // reattaches and the sessions bind.
    for (const [sessionId, n] of this.store.sync.queuedMessageCounts()) {
      const session = this.sessions.get(sessionId)
      if (session) session.queuedMessageCount = n
      else this.store.sync.deleteQueuedMessagesForSession(sessionId) // orphaned queue
    }
    this.store.sync.pruneAppliedMutations({
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
    const recovered = this.ports.ledger.reconcile(
      'session',
      this.listSessions().map((s) => ({ id: s.sessionId, value: s })),
    )
    this.publishSessionProjection(recovered)
  }

  forget(sessionId: SessionId): void {
    this.pendingVolatileSessions.delete(sessionId)
    this.capturedSessionStates.delete(sessionId)
    if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
  }
}
