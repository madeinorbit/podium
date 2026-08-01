import type {
  AccountId,
  AgentRuntimeState,
  Attribution,
  AutomationRunWire,
  AutomationWire,
  Geometry,
  IssueId,
  IssueWire,
  ResumeRef,
  SessionId,
  SessionMeta,
  TranscriptItem,
  WorkState,
} from '@podium/model'
import { AgentKind, asSessionId, asUserId, type UserId } from '@podium/model'
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
import { acceptAgentObservation } from '@podium/harness'
import {
  harnessCapabilitiesFor,
  harnessNeedsSubmitVerification,
  harnessObservationProvider,
  harnessSupportsEffort,
  harnessSupportsInitialPrompt,
  harnessUsesPromptTitleFallback,
} from '../../harness-manifest'
import {
  computePriorities,
  FIRST_ADMIN_USER_ID,
  NO_SESSION_USER_STATE,
  type SessionUserOverlay,
} from '@podium/model'
import type { MachinePrincipal } from '@podium/protocol'
import {
  asDelegationRef,
  type AgentInstruction,
  type ApprovalWire,
  AUTO_ARCHIVE_READ_WINDOW_MS,
  CAP_METADATA_DELTA,
  type ClientMessage,
  type ControlMessage,
  type DaemonMessage,
  type DraftEditMessage,
  FEED_MESSAGE_TYPES,
  formatSessionRef,
  type IssueDepProjection,
  type IssueProjection,
  type LiveServerMessage,
  MAX_AGENT_TITLE_LENGTH,
  type MetadataChange,
  type RepoProjection,
  type ServerMessage,
  type SessionBindingAdoptLaunchInstruction,
  type SessionBindingSpawnInstruction,
  type SessionOpenUrlMessage,
  type SyncChangesSinceResult,
} from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import { LOCAL_PLACEHOLDER } from '@podium/runtime/local-machine'
import { type EntityChangeSpec, MutationLedger, type MutationLedgerPort } from '@podium/sync'
import { AutoContinueController } from '../../auto-continue'
import {
  resolvePrincipal,
  systemPrincipal,
  userCommandPrincipal,
  type CommandPrincipal,
} from '../../command-principal'
import { isFeatureEnabled } from '../../features'
import { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsClientFrame } from '../../gateway/client-frame-routing'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { feedPrincipalOf } from '../../gateway/client-principal'
import { type ClientConn, ClientRegistry } from '../../gateway/client-registry'
import type { SessionsDaemonFrame } from '../../gateway/daemon-frame-routing'
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
import {
  isCommandWrapperText,
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  titleFromPrompt,
} from '../../title-filter'
import type { EventBus } from '../bus'
import type { ConversationsService } from '../conversations/service'
import type { WriteFunnel } from '../funnel'
import type { HostsService } from '../hosts/service'
import type { IssueService } from '../issues/service'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService, MachineUseResolver } from '../machines/service'
import { perfPrincipal } from '../perf/principal'
import { DEPLOYMENT, perf } from '../perf/registry'
import type { HeadlessService } from '../superagent/headless'
import { resolveAccountEnv } from './account-env'
import { machineUseGateForCapability } from './handoff/access'
import { HandoffCoordinator } from './handoff/coordinator'
import type { AssertMachineUse, HandoffCaller, HandoffPorts } from './handoff/ports'
// Still used by the lazy workspace-fetch path (POD-658), which shares the
// source-side bundle-base handshake and the chunked transfer with handoff.
import type { PreparedSessionInstructions } from './instructions'
import {
  inboxActorColumns,
  inboxActorFromColumns,
  inboxPrincipalFromCommand,
  type InboxSendInput,
  type InboxPrincipalReference,
  SessionInbox,
  SYSTEM_INBOX_PRINCIPAL,
} from './inbox'
import { SessionClientControl } from './client-control'
import { SessionDaemonProjection } from './daemon-projection'
import { SessionWorkspace } from './workspace'
import { SessionBindingReceipts } from './session-binding'
import { assertMayCommandSession, resolveSessionTarget } from './session-access'
import { SessionStateRegistry, sessionStatePrincipalFor } from './session-state/registry'
import type { SessionProjectionEvent } from './publish-worker-actor'
import { PublishWorkerClient } from './publish-worker-client'
import {
  SessionPublicationCoordinator,
  type SessionPublicationMetrics,
} from './publication/coordinator'
import { SessionBroadcastCoordinator } from './publication/broadcast'
import {
  type PublicationAuthority,
  Session,
  type SessionDurableState,
  type SessionVolatileField,
} from './session'
import { type SessionStatePrincipal, SessionStateService } from './session-state/service'

export const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }

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

/** Normalize an agent-set session name the same way setAgentName does — trim,
 *  collapse whitespace, reject empty / over-long. Shared by the agent self-title
 *  path and createSession's spawner-prescribed name [spec:SP-4ef9][spec:SP-eb60].
 *  Length cap: MAX_AGENT_TITLE_LENGTH from @podium/protocol/titles. */
function normalizeAgentName(
  name: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) return { ok: false, reason: 'title is empty' }
  if (clean.length > MAX_AGENT_TITLE_LENGTH) {
    return {
      ok: false,
      reason: `title exceeds ${MAX_AGENT_TITLE_LENGTH} characters — a session title is 3–5 words`,
    }
  }
  return { ok: true, name: clean }
}

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
  /**
   * Evict a client connection through the GATEWAY (registry removal + the sweep),
   * for the one place a feature initiates a disconnect: the reconnect reclaim,
   * where a client's `hello` supersedes its own previous socket. Absent = the
   * in-process fallback below.
   */
  disconnectClient?(id: string): void
  /** Test/fault-injection seam; production owns the default daemon client. */
  publicationWorker?: PublishWorkerClient
  /** Rollout-only old/new semantic comparison; never changes delivered bytes. */
  publicationShadowCompare?: boolean
  machines: MachinesService
  rpc: DaemonRpcService
  hosts: HostsService
  headless: HeadlessService
  /** Lazy: the conversations service is constructed after this one (post-load slot). */
  conversations(): ConversationsService
  /** Lazy: the issue tracker is constructed after this one. */
  issues(): IssueService
  /** Full issue-list reconcile through the publisher — the derived-ripple path
   *  (closing an issue flips its dependents' wire rows with no write on them).
   *  Its rows are appended at the write seam and served from the feed; there is
   *  no snapshot tail behind it any more (POD-1203). */
  publishIssues(sessions: SessionMeta[]): void
  /** The issue wire list (attachClient bootstrap + snapshot sync). */
  issuesWire(): IssueWire[]
  /** Normalized local truths for cold snapshot bootstrap; empty while the flag is off. */
  issueProjectionsWire(): IssueProjection[]
  issueDepsWire(): IssueDepProjection[]
  issueReposWire(): RepoProjection[]
  /** Durable scheduled definitions and run history for bootstrap/snapshot sync. */
  automationsWire(): AutomationWire[]
  automationRunsWire(): AutomationRunWire[]
  /** POD-665: a worktree appeared/vanished out from under connected clients —
   *  nudge them to re-fetch repos. Raw invalidation, no payload. */
  onWorktreesChanged(repoPath: string, machineId?: string): void
  /** Approval broker [spec:SP-edbb]: the attach snapshot. The daemon execution
   *  OUTCOME no longer arrives here — `approvalExecResult` routes straight from
   *  the gateway to the approvals port (POD-389). */
  approvalsPending(): ApprovalWire[]
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
export interface SessionSpawnResult {
  sessionId: SessionId
  agentId: string
  harness: AgentKind
  model: string | null
  effort: string | null
  machine: string
  machineId: string
  accountId: AccountId | null
}

export class SessionLifecycle {
  /** Live maps — public: the composition root's cross-module closures (and the
   *  relay tests, via `(reg as any).sessions/.clients`) reach them directly. */
  readonly sessions = new Map<SessionId, Session>()
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
  private readonly observationLeases = new Map<SessionId, ObservationLeaseRecord>()

  private readonly store: SessionStore
  private readonly now: () => number
  private readonly bus: EventBus
  private readonly machines: MachinesService
  private readonly rpc: DaemonRpcService
  private readonly hosts: HostsService
  private readonly headless: HeadlessService
  /** Durable viewer/shared-surface state, isolated behind explicit ports. */
  readonly state: SessionStateService
  /** Backend auto-continue loop — re-arms retryable errored agents. */
  private readonly autoContinue: AutoContinueController
  /** Attributed inbound text, answers, FIFO queueing and controller gating. */
  private readonly inbox: SessionInbox
  /** The `sessions.handoff` handler (POD-642), built on first use. It holds the
   *  single-flight registry that stops a duplicate dispatch from forking a
   *  session, so it must outlive one call — see `handoffs()`. */
  private handoffCoordinator?: HandoffCoordinator
  /** The write funnel — owns the durable metadata oplog (docs/spec/oplog-read-path.md). */
  private readonly funnel: WriteFunnel
  readonly publication: SessionPublicationCoordinator
  readonly clientControl: SessionClientControl
  readonly daemonProjection: SessionDaemonProjection
  readonly workspace: SessionWorkspace

  // Server-only dirty generation [spec:SP-c29e]. It schedules projection work and
  // invalidates the legacy snapshot cache; ledger seq remains the sole durable and
  // client-visible ordering/catch-up primitive. Every successful persisted or
  // explicitly captured wire mutation bumps once. The value is never serialized.
  private sessionsGeneration_ = 0
  private readonly sessionProjectionListeners = new Set<(event: SessionProjectionEvent) => void>()
  private volatileSessionMutationVersion = 0
  private readonly pendingVolatileSessions = new Map<
    SessionId,
    { version: number; preserve: Set<SessionVolatileField>; issueRelevant: boolean }
  >()
  private readonly capturedSessionStates = new Map<SessionId, SessionDurableState>()
  private volatileSessionCaptureTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly VOLATILE_CAPTURE_RETRY_MS = 1_000
  private issueProjectionGeneration = 0
  readonly broadcasts: SessionBroadcastCoordinator
  private readonly browserOpen: BrowserOpenGateway
  private readonly bindingReceipts: SessionBindingReceipts
  // Single timer that persists only sessions whose activity counters advanced
  // since the last tick — keeps the per-frame / per-keystroke path off the DB.
  private readonly activityFlushTimer = setInterval(() => this.flushActivity(), 12_000)

  constructor(private readonly deps: SessionLifecycleDeps) {
    this.store = deps.store
    this.now = deps.now
    this.mutations = deps.mutations ?? new MutationLedger(this.store.sync, () => this.now())
    this.clients = deps.clients ?? new ClientRegistry()
    this.bus = deps.bus
    this.machines = deps.machines
    this.rpc = deps.rpc
    this.hosts = deps.hosts
    this.headless = deps.headless
    this.activityFlushTimer.unref?.()
    this.funnel = deps.funnel
    const publicationWorker = deps.publicationWorker ?? new PublishWorkerClient()
    this.publication = new SessionPublicationCoordinator({
      clients: this.clients,
      worker: publicationWorker,
      funnel: this.funnel,
      shadowCompare: deps.publicationShadowCompare ?? false,
      generation: () => this.sessionsGeneration_,
      sessions: () => this.sessions,
      listSessions: () => this.listSessions(),
      snapshotTail: () => ({
        issues: this.deps.issuesWire(),
        issueProjections: this.deps.issueProjectionsWire(),
        issueDeps: this.deps.issueDepsWire(),
        repos: this.deps.issueReposWire(),
        conversations: this.conversations().allConversations(),
        automations: this.deps.automationsWire(),
        automationRuns: this.deps.automationRunsWire(),
        diagnostics: this.conversations().diagnostics(),
      }),
    })
    this.broadcasts = new SessionBroadcastCoordinator({
      hasPendingVolatile: () => this.pendingVolatileSessions.size > 0,
      scheduleVolatileCapture: () => this.scheduleVolatileSessionCapture(),
      flushVolatileCaptures: () => {
        this.flushVolatileSessionCaptures()
      },
      generation: () => this.sessionsGeneration_,
      issueGeneration: () => this.issueProjectionGeneration,
      listSessions: () => this.listSessions(),
      schedulePublication: (options) => this.publication.schedule(options),
      publishIssues: (sessions) => this.deps.publishIssues(sessions),
      flushDeltas: () => this.funnel.flushDeltas(),
    })
    this.browserOpen = new BrowserOpenGateway({
      now: () => this.now(),
      clients: this.clients,
      session: (sessionId) => this.sessions.get(sessionId),
      sessionOwner: (sessionId) => this.sessionOwner(sessionId),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
    })
    this.bindingReceipts = new SessionBindingReceipts({
      store: this.store,
      sessions: () => this.sessions.values(),
      session: (sessionId) => this.sessions.get(sessionId),
      sessionOwner: (sessionId) => this.sessionOwner(sessionId),
      persist: (session) => this.persist(session),
      broadcastSessions: () => this.broadcastSessions(),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
    })
    this.daemonProjection = new SessionDaemonProjection({
      sessions: this.sessions,
      issues: () => this.issues(),
      binding: this.bindingReceipts,
      persist: (session) => this.persist(session),
      broadcastSessions: () => this.broadcastSessions(),
      broadcastToClients: (message) => this.broadcastToClients(message),
      adoptWorktree: (issueId, message) => this.adoptWorktree(issueId, message),
    })

    this.workspace = new SessionWorkspace({
      store: this.store,
      rpc: this.rpc,
      machines: this.machines,
      issues: () => this.issues(),
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
        if (session) this.persist(session, additionalWrite)
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
        this.issues().onSessionRemovedOrArchived(sessionId)
        this.maybeReapDraftIssue(this.sessions.get(sessionId)?.issueId)
        this.parkArchivedSession(sessionId)
      },
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
        authorizeAtDrain: (input) => this.authorizeInboxAtDrain(input),
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
        this.persist(
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
      resurrect: (sessionId) => this.resurrectSession({ sessionId }),
    })
    this.clientControl = new SessionClientControl({
      clients: this.clients,
      sessions: this.sessions,
      publication: this.publication,
      state: this.state,
      inbox: this.inbox,
      machines: this.machines,
      hosts: this.hosts,
      browserOpen: this.browserOpen,
      approvalsPending: () => this.deps.approvalsPending(),
      mutate: (sessionId, change, issueRelevant) =>
        this.mutateSessionView(sessionId, change, issueRelevant),
      broadcastSessions: () => this.broadcastSessions(),
      pushPriorities: () => this.pushPriorities(),
      ...(this.deps.disconnectClient
        ? { disconnectClient: (id) => this.deps.disconnectClient?.(id) }
        : {}),
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
      editDraft: (message, clientId) => this.handleDraftEdit(message, clientId),
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

  private authorizeInboxAtDrain(input: {
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
      issues: this.issues(),
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

  private issues(): IssueService {
    return this.deps.issues()
  }

  private conversations(): ConversationsService {
    return this.deps.conversations()
  }
  /**
   * Allocate and durably store the observer lease before its control message is
   * sent. Shells and non-causal adapters intentionally have no lease.
   */
  private fenceObservation(session: Session): ObservationLeaseRecord | undefined {
    const provider = harnessObservationProvider(session.agentKind)
    if (!provider) return undefined
    const lease = this.store.observationCheckpoints.advanceGeneration(
      session.sessionId,
      provider,
      session.resume?.value ?? null,
    )
    this.observationLeases.set(session.sessionId, lease)
    return lease
  }

  dispose(): void {
    this.autoContinue.dispose()
    clearInterval(this.activityFlushTimer)
    this.browserOpen.dispose()
    // Graceful server restarts must not lose a resize that landed inside the
    // coalescing window; persist dirty geometry/activity before closing [spec:SP-1a0b].
    this.flushActivity()
    // Run any coalesced session broadcast + pending delta batch. The durable
    // change log is already complete (commits happen at persist time, #256);
    // this just drains the in-flight fan-out tail deterministically.
    this.flushBroadcasts()
    this.publication.stop()
  }

  /** Current server-local session projection generation. Never sent to clients. */
  sessionsGeneration(): number {
    return this.sessionsGeneration_
  }

  /** Ordered post-capture patches for projection workers [spec:SP-c29e]. */
  onSessionProjection(listener: (event: SessionProjectionEvent) => void): () => void {
    this.sessionProjectionListeners.add(listener)
    return () => this.sessionProjectionListeners.delete(listener)
  }

  private publishSessionProjection(
    changes: MetadataChange[],
    ledgerCursor: number | undefined = changes.at(-1)?.seq,
    issueRelevant = true,
  ): void {
    const sessionChanges = changes.filter((change) => change.entity === 'session')
    if (sessionChanges.length === 0 || ledgerCursor === undefined) return
    const event: SessionProjectionEvent = {
      generation: ++this.sessionsGeneration_,
      changes: sessionChanges,
      ledgerCursor,
    }
    this.publication.applyProjection(event)
    for (const listener of this.sessionProjectionListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[sessions] projection listener threw', err)
      }
    }
  }

  /** Explicit non-row capture seam [spec:SP-c29e]. */
  private captureSessionSpecs(specs: EntityChangeSpec[], issueRelevant = true): MetadataChange[] {
    if (specs.length === 0) return []
    const changes = this.deps.ledger.capture(specs)
    this.publishSessionProjection(changes, undefined, issueRelevant)
    return changes
  }

  private markVolatileSessionDirty(
    sessionId: SessionId,
    preserve: SessionVolatileField[] = ['geometry', 'handoffTarget'],
    issueRelevant = true,
  ): void {
    const previous = this.pendingVolatileSessions.get(sessionId)
    this.pendingVolatileSessions.set(sessionId, {
      version: ++this.volatileSessionMutationVersion,
      preserve: new Set([...(previous?.preserve ?? []), ...preserve]),
      issueRelevant: (previous?.issueRelevant ?? false) || issueRelevant,
    })
    this.scheduleVolatileSessionCapture()
  }

  private scheduleVolatileSessionCapture(delayMs = 0): void {
    if (this.volatileSessionCaptureTimer) return
    this.volatileSessionCaptureTimer = setTimeout(() => {
      this.volatileSessionCaptureTimer = null
      try {
        this.flushBroadcasts()
      } catch (err) {
        console.warn('[podium] volatile session capture failed', err)
      }
    }, delayMs)
    this.volatileSessionCaptureTimer.unref?.()
  }

  private clearVolatileSessionCaptureTimer(): void {
    if (!this.volatileSessionCaptureTimer) return
    clearTimeout(this.volatileSessionCaptureTimer)
    this.volatileSessionCaptureTimer = null
  }

  private flushVolatileSessionCaptures(): MetadataChange[] {
    this.clearVolatileSessionCaptureTimer()
    if (this.pendingVolatileSessions.size === 0) return []
    const pending = [...this.pendingVolatileSessions]
    const issueRelevant = pending.some(([, state]) => state.issueRelevant)
    const specs: EntityChangeSpec[] = []
    for (const [sessionId] of pending) {
      const session = this.sessions.get(sessionId)
      if (!session) continue
      specs.push({
        entity: 'session',
        id: sessionId,
        op: 'upsert',
        value: this.sessionWire(session),
      })
    }
    try {
      const changes = this.captureSessionSpecs(specs, issueRelevant)
      // A volatile A→B→A batch legitimately dedups to no durable patch, but it
      // still invalidates the legacy snapshot pipeline once. Do not fabricate a
      // projection event: patch consumers need only the captured final truth.
      if (!changes.some((change) => change.entity === 'session')) {
        this.sessionsGeneration_++
        this.publication.replaceProjection({
          generation: this.sessionsGeneration_,
          ledgerCursor: this.funnel.cursor(),
          sessions: this.listSessions(),
        })
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
      this.scheduleVolatileSessionCapture(SessionLifecycle.VOLATILE_CAPTURE_RETRY_MS)
      throw err
    }
  }

  /** Central volatile Session-view mutation seam. The latest value is captured
   * once per session by the coalesced broadcast flush, keeping interaction paths
   * free of synchronous SQLite writes [spec:SP-c29e]. */
  private mutateSessionView(
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
  sessionsChangedForMachine(machineId: string): void {
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
      const committed = this.deps.ledger.commit({
        write: () => {
          additionalWrite()
          this.store.sessions.upsertSession(session.toRow())
        },
        changes: () => [
          {
            entity: 'session',
            id: session.sessionId,
            op: 'upsert',
            value: this.sessionWire(session),
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

  /**
   * THE live-session -> wire mapping. One function, one hop (ADR 4 §4.1,
   * inventory §6.5 rule 2) — `toMeta()` for the entity fields, the `machineName`
   * stamp, and `stampRef()` for the derived `displayRef`.
   *
   * It was already documented as the single shape ("the committed payload and
   * the legacy snapshot rows must agree byte-for-byte or the ledger's dedup and
   * the clients' replicas would diverge") while `listSessions()` restated its
   * body character-for-character. Two mappers for one hop, with a comment
   * asserting they agree and nothing enforcing it, is the drift this issue
   * exists to delete — so `listSessions()` now calls this instead (POD-366).
   *
   * PRINCIPAL SEAM, expressed and deliberately NOT implemented. Under the scoped
   * feed (POD-1077, Phase 2) a session's wire projection may legitimately differ
   * per reader — a field suppressed because the viewer may not see it, or a
   * machine fact visible to the machine's owner but not to a session viewer
   * (ADR 9 D3/D6). `packages/model/src/fields/README.md` rule 2 says leave room
   * for that and do not build it, and POLICY belongs to Phase 3 (POD-290).
   *
   * So the parameter exists and is threaded from every caller, and the ONE place
   * a suppression rule will ever go is this function body. What must not happen
   * instead is ad-hoc filtering at the call sites: that is the same drift class
   * arriving in a new guise, and it is why the argument is explicit rather than
   * read off `this`. `undefined` means "no principal in scope" and today every
   * caller passes it, because there is no policy to apply yet — a reader is not
   * meant to infer from that that the seam is unused.
   */
  private sessionWire(session: Session, forPrincipal?: SessionWirePrincipal): SessionMeta {
    const harnessCapabilities = harnessCapabilitiesFor(session.agentKind)
    const viewer = forPrincipal ?? this.defaultStatePrincipal()
    return this.stampRef(session, {
      ...session.toMeta(
        viewer ? this.state.overlay(viewer.userId, session.sessionId) : NO_SESSION_USER_STATE,
      ),
      machineName: this.machines.machineName(session.machineId),
      ...(harnessCapabilities
        ? {
            harnessHandoff: harnessCapabilities.handoff,
            harnessPromptModeHints: harnessCapabilities.promptModeHints,
          }
        : {}),
    })
  }

  /**
   * WHOSE per-user session markers the broadcast carries (POD-1076).
   *
   * `FIRST_ADMIN_USER_ID` spelled out, never a default: an unidentified principal
   * fails CLOSED rather than resolving to an operator identity (readiness
   * §3.1.6 S4). POD-1077 replaces the body with the request's principal.
   */
  private broadcastViewer(): UserId {
    return FIRST_ADMIN_USER_ID
  }

  private statePrincipalForTrustedUser(userId: UserId): SessionStatePrincipal {
    const role = this.store.users.roleOf(userId)
    if (!role) throw new Error(`refused: no active account for session-state user ${userId}`)
    return sessionStatePrincipalFor(userCommandPrincipal(userId, role))
  }

  private defaultStatePrincipal(): SessionStatePrincipal | undefined {
    const role = this.store.users.roleOf(FIRST_ADMIN_USER_ID)
    return role
      ? sessionStatePrincipalFor(userCommandPrincipal(FIRST_ADMIN_USER_ID, role))
      : undefined
  }

  /**
   * One session's markers for the broadcast viewer, read from a lazily-loaded
   * cache of that user's two per-user tables.
   *
   * A CACHE, not a mirror on the session: it is keyed by session id and thrown
   * away wholesale, so there is no field on a shared object that a second user's
   * projection could read by accident — which is exactly what the ratchet counted
   * before this issue.
   */
  private viewerOverlay(sessionId: SessionId): SessionUserOverlay {
    return this.state.overlay(this.broadcastViewer(), sessionId)
  }

  private invalidateViewerOverlay(): void {
    this.state.invalidateAllOverlays()
  }

  /**
   * Stamp the derived permanent `displayRef` onto a session's wire meta (#474).
   * PURE READ — allocation happens at the deliberate naming points
   * (spawn / first attach / boot backfill), never inside serialization.
   * Sessions with no local Session row keep their own ref.
   */
  private stampRef(session: Session, meta: SessionMeta): SessionMeta {
    const displayRef = this.computeSessionDisplayRef(session)
    return {
      ...meta,
      ...(session.refIssueId ? { refIssueId: session.refIssueId } : {}),
      ...(session.refLetter ? { refLetter: session.refLetter } : {}),
      ...(session.refDraft != null ? { refDraft: session.refDraft } : {}),
      ...(displayRef ? { displayRef } : {}),
    }
  }

  /**
   * NAMING POINT (#474): assign the permanent birth ref if this session has
   * none yet. The birth issue is the session's issue AT NAMING TIME; a session
   * with none is named in the per-repo DRAFT namespace. Never reallocates —
   * a later re-attach keeps the birth name.
   *
   * Called only at deliberate moments (never during reads/serialization):
   *   - spawnSession, after issueId resolution completed,
   *   - the first setSessionIssueId on a still-unnamed session,
   *   - the one-shot boot backfill for pre-#474 historical rows.
   */
  private prepareSessionRefAllocation(session: Session): (() => void) | undefined {
    if (session.refIssueId || session.refDraft != null) return
    const birthIssueId = session.issueId ?? null
    if (birthIssueId) {
      const issue = this.store.issues.getIssue(birthIssueId)
      if (issue) {
        // The returned write runs inside persist's Ledger transaction. That
        // makes the high-water advance, session row, and change append one
        // commit boundary; a failed append cannot burn a visible ref.
        return () => {
          session.refLetter = this.store.issues.allocateSessionLetter(birthIssueId)
          session.refIssueId = birthIssueId
        }
      }
    }
    // Truly issueless → per-repo DRAFT counter (`POD-DRAFT-3`). Skip when the
    // cwd resolves to no registered prefix: the name could never render, and
    // the high-water counter makes skipping safe (no ordinal is ever reused).
    const repoId = this.store.repos.resolveRepoIdForPath(session.cwd)
    if (this.store.repos.prefixForRepoId(repoId) === null) return
    return () => {
      session.refDraft = this.store.repos.nextDraftSeq(repoId)
    }
  }

  /** The permanent birth nice name (`POD-13-A` / `POD-DRAFT-3`), or undefined
   *  when its repo prefix / birth issue can't be resolved. Pure. */
  private computeSessionDisplayRef(session: Session): string | undefined {
    if (session.refIssueId && session.refLetter) {
      const issue = this.store.issues.getIssue(session.refIssueId)
      if (!issue) return undefined
      const prefix = this.store.repos.prefixForPath(issue.repoPath)
      return prefix
        ? formatSessionRef({ prefix, seq: issue.seq, letter: session.refLetter })
        : undefined
    }
    if (session.refDraft != null) {
      const prefix = this.store.repos.prefixForPath(session.cwd)
      return prefix ? formatSessionRef({ prefix, draft: session.refDraft }) : undefined
    }
    return undefined
  }

  /** Persist every session whose activity counters advanced since the last flush.
   *  Keeps the per-frame / per-keystroke path off the DB — the timer above calls
   *  this on a coarse interval, so a busy session writes at most once per tick. */
  flushActivity(): void {
    for (const s of this.sessions.values()) {
      if (s.terminal.activityDirty) {
        this.persist(s)
        s.terminal.clearActivityDirty()
      }
    }
  }

  /** Materialize one persisted row without exposing it until the caller installs it.
   *  Restored tombstones always come back as exited: deletion killed their runtime,
   *  so retaining a prior live/starting status would claim a PTY that no longer exists. */
  private sessionFromStoredRow(r: SessionRow, mode: 'boot' | 'restore'): Session | null {
    const kind = AgentKind.safeParse(r.agentKind)
    if (!kind.success) {
      console.warn(
        `[podium] skipping persisted session ${r.id}: invalid agentKind ${JSON.stringify(r.agentKind)}`,
      )
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
      console.warn(`[podium] persisted resume session ${r.id} has no conversationId`)
    }
    const machineId = r.machineId ?? LOCAL_PLACEHOLDER
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
      geometry: { ...(r.geometry ?? DEFAULT_GEOMETRY) },
      machineId,
      toDaemon: (msg) => this.toMachine(this.sessions.get(r.id)?.machineId ?? machineId, msg),
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
      ...(r.accountId ? { accountId: r.accountId } : {}),
      ...(r.spawnedBy ? { spawnedBy: r.spawnedBy } : {}),
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
    })
    return session
  }

  private installStoredSession(
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
      session.conversationPodiumId = this.store.conversations.conversationPodiumId(
        session.machineId,
        session.resume.value,
      )
    }
    this.capturedSessionStates.set(session.sessionId, session.captureDurableState())
  }

  loadFromStore(): void {
    this.observationLeases.clear()
    for (const lease of this.store.observationCheckpoints.loadAll()) {
      this.observationLeases.set(lease.sessionId, lease)
    }

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
      const checkpoint = this.observationLeases.get(r.id)?.checkpoint
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
      const additionalWrite = this.prepareSessionRefAllocation(session)
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
      maxAgeMs: APPLIED_MUTATIONS_MAX_AGE_MS,
      now: this.now(),
    })
    // Boot reconciliation ([spec:SP-3fe2] #256): diff the restored full truth
    // against the ledger baseline — INCLUDING removes (rows deleted or
    // quarantined while the server was down) — so a cursor-holding client that
    // reconnects heals via changesSince instead of silently missing the gap.
    // No fan-out: there are no clients at boot. Conversations are deliberately
    // NOT reconciled at boot: they are daemon-fed, and an empty list at boot
    // means "not scanned yet", not "all gone".
    // Boot ordering (#247): this runs BEFORE server.ts calls ensureLocalMachine,
    // so placeholder rows reconcile here with machineId '__local__'. That stale
    // baseline is unobservable and self-healing: adoption
    // (ensureLocalMachine → adoptPlaceholderRows) explicitly captures affected
    // sessions before its broadcast — all before the server accepts connections.
    const recovered = this.deps.ledger.reconcile(
      'session',
      this.listSessions().map((s) => ({ id: s.sessionId, value: s })),
    )
    this.publishSessionProjection(recovered)
    // A fully deduped boot reconcile emits no patch. Reset explicitly so a new
    // worker (or one recovering from a crash) still begins from restored truth.
    this.publication.replaceProjection({
      generation: this.sessionsGeneration_,
      ledgerCursor: this.funnel.cursor(),
      sessions: this.listSessions(),
    })
  }

  /**
   * A machine's daemon became reachable — the SESSION half of what `attachDaemon`
   * used to do inline. The socket registration, the placeholder adoption, the
   * queued-control flush, the machine broadcast and the `machine.connected` bus
   * emit are the gateway's (`gateway/daemon-mux.ts`); everything below is session
   * orchestration and stays here, in its original order.
   *
   * `principal` is the transport-resolved MACHINE principal (ADR 3 D7). Every
   * write these steps make is a daemon-class observation attributed to that
   * machine — never to a person, and with no on-behalf-of (ADR 1's daemon writer
   * class; `docs/multi-user-readiness.md` §3.1.6 S5).
   */
  onMachineAttached(principal: MachinePrincipal): void {
    const machineId = principal.machine
    // Re-arm queued-send delivery for this machine's sessions: their earlier drain
    // attempts parked while the daemon was away (single-flight + liveness wait make
    // this safe to fire eagerly; reattached sessions also re-trigger via 'bind').
    for (const s of this.sessions.values()) {
      if (s.machineId === machineId && s.queuedMessageCount > 0) {
        this.inbox.drain(s.sessionId)
      }
    }
    // Attach trigger (transcript-mirror spec §2.3): catch-up sweep after server/daemon
    // downtime — re-enqueue this machine's unmirrored segments. No-op without a lake dir.
    this.conversations().triggerLakeSweep(machineId)
    // A freshly-(re)connected daemon knows no session's relay priority. Clear the
    // delta cache so every current session re-sends as a change, then push the full
    // map — otherwise a daemon restart would leave the scheduler at its default
    // until the next viewState/attach happened to flip a session.
    this.state.resetPriorities()
    this.pushPriorities()
    // Archived survivors are never rebound — archive means stopped (POD-108).
    // Rows archived before archive learned to kill, or archived while this
    // machine's daemon was away, are still 'live'/'reconnecting' here; parking
    // them sends the kill now that a daemon can receive it (the daemon reaps the
    // durable host by label even without a bridge). Must run BEFORE the probe
    // fan-out below so an archived 'reconnecting' row is parked, not reattached.
    for (const s of this.sessions.values()) {
      if (s.machineId === machineId && !s.headless && s.archived) {
        this.parkArchivedSession(s.sessionId)
      }
    }
    // Re-bind survivor sessions ON THIS MACHINE: ask its daemon to reattach to their
    // live durable host. 'reconnecting' = was live/starting at boot. 'exited' (not
    // archived) is also probed because a row can be wrongly 'exited': its attach
    // client died on a daemon restart while the master + agent survived in their
    // scope (pre-fix orphans, or any residual race). The daemon reattaches a live
    // master (→ a bind → markLive) or replies reattachFailed (→ it stays exited).
    // The durable host, not the persisted row, is the source of truth for liveness.
    // View-priority first, then most-recently-used: the daemon gates its spawn
    // fan-out, so the order we send in decides who reattaches soonest. A session
    // some connected client is focused on / rendering (viewState is
    // server-authoritative — the same tiers the output scheduler uses) must come
    // back typable before the long unwatched tail (POD-612); within a tier,
    // lastActiveAt is an ISO string, so a reverse lexical sort is newest-first.
    const probes = [...this.sessions.values()].filter(
      (s) =>
        s.machineId === machineId &&
        !s.headless &&
        (s.status === 'reconnecting' || (s.status === 'exited' && !s.archived)),
    )
    const viewTiers = computePriorities(
      [...this.clients.values()],
      probes.map((s) => s.sessionId),
    )
    probes.sort(
      (a, b) =>
        (viewTiers.get(a.sessionId) ?? 3) - (viewTiers.get(b.sessionId) ?? 3) ||
        (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''),
    )
    const recoveryMachineAccess =
      machineUseDecision(
        systemPrincipal('session-rebind'),
        machineId,
        ownershipFromMachines(this.machines),
      ) === 'granted'
        ? 'allowed'
        : 'denied'
    for (const s of probes) {
      const observationLease = this.fenceObservation(s)
      const requestedGeneration = observationLease?.observationGeneration ?? 1
      this.toMachine(machineId, {
        type: 'reattach',
        sessionId: s.sessionId,
        durableLabel: s.durableLabel,
        agentKind: s.agentKind,
        cwd: s.cwd,
        geometry: s.terminal.geometry,
        binding: {
          transitionId: `reattach:${s.sessionId}:${requestedGeneration}`,
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
        ...(s.resume ? { resume: s.resume } : {}),
        ...(this.rpc.transcriptPathHint(s) ?? {}),
        // Spawn-time floor for observer-based harnesses (codex): lets a reattached
        // observer discover a lazily-created rollout it never saw before the restart.
        ...(Number.isFinite(Date.parse(s.createdAt))
          ? { createdAtMs: Date.parse(s.createdAt) }
          : {}),
        ...(this.draftSyncEnabled() ? { draftSync: true } : {}),
      })
    }
    // Headless sessions have no PTY to reattach; instead re-establish their
    // daemon-side transcript tails (fire-and-forget — re-issued on every daemon
    // connect, so a missed bind self-heals on the next attach).
    for (const s of this.sessions.values()) {
      if (s.machineId !== machineId || !s.headless || !s.resume?.value) continue
      void this.headless
        .headlessBind({
          sessionId: s.sessionId,
          agentKind: s.agentKind,
          cwd: s.cwd,
          resumeValue: s.resume.value,
        })
        .then((r) => {
          if (!r.ok) {
            console.warn(
              `[podium] headless bind failed for ${s.sessionId}: ${r.error ?? 'unknown'}`,
            )
          }
        })
    }
  }

  /**
   * That machine's daemon went away — the SESSION half of `detachDaemon`. The
   * superseded-socket guard, the `machine.disconnected` emit and the machine
   * broadcast are the gateway's; this runs only once the gateway has decided the
   * detach is real, in the same position it occupied before.
   */
  onMachineDetached(principal: MachinePrincipal): void {
    const machineId = principal.machine
    // The daemon that held THIS machine's sessions' PTY bridges is gone (daemon
    // restart/crash; durable masters survive in their own scopes). Drop only THIS
    // machine's live/starting sessions to 'reconnecting' so the next daemon to attach
    // re-binds them — attachDaemon only probes 'reconnecting'/'exited'. Sessions on
    // OTHER machines are untouched. Without this a daemon-only restart leaves sessions
    // 'live' but unattached: the server never re-asks and they orphan until a server
    // restart. (In the old single-process world the daemon never restarted alone, so
    // this gap couldn't surface.)
    const changed: Session[] = []
    for (const s of this.sessions.values()) {
      if (s.machineId !== machineId) continue
      // Headless sessions stay 'live' across daemon restarts — no PTY bridge to
      // lose; their tails re-establish via headlessBind on the next attach.
      if (s.headless) continue
      if (s.markReconnecting()) changed.push(s)
    }
    if (changed.length > 0) {
      for (const session of changed) this.markVolatileSessionDirty(session.sessionId, ['status'])
      this.broadcastSessions()
    }
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
    // Was a character-for-character copy of sessionWire()'s body; now the one
    // mapper, so the "must agree byte-for-byte" invariant in its doc comment is
    // structural instead of hand-maintained (POD-366).
    const principal = forPrincipal ?? this.defaultStatePrincipal()
    if (!principal) return []
    const local: SessionMeta[] = [...this.sessions.values()]
      .filter((session) => this.state.canReadSession(principal, session.sessionId))
      .map((session) => this.sessionWire(session, principal))
    return local
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
    this.state.setSnooze(this.statePrincipalForTrustedUser(asUserId(userId)), sessionId, until)
  }

  clearSnooze(userId: string, sessionId: SessionId): void {
    this.state.clearSnooze(this.statePrincipalForTrustedUser(asUserId(userId)), sessionId)
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
   * The composer draft's current revision, or `undefined` when the session has no
   * versioned draft doc. Read by the draft contract's handler to reject a STALE
   * `baseRevision` instead of overwriting a second writer's text — the one rule the
   * op-stream reservation enforces today (§3.3/§4).
   */
  draftRevision(sessionId: SessionId): number | undefined {
    return this.state.draftRevision(sessionId)
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
    this.persist(session, () => this.store.sessions.setOffer(sessionId, offer))
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
    this.persist(session, () => this.store.sessions.clearOffer(sessionId))
    this.broadcastSessions()
  }

  /** Phases that put a session in the sidebar's attention bucket — mirrors the
   *  web's attentionGroup 'needsYou' branch. Used to clear a snooze when the
   *  agent moves on. */
  private static isAttentionPhase(s: AgentRuntimeState | undefined): boolean {
    const phase = s?.phase
    if (phase === 'needs_user' || phase === 'errored') return true
    if (phase === 'idle') return !!s?.idle && s.idle.kind !== 'done'
    return false
  }

  /** Agent kind may be omitted — the settings default decides ('auto' = Claude Code).
   *  `initialPrompt` hands the fresh session the human's first prompt: for argv-capable
   *  agents (claude/codex/grok) it rides the launch command (`claude "<prompt>"`,
   *  race-free); for the rest it's seeded into the composer draft. */
  createSession(input: {
    /** Authenticated human owner; every production caller supplies this. */
    ownerUserId?: UserId
    agentKind?: AgentKind
    cwd: string
    title?: string
    /** Spawner-prescribed curated name [spec:SP-4ef9][spec:SP-eb60]. Lands in the
     *  `name` slot with `nameSource='agent'` (NOT the derived `title` slot). Same
     *  normalize rules as setAgentName; optional — absent leaves the child unnamed
     *  so it self-titles as today. */
    name?: string
    machineId?: string
    initialPrompt?: string
    /** Per-ticket model/effort override; absent = use the settings defaults. */
    model?: string
    effort?: string
    /** Resolved account selection from an execution profile; never credential material. */
    accountId?: AccountId
    /** Deliberately spawn with a model slug the live catalog doesn't list (bypasses
     *  the unknown-MODEL rejection only) [spec:SP-cc60]. Recorded in events when it
     *  takes effect. */
    forceUnknownModel?: boolean
    /** Creation provenance (issue #60). Deliberately NOT defaulted here — the tRPC
     *  router stamps 'user' (its callers are the human seams); programmatic callers
     *  (issues, superagent) pass their own value. Absent = unknown. */
    spawnedBy?: string
    /** OPTIONAL workflow pass-through metadata (#285 via #237 [spec:SP-34d7
     *  cross-harness]) — persisted verbatim, never interpreted here. */
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
    /** Explicit issue attachment (issue-as-workspace). Absent = derive: a session
     *  spawned inside a worktree owned by exactly one non-archived issue is
     *  "continuing that issue" and gets its id stamped. */
    issueId?: IssueId
    /** Client-supplied id (optimistic UI): use this verbatim instead of minting a
     *  fresh uuid, so an optimistic client row reconciles onto the real session
     *  without a swap. Absent = mint one (unchanged default behavior). */
    sessionId?: SessionId
    /** Explicit workflow override; absent = issue → repository → global default. */
    workflowRevisionId?: string
    /** The CALLING principal's per-machine `use` decision (ADR 3 Am1 D18). Absent
     *  = not evaluated, which is what every non-command-plane caller (issue
     *  start, superagent, boot reconcile) passes today. Threaded into placement
     *  so an IMPLICIT machine pick can never land on a machine the principal may
     *  not execute on — readiness §3.1.4 M5's "must not offer". */
    use?: MachineUseResolver
    /** Authenticated transport principal translated at the command composition
     * root. Internal pre-account callers default to the one authenticated user
     * here on the server; the daemon never invents one. */
    binding?: Omit<SessionBindingSpawnInstruction, 'transitionId' | 'machineAccess' | 'issueId'>
  }): SessionSpawnResult {
    // Resolve the agent down to a concrete AgentKind. `agentKind` may be absent,
    // or carry a non-AgentKind sentinel like 'auto' (the issue start-flow casts
    // the issue's `defaultAgent` `as AgentKind` at the boundary). 'auto' is NOT a
    // valid AgentKind: persisting or broadcasting it fails the sessionsChanged
    // zod-parse and silently wipes the whole session list on every client.
    // safeParse anything that isn't a real kind back to the coding role's harness.
    const requested = AgentKind.safeParse(input.agentKind)
    const agentKind = requested.success
      ? requested.data
      : resolveRole(this.store.settings.getSettingsFor(this.settingsViewer()), 'coding').harness
    // Reject an explicit model/effort the live catalog doesn't list BEFORE any spawn
    // side effect [spec:SP-cc60]. The last line of defense for the agent-spawn path
    // (issue start/add-session pre-check earlier, before mutating start state).
    const { forced } = assertModelSelectionValid(this.store.settings.getModelCatalog(), {
      agentKind,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.forceUnknownModel ? { force: true } : {}),
    })
    // Spawner name is validated before any side effect so a bad title never
    // leaves a half-spawned session. Fresh sessions have no user name to refuse.
    let curatedName: string | undefined
    if (input.name !== undefined) {
      const norm = normalizeAgentName(input.name)
      if (!norm.ok) throw new Error(norm.reason)
      curatedName = norm.name
    }
    // Explicit attachment wins; otherwise starting in an issue-owned worktree
    // means continuing that issue (spec: issue-as-workspace).
    const issueId = input.issueId ?? this.issues().soleOwnerForCwd(input.cwd) ?? undefined
    // MINT SITE: a server-minted session id. The brand belongs where the id is
    // GENERATED — nothing upstream had it, so this is not an adapter cast.
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const preparedInstructions = this.deps.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind,
      ...(issueId ? { issueId } : {}),
      ...(input.workflowRevisionId ? { workflowRevisionId: input.workflowRevisionId } : {}),
    })
    const taskPrompt = input.initialPrompt?.trim() ? input.initialPrompt.trim() : undefined
    const useArgv = taskPrompt !== undefined && harnessSupportsInitialPrompt(agentKind)
    // Session ownership is declared per class: an issue-owned child inherits the
    // issue owner; otherwise a binding resolves to its on-behalf-of human. The
    // explicit owner is the transport composition root's already-resolved answer,
    // never a wire field. The final fallback exists only for legacy in-process
    // callers with no binding.
    const parentOwner = issueId ? this.store.issues.getIssue(issueId)?.ownerUserId : undefined
    const bindingOwner =
      input.binding?.principal.kind === 'user'
        ? input.binding.principal.userId
        : input.binding?.principal.kind === 'agent'
          ? this.sessionOwner(input.binding.principal.parentBindingId)?.owner
          : undefined
    const ownerUserId = parentOwner ?? input.ownerUserId ?? bindingOwner ?? FIRST_ADMIN_USER_ID
    const machineId = this.machines.resolveMachineForAgent(
      input.machineId,
      input.cwd,
      agentKind,
      input.use,
    )
    const spawned = this.spawn({
      agentKind,
      ownerUserId,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(curatedName ? { name: curatedName, nameSource: 'agent' as const } : {}),
      origin: { kind: 'spawn' },
      machineId,
      bindingMachineAccess: input.use?.(machineId) === 'denied' ? 'denied' : 'allowed',
      ...(useArgv ? { initialPrompt: taskPrompt } : {}),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(issueId ? { issueId } : {}),
      binding: input.binding ?? {
        // One ownership answer feeds both the durable row and the daemon binding;
        // this seam never invents a different principal.
        principal: { kind: 'user', userId: ownerUserId },
      },
      sessionId,
    })
    preparedInstructions.commit()
    if (taskPrompt !== undefined && !useArgv) {
      this.setSessionDraft({ sessionId: spawned.sessionId, text: taskPrompt })
    }
    // Fire-and-forget notification (post-spawn, so subscribers observe the new
    // world). Its one consumer today is the opt-in telemetry usage counter
    // [spec:SP-f933], which is why the payload carries the harness kind and
    // nothing else — no cwd, no prompt, no issue id.
    this.bus.emit('session.created', { sessionId: spawned.sessionId, agentKind })
    // Forcing an unlisted model is a deliberate override — make it durable and
    // observable across every spawn path [spec:SP-cc60]. Only emitted when the force
    // actually bypassed an unknown model (a known model needs no force).
    if (forced) {
      this.store.events.appendEvent({
        ts: new Date().toISOString(),
        kind: 'agent.model_forced',
        subject: spawned.sessionId,
        payload: {
          sessionId: spawned.sessionId,
          harness: agentKind,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(issueId ? { issueId } : {}),
          ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
        },
      })
    }
    return spawned
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
    const issueId = s.issueId ?? this.issues().issueForCwd(s.cwd)
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

  async resumeSession(input: {
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
  }): Promise<{ sessionId: SessionId }> {
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
        const woke = await this.resurrectSession({ sessionId: existing.sessionId })
        if (!woke.ok) throw new Error(woke.reason ?? 'failed to resume parked session')
      } else {
        // Reopening a still-live but long-idle session also resets its hibernation
        // timer — the user is back on it even with no new message. (resurrectSession
        // already stamps this for the parked case above.)
        this.sessions.get(existing.sessionId)?.markResumed()
      }
      return { sessionId: existing.sessionId }
    }
    const issueId = this.issues().soleOwnerForCwd(input.cwd) ?? undefined
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

  sendText(input: InboxSendInput): { ok: boolean; queued?: boolean; reason?: string } {
    return this.inbox.sendText(input)
  }

  interruptText(input: InboxSendInput): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    return this.inbox.interruptText(input)
  }

  answerAskUserQuestion(input: {
    sessionId: SessionId
    choices: { optionIndices: number[] }[]
    principal?: InboxPrincipalReference
  }): { ok: boolean } {
    return this.inbox.answerAskUserQuestion({
      ...input,
      principal: input.principal ?? SYSTEM_INBOX_PRINCIPAL,
    })
  }
  setSessionDraft(input: { sessionId: SessionId; text: string }, fromClientId?: string): void {
    this.state.setDraft(input, fromClientId)
  }

  private draftSyncEnabled(): boolean {
    return this.state.draftSyncEnabled()
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

  private handleDraftEdit(input: DraftEditMessage, fromClientId: string): void {
    this.state.handleDraftEdit(input, fromClientId)
  }

  private maybeCatchupInject(sessionId: SessionId, machineId: string): void {
    this.state.maybeCatchupInject(sessionId, machineId)
  }

  queueText(input: InboxSendInput & { mutationId?: string }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    return this.inbox.queueText(input)
  }

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
        this.persist(session, additionalWrite ?? undefined)
      },
    })
    this.broadcastSessions()
  }

  /**
   * A HUMAN names the session (web rename, superagent `rename_session`) — the
   * curated slot, stamped `nameSource = 'user'` (#490). That stamp is sovereign:
   * setAgentName refuses against it forever after, so an agent can never overwrite
   * a name the user picked.
   *
   * Clearing (name = '') also clears the source — the session is unnamed again, so
   * an agent may name it (and the prime will ask it to).
   */
  renameSession({ sessionId, name }: { sessionId: SessionId; name: string }): void {
    this.mutateSessionMeta(sessionId, (session) => {
      const clean = name.trim()
      session.name = clean
      session.nameSource = clean ? 'user' : undefined
    })
  }

  /**
   * The AGENT names its own session (#490) — `podium session title "…"`, relayed as
   * sessions.title and bound to the calling session by the capability.
   *
   * Writes the same curated `name` slot the user writes, so it wins in the UI over
   * the derived `title` — but stamped 'agent', and REFUSED when the user already
   * named it. An agent may overwrite its OWN earlier agent-set name (retitling as
   * the work becomes clear) and may name a session whose name nobody set.
   *
   * Refusal is a returned reason, not a throw: the CLI prints it and the agent
   * carries on. Same persist + broadcast path as renameSession.
   */
  setAgentName({ sessionId, name }: { sessionId: SessionId; name: string }): {
    ok: boolean
    name?: string
    reason?: string
  } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'session not found' }
    const norm = normalizeAgentName(name)
    if (!norm.ok) return { ok: false, reason: norm.reason }
    // User-set names are sovereign [spec:SP-eb60]: refuse, never throw, never overwrite.
    if (session.nameSource === 'user') {
      return {
        ok: false,
        name: session.name,
        reason: `this session was named by the user ("${session.name}") — an agent cannot rename it`,
      }
    }
    this.mutateSessionMeta(sessionId, (s) => {
      s.name = norm.name
      s.nameSource = 'agent'
    })
    return { ok: true, name: norm.name }
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
    this.persist(session)
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
    if (observed.readerUserId !== this.broadcastViewer()) return 'precondition'
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
    const readMs = Date.parse(this.viewerOverlay(observed.sessionId).readAt ?? '')
    if (!Number.isFinite(stoppedMs) || !Number.isFinite(readMs) || readMs < stoppedMs) {
      return 'precondition'
    }
    if (Math.max(stoppedMs, readMs) > nowMs - AUTO_ARCHIVE_READ_WINDOW_MS) return 'not-due'
    if (session.issueId) {
      const issue = this.deps.issuesWire().find((candidate) => candidate.id === session.issueId)
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
    this.state.markRead(this.statePrincipalForTrustedUser(asUserId(userId)), sessionId)
  }

  /** Mark this session UNREAD again (issue #138, the email-style inverse of
   *  markSessionRead): DELETE the actor's marker so the derived `unread` (readAt
   *  null ⇒ unread) flips back to true, then broadcast. Marking MY copy unread
   *  never touches yours. No-op for an unknown session. */
  markSessionUnread(userId: string, sessionId: SessionId): void {
    this.state.markUnread(this.statePrincipalForTrustedUser(asUserId(userId)), sessionId)
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
      if (issueId) return this.prepareSessionRefAllocation(session)
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
  async stopSession(input: {
    sessionId: SessionId
    force?: boolean
    /** True when the CALLER is stopping itself — defer process kill. */
    selfStop?: boolean
    /** Parent-close/issue-stop provenance; direct forced stops derive below. */
    stopReason?: 'self' | 'parent' | 'forced'
  }): Promise<{
    ok: boolean
    reason?: string
    worktreeFreed?: boolean
    deferredKill?: boolean
  }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }

    const issueId = session.issueId ?? this.issues().issueForCwd(session.cwd)
    const issue = issueId ? this.issues().getMeta(issueId) : undefined
    const worktreePath = issue?.worktreePath ?? null

    // Unsaved-work guard: inspect the working copy when present. Branch commits
    // alone are not a refusal — the branch is always kept.
    if (worktreePath && !input.force) {
      const st = await this.rpc.repoOp(
        'status',
        worktreePath,
        undefined,
        session.machineId === LOCAL_PLACEHOLDER ? undefined : session.machineId,
      )
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
      this.persist(session, () =>
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
        const freed = await this.issues().freeWorktreeKeepBranch(issueId, {
          force: input.force === true,
        })
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
  async stopIssue(input: {
    issueId: string
    force?: boolean
    /** Session performing the stop (for self-stop deferral when it is a member). */
    callerSessionId?: string
  }): Promise<{
    ok: boolean
    reason?: string
    stopped: string[]
    worktreeFreed: boolean
    deferredKill?: boolean
  }> {
    const issue = this.issues().getMeta(input.issueId)
    if (!issue) return { ok: false, reason: 'unknown issue', stopped: [], worktreeFreed: false }
    // sessionsForIssue matches on the canonical issue id; input.issueId may be a
    // human ref/seq that getMeta resolved above but a raw string compare would miss [POD-985].
    const members = sessionsForIssue(issue.worktreePath ?? null, this.listSessions(), issue.id)
    const stopped: string[] = []
    let deferredKill = false
    // Non-self members first (immediate kill). Self last so sibling stops + free
    // finish before the caller's deferred kill is armed after the relay reply.
    const ordered = [
      ...members.filter((m) => m.sessionId !== input.callerSessionId),
      ...members.filter((m) => m.sessionId === input.callerSessionId),
    ]
    for (const m of ordered) {
      const r = await this.stopSession({
        sessionId: m.sessionId,
        force: input.force,
        selfStop: input.callerSessionId === m.sessionId,
        stopReason: input.force ? 'forced' : 'parent',
      })
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
    const current = this.issues().getMeta(input.issueId)
    const wt = current?.worktreePath ?? null
    if (wt) {
      const stillUsing = liveSessionsUsingWorktree(wt, this.listSessions())
      if (stillUsing.length === 0) {
        const freed = await this.issues().freeWorktreeKeepBranch(input.issueId, {
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
   * Park a live session: kill its process (and durable host) but keep the row,
   * its transcript, and the resume ref. One click brings it back. Returns false
   * when the session can't come back later (no resume ref) — we refuse rather
   * than silently turn "hibernate" into "kill".
   */
  private terminalCandidateFacts(
    session: Session,
    lease: ObservationLeaseRecord,
    checkpoint = lease.checkpoint,
  ): TerminalCandidateFacts | null {
    const fence = checkpoint?.terminalFence
    if (!checkpoint || !fence || fence.closing) return null
    if (!['idle', 'errored', 'ended'].includes(checkpoint.turnState.phase)) return null
    const addressedMessages = this.store.messages
      .pendingForSessionProof(session.sessionId, new Date(this.now()).toISOString())
      .map((message) => ({
        id: message.id,
        status: message.status,
        deliveredAt: message.deliveredAt,
        injectedAt: message.injectedAt ?? null,
        ackedBy: message.ackedBy,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const activeChildren = [...this.sessions.values()]
      .filter(
        (child) =>
          child.spawnedBy === `session:${session.sessionId}` &&
          (child.status === 'starting' ||
            child.status === 'live' ||
            child.status === 'reconnecting'),
      )
      .map((child) => ({
        sessionId: child.sessionId,
        status: child.status,
        activityCount: child.terminal.activityCount,
      }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    const activeWork = {
      nativeSubagentCount: checkpoint.turnState.nativeSubagentCount,
      nativeSubagentIds: (checkpoint.turnState.nativeSubagents ?? [])
        .map((child) => child.id)
        .sort(),
      awaitingSubagents: checkpoint.turnState.awaitingSubagents === true,
      childSessions: activeChildren,
      queueDrainActive: this.inbox.isDraining(session.sessionId),
      draftPending: session.draftUpdatedAt !== undefined,
      draftVersion: session.draftUpdatedAt ?? null,
      offerPending: session.offer !== undefined,
    }
    return {
      schemaVersion: 1,
      sessionId: session.sessionId,
      terminalTransitionId: fence.transitionId,
      terminalTurnEpoch: fence.turnEpoch,
      provider: lease.provider,
      providerSessionId: lease.providerSessionId,
      bindingVersion: lease.bindingVersion,
      observerGeneration: lease.observationGeneration,
      providerCursor: checkpoint.providerCursor ?? fence.providerCursor,
      lastLiveReceiptAt: checkpoint.lastLiveReceiptAt,
      lastTransitionId: checkpoint.lastTransitionId,
      lastActiveAt: session.lastActiveAt,
      lastInputAtMs: session.terminal.lastInputAtMs,
      lastOutputAtMs: session.terminal.lastOutputAtMs,
      lastResumedAtMs: session.terminal.lastResumedAtMs,
      inputCount: session.terminal.inputCount,
      outputCount: session.terminal.outputCount,
      activityCount: session.terminal.activityCount,
      queuedInputCount: session.queuedMessageCount,
      pendingMessages: addressedMessages,
      autoContinueActive: this.autoContinue.isActive(session.sessionId),
      activeWork,
      resumable: session.resume !== undefined,
      machineId: session.machineId,
    }
  }

  private terminalFactsConsumable(facts: TerminalCandidateFacts): boolean {
    if (
      !facts.resumable ||
      facts.queuedInputCount !== 0 ||
      facts.pendingMessages.length !== 0 ||
      facts.autoContinueActive
    )
      return false
    const active = facts.activeWork
    return (
      active.nativeSubagentCount === 0 &&
      !active.awaitingSubagents &&
      active.childSessions.length === 0 &&
      !active.queueDrainActive &&
      !active.draftPending &&
      !active.offerPending
    )
  }

  hasValidTerminalProof(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId)
    const lease = this.store.observationCheckpoints.get(sessionId)
    if (!session || !lease || (session.status !== 'live' && session.status !== 'reconnecting'))
      return false
    const facts = this.terminalCandidateFacts(session, lease)
    const proof = this.store.observationCheckpoints.getTerminalCandidate(sessionId)
    return Boolean(
      facts &&
        proof?.confirmedAt &&
        !proof.consumedAt &&
        JSON.stringify(proof.facts) === JSON.stringify(facts) &&
        this.terminalFactsConsumable(facts),
    )
  }

  terminalProofMissing(sessionId: SessionId): boolean {
    const lease = this.store.observationCheckpoints.get(sessionId)
    return (
      lease?.checkpoint?.terminalFence == null ||
      this.store.observationCheckpoints.getTerminalCandidate(sessionId) == null
    )
  }

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
    const facts = lease ? this.terminalCandidateFacts(session, lease) : null
    if (requireTerminalProof) {
      if (!facts || !this.terminalFactsConsumable(facts)) {
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
      this.persist(
        session,
        facts
          ? () => {
              const currentLease = this.store.observationCheckpoints.get(sessionId)
              const currentFacts = currentLease
                ? this.terminalCandidateFacts(session, currentLease)
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
  ): Promise<{ ok: true; newCwd: string }> {
    return this.handoffs().handoff(input, caller, this.machineUseGate(caller))
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
  private handoffs(): HandoffCoordinator {
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
      issueMeta: (issueId) => this.issues().getMeta(issueId) ?? undefined,
      rehomeIssue: (issueId, where) => this.issues().rehome(issueId, where),
      ensureTargetRepo: (sourceRepo, targetMachineId) =>
        this.workspace.ensureTargetRepo(sourceRepo, targetMachineId),
      persist: (session) => this.persist(session),
      mutateSessionView: (sessionId, mutate) => {
        this.mutateSessionView(sessionId, mutate)
      },
      broadcastSessions: () => this.broadcastSessions(),
      onSessionGone: (sessionId) => this.autoContinue.onSessionGone(sessionId),
      toMachine: (machineId, message) => this.toMachine(machineId, message),
      onWorktreesChanged: (repoPath, machineId) =>
        this.deps.onWorktreesChanged(repoPath, machineId),
      resumeSession: (resumeInput) => this.resumeSession(resumeInput),
      resurrectSession: (resurrectInput) => this.resurrectSession(resurrectInput),
      recordEvent: (event) => {
        this.store.events.appendEvent(event)
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
    this.handoffCoordinator = new HandoffCoordinator(ports)
    return this.handoffCoordinator
  }


  /**
   * Chat-compose path for a parked session: if it's live, just send; if it's
   * hibernated/exited (process gone, conversation intact), wake it first and
   * deliver the text once the resumed CLI is ready to receive it. Lets the chat
   * composer accept a message on a sleeping agent instead of refusing input —
   * the message itself becomes the reason to wake.
   */
  resumeAndSend(input: InboxSendInput & { mutationId?: string }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    return this.inbox.resumeAndSend(input)
  }

  /** Wake a hibernated session: respawn under the same id with its resume ref.
   *  If stop freed the worktree, recreates it from the preserved branch first
   *  [spec:SP-9904]. */
  resurrectSession({
    sessionId,
    adoptedBinding,
  }: {
    sessionId: SessionId
    adoptedBinding?: SessionBindingAdoptLaunchInstruction
  }): Promise<{ ok: boolean; reason?: string }> {
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
    const ensured = this.workspace.ensureSessionWorktree(session)
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
    this.persist(session)
    const observationLease = this.fenceObservation(session)
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
      ...this.modelDefaults(session.agentKind),
      ...this.accountEnv(session.agentKind, session.accountId),
      ...(this.draftSyncEnabled() ? { draftSync: true } : {}),
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
      this.issues().reapIfEmptyDraft(issueId)
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
      s.toMeta(this.viewerOverlay(s.sessionId)),
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
        this.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Prepare restoration of the sessions tombstoned by one issue deletion. The
   *  durable rows and ledger upserts commit with the issue restore; runtime
   *  installation follows only after that transaction succeeds. */
  prepareIssueSessionRestore(issueId: string): SessionRestorePlan {
    const rows = this.store.sessions.loadDeletedSessionsForIssue(issueId)
    const restored = rows
      .map((row) => ({ row, session: this.sessionFromStoredRow(row, 'restore') }))
      .filter((entry): entry is { row: SessionRow; session: Session } => entry.session !== null)
    return {
      sessionIds: restored.map(({ session }) => session.sessionId),
      restoredSessions: restored.map(({ session }) => this.sessionWire(session)),
      write: () => this.store.sessions.restoreDeletedForIssue(issueId),
      changes: () =>
        restored.map(({ session }) => ({
          entity: 'session' as const,
          id: session.sessionId,
          op: 'upsert' as const,
          value: this.sessionWire(session),
        })),
      apply: (changes, ledgerCursor) => {
        this.state.loadFromStore()
        const offers = this.store.sessions.listOffers() // [spec:SP-c7f1]
        for (const { session } of restored) {
          this.installStoredSession(session, offers)
        }
        // Restored sessions may carry per-user rows; the overlay is read fresh.
        this.invalidateViewerOverlay()
        this.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Runtime half of a durable session removal. Kept separate so issue deletion
   *  can batch many rows in one transaction and one sessions broadcast. */
  private removeSessionRuntime(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId)
    // The issues service owns the per-session Git attribution ledger. Notify it
    // while membership/cwd are still resolvable, before this permanent removal.
    this.issues().onSessionRemovedOrArchived(sessionId)

    this.toMachine(session?.machineId ?? LOCAL_PLACEHOLDER, {
      type: 'kill',
      sessionId,
      ...(session ? { durableLabel: session.durableLabel } : {}),
    })
    this.autoContinue.onSessionGone(sessionId)
    session?.terminal.detachAll()
    this.sessions.delete(sessionId)
    this.state.removeSession(sessionId)
    this.daemonProjection.disposeTitle(sessionId)
    for (const c of this.clients.values()) c.attached.delete(sessionId)
    this.pendingVolatileSessions.delete(sessionId)
    this.capturedSessionStates.delete(sessionId)
    if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
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
    this.removeSessionRuntime(input.sessionId)
    this.publishSessionProjection(changes)
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

  private spawn(input: {
    agentKind: AgentKind
    ownerUserId?: UserId
    cwd: string
    title?: string
    /** Curated name at birth (spawner-prescribed or other); pairs with nameSource. */
    name?: string
    nameSource?: 'user' | 'agent'
    origin: SessionMeta['origin']
    resume?: ResumeRef
    machineId?: string
    initialPrompt?: string
    instructions?: AgentInstruction[]
    /** Per-ticket model/effort override; absent = use the settings defaults. */
    model?: string
    effort?: string
    accountId?: AccountId
    spawnedBy?: string
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
    issueId?: IssueId
    /** Client-supplied id (optimistic UI); absent = mint one (unchanged default). */
    sessionId?: SessionId
    binding?: Omit<SessionBindingSpawnInstruction, 'transitionId' | 'machineAccess' | 'issueId'>
    bindingMachineAccess?: SessionBindingSpawnInstruction['machineAccess']
  }): SessionSpawnResult {
    // A server-minted uuid was unique by construction; a client-supplied id is
    // not. Reject a collision rather than let `sessions.set` overwrite the live
    // Session (orphaning its PTY/daemon binding) or re-fire a spawn. `withMutation`
    // already dedupes a genuine retry before we get here, so a hit is a real clash.
    if (input.sessionId && this.sessions.has(input.sessionId)) {
      throw new Error(`refusing to reuse an existing session id: ${input.sessionId}`)
    }
    // MINT SITE: a server-minted session id. The brand belongs where the id is
    // GENERATED — nothing upstream had it, so this is not an adapter cast.
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const machineId = input.machineId ?? LOCAL_PLACEHOLDER
    const launch = this.modelDefaults(
      input.agentKind,
      input.model !== undefined || input.effort !== undefined
        ? { model: input.model, effort: input.effort }
        : undefined,
    )
    const accountId =
      input.agentKind === 'shell'
        ? undefined
        : (input.accountId ??
          resolveRole(this.store.settings.getSettingsFor(this.settingsViewer()), 'coding')
            .accountId)
    const session = new Session({
      sessionId,
      ownerUserId: input.ownerUserId ?? FIRST_ADMIN_USER_ID,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort ? { effort: launch.effort } : {}),
      ...(accountId ? { accountId } : {}),
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      machineId,
      // Bind the route to the live machineId (tracks the local-adoption reassignment).
      toDaemon: (msg) => this.toMachine(this.sessions.get(sessionId)?.machineId ?? machineId, msg),
      onActivity: () => {
        // Shell busy transitions advance lastActiveAt (their only activity signal);
        // persist so that recency is durable across a restart, then rebroadcast.
        this.persist(session)
        this.broadcastSessions()
      },
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.nameSource ? { nameSource: input.nameSource } : {}),
    })
    this.sessions.set(sessionId, session)
    // Naming point (#474): input.issueId is the resolved birth issue (or absent
    // for a genuinely issueless spawn) — allocate the permanent ref now.
    const additionalWrite = this.prepareSessionRefAllocation(session)
    this.persist(session, additionalWrite)
    const observationLease = this.fenceObservation(session)
    this.toMachine(machineId, {
      type: 'spawn',
      sessionId,
      durableLabel: session.durableLabel,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.binding
        ? {
            binding: {
              transitionId: `spawn:${sessionId}`,
              machineAccess: input.bindingMachineAccess ?? 'allowed',
              ...input.binding,
              ...(input.issueId ? { issueId: input.issueId } : {}),
            },
          }
        : {}),
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
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      ...(input.instructions?.length ? { instructions: input.instructions } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
      ...launch,
      ...this.accountEnv(input.agentKind, accountId),
      ...(this.draftSyncEnabled() ? { draftSync: true } : {}),
    })
    this.broadcastSessions()
    return {
      sessionId,
      agentId: sessionId,
      harness: input.agentKind,
      model: launch.model ?? null,
      effort: launch.effort ?? null,
      machine: this.machines.machineName(machineId),
      machineId,
      accountId: accountId ?? null,
    }
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

  private modelDefaults(
    agentKind: AgentKind,
    override?: { model?: string; effort?: string },
  ): { model?: string; subagentModel?: string; effort?: string; seedCliTheme?: boolean } {
    const settings = this.store.settings.getSettingsFor(this.settingsViewer())
    const coding = settings.roles.coding
    const useCodingDefaults = agentKind === resolveRole(settings, 'coding').harness
    const explicitModel = override?.model
    const explicitEffort = override?.effort
    const model =
      explicitModel !== undefined && explicitModel !== 'auto'
        ? explicitModel
        : useCodingDefaults
          ? coding.model
          : 'auto'
    const effort =
      explicitEffort !== undefined && explicitEffort !== 'auto'
        ? explicitEffort
        : useCodingDefaults
          ? coding.effort
          : 'auto'
    const subagentModel = coding.subagentModel
    return {
      ...(model !== 'auto' && agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== 'auto' && harnessCapabilitiesFor(agentKind)?.subagentModelEnv
        ? { subagentModel }
        : {}),
      // Cursor + shell have no effort flag; agentLaunchCommand also drops it, but
      // gating here keeps the spawn message clean (capability lookup, #158).
      ...(effort !== 'auto' && harnessSupportsEffort(agentKind) ? { effort } : {}),
      // Per-session CLI theme seeding rides every (re)spawn so a resurrected
      // session keeps the configured behaviour too [spec:SP-a04d].
      ...(agentKind !== 'shell' ? { seedCliTheme: coding.seedCliTheme } : {}),
    }
  }

  /** The managed credential (if any) for the coding role, as spawn env (#216).
   *  Native accounts yield {} — the CLI uses its own login and the frame is
   *  unchanged. Read live at spawn, like modelDefaults.
   *
   *  NEVER injected into a 'shell' pane: a shell is an interactive prompt the user
   *  drives, so the credential would be one `env` away from being streamed to the
   *  browser and written into persisted scrollback. Only an agent harness — which
   *  is what the coding role's credential is FOR — gets it. (modelDefaults()
   *  special-cases shell for the same reason of shape: a shell is not an agent.) */
  private accountEnv(
    agentKind: AgentKind,
    accountId = resolveRole(
      this.store.settings.getSettingsFor(this.settingsViewer()),
      'coding',
    ).accountId,
  ): { env?: Record<string, string> } {
    if (agentKind === 'shell') return {}
    return resolveAccountEnv(this.store.accounts, accountId)
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

  /** Authorization/view invalidation seam: the main authority changed one client world. */
  refreshClientPublication(id: string): void {
    this.publication.refreshClient(id)
  }

  publicationMetrics(): SessionPublicationMetrics {
    return this.publication.metrics()
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
  private adoptWorktree(
    issueId: string,
    msg: Extract<DaemonMessage, { type: 'sessionCwd' }>,
  ): void {
    const issue = this.issues().getMeta(issueId)
    if (!issue || issue.archived || issue.worktreePath !== null) return
    // Only a POD-665+ daemon may adopt: `kind` is the ONLY trustworthy way to know a
    // path is a real worktree and not main, because it comes from git. An older daemon
    // sends no `kind` and simply does not adopt — its sessions self-heal the instant
    // its binary updates, since any hook cwd from a real worktree then adopts.
    //
    // Its old guard (`explicit && issue.repoPath !== msg.cwd`) is deliberately NOT kept.
    // It identifies "main" by string-comparing against a REGISTERED path, which holds
    // only while that string is byte-identical to git's toplevel: a symlinked repo path
    // resolves to its real path, so the compare says "not main" and the issue gets
    // stamped with live main itself — the swallow-everything failure [spec:SP-595b].
    // Path tests cannot be rescued here either, since worktrees live INSIDE the repo
    // dir (`<repo>/.worktrees/x`) — no prefix separates them from a main subdirectory.
    // That is the whole reason classification moved into git. A nicety that heals on
    // its own is not worth a live-main stamp during a mixed-version rollout.
    if (msg.kind !== 'worktree') return
    // Absent repoRoot means an exotic layout (a bare repo serving worktrees) where no
    // primary checkout exists to compare; the remaining guards still apply.
    if (msg.repoRoot !== undefined && msg.repoRoot !== issue.repoPath) return
    if (this.issues().worktreePaths().includes(msg.cwd)) return
    this.issues().update(issue.id, {
      worktreePath: msg.cwd,
      // Absent on a detached HEAD: take the worktree, leave the branch claim alone.
      ...(msg.branch ? { branch: msg.branch } : {}),
    })
  }

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
        if (msg.draftSyncEngine) this.maybeCatchupInject(msg.sessionId, machineId)
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
        this.issues().onSessionActivity(msg.sessionId)
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
        this.issues().onSessionActivity(session.sessionId)
        this.inbox.stateChanged({
          sessionId: session.sessionId,
          prev,
          next,
          observation,
        })
        if (SessionLifecycle.isAttentionPhase(prev) && !SessionLifecycle.isAttentionPhase(next)) {
          this.state.clearAllSnoozes(session.sessionId)
        }
        if (!SessionLifecycle.isAttentionPhase(prev) && SessionLifecycle.isAttentionPhase(next)) {
          this.issues().onSessionAttention(session.sessionId)
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
        this.issues().onSessionActivity(msg.sessionId)
        // Turn end (working → anything else) is the only moment new commits can
        // appear — refresh the owning issue's git state [POD-98].
        if (prev?.phase === 'working' && next.phase !== 'working') {
          this.issues().onSessionTurnEnd(msg.sessionId)
        }
        // Synchronous fan-out to bus subscribers (NotifyService) — same ordering
        // as the old direct notifyAttention call.
        this.inbox.stateChanged({ sessionId: msg.sessionId, prev, next })
        if (SessionLifecycle.isAttentionPhase(prev) && !SessionLifecycle.isAttentionPhase(next)) {
          this.state.clearAllSnoozes(msg.sessionId)
        }
        // Entering an attention phase = a new message needs the user: end any
        // "until next message" defer on the issue that owns this session.
        if (!SessionLifecycle.isAttentionPhase(prev) && SessionLifecycle.isAttentionPhase(next)) {
          this.issues().onSessionAttention(msg.sessionId)
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
