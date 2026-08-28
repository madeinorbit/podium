import { acceptAgentObservation } from '@podium/harness/metadata'
import { createLogger } from '@podium/logger'
import {
  type AgentRuntimeState,
  idleVerdictNeedsHuman,
  type SessionId,
  type MachineId,
} from '@podium/model'
import type {
  DaemonPtyOutputBatch,
  LiveServerMessage,
  MachinePrincipal,
  ObservationInputOrigin,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { AutoContinueController } from '../../auto-continue'
import type { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsDaemonFrame } from '../../gateway/daemon-frame-routing'
import { harnessObservationProvider } from '../../harness-manifest'
import type { ObservationLeaseRecord, SessionStore, TerminalCandidateFacts } from '../../store'
import type { EventBus } from '../bus'
import type { MemoryService } from '../memory/service'
import type { SessionDaemonProjection } from './daemon-projection'
import type { SessionInbox } from './inbox'
import type { SessionObservationLeases } from './observation-leases'
import type { Session } from './session'
import type { SessionStateService } from './session-state/service'

const log = createLogger('server:sessions')

export interface SessionDaemonLifecyclePorts {
  sessions: Map<SessionId, Session>
  bus: EventBus
  browserOpen: BrowserOpenGateway
  autoContinue: AutoContinueController
  inbox: SessionInbox
  state: SessionStateService
  projection: SessionDaemonProjection
  store: SessionStore
  memory: Pick<MemoryService, 'ensureConversationIdentity' | 'linkConversationSegment'>
  observationLeases: SessionObservationLeases
  persist(session: Session, additionalWrite?: () => void): void
  broadcastSessions(): void
  onSessionActivity(sessionId: SessionId): void
  onSessionAttention(sessionId: SessionId): void
  onSessionTurnEnd(sessionId: SessionId): void
  emitSessionExited(sessionId: SessionId, code: number, spawnedBy?: string): void
  toMachine(machineId: MachineId, message: ControlMessage): void
  now(): number
  terminalCandidateFacts(
    session: Session,
    lease: ObservationLeaseRecord,
    checkpoint: NonNullable<ObservationLeaseRecord['checkpoint']>,
  ): TerminalCandidateFacts | null
  broadcastToClients(message: LiveServerMessage): void
  clearOffer(sessionId: SessionId): void
  /** A parked row whose durable host turned out to be alive [POD-1953]. */
  reviveParkedButAlive(session: Session, machineId: string, reason: string): void
  /** This machine's live durable labels, pushed on connect [POD-1953]. */
  onDurableSessionCensus(principal: MachinePrincipal, labels: string[]): void
  /**
   * The Agent Runtime contract's inbound event sink (POD-1761 W3).
   *
   * OPTIONAL because a build without the contract wired has nowhere for these to
   * go, and because every existing fixture predates it — an unflagged session
   * produces none of these frames, so an absent sink is not a dropped fact.
   */
  runtimeEvents?: {
    record(
      machineId: MachineId,
      msg: Extract<SessionsDaemonFrame, { type: 'runtimeEvent' | 'runtimeFineEvent' }>,
    ): import('./runtime-event-gate').RuntimeEventGateResult
    ready(sessionId: SessionId): boolean
  }
  /**
   * The daemon reporting turns its queue never typed (POD-2132, POD-2202).
   *
   * Bound at the composition root to the message service, which moves each named
   * durable row to its terminal not-delivered state. THE FRAME REPEATS from a
   * durable daemon outbox until this lifecycle sends its acknowledgement after
   * `record` returns, so whatever is bound here MUST DEDUPE BY TURN ID rather
   * than assume one report per turn.
   */
  queueDrainAbandoned?: {
    record(msg: Extract<SessionsDaemonFrame, { type: 'runtimeQueueDrainAbandoned' }>): void
  }
  /**
   * THE PROTOCOL ASK INGRESS (POD-2023).
   *
   * Bound at the composition root to the interactions aggregate's `ask()`.
   * Optional for the same reason as the sink above — a build with no contract
   * wired receives none of these frames, so an absent handler drops nothing —
   * and NOT optional in spirit: once a server-family session is running, this is
   * the only way its asks become visible on any surface.
   */
  runtimeInteractions?: {
    ask(msg: Extract<SessionsDaemonFrame, { type: 'runtimeInteractionAsked' }>): void
  }
}

function isAttentionPhase(state: AgentRuntimeState | undefined): boolean {
  const phase = state?.phase
  if (phase === 'needs_user' || phase === 'errored') return true
  // The model owns which verdicts are a REQUEST: entering attention clears the
  // session's snoozes and ends an "until next message" defer on its issue, so an
  // ordinary turn that merely ended with open todos must NOT count (POD-415).
  if (phase === 'idle') return idleVerdictNeedsHuman(state?.idle?.kind)
  return false
}

function isExactFencedCheckpointReplay(
  observation: Extract<SessionsDaemonFrame, { type: 'agentObservation' }>['observation'],
  lease: ObservationLeaseRecord,
): boolean {
  const checkpoint = lease.checkpoint
  return Boolean(
    checkpoint?.terminalFence &&
      observation.provenance === 'bootstrap' &&
      observation.provider === lease.provider &&
      observation.providerSessionId === lease.providerSessionId &&
      observation.bindingVersion === lease.bindingVersion &&
      observation.observerGeneration === lease.observationGeneration &&
      observation.transitionId === checkpoint.lastTransitionId &&
      observation.turnEpoch === checkpoint.turnEpoch &&
      observation.providerTurnId === checkpoint.providerTurnId &&
      observation.providerPromptId === checkpoint.providerPromptId &&
      observation.providerAt === checkpoint.providerAt &&
      observation.state.phase === checkpoint.turnState.phase &&
      JSON.stringify(observation.state) === JSON.stringify(checkpoint.turnState) &&
      JSON.stringify(observation.providerCursor) === JSON.stringify(checkpoint.providerCursor),
  )
}

export class SessionDaemonLifecycle {
  /** Unfenced legacy exits can only be deduplicated until their replacement
   * binds. Runtime exits carry an observer generation and use the durable lease
   * comparison instead, which remains valid after bind as well. */
  private readonly unfencedExitsAwaitingBind = new Set<SessionId>()

  constructor(private readonly ports: SessionDaemonLifecyclePorts) {}

  private get sessions(): Map<SessionId, Session> {
    return this.ports.sessions
  }
  private get bus(): EventBus {
    return this.ports.bus
  }
  private get browserOpen(): BrowserOpenGateway {
    return this.ports.browserOpen
  }
  private get autoContinue(): AutoContinueController {
    return this.ports.autoContinue
  }
  private get inbox(): SessionInbox {
    return this.ports.inbox
  }
  private get state(): SessionStateService {
    return this.ports.state
  }
  private get daemonProjection(): SessionDaemonProjection {
    return this.ports.projection
  }
  private get store(): SessionStore {
    return this.ports.store
  }
  private get observationLeases(): SessionObservationLeases {
    return this.ports.observationLeases
  }
  private readonly persist = (session: Session, additionalWrite?: () => void): void =>
    this.ports.persist(session, additionalWrite)
  private readonly broadcastSessions = (): void => this.ports.broadcastSessions()
  private readonly emitSessionExited = (
    sessionId: SessionId,
    code: number,
    spawnedBy?: string,
  ): void => this.ports.emitSessionExited(sessionId, code, spawnedBy)
  private readonly toMachine = (machineId: MachineId, message: ControlMessage): void =>
    this.ports.toMachine(machineId, message)
  private readonly now = (): number => this.ports.now()
  private readonly terminalCandidateFacts = (
    session: Session,
    lease: ObservationLeaseRecord,
    checkpoint: NonNullable<ObservationLeaseRecord['checkpoint']>,
  ): TerminalCandidateFacts | null => this.ports.terminalCandidateFacts(session, lease, checkpoint)
  private readonly broadcastToClients = (message: LiveServerMessage): void =>
    this.ports.broadcastToClients(message)
  private readonly clearOffer = (sessionId: SessionId): void => this.ports.clearOffer(sessionId)

  /**
   * Apply a process death from either legacy `agentExit` or the durable runtime
   * stream. The latter is the lossless copy: `agentExit` is an ordinary daemon
   * frame and may be dropped while the daemon/server link is reconnecting.
   */
  private handleAgentExit(msg: Extract<SessionsDaemonFrame, { type: 'agentExit' }>): void {
    const before = this.sessions.get(msg.sessionId)
    const lease =
      this.observationLeases.get(msg.sessionId) ??
      this.store.observationCheckpoints.get(msg.sessionId)
    // A replacement reuses the Podium session id but owns a newer runtime
    // generation. Reject any exit not authored by the currently fenced
    // process, including one repeated after the replacement has bound live.
    // A stated generation with no lease fails closed: the runtime cannot
    // legitimately spawn until terminal proof has minted that lease.
    if (
      msg.observerGeneration !== undefined &&
      (!lease || msg.observerGeneration !== lease.observationGeneration)
    ) {
      return
    }
    // Older terminal/daemon frames have no generation. Preserve their
    // pre-bind duplicate guard; an already-exited row is inert either way.
    if (
      (msg.observerGeneration === undefined &&
        this.unfencedExitsAwaitingBind.has(msg.sessionId)) ||
      before?.status === 'exited'
    ) {
      return
    }
    before?.onExit(msg.code)
    this.autoContinue.onSessionGone(msg.sessionId)
    // Free the lingering per-session title debouncer when the process ends (audit
    // P1-12) — previously only killSession did, so every exited-but-not-killed
    // session leaked its debouncer closure. The row stays (resurrectable); a new
    // debouncer is created lazily if it ever emits a title again. Drafts are kept
    // (resurrect/chat needs them).
    this.daemonProjection.disposeTitle(msg.sessionId)
    const s = this.sessions.get(msg.sessionId)
    if (s) this.persist(s)
    this.broadcastSessions()
    // The assistant digest remains a legacy consumer in this vertical slice.
    this.ports.onSessionActivity(msg.sessionId)
    // Keep the issue attachment: an updater and an abandoned process both
    // arrive as agentExit, and the exited session remains resumable.
    // Session-death notification [spec:SP-85d1] (lock auto-release et al.).
    // Only a REAL exit fires: a hibernate kill keeps status 'hibernated'
    // and the session's leases with it. Also durable for steward parent-wake
    // (POD-904).
    if (s?.status === 'exited') {
      // Capture and publish the REAL death before requesting recovery. The
      // wake reaction is synchronous through workspace ensure and mutates
      // this same Session to `starting`; doing it first suppresses this
      // event and loses lock release and parent wake.
      if (msg.observerGeneration === undefined) {
        this.unfencedExitsAwaitingBind.add(msg.sessionId)
      }
      this.emitSessionExited(msg.sessionId, msg.code, s.spawnedBy)
      // A send can be durably admitted in the narrow interval between the
      // child dying and this exit reaching the server. It was accepted while
      // the row still said `live`, so queueText did not request resurrection.
      // Once the real exit is published, hand that accepted row back to the
      // ordinary delegated wake path; a fresh bind re-arms its FIFO drain.
      this.inbox.recoverQueuedAfterExit(msg.sessionId)
    }
  }

  /**
   * A new turn began: does it retire the session's standing offer
   * [spec:SP-c7f1]? Only when the USER opened it — a turn forced by a
   * stop-hook, mail delivery, cron or steward wake must leave an offer the
   * human never saw standing [POD-118].
   *
   * `origin` is the causal ledger's normalized answer and is trusted whenever
   * the provider supplies a real one. The codex and grok observers stamp every
   * transition 'provider' (they track no origin), and the legacy path carries
   * none at all, so those fall back to the evidence that path always used:
   * input a person is responsible for, arriving after the offer was posted.
   *
   * Both call sites route through here so the two branches cannot drift apart
   * again — the drift is what left the offer standing in the first place.
   */
  private userOpenedTurn(
    session: Session,
    offerCreatedAt: string,
    origin?: ObservationInputOrigin,
  ): boolean {
    switch (origin) {
      case 'human':
      case 'controller':
        return true
      case 'mail':
      case 'auto_continue':
      case 'steward':
      case 'system':
        return false
      default:
        return session.terminal.lastUserInputAtMs > Date.parse(offerCreatedAt)
    }
  }

  handleOutput(principal: MachinePrincipal, batch: DaemonPtyOutputBatch): void {
    const session = this.sessions.get(batch.sessionId)
    if (!session || session.machineId !== principal.machine) return
    session.terminal.acceptOutput(batch.bytes, batch.sourceFrames)
  }
  handle(principal: MachinePrincipal, msg: SessionsDaemonFrame): void {
    const machineId = principal.machine
    switch (msg.type) {
      case 'sessionOpenUrl': {
        const session = this.sessions.get(msg.sessionId)
        // A daemon may only originate intents for sessions it owns. The bus is
        // the typed notification seam from capture to client routing. [spec:SP-a43e]
        if (session?.machineId === machineId) this.bus.emit('session.openUrl', msg)
        break
      }
      case 'sessionOpenUrlResult': {
        this.browserOpen.onOpenUrlResult(machineId, msg)
        break
      }
      /**
       * The daemon has DECIDED which driver this session gets and has not yet
       * started it (POD-2290). Recorded and broadcast immediately, because the
       * whole value of the frame is arriving before `bind` does — a client
       * choosing a view during the launch window is the reason it exists.
       *
       * Deliberately does NOT mark the session live or touch `driverId`: a
       * decision is not a binding, and the row must not claim a handle exists.
       */
      case 'driverSelected': {
        const s = this.sessions.get(msg.sessionId)
        if (s) {
          s.selectedDriverId = msg.driverId
          // PERSISTED, not merely held (POD-2290 round 2). Holding it in memory
          // was the whole defect the reviewer drove: a server restart rehydrates
          // live rows as `reconnecting`, and an in-memory-only selection is gone
          // by then, so a headless session came back looking like it had a
          // terminal. This write is what survives the restart.
          this.persist(s)
          this.broadcastSessions()
        }
        break
      }
      case 'bind': {
        this.unfencedExitsAwaitingBind.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.markLive(msg.cmd, msg.geometry)
        this.inbox.markSessionBound(msg.sessionId)
        const s = this.sessions.get(msg.sessionId)
        if (s) {
          // Whether the daemon runs the composer engine for this session (POD-859)
          // — surfaced in meta so a client retires its own sampler/flush.
          s.draftSyncEngine = msg.draftSyncEngine ?? false
          // Whether the daemon drives this session through the agent-runtime
          // contract (POD-1761 W4) — the fact W4's migrated senders branch on.
          // Absent from an older daemon means the legacy path, which is both the
          // truth and the safe default.
          s.runtimeContract = msg.runtimeContract ?? false
          // A BIND IS ALSO A REATTACH (POD-2745). Whatever level the previous
          // daemon was told died with it — its watch registry is per-process —
          // so anything this session's viewers still need has to be asked for
          // again. Says nothing when nobody is watching.
          s.terminal.resetWatchLevel()
          // The resolved driver comes from the daemon's live handle binding, not
          // from the requested override. Older daemons and legacy sessions omit it.
          s.driverId = msg.driverId
          // …and what that driver can change on a running session (POD-3087).
          // Assigned unguarded, like `driverId` itself: a bind describes the
          // handle that exists NOW, so an older daemon's silence must clear a
          // previous daemon's answer rather than leave a stale capability
          // standing for a driver this one may not even have bound.
          s.configureFields = msg.configureFields
          /**
           * …and the DURABLE record follows the binding, not the plan (POD-2290
           * round 2). Normally they agree. Where they can differ — a launch that
           * fell back — the persisted fact has to describe what actually ran, or
           * the next restart rehydrates the session as the family it failed to
           * become. Guarded so an older daemon's bind, which carries no driver,
           * cannot erase a selection this session already reported.
           */
          if (msg.driverId) s.selectedDriverId = msg.driverId
          // Present only for a permitted manifest/machine default degradation.
          // Reattach echoes it so daemon reconnects preserve the fact.
          s.requestedDriverId = msg.requestedDriverId
          this.persist(s)
          this.autoContinue.onSessionLive(s.sessionId)
        }
        this.broadcastSessions()
        // The PTY is bound: if messages queued up while this session was parked
        // (or across a server restart), start a delivery attempt — the drain loop
        // itself waits out the boot-settle before typing. `justBound` is the part
        // the drain cannot see for itself: markLive above has already flipped the
        // session to 'live', so by the time it looks, an unproven CLI and a
        // long-settled one are the same word (POD-1100).
        this.inbox.drain(msg.sessionId, { justBound: true })
        // Catchup (POD-859 §6): seed native with a chat draft edited while the
        // session was down — on BIND (the engine is attached by the time the daemon
        // reports draftSyncEngine), not on reattach (dispatched before attach).
        if (msg.draftSyncEngine) this.state.maybeCatchupInject(msg.sessionId, machineId)
        break
      }
      case 'nativeDraft': {
        // The daemon's composer engine scraped the native composer (POD-859).
        // Sequence it as an origin='native' versioned edit and broadcast. Skip a
        // message the server is currently typing OUT (reviewer fix 5).
        this.state.handleNativeDraft(msg.sessionId, msg.text)
        break
      }
      case 'agentFrame':
        this.handleOutput(principal, {
          sessionId: msg.sessionId,
          sourceFrames: 1,
          bytes: Buffer.from(msg.data, 'base64'),
        })
        break
      case 'agentFrameBatch': {
        if (msg.frames.length === 0) break
        const bytes =
          msg.frames.length === 1
            ? Buffer.from(msg.frames[0]!, 'base64')
            : Buffer.concat(msg.frames.map((data) => Buffer.from(data, 'base64')))
        this.handleOutput(principal, {
          sessionId: msg.sessionId,
          sourceFrames: msg.frames.length,
          bytes,
        })
        break
      }
      case 'agentExit': {
        this.handleAgentExit(msg)
        break
      }
      case 'spawnError': {
        // No bind will arrive for this attempt. Retire the legacy pre-bind
        // duplicate guard so a later explicitly authorized retry starts with
        // clean lifecycle accounting; fenced Grok exits remain distinguishable
        // by their observer generation across both attempts.
        this.unfencedExitsAwaitingBind.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        // markSpawnError sets status 'exited' — notify lock auto-release etc.
        // [spec:SP-85d1] like any other real death.
        if (s) this.emitSessionExited(s.sessionId, -1, s.spawnedBy)
        break
      }
      case 'sessionKillResult': {
        // The receipt for a kill this server asked for [POD-1953]. A confirmed
        // reap needs nothing — the park already flipped the row. An UNCONFIRMED
        // one means the row is now lying about a process that is still serving,
        // so the durable host wins and the row goes back to reconnecting.
        const s = this.sessions.get(msg.sessionId)
        if (!s || s.machineId !== machineId) break
        if (msg.killed) break
        this.ports.reviveParkedButAlive(s, machineId, msg.reason ?? 'kill unconfirmed')
        break
      }
      case 'durableSessionCensus': {
        this.ports.onDurableSessionCensus(principal, msg.labels)
        break
      }
      case 'reattachFailed': {
        const s = this.sessions.get(msg.sessionId)
        // Skip rows already exited: those are the boot-time probes of dead 'exited'
        // sessions (see attachDaemon). Re-running onExit there would re-broadcast a
        // redundant agentExit and churn the row on every restart. A 'reconnecting'
        // survivor that fails to reattach is a real death — mark it exited.
        if (s && s.status !== 'exited') {
          s.onExit(-1) // the durable host is gone; the agent died with it
          this.autoContinue.onSessionGone(s.sessionId) // cancel any armed retry promptly, not at the next backoff tick
          this.persist(s)
          // Real death (not a boot-time probe of an already-exited row) —
          // notify lock auto-release etc. [spec:SP-85d1]. onExit keeps a
          // hibernated row 'hibernated'; only a genuine exit fires. (Fresh
          // lookup: the narrowed `s.status` above would defeat the compare.)
          if (this.sessions.get(msg.sessionId)?.status === 'exited') {
            this.emitSessionExited(s.sessionId, -1, s.spawnedBy)
          }
        }
        this.broadcastSessions()
        break
      }
      case 'agentObservationRebind': {
        const session = this.sessions.get(msg.sessionId)
        if (!session || session.machineId !== machineId) break
        if (!['starting', 'live', 'reconnecting'].includes(session.status)) break
        const lease =
          this.observationLeases.get(msg.sessionId) ??
          this.store.observationCheckpoints.get(msg.sessionId)
        const expectedProvider = harnessObservationProvider(session.agentKind)
        const sessionBindingCompatible =
          session.resume === undefined ||
          (session.resume.kind === msg.resumeKind &&
            (session.resume.value === msg.providerSessionId ||
              session.resume.value === msg.nextProviderSessionId))
        // A pre-existing target binding is authority only when THIS session was
        // explicitly launched to resume/handoff that exact thread. Otherwise a
        // fresh observer's exact-looking rebind can cross-wire two Podium rows
        // onto one provider transcript.
        const explicitlyExpectedTarget =
          session.resume?.kind === msg.resumeKind &&
          session.resume.value === msg.nextProviderSessionId
        const targetOwnedByAnotherSession =
          !explicitlyExpectedTarget &&
          [...this.sessions.values()].some(
            (other) =>
              other.sessionId !== session.sessionId &&
              other.resume?.kind === msg.resumeKind &&
              other.resume.value === msg.nextProviderSessionId,
          )
        if (
          !lease ||
          expectedProvider !== msg.provider ||
          lease.provider !== msg.provider ||
          !sessionBindingCompatible ||
          targetOwnedByAnotherSession
        ) {
          if (!lease) break
          this.toMachine(session.machineId, {
            type: 'agentObservationRebindAck',
            sessionId: session.sessionId,
            provider: lease.provider,
            rebindId: msg.rebindId,
            priorObserverGeneration: msg.observerGeneration,
            priorBindingVersion: msg.bindingVersion,
            nextProviderSessionId: msg.nextProviderSessionId,
            providerSessionId: lease.providerSessionId,
            result: 'rejected',
            rejectionReason: 'provider_binding_mismatch',
            observerGeneration: lease.observationGeneration,
            bindingVersion: lease.bindingVersion,
            checkpoint: lease.checkpoint,
          })
          break
        }

        let outcome: ReturnType<typeof this.store.observationCheckpoints.rebindExact> | undefined
        try {
          this.persist(session, () => {
            outcome = this.store.observationCheckpoints.rebindExact({
              sessionId: session.sessionId,
              provider: msg.provider,
              providerSessionId: msg.providerSessionId,
              bindingVersion: msg.bindingVersion,
              observationGeneration: msg.observerGeneration,
              nextProviderSessionId: msg.nextProviderSessionId,
            })
            if (outcome.kind === 'rejected') {
              throw new Error(`observation rebind rejected for ${session.sessionId}`)
            }
            session.resume = { kind: msg.resumeKind, value: msg.nextProviderSessionId }
            if (outcome.disposition !== 'advanced') return
            session.conversationPodiumId = msg.providerSessionId
              ? this.ports.memory.linkConversationSegment({
                  machineId: session.machineId,
                  newNativeId: msg.nextProviderSessionId,
                  priorNativeId: msg.providerSessionId,
                  providerId: session.agentKind,
                })
              : this.ports.memory.ensureConversationIdentity({
                  machineId: session.machineId,
                  nativeId: msg.nextProviderSessionId,
                  providerId: session.agentKind,
                })
          })
        } catch (err) {
          if (outcome?.kind !== 'rejected') throw err
        }
        if (!outcome) throw new Error(`missing observation rebind result for ${session.sessionId}`)
        if (outcome.kind === 'rejected') {
          this.toMachine(session.machineId, {
            type: 'agentObservationRebindAck',
            sessionId: session.sessionId,
            provider: outcome.lease.provider,
            rebindId: msg.rebindId,
            priorObserverGeneration: msg.observerGeneration,
            priorBindingVersion: msg.bindingVersion,
            nextProviderSessionId: msg.nextProviderSessionId,
            providerSessionId: outcome.lease.providerSessionId,
            result: 'rejected',
            rejectionReason: outcome.rejectionReason,
            observerGeneration: outcome.lease.observationGeneration,
            bindingVersion: outcome.lease.bindingVersion,
            checkpoint: outcome.lease.checkpoint,
          })
          break
        }
        const rebound = outcome.lease
        this.observationLeases.record(session.sessionId, rebound)
        this.toMachine(session.machineId, {
          type: 'agentObservationRebindAck',
          sessionId: session.sessionId,
          provider: rebound.provider,
          rebindId: msg.rebindId,
          priorObserverGeneration: msg.observerGeneration,
          priorBindingVersion: msg.bindingVersion,
          nextProviderSessionId: msg.nextProviderSessionId,
          providerSessionId: rebound.providerSessionId,
          result: 'accepted',
          observerGeneration: rebound.observationGeneration,
          bindingVersion: rebound.bindingVersion,
          checkpoint: rebound.checkpoint,
        })
        if (outcome.disposition === 'advanced') {
          this.broadcastSessions()
        }
        break
      }
      case 'agentObservation': {
        const observation = msg.observation
        const session = this.sessions.get(observation.podiumSessionId)
        if (!session || session.machineId !== machineId) break
        if (!['starting', 'live', 'reconnecting'].includes(session.status)) break
        // Durable state is authoritative: a foreign daemon or reattach may
        // have advanced the lease since this process cached it.
        const lease = this.store.observationCheckpoints.get(observation.podiumSessionId)
        if (lease) this.observationLeases.record(observation.podiumSessionId, lease)
        const outcome =
          observation.podiumSessionId !== session.sessionId || !lease
            ? ({ kind: 'rejected', rejectionReason: 'legacy_unfenced_observation' } as const)
            : acceptAgentObservation(
                lease.checkpoint,
                {
                  provider: lease.provider,
                  providerSessionId: lease.providerSessionId,
                  bindingVersion: lease.bindingVersion,
                  observationGeneration: lease.observationGeneration,
                },
                observation,
                new Date(this.now()).toISOString(),
              )

        if (outcome.kind === 'rejected') {
          // A replacement observer replays the exact durable checkpoint under
          // its freshly fenced generation. The causal gate still rejects that
          // duplicate for effects, but it proves the old terminal fence survived
          // reattachment. Renew only the generation/repaint counters; the
          // repository refuses any changed work, input, binding, or cursor fact.
          if (lease && isExactFencedCheckpointReplay(observation, lease)) {
            const checkpoint = lease.checkpoint
            if (checkpoint) {
              const facts = this.terminalCandidateFacts(session, lease, checkpoint)
              if (facts) {
                this.store.observationCheckpoints.renewTerminalCandidate(
                  facts,
                  new Date(this.now()).toISOString(),
                )
              }
            }
          }
          this.toMachine(session.machineId, {
            type: 'agentObservationAck',
            sessionId: session.sessionId,
            observerGeneration: observation.observerGeneration,
            bindingVersion: observation.bindingVersion,
            transitionId: observation.transitionId,
            result: 'rejected',
            rejectionReason: outcome.rejectionReason,
            ...(lease?.checkpoint?.providerCursor
              ? { acceptedCursor: lease.checkpoint.providerCursor }
              : {}),
            checkpoint: lease?.checkpoint ?? null,
          })
          break
        }

        const prev = session.agentState
        session.applyObservationCheckpoint(
          outcome.checkpoint,
          !this.ports.runtimeEvents?.ready(session.sessionId),
        )
        const acceptedLive =
          outcome.kind === 'live_transition_accepted' || outcome.kind === 'live_refresh_accepted'
        if (acceptedLive) session.terminal.recordObservationActivity()
        const acceptedLease: ObservationLeaseRecord = {
          ...(lease as ObservationLeaseRecord),
          providerSessionId: outcome.checkpoint.providerSessionId,
          checkpoint: outcome.checkpoint,
          updatedAt: outcome.checkpoint.acceptedAt,
        }
        const candidateFacts = this.terminalCandidateFacts(
          session,
          acceptedLease,
          outcome.checkpoint,
        )
        this.persist(session, () => {
          this.store.observationCheckpoints.save(outcome.checkpoint)
          if (acceptedLive) {
            if (candidateFacts) {
              this.store.observationCheckpoints.recordTerminalCandidate(
                candidateFacts,
                outcome.checkpoint.acceptedAt,
              )
            } else {
              this.store.observationCheckpoints.cancelTerminalCandidate(session.sessionId)
            }
          }
        })
        this.observationLeases.record(session.sessionId, acceptedLease)
        const next = session.agentState ?? outcome.checkpoint.turnState

        // The durable commit above is the release point for daemon-side
        // bootstrap buffering [spec:SP-cdb2].
        this.toMachine(session.machineId, {
          type: 'agentObservationAck',
          sessionId: session.sessionId,
          observerGeneration: observation.observerGeneration,
          bindingVersion: observation.bindingVersion,
          transitionId: observation.transitionId,
          result: outcome.kind,
          acceptedCursor: outcome.checkpoint.providerCursor,
          checkpoint: outcome.checkpoint,
        })

        this.broadcastToClients({
          type: 'sessionAgentStateChanged',
          sessionId: session.sessionId,
          state: next,
        })

        // Snapshot and same-phase refresh update display/checkpoint only. Every
        // effect below is exclusive to one accepted causal live phase edge.
        if (outcome.kind !== 'live_transition_accepted') break
        this.autoContinue.onStateChange(session.sessionId, next)
        // The assistant digest is not part of the board/recency slice; keep its
        // legacy activity trigger until a later consumer migration owns replay.
        this.ports.onSessionActivity(session.sessionId)
        // Turn end (working → anything else) is the only moment new commits can
        // appear — refresh the owning issue's git state [POD-98].
        if (
          !this.ports.runtimeEvents?.ready(session.sessionId) &&
          prev?.phase === 'working' &&
          next.phase !== 'working'
        ) {
          this.ports.onSessionTurnEnd(session.sessionId)
        }
        this.inbox.stateChanged({
          sessionId: session.sessionId,
          prev,
          next,
          observation,
        })
        if (isAttentionPhase(prev) && !isAttentionPhase(next)) {
          this.state.clearAllSnoozes(session.sessionId)
        }
        if (
          !this.ports.runtimeEvents?.ready(session.sessionId) &&
          !isAttentionPhase(prev) &&
          isAttentionPhase(next)
        ) {
          this.ports.onSessionAttention(session.sessionId)
        }
        // A NEW turn opened after the offer means the conversation moved past
        // it, so its suggested actions no longer apply [spec:SP-c7f1]. This is
        // the path every causally-observed harness takes — the chat composer
        // and the offer buttons clear directly in sendText, so what lands here
        // is the continuation those never see: the user typing into the PTY.
        // The event-time guard keeps a late or replayed turn_opened from
        // consuming an offer that was posted after it.
        if (
          session.offer !== undefined &&
          observation.transitionKind === 'turn_opened' &&
          Date.parse(observation.receivedAt) > Date.parse(session.offer.createdAt) &&
          this.userOpenedTurn(session, session.offer.createdAt, observation.inputOrigin)
        ) {
          this.clearOffer(session.sessionId)
        }
        break
      }
      case 'agentObserverLiveConfirmation': {
        const session = this.sessions.get(msg.sessionId)
        if (!session || session.machineId !== machineId) break
        if (!['starting', 'live', 'reconnecting'].includes(session.status)) break
        const lease = this.store.observationCheckpoints.get(msg.sessionId)
        const checkpoint = lease?.checkpoint
        if (
          !lease ||
          !checkpoint?.terminalFence ||
          checkpoint.terminalFence.closing ||
          msg.provider !== lease.provider ||
          msg.providerSessionId !== lease.providerSessionId ||
          msg.bindingVersion !== lease.bindingVersion ||
          msg.observerGeneration !== lease.observationGeneration ||
          JSON.stringify(msg.providerCursor) !== JSON.stringify(checkpoint.providerCursor)
        )
          break
        const facts = this.terminalCandidateFacts(session, lease, checkpoint)
        if (!facts) break
        this.store.observationCheckpoints.confirmTerminalCandidate(
          facts,
          msg.livePollSequence,
          msg.confirmedAt,
        )
        break
      }
      case 'agentState': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        if (!['starting', 'live', 'reconnecting'].includes(session.status)) break
        // Mixed deployment: legacy remains visible until the first v1
        // checkpoint. It can never downgrade or overwrite causal truth.
        if (this.observationLeases.hasCheckpoint(msg.sessionId)) {
          log.warn('rejected a legacy unfenced observation', { sessionId: msg.sessionId })
          break
        }
        const prev = session.agentState
        session.setAgentState(msg.state, !this.ports.runtimeEvents?.ready(session.sessionId))
        const next = session.agentState ?? msg.state
        this.autoContinue.onStateChange(msg.sessionId, next)
        // Persist so the advanced recency (lastActiveAt) is durable across a server
        // restart — otherwise the row keeps its stale last-persisted time and the
        // ordering jumps backward on every redeploy until events re-arrive.
        this.persist(session)
        // A dedicated per-session message — not broadcastSessions(). Hook events
        // fire often (TodoWrite mutations, turn boundaries, across all sessions);
        // re-serializing and fanning out the whole session list each time is
        // O(sessions × clients). Late joiners still get state via listSessions().
        this.broadcastToClients({
          type: 'sessionAgentStateChanged',
          sessionId: msg.sessionId,
          state: next,
        })
        // The assistant digest is not part of the board/recency slice; keep its
        // legacy activity trigger until a later consumer migration owns replay.
        this.ports.onSessionActivity(msg.sessionId)
        // Turn end (working → anything else) is the only moment new commits can
        // appear — refresh the owning issue's git state [POD-98].
        if (
          !this.ports.runtimeEvents?.ready(session.sessionId) &&
          prev?.phase === 'working' &&
          next.phase !== 'working'
        ) {
          this.ports.onSessionTurnEnd(msg.sessionId)
        }
        // Synchronous fan-out to bus subscribers (NotifyService) — same ordering
        // as the old direct notifyAttention call.
        this.inbox.stateChanged({ sessionId: msg.sessionId, prev, next })
        if (isAttentionPhase(prev) && !isAttentionPhase(next)) {
          this.state.clearAllSnoozes(msg.sessionId)
        }
        // Entering an attention phase = a new message needs the user: end any
        // "until next message" defer on the issue that owns this session.
        if (
          !this.ports.runtimeEvents?.ready(session.sessionId) &&
          !isAttentionPhase(prev) &&
          isAttentionPhase(next)
        ) {
          this.ports.onSessionAttention(msg.sessionId)
        }
        // A NEW turn beginning after the offer was made means the conversation
        // moved past it — its suggested actions no longer apply [spec:SP-c7f1].
        // This frame carries no input origin, so {@link userOpenedTurn} decides
        // on input evidence. The event-time guard keeps a boot replay of the
        // very turn that produced the offer from consuming it.
        if (
          session.offer !== undefined &&
          prev?.phase !== 'working' &&
          next.phase === 'working' &&
          next.since > session.offer.createdAt &&
          this.userOpenedTurn(session, session.offer.createdAt)
        ) {
          this.clearOffer(msg.sessionId)
        }
        break
      }
      case 'runtimeInteractionAsked': {
        /**
         * A PROTOCOL DRIVER'S ASK, ON ITS WAY TO THE DURABLE AGGREGATE
         * (POD-2023).
         *
         * The same ownership check every session-owned frame gets, and then the
         * W2 ingress — `ask()` with the driver's own id, `source: 'protocol'`
         * and `answerable: 'structured'`. Nothing is synthesized here: the
         * driver observed a real `permission.asked`/`question.asked` with a real
         * request id, which is precisely why this path does not go anywhere near
         * the screen classifier's at-least-once machinery.
         */
        const owner = this.sessions.get(msg.sessionId)
        if (owner?.machineId === machineId) this.ports.runtimeInteractions?.ask(msg)
        break
      }
      case 'runtimeQueueDrainAbandoned': {
        const owner = this.sessions.get(msg.sessionId)
        if (owner?.machineId === machineId && this.ports.queueDrainAbandoned) {
          // `record` is the synchronous durable boundary: it returns only after
          // the guarded queued→dead_letter update and its transition/notice work.
          // If it throws, no ack is sent and the daemon retains/replays the report.
          this.ports.queueDrainAbandoned.record(msg)
          if (msg.reportId) {
            this.ports.toMachine(machineId, {
              type: 'runtimeQueueDrainAbandonedAck',
              reportId: msg.reportId,
            })
          }
        }
        break
      }
      case 'runtimeFineEvent':
      case 'runtimeEvent': {
        // THE DURABLE COARSE RUNTIME STREAM (POD-2411).
        //
        // Ownership is checked before the one application gate advances its
        // restart cursor, appends the event and projects board/recency. State,
        // notification and chat compatibility frames remain separate consumers
        // until their own vertical slices move; they no longer own board effects
        // for a session that declared the runtime contract.
        const owner = this.sessions.get(msg.sessionId)
        if (msg.type === 'runtimeFineEvent') {
          if (owner?.machineId === machineId) this.ports.runtimeEvents?.record(machineId, msg)
          break
        }
        const result =
          owner?.machineId === machineId
            ? this.ports.runtimeEvents?.record(machineId, msg)
            : ({ kind: 'rejected', reason: 'unknown-session' } as const)
        if (!result) break
        if (!msg.deliveryId) break
        if (result.kind === 'rejected') {
          this.ports.toMachine(machineId, {
            type: 'runtimeEventAck',
            deliveryId: msg.deliveryId,
            outcome: 'rejected',
            rejectionReason: result.reason,
          })
        } else {
          // `runtimeEvent` is the durable copy of the process boundary. The
          // Grok adapter also emits `agentExit` for legacy consumers, but that
          // ordinary frame is lossy while the daemon/server link reconnects.
          // Recover from the committed event before acknowledging its outbox
          // record, preserving the queued-send resume contract.
          if (
            (result.kind === 'accepted' || result.kind === 'duplicate') &&
            msg.event.t === 'process' &&
            msg.event.ev.ev === 'exited'
          ) {
            this.handleAgentExit({
              type: 'agentExit',
              sessionId: msg.sessionId,
              code: msg.event.ev.code ?? 0,
              observerGeneration: msg.event.observerGeneration,
            })
          }
          this.ports.toMachine(machineId, {
            type: 'runtimeEventAck',
            deliveryId: msg.deliveryId,
            outcome: 'committed',
          })
        }
        break
      }
      default:
        this.daemonProjection.handle(machineId, msg)
        break
    }
  }
}
