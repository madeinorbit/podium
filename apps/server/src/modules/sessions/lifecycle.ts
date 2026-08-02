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
import { type EntityChangeSpec, MutationLedger, type MutationLedgerPort } from '@podium/sync'
import { AutoContinueController } from '../../auto-continue'
import {
  type CommandPrincipal,
  resolvePrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import { isFeatureEnabled } from '../../features'
import { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsClientFrame } from '../../gateway/client-frame-routing'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { type ClientConn, ClientRegistry } from '../../gateway/client-registry'
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
import { HeadlessService } from '../superagent/headless'
import { resolveAccountEnv } from './account-env'
import { SessionClientControl } from './client-control'
import { machinesForPrincipal as projectMachinesForPrincipal } from './command-ctx'
import { SessionDaemonLifecycle } from './daemon-lifecycle'
import { SessionDaemonProjection } from './daemon-projection'
import { machineUseGateForCapability } from './handoff/access'
import { HandoffCoordinator } from './handoff/coordinator'
import type { AssertMachineUse, HandoffCaller, HandoffPorts } from './handoff/ports'
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

import { SessionLaunchConfig } from './launch-config'
import { SessionMachineReconciler } from './machine-reconciler'
import { normalizeAgentName, SessionNaming } from './naming'
import { SessionObservationLeases } from './observation-leases'
import { SessionBroadcastCoordinator } from './publication/broadcast'
import {
  SessionPublicationCoordinator,
  type SessionPublicationMetrics,
  type SnapshotTail,
} from './publication/coordinator'
import type { SessionProjectionEvent } from './publish-worker-actor'
import { PublishWorkerClient } from './publish-worker-client'
import { SessionRepository } from './repository'
import type { PublicationAuthority, Session } from './session'
import { assertMayCommandSession, resolveSessionTarget } from './session-access'
import { SessionBindingReceipts } from './session-binding'
import { SessionStart } from './session-start'
import { SessionStateRegistry, sessionStatePrincipalFor } from './session-state/registry'
import { type SessionStatePrincipal, SessionStateService } from './session-state/service'
import { SessionTerminalProof } from './terminal-proof'
import { SessionView } from './view'
import { SessionWorkspace } from './workspace'

/**
 * Idempotency records outlive any sane replay horizon, then get pruned. ADR 2 D11
 * owns this number and this is its prune site.
 *
 * EXPORTED because ADR 3 D11.3 requires the outbox age inequality
 * (`OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS < RECEIPT_RETENTION_MS`) to IMPORT it
 * rather than copy `30d` into the check — a copy is a comment that fails open the
 * day this line is tuned. The importer is
 * `receipt-retention.test.ts` beside this file: `packages/*` may not import
 * `apps/*`, so the invariant is asserted on this side of that boundary, against
 * the live constant. Lowering this value below the outbox horizon fails that test.
 */
export const APPLIED_MUTATIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

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

interface SessionLifecycleDeps {
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
  readonly sessions: Map<SessionId, Session>
  /**
   * THE CLIENT CONNECTION SET — OWNED BY THE GATEWAY (POD-390).
   *
   * Held as a reference, not constructed here: `gateway/client-mux.ts` adds and
   * removes entries, and this service only READS the set to decide who a given
   * message is for. That read is the fan-out's selection half and it stays a
   * feature concern (see `gateway/client-registry.ts`); the delivery half is the
   * registry's methods.
   */
  readonly clients: ClientRegistry

  /** Durable observer leases, hydrated before session state restoration. */
  private readonly observationLeases = new SessionObservationLeases()
  /** Terminal-proof reasoning over the lease book (POD-1396). */
  private readonly terminalProof: SessionTerminalProof
  /** Daemon presence reconciliation for one machine (POD-1396). */
  private readonly machineReconciler: SessionMachineReconciler
  /** The curated name slot and its provenance rule (POD-1396). */
  private readonly naming: SessionNaming
  /** Model/effort/credential resolution for a spawn frame (POD-1396). */
  private readonly launchConfig: SessionLaunchConfig
  /** Request resolution + spawn-frame construction (POD-1396). */
  private readonly sessionStart: SessionStart

  private readonly store: SessionStore
  private readonly now: () => number
  private readonly bus: EventBus
  private readonly machines: MachinesService
  private readonly rpc: DaemonRpcService
  readonly headless: HeadlessService
  /** Durable viewer/shared-surface state, isolated behind explicit ports. */
  readonly state: SessionStateService
  /** Backend auto-continue loop — re-arms retryable errored agents. */
  private readonly autoContinue: AutoContinueController
  /** Attributed inbound text, answers, FIFO queueing and controller gating. */
  readonly inbox: SessionInbox
  readonly sendText: SessionInbox['sendText']
  readonly interruptText: SessionInbox['interruptText']
  readonly queueText: SessionInbox['queueText']
  readonly resumeAndSend: SessionInbox['resumeAndSend']
  readonly answerAskUserQuestion: (input: {
    sessionId: SessionId
    choices: { optionIndices: number[] }[]
    principal?: InboxPrincipalReference
  }) => { ok: boolean }
  readonly setSessionDraft: (
    input: { sessionId: SessionId; text: string },
    fromClientId?: string,
  ) => void
  readonly draftRevision: SessionStateService['draftRevision']
  /** The `sessions.handoff` handler (POD-642), built on first use. It holds the
   *  single-flight registry that stops a duplicate dispatch from forking a
   *  session, so it must outlive one call — see `handoffs()`. */
  private handoffCoordinator?: HandoffCoordinator
  /** The write funnel — owns the durable metadata oplog (docs/spec/oplog-read-path.md). */
  private readonly funnel: WriteFunnel
  readonly publication: SessionPublicationCoordinator
  readonly clientControl: SessionClientControl
  readonly daemonProjection: SessionDaemonProjection
  private readonly daemonLifecycle: SessionDaemonLifecycle
  readonly workspace: SessionWorkspace
  readonly view: SessionView
  readonly repository: SessionRepository

  private issueProjectionGeneration = 0
  readonly broadcasts: SessionBroadcastCoordinator
  private readonly browserOpen: BrowserOpenGateway
  private readonly bindingReceipts: SessionBindingReceipts
  // Single timer that persists only sessions whose activity counters advanced
  // since the last tick — keeps the per-frame / per-keystroke path off the DB.
  private readonly activityFlushTimer = setInterval(() => this.repository.flushActivity(), 12_000)

  constructor(private readonly deps: SessionLifecycleDeps) {
    this.store = deps.store
    this.sessions = deps.sessions ?? new Map()
    this.now = deps.now
    this.mutations = deps.mutations ?? new MutationLedger(this.store.sync, () => this.now())
    this.clients = deps.clients ?? new ClientRegistry()
    this.bus = deps.bus
    this.machines = deps.machines
    this.rpc = deps.rpc
    this.activityFlushTimer.unref?.()
    this.funnel = deps.funnel
    this.terminalProof = new SessionTerminalProof({
      now: () => this.now(),
      leases: this.observationLeases,
      checkpoints: this.store.observationCheckpoints,
      sessions: () => this.sessions.values(),
      session: (sessionId) => this.sessions.get(sessionId),
      pendingForProof: (sessionId, atIso) =>
        this.store.messages.pendingForSessionProof(sessionId, atIso),
      isDraining: (sessionId) => this.inbox.isDraining(sessionId),
      autoContinueActive: (sessionId) => this.autoContinue.isActive(sessionId),
    })
    this.launchConfig = new SessionLaunchConfig({
      store: this.store,
      settingsViewer: () => this.settingsViewer(),
    })
    this.naming = new SessionNaming({
      session: (sessionId) => this.sessions.get(sessionId),
      mutate: (sessionId, write) => this.mutateSessionMeta(sessionId, write),
    })
    this.machineReconciler = new SessionMachineReconciler({
      sessions: () => this.sessions.values(),
      drainInbox: (sessionId) => this.inbox.drain(sessionId),
      triggerLakeSweep: (machineId) => this.deps.memory.triggerLakeSweep(machineId),
      resetPriorities: () => this.state.resetPriorities(),
      pushPriorities: () => this.pushPriorities(),
      parkArchivedSession: (sessionId) => this.parkArchivedSession(sessionId),
      reattachMessage: (session, machineId) => this.reattachMessageFor(session, machineId),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      viewTiers: (sessionIds) => computePriorities([...this.clients.values()], sessionIds),
      rebindHeadless: (session) => this.rebindHeadless(session),
      markVolatileSessionDirty: (sessionId, fields) =>
        this.repository.markVolatileSessionDirty(sessionId, fields),
      broadcastSessions: () => this.broadcastSessions(),
    })
    const publicationWorker = deps.publicationWorker ?? new PublishWorkerClient()
    this.publication = new SessionPublicationCoordinator({
      clients: this.clients,
      worker: publicationWorker,
      funnel: this.funnel,
      shadowCompare: deps.publicationShadowCompare ?? false,
      generation: () => this.repository.sessionsGeneration(),
      sessions: () => this.sessions,
      listSessions: () => this.listSessions(),
      snapshotTail: deps.snapshotTail,
    })
    this.broadcasts = new SessionBroadcastCoordinator({
      hasPendingVolatile: () => this.repository.hasPendingVolatile(),
      scheduleVolatileCapture: () => this.repository.scheduleVolatileSessionCapture(),
      flushVolatileCaptures: () => {
        this.repository.flushVolatileSessionCaptures()
      },
      generation: () => this.repository.sessionsGeneration(),
      issueGeneration: () => this.issueProjectionGeneration,
      listSessions: () => this.listSessions(),
      schedulePublication: (options) => this.publication.schedule(options),
      publishIssues: (sessions) => this.bus.emit('session.listChanged', { sessions }),
      flushDeltas: () => this.funnel.flushDeltas(),
    })
    this.browserOpen = new BrowserOpenGateway({
      now: () => this.now(),
      clients: this.clients,
      subscriptions: this.deps.subscriptions,
      session: (sessionId) => this.sessions.get(sessionId),
      sessionOwner: (sessionId) => this.sessionOwner(sessionId),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
    })
    this.bindingReceipts = new SessionBindingReceipts({
      memory: this.deps.memory,
      now: () => this.now(),
      sessions: () => this.sessions.values(),
      session: (sessionId) => this.sessions.get(sessionId),
      sessionOwner: (sessionId) => this.sessionOwner(sessionId),
      persist: (session) => this.repository.persist(session),
      broadcastSessions: () => this.broadcastSessions(),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
    })
    this.daemonProjection = new SessionDaemonProjection({
      sessions: this.sessions,
      recordSessionGitActivity: (sessionId, input) =>
        this.bus.emit('issue.sessionDerived', { kind: 'gitActivity', sessionId, ...input }),
      binding: this.bindingReceipts,
      persist: (session) => this.repository.persist(session),
      broadcastSessions: () => this.broadcastSessions(),
      broadcastToClients: (message) => this.broadcastToClients(message),
      adoptWorktree: (issueId, message) =>
        this.bus.emit('issue.sessionDerived', { kind: 'adoptWorktree', issueId, message }),
    })

    this.workspace = new SessionWorkspace({
      store: this.store,
      rpc: this.rpc,
      machines: this.machines,
      issueAccess: this.deps.issueAccess,
      getSession: (sessionId) => this.sessions.get(sessionId),
      settingsViewer: () => this.settingsViewer(),
      onWorktreesChanged: (repoPath, machineId) =>
        this.deps.onWorktreesChanged(repoPath, machineId),
    })

    this.state = new SessionStateService({
      store: this.store,
      now: () => this.now(),
      getSession: (sessionId) => this.sessions.get(sessionId),
      sessionIds: () => this.sessions.keys(),
      clients: () => this.clients.values(),
      sessionOwner: (sessionId) => this.sessionOwner(sessionId),
      persistSession: (sessionId, additionalWrite) => {
        const session = this.sessions.get(sessionId)
        if (session) this.repository.persist(session, additionalWrite)
      },
      mutateSession: (sessionId, mutate) => {
        this.mutateSessionMeta(sessionId, (session) => mutate(session))
      },
      broadcastSessions: () => this.broadcastSessions(),
      broadcastToClients: (message, options) => this.broadcastToClients(message, options),
      deliverToClient: (clientId, message) => {
        const client = this.clients.get(clientId)
        if (client) this.clients.deliver(client, message)
      },
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      onArchived: (sessionId) => {
        this.bus.emit('issue.sessionDerived', { kind: 'removedOrArchived', sessionId })
        this.maybeReapDraftIssue(this.sessions.get(sessionId)?.issueId)
        this.parkArchivedSession(sessionId)
      },
    })
    this.view = new SessionView({
      sessions: this.sessions,
      store: this.store,
      machines: this.machines,
      state: this.state,
    })
    this.repository = new SessionRepository({
      sessions: this.sessions,
      store: this.store,
      memory: this.deps.memory,
      ledger: this.deps.ledger,
      publication: this.publication,
      funnel: this.funnel,
      view: this.view,
      state: this.state,
      observationLeases: this.observationLeases,
      autoContinue: () => this.autoContinue,
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      broadcastSessions: () => this.broadcastSessions(),
      flushBroadcasts: () => this.broadcasts.flush(),
      listSessions: () => this.view.list(),
      now: () => this.now(),
      appliedMutationMaxAgeMs: APPLIED_MUTATIONS_MAX_AGE_MS,
    })
    // CONSTRUCTED HERE, NOT EARLIER, AND THE POSITION IS LOAD-BEARING.
    // SessionStart takes view, repository and state as direct references, so it
    // must be built after all three exist. The compiler caught this when it was
    // placed with the other POD-1396 modules near the top of the constructor
    // ("Property 'view' is used before being assigned") — worth recording
    // because scripts/server-construction-order.ts walks only the RELAY root and
    // would NOT have caught a reordering in here (POD-1411).
    this.sessionStart = new SessionStart({
      store: this.store,
      view: this.view,
      repository: this.repository,
      state: this.state,
      launchConfig: this.launchConfig,
      terminalProof: this.terminalProof,
      settingsViewer: () => this.settingsViewer(),
      durableLabelFor: (sessionId) => this.deps.durableLabelFor(sessionId),
      hasSession: (sessionId) => this.sessions.has(sessionId),
      registerSession: (session) => {
        this.sessions.set(session.sessionId, session)
      },
      sessionMachineId: (sessionId) => this.sessions.get(sessionId)?.machineId,
      defaultMachine: () => this.machines.defaultMachine(),
      machineName: (machineId) => this.machines.machineName(machineId),
      resolveMachineForAgent: (requested, cwd, agentKind, use) =>
        this.machines.resolveMachineForAgent(requested, cwd, agentKind, use),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      broadcastSessions: () => this.broadcastSessions(),
      soleOwnerForCwd: (cwd) => this.deps.issueAccess.soleOwnerForCwd(cwd) ?? undefined,
      instructionsForStart: (i) => this.deps.instructionsForStart(i),
      sessionOwner: (sessionId) => this.sessionOwner(sessionId),
      setSessionDraft: (i, fromClientId) => this.setSessionDraft(i, fromClientId),
      emitSessionCreated: (payload) => this.bus.emit('session.created', payload),
    })
    this.headless = new HeadlessService({
      durableLabelFor: (sessionId) => this.deps.durableLabelFor(sessionId),
      getSession: (sessionId) => this.sessions.get(sessionId),
      registerSession: (session) => this.sessions.set(session.sessionId, session),
      resolveMachine: (requested, cwd, agentKind) =>
        this.machines.resolveMachineForAgent(requested, cwd, agentKind),
      defaultMachine: () => this.machines.defaultMachine(),
      toMachine: (machineId, message) => this.machines.toMachine(machineId, message),
      nextRequestId: (prefix) => this.rpc.nextRequestId(prefix),
      defaultGeometry: () => ({ ...DEFAULT_GEOMETRY }),
      persist: (session) => this.persist(session),
      broadcastSessions: () => this.broadcastSessions(),
      clients: () => this.clients.values(),
    })
    this.inbox = new SessionInbox({
      getSession: (sessionId) => this.sessions.get(sessionId),
      queue: {
        enqueue: (row) => {
          const actor = inboxActorColumns(row.principal.attribution.actor)
          return this.store.sync.enqueueMessage({
            id: row.id,
            sessionId: row.sessionId,
            text: row.text,
            queuedAt: row.queuedAt,
            inputOrigin: row.inputOrigin,
            principalKind: row.principal.kind,
            principalRef: row.principal.principalRef,
            delegationRef: row.principal.delegation,
            actorKind: actor.actorKind,
            actorId: actor.actorId,
            onBehalfOf: row.principal.attribution.onBehalfOf,
            sourceMessageId: row.sourceMessageId,
          })
        },
        list: (sessionId) =>
          this.store.sync.listQueuedMessages(sessionId).map((row) => ({
            id: row.id,
            text: row.text,
            attempts: row.attempts,
            inputOrigin: row.inputOrigin,
            principal: {
              kind: row.principalKind,
              principalRef: row.principalRef,
              delegation: row.delegationRef ? asDelegationRef(row.delegationRef) : null,
              attribution: {
                actor: inboxActorFromColumns(row.actorKind, row.actorId),
                onBehalfOf: row.onBehalfOf ? asUserId(row.onBehalfOf) : null,
              },
            },
            sourceMessageId: row.sourceMessageId,
          })),
        bumpAttempts: (id) => this.store.sync.bumpQueuedAttempts(id),
        delete: (id) => this.store.sync.deleteQueuedMessage(id),
      },
      daemon: {
        sendInput: (machineId, message) => this.toMachine(machineId, message),
      },
      authorization: {
        authorizeAtDrain: (input) => this.authorizeQueuedInputAtApply(input),
        rejected: ({ sourceMessageId, reason }) => {
          if (sourceMessageId) this.deps.rejectQueuedMessage?.(sourceMessageId, reason)
        },
      },
      attention: {
        stateChanged: (input) => this.bus.emit('session.stateChanged', input),
        answered: ({ ownerUserId, sessionId, attribution }) => {
          this.store.events.appendEvent({
            ts: new Date(this.now()).toISOString(),
            kind: 'session.inbox.answered',
            subject: sessionId,
            payload: { sessionId, ownerUserId, attribution },
          })
        },
      },
      now: () => this.now(),
      persist: (session, options) =>
        this.repository.persist(
          session,
          options?.cancelTerminalCandidate
            ? () => this.store.observationCheckpoints.cancelTerminalCandidate(session.sessionId)
            : undefined,
        ),
      broadcast: () => this.broadcastSessions(),
      needsSubmitVerification: harnessNeedsSubmitVerification,
      prepareSend: (sessionId, attribution, kind) =>
        this.prepareInboxSend(sessionId, attribution, kind),
      ownerOf: (sessionId) => this.sessionOwner(sessionId)?.owner,
      resurrect: async (sessionId, principal) => {
        this.bus.emit('session.wakeRequested', { sessionId, principal })
        return { ok: true }
      },
    })
    this.sendText = (input) => this.inbox.sendText(input)
    this.interruptText = (input) => this.inbox.interruptText(input)
    this.queueText = (input) => this.inbox.queueText(input)
    this.resumeAndSend = (input) => this.inbox.resumeAndSend(input)
    this.answerAskUserQuestion = (input) =>
      this.inbox.answerAskUserQuestion({
        ...input,
        principal: input.principal ?? SYSTEM_INBOX_PRINCIPAL,
      })
    this.setSessionDraft = (input, fromClientId) => this.state.setDraft(input, fromClientId)
    this.draftRevision = (sessionId) => this.state.draftRevision(sessionId)
    this.clientControl = new SessionClientControl({
      sessions: this.sessions,
      publication: this.publication,
      state: this.state,
      inbox: this.inbox,
      machinesForPrincipal: (principal) =>
        projectMachinesForPrincipal(
          { machines: this.machines },
          userCommandPrincipal(asUserId(principal.user), principal.role),
        ),
      browserOpen: this.browserOpen,
      mutate: (sessionId, change, issueRelevant) =>
        this.repository.mutateSessionView(sessionId, change, issueRelevant),
      broadcastSessions: () => this.broadcastSessions(),
      pushPriorities: () => this.pushPriorities(),
      setDraft: (principal, clientId, sessionId, text) => {
        this.sessionStateEnvelope().execute(
          'sessions.setDraft',
          { sessionId, edit: { kind: 'replace', text } },
          sessionStatePrincipalFor(
            userCommandPrincipal(asUserId(principal.user), principal.role),
            clientId,
          ),
          'ws',
        )
      },
      editDraft: (message, clientId) => this.state.handleDraftEdit(message, clientId),
    })

    this.autoContinue = new AutoContinueController({
      // PERSONAL (POD-1213): auto-continue governs the reader's OWN sessions,
      // so it is resolved for a user. See `settingsViewer` below for why that
      // user is spelled out rather than defaulted.
      isEnabled: () =>
        this.store.settings.getSettingsFor(this.settingsViewer()).autoContinue.enabled,
      sendContinue: (sessionId) => {
        this.continueSession({ sessionId })
      },
      getSession: (sessionId) => {
        // The controller re-arms off fresh agentState events, so overnight recovery
        // after a daemon reattach relies on reattach re-seeding agentState (seedBootState).
        const s = this.sessions.get(sessionId)
        if (!s) return undefined
        return { live: s.status === 'live' || s.status === 'starting', state: s.agentState }
      },
    })
    this.daemonLifecycle = new SessionDaemonLifecycle({
      sessions: this.sessions,
      bus: this.bus,
      browserOpen: this.browserOpen,
      autoContinue: this.autoContinue,
      inbox: this.inbox,
      state: this.state,
      projection: this.daemonProjection,
      store: this.store,
      memory: this.deps.memory,
      observationLeases: this.observationLeases,
      persist: (session, additionalWrite) => this.repository.persist(session, additionalWrite),
      broadcastSessions: () => this.broadcastSessions(),
      onSessionActivity: (sessionId) =>
        this.bus.emit('issue.sessionDerived', { kind: 'activity', sessionId }),
      onSessionAttention: (sessionId) =>
        this.bus.emit('issue.sessionDerived', { kind: 'attention', sessionId }),
      onSessionTurnEnd: (sessionId) =>
        this.bus.emit('issue.sessionDerived', { kind: 'turnEnd', sessionId }),
      maybeReapDraftIssue: (issueId) => this.maybeReapDraftIssue(issueId),
      emitSessionExited: (sessionId, code, spawnedBy) =>
        this.emitSessionExited(sessionId, code, spawnedBy),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      now: () => this.now(),
      terminalCandidateFacts: (session, lease, checkpoint) =>
        this.terminalProof.facts(session, lease, checkpoint),
      broadcastToClients: (message) => this.broadcastToClients(message),
      clearOffer: (sessionId) => this.clearOffer(sessionId),
    })
    // Auto-continue re-arm on the settings flip — the reaction needs the sessions
    // map, so it lives here as a bus subscriber (this service is constructed AFTER
    // NotifyService, so the notification replay keeps firing first).
    this.bus.on('settings.changed', ({ previous, next }) => {
      // Keep the cached draftSync flag current (POD-859). Resolved through the
      // canonical experiments system (channel/config/user) [spec:SP-f4b9].
      this.state.setDraftSyncEnabled(isFeatureEnabled('draft-sync', next))
      const wasEnabled = previous.autoContinue.enabled
      const nowEnabled = next.autoContinue.enabled
      if (nowEnabled === wasEnabled) return
      const ids = nowEnabled
        ? [...this.sessions.values()]
            .filter(
              (s) =>
                (s.status === 'live' || s.status === 'starting') &&
                s.agentState?.phase === 'errored' &&
                s.agentState.error?.retryable === true,
            )
            .map((s) => s.sessionId)
        : []
      this.autoContinue.onSettingsChanged(nowEnabled, ids)
    })
    // Agent mail send-time nudge (issue #103): poke the target issue's live agent
    // session so mail is noticed without polling. The nudge carries NO message
    // body — an idempotent "check your inbox" poke. Selection: a single idle
    // live agent gets an immediate sendText; otherwise the most recently active
    // live agent gets a durable queued send; no live agents → nothing (the mail
    // surfaces via prime / the stop-hook).
    this.bus.on('issue.mailSent', ({ seq, worktreePath }) => {
      const members = sessionsForIssue(worktreePath ?? null, this.listSessions())
      const target = selectMailNudgeSession(members)
      if (!target) return
      const text = `You have mail on issue #${seq}: run 'podium issue mail inbox' (claim with 'podium issue mail claim <id>' only if you will act on it).`
      if (target.mode === 'send') this.sendText({ sessionId: target.sessionId, text })
      else void this.queueText({ sessionId: target.sessionId, text })
    })
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
      /** Provenance for the FRESH-SPAWN fallback only (issue #60). When the resume
       *  lands on an existing row (reuse/resurrect below), that row's original
       *  spawnedBy is kept — a resume never rewrites who created the session. */
      spawnedBy?: string
      /** The calling principal's `use` decision per machine — see createSession. */
      use?: MachineUseResolver
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{ sessionId: SessionId }> {
    // One row per conversation. A conversation is identified by its durable
    // resume ref (kind+value); resuming one that already has a row must REUSE
    // that row, never mint a parallel one. Each parallel row spawned its own
    // durable master and forked its own transcript, while the web only HID the
    // siblings (dedupeSessionsByResume) — so closing the visible row revealed a
    // masked duplicate with its own title/transcript/stage. Reuse kills that at
    // the source: a running row is focused as-is; a parked (hibernated/exited)
    // row is resurrected under its same id.
    const existing = this.findLiveByResume(input.resume)
    if (existing) {
      if (existing.status === 'hibernated' || existing.status === 'exited') {
        const woke = await this.resurrectSession({ sessionId: existing.sessionId }, issues)
        if (!woke.ok) throw new Error(woke.reason ?? 'failed to resume parked session')
      } else {
        // Reopening a still-live but long-idle session also resets its hibernation
        // timer — the user is back on it even with no new message. (resurrectSession
        // already stamps this for the parked case above.)
        this.sessions.get(existing.sessionId)?.markResumed()
      }
      return { sessionId: existing.sessionId }
    }
    const issueId = this.deps.issueAccess.soleOwnerForCwd(input.cwd) ?? undefined
    // MINT SITE: a server-minted session id. The brand belongs where the id is
    // GENERATED — nothing upstream had it, so this is not an adapter cast.
    const sessionId = asSessionId(randomUUID())
    const preparedInstructions = this.deps.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind: input.agentKind,
      ...(issueId ? { issueId } : {}),
    })
    const spawned = this.spawn({
      agentKind: input.agentKind,
      ownerUserId: input.ownerUserId ?? FIRST_ADMIN_USER_ID,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
      machineId: this.machines.resolveMachineForAgent(
        input.machineId,
        input.cwd,
        input.agentKind,
        input.use,
      ),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(issueId ? { issueId } : {}),
      sessionId,
    })
    preparedInstructions.commit()
    return spawned
  }

  /**
   * The existing session for a resume ref, if any — the canonical row for that
   * conversation. Prefers a still-running row (live/starting/reconnecting) over a
   * parked one, breaking ties toward the most-recently-active so we land on the
   * row the user last touched.
   */
  private findLiveByResume(resume: ResumeRef): Session | undefined {
    const running = (s: Session) =>
      s.status === 'live' || s.status === 'starting' || s.status === 'reconnecting'
    return (
      [...this.sessions.values()]
        // A HEADLESS session shares its harness's resume ref but is not a PTY
        // reuse target — "open in terminal" resumes the same ref as a real PTY
        // session alongside it, so headless rows never satisfy this lookup.
        .filter(
          (s) => !s.headless && s.resume?.kind === resume.kind && s.resume?.value === resume.value,
        )
        .sort((a, b) => {
          if (running(a) !== running(b)) return running(a) ? -1 : 1
          return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')
        })
        .at(0)
    )
  }

  /**
   * The overview "Continue" button: nudge an errored agent to retry by typing
   * `continue⏎` into its PTY. Guarded to the errored phase so a stray click
   * can't inject text into a healthy prompt.
   */
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

  private readonly mutations: MutationLedgerPort

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

  /**
   * Archive also stops the process (POD-108). Archive used to be pure metadata,
   * so every archived-but-live session kept its abduco master + agent resident
   * forever — dozens of idle agent processes with no way to reap them from the
   * UI. Same park as stopSession: 'hibernated' when a cold resume is possible
   * (resume ref kept), else 'exited'. Unlike hibernateSession this does not
   * refuse a working agent — the archive guard already made the user confirm
   * archiving a working session, and that confirmed intent is "stop it".
   * Unarchiving does NOT resurrect; that stays an explicit resume.
   */
  private parkArchivedSession(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const running =
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'
    if (!running) return
    if (session.agentKind !== 'shell' && !session.resume) {
      session.status = 'exited'
      session.exitCode = session.exitCode ?? 0
    } else {
      session.status = 'hibernated'
    }
    this.autoContinue.onSessionGone(sessionId)
    session.stoppedAt = new Date(this.now()).toISOString()
    session.stopReason = 'parent'
    // Unlike stopSession, readAt is left alone: archiving IS the acknowledgment —
    // resurfacing the session as unread would undo the tidy-up the user just did.
    this.repository.persist(session)
    this.killStoppedSession(session)
    this.broadcastSessions()
  }

  /** Authoritatively revalidate a stopped-session decay proposal [spec:SP-6144]. */
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
    const session = this.sessions.get(observed.sessionId)
    if (!session || session.archived) return 'precondition'
    // WHOSE read (POD-1229) — see `IssueAttention.tryAutoArchiveObserved` for the
    // reasoning. `archived` is shared, so only the viewer this service archives
    // for may gate it, and a proposal naming anyone else is refused outright.
    if (observed.readerUserId !== this.view.broadcastViewer()) return 'precondition'
    // NO compare-and-swap against an observed timestamp (POD-1229 removed it),
    // and no `readAt == null` clause here either: both cases the CAS caught are
    // refused by the checks below — a re-read lands inside the `not-due` window,
    // and a mark-unread makes `Date.parse(null ?? '')` NaN. A guard that can be
    // deleted with every test still green is indistinguishable from an absent
    // one, so the refusal lives in exactly one place.
    if (
      (session.issueId ?? null) !== observed.issueId ||
      session.stoppedAt !== observed.stoppedAt
    ) {
      return 'precondition'
    }
    const stoppedMs = Date.parse(session.stoppedAt ?? '')
    const readMs = Date.parse(this.view.overlay(observed.sessionId).readAt ?? '')
    if (!Number.isFinite(stoppedMs) || !Number.isFinite(readMs) || readMs < stoppedMs) {
      return 'precondition'
    }
    if (Math.max(stoppedMs, readMs) > nowMs - AUTO_ARCHIVE_READ_WINDOW_MS) return 'not-due'
    if (session.issueId) {
      const issue = this.deps
        .snapshotTail()
        .issues.find((candidate) => candidate.id === session.issueId)
      if (!issue || issue.parentId) return 'precondition'
    }
    this.setArchived({ sessionId: session.sessionId, archived: true })
    return 'applied'
  }

  /** Mark a session read (issue #124): stamp readAt = now on the ACTOR's own
   *  `(userId, sessionId)` row (POD-1076), then broadcast. The derived `unread`
   *  flips to false immediately (readAt is now the latest timestamp) and re-arms
   *  on the next activity. No-op for an unknown session. */
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
   * Cleanly end a session [spec:SP-9904]: stop its process, free the issue
   * worktree when safe, KEEP branch + transcript + session row (reversible —
   * resume recreates the worktree from the branch). Distinct from hibernate
   * (keeps worktree) and kill/delete (removes the row).
   *
   * Unsaved-work guard: dirty/conflicted working tree refuses without `force`.
   * Self-stop (`selfStop`) defers the process kill so the CLI/relay reply
   * lands before the agent dies.
   */
  async stopSession(
    input: {
      sessionId: SessionId
      force?: boolean
      /** True when the CALLER is stopping itself — defer process kill. */
      selfStop?: boolean
      /** Parent-close/issue-stop provenance; direct forced stops derive below. */
      stopReason?: 'self' | 'parent' | 'forced'
      /**
       * Who asked for the stop (POD-1344). Stamped onto the free-worktree audit
       * comment. Absent only on genuinely caller-less paths (tests, in-process
       * jobs) — those fall back to `systemPrincipal('stop')`.
       */
      principal?: CommandPrincipal
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{
    ok: boolean
    reason?: string
    worktreeFreed?: boolean
    deferredKill?: boolean
  }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }

    const issueId = session.issueId ?? this.deps.issueAccess.issueForCwd(session.cwd)
    const issue = issueId ? this.deps.issueAccess.getMeta(issueId) : undefined
    const worktreePath = issue?.worktreePath ?? null

    // Unsaved-work guard: inspect the working copy when present. Branch commits
    // alone are not a refusal — the branch is always kept.
    if (worktreePath && !input.force) {
      const st = await this.rpc.repoOp('status', worktreePath, undefined, session.machineId)
      if (st.ok) {
        const dirty = st.output.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('## '))
        if (dirty.length > 0) {
          return {
            ok: false,
            reason: `refusing stop: unsaved changes in the working tree (re-run with --force to free the worktree and discard them; branch is kept either way):\n${dirty.join('\n')}`,
          }
        }
      } else if (!/cannot change to .*: no such file or directory/i.test(st.output)) {
        return {
          ok: false,
          reason: `refusing stop: cannot inspect worktree: ${st.output}`,
        }
      }
    }

    const wasRunning =
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'

    // Park the row first (keep resume ref + transcript). Shells have no resume
    // ref — stop still parks them as exited so they stay inspectable.
    if (wasRunning) {
      if (session.agentKind !== 'shell' && !session.resume) {
        // No resume ref yet: still stop the process but mark exited rather than
        // hibernated (same inspectability; resume may not recover conversation).
        session.status = 'exited'
        session.exitCode = session.exitCode ?? 0
      } else {
        session.status = 'hibernated'
      }
      this.autoContinue.onSessionGone(input.sessionId)
      // A terminal transition is new unread information; acknowledgment begins only
      // after the operator opens it again. [spec:SP-6144]
      session.stoppedAt = new Date(this.now()).toISOString()
      // 'forced' is reserved for --force (work may be discarded); a plain
      // operator/parent stop is an orderly park, labeled 'parent'. [spec:SP-6144]
      session.stopReason = input.force
        ? 'forced'
        : (input.stopReason ?? (input.selfStop ? 'self' : 'parent'))
      this.rearmUnread(input.sessionId)
      this.repository.persist(session, () =>
        this.store.observationCheckpoints.cancelTerminalCandidate(input.sessionId),
      )
      this.broadcastSessions()
    } else if (session.status !== 'hibernated' && session.status !== 'exited') {
      return { ok: false, reason: `cannot stop session in status '${session.status}'` }
    }

    // Free worktree only when no OTHER live session still uses the path —
    // including sessions attached to a different issue but running in this
    // worktree [spec:SP-9904]. Free BEFORE arming any kill so work completes
    // while the agent is still alive; self-stop kill is armed only after the
    // relay reply (finalizeDeferredStopKill), not via a timer.
    let worktreeFreed = false
    if (issueId && worktreePath) {
      const stillUsing = liveSessionsUsingWorktree(
        worktreePath,
        this.listSessions(),
        input.sessionId,
      )
      if (stillUsing.length === 0) {
        const freed = await issues.freeWorktreeKeepBranch(
          issueId,
          input.principal ?? systemPrincipal('stop'),
          {
            force: input.force === true,
          },
        )
        if (!freed.ok) {
          if (wasRunning && !input.selfStop) this.killStoppedSession(session)
          return {
            ok: true,
            reason: `session stopped but worktree not freed: ${freed.output}`,
            worktreeFreed: false,
            deferredKill: input.selfStop === true && wasRunning,
          }
        }
        worktreeFreed = freed.worktreeFreed
      }
    }

    // Peer/operator: kill now. Self-stop: hold the kill until the relay has
    // delivered agentRelayResult (finalizeDeferredStopKill) [spec:SP-9904].
    if (wasRunning && !input.selfStop) this.killStoppedSession(session)

    return {
      ok: true,
      worktreeFreed,
      deferredKill: input.selfStop === true && wasRunning,
    }
  }

  /** Immediate process kill for a session already parked by stop. */
  private killStoppedSession(session: Session): void {
    this.toMachine(session.machineId, {
      type: 'kill',
      sessionId: session.sessionId,
      durableLabel: session.durableLabel,
    })
  }

  /**
   * Arm the process kill for a self-stop AFTER the relay reply has been sent
   * [spec:SP-9904]. Called from AgentRelayGate once agentRelayResult is on the
   * wire — not a fixed timer.
   */
  finalizeDeferredStopKill(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // Only kill if still parked from stop (hibernated/exited) — never a live row.
    if (session.status !== 'hibernated' && session.status !== 'exited') return
    this.killStoppedSession(session)
  }

  /**
   * Stop every session on an issue, then free the issue worktree (keep branch)
   * [spec:SP-9904].
   */
  async stopIssue(
    input: {
      issueId: string
      force?: boolean
      /** Session performing the stop (for self-stop deferral when it is a member). */
      callerSessionId?: string
      /**
       * Who asked for the stop (POD-1344). Stamped onto free-worktree audit
       * comments. Absent only on genuinely caller-less paths — those fall back
       * to `systemPrincipal('stop')`.
       */
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
    const issue = this.deps.issueAccess.getMeta(input.issueId)
    if (!issue) return { ok: false, reason: 'unknown issue', stopped: [], worktreeFreed: false }
    // sessionsForIssue matches on the canonical issue id; input.issueId may be a
    // human ref/seq that getMeta resolved above but a raw string compare would miss [POD-985].
    const members = sessionsForIssue(issue.worktreePath ?? null, this.listSessions(), issue.id)
    const stopped: string[] = []
    let deferredKill = false
    const principal = input.principal ?? systemPrincipal('stop')
    // Non-self members first (immediate kill). Self last so sibling stops + free
    // finish before the caller's deferred kill is armed after the relay reply.
    const ordered = [
      ...members.filter((m) => m.sessionId !== input.callerSessionId),
      ...members.filter((m) => m.sessionId === input.callerSessionId),
    ]
    for (const m of ordered) {
      const r = await this.stopSession(
        {
          sessionId: m.sessionId,
          force: input.force,
          selfStop: input.callerSessionId === m.sessionId,
          stopReason: input.force ? 'forced' : 'parent',
          principal,
        },
        issues,
      )
      if (!r.ok) {
        return {
          ok: false,
          reason: r.reason ?? `failed to stop session ${m.sessionId}`,
          stopped,
          worktreeFreed: false,
        }
      }
      stopped.push(m.sessionId)
      if (r.deferredKill) deferredKill = true
    }
    // Final free pass: only when no live cwd still uses the worktree (any issue).
    let worktreeFreed = false
    const current = this.deps.issueAccess.getMeta(input.issueId)
    const wt = current?.worktreePath ?? null
    if (wt) {
      const stillUsing = liveSessionsUsingWorktree(wt, this.listSessions())
      if (stillUsing.length === 0) {
        const freed = await issues.freeWorktreeKeepBranch(input.issueId, principal, {
          force: input.force === true,
        })
        if (!freed.ok) {
          return {
            ok: true,
            reason: `sessions stopped but worktree not freed: ${freed.output}`,
            stopped,
            worktreeFreed: false,
            ...(deferredKill ? { deferredKill: true } : {}),
          }
        }
        worktreeFreed = freed.worktreeFreed
      }
    } else {
      worktreeFreed = Boolean(current?.branch && !current.worktreePath)
    }
    return {
      ok: true,
      stopped,
      worktreeFreed,
      ...(deferredKill ? { deferredKill: true } : {}),
    }
  }

  /**
   * Whether this session has a valid, unconsumed terminal proof. Delegates to
   * {@link SessionTerminalProof}; kept here because `relay.ts` and the hosts
   * module reach it through this service's public surface.
   */
  hasValidTerminalProof(sessionId: SessionId): boolean {
    return this.terminalProof.hasValidProof(sessionId)
  }

  terminalProofMissing(sessionId: SessionId): boolean {
    return this.terminalProof.proofMissing(sessionId)
  }

  /**
   * Park a live session: kill its process (and durable host) but keep the row,
   * its transcript, and the resume ref. One click brings it back. Returns false
   * when the session can't come back later (no resume ref) — we refuse rather
   * than silently turn "hibernate" into "kill".
   */
  hibernateSession({
    sessionId,
    requireTerminalProof = false,
  }: {
    sessionId: SessionId
    requireTerminalProof?: boolean
  }): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status !== 'live' && session.status !== 'reconnecting')
      return { ok: false, reason: 'not running' }
    if (!session.resume) {
      return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
    }
    // Never park an agent mid-work: hibernation kills the process, and a
    // working/compacting agent would lose its in-flight turn. Auto-hibernation
    // already filters to idle/ended; enforcing it here makes the primitive (and
    // the manual hibernate button) safe regardless of caller.
    const phase = session.agentState?.phase
    if (phase === 'working' || phase === 'compacting') {
      return { ok: false, reason: 'agent is working — let it reach idle first' }
    }
    const lease = requireTerminalProof ? this.store.observationCheckpoints.get(sessionId) : null
    const facts = lease ? this.terminalProof.facts(session, lease) : null
    if (requireTerminalProof) {
      if (!facts || !this.terminalProof.consumable(facts)) {
        return { ok: false, reason: 'terminal state is not safely reapable' }
      }
      const proof = this.store.observationCheckpoints.getTerminalCandidate(sessionId)
      if (
        !proof?.confirmedAt ||
        proof.consumedAt ||
        JSON.stringify(proof.facts) !== JSON.stringify(facts)
      ) {
        return { ok: false, reason: 'terminal state has not passed live revalidation' }
      }
    }
    const runningStatus = session.status
    session.status = 'hibernated'
    const consumedAt = new Date(this.now()).toISOString()
    try {
      this.repository.persist(
        session,
        facts
          ? () => {
              const currentLease = this.store.observationCheckpoints.get(sessionId)
              const currentFacts = currentLease
                ? this.terminalProof.facts(session, currentLease)
                : null
              if (
                !currentFacts ||
                JSON.stringify(currentFacts) !== JSON.stringify(facts) ||
                !this.store.observationCheckpoints.consumeTerminalCandidate(
                  currentFacts,
                  consumedAt,
                )
              ) {
                throw new Error('terminal proof changed before hibernation')
              }
            }
          : undefined,
      )
    } catch (error) {
      // `persist` restores its captured durable state on any transaction error;
      // keep this lifecycle primitive independently correct even when a caller or
      // test supplies a store without a prior capture.
      session.status = runningStatus
      if (error instanceof Error && error.message === 'terminal proof changed before hibernation') {
        return { ok: false, reason: error.message }
      }
      throw error
    }
    this.autoContinue.onSessionGone(sessionId)
    this.toMachine(session.machineId, {
      type: 'kill',
      sessionId,
      ...(session ? { durableLabel: session.durableLabel } : {}),
    })
    this.broadcastSessions()
    return { ok: true }
  }

  /**
   * Move one resumable worktree session to another machine ([spec:SP-3f7a]).
   *
   * THE COMPOSITION ROOT for the `sessions.handoff` command (POD-642). The
   * choreography, the `use`-verb gate on both machines, the apply-time
   * re-authorization and the single-flight idempotency live in
   * {@link HandoffCoordinator}; this method's whole job is to build that
   * coordinator's ports out of this service and hand it the transport caller.
   *
   * `caller` DEFAULTS TO THE OPERATOR, and that default is a legacy seam with
   * exactly one justification: `sessions.handoff` is exposed on `trpc` only, and
   * "every HTTP caller is the OPERATOR today" (the router context says so). So
   * the default states today's truth rather than inventing an ambient identity —
   * and it is deliberately NOT inside the coordinator, which refuses a call with
   * no caller at all (ADR 3 D7 fail-closed). When POD-381's `command-ctx`
   * resolves a real principal per transport, this parameter is what it fills.
   */
  handoffSession(
    input: { sessionId: SessionId; machineId: string },
    caller: HandoffCaller,
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: true; newCwd: string }> {
    return this.handoffs(issues).handoff(input, caller, this.machineUseGate(caller))
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

  /**
   * ONE coordinator for the life of this service, not one per call: its
   * single-flight map is the thing that stops a duplicate dispatch from forking
   * the session, and a per-call coordinator would start every dispatch with an
   * empty map — a guard that still looked implemented.
   */
  private handoffs(issues: SessionIssueWorkflowPort): HandoffCoordinator {
    if (this.handoffCoordinator) return this.handoffCoordinator
    const ports: HandoffPorts = {
      rpc: this.rpc,
      getSession: (sessionId) => this.sessions.get(sessionId),
      listSessions: () =>
        this.listSessions().map((meta) => ({
          sessionId: meta.sessionId,
          machineId: meta.machineId ?? '',
          cwd: meta.cwd,
          status: meta.status,
        })),
      listRepos: () => this.store.repos.listRepos(),
      listMachines: () => this.machines.listMachines(),
      issueMeta: (issueId) => this.deps.issueAccess.getMeta(issueId) ?? undefined,
      rehomeIssue: (issueId, where) => issues.rehome(issueId, where),
      ensureTargetRepo: (sourceRepo, targetMachineId) =>
        this.workspace.ensureTargetRepo(sourceRepo, targetMachineId),
      persist: (session) => this.repository.persist(session),
      mutateSessionView: (sessionId, mutate) => {
        this.repository.mutateSessionView(sessionId, mutate)
      },
      broadcastSessions: () => this.broadcastSessions(),
      onSessionGone: (sessionId) => this.autoContinue.onSessionGone(sessionId),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      onWorktreesChanged: (repoPath, machineId) =>
        this.deps.onWorktreesChanged(repoPath, machineId),
      resumeSession: (resumeInput) => this.resumeSession(resumeInput, issues),
      resurrectSession: (resurrectInput) => this.resurrectSession(resurrectInput, issues),
      recordEvent: (event) => {
        this.store.events.appendEvent(event)
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
    this.handoffCoordinator = new HandoffCoordinator(ports)
    return this.handoffCoordinator
  }

  /** Wake a hibernated session: respawn under the same id with its resume ref.
   *  If stop freed the worktree, recreates it from the preserved branch first
   *  [spec:SP-9904]. */
  resurrectSession(
    {
      sessionId,
      adoptedBinding,
    }: {
      sessionId: SessionId
      adoptedBinding?: SessionBindingAdoptLaunchInstruction
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: boolean; reason?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, reason: 'unknown session' })
    // Hibernated (parked on purpose) and exited (process died or was killed
    // externally) are the same situation here: no process, but the row and the
    // resume ref are intact — both come back with one spawn.
    if (session.status !== 'hibernated' && session.status !== 'exited') {
      return Promise.resolve({ ok: false, reason: 'process still running' })
    }
    // A shell has no conversation to lose — a fresh spawn in the same cwd IS
    // full recovery, so it never needs a resume ref. Agents do: respawning one
    // without its ref would silently discard the conversation.
    if (session.agentKind !== 'shell' && !session.resume) {
      return Promise.resolve({ ok: false, reason: 'no resume ref' })
    }

    // Recreate a worktree freed by stop (or deleted out-of-band) before spawn
    // so the agent has a real cwd. Transcript inspection does not need this.
    // The common hibernate→wake path resolves synchronously, and the spawn
    // must too: queueText fire-and-forgets this call and its callers rely on
    // the spawn being on the wire before queueText returns [POD-197].
    const ensured = this.workspace.ensureSessionWorktree(session, issues)
    if (ensured instanceof Promise) {
      return ensured.then((e) => this.finishResurrect(session, e, adoptedBinding))
    }
    return Promise.resolve(this.finishResurrect(session, ensured, adoptedBinding))
  }

  private finishResurrect(
    session: Session,
    ensured: { ok: boolean; reason?: string; cwd?: string },
    adoptedBinding?: SessionBindingAdoptLaunchInstruction,
  ): { ok: boolean; reason?: string } {
    const sessionId = session.sessionId
    if (!ensured.ok) return { ok: false, reason: ensured.reason }
    if (ensured.cwd && ensured.cwd !== session.cwd) {
      session.cwd = ensured.cwd
    }

    const preparedInstructions = this.deps.instructionsForStart({
      sessionId,
      cwd: session.cwd,
      agentKind: session.agentKind,
      ...(session.issueId ? { issueId: session.issueId } : {}),
      existingOnly: true,
    })
    session.status = 'starting'
    session.exitCode = undefined
    // Waking a session resets its hibernation idle timer — otherwise a stale
    // lastActiveAt makes it immediately eligible to be parked again.
    session.markResumed()
    this.repository.persist(session)
    const observationLease = this.terminalProof.fence(session)
    this.toMachine(session.machineId, {
      type: 'spawn',
      sessionId,
      durableLabel: session.durableLabel,
      agentKind: session.agentKind,
      cwd: session.cwd,
      ...(adoptedBinding ? { adoptedBinding } : {}),
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
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      geometry: session.terminal.geometry,
      ...this.launchConfig.modelDefaults(session.agentKind),
      ...this.launchConfig.accountEnv(session.agentKind, session.accountId),
      ...(this.state.draftSyncEnabled() ? { draftSync: true } : {}),
    })
    preparedInstructions.commit()
    this.broadcastSessions()
    return { ok: true }
  }

  /** issue-as-workspace draft cleanup: after a session dies (kill/remove/exit/
   *  archive), reap its draft issue if the draft is now empty — draft, no
   *  worktree, no children, and every attached session dead (exited/archived) or
   *  gone. Hibernation does NOT land here via a dead status ('hibernated' blocks
   *  the reap inside reapIfEmptyDraft), so a parked draft survives. */
  private maybeReapDraftIssue(issueId: string | null | undefined): void {
    if (!issueId) return
    try {
      this.bus.emit('issue.sessionDerived', { kind: 'reapDraft', issueId })
    } catch (err) {
      console.warn(`[podium:issues] draft-issue reap failed for ${issueId}:`, err)
    }
  }

  /** Durable transition for removing a local session. POD-309 removed the second
   *  spec this used to push: a retained hub-mirror entry colliding on the same id was
   *  revealed in the same ordered append. There is no mirror to reveal any more. */
  private sessionRemovalSpecs(sessionId: SessionId): EntityChangeSpec[] {
    return [{ entity: 'session', id: sessionId, op: 'remove' }]
  }

  /** Prepare deletion of every LOCAL session belonging to an issue. The caller
   *  commits `write` + `changes` together with the issue tombstone, then invokes
   *  `apply` only after that durable transaction succeeds. */
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

  /** Runtime half of a durable session removal. Issue-owned tombstones can be
   * restored and therefore use generic process kill; standalone deletion is
   * terminal and emits the distinct binding-retirement instruction. */
  private removeSessionRuntime(
    sessionId: SessionId,
    terminalRetirement?: { retiredAt: string },
  ): void {
    const session = this.sessions.get(sessionId)
    // The issues service owns the per-session Git attribution ledger. Notify it
    // while membership/cwd are still resolvable, before this removal.
    this.bus.emit('issue.sessionDerived', { kind: 'removedOrArchived', sessionId })

    this.toMachine(
      // The live Session is the truth while it exists; after it is dropped the durable
      // row still names the machine that ran it, and only a session with neither gets
      // the fleet default. Every arm is a machine some daemon actually answers to.
      session?.machineId ??
        this.store.sessions.getSession(sessionId)?.machineId ??
        this.machines.defaultMachine(),
      terminalRetirement
        ? {
            type: 'sessionBindingRetire',
            sessionId,
            transitionId: `retire:${sessionId}`,
            retiredAt: terminalRetirement.retiredAt,
            ...(session ? { durableLabel: session.durableLabel } : {}),
          }
        : {
            type: 'kill',
            sessionId,
            ...(session ? { durableLabel: session.durableLabel } : {}),
          },
    )
    this.autoContinue.onSessionGone(sessionId)
    session?.terminal.detachAll()
    this.sessions.delete(sessionId)
    this.state.removeSession(sessionId)
    this.daemonProjection.disposeTitle(sessionId)
    for (const c of this.clients.values()) c.attached.delete(sessionId)
    this.repository.forget(sessionId)
  }

  killSession(input: { sessionId: SessionId }): void {
    const session = this.sessions.get(input.sessionId)
    // Capture before the row is tombstoned — the reap after cleanup needs it.
    const issueId = session?.issueId
    const deletedAt = new Date(this.now()).toISOString()
    // The remove change commits in the SAME transaction as the tombstone (and
    // the queued-send cleanup — a killed session can never deliver, so its rows
    // would only orphan until the next boot's sweep) [spec:SP-3fe2] #256: the
    // durable change log can never say something the sessions table doesn't.
    // Durable tombstone FIRST, live teardown after (#247): a commit throw leaves
    // the session fully alive — still in the map, clients attached, PTY not
    // signalled — and propagates to the caller, instead of tearing down live
    // state for a row the rolled-back transaction still holds.
    const { changes } = this.deps.ledger.commit({
      write: () => {
        this.store.sessions.softDeleteSessions([input.sessionId], deletedAt, 'standalone')
        this.store.sync.deleteQueuedMessagesForSession(input.sessionId)
      },
      changes: () => this.sessionRemovalSpecs(input.sessionId),
    })
    this.removeSessionRuntime(input.sessionId, { retiredAt: deletedAt })
    this.repository.publishSessionProjection(changes)
    this.broadcastSessions()
    // The killed session may have been the last living occupant of an empty
    // draft issue — reap the vessel so "x" doesn't leak orphaned Drafts.
    this.maybeReapDraftIssue(issueId)
    // Session-death notification [spec:SP-85d1] (lock auto-release et al.): a
    // kill deletes the row from the map BEFORE the daemon's agentExit arrives,
    // so the agentExit-path emit would be skipped — fire it here. killSession
    // is never the hibernate path (hibernateSession only flips status).
    // Capture spawnedBy before the row is gone so the steward can still resolve
    // a session-spawner parent wake (POD-904 / exit-without-report).
    this.emitSessionExited(input.sessionId, session?.exitCode ?? -1, session?.spawnedBy, session)
  }

  /**
   * Real process death: bus fan-out (locks, messaging) AND a durable
   * `session.exited` row for the steward's session-parent wake (POD-904).
   * Hibernate does not land here. Best-effort log write — a store throw must
   * not undo the exit side-effects already applied.
   */
  private emitSessionExited(
    sessionId: SessionId,
    code: number,
    spawnedBy?: string | null,
    sourceSession: Session | undefined = this.sessions.get(sessionId),
  ): void {
    const session = sourceSession
    const lease = this.store.observationCheckpoints.get(sessionId)
    const fence = lease?.checkpoint?.terminalFence
    const candidate = this.store.observationCheckpoints.getTerminalCandidate(sessionId)
    // A fence suppresses the fixed steward exit fallback only while it still
    // describes the latest causal input. Historical/mixed-version fences without
    // their matching durable candidate, or a prompt sent after the fence, must let
    // the crash surface as a real exit.
    const terminalFenceReported = Boolean(
      session &&
        fence &&
        !fence.closing &&
        candidate &&
        candidate.facts.terminalTransitionId === fence.transitionId &&
        candidate.facts.inputCount === session.terminal.inputCount,
    )
    this.bus.emit('session.exited', { sessionId, code })
    try {
      this.store.events.appendEvent({
        ts: new Date(this.now()).toISOString(),
        kind: 'session.exited',
        subject: sessionId,
        payload: {
          code,
          ...(terminalFenceReported ? { terminalFenceReported: true } : {}),
          ...(spawnedBy ? { spawnedBy } : {}),
        },
      })
    } catch {
      // Durable log is best-effort; bus subscribers already ran.
    }
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
