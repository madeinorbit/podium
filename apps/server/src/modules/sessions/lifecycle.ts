import type {
  AccountId,
  Attribution,
  Geometry,
  IssueId,
  ResumeRef,
  SessionId,
  SessionMeta,
  TranscriptItem,
  WorkState,
} from '@podium/model'
import { type AgentKind, asMachineId, asSessionId, asUserId, type UserId } from '@podium/model'
import { sessionSpawnerParentId } from '../../steward'

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

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { computePriorities, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { MachinePrincipal } from '@podium/protocol'
import {
  type AgentInstruction,
  AUTO_ARCHIVE_READ_WINDOW_MS,
  asDelegationRef,
  type ControlMessage,
  type DaemonMessage,
  type LiveServerMessage,
  MAX_AGENT_TITLE_LENGTH,
  type MetadataChange,
  type RoomRef,
  type ServerMessage,
  type SessionBindingAdoptLaunchInstruction,
  type SessionBindingSpawnInstruction,
  type SessionOpenUrlMessage,
  type SubscriptionRegistry,
  type SyncChangesSinceResult,
} from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import { type EntityChangeSpec, type MutationLedger, type MutationLedgerPort } from '@podium/sync'
import type { AutoContinueController } from '../../auto-continue'
import {
  type CommandPrincipal,
  resolvePrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import { isFeatureEnabled } from '../../features'
import type { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsClientFrame } from '../../gateway/client-frame-routing'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { type ClientConn, type ClientRegistry } from '../../gateway/client-registry'
import type { SessionsDaemonFrame } from '../../gateway/daemon-frame-routing'
import {
  harnessCapabilitiesFor,
  harnessNeedsSubmitVerification,
  harnessObservationProvider,
  harnessSupportsEffort,
  harnessSupportsInitialPrompt,
} from '../../harness-manifest'
import type { Capability } from '../../issue-authz'
import {
  liveSessionsUsingWorktree,
  selectMailNudgeSession,
  sessionsForIssue,
} from '../../issue-util'
import { machineUseDecision, ownershipFromMachines } from '../../machine-access'
import { assertModelSelectionValid } from '../../model-validation'
import type {
  ObservationLeaseRecord,
  SessionRow,
  SessionStore,
  TerminalCandidateFacts,
} from '../../store'
import type { EventBus } from '../bus'
import type { WriteFunnel } from '../funnel'
import type { DurableIssueAccessIndex } from '../issues/access-index'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService, MachineUseResolver } from '../machines/service'
import type { MemoryService } from '../memory/service'
import type { HeadlessService } from '../superagent/headless'
import { resolveAccountEnv } from './account-env'
import type { SessionClientControl } from './client-control'
import { machinesForPrincipal as projectMachinesForPrincipal } from './command-ctx'
import type { SessionDaemonLifecycle } from './daemon-lifecycle'
import type { SessionDaemonProjection } from './daemon-projection'
import { machineUseGateForCapability } from './handoff/access'
import type { AssertMachineUse, HandoffCaller } from './handoff/ports'
import {
  type InboxPrincipalReference,
  inboxActorColumns,
  inboxActorFromColumns,
  inboxPrincipalFromCommand,
  SessionInbox,
  SYSTEM_INBOX_PRINCIPAL,
} from './inbox'
// Still used by the lazy workspace-fetch path (POD-658), which shares the
// source-side bundle-base handshake and the chunked transfer with handoff.
import type { PreparedSessionInstructions } from './instructions'
import type { SessionIssueWorkflowPort } from './issue-workflow-port'
import { DEFAULT_GEOMETRY } from './session-shared'
import type { SessionSpawnResult } from './session-start'

export type { SessionSpawnResult }
// Re-exported for `relay.ts`, which imports both from here. Neither is
// DECLARED here: DEFAULT_GEOMETRY lives in session-shared.ts (three
// consumers, no single owner) and SessionSpawnResult lives with the module
// that produces it. POD-302's registry names declaration SITES, so pointing
// it at a re-export is what went stale after the extraction.
export { DEFAULT_GEOMETRY }

import type { SessionLaunchConfig } from './launch-config'
import type { SessionMachineReconciler } from './machine-reconciler'
import { normalizeAgentName } from './naming'
import type { SessionNaming } from './naming'
import { SessionObservationLeases } from './observation-leases'
import type { SessionBroadcastCoordinator } from './publication/broadcast'
import type {
  SessionPublicationCoordinator,
  SessionPublicationMetrics,
  SnapshotTail,
} from './publication/coordinator'
import type { SessionProjectionEvent } from './publish-worker-actor'
import type { PublishWorkerClient } from './publish-worker-client'
import type { SessionRepository } from './repository'
import type { PublicationAuthority, Session } from './session'
import { assertMayCommandSession, resolveSessionTarget } from './session-access'
import type { SessionBindingReceipts } from './session-binding'
import type { SessionStart } from './session-start'
import type { SessionTeardown } from './session-teardown'
import type { SessionRevival } from './session-revival'
import { wireSessionLifecycle } from './session-wiring'
import { SessionStateRegistry, sessionStatePrincipalFor } from './session-state/registry'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'
import type { SessionTerminalProof } from './terminal-proof'
import type { SessionView } from './view'
import type { SessionWorkspace } from './workspace'

/** Re-exported from session-shared so receipt-retention tests keep a stable site. */
export { APPLIED_MUTATIONS_MAX_AGE_MS } from './session-shared'

/** The write-seam change log face sessions run through ([spec:SP-3fe2] #256):
 *  `commit` binds a session row write and its declared change into one
 *  transaction; `reconcile` diffs the full restored truth at boot (including
 *  removes). Structurally satisfied by {@link @podium/sync.Ledger}; narrow so
 *  tests can fake it. */
export interface SessionLedger {
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  }
  capture(specs: EntityChangeSpec[]): MetadataChange[]
  reconcile(entity: 'session', rows: { id: string; value: unknown }[]): MetadataChange[]
}

/** Prepared half of a cross-aggregate issue/session deletion transaction. */
export interface SessionDeletePlan {
  sessionIds: string[]
  write(): void
  changes(): EntityChangeSpec[]
  apply(changes: MetadataChange[], ledgerCursor: number): void
}

/** Prepared half of restoring issue-owned session tombstones. */
export interface SessionRestorePlan {
  sessionIds: string[]
  restoredSessions: SessionMeta[]
  write(): void
  changes(): EntityChangeSpec[]
  apply(changes: MetadataChange[], ledgerCursor: number): void
}

export interface SessionLifecycleDeps {
  /** Deployment-qualified durable namespace, injected by the composition root. */
  durableLabelFor(sessionId: SessionId): string
  store: SessionStore
  now(): number
  bus: EventBus
  /** Lazy source-message re-authorization; resolved on every inbox drain. */
  authorizeQueuedMessage?(messageId: string): { ok: true } | { ok: false; reason: string }
  /** Dead-letter the durable source intent after a drain-time refusal. */
  rejectQueuedMessage?(messageId: string, reason: string): void
  /**
   * FRAMEWORK IDEMPOTENCY (POD-382): the composition root's ONE
   * `MutationLedger`. Threaded through rather than constructed here — the service
   * owns no dedup of its own since `withMutation` was deleted, and a
   * service-built ledger would be a second in-flight map over one durable table.
   *
   * Optional so the ~40 test fixtures that build a bare service literal keep
   * compiling; absent means a private ledger over the same store, which is
   * behaviourally identical for the synchronous session-state writes that reach it and
   * is the only path that can be reached without the composition root.
   */
  mutations?: MutationLedgerPort
  /** THE write funnel (modules/funnel): every broadcast pipeline ends in its
   *  fan-out tail; session deltas ride its ordered pipe via the ledger bridge. */
  funnel: WriteFunnel
  /** The write-seam change log ([spec:SP-3fe2] #256): persist() commits the row
   *  write + declared session change atomically; loadFromStore reconciles. */
  ledger: SessionLedger
  /**
   * THE GATEWAY's client connection set (POD-390). Threaded in rather than
   * constructed here: the mux owns the lifecycle, and a service-built registry
   * would be a second connection set.
   *
   * Optional for the same reason `mutations` is — the ~40 test fixtures that
   * build a bare service literal keep compiling, and absent means a private
   * registry that only this service can reach (no socket can ever enter it), the
   * client-plane mirror of the daemon mux's in-process peer form.
   */
  clients?: ClientRegistry
  /** The gateway's ONE routing registry, shared by the feed and room stream. */
  subscriptions: SubscriptionRegistry
  /** Shared live-session registry, constructed before every reader. Lifecycle
   * remains its sole mutation owner. */
  sessions?: Map<SessionId, Session>
  /** Test/fault-injection seam; production owns the default daemon client. */
  publicationWorker?: PublishWorkerClient
  /** Rollout-only old/new semantic comparison; never changes delivered bytes. */
  publicationShadowCompare?: boolean
  machines: MachinesService
  rpc: DaemonRpcService
  memory: MemoryService
  /** Live repository-backed issue access; re-read on every apply and replay. */
  issueAccess: DurableIssueAccessIndex
  /** Cross-feature snapshot material read from the already-constructed durable authority. */
  snapshotTail(): SnapshotTail
  /** POD-665: a worktree appeared/vanished out from under connected clients —
   *  nudge them to re-fetch repos. Raw invalidation, no payload. */
  onWorktreesChanged(repoPath: string, machineId?: string): void
  /** Prepare every registered source of machine-authored context before spawn.
   * Providers commit side effects only after the session row + command exist. */
  instructionsForStart(input: {
    sessionId: SessionId
    cwd: string
    agentKind: AgentKind
    issueId?: IssueId
    workflowRevisionId?: string
    existingOnly?: boolean
  }): PreparedSessionInstructions
  /**
   * Presence-room occupancy for a session (POD-1081). When provided,
   * `clientCount` is derived from it and attach/watch policy can consult the
   * same room world. Optional so unit fixtures without the stream plane keep
   * using the attach-set size.
   */
  sessionOccupancyCount?(sessionId: SessionId): number | undefined
  /**
   * Join/leave the session presence room when a PTY attaches or detaches so
   * occupancy and attach stay one mechanism (POD-1081 §5).
   */
  sessionRoomJoin?(client: ClientConn, sessionId: SessionId): void
  sessionRoomLeave?(client: ClientConn, sessionId: SessionId): void
}

/**
 * Session lifecycle runtime and its composition boundary.
 *
 * Handoff remains a fourth module under the handoff/ directory: its transaction, rollback,
 * and apply-time authorization checkpoints are cohesive independently of the
 * lifecycle transitions hosted here. Native identity receipts remain a visible
 * SessionBinding seam for POD-737; browser-open frames remain gateway/control
 * forwarding and are not lifecycle policy.
 *
 * Core session lifecycle + PTY frame relay + scheduling (issue #13 Phase 2):
 * the sessions/clients maps, spawn/resume/park/kill command paths, the client
 * and daemon ws data planes, the durable queued-send drain, and the coalesced
 * session broadcast pipeline (metadata oplog + split fan-out). SessionRegistry
 * is the composition root that wires this to the other modules and keeps thin
 * public delegates.
 */

export class SessionLifecycle {
  /** Live maps — public: the composition root's cross-module closures (and the
   *  relay tests, via `(reg as any).sessions/.clients`) reach them directly. */
  readonly sessions!: Map<SessionId, Session>
  /**
   * THE CLIENT CONNECTION SET — OWNED BY THE GATEWAY (POD-390).
   *
   * Held as a reference, not constructed here: `gateway/client-mux.ts` adds and
   * removes entries, and this service only READS the set to decide who a given
   * message is for. That read is the fan-out's selection half and it stays a
   * feature concern (see `gateway/client-registry.ts`); the delivery half is the
   * registry's methods.
   */
  readonly clients!: ClientRegistry

  /** Durable observer leases, hydrated before session state restoration. */
  private readonly observationLeases = new SessionObservationLeases()
  /** Terminal-proof reasoning over the lease book (POD-1396). */
  private readonly terminalProof!: SessionTerminalProof
  /** Daemon presence reconciliation for one machine (POD-1396). */
  private readonly machineReconciler!: SessionMachineReconciler
  /** The curated name slot and its provenance rule (POD-1396). */
  private readonly naming!: SessionNaming
  /** Model/effort/credential resolution for a spawn frame (POD-1396). */
  private readonly launchConfig!: SessionLaunchConfig
  /** Request resolution + spawn-frame construction (POD-1396). */
  private readonly sessionStart!: SessionStart
  /** Ending a session in one of four survival shapes (POD-1396). */
  private readonly sessionTeardown!: SessionTeardown
  /** Resume / resurrect / handoff (POD-1396). */
  private readonly sessionRevival!: SessionRevival

  private readonly store!: SessionStore
  private readonly now!: () => number
  private readonly bus!: EventBus
  private readonly machines!: MachinesService
  private readonly rpc!: DaemonRpcService
  readonly headless!: HeadlessService
  /** Durable viewer/shared-surface state, isolated behind explicit ports. */
  readonly state!: SessionStateService
  /** Backend auto-continue loop — re-arms retryable errored agents. */
  private readonly autoContinue!: AutoContinueController
  /** Attributed inbound text, answers, FIFO queueing and controller gating. */
  readonly inbox!: SessionInbox
  readonly sendText!: SessionInbox['sendText']
  readonly interruptText!: SessionInbox['interruptText']
  readonly queueText!: SessionInbox['queueText']
  readonly resumeAndSend!: SessionInbox['resumeAndSend']
  readonly answerAskUserQuestion!: (input: {
    sessionId: SessionId
    choices: { optionIndices: number[] }[]
    principal?: InboxPrincipalReference
  }) => { ok: boolean }
  readonly setSessionDraft!: (
    input: { sessionId: SessionId; text: string },
    fromClientId?: string,
  ) => void
  readonly draftRevision!: SessionStateService['draftRevision']
  /** The `sessions.handoff` handler (POD-642), built on first use. It holds the
   *  single-flight registry that stops a duplicate dispatch from forking a
   *  session, so it must outlive one call — see `handoffs()`. */
  /** The write funnel — owns the durable metadata oplog (docs/spec/oplog-read-path.md). */
  private readonly funnel!: WriteFunnel
  readonly publication!: SessionPublicationCoordinator
  readonly clientControl!: SessionClientControl
  readonly daemonProjection!: SessionDaemonProjection
  private readonly daemonLifecycle!: SessionDaemonLifecycle
  readonly workspace!: SessionWorkspace
  readonly view!: SessionView
  readonly repository!: SessionRepository

  private issueProjectionGeneration = 0
  readonly broadcasts!: SessionBroadcastCoordinator
  private readonly browserOpen!: BrowserOpenGateway
  private readonly bindingReceipts!: SessionBindingReceipts
  // Single timer that persists only sessions whose activity counters advanced
  // since the last tick — keeps the per-frame / per-keystroke path off the DB.
  private readonly activityFlushTimer = setInterval(() => this.repository.flushActivity(), 12_000)

  constructor(private readonly deps: SessionLifecycleDeps) {
    // ORDER UNCHANGED — body lives in session-wiring.ts as a verbatim move.
    // scripts/server-construction-order.ts does not walk this interior (POD-1411).
    wireSessionLifecycle(this, deps)
  }

  private prepareInboxSend(
    sessionId: SessionId,
    attribution: Attribution,
    kind: 'text' | 'answer',
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.state.clearAllSnoozes(sessionId)
    this.state.suppressNativeDraft(sessionId)
    if (session.offer !== undefined) this.clearOffer(sessionId)
    this.store.events.appendEvent({
      ts: new Date(this.now()).toISOString(),
      kind: kind === 'answer' ? 'session.inbox.answer' : 'session.inbox.send',
      subject: sessionId,
      payload: { sessionId, attribution },
    })
  }

  authorizeQueuedInputAtApply(input: {
    sessionId: SessionId
    principal: InboxPrincipalReference
    sourceMessageId: string | null
  }): { ok: true } | { ok: false; reason: string } {
    const refused = { ok: false, reason: 'session no longer exists' } as const
    const target = this.sessions.get(input.sessionId)
    const ownership = this.sessionOwner(input.sessionId)
    if (!target || !ownership) return refused

    if (input.sourceMessageId) {
      const source = this.deps.authorizeQueuedMessage?.(input.sourceMessageId)
      if (source && !source.ok) return source
    }

    if (input.principal.kind === 'system') return { ok: true }

    let principal: CommandPrincipal
    if (input.principal.kind === 'user') {
      const user = asUserId(input.principal.principalRef)
      if (
        !this.store.users.get(user) ||
        input.principal.attribution.actor.kind !== 'user' ||
        input.principal.attribution.actor.id !== user ||
        input.principal.attribution.onBehalfOf !== user
      ) {
        return refused
      }
      const role = this.store.users.roleOf(user)
      if (!role) return refused
      principal = userCommandPrincipal(user, role)
    } else {
      const actorSessionId = asSessionId(input.principal.principalRef)
      if (
        String(input.principal.delegation) !== actorSessionId ||
        input.principal.attribution.actor.kind !== 'agent' ||
        String(input.principal.attribution.actor.id) !== actorSessionId
      ) {
        return refused
      }
      principal = resolvePrincipal(this.capabilityForSession(actorSessionId), {
        parentSessionOf: (sessionId) =>
          sessionSpawnerParentId(this.sessions.get(sessionId)?.spawnedBy),
        onBehalfOfFor: (sessionId) => this.sessionOwner(sessionId)?.owner ?? undefined,
      })
      if (
        principal.kind !== 'agent' ||
        !this.store.users.get(principal.onBehalfOf) ||
        principal.onBehalfOf !== input.principal.attribution.onBehalfOf
      ) {
        return refused
      }
    }

    if (
      ownership.owner !== (principal.kind === 'user' ? principal.user : principal.onBehalfOf) &&
      !ownership.grants.includes(principal.kind === 'user' ? principal.user : principal.onBehalfOf)
    ) {
      return refused
    }
    if (
      machineUseDecision(principal, target.machineId, ownershipFromMachines(this.machines)) !==
      'granted'
    ) {
      return refused
    }

    // Every apply — including outbox replay — re-runs the ordinary session
    // scope gate. The source message proves intent and ordering, never rights.
    const access = {
      listSessions: () => this.listSessions(),
      issues: this.deps.issueAccess,
      visibility: () => true,
    }
    const resolved = resolveSessionTarget(principal, input.sessionId, access)
    if (resolved.kind === 'absent') return refused
    try {
      assertMayCommandSession(principal, resolved.session, 'sessions.sendText', access)
    } catch {
      return refused
    }
    return { ok: true }
  }

  dispose(): void {
    this.autoContinue.dispose()
    clearInterval(this.activityFlushTimer)
    this.browserOpen.dispose()
    // Graceful server restarts must not lose a resize that landed inside the
    // coalescing window; persist dirty geometry/activity before closing [spec:SP-1a0b].
    this.repository.flushActivity()
    // Run any coalesced session broadcast + pending delta batch. The durable
    // change log is already complete (commits happen at persist time, #256);
    // this just drains the in-flight fan-out tail deterministically.
    this.flushBroadcasts()
    this.publication.stop()
  }

  sessionsGeneration(): number {
    return this.repository.sessionsGeneration()
  }

  onSessionProjection(listener: (event: SessionProjectionEvent) => void): () => void {
    return this.repository.onSessionProjection(listener)
  }

  persist(session: Session, additionalWrite: () => void = () => {}): void {
    this.repository.persist(session, additionalWrite)
  }

  flushActivity(): void {
    this.repository.flushActivity()
  }

  loadFromStore(): void {
    this.repository.loadFromStore()
  }

  sessionsChangedForMachine(machineId: string): void {
    this.repository.sessionsChangedForMachine(machineId)
  }

  /**
   * A machine's daemon became reachable / went away — the SESSION half of
   * attach/detach. Delegated to {@link SessionMachineReconciler}; the gateway
   * (`gateway/daemon-mux.ts`) owns the transport half and calls these.
   */
  onMachineAttached(principal: MachinePrincipal): void {
    this.machineReconciler.onAttached(principal)
  }

  onMachineDetached(principal: MachinePrincipal): void {
    this.machineReconciler.onDetached(principal)
  }

  /**
   * The reattach control message for one survivor session.
   *
   * `recoveryMachineAccess` was computed ONCE per attach before this moved, and
   * is computed per session here. Identical result: the decision depends only on
   * `machineId` and the machines ownership snapshot, and the caller's loop is
   * synchronous, so nothing can change between iterations.
   */
  private reattachMessageFor(session: Session, machineId: string): ControlMessage {
    const recoveryMachineAccess =
      machineUseDecision(
        systemPrincipal('session-rebind'),
        machineId,
        ownershipFromMachines(this.machines),
      ) === 'granted'
        ? 'allowed'
        : 'denied'
    const observationLease = this.terminalProof.fence(session)
    const requestedGeneration = observationLease?.observationGeneration ?? 1
    return {
      type: 'reattach',
      sessionId: session.sessionId,
      durableLabel: session.durableLabel,
      agentKind: session.agentKind,
      cwd: session.cwd,
      geometry: session.terminal.geometry,
      binding: {
        transitionId: `reattach:${session.sessionId}:${requestedGeneration}`,
        machineAccess: recoveryMachineAccess,
        sessionAccess: 'allowed',
        principal: { kind: 'system' },
      },
      ...(observationLease
        ? {
            observationGeneration: observationLease.observationGeneration,
            observationBindingVersion: observationLease.bindingVersion,
            observationProviderSessionId: observationLease.providerSessionId,
            ...(observationLease.checkpoint
              ? { observationCheckpoint: observationLease.checkpoint }
              : {}),
          }
        : {}),
      ...(session.resume ? { resume: session.resume } : {}),
      ...(this.rpc.transcriptPathHint(
        { kind: 'system', id: 'session-attach' },
        {
          id: session.sessionId,
          machineId: session.machineId,
          ...(session.resume ? { resume: session.resume } : {}),
        },
      ) ?? {}),
      // Spawn-time floor for observer-based harnesses (codex): lets a reattached
      // observer discover a lazily-created rollout it never saw before the restart.
      ...(Number.isFinite(Date.parse(session.createdAt))
        ? { createdAtMs: Date.parse(session.createdAt) }
        : {}),
      ...(this.state.draftSyncEnabled() ? { draftSync: true } : {}),
    } as ControlMessage
  }

  /**
   * Re-establish a headless session's daemon-side transcript tail.
   *
   * DELIBERATELY NOT AWAITED, exactly as before the move. It is re-issued on
   * every daemon connect, so a missed bind self-heals on the next attach; making
   * it awaited here would serialise the rebind loop behind daemon round-trips.
   */
  private rebindHeadless(session: Session): void {
    if (!session.resume?.value) return
    void this.headless
      .headlessBind({
        sessionId: session.sessionId,
        agentKind: session.agentKind,
        cwd: session.cwd,
        resumeValue: session.resume.value,
      })
      .then((r) => {
        if (!r.ok) {
          console.warn(
            `[podium] headless bind failed for ${session.sessionId}: ${r.error ?? 'unknown'}`,
          )
        }
      })
  }

  /** Route a control message to the daemon that owns `machineId` (modules/machines);
   *  queued if that machine is briefly offline. Kept as a property so Session
   *  toDaemon closures and every internal call site bind through one seam. */
  private readonly toMachine = (machineId: string, msg: ControlMessage): void =>
    this.machines.toMachine(machineId, msg)

  /**
   * Recompute per-session output-relay priority across every client and push the
   * deltas to the daemon. computePriorities re-iterates its `clients` argument
   * ONCE PER SESSION, so a single-use iterator (this.clients.values()) would
   * exhaust after the first session and read every later session as tier 3 —
   * materialize it to an array. Only CHANGED sessions are sent (diffed against
   * lastPriority) so a viewState/attach churn never re-floods the whole map.
   */
  private pushPriorities(): void {
    this.state.pushPriorities()
  }

  // ---- tRPC control plane ----
  listSessions(forPrincipal?: SessionWirePrincipal): SessionMeta[] {
    return this.view.list(forPrincipal)
  }

  // RETIRED at POD-309 (ADR 5 D8): the hub-mirror apply path lived here —
  // `upstreamSessions` / `upstreamStale` / `upstreamOwnMachineIds`, the
  // `setUpstreamSessions` ingest that stamped `viaHub`, the stale-visible flip, and
  // the `upstreamRejection` guard that refused commands against a mirrored session.
  // Federation is deferred ([spec:SP-0371]) and `UpstreamSync` — the ONLY producer of
  // any of it — is deleted, so every one of those maps was permanently empty and every
  // guard reading them was permanently false. What survives is the SEAM, and it is not
  // here: authority/feed identity (packages/sync/src/feed), the change envelope's
  // origin/causation/mutation identity (packages/model/src/provenance), and the
  // reserved node-peer capabilities (packages/protocol/src/handshake).

  /**
   * Snooze a session for ONE USER (POD-380). Snooze is per-user state keyed
   * `(userId, sessionId)`; `userId` is required so no caller can write a row
   * without saying whose it is.
   *
   * There is no live mirror any more (POD-1076): the broadcast projection reads
   * `viewerOverlay`, so the only thing this writes is the durable row. The
   * projection is still unscoped (ADR 2 D2) and therefore still serves one named
   * viewer, but that choice now lives in ONE method instead of on every session.
   */
  setSnooze({
    userId,
    sessionId,
    until,
  }: {
    userId: string
    sessionId: SessionId
    until: string | null
  }): void {
    this.state.setSnooze(this.view.principalForTrustedUser(asUserId(userId)), sessionId, until)
  }

  clearSnooze(userId: string, sessionId: SessionId): void {
    this.state.clearSnooze(this.view.principalForTrustedUser(asUserId(userId)), sessionId)
  }

  /**
   * OWNER + GRANTS of a session, for the owner-or-grant policy (POD-380).
   *
   * `undefined` means the session does not exist — which the session-state envelope
   * treats identically to a denial (§3.1.5's consistent-error rule).
   *
   * Session rows still have no `owner` column, so existing sessions use
   * the instance's first-admin identity as a transitional owner. This is the ONE place
   * that answer is given; POD-1070 ownership work replaces it here rather than
   * in eleven handlers.
   */
  sessionOwner(sessionId: SessionId): { owner: UserId; grants: string[] } | undefined {
    const live = this.sessions.get(sessionId)
    const durable = live ?? this.store.sessions.getSession(sessionId)
    if (!durable) return undefined
    const issueId = durable.issueId ?? undefined
    const resourceKind = issueId ? 'issue' : 'session'
    const resourceId = issueId ?? sessionId
    const parentOwner = issueId
      ? (this.store.issues.getIssue(issueId)?.ownerUserId ?? durable.ownerUserId)
      : durable.ownerUserId
    if (!parentOwner) return undefined
    const grants = [
      ...new Set(
        this.store.grants
          .listForResource(resourceKind, resourceId)
          .filter((edge) => edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
          .map((edge) => edge.grantee),
      ),
    ]
    return { owner: parentOwner, grants }
  }

  /**
   * Machine `use` for a browser principal against the session's host
   * (POD-1081 §4). Independent of session grants — share is not a back door.
   */
  machineUseForClient(
    principal: ClientPrincipal,
    sessionId: SessionId,
  ): 'granted' | 'denied' | 'absent' {
    const session = this.sessions.get(sessionId) ?? this.store.sessions.getSession(sessionId)
    if (!session) return 'absent'
    const command = userCommandPrincipal(asUserId(principal.user), principal.role)
    const ownership = ownershipFromMachines(this.machines)
    // machineUseDecision collapses absent+denied to 'denied' when the principal
    // cannot see the machine; attach maps both to terminalOutcome unauthorized.
    return machineUseDecision(command, session.machineId, ownership) === 'granted'
      ? 'granted'
      : 'denied'
  }

  /** Live drive gate for requestControl / controller input (POD-1081 §3). */
  authorizeClientDrive(principal: ClientPrincipal, sessionId: SessionId): boolean {
    return this.clientControl.authorizeDrive(principal, sessionId)
  }

  /** Set (replace) a session's agent action offer [spec:SP-c7f1]. A subsequent
   *  offer replaces the previous one. Persisted in the `offers` table (off-row,
   *  like snooze) and broadcast so every client's chat bar updates. */
  setOffer({
    sessionId,
    message,
    actions,
    artifacts,
  }: {
    sessionId: SessionId
    message: string
    actions: { label: string; prompt: string; input?: boolean }[]
    /** Issue-artifact paths named as evidence [POD-120]; resolved client-side. */
    artifacts?: string[]
  }): void {
    const offer = {
      message,
      actions,
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
      createdAt: new Date().toISOString(),
    }
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.store.sessions.setOffer(sessionId, offer)
      this.broadcastSessions()
      return
    }
    session.offer = offer
    this.repository.persist(session, () => this.store.sessions.setOffer(sessionId, offer))
    this.broadcastSessions()
  }

  /** Clear a session's agent action offer [spec:SP-c7f1] (explicit `offer clear`
   *  or auto-clear on the next user turn). Skips work when nothing changes. */
  clearOffer(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.clearOffer()) {
      this.store.sessions.clearOffer(sessionId)
      this.broadcastSessions()
      return
    }
    this.repository.persist(session, () => this.store.sessions.clearOffer(sessionId))
    this.broadcastSessions()
  }

  /** Agent kind may be omitted — the settings default decides ('auto' = Claude Code).
   *  `initialPrompt` hands the fresh session the human's first prompt: for argv-capable
   *  agents (claude/codex/grok) it rides the launch command (`claude "<prompt>"`,
   *  race-free); for the rest it's seeded into the composer draft. */
  /** Create a session: resolve the request, then spawn it. Delegated to
   *  {@link SessionStart}, which owns both halves. */
  createSession(input: Parameters<SessionStart['create']>[0]): SessionSpawnResult {
    return this.sessionStart.create(input)
  }

  /** The capability a relayed agent session presents: worker, scoped to the issue whose
   *  worktree it runs in (subtree), else 'none' (may read + create, but writing an existing
   *  issue needs --outside-scope). Unknown session → most-restricted. */
  capabilityForSession(sessionId: SessionId): Capability {
    const s = this.sessions.get(sessionId)
    if (!s) return { role: 'worker', scope: { kind: 'none' } }
    const attribution = { onBehalfOf: s.ownerUserId }
    // Explicit attachment wins over cwd containment (issue-as-workspace): an
    // attached / draft-bound session is scoped to ITS issue even when its cwd
    // sits in another issue's worktree (or none).
    const issueId = s.issueId ?? this.deps.issueAccess.issueForCwd(s.cwd)
    return issueId
      ? {
          role: 'worker',
          scope: { kind: 'subtree', rootId: issueId },
          actorSessionId: sessionId,
          ...attribution,
        }
      : { role: 'worker', scope: { kind: 'none' }, actorSessionId: sessionId, ...attribution }
  }

  /**
   * Server-stamped inbox identity for an authenticated capability. The
   * delegation chain and owning human are read from live session rows each time;
   * callers receive only the opaque reference that the inbox persists.
   */
  inboxPrincipalForCapability(capability: Capability): InboxPrincipalReference {
    return inboxPrincipalFromCommand(
      resolvePrincipal(capability, {
        parentSessionOf: (sessionId) =>
          sessionSpawnerParentId(this.sessions.get(sessionId)?.spawnedBy),
        onBehalfOfFor: (sessionId) => this.sessionOwner(sessionId)?.owner ?? undefined,
      }),
    )
  }

  /** In-process agent identity; absence fails closed instead of inventing one. */
  inboxPrincipalForSession(sessionId: SessionId): InboxPrincipalReference | undefined {
    return this.sessions.has(sessionId)
      ? this.inboxPrincipalForCapability(this.capabilityForSession(sessionId))
      : undefined
  }

  async resumeSession(
    input: {
      ownerUserId?: UserId
      agentKind: AgentKind
      cwd: string
      resume: ResumeRef
      conversationId: string
      title?: string
      machineId?: string
      spawnedBy?: string
      use?: MachineUseResolver
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{ sessionId: SessionId }> {
    return this.sessionRevival.resumeSession(input, issues)
  }

  private findLiveByResume(resume: ResumeRef): Session | undefined {
    return this.sessionRevival.findLiveByResume(resume)
  }

  continueSession({ sessionId }: { sessionId: SessionId }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false }
    // Status gate as well as phase: a session can read 'errored' while its
    // process is already gone (hibernated/exited), where typing 'continue' would
    // vanish into a dead PTY yet still report ok. Only a running session can retry.
    if (session.status !== 'live' && session.status !== 'starting') return { ok: false }
    if (session.agentState?.phase !== 'errored') return { ok: false }
    session.terminal.recordInputActivity(this.now())
    this.toMachine(session.machineId, {
      type: 'input',
      sessionId,
      inputOrigin: 'auto_continue',
      data: Buffer.from('continue\r').toString('base64'),
    })
    return { ok: true }
  }

  /** Durable session-state command envelope, built lazily over the module port. */
  private sessionStateRegistry: SessionStateRegistry | undefined
  private sessionStateEnvelope(): SessionStateRegistry {
    this.sessionStateRegistry ??= new SessionStateRegistry({
      sessions: this,
      state: this.state,

      mutations: this.mutations,
    })
    return this.sessionStateRegistry
  }

  private readonly mutations!: MutationLedgerPort

  /**
   * IDEMPOTENCY IS NOT THIS SERVICE'S ANYMORE (POD-382).
   *
   * `withMutation(mutationId, proc, fn)` lived here and every session write, plus
   * the whole issue registry through an injected reference to it, wrapped itself in
   * it. It is now `@podium/sync`'s `MutationLedger` — one implementation, called by
   * the command envelopes (`SessionStateRegistry.execute`, `dispatchSessionCommand`,
   * `IssueCommandCtx.withMutation`) AFTER they authorize, never by a handler.
   *
   * Deliberately not re-exposed as a delegating method: a method here is a seam a
   * new write can wrap itself in, which is exactly the per-proc shape POD-312 set
   * out to delete. The service holds {@link SessionLifecycle.mutations} privately
   * for the session-state envelope it builds and offers no public wrapper.
   */

  /**
   * The write funnel's session-metadata face: apply the field write, persist the
   * row (repository write), then enter the coalesced broadcast — whose trailing
   * run is the funnel's oplog-append → fan-out tail. Every plain metadata
   * mutation (rename/archive/read/issue attachment/work state) goes through
   * here instead of hand-rolling persist+broadcast.
   */
  private mutateSessionMeta(
    sessionId: SessionId,
    write: (session: Session) => void | (() => void),
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.funnel.run({
      write: () => {
        const additionalWrite = write(session)
        this.repository.persist(session, additionalWrite ?? undefined)
      },
    })
    this.broadcastSessions()
  }

  /** A HUMAN names the session. Delegated to {@link SessionNaming}, which owns
   *  the user-sovereign provenance rule. */
  renameSession(input: { sessionId: SessionId; name: string }): void {
    this.naming.rename(input)
  }

  /** The AGENT names its own session; refused against a user-set name. */
  setAgentName(input: { sessionId: SessionId; name: string }): {
    ok: boolean
    name?: string
    reason?: string
  } {
    return this.naming.setAgentName(input)
  }

  setArchived({ sessionId, archived }: { sessionId: SessionId; archived: boolean }): void {
    this.state.setArchived(sessionId, archived)
  }

  /** Archive parks a running process (POD-108). See SessionTeardown survival table. */
  private parkArchivedSession(sessionId: SessionId): void {
    this.sessionTeardown.parkArchivedSession(sessionId)
  }

  tryAutoArchiveStoppedObserved(
    observed: {
      sessionId: SessionId
      issueId: string | null
      stoppedAt: string
      readerUserId: string
      archived: false
    },
    nowMs: number,
  ): 'applied' | 'precondition' | 'not-due' {
    return this.sessionTeardown.tryAutoArchiveStoppedObserved(observed, nowMs)
  }

  markSessionRead(userId: string, sessionId: SessionId): void {
    this.state.markRead(this.view.principalForTrustedUser(asUserId(userId)), sessionId)
  }

  /** Mark this session UNREAD again (issue #138, the email-style inverse of
   *  markSessionRead): DELETE the actor's marker so the derived `unread` (readAt
   *  null ⇒ unread) flips back to true, then broadcast. Marking MY copy unread
   *  never touches yours. No-op for an unknown session. */
  markSessionUnread(userId: string, sessionId: SessionId): void {
    this.state.markUnread(this.view.principalForTrustedUser(asUserId(userId)), sessionId)
  }

  /**
   * Re-arm unread for EVERY reader of a session (POD-1076).
   *
   * A terminal transition used to null the one `read_at` column, which re-armed
   * unread for the whole instance because there was only one marker. Per-user
   * that is a delete across every reader's row, which is what this does — the
   * behaviour is unchanged; what changed is that it is now a statement about all
   * readers rather than an accident of there being one.
   */
  private rearmUnread(sessionId: SessionId): void {
    this.state.rearmUnreadForAll(sessionId)
  }

  /** Set (or clear with null) a session's explicit issue attachment. */
  setSessionIssueId(sessionId: SessionId, issueId: IssueId | null): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.issueId = issueId ?? undefined
      // Naming point (#474): the first attach on a still-unnamed session brands
      // it with that issue's letter. A detach (null) is NOT a naming point —
      // the session stays unnamed rather than getting a spurious DRAFT ordinal.
      if (issueId) return this.view.prepareRefAllocation(session)
    })
  }

  /** The session's explicit issue attachment (issue-as-workspace), if any. */
  getSessionIssueId(sessionId: SessionId): IssueId | null {
    return this.sessions.get(sessionId)?.issueId ?? null
  }

  setWorkState({
    sessionId,
    workState,
  }: {
    sessionId: SessionId
    workState: WorkState | null
  }): void {
    this.state.setWorkState(sessionId, workState)
  }

  /**
   * Cleanly end a session [spec:SP-9904]. Survival table lives on SessionTeardown.
   */
  async stopSession(
    input: {
      sessionId: SessionId
      force?: boolean
      selfStop?: boolean
      stopReason?: 'self' | 'parent' | 'forced'
      principal?: CommandPrincipal
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{
    ok: boolean
    reason?: string
    worktreeFreed?: boolean
    deferredKill?: boolean
  }> {
    return this.sessionTeardown.stopSession(input, issues)
  }

  finalizeDeferredStopKill(sessionId: SessionId): void {
    this.sessionTeardown.finalizeDeferredStopKill(sessionId)
  }

  async stopIssue(
    input: {
      issueId: string
      force?: boolean
      callerSessionId?: string
      principal?: CommandPrincipal
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{
    ok: boolean
    reason?: string
    stopped: string[]
    worktreeFreed: boolean
    deferredKill?: boolean
  }> {
    return this.sessionTeardown.stopIssue(input, issues)
  }

  hasValidTerminalProof(sessionId: SessionId): boolean {
    return this.terminalProof.hasValidProof(sessionId)
  }

  terminalProofMissing(sessionId: SessionId): boolean {
    return this.terminalProof.proofMissing(sessionId)
  }

  /**
   * Park a live session: kill process, keep row/transcript/resume ref.
   * Survival table lives on SessionTeardown; terminal proof is only read there.
   */
  hibernateSession(input: {
    sessionId: SessionId
    requireTerminalProof?: boolean
  }): { ok: boolean; reason?: string } {
    return this.sessionTeardown.hibernateSession(input)
  }

  /**
   * Move one resumable worktree session to another machine ([spec:SP-3f7a]).
   * Composition root for `sessions.handoff` — see SessionRevival.
   */
  handoffSession(
    input: { sessionId: SessionId; machineId: string },
    caller: HandoffCaller,
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: true; newCwd: string }> {
    return this.sessionRevival.handoffSession(input, caller, issues)
  }

  /**
   * HOW A CALLER'S `use` RIGHTS ON A MACHINE ARE RESOLVED — the seam, deliberately
   * assignable (readiness §3.1.4, ADR 3 Amendment 1 D18).
   *
   * The DEFAULT is admin-only, which is what today's fleet can express: the
   * `machines` table has no owner and no grant list (POD-1079), and every shipped
   * caller of `sessions.handoff` is the operator. POD-381's `ctx.assertMachineUse`
   * and POD-1079's grant table replace this property at the composition root — the
   * point of it being a property rather than an inline call is that enabling real
   * grants is one assignment, not a second migration through the handoff path.
   *
   * A factory of a gate, not a gate: it must re-read rights on every call, because
   * the coordinator calls it again at each apply point.
   *
   * Stays on SessionLifecycle (not SessionRevival): it is an authorization seam,
   * not a revival concern.
   */
  machineUseGate: (caller: HandoffCaller) => AssertMachineUse = (caller) =>
    machineUseGateForCapability({
      capability: caller.capability,
      // POD-381's delegation index, read from live rows: an agent's chain is
      // walked from `spawnedBy`, so it roots at exactly one human and a sub-agent
      // cannot carry a delegator its parent lacks (D16.2).
      // One parser for the `session:<id>` tag (POD-362): it brands what it
      // EXTRACTS while leaving the tag itself raw, which entities/session.ts
      // records as deliberate. This was the third hand-rolled copy of the slice.
      parentSessionOf: (sessionId) =>
        sessionSpawnerParentId(
          this.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy,
        ),
      ownership: ownershipFromMachines(this.machines),
    })

  /** Wake a hibernated/exited session under the same id [spec:SP-9904]. */
  resurrectSession(
    input: {
      sessionId: SessionId
      adoptedBinding?: SessionBindingAdoptLaunchInstruction
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.sessionRevival.resurrectSession(input, issues)
  }

  private maybeReapDraftIssue(issueId: string | null | undefined): void {
    this.sessionTeardown.maybeReapDraftIssue(issueId)
  }

  private sessionRemovalSpecs(sessionId: SessionId): EntityChangeSpec[] {
    return this.sessionTeardown.sessionRemovalSpecs(sessionId)
  }

  prepareIssueSessionDelete(issueId: string, worktreePath: string | null): SessionDeletePlan {
    const localMetas = [...this.sessions.values()].map((s) =>
      s.toMeta(this.view.overlay(s.sessionId)),
    )
    const sessionIds = sessionsForIssue(worktreePath, localMetas, issueId).map((s) => s.sessionId)
    const deletedAt = new Date(this.now()).toISOString()
    return {
      sessionIds,
      write: () => {
        this.store.sessions.softDeleteForIssue(sessionIds, issueId, deletedAt)
        for (const sessionId of sessionIds)
          this.store.sync.deleteQueuedMessagesForSession(sessionId)
      },
      changes: () => sessionIds.flatMap((sessionId) => this.sessionRemovalSpecs(sessionId)),
      apply: (changes, ledgerCursor) => {
        for (const sessionId of sessionIds) this.removeSessionRuntime(sessionId)
        this.repository.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Prepare restoration of the sessions tombstoned by one issue deletion. The
   *  durable rows and ledger upserts commit with the issue restore; runtime
   *  installation follows only after that transaction succeeds. */
  prepareIssueSessionRestore(issueId: string): SessionRestorePlan {
    const rows = this.store.sessions.loadDeletedSessionsForIssue(issueId)
    const restored = rows
      .map((row) => ({ row, session: this.repository.sessionFromStoredRow(row, 'restore') }))
      .filter((entry): entry is { row: SessionRow; session: Session } => entry.session !== null)
    return {
      sessionIds: restored.map(({ session }) => session.sessionId),
      restoredSessions: restored.map(({ session }) => this.view.wire(session)),
      write: () => this.store.sessions.restoreDeletedForIssue(issueId),
      changes: () =>
        restored.map(({ session }) => ({
          entity: 'session' as const,
          id: session.sessionId,
          op: 'upsert' as const,
          value: this.view.wire(session),
        })),
      apply: (changes, ledgerCursor) => {
        this.state.loadFromStore()
        const offers = this.store.sessions.listOffers() // [spec:SP-c7f1]
        for (const { session } of restored) {
          this.repository.installStoredSession(session, offers)
        }
        // Restored sessions may carry per-user rows; the overlay is read fresh.
        this.state.invalidateAllOverlays()
        this.repository.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Runtime half of a durable session removal. */
  private removeSessionRuntime(
    sessionId: SessionId,
    terminalRetirement?: { retiredAt: string },
  ): void {
    this.sessionTeardown.removeSessionRuntime(sessionId, terminalRetirement)
  }

  killSession(input: { sessionId: SessionId }): void {
    this.sessionTeardown.killSession(input)
  }

  private emitSessionExited(
    sessionId: SessionId,
    code: number,
    spawnedBy?: string | null,
    sourceSession?: Session,
  ): void {
    this.sessionTeardown.emitSessionExited(sessionId, code, spawnedBy, sourceSession)
  }

  private spawn(input: Parameters<SessionStart['spawn']>[0]): SessionSpawnResult {
    return this.sessionStart.spawn(input)
  }

  /**
   * Model + effort flags for a spawn message; 'auto' means no override.
   * Shared by every spawn path (fresh spawn AND resurrect) so a resumed session
   * keeps the configured model when it uses the configured coding harness.
   * `override` (from an issue's per-ticket model/effort) wins independently over
   * settings defaults — 'auto' inherits them for the configured coding harness
   * and means "no flag" for any other harness. Missing values follow the same
   * rule; selecting a different harness must not inherit that harness's model or effort
   * [spec:SP-7ff1].
   */
  /**
   * WHOSE PREFERENCES A SESSION-SPAWNING READ USES (POD-1213).
   *
   * `roles.*` and `autoContinue.*` are `preferences-personal` and live on
   * `user_preferences` now, so a read of the instance blob would see the model's
   * defaults rather than anyone's choices. `FIRST_ADMIN_USER_ID` is spelled out
   * here for the reason `IssueService.broadcastViewer` spells it out: this
   * build's transport authenticates one shared password, so the sole account is
   * the only true answer — and POD-315 replaces this body with the requesting
   * principal, with every caller already asking the question.
   */
  private settingsViewer(): UserId {
    return FIRST_ADMIN_USER_ID
  }

  // ---- the sessions FEATURE PORT for client frames (gateway/client-mux.ts) ----
  /**
   * A client connection was admitted: send it the world it is owed.
   *
   * This used to be the tail of `attachClient`, which also minted the id,
   * registered the socket and sent `welcome`. Those are the gateway's now
   * (POD-390) and this is what remains: the session/issue/conversation/machine
   * bootstrap, byte-for-byte and in the same order.
   *
   * The `principal` is carried, not consulted — the bootstrap is NOT scoped by it
   * today (the publication AUTHORITY is what narrows a scoped socket, exactly as
   * before). POD-1077 is where a principal starts deciding content.
   */
  onClientAttached(principal: ClientPrincipal, client: ClientConn): void {
    this.clientControl.onAttached(principal, client)
  }

  /** Feature-owned consequence of a successful stream-room join. */
  onRoomJoined(client: ClientConn, room: RoomRef): void {
    if (room.kind === 'session') this.browserOpen.replayPending(client)
  }

  /** Authorization/view invalidation seam: the main authority changed one client world. */
  refreshClientPublication(id: string): void {
    this.publication.refreshClient(id)
  }

  publicationMetrics(): SessionPublicationMetrics {
    return this.publication.metrics()
  }

  onClientReclaim(prior: ClientConn, next: ClientConn): void {
    this.clientControl.reclaim(prior, next)
  }

  /**
   * A client connection is gone: sweep the session state it held.
   *
   * The gateway has ALREADY removed it from the connection set when this runs
   * (`client-mux.ts` explains why that ordering is behaviour-identical: every
   * read below is off the connection object or the per-session client maps, and
   * the two recomputes at the end always ran after the removal anyway).
   */
  onClientDetached(principal: ClientPrincipal, client: ClientConn): void {
    this.clientControl.onDetached(principal, client)
  }
  /** Gateway/control-plane entrypoint for the typed session.openUrl event. */
  onOpenUrl(request: SessionOpenUrlMessage): void {
    this.browserOpen.onOpenUrl(request)
  }

  /**
   * Reconnect reclaim: a freshly connected client (`next`) presents the id of its
   * previous socket (`priorId`). Move that stale client's controller roles onto
   * `next`, then evict it. Roles are transferred BEFORE eviction so detachClient's
   * "reassign to some other attached client" fallback doesn't hand control to a
   * third party (or drop it) in the window before `next` re-sends its attaches.
   * The client's own `attach` messages (which follow `hello`) then re-establish
   * PTY membership and resume the output stream.
   */
  /**
   * One SESSION-OWNED client frame, attributed to the connection it arrived on.
   *
   * This used to be `onClientMessage` — a switch over the WHOLE client union
   * reached by id lookup, which made the sessions service the multiplexer AND
   * the socket owner for the client plane. The mux is the gateway's now
   * (POD-390); what remains is the session-owned subset the routing table
   * assigns to this port, with `SessionsClientFrame` making that subset a
   * compile-checked type rather than a comment. `ping`/`pong` is no longer here:
   * a liveness echo is transport, and the gateway answers it.
   *
   * The principal is carried and not consulted: authorization on this plane is
   * the command envelope's (`sessions.setDraft` below routes through it), and a
   * device-grade principal has nothing to decide that today's single-user trust
   * model does not already settle. See `gateway/client-principal.ts`.
   */
  onSessionClientFrame(
    principal: ClientPrincipal,
    client: ClientConn,
    message: SessionsClientFrame,
  ): void {
    this.clientControl.onFrame(principal, client, message)
  }

  /** Hand an issue the worktree its session is actually working in [spec:SP-4ef9].
   *  Two ways in: the agent DECLARES it (`podium worktree`), or the HARNESS makes its
   *  own worktree and the session's hooks start reporting from it (Claude's
   *  EnterWorktree — POD-664 left the worktree real on disk with the issue holding
   *  neither branch nor path). Podium adopts what the harness did rather than fighting
   *  it; branch and path are stamped together so the issue can never hold half of one.
   *
   *  Every guard earns its place — this stamps a path the AGENT chose, not one podium
   *  created: only a real linked worktree (a main checkout is never a workspace, and an
   *  issue claiming main would swallow every unattached session — [spec:SP-595b]), only
   *  in the issue's own repo, only when the issue owns no worktree yet, and never one
   *  another issue already owns (a `cd` into a sibling's workspace must not steal it).
   *
   *  Declaring (`podium worktree`) vs being observed makes no difference to the stamp:
   *  the guards below decide, and `explicit` only buys a send the daemon would otherwise
   *  dedup away. Both answer the same question — is the session working in a worktree
   *  its issue doesn't know about? */
  // ---- the sessions FEATURE PORT for daemon frames (gateway/daemon-mux.ts) ----
  /**
   * One SESSION-OWNED daemon frame, attributed to the machine that sent it.
   *
   * This used to be `onDaemonMessageFrom` — a switch over the WHOLE daemon union,
   * which made the sessions service the multiplexer for host metrics, repo scans,
   * credential relays, approvals, the agent relay and every RPC reply. The mux is
   * the gateway's now (POD-389); what remains is the session-keyed subset the
   * routing table assigns to this port, and `SessionsDaemonFrame` makes that
   * subset a compile-checked type rather than a comment.
   *
   * The frames are session-keyed and machine-agnostic in their LOOKUP, but the
   * machine still matters: several cases refuse a frame from a machine that does
   * not own the session (handoff leaves a stale daemon able to send late frames
   * for a session id now hosted elsewhere), and every write they make is a
   * daemon-class observation attributed to `principal`.
   */
  onSessionDaemonFrame(principal: MachinePrincipal, msg: SessionsDaemonFrame): void {
    this.daemonLifecycle.handle(principal, msg)
  }

  transcriptFor(sessionId: SessionId): TranscriptItem[] {
    return this.sessions.get(sessionId)?.terminal.transcriptItems() ?? []
  }

  /** Raw fan-out to every connected client. Typed LIVE-ONLY (modules/
   *  message-class, issue #190): durable entity messages must go through the
   *  write funnel's publish tail instead, so passing one here is a type error.
   *  `exceptClientId` skips the originator (draft echo suppression).
   *
   *  The MECHANISM is the gateway registry's (POD-390); this method is the
   *  feature's typed entry point to it, and the LiveServerMessage constraint is
   *  why it stays a method rather than becoming a call to `registry.broadcast`
   *  at 8 sites — the registry deliberately has no opinion about message class. */
  broadcastToClients(msg: LiveServerMessage, opts: { exceptClientId?: string } = {}): void {
    this.clients.broadcast(msg, opts)
  }

  broadcastSessions(): void {
    this.broadcasts.broadcast()
  }

  flushBroadcasts(): void {
    this.broadcasts.flush()
  }

  onFeedPublished(seq: number): void {
    this.publication.onFeedPublished(seq)
  }

  deliverEntityMessage(client: ClientConn, message: ServerMessage): void {
    this.publication.deliver(client, message)
  }

  syncChangesSince(
    cursor: number | null,
    authority?: PublicationAuthority,
  ): SyncChangesSinceResult {
    return this.publication.syncChangesSince(cursor, authority)
  }
}
