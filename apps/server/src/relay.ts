import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from '@podium/harness/metadata'
import type { AgentKind, SessionId, SessionMeta } from '@podium/model'
import { asSessionId, asUserId, FIRST_ADMIN_USER_ID, spawnedByParentSessionId } from '@podium/model'
import type { LiveServerMessage, VisibilityResolver } from '@podium/protocol'
import { formatIssueRef, SubscriptionRegistry } from '@podium/protocol'
import { durableSessionLabel } from '@podium/runtime/instance'
import { stateDir } from '@podium/runtime/local-machine'
import {
  DEVICE_GRADE_PRINCIPAL,
  FeedIdentityRegistry,
  GrantEdgeVisibilityPolicy,
  kernelVisibilityResolver,
  Ledger,
  MutationLedger,
  NoDelegationsGranted,
} from '@podium/sync'
import { IssueAttachOrchestrator } from './application/issue-attach-orchestrator'
import {
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from './command-principal'
import { composeReactions, REACTIONS, type ReactionDefinition } from './composition/reactions'
import { getFeatureStates, isFeatureEnabled } from './features'
import { makeFeedVisibility } from './feed-visibility'
import { ClientMux } from './gateway/client-mux'
import { ClientRegistry } from './gateway/client-registry'
import { DaemonMux } from './gateway/daemon-mux'
import { FeedServing } from './gateway/feed-serving'
import { PresenceRouting } from './gateway/presence-routing'
import { checkMachineUse, ownershipFromMachines } from './machine-access'
import type { ModelProbe } from './model-catalog'
import { NativeLoginService } from './modules/accounts/native-login'
import { ApprovalService } from './modules/approvals/service'
import { AutomationScheduler } from './modules/automations/scheduler'
import { AutomationsService } from './modules/automations/service'
import { EventBus } from './modules/bus'
import { DaemonRequestBroker } from './modules/daemon-request'
import { EventLogRetention } from './modules/events/retention'
import { WriteFunnel } from './modules/funnel'
import { HostsService, type MemoryBreakdown } from './modules/hosts/service'
import { IssueSessionLifecycle } from './modules/issue-session-lifecycle'
import { DurableIssueAccessIndex } from './modules/issues/access-index'
import { IssueArtifactStore } from './modules/issues/artifact-store'
import { IssueAutoArchive } from './modules/issues/auto-archive'
import { IssueCommandDispatcher } from './modules/issues/dispatcher'
import { IssueGitWatch } from './modules/issues/git-watch'
import { repoProjectionRows } from './modules/issues/projection'
import { IssuePublisher } from './modules/issues/publish'
import { makeAgentRelayDispatch } from './modules/issues/relay-dispatch'
import { AgentRelayGate } from './modules/issues/relay-gate'
import { IssueService } from './modules/issues/service'
import { LayoutService } from './modules/layout/service'
import { LockCommandDispatcher } from './modules/lock/registry'
import { LockService } from './modules/lock/service'
import { routeMachineDiagnostic } from './modules/machines/diagnostics'
import { LoginPropagationService } from './modules/machines/login-propagation'
import { DaemonRpcService } from './modules/machines/rpc'
import { MachinesService, type PairingCodes } from './modules/machines/service'
import { MemoryService } from './modules/memory/service'
import { restartAsDaemon } from './modules/server-transfer/lifecycle'
import { ServerTransferService } from './modules/server-transfer/service'
import { MessageGate } from './modules/messages/gate'
import { principalMailPolicy } from './modules/messages/handlers/context'
import { QueuedMessageApply } from './modules/messages/queued-apply'
import { DELIVERY_RETRY_BACKSTOP_MS } from './modules/messages/scheduler'
import { MessageDeliveryService } from './modules/messages/service'
import { makeSpawnOnWake } from './modules/messages/spawn'
import {
  DEFAULT_NOTIFICATION_PUSHERS,
  type NotificationPushers,
  NotifyService,
  type SessionNoticeInfo,
} from './modules/notify/service'
import { DEPLOYMENT, type PerfRegistry, perf } from './modules/perf/registry'
import { ReadPositionService } from './modules/read-position/service'
import { machinesForPrincipal } from './modules/sessions/command-ctx'
import { SessionInstructionRegistry } from './modules/sessions/instructions'
import { SessionLifecycle } from './modules/sessions/lifecycle'
import type { SnapshotTail } from './modules/sessions/publication/coordinator'
import type { PublishWorkerClient } from './modules/sessions/publish-worker-client'
import { SessionReadToolkit } from './modules/sessions/read-toolkit'
import type { Session } from './modules/sessions/session'
import { SettingsService, type TelegramSetupClient } from './modules/settings/service'
import { SpecsService } from './modules/specs/service'
import { deliverAnswerToSession } from './modules/superagent/answer-delivery'
import type { HeadlessService } from './modules/superagent/headless'
import { UpdatesService } from './modules/updates/service'
import { WorkflowService } from './modules/workflows/service'
import { inferRepoFromRoots } from './repo-registry'
import { StewardService } from './steward'
import { SessionStore } from './store'

// Re-exported so repo-registry/superagent/tests keep importing the daemon-RPC
// result shapes from './relay'.
export type {
  OpResult,
  ScanReposResult,
  ScanResult,
} from './modules/machines/rpc'
export type { MemoryBreakdown }

interface SessionRegistryOptions {
  /** Boot-resolved deployment identity; every composition root names it explicitly. */
  instanceId: string
  /**
   * The server target app label for derived machine version state. The real
   * composition root supplies the baked app version; fixtures may omit it.
   */
  targetVersion?: () => string | undefined
  /** Public half of this server's update-signing key, sent on every successful machine hello. */
  updatePubkey?: () => string
  telegramSetup?: TelegramSetupClient
  generateTelegramSetupCode?: () => string
  now?: () => number
  /** Root of the transcript lake ($PODIUM_STATE_DIR/transcripts). Opt-in: when unset
   *  (the default — every existing test), NO mirror traffic is produced. */
  mirrorLakeDir?: string
  /** Live model-list probe (grok/cursor/opencode `models`). Injected in tests so the
   *  catalog never shells out; defaults to the real CLI probe. */
  modelProbe?: ModelProbe
  /** Inbound daemon pairing codes — a HUB-role capability injected from server
   *  assembly (core never imports hub/pairing; see roles.ts). Absent = pairing
   *  disabled: mint throws, `pair` handshakes are rejected, `hello` unaffected. */
  pairing?: PairingCodes
  /**
   * Enrollment ledger (POD-1114, D19.4) — pairing root + append-only enrollment,
   * owner and revocation facts at the state-root tier. Injected from server
   * assembly so the path is composition-owned; absent only in fixtures that never
   * exercise pairing durability.
   */
  enrollment?: import('./enrollment-ledger').EnrollmentLedger
  /** Deterministic publication-worker fault injection for service-level tests. */
  publicationWorker?: PublishWorkerClient
  /** Rollout-only semantic comparison of legacy and worker publications. */
  publicationShadowCompare?: boolean
  /** Reaction contracts to publish on the module seam. Defaults to the registry;
   *  injected only so the runtime refusal of an invalid principal is observable
   *  (POD-1470). Whatever is passed goes through the same totality check the
   *  registry does — a widened system writeScope fails construction. */
  reactions?: readonly unknown[]
}

/** The composed module set (issue #13 Phase 2): the typed seam every caller —
 *  router procs (ctx.modules), server assembly, superagent, tests — reaches
 *  services through. */
export interface RegistryModules {
  bus: EventBus
  funnel: WriteFunnel
  sessions: SessionLifecycle
  machines: MachinesService
  updates: UpdatesService
  rpc: DaemonRpcService
  serverTransfer: ServerTransferService
  loginPropagation: LoginPropagationService
  nativeLogin: NativeLoginService
  memory: MemoryService
  hosts: HostsService
  settings: SettingsService
  /** Per-user sidebar/tab layout (POD-1350) — store + feed publish behind one service. */
  layout: LayoutService
  /** Per-user event-stream read positions (POD-1380) — same shape, monotonic merge. */
  readPosition: ReadPositionService
  issueSessionLifecycle: IssueSessionLifecycle
  headless: HeadlessService
  notify: NotifyService
  issues: IssueService
  issuePublisher: IssuePublisher
  issueCommands: IssueCommandDispatcher
  specs: SpecsService
  approvals: ApprovalService
  workflows: WorkflowService
  /** Advisory named lease locks [spec:SP-85d1]. */
  locks: LockService
  lockCommands: LockCommandDispatcher
  /** Scheduled automations (#470) [spec:SP-17db] — the Automations tab's cron half. */
  automations: AutomationsService
  /** Unified agent messaging (#237) [spec:SP-34d7]. */
  messages: MessageDeliveryService
  /** `podium mail` command surface over the substrate (#237) [spec:SP-34d7]. */
  messageGate: MessageGate
  /** Read toolkit tiers 1–2 — session status/read (#237) [spec:SP-34d7]. */
  readToolkit: SessionReadToolkit
  /** Permanent artifact snapshot store ([spec:SP-0fc9] #441). */
  issueArtifacts: IssueArtifactStore
  /** Total operational contract for every semantically asynchronous reaction. */
  reactions: readonly ReactionDefinition[]
  /** Switch-latency perf registry [POD-701] — the process-level singleton,
   *  exposed here so router procs reach it through the module seam. */
  perf: PerfRegistry
  /** Framework idempotency (POD-382) — the ONE mutationId dedup, exposed on the
   *  module seam so a transport wires the framework's implementation rather than
   *  reaching into a service for it. */
  mutations: MutationLedger
}

/** Projection of a Session to the fields an attention notice needs. */
function noticeInfo(session: Session): SessionNoticeInfo {
  return {
    sessionId: session.sessionId,
    ...(session.name ? { name: session.name } : {}),
    ...(session.title ? { title: session.title } : {}),
    cwd: session.cwd,
    agentKind: session.agentKind,
  }
}

/**
 * The server's composition root (issue #13 Phase 2 → #191). The constructor IS
 * the composition: it builds the module graph in dependency order
 * (bus → machines/rpc → settings/notify/hosts → issue wire plumbing → sessions →
 * conversations → issues → commands), wires the cross-module bus subscriptions,
 * runs the module boot hooks, and exposes the graph as the typed `modules` set.
 * There is NO delegating facade here any more: callers hold `modules.<svc>`
 * (or the store's aggregate repositories) directly.
 */
export class SessionRegistry {
  /** Typed in-process event bus — modules subscribe here (issue #13 Phase 2). */
  readonly bus = new EventBus()
  /** Typed accessor to the composed services — the one seam callers use. */
  readonly modules: RegistryModules
  /**
   * THE GATEWAY's daemon socket mux (POD-389). `attachDaemon`, `detachDaemon` and
   * `routeDaemonFrame` live here, not on the sessions service: a daemon
   * connection is a MACHINE principal whose frames belong to many features, and
   * the sessions service is one of them.
   */
  readonly gateway: DaemonMux
  /**
   * THE GATEWAY's client socket mux (POD-390). `attachClient`, `detachClient`
   * and `routeClientFrame` live here, not on the sessions service: a client
   * connection is a transport-authenticated principal whose frames and whose
   * fan-out belong to the gateway plane, and the sessions service is one of the
   * features that delivers through it. Named separately from {@link gateway}
   * (the daemon mux) rather than renaming POD-389's field across the tree;
   * POD-391 owns whether the two become one object.
   */
  readonly clientGateway: ClientMux
  /** The issue tracker, aliased for ergonomics (≡ modules.issues). */
  readonly issues: IssueService
  /** In-process issue command surface (≡ modules.issueCommands) — the registry
   *  dispatcher serving the daemon relay + MCP with router-equal authz. */
  readonly issueCommands: IssueCommandDispatcher

  /** Steward trigger queue over the event log; polls only while settings-enabled. */
  private readonly steward: StewardService
  /** Event-log retention timers (issue #61) — modules/events. */
  private readonly eventRetention: EventLogRetention
  /** Durable change-log owner, retained so shutdown cancels maintenance slices. */
  private readonly ledger: Ledger
  /** Message delivery slow sweep (#237) [spec:SP-34d7]. */
  private readonly messageSweep: ReturnType<typeof setInterval>
  /** Read-gated auto-archive timers (issue #127) — modules/issues. */
  private readonly issueAutoArchive: IssueAutoArchive
  /** Parent-branch movement watch (POD-384) — modules/issues. */
  private readonly issueGitWatch: IssueGitWatch
  /** Cron tick for scheduled automations (#470) [spec:SP-17db] — modules/automations. */
  private readonly automationScheduler: AutomationScheduler
  private readonly store: SessionStore
  private readonly now: () => number

  constructor(
    store: SessionStore | undefined,
    notificationPushers: NotificationPushers | undefined,
    options: SessionRegistryOptions,
  ) {
    // Validated BEFORE anything is constructed: an invalid reaction principal — a
    // system reaction widening its writeScope — must refuse the assembly outright
    // rather than surface after services and timers exist (POD-1470).
    const reactions = composeReactions(options.reactions ?? REACTIONS)
    this.store = store ?? new SessionStore(':memory:')
    notificationPushers ??= DEFAULT_NOTIFICATION_PUSHERS
    const { instanceId } = options
    this.now = options.now ?? Date.now
    // Resolve feature state once, then keep it atomic with settings changes. This also
    // avoids reading persistence during instruction preparation after async recovery.
    let currentSettings = this.store.settings.getSettings()
    this.bus.on('settings.changed', ({ next }) => {
      currentSettings = next
    })
    const featureEnabled = (id: Parameters<typeof isFeatureEnabled>[0]) =>
      isFeatureEnabled(id, currentSettings)
    // Delegation is resolved from durable session ownership on every apply. This
    // lookup is available before feature construction and never snapshots rights.
    const principalForCapability = (capability: import('@podium/model').Capability) =>
      resolvePrincipal(capability, {
        parentSessionOf: (candidate) =>
          spawnedByParentSessionId(
            this.store.sessions.getSession(asSessionId(candidate))?.spawnedBy,
          ),
        onBehalfOfFor: (candidate) =>
          this.store.sessions.getSession(asSessionId(candidate))?.ownerUserId,
      })
    const workflowCallerForCapability = (
      capability: import('@podium/model').Capability,
      overrideScope?: boolean,
    ): import('./modules/workflows/service').WorkflowCaller => {
      const principal = principalForCapability(capability)
      const human = onBehalfOfUser(principal)
      const role = human === null ? undefined : this.store.users.roleOf(human)
      return {
        actor: capability.actorSessionId
          ? { kind: 'session', id: capability.actorSessionId }
          : { kind: 'operator', id: null },
        capability,
        principal,
        onBehalfOf: human,
        ...(role === 'admin' ? { protectedWrite: true } : {}),
        ...(overrideScope ? { overrideScope: true } : {}),
      }
    }
    /**
     * FRAMEWORK IDEMPOTENCY, ONE INSTANCE (POD-382). Every command envelope that
     * honours a `mutationId` — the session session-state class, the session command
     * plane and the issue registry — dedupes through THIS object. It replaces
     * `SessionLifecycle.withMutation`, whose per-proc wrapper form was a per-proc
     * chance to forget (POD-379's idempotency oracle exists because of it) and
     * which made the issue family reach the session service for a property that
     * belongs to neither.
     *
     * Built here, at the composition root, ahead of every consumer: an envelope
     * that constructed its own would be a second dedup cache, and two caches over
     * one durable table is how a replay applies twice.
     */
    const mutations = new MutationLedger(this.store.sync, this.now)
    const sessionInstructions = new SessionInstructionRegistry()
    const liveSessions = new Map<SessionId, Session>()
    // THE CLIENT CONNECTION SET, built before the sessions service that reads it:
    // the gateway owns it (POD-390), and the mux below is what mutates it.
    const clientRegistry = new ClientRegistry()

    const issueAccess = new DurableIssueAccessIndex(
      this.store.issues,
      this.store.grants,
      this.store.repos,
    )
    let updates: UpdatesService | undefined
    const machines = new MachinesService({
      instanceId,
      ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}),
      ...(options.updatePubkey ? { updatePubkey: options.updatePubkey } : {}),
      store: this.store,
      targetVersion: () => updates?.targetVersion() ?? options.targetVersion?.(),
      // ONE READER of `<stateDir>/machine.id`: the composition root passes the id to
      // the store, and every consumer takes the store's copy. A second `readOrCreate*`
      // call anywhere in the process would be a second opinion about who this host is.
      hostMachineId: this.store.hostMachineId,
      bus: this.bus,
      ...(options.pairing ? { pairing: options.pairing } : {}),
      ...(options.enrollment ? { enrollment: options.enrollment } : {}),
      // Quarantine resolution (D19.4b): an owner that no longer has an account row
      // must not keep use, and must not be rewritten to the first admin.
      userExists: (userId) => this.store.users.get(userId) !== undefined,
      clients: () => clientRegistry.values(),
      machinesForPrincipal: (principal, machineService) =>
        machinesForPrincipal(
          { machines: machineService },
          userCommandPrincipal(asUserId(principal.user), principal.role),
        ),
    })
    // THE HOST'S OWN ROW, PROVISIONED BY THE THING THAT CREATES ROWS. Every session
    // this registry mints names a machine (POD-318), and a machine id with no row is
    // a machine nobody may use — so the row has to exist before the registry can be
    // asked for anything, and making it a construction invariant is how no
    // composition gets to forget. The composition root calls `ensureHostMachine`
    // again with the real hostname and the loopback bootstrap secret; that call is
    // an idempotent UPDATE of this row, not a rival insert.
    machines.ensureHostMachine(hostname())
    const updatesService = new UpdatesService({
      machines: () =>
        machines.listMachines().map((machine) => ({
          id: machine.id,
          version: machine.appVersion ?? 'unreported',
          state: 'current',
          online: machine.online,
          busy: false,
        })),
      send: (machineId, message) => machines.toMachine(machineId, message),
      now: this.now,
      nextGrantId: () => randomUUID(),
      concurrency: 3,
    })
    updates = updatesService
    const requestBroker = new DaemonRequestBroker({
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      defaultMachine: () => machines.defaultMachine(),
    })
    const settings = new SettingsService(this.store.settings, this.store.secrets, this.bus, {
      telegramBindings: this.store.telegramBindings,
      // The append-only settings trail (POD-421). Injected here so the transport
      // never reaches into the store for it.
      audit: { repo: this.store.settingsAudit, now: () => new Date(this.now()).toISOString() },
      ...(options.telegramSetup ? { telegramSetup: options.telegramSetup } : {}),
      ...(options.generateTelegramSetupCode
        ? { generateTelegramSetupCode: options.generateTelegramSetupCode }
        : {}),
      ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
      now: this.now,
    })
    // Issue wire plumbing (modules/issues). Constructed BEFORE loadFromStore: the
    // deps are lazy closures (allWire guards the not-yet-assigned IssueService),
    // and broadcasts triggered during load must find the publisher in place.
    // The write-seam change log ([spec:SP-3fe2] #255/#256/#257): issue, session
    // AND conversation writes append their change rows ATOMICALLY with the
    // entity write (one transact span on the shared connection). One changes
    // table + one seq sequence — changesSince consumers see one unified feed.
    const feedVisibility = makeFeedVisibility({ store: this.store })
    const visibility = new GrantEdgeVisibilityPolicy(
      feedVisibility.state,
      new NoDelegationsGranted(),
    )
    const ledger = new Ledger({
      visibility,
      anchors: feedVisibility.anchors,
      listenerPrincipal: DEVICE_GRADE_PRINCIPAL,
      repo: this.store.sync,
      now: () => this.now(),
      transact: (fn) => this.store.transact(fn),
      onPruneMetrics: (metrics) => {
        perf.record('phase', 'changeLogPrune.total', metrics.totalDurationMs, DEPLOYMENT)
        perf.record('phase', 'changeLogPrune.maxSlice', metrics.maxUninterruptedSliceMs, DEPLOYMENT)
      },
    })
    this.ledger = ledger
    // THE write funnel (modules/funnel): authorize → repo write → change append →
    // broadcast. Bridges ledger appends onto the bus and runs THE ordered
    // metadataDelta pipe (#256) — sendDelta is the one seam deltas reach
    // clients through.
    // THE SERVING EDGE (POD-1203). One feed, framed per connection by the kernel's
    // publisher, translated per negotiated wire version at the boundary. Feed
    // identity is PERSISTED (`readFeedIdentity`/`writeFeedIdentity`), because ADR
    // 2 D1 makes a re-minted epoch across a restart indistinguishable from a
    // restored backup to every replica holding a cursor.
    const conversationDiagnostics: {
      current: readonly import('@podium/model').ConversationDiagnosticWire[]
    } = { current: [] }
    const subscriptions = new SubscriptionRegistry()
    // THE KERNEL'S OWN SEAM (POD-1196), not a hand-written bridge.
    //
    // This used to translate a protocol Principal into a second principal type
    // and open with `if (principal.kind !== 'user') return false` — refusing
    // EVERY agent, because the kernel's principal had nowhere to put a delegated
    // scope. One principal type and a delegation port remove both the
    // translation and the refusal.
    //
    // The entity-kind narrowing stays: it is a fact about what rooms address,
    // not a refusal of a principal.
    const roomVisibility: VisibilityResolver = {
      canSee: (principal, ref) =>
        (ref.kind === 'session' || ref.kind === 'issue') &&
        kernelVisibilityResolver(visibility).canSee(principal, ref),
    }
    const presence = new PresenceRouting({
      subscriptions,
      clients: clientRegistry,
      visibility: roomVisibility,
      now: this.now,
    })
    const feedServing = new FeedServing({
      authority: ledger.authority,
      onBootstrapReadStart: feedVisibility.beginBootstrapRead,
      onBootstrapReadEnd: (principal) => feedVisibility.finishBootstrapRead(principal),
      identity: new FeedIdentityRegistry(
        {
          readIdentity: () => this.store.sync.readFeedIdentity(),
          writeIdentity: (identity) => this.store.sync.writeFeedIdentity(identity, this.now()),
        },
        // Opaque, never a counter: D1 forbids a counter outright (restoring one
        // backup twice re-mints the same value and hands a different timeline an
        // epoch clients have already accepted) and `assertOpaqueEpoch` refuses a
        // decimal integer at this boundary.
        () => randomUUID(),
      ),
      retention: { minAvailableSeq: () => this.store.sync.minChangeSeq() },
      subscriptions,
      onVisibilityChanged: (subscriberIds) => presence.revalidateSubscribers(subscriberIds),
      diagnostics: () => [...conversationDiagnostics.current],
    })
    const funnel = new WriteFunnel({
      bus: this.bus,
      // THE SAME Authority the Ledger facade wraps, not a second one (POD-305):
      // two over one store would each keep their own dedup baseline and their
      // own ordered broadcast queue.
      authority: ledger.authority,
      serving: feedServing,
      onPublished: (seq) => this.bus.emit('feed.published', { seq }),
    })
    const snapshotTail = (): SnapshotTail => ({
      issues: ledger.authority.snapshot('issue') as SnapshotTail['issues'],
      issueProjections: ledger.authority.snapshot(
        'issueProjection',
      ) as SnapshotTail['issueProjections'],
      issueDeps: ledger.authority.snapshot('issueDep') as SnapshotTail['issueDeps'],
      repos: repoProjectionRows(this.store.repos.listRepos()).map((row) => row.value),
      conversations: ledger.authority.snapshot('conversation') as SnapshotTail['conversations'],
      automations: ledger.authority.snapshot('automation') as SnapshotTail['automations'],
      automationRuns: ledger.authority.snapshot('automationRun') as SnapshotTail['automationRuns'],
      diagnostics: [...conversationDiagnostics.current],
    })
    // Spec factory only (POD-1576). The `publishIssueList` reconcile tail that
    // used to be wired here — issue + issueProjection + issueDep full-truth
    // reconciles for write-less republishes — had no trigger left once POD-1574
    // deleted the never-bumped dirty gate that called it. Issue WRITES still
    // reconcile those same kinds; they do it from IssueService's own tail.
    const publisher = new IssuePublisher({})
    const specs = new SpecsService({
      repoRoots: () => this.store.repos.listRepoPaths(),
    })
    // Advisory named lease locks [spec:SP-85d1]. Worktree invalidation is an
    // event callback into the already-constructed gateway registry, not a
    // deferred service dependency.
    // POD-665: fan out the invalidation raw (imitating MachinesService.
    // broadcastMachines) — no repo payload, just "go re-fetch" (see
    // WorktreesChangedMessage doc comment for why NOT scanReposAll's result).
    // Shared by every path that creates or destroys a worktree behind the
    // clients' backs: issue start, and handoff import (POD-821).
    const broadcastWorktreesChanged = (repoPath: string, machineId?: string): void => {
      const msg: LiveServerMessage = {
        type: 'worktreesChanged',
        repoPath,
        ...(machineId ? { machineId } : {}),
      }
      for (const c of clientRegistry.values()) c.send(msg)
    }
    const memory = new MemoryService(
      {
        store: this.store,
        now: () => this.now(),
        // Conversation writes commit through the write-seam ledger (#257):
        // discovery/meta commits + list reconciles append durably at
        // the write; the feed serves them (POD-1203 deleted the snapshot tail).
        ledger,
        // Scan diagnostics are not feed content and the v1 wire carried them
        // inside `conversationsChanged`; the edge re-serves them to the wire
        // versions that still need them (POD-1203).
        onDiagnosticsChanged: (diagnostics) => {
          conversationDiagnostics.current = diagnostics
          feedServing.publishAdvisory('conversation-diagnostics')
        },
        // ONE correlator, handed over as itself (POD-318). It was constructed
        // above precisely so every consumer can take it directly instead of
        // wrapping a not-yet-built service in a closure.
        daemonRequest: requestBroker,
      },
      options.mirrorLakeDir ? { mirrorLakeDir: options.mirrorLakeDir } : {},
    )
    const rpc = new DaemonRpcService({
      broker: requestBroker,
      memory,
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      defaultMachine: () => machines.defaultMachine(),
      resolveMachine: (requested, cwd) => machines.resolveMachine(requested, cwd),
      hasDaemon: (machineId) => machines.hasDaemon(machineId),
      machineName: (id) => machines.machineName(id),
      onlineMachineIds: () => machines.onlineMachineIds(),
      getSession: (sessionId) => {
        const session = liveSessions.get(sessionId)
        return session
          ? {
              id: session.sessionId,
              cwd: session.cwd,
              machineId: session.machineId,
              agentKind: session.agentKind,
              resume: session.resume,
              transcriptItems: () => session.terminal.transcriptItems(),
            }
          : undefined
      },
    })
    const serverTransfer = new ServerTransferService({
      stateRoot: stateDir(),
      sourceMachineId: this.store.hostMachineId,
      rpc,
      online: (machineId) => machines.hasDaemon(machineId),
      checkpoint: () => this.store.checkpointForTransfer(),
      fence: () => this.store.beginTransferFence(),
      releaseFence: () => this.store.endTransferFence(),
      restartAsDaemon,
    })
    const loginPropagation = new LoginPropagationService({
      store: this.store,
      machines,
      rpc,
      now: () => this.now(),
    })
    const capabilityForLiveSession = (sessionId: SessionId) => {
      const session = liveSessions.get(sessionId)
      if (!session) return { role: 'worker', scope: { kind: 'none' } } as const
      const issueId = session.issueId ?? issueAccess.issueForCwd(session.cwd)
      return issueId
        ? {
            role: 'worker' as const,
            scope: { kind: 'subtree' as const, rootId: issueId },
            actorSessionId: sessionId,
            onBehalfOf: session.ownerUserId,
          }
        : {
            role: 'worker' as const,
            scope: { kind: 'none' as const },
            actorSessionId: sessionId,
            onBehalfOf: session.ownerUserId,
          }
    }
    const liveSessionOwnership = (sessionId: SessionId) => {
      const session = liveSessions.get(sessionId)
      if (!session) return undefined
      return {
        owner: session.ownerUserId,
        grants: this.store.grants
          .listForResource('session', sessionId)
          .filter((edge) => edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
          .map((edge) => edge.grantee),
      }
    }
    const mail = principalMailPolicy({
      principalForCapability,
      principalForMessage: (message) => {
        if (message.fromKind === 'system') return systemPrincipal(message.fromName ?? 'message')
        if (message.fromSession) {
          try {
            return principalForCapability(capabilityForLiveSession(message.fromSession))
          } catch {
            return undefined
          }
        }
        if (!message.attribution?.onBehalfOf) return undefined
        const userId = asUserId(message.attribution?.onBehalfOf)
        const role = this.store.users.roleOf(userId)
        return role ? userCommandPrincipal(userId, role) : undefined
      },
      policyFor: (principal) => {
        const userId = onBehalfOfUser(principal)
        return {
          ceiling: {
            canSee: (ref) => {
              if (principal.kind === 'system') return true
              if (userId === null) return false
              if (ref.kind === 'issue') return feedVisibility.mayReadIssue(userId, ref.id)
              if (ref.kind === 'session') {
                const owner = liveSessionOwnership(asSessionId(ref.id))
                return owner?.owner === userId || owner?.grants.includes(userId) === true
              }
              return false
            },
          },
          machines: {
            mayUse: (machineId) =>
              principal.kind === 'system' ||
              checkMachineUse(principal, machineId, ownershipFromMachines(machines)) === undefined,
            isReachable: (machineId) => machines.hasDaemon(machineId),
          },
        }
      },
    })
    // The sessions module (core lifecycle + data planes). Its issue-shaped deps
    // are lazy closures — issues/conversations are assigned below, and are only
    // ever invoked after construction completes.
    const queuedMessageApply = new QueuedMessageApply({
      messages: this.store.messages,
      events: this.store.events,
      authorize: mail.authorizeAtApply,
      bus: this.bus,
      now: () => new Date(this.now()).toISOString(),
    })
    const sessionsSvc = new SessionLifecycle({
      durableLabelFor: (sessionId) => durableSessionLabel(sessionId, instanceId),
      store: this.store,
      now: () => this.now(),
      bus: this.bus,
      authorizeQueuedMessage: (messageId) => queuedMessageApply.authorize(messageId),
      rejectQueuedMessage: (messageId, reason) => queuedMessageApply.reject(messageId, reason),
      sessions: liveSessions,
      funnel,
      clients: clientRegistry,
      subscriptions,
      // Session writes commit through the write-seam ledger at persist() (#256).
      ledger,
      ...(options.publicationWorker ? { publicationWorker: options.publicationWorker } : {}),
      ...(options.publicationShadowCompare !== undefined
        ? { publicationShadowCompare: options.publicationShadowCompare }
        : {}),
      machines,
      rpc,
      onSpawnTargetLogin: ({ machineId, agentKind, ownerUserId }) =>
        loginPropagation.trigger({
          targetMachineId: machineId,
          agentKind,
          principalUserId: ownerUserId,
        }),
      memory,
      issueAccess,
      snapshotTail,
      onWorktreesChanged: broadcastWorktreesChanged,
      instructionsForStart: (input) => sessionInstructions.prepare(input),
      // POD-1081: clientCount is a degenerate view of session-room occupancy.
      // Attach still owns frame delivery; presence rooms own who-is-watching.
      // PTY attach auto-joins the room so the two stay one mechanism.
      sessionOccupancyCount: (sessionId) =>
        presence.occupancy({ kind: 'session', id: sessionId }).length,
      sessionRoomJoin: (client, sessionId) =>
        presence.ensureJoined(client, { kind: 'session', id: sessionId }),
      sessionRoomLeave: (client, sessionId) =>
        presence.ensureLeft(client, { kind: 'session', id: sessionId }),
    })
    const nativeLogin = new NativeLoginService({
      machines,
      sessions: sessionsSvc,
      bus: this.bus,
      authorize: (ownerUserId, machineId) => {
        const user = this.store.users.get(ownerUserId)
        if (user?.role !== 'admin') return 'native provider login requires an admin account'
        const principal = userCommandPrincipal(ownerUserId, user.role)
        const access = checkMachineUse(principal, machineId, ownershipFromMachines(machines))
        return access === 'absent'
          ? `unknown machine '${machineId}'`
          : access === 'unauthorized'
            ? 'you do not have access to start login on this machine'
            : undefined
      },
      cwdForMachine: (machineId) => this.store.repos.listRepoPaths(machineId)[0] ?? '/',
    })
    this.bus.on('superagent.turnEnded', (event) => {
      if (event.ok || event.harnessErrorKind !== 'provider-auth' || !event.harness) return
      const session = sessionsSvc.sessionById(asSessionId(event.podiumSessionId))
      if (!session?.machineId) return
      nativeLogin.markRequired(session.machineId, event.harness)
      loginPropagation.trigger({
        targetMachineId: session.machineId,
        agentKind: event.harness,
        force: true,
        ...(event.ownerUserId ? { principalUserId: event.ownerUserId } : {}),
      })
    })
    const hosts = new HostsService(
      {
        getSettings: () => this.store.settings.getSettings(),
        clients: () => clientRegistry.values(),
        machineName: (id) => machines.machineName(id),
        sessions: () =>
          [...liveSessions.values()].map((session) => ({
            sessionId: session.sessionId,
            machineId: session.machineId,
            status: session.status,
            resume: session.resume,
            agentState: session.agentState,
            lastActiveAt: session.lastActiveAt,
            lastResumedAtMs: session.terminal.lastResumedAtMs,
            lastInputAtMs: session.terminal.lastInputAtMs,
            lastOutputAtMs: session.terminal.lastOutputAtMs,
          })),
        hibernateSession: (input) => sessionsSvc.hibernateSession(input),
        hasValidTerminalProof: (sessionId) => sessionsSvc.hasValidTerminalProof(sessionId),
        terminalProofMissing: (sessionId) => sessionsSvc.terminalProofMissing(sessionId),
        daemonRequest: requestBroker,
      },
      this.bus,
    )
    const headless = sessionsSvc.headless
    this.bus.on('feed.published', ({ seq }) => {
      sessionsSvc.onFeedPublished(seq)
    })
    this.bus.on('session.openUrl', (request) => sessionsSvc.onOpenUrl(request))
    this.bus.on('machine.metadataChanged', ({ machineId }) => {
      sessionsSvc.sessionsChangedForMachine(machineId)
    })
    // Session-bound lock auto-release [spec:SP-85d1]: a finished/exited session
    const notify = new NotifyService(
      {
        // RESOLVED FOR ONE PERSON (POD-1213). These reads include personal
        // preferences, which no longer live on the instance blob — an unresolved
        // read would see the model's defaults instead of the operator's choices.
        // `FIRST_ADMIN_USER_ID` is spelled out rather than defaulted, the shape
        // `IssueService.broadcastViewer` uses: this build's transport cannot name
        // a person (one shared password), so the sole account is the only true
        // answer, and POD-315/POD-1077 replace the argument rather than finding a
        // hidden read.
        getSettings: (ownerUserId = FIRST_ADMIN_USER_ID) =>
          this.store.settings.getSettingsFor(ownerUserId),
        // POD-419: out of the server-only keyed store, read at the moment of use.
        telegramBotToken: () => this.store.secrets.getOrEmpty('notifications.telegramBotToken'),
        telegramRouteAvailable: (ownerUserId) =>
          this.store.telegramBindings.listForUser(ownerUserId).length === 1,
        requestTelegram: (request) => this.bus.emit('notification.telegramRequested', request),
        appendEvent: (e) => this.store.events.appendEvent(e),
        now: () => this.now(),
        clients: (ownerUserId) =>
          [...clientRegistry.values()].filter(
            (client) => ownerUserId === undefined || client.principal.user === ownerUserId,
          ),
        sessionInfo: (sessionId) => {
          const s = sessionsSvc.sessions.get(sessionId)
          return s ? noticeInfo(s) : undefined
        },
        sessionStates: () =>
          [...sessionsSvc.sessions.values()].map((s) => ({
            info: noticeInfo(s),
            state: s.agentState,
            ownerUserId: FIRST_ADMIN_USER_ID,
          })),
        notificationsEnabled: () => featureEnabled('notifications'),
      },
      notificationPushers,
      this.bus,
    )
    // releases its held locks and leaves every wait queue (the queue advances
    // with a grant-notification mail). Best-effort — the lazy expiry sweep is
    // the backstop if this listener ever misses a death.
    this.bus.on('session.exited', ({ sessionId }) => locks.releaseForSession(sessionId))
    // Boot: hydrate sessions (and reconcile the restored state against the
    // write-seam ledger — boot reconciliation lives in the sessions module now).
    sessionsSvc.loadFromStore()
    // Constructed AFTER loadFromStore (same slot the inline mirror construction held).
    // Permanent artifact snapshots ([spec:SP-0fc9] #441): the server pulls bytes
    // from the owning daemon at artifact-add time into <state-dir>/artifacts and
    // serves them locally via /files/artifact (registered in server.ts).
    const issueArtifacts = new IssueArtifactStore(join(stateDir(), 'artifacts'), {
      readAsset: (i) => rpc.readAsset(i),
      listDir: (i) => rpc.listDir(i),
    })
    const issues = new IssueService({
      store: this.store,
      artifacts: issueArtifacts,
      listSessions: () => sessionsSvc.listSessions(),
      // The by-id read [POD-1646]: one session, not the full pass.
      sessionById: (sessionId) => sessionsSvc.sessionById(sessionId),
      // The narrow read [POD-1639]: an issue mutation asks for ITS sessions, not
      // for all of them. Same set, same fields — see SessionView.listForIssue.
      listSessionsForIssue: (worktreePath, issueId) =>
        sessionsSvc.listSessionsForIssue(worktreePath, issueId),
      // Resolved for the sole account (POD-1213): the issue service reads
      // `roles.coding` — a personal preference — beside instance-tier git
      // workflow policy. See the note on `NotifyService` above.
      getSettings: () => this.store.settings.getSettingsFor(FIRST_ADMIN_USER_ID),
      spawnSession: (o) =>
        sessionsSvc.createSession({
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.issueId ? { issueId: o.issueId } : {}),
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.effort !== undefined ? { effort: o.effort } : {}),
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
          ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
          ...(o.machineId ? { machineId: o.machineId } : {}),
          ...(o.ownerUserId ? { ownerUserId: o.ownerUserId } : {}),
        }),
      repoOp: (op, cwd, args, machineId) => rpc.repoOp(op, cwd, args, machineId),
      requireMachineForRepo: (machineId, repoPath) =>
        machines.requireMachineForRepo(machineId, repoPath),
      // Machine-pinned start (POD-1386/POD-1405/POD-1424): resolve the repository on the
      // target by IDENTITY — the repoId-keyed resolver handoff already uses, so a pin
      // finds the repo instead of demanding the source's path — then materialise the
      // start point there, because our integration branches are on no shared remote and
      // a fetch cannot help the target reach them.
      prepareMachineStart: async ({ repoPath, machineId, startPoint }) => {
        const targetRepoPath = await sessionsSvc.workspace.resolveRepoOnMachine(repoPath, machineId)
        if (!startPoint) return { repoPath: targetRepoPath }
        // The start point that comes BACK may be a commit id rather than the branch name
        // that went in: a bundled branch arrives as objects, not as a ref, so the name
        // does not resolve on the target even though the commit does.
        const ensured = await sessionsSvc.workspace.ensureRefOnMachine({
          sourceRepoPath: repoPath,
          targetMachineId: machineId,
          targetRepoPath,
          ref: startPoint,
        })
        return { repoPath: targetRepoPath, startPoint: ensured.startPoint }
      },
      // The lookup-only half (POD-1571): add-session and worktree recreate need the
      // repository the target ALREADY has, and must keep the refusal when it has none.
      findRepoOnMachine: (repoPath, machineId) =>
        sessionsSvc.workspace.findRepoOnMachine(repoPath, machineId),
      getSessionIssueId: (sessionId) => sessionsSvc.getSessionIssueId(sessionId),
      setSessionIssueId: (sessionId, issueId) => sessionsSvc.setSessionIssueId(sessionId, issueId),
      setSessionArchived: (sessionId, archived) => sessionsSvc.setArchived({ sessionId, archived }),
      // Closing an issue retires standing session offers (POD-290) so finished
      // work cannot keep demanding a decision after the close flip.
      clearSessionOffer: (sessionId) => sessionsSvc.clearOffer(sessionId),
      onWorktreesChanged: broadcastWorktreesChanged,
      // Every issue mutation commits through the write-seam ledger (#255) —
      // change rows land in the same transaction as the row write — and fans
      // by the publisher (which unions in hub-mirrored issues), so durable-
      // before-fan-out holds by construction — there is NO raw-WS path out of
      // the issue tracker anymore, and since POD-1203 no snapshot path either:
      // the appended rows ARE what a client is served.
      funnel,
      ledger,
      publishSpecs: publisher,
      // Agent mail send-time nudge (issue #103): the sessions module subscribes
      // and picks the live member session to poke — see modules/sessions.
      onMailSent: (row) =>
        this.bus.emit('issue.mailSent', {
          seq: row.seq,
          ...(row.worktreePath ? { worktreePath: row.worktreePath } : {}),
        }),
    })
    this.bus.on('issue.sessionDerived', (event) => {
      switch (event.kind) {
        case 'gitActivity':
          issues.recordSessionGitActivity(event.sessionId, {
            ...(event.commits ? { commits: event.commits } : {}),
            ...(event.touched ? { touched: event.touched } : {}),
          })
          break
        case 'activity':
          issues.onSessionActivity(event.sessionId)
          break
        case 'attention':
          issues.onSessionAttention(event.sessionId)
          break
        case 'turnEnd':
          issues.onSessionTurnEnd(event.sessionId)
          break
        case 'removedOrArchived':
          issues.onSessionRemovedOrArchived(event.sessionId)
          break
        case 'reapDraft':
          issues.reapIfEmptyDraft(event.issueId)
          break
        case 'adoptWorktree': {
          const issue = issueAccess.getMeta(event.issueId)
          const message = event.message
          if (
            !issue ||
            issue.archived ||
            issue.worktreePath !== null ||
            message.kind !== 'worktree'
          )
            break
          if (message.repoRoot !== undefined && message.repoRoot !== issue.repoPath) break
          if (issueAccess.worktreePaths().includes(message.cwd)) break
          issues.update(issue.id, {
            worktreePath: message.cwd,
            ...(message.branch ? { branch: message.branch } : {}),
          })
          break
        }
      }
    })
    const issueSessionLifecycle = new IssueSessionLifecycle({
      issues,
      sessions: sessionsSvc,
      ledger,
    })
    this.bus.on('session.wakeRequested', ({ sessionId, principal }) => {
      const authorized = sessionsSvc.authorizeQueuedInputAtApply({
        sessionId,
        principal,
        sourceMessageId: null,
      })
      // REFUSING THE WAKE IS CORRECT — revocation is supposed to stop a parked
      // session being woken by input it may no longer accept, and the queued row
      // stays pending for an explicit later resume. Doing it SILENTLY was not:
      // the sender is told its message was queued, the session never comes back,
      // and nothing anywhere records why. A refused wake looked identical to a
      // broken one for as long as it took to read this line (POD-1650).
      if (!authorized.ok) {
        console.warn(
          `[podium] wake refused for ${sessionId}: ${authorized.reason ?? 'not authorized'} — input stays queued for an explicit resume`,
        )
        return
      }
      void issueSessionLifecycle
        .resurrectSession({ sessionId })
        .then((result) => {
          if (!result.ok)
            console.warn('[podium] wake-on-queue failed for ' + sessionId + ': ' + result.reason)
        })
        .catch((err) => {
          console.warn('[podium] wake-on-queue failed for ' + sessionId + ':', err)
        })
    })
    // The `session.listChanged` republish tail is GONE (POD-1574). It re-derived
    // every issue's payload whenever the session list moved, gated by a dirty
    // check that no writer ever advanced. Neither `IssueWire` (POD-797 removed
    // `sessions`/`sessionSummary`/`unread`) nor `IssueProjection` (never had one)
    // carries a session-derived field, so the tail had nothing to reconcile — and
    // the one time the gate did open, boot reconciliation had already published
    // the same rows (modules/issues/service/index.ts).
    const locks = new LockService({
      locks: this.store.locks,
      transact: (fn) => this.store.transact(fn),
      funnel,
      now: () => this.now(),
      resolveRepoId: (repoPath) => this.store.repos.resolveRepoIdForPath(repoPath),
      sessionAlive: (sessionId) => {
        // `sessionId` is a LockSessionKey: it may be one of the two lock sentinels,
        // which are NOT session ids. The lookup is expected to MISS for those —
        // that miss is how the unknown-relay sentinel gets pruned from a queue
        // (see LockSessionKey's note). So the map is probed as a plain key.
        const s = (liveSessions as ReadonlyMap<string, { status: string }>).get(sessionId)
        return !!s && s.status !== 'exited'
      },
      // Grant/steal notifications ride agent mail; best-effort by contract
      // (the waiter also discovers the grant via polling).
      sendMail: (issueId, from, body) => {
        try {
          issues.sendMail(issueId, from, body)
        } catch {}
      },
      appendEvent: (e) => this.store.events.appendEvent(e),
    })
    const lockCommands = new LockCommandDispatcher({
      locks,
      issues,
    })
    // Unified messaging (#237) [spec:SP-34d7]: the one send path. Sender is
    // stamped by each surface from its authenticated caller; issue-addressed
    // sends dual-write the legacy issue_messages mirror so inbox/claim/pending
    // keep working until those readers migrate.
    // Principal-resolved at accept and apply time; queued rows retain attribution.
    // producer: the delivery service gets its apply-time port and the gate gets
    // its resolution-time ceiling, and MessageGate refuses at boot if they are
    // not the same object. Today's ceiling is the single-user maximum, so this
    // wiring changes no behaviour — what it changes is that the queued-send
    // rejection path (ADR 3 D8 / Amendment 1 D16) is now LIVE end to end rather
    // than only unit-tested against the handler, so POD-1075's real ceiling
    // arrives at a composition root that already carries it.
    const messagesSvc = new MessageDeliveryService({
      authorizeAtApply: mail.authorizeAtApply,
      // POD-1193: wake resumes/spawns on the target session's machine — enforce
      // `use` at delivery. Same principalMailPolicy object as the ceiling port.
      placementAtWake: mail.placementAtWake,
      messages: this.store.messages,
      notificationFacts: this.store.notificationFacts,
      events: this.store.events,
      issues,
      sessions: sessionsSvc,
      mirrorIssueMail: (row) => funnel.run({ write: () => this.store.issues.addIssueMessage(row) }),
      mirrorMarkIssueMailRead: (issueId, ids) =>
        funnel.run({
          write: () =>
            this.store.issues.markIssueMessagesRead(
              FIRST_ADMIN_USER_ID,
              issueId,
              ids,
              new Date().toISOString(),
            ),
        }),
      transact: (fn) => this.store.transact(fn),
      // Spawn-on-wake (#237) [spec:SP-34d7 decision 4]: an unresumable wake
      // spawns a fresh agent on the target issue through the SAME machinery
      // issue_start rides (createSession); the service then queues the message
      // as the child's first prompt. Authz (gate.send write check) → spawn
      // budget → cooldown all bite before this seam is reached.
      spawnOnWake: makeSpawnOnWake({
        issues,
        createSession: (o) => sessionsSvc.createSession(o),
      }),
      // Cross-machine provenance [POD-658]: name the sender's machine in the
      // envelope note so the receiver knows to `podium workspace fetch`.
      machineName: (id) => machines.listMachines().find((m) => m.id === id)?.name ?? id,
      now: () => new Date(this.now()).toISOString(),
    })
    this.bus.on('message.deadLettered', ({ messageId, reason }) =>
      messagesSvc.notifyQueuedInputRejected(messageId, reason),
    )
    // Event-complete delivery eligibility [spec:SP-c29e]: every durable session
    // or issue metadata transition lands here after commit. Session upserts cover
    // bind/live, resume-ref, attachment/CWD and draft changes; issue upserts cover
    // worktree/archive/target-resolution changes. The service coalesces by target.
    this.bus.on('oplog.appended', ({ changes }) => {
      // ISSUE CHANGES GO IN ONE BATCH (POD-1597). Per change, the recompute walks
      // every session and resolves each against every issue; the boot catch-up
      // arrives here as ONE batch of every issue there is, so per-change cost
      // squared the world and cost 573s of a 668s boot on the live database.
      // The issue half of a mixed batch is therefore recomputed AFTER the session
      // half rather than interleaved with it; both only queue targets into the
      // scheduler's coalescing map, which is flushed once, after this handler.
      const changedIssueIds: string[] = []
      for (const change of changes) {
        if (change.entity === 'session') {
          messagesSvc.onSessionEligibilityChanged(
            // `EntityChangeSpec.id` is polymorphic by `entity` (an issue id for
            // 'issue', a session id here), so the brand is recovered inside the
            // discriminated branch — the same rule as MessageRow's `toId`.
            asSessionId(change.id),
            change.op === 'upsert' ? (change.value as SessionMeta) : undefined,
          )
        } else if (change.entity === 'issue') {
          changedIssueIds.push(change.id)
        }
      }
      messagesSvc.onIssuesEligibilityChanged(changedIssueIds)
    })
    const workflows = new WorkflowService(
      {
        store: this.store.workflows,
        now: () => new Date(this.now()).toISOString(),
        session: (sessionId) => {
          const s = liveSessions.get(sessionId)
          return s
            ? {
                sessionId: s.sessionId,
                cwd: s.cwd,
                ...(s.issueId ? { issueId: s.issueId } : {}),
                agentKind: s.agentKind,
                machineId: s.machineId,
              }
            : undefined
        },
        issue: (issueId) => {
          const issue = issues?.getMeta(issueId)
          // Only `worktreePath` is read (workflows' step-placement check); the id /
          // repoId / repoPath this used to also carry had no reader (POD-367).
          return issue ? { worktreePath: issue.worktreePath } : undefined
        },
        repoIdForPath: (path) => this.store.repos.resolveRepoIdForPath(path),
        notifyCoordinator: (sessionId, text) => {
          messagesSvc.send(
            { kind: 'system', name: 'workflow' },
            {
              to: { kind: 'session', id: sessionId },
              body: text,
              kind: 'notification',
              // #471: fyi is the only urgency that currently waits for a turn boundary.
              urgency: 'fyi',
              lifecycle: 'wait',
            },
          )
        },
      },
      {
        /**
         * THE RUN-SCOPED IDEMPOTENCY LEDGER (POD-731), backed by the product's
         * existing `applied_mutations` table rather than by a second mechanism —
         * the same store the outbox write path already treats as "a replay of an
         * already-applied mutation returns its recorded result instead of
         * re-running". The workflow key namespaces it by command and run, so a
         * mutation id replayed against another run is a different delivery.
         */
        ownership: {
          ownerOf: (entity) => this.store.workflows.ownerOf(entity.kind, entity.id),
          hasGrant: (user, entity, verb) =>
            this.store.grants
              .listForResource(entity.kind, entity.id)
              .some((grant) => grant.grantee === user && grant.verb === verb),
        },
        machinesFor: (workflowPrincipal) => {
          let principal: CommandPrincipal | undefined
          if (workflowPrincipal.onBehalfOf === null) {
            return {
              mayUse: () => false,
              isReachable: (machineId: string) => machines.hasDaemon(machineId),
            }
          }
          if (workflowPrincipal.actor.startsWith('session:')) {
            const sessionId = asSessionId(workflowPrincipal.actor.slice('session:'.length))
            try {
              principal = principalForCapability(sessionsSvc.capabilityForSession(sessionId))
            } catch {
              principal = undefined
            }
          } else {
            const userId = asUserId(workflowPrincipal.onBehalfOf)
            const role = this.store.users.roleOf(userId)
            principal = role ? userCommandPrincipal(userId, role) : undefined
          }
          return {
            mayUse: (machineId: string) =>
              principal !== undefined &&
              checkMachineUse(principal, machineId, ownershipFromMachines(machines)) === undefined,
            isReachable: (machineId: string) => machines.hasDaemon(machineId),
          }
        },
        ledger: {
          recall: (key) => this.store.sync.getAppliedMutation(key),
          record: (key, result) =>
            this.store.sync.recordAppliedMutation(key, 'workflows', result, this.now()),
        },
      },
    )
    sessionInstructions.register({
      source: 'podium:issues',
      prepare: () => ({ content: ISSUE_SYSTEM_POINTER }),
    })
    sessionInstructions.register({
      source: 'podium:specs',
      prepare: () => (featureEnabled('specs') ? { content: SPEC_SYSTEM_POINTER } : null),
    })
    sessionInstructions.register({
      source: 'podium:workflow',
      prepare: ({ sessionId, cwd, issueId, workflowRevisionId, existingOnly }) => {
        if (!featureEnabled('workflows')) return null
        const prepared = existingOnly
          ? workflows.prepareExistingSession({
              sessionId,
              ...(issueId ? { issueId } : {}),
            })
          : workflows.prepareStart({
              sessionId,
              cwd,
              ...(issueId ? { issueId } : {}),
              ...(workflowRevisionId ? { explicitRevisionId: workflowRevisionId } : {}),
            })
        if (!prepared) return null
        return {
          content: prepared.prompt,
          ...(!existingOnly
            ? {
                afterSpawn: () => {
                  workflows.startRun({
                    sessionId,
                    onBehalfOf: sessionsSvc.sessionOwner(sessionId)?.owner ?? null,
                    cwd,
                    ...(issueId ? { issueId } : {}),
                    revisionId: prepared.revision.id,
                  })
                },
              }
            : {}),
        }
      },
    })
    const messageGate = new MessageGate(
      {
        messages: messagesSvc,
        issues,
        listSessions: () => sessionsSvc.listSessions(),
        sessionById: (sessionId) => sessionsSvc.sessionById(sessionId),
        // Cross-harness subagent spawn (#237) [spec:SP-34d7 cross-harness]: the
        // child is a FULL Podium session through the one spawn path; --new is the
        // deliberate issue-create path (never automatic).
        spawnSession: (o) =>
          sessionsSvc.createSession({
            ownerUserId: o.ownerUserId,
            cwd: o.cwd,
            agentKind: o.agentKind as AgentKind,
            ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
            ...(o.model !== undefined ? { model: o.model } : {}),
            ...(o.effort !== undefined ? { effort: o.effort } : {}),
            ...(o.issueId ? { issueId: o.issueId } : {}),
            ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
            ...(o.machineId ? { machineId: o.machineId } : {}),
            // Spawner-prescribed curated name [spec:SP-4ef9][spec:SP-eb60].
            ...(o.name ? { name: o.name } : {}),
            ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
            ...(o.workflowStepId ? { workflowStepId: o.workflowStepId } : {}),
            ...(o.executionProfileId ? { executionProfileId: o.executionProfileId } : {}),
          }),
        resolveExecutionProfile: (input) => {
          const { caller, ...profileInput } = input
          return workflows.executionProfileForLaunch({
            ...profileInput,
            ...(caller
              ? { caller: workflowCallerForCapability(caller.capability, caller.overrideScope) }
              : {}),
          })
        },
        createIssue: (o) => issues.create({ ...o, startNow: false }),
        appendEvent: (e) => this.store.events.appendEvent(e),
        now: () => new Date(this.now()).toISOString(),
        // Parent-await consume-on-ack (POD-917/POD-923): clear the session-parent
        // wake sticky when the parent observes the child settled, so a later
        // genuine re-completion can re-fire once. Matches NotificationArbiter.retire.
        retireNotificationFact: (factKey, target) => {
          this.store.notificationFacts.retire(factKey, target, new Date(this.now()).toISOString())
        },
      },
      mail.gateOptions,
    )
    const readToolkit = new SessionReadToolkit({
      listSessions: () => sessionsSvc.listSessions(),
      issues,
      messages: messagesSvc,
      events: this.store.events,
      // Tier-3 recap watermarks persist per (reader, target) [spec:SP-34d7].
      watermarks: this.store.readWatermarks,
      repoOp: async (op, cwd, machineId) => rpc.repoOp(op, cwd, undefined, machineId),
      readTranscript: (input) =>
        rpc.readTranscript(input, { kind: 'system', id: 'session-read-toolkit' }),
      now: () => new Date(this.now()).toISOString(),
    })

    const issueAttach = new IssueAttachOrchestrator({
      transact: (work) => this.store.transact(work),
      attention: issues.attention,
    })

    // Scheduled automations (#470) [spec:SP-17db]. The spawn goes straight to
    // SessionLifecycle.createSession with its own provenance tag (the tRPC
    // `sessions.create` proc stamps spawnedBy 'user'), and the prompt rides the
    // durable outbox — see AutomationsService.spawn for why not initialPrompt.
    // A session still occupying the machine (anything but exited/hibernated)
    // makes the next occurrence a skipped_overlap rather than a pile-up.
    const automations = new AutomationsService({
      store: this.store.automations,
      ledger,
      createSession: (o) => sessionsSvc.createSession(o),
      queueText: (o) => sessionsSvc.queueText(o),
      resumeAndSend: (o) => sessionsSvc.resumeAndSend(o),
      createIssue: (o) => {
        const issue = issues.create({
          ...o,
          startNow: false,
          origin: 'agent',
          audience: 'human',
        })
        issues.update(issue.id, { stage: 'in_progress' })
        return { id: issue.id }
      },
      liveSessionIds: () =>
        new Set(
          sessionsSvc
            .listSessions()
            .filter((s) => s.status !== 'exited' && s.status !== 'hibernated')
            .map((s) => s.sessionId),
        ),
      principalForOwner: (ownerUserId) => {
        const role = this.store.users.roleOf(ownerUserId)
        return role ? userCommandPrincipal(ownerUserId, role) : undefined
      },
      mayUseDefaultMachine: (principal) =>
        checkMachineUse(principal, machines.defaultMachine(), ownershipFromMachines(machines)) ===
        undefined,
      now: () => new Date(this.now()),
    })
    // Approval broker [spec:SP-edbb] (#410): agent-requested management ops.
    const approvals = new ApprovalService({
      store: this.store.approvals,
      now: () => new Date().toISOString(),
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      clients: () => clientRegistry.values(),
      sessionIssueId: (sessionId) => {
        const s = sessionsSvc.sessionById(sessionId)
        return s ? (s.issueId ?? issues.issueForCwd(s.cwd)) : null
      },
      issueInfo: (issueId) => {
        const row = issues.getMeta(issueId)
        if (!row) return null
        const prefix = this.store.repos.prefixForPath(row.repoPath)
        return {
          seq: row.seq,
          title: row.title,
          displayRef: prefix ? formatIssueRef(prefix, row.seq) : `#${row.seq}`,
        }
      },
      machineName: (machineId) => machines.listMachines().find((m) => m.id === machineId)?.name,
      notifyIssue: (issueId, body) => void issues.sendMail(issueId, 'approval-broker', body),
      executeServerOp: (op, sessionId) => {
        const caller = workflowCallerForCapability(sessionsSvc.capabilityForSession(sessionId))
        if (op.kind === 'workflow-publish') {
          // The approval broker's server-side ops enter by the SAME door every
          // transport uses (POD-732) — the deleted `publish`/`assign` shims were
          // its only other way in, and a server op that skipped the contract's
          // parse would be the one caller whose input nobody validated.
          const revision = workflows.execute(caller, 'publish', {
            revisionId: op.revisionId,
          })
          return `published workflow revision ${revision.id}`
        }
        if (op.kind === 'workflow-set-default') {
          const binding = workflows.execute(caller, 'assign', {
            targetKind: op.targetKind,
            targetId: op.targetId,
            revisionId: op.revisionId,
          })
          return `set ${binding.targetKind} workflow default to revision ${binding.revisionId}`
        }
        if (op.kind === 'automation-schedule') {
          const existingSessionId =
            op.target.kind === 'current'
              ? sessionId
              : op.target.kind === 'session'
                ? op.target.sessionId
                : null
          const existing =
            existingSessionId === null
              ? null
              : sessionsSvc
                  .listSessions()
                  .find((session) => session.sessionId === existingSessionId)
          if (existingSessionId !== null && !existing) {
            throw new Error(`unknown target session: ${existingSessionId}`)
          }
          const fresh = op.target.kind === 'fresh' ? op.target : null
          const principal = resolvePrincipal(sessionsSvc.capabilityForSession(sessionId), {
            parentSessionOf: (candidate) =>
              spawnedByParentSessionId(sessionsSvc.sessionSpawnedBy(candidate)),
            onBehalfOfFor: (candidate) => sessionsSvc.sessionOwner(candidate)?.owner,
          })
          const scheduled = automations.create(
            {
              name: op.name,
              scheduleKind: 'once',
              cron: null,
              runAt: op.runAt,
              targetSessionId: existingSessionId,
              repoPath: existing?.cwd ?? fresh?.repoPath ?? null,
              agentKind: existing?.agentKind ?? fresh?.agentKind ?? 'codex',
              model: fresh?.model ?? 'auto',
              effort: fresh?.effort ?? 'auto',
              prompt: op.prompt,
              enabled: true,
              sessionMode: existingSessionId === null ? 'fresh' : 'resume',
            },
            principal,
          )
          return `scheduled one-off automation ${scheduled.id} for ${scheduled.runAt}`
        }

        return null
      },
      logEvent: (kind, issueId, payload) => {
        try {
          this.store.events.appendEvent({
            ts: new Date().toISOString(),
            kind,
            subject: issueId ?? 'approvals',
            payload,
          })
        } catch {}
      },
    })
    const issueCommands = new IssueCommandDispatcher({
      attachSession: (caller, input) => issueAttach.execute(caller, input),
      issues,
      deleteIssue: (id) => issueSessionLifecycle.deleteIssue(id),
      restoreIssue: (id) => issueSessionLifecycle.restoreIssue(id),
      mutations,
      listSessions: () => sessionsSvc.listSessions(),
      // The by-id read [POD-1646]: one session, not the full pass.
      sessionById: (sessionId) => sessionsSvc.sessionById(sessionId),
      repoPaths: () => this.store.repos.listRepoPaths(),
      inferRepoFromPath: (path) => inferRepoFromRoots(this.store.repos.listRepoPaths(), path),
      // mailSend rides the unified substrate (#237) [spec:SP-34d7].
      sendMessage: (from, input) => messagesSvc.send(from, input),
      // Tray answer delivery (issue #53): the shared answer_question matching
      // path, with text fallback — no live menu means the answer arrives as a
      // normal chat message (resumeAndSend wakes a parked session).
      answerSessionQuestion: async (sessionId, answer, caller) => {
        const r = await deliverAnswerToSession(
          {
            getSession: (id) => sessionsSvc.sessionById(id),
            sessions: sessionsSvc,
            rpc: {
              readTranscript: (input) =>
                rpc.readTranscript(input, { kind: 'system', id: 'issue-answer-delivery' }),
            },
          },
          {
            sessionId,
            answer,
            principal: sessionsSvc.inboxPrincipalForCapability(caller.capability),
            textFallback: true,
          },
        )
        return r.ok ? { ok: true, via: r.via } : r
      },
      // issue stop [spec:SP-9904]: park every member session + free worktree.
      stopIssueSessions: (input) => issueSessionLifecycle.stopIssue(input),
    })
    this.issues = issues
    this.bus.on('machine.diagnostic', (diagnostic) => {
      routeMachineDiagnostic(diagnostic, {
        recipients: (machineId) => {
          const owner = machines.ownershipRows().find((row) => row.id === machineId)?.ownerUserId
          return [
            ...(owner ? [asUserId(owner)] : []),
            ...this.store.users
              .list()
              .filter((user) => user.role === 'admin')
              .map((user) => asUserId(user.id)),
          ]
        },
        repoPath: (machineId) =>
          this.store.repos.listRepoPaths(machineId)[0] ?? this.store.repos.listRepoPaths()[0],
        issueExists: (id) => this.store.issues.getIssue(id) !== null,
        createIssue: (input) => void issues.create(input),
        sendMail: (issueId, body) => void issues.sendMail(issueId, 'machine-diagnostic', body),
        notify: (ownerUserId, notice) => notify.notifyExternal(notice, ownerUserId),
        warn: (message) => console.warn(message),
      })
    })
    this.issueCommands = issueCommands
    // Layout service is composed here (not reached from tRPC via sessionStore) so
    // the transport only names familyState(ctx).modules.layout — router-triple-access.
    const layout = new LayoutService({ layout: this.store.layout, ledger })
    // Same composition seam for the read-cursor family (POD-1380).
    const readPosition = new ReadPositionService({ cursors: this.store.readPositions, ledger })
    this.modules = {
      bus: this.bus,
      funnel,
      sessions: sessionsSvc,
      machines,
      updates: updatesService,
      rpc,
      serverTransfer,
      loginPropagation,
      nativeLogin,
      memory,
      hosts,
      settings,
      layout,
      readPosition,
      headless,
      reactions,
      notify,
      issues,
      issueSessionLifecycle,
      issuePublisher: publisher,
      issueCommands,
      specs,
      approvals,
      workflows,
      locks,
      lockCommands,
      messages: messagesSvc,
      messageGate,
      readToolkit,
      issueArtifacts,
      automations,
      perf,
      mutations,
    }
    const agentRelayGate = new AgentRelayGate({
      // issues/repos ops run through the registry dispatcher (guard + schema +
      // handler, router-equal); the specs router (pspec, #135) is served by the
      // specs module — same schemas + repo-root gate as the tRPC slice; the
      // sessions slice exposes ONLY real-turn delivery (sendText/resumeAndSend/
      // continue — never spawn/kill/archive or raw PTY input), scope-gated
      // against the TARGET session's issue exactly like an issue write
      // (RELAY_ALLOWED lists all four routers).
      dispatch: makeAgentRelayDispatch({
        approvals,
        featureStates: () => getFeatureStates(currentSettings),
        featureEnabled,
        issueCommands,
        issueSessionLifecycle,
        issues,
        listRepos: () => this.store.repos.listRepos(),
        lockCommands,
        messageGate,
        // A getter, not `this.modules`: the field is filled just above and the
        // arm only runs per request, long after — but the arm is BUILT here, so
        // it must not capture the value.
        modules: () => this.modules,
        readToolkit,
        sessionsSvc,
        specs,
        workflowCallerForCapability,
        workflows,
      }),
      capabilityForSession: (sessionId) => sessionsSvc.capabilityForSession(sessionId),
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      // Self-stop kill only after agentRelayResult is on the wire [spec:SP-9904].
      afterSuccessfulReply: (msg, result) => {
        if (!result || typeof result !== 'object') return
        if ((result as { deferredKill?: boolean }).deferredKill !== true) return
        if (
          (msg.router === 'sessions' && msg.proc === 'stop') ||
          (msg.router === 'issues' && msg.proc === 'stop')
        ) {
          sessionsSvc.finalizeDeferredStopKill(msg.sessionId)
        }
      },
    })
    // Module boot hook: eager hydration (a corrupt row is quarantined by the
    // store's row-level guard, so boot proceeds minus that row instead of
    // crash-looping), the leaked-draft reap, and the issue ledger boot reconcile.
    issues.boot(systemPrincipal('boot-reconcile'))
    // One durable queued-row pass repairs events missed while the server was down
    // and restores one-shot wake-cooldown deadlines. [spec:SP-c29e]
    try {
      messagesSvc.reconcileQueued()
    } catch (error) {
      console.warn(
        '[podium] queued message startup recovery failed; retry backstop remains active',
        error,
      )
    }
    this.steward = new StewardService({
      principal: systemPrincipal('steward'),
      store: this.store.events,
      facts: this.store.notificationFacts,
      messages: this.store.messages,
      issues,
      listSessions: () => sessionsSvc.listSessions(),
      // The by-id read [POD-1646]: one session, not the full pass.
      sessionById: (sessionId) => sessionsSvc.sessionById(sessionId),
      sessionOwner: (sessionId) => sessionsSvc.sessionOwner(sessionId)?.owner,
      // Durable outbox path: the nudge survives restarts and waits out a booting TUI.
      sendTextWhenReady: (sessionId, text, mutationId) => {
        const result = sessionsSvc.queueText({
          sessionId,
          text,
          ...(mutationId ? { mutationId } : {}),
          inputOrigin: 'steward',
        })
        if (!result.ok) throw new Error(result.reason ?? 'failed to durably queue steward nudge')
      },
      // The `notify` switch's external push (#470) [spec:SP-17db] — injected, not
      // imported, so the steward's unit tests never touch ntfy/Telegram.
      notify: (ownerUserId, notice) => notify.notifyExternal(notice, ownerUserId),
      getSettings: () => this.store.settings.getSettings(),
      // Deterministic ack fallback (#237) [spec:SP-34d7 acks]: stitch issue
      // stage + last commit (best-effort daemon git) into the system notice.
      messaging: {
        ackFallback: (sessionId, outcome, notificationFact) =>
          void (async () => {
            if (messagesSvc.settleNotifiable(sessionId).length === 0) return
            const meta = sessionsSvc.sessionById(sessionId)
            const issueId = meta ? (meta.issueId ?? issues.issueForCwd(meta.cwd)) : null
            const issue = issueId ? issues.getMeta(issueId) : null
            let lastCommit: string | undefined
            if (meta) {
              try {
                const r = await rpc.repoOp('log', meta.cwd, undefined, meta.machineId)
                if (r.ok) lastCommit = r.output.split('\n')[0]
              } catch {}
            }
            messagesSvc.systemAckFallback(sessionId, {
              outcome,
              notificationFact,
              ...(issue ? { issueSeq: issue.seq, issueStage: issue.stage } : {}),
              ...(lastCommit ? { lastCommit } : {}),
              // #285 pass-through: a worker that settles without reporting its
              // assigned workflow step gets that flagged in the settle notice.
              ...(meta?.workflowStepId ? { workflowStepId: meta.workflowStepId } : {}),
            })
          })().catch(() => {}),
      },
    })
    // Steward timer RETIRED [POD-925]: janitor owns steward-poll cadence.
    // this.steward.start()
    // Message delivery retriggers (#237) [spec:SP-34d7]: a turn ending (phase →
    // idle) drains that session's queued messages (and clears its hop context);
    // the slow sweep expires + retries whatever the event triggers missed.
    this.bus.on('session.stateChanged', ({ sessionId, prev, next }) => {
      if (next.phase !== 'idle' || prev?.phase === 'idle') return
      const meta = sessionsSvc.sessionById(sessionId)
      // Pass the phase the turn left from: an errored turn (prev='errored') did
      // not complete, so the turn-boundary backstop must not confirm its injected
      // rows [POD-853].
      if (meta) messagesSvc.onSessionIdle(meta, { priorPhase: prev?.phase })
      else messagesSvc.onSessionEligibilityChanged(sessionId)
    })
    // Transcript-echo confirmation (#834) [POD-834 §04d]: a message the substrate
    // typed into a PTY reappears as a user turn carrying its `[podium message
    // <id>]` frame — seeing that echo is what flips the ledger queued → delivered
    // (an honest "the agent has it", never the old enqueue-time lie).
    this.bus.on('transcript.delta', ({ sessionId, items }) => {
      messagesSvc.onTranscriptDelta(sessionId, items)
    })
    this.messageSweep = setInterval(() => messagesSvc.sweep(), DELIVERY_RETRY_BACKSTOP_MS)
    this.messageSweep.unref?.()
    // Event-log retention + issue auto-archive timers RETIRED [POD-925]: both
    // jobs now run on the fenced janitor surface (parity-proven in unit tests).
    // Classes remain for tests / manual pruneNow; start() is no longer called.
    this.eventRetention = new EventLogRetention(this.store.events, {
      onMetrics: (metrics) => {
        perf.record('phase', 'eventLogPrune.total', metrics.totalDurationMs, DEPLOYMENT)
        perf.record('phase', 'eventLogPrune.maxSlice', metrics.maxUninterruptedSliceMs, DEPLOYMENT)
      },
    })
    this.issueAutoArchive = new IssueAutoArchive(issues)
    // STARTED, unlike the two retired timers around it: the watch refreshes only
    // the ephemeral in-memory git-state cache, so there is no durable write for
    // the janitor's fence to protect — see IssueGitWatch.
    this.issueGitWatch = new IssueGitWatch(issues)
    this.issueGitWatch.start()
    // Automations scheduler timer RETIRED [POD-925]: janitor owns automation-fire.
    this.automationScheduler = new AutomationScheduler(automations)
    // this.automationScheduler.start()

    // THE GATEWAY (POD-317 / POD-389). The daemon socket mux is composed HERE,
    // over the feature ports, so no feature module owns another feature's
    // traffic. `agentRelay` is its own port and receives exactly the two relay
    // frames — the host-edge separation of ADR 7 D2 / ADR 5 D7 survives the fact
    // that both surfaces arrive on the same socket.
    // The CLIENT plane's mux. Every client frame is session-owned today except
    // `ping`, which the mux answers itself — see gateway/client-frame-routing.ts.
    this.clientGateway = new ClientMux({
      registry: clientRegistry,
      ports: { sessions: sessionsSvc },
      feed: feedServing,
      presence,
      bootstrap: (client) => {
        if (!client.publication || client.publication.global) {
          client.send({ type: 'approvalsChanged', pending: approvals.listPending() })
          hosts.snapshotFor(client.send)
        }
      },
    })
    this.gateway = new DaemonMux({
      bus: this.bus,
      ports: {
        sessions: sessionsSvc,
        machines,
        hosts,
        conversations: memory,
        rpc,
        headless,
        approvals,
        agentRelay: { run: (machineId, msg) => void agentRelayGate.run(machineId, msg) },
        updates: { onUpdateStatus: (machineId, msg) => updatesService.onStatus(machineId, msg) },
      },
    })
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  /** Write-seam ledger — layout (and other non-session modules) capture entity rows here. */
  get changeLedger(): Ledger {
    return this.ledger
  }

  dispose(): void {
    // FIRST, and before store.close() further down the shutdown's persist list:
    // the memory service owns paced loops (transcript mirror + FTS indexer) that
    // keep writing to the store on later turns. Left running they woke after the
    // handle closed and logged their own failure, so a clean stop was
    // indistinguishable from a broken one (POD-1390).
    this.modules.memory.dispose()
    this.eventRetention.dispose()
    this.ledger.dispose()
    clearInterval(this.messageSweep)
    this.modules.messages.dispose()
    this.issueAutoArchive.dispose()
    this.issueGitWatch.dispose()
    this.automationScheduler.dispose()
    // Also drains any coalesced session broadcast + pending delta batch (the
    // durable change log is already complete — commits happen at persist time).
    this.modules.sessions.dispose()
    this.steward.dispose()
  }

  /** Fenced janitor entry: one steward poll with deliveries-before-cursor-advance. */
  runStewardTick(): Promise<void> {
    return this.steward.tick()
  }
}
