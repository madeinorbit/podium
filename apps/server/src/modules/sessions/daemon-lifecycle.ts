import { acceptAgentObservation } from '@podium/harness'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { ControlMessage, LiveServerMessage, MachinePrincipal } from '@podium/protocol'
import type { AutoContinueController } from '../../auto-continue'
import type { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsDaemonFrame } from '../../gateway/daemon-frame-routing'
import { harnessObservationProvider } from '../../harness-manifest'
import type { ObservationLeaseRecord, SessionStore, TerminalCandidateFacts } from '../../store'
import type { EventBus } from '../bus'
import type { SessionDaemonProjection } from './daemon-projection'
import type { SessionInbox } from './inbox'
import type { Session } from './session'
import type { SessionStateService } from './session-state/service'

export interface SessionDaemonLifecyclePorts {
  sessions: Map<SessionId, Session>
  bus: EventBus
  browserOpen: BrowserOpenGateway
  autoContinue: AutoContinueController
  inbox: SessionInbox
  state: SessionStateService
  projection: SessionDaemonProjection
  store: SessionStore
  observationLeases: Map<SessionId, ObservationLeaseRecord>
  persist(session: Session, additionalWrite?: () => void): void
  broadcastSessions(): void
  onSessionActivity(sessionId: SessionId): void
  onSessionAttention(sessionId: SessionId): void
  onSessionTurnEnd(sessionId: SessionId): void
  maybeReapDraftIssue(issueId: string | null | undefined): void
  emitSessionExited(sessionId: SessionId, code: number, spawnedBy?: string): void
  toMachine(machineId: string, message: ControlMessage): void
  now(): number
  terminalCandidateFacts(
    session: Session,
    lease: ObservationLeaseRecord,
    checkpoint: NonNullable<ObservationLeaseRecord['checkpoint']>,
  ): TerminalCandidateFacts | null
  broadcastToClients(message: LiveServerMessage): void
  clearOffer(sessionId: SessionId): void
}

function isAttentionPhase(state: AgentRuntimeState | undefined): boolean {
  const phase = state?.phase
  if (phase === 'needs_user' || phase === 'errored') return true
  if (phase === 'idle') return !!state?.idle && state.idle.kind !== 'done'
  return false
}

export class SessionDaemonLifecycle {
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
  private get observationLeases(): Map<SessionId, ObservationLeaseRecord> {
    return this.ports.observationLeases
  }
  private readonly persist = (session: Session, additionalWrite?: () => void): void =>
    this.ports.persist(session, additionalWrite)
  private readonly broadcastSessions = (): void => this.ports.broadcastSessions()
  private readonly maybeReapDraftIssue = (issueId: string | null | undefined): void =>
    this.ports.maybeReapDraftIssue(issueId)
  private readonly emitSessionExited = (
    sessionId: SessionId,
    code: number,
    spawnedBy?: string,
  ): void => this.ports.emitSessionExited(sessionId, code, spawnedBy)
  private readonly toMachine = (machineId: string, message: ControlMessage): void =>
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
      case 'bind': {
        this.sessions.get(msg.sessionId)?.markLive(msg.cmd, msg.geometry)
        const s = this.sessions.get(msg.sessionId)
        if (s) {
          // Whether the daemon runs the composer engine for this session (POD-859)
          // — surfaced in meta so a client retires its own sampler/flush.
          s.draftSyncEngine = msg.draftSyncEngine ?? false
          this.persist(s)
          this.autoContinue.onSessionLive(s.sessionId)
        }
        this.broadcastSessions()
        // The PTY is bound: if messages queued up while this session was parked
        // (or across a server restart), start a delivery attempt — the drain loop
        // itself waits out the boot-settle before typing.
        this.inbox.drain(msg.sessionId)
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
        // The bridge's msg.seq is ignored — the Session assigns its own monotonic
        // seq so the client cursor stays stable across daemon reattaches.
        this.sessions.get(msg.sessionId)?.terminal.onFrame(msg.data)
        break
      case 'agentFrameBatch': {
        // The daemon coalesced several PTY frames for a lower-priority session into
        // one batch. Unpack back into per-frame onFrame so each still gets its own
        // server seq + outputFrame broadcast (clients are unchanged by coalescing).
        const session = this.sessions.get(msg.sessionId)
        if (session) for (const data of msg.frames) session.terminal.onFrame(data)
        break
      }
      case 'agentExit': {
        this.sessions.get(msg.sessionId)?.onExit(msg.code)
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
        this.ports.onSessionActivity(msg.sessionId)
        // If the process death made an empty draft's last session 'exited', reap
        // the draft. A hibernate kill lands here too, but onExit keeps status
        // 'hibernated', which blocks the reap — parked drafts survive.
        this.maybeReapDraftIssue(s?.issueId)
        // Session-death notification [spec:SP-85d1] (lock auto-release et al.).
        // Only a REAL exit fires: a hibernate kill keeps status 'hibernated'
        // and the session's leases with it. Also durable for steward parent-wake
        // (POD-904).
        if (s?.status === 'exited') {
          this.emitSessionExited(msg.sessionId, msg.code, s.spawnedBy)
        }
        break
      }
      case 'spawnError': {
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        // markSpawnError sets status 'exited' — notify lock auto-release etc.
        // [spec:SP-85d1] like any other real death.
        if (s) this.emitSessionExited(s.sessionId, -1, s.spawnedBy)
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
        if (
          !lease ||
          expectedProvider !== msg.provider ||
          lease.provider !== msg.provider ||
          !sessionBindingCompatible
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
              ? this.store.conversations.linkConversationSegment({
                  machineId: session.machineId,
                  newNativeId: msg.nextProviderSessionId,
                  priorNativeId: msg.providerSessionId,
                  providerId: session.agentKind,
                })
              : this.store.conversations.ensureConversationIdentity({
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
        this.observationLeases.set(session.sessionId, rebound)
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
        if (lease) this.observationLeases.set(observation.podiumSessionId, lease)
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
        session.applyObservationCheckpoint(outcome.checkpoint)
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
        this.observationLeases.set(session.sessionId, acceptedLease)
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
        this.ports.onSessionActivity(session.sessionId)
        this.inbox.stateChanged({
          sessionId: session.sessionId,
          prev,
          next,
          observation,
        })
        if (isAttentionPhase(prev) && !isAttentionPhase(next)) {
          this.state.clearAllSnoozes(session.sessionId)
        }
        if (!isAttentionPhase(prev) && isAttentionPhase(next)) {
          this.ports.onSessionAttention(session.sessionId)
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
        if (this.observationLeases.get(msg.sessionId)?.checkpoint) {
          console.warn(`[podium] rejected legacy unfenced observation for ${msg.sessionId}`)
          break
        }
        const prev = session.agentState
        session.setAgentState(msg.state)
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
        this.ports.onSessionActivity(msg.sessionId)
        // Turn end (working → anything else) is the only moment new commits can
        // appear — refresh the owning issue's git state [POD-98].
        if (prev?.phase === 'working' && next.phase !== 'working') {
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
        if (!isAttentionPhase(prev) && isAttentionPhase(next)) {
          this.ports.onSessionAttention(msg.sessionId)
        }
        // A NEW turn beginning after the offer was made means the conversation
        // moved past it — its suggested actions no longer apply [spec:SP-c7f1]
        // — but only when the USER moved it: a turn forced by a stop-hook or a
        // mail/cron wake must NOT consume a standing offer the human never saw
        // [POD-118]. So this path (which catches the continuations sendText
        // never sees: raw PTY keystrokes, whichever client they came from)
        // additionally requires controller input SINCE the offer; chat sends
        // and button clicks clear directly in sendText. The event-time guard
        // keeps a boot replay of the very turn that produced the offer from
        // consuming it.
        if (
          session.offer !== undefined &&
          prev?.phase !== 'working' &&
          next.phase === 'working' &&
          next.since > session.offer.createdAt &&
          session.terminal.lastInputAtMs > Date.parse(session.offer.createdAt)
        ) {
          this.clearOffer(msg.sessionId)
        }
        break
      }
      default:
        this.daemonProjection.handle(machineId, msg)
        break
    }
  }
}
