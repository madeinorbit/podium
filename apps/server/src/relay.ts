import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { isExposedOn, sessionCommandPlane } from '@podium/commands'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from '@podium/harness'
import type { AgentKind, SessionId, SessionMeta } from '@podium/model'
import {
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  parseIssueDepId,
  parseLayoutRowId,
} from '@podium/model'
import type { LiveServerMessage, VisibilityResolver } from '@podium/protocol'
import { formatIssueRef, SubscriptionRegistry, sessionTitleRule } from '@podium/protocol'
import { durableSessionLabel } from '@podium/runtime/instance'
import { stateDir } from '@podium/runtime/local-machine'
import {
  DEVICE_GRADE_PRINCIPAL,
  FeedIdentityRegistry,
  GrantEdgeVisibilityPolicy,
  Ledger,
  MutationLedger,
  type VisibilityAnchorPort,
} from '@podium/sync'
import { IssueAttachOrchestrator } from './application/issue-attach-orchestrator'
import {
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from './command-principal'
import { REACTIONS, type ReactionDefinition } from './composition/reactions'
import { deviceGradeSoleOwner } from './device-grade-owner'
import { getFeatureStates, isFeatureEnabled } from './features'
import { ClientMux } from './gateway/client-mux'
import { ClientRegistry } from './gateway/client-registry'
import { DaemonMux } from './gateway/daemon-mux'
import { FeedServing } from './gateway/feed-serving'
import { PresenceRouting } from './gateway/presence-routing'
import { checkIssueAccess } from './issue-authz'
import { checkMachineUse, ownershipFromMachines } from './machine-access'
import type { ModelProbe } from './model-catalog'
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
import { issueDepProjectionRows, repoProjectionRows } from './modules/issues/projection'
import { IssuePublisher } from './modules/issues/publish'
import { IssueCommandDispatcher } from './modules/issues/registry'
import { AgentRelayGate } from './modules/issues/relay-gate'
import { IssueService } from './modules/issues/service'
import { LockCommandDispatcher } from './modules/lock/registry'
import { LockService } from './modules/lock/service'
import { routeMachineDiagnostic } from './modules/machines/diagnostics'
import { DaemonRpcService } from './modules/machines/rpc'
import { MachinesService, type PairingCodes } from './modules/machines/service'
import { MemoryService } from './modules/memory/service'
import { MessageGate } from './modules/messages/gate'
import { principalMailPolicy } from './modules/messages/handlers/context'
import { QueuedMessageApply } from './modules/messages/queued-apply'
import { DELIVERY_RETRY_BACKSTOP_MS, MessageDeliveryService } from './modules/messages/service'
import { makeSpawnOnWake } from './modules/messages/spawn'
import {
  DEFAULT_NOTIFICATION_PUSHERS,
  type NotificationPushers,
  NotifyService,
  type SessionNoticeInfo,
} from './modules/notify/service'
import { DEPLOYMENT, type PerfRegistry, perf } from './modules/perf/registry'
import {
  fleetViewFor,
  machinesForPrincipal,
  sessionCommandCtx,
  visibleMachinesFor,
} from './modules/sessions/command-ctx'
import { dispatchSessionCommand, isCommandPlaneProc } from './modules/sessions/command-plane'
import { SessionInstructionRegistry } from './modules/sessions/instructions'
import { DEFAULT_GEOMETRY, SessionLifecycle } from './modules/sessions/lifecycle'
import type { SnapshotTail } from './modules/sessions/publication/coordinator'
import type { PublishWorkerClient } from './modules/sessions/publish-worker-client'
import { SessionReadToolkit } from './modules/sessions/read-toolkit'
import type { Session } from './modules/sessions/session'
import { LayoutService } from './modules/layout/service'
import { SettingsService, type TelegramSetupClient } from './modules/settings/service'
import { SpecsService } from './modules/specs/service'
import { deliverAnswerToSession } from './modules/superagent/answer-delivery'
import type { HeadlessService } from './modules/superagent/headless'
import { dispatchWorkflowRpc } from './modules/workflows/rpc'
import { WorkflowService } from './modules/workflows/service'
import { inferRepoFromRoots } from './repo-registry'
import { StewardService, sessionSpawnerParentId } from './steward'
import { SessionStore } from './store'
import { isGenericClaudeTitle, isTransientTitle } from './title-filter'

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
  /** Deterministic publication-worker fault injection for service-level tests. */
  publicationWorker?: PublishWorkerClient
  /** Rollout-only semantic comparison of legacy and worker publications. */
  publicationShadowCompare?: boolean
}

/** The composed module set (issue #13 Phase 2): the typed seam every caller —
 *  router procs (ctx.modules), server assembly, superagent, tests — reaches
 *  services through. */
export interface RegistryModules {
  bus: EventBus
  funnel: WriteFunnel
  sessions: SessionLifecycle
  machines: MachinesService
  rpc: DaemonRpcService
  memory: MemoryService
  hosts: HostsService
  settings: SettingsService
  /** Per-user sidebar/tab layout (POD-1350) — store + feed publish behind one service. */
  layout: LayoutService
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

/**
 * The label a session shows in the sidebar, or undefined when it has none worth
 * showing (#490). Mirrors the client's sessionDisplayName (name beats title) minus
 * its 'untitled' fallback: a placeholder — an empty/spinner OSC title, or Claude's
 * generic "Claude Code" — is NOT a label, and listing it as a sibling would tell an
 * agent to distinguish itself from nothing.
 */
function sessionLabel(session: SessionMeta): string | undefined {
  const name = session.name?.trim()
  if (name) return name
  const title = session.title.trim()
  if (!title || isTransientTitle(title) || isGenericClaudeTitle(title)) return undefined
  return title
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
  /** Cron tick for scheduled automations (#470) [spec:SP-17db] — modules/automations. */
  private readonly automationScheduler: AutomationScheduler
  private readonly store: SessionStore
  private readonly now: () => number

  constructor(
    store: SessionStore | undefined,
    notificationPushers: NotificationPushers | undefined,
    options: SessionRegistryOptions,
  ) {
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
          sessionSpawnerParentId(this.store.sessions.getSession(asSessionId(candidate))?.spawnedBy),
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
    const machines = new MachinesService({
      instanceId,
      store: this.store,
      // ONE READER of `<stateDir>/machine.id`: the composition root passes the id to
      // the store, and every consumer takes the store's copy. A second `readOrCreate*`
      // call anywhere in the process would be a second opinion about who this host is.
      hostMachineId: this.store.hostMachineId,
      bus: this.bus,
      ...(options.pairing ? { pairing: options.pairing } : {}),
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
    const feedMayReadIssue = (userId: string, issueId: string): boolean => {
      // Authority publishes after the transaction commits but before IssueService
      // installs a newly-created row in its live map. Read the durable row here so
      // the creation frame is scoped from the same committed truth catch-up sees.
      const row = this.store.issues.getIssue(issueId)
      if (row?.ownerUserId === userId) return true
      return this.store.grants
        .listForResource('issue', issueId)
        .some(
          (edge) =>
            edge.grantee === userId &&
            (edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage'),
        )
    }
    const visibility = new GrantEdgeVisibilityPolicy({
      classOf: (entity) => {
        if (entity === 'repo') return 'deployment-substrate'
        // Per-user shell layout (POD-1350): never grantable; keyedUserOf owns the
        // filter. Must NOT fall through to personal or unclassified.
        if (entity === 'userLayout') return 'per-user-state'
        if (
          entity === 'session' ||
          entity === 'issue' ||
          entity === 'issueProjection' ||
          entity === 'issueDep' ||
          entity === 'conversation' ||
          entity === 'automation' ||
          entity === 'automationRun'
        )
          return 'personal'
        return null
      },
      mayRead: (userId, ref) => {
        if (userId === 'device:shared-instance-password') return true
        if (ref.entity === 'issue' || ref.entity === 'issueProjection') {
          return feedMayReadIssue(userId, ref.entityId)
        }
        if (ref.entity === 'issueDep') {
          const dep = parseIssueDepId(ref.entityId)
          return dep !== null && feedMayReadIssue(userId, dep.fromId)
        }
        if (ref.entity === 'session') {
          const row = this.store.sessions.getSession(asSessionId(ref.entityId))
          if (row?.ownerUserId === userId) return true
          return this.store.grants
            .listForResource('session', ref.entityId)
            .some((edge) => edge.grantee === userId && edge.verb === 'read')
        }
        if (ref.entity === 'conversation') {
          const row = this.store.sessions
            .loadSessions()
            .find((candidate) => candidate.resumeValue === ref.entityId)
          if (!row) return false
          if (row.ownerUserId === userId) return true
          return this.store.grants
            .listForResource('session', row.id)
            .some((edge) => edge.grantee === userId && edge.verb === 'read')
        }
        if (ref.entity === 'automation') {
          return this.store.automations.get(ref.entityId)?.ownerUserId === userId
        }
        if (ref.entity === 'automationRun') {
          const run = this.store.automations.getRun(ref.entityId)
          return run ? this.store.automations.get(run.automationId)?.ownerUserId === userId : false
        }
        // per-user-state is decided by keyedUserOf, not mayRead.
        if (ref.entity === 'userLayout') return false
        return false
      },
      keyedUserOf: (ref) => {
        if (ref.entity !== 'userLayout') return null
        try {
          return parseLayoutRowId(ref.entityId).userId
        } catch {
          return null
        }
      },
    })
    const durableChangeValueOf = (ref: { entity: string; entityId: string }): unknown => {
      const row = this.store.sync
        .latestChangeStates()
        .find((candidate) => candidate.entity === ref.entity && candidate.entityId === ref.entityId)
      if (!row || row.op !== 'upsert' || row.payload === null) return undefined
      try {
        return JSON.parse(row.payload)
      } catch {
        return undefined
      }
    }
    const anchors: VisibilityAnchorPort = {
      visibilityEdge: (ref) => {
        if (ref.entity !== 'issue') return null
        const audience = this.store.grants.visibilityAudienceFor('issue', ref.entityId)
        if (audience.length === 0) return null
        const issueSessions = this.store.sessions
          .loadSessions()
          .filter((session) => session.issueId === ref.entityId)
        const subjects = [
          { entity: 'issue' as const, entityId: ref.entityId },
          { entity: 'issueProjection' as const, entityId: ref.entityId },
          ...issueSessions.map((session) => ({
            entity: 'session' as const,
            entityId: session.id,
          })),
          ...issueSessions.flatMap((session) =>
            session.resumeValue
              ? [{ entity: 'conversation' as const, entityId: session.resumeValue }]
              : [],
          ),
          ...this.store.sync
            .latestChangeStates()
            .filter(
              (row) =>
                row.entity === 'issueDep' &&
                row.op === 'upsert' &&
                parseIssueDepId(row.entityId)?.fromId === ref.entityId,
            )
            .map((row) => ({ entity: 'issueDep' as const, entityId: row.entityId })),
        ]
        return { audience, subjects }
      },
      currentValueOf: (ref) => durableChangeValueOf(ref),
    }
    const ledger = new Ledger({
      visibility,
      anchors,
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
    const roomVisibility: VisibilityResolver = {
      canSee: (principal, ref) => {
        if (principal.kind !== 'user') return false
        if (ref.kind !== 'session' && ref.kind !== 'issue') return false
        return visibility.mayDeliver(
          { kind: 'user', userId: principal.user },
          { entity: ref.kind, entityId: ref.id },
        )
      },
    }
    const presence = new PresenceRouting({
      subscriptions,
      clients: clientRegistry,
      visibility: roomVisibility,
      now: this.now,
    })
    const feedServing = new FeedServing({
      authority: ledger.authority,
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
    const publisher = new IssuePublisher({
      // Write-less full-list rebroadcasts (session churn, staleness flips):
      // reconcile against the ledger baseline (durable append, #255), then fan
      // the committed changes out.
      publishIssueList: (spec, projectionRows) => {
        // The reconcile's appends ARE the fan-out (POD-1203): they enter the
        // Authority's ordered pipe and reach every connection through the feed.
        // The legacy snapshot that used to follow this line is built at the
        // connection boundary now, from these same rows.
        ledger.reconcile('issue', spec.rows)
        // The normalized kind rides the SAME onAppended pipe [POD-796] — no
        // second emitter and no second ordering, which the client gap rule
        // (seq !== cursor+1 -> heal) makes non-negotiable. A delta client that
        // did NOT offer CAP_ISSUES_NORMALIZED still receives these rows and
        // ignores them via lenient parsing, advancing its cursor past them
        // (protocol/messages/sync.ts) — that is why a new KIND is additive
        // where reshaping 'issue' in place would not have been.
        if (projectionRows) ledger.reconcile('issueProjection', projectionRows)
        // The edges reconcile on the same full-truth pass [POD-822]. Additive,
        // and since POD-797 UNCONDITIONAL (the issues-normalized-wire flag is
        // deleted): `undefined` means only "cannot project; do not touch the
        // kind". A build that has never heard of the 'issueDep' kind ignores
        // the rows and advances its cursor.
        const depRows = issueDepProjectionRows(this.store.issues.listAllIssueDeps())
        if (depRows) ledger.reconcile('issueDep', depRows)
      },
    })
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
              if (ref.kind === 'issue') return feedMayReadIssue(userId, ref.id)
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
      memory,
      issueAccess,
      snapshotTail,
      onWorktreesChanged: broadcastWorktreesChanged,
      instructionsForStart: (input) => sessionInstructions.prepare(input),
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
      if (!authorized.ok) return
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
    this.bus.on('session.listChanged', () => {
      publisher.publishIssues(issues.allWire(), issues.allProjections())
    })
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
          messagesSvc.onIssueEligibilityChanged(change.id)
        }
      }
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
        const s = sessionsSvc.listSessions().find((x) => x.sessionId === sessionId)
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
              sessionSpawnerParentId(
                sessionsSvc.listSessions().find((session) => session.sessionId === candidate)
                  ?.spawnedBy,
              ),
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
            getSession: (id) => sessionsSvc.listSessions().find((s) => s.sessionId === id),
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
    this.modules = {
      bus: this.bus,
      funnel,
      sessions: sessionsSvc,
      machines,
      rpc,
      memory,
      hosts,
      settings,
      layout,
      headless,
      reactions: REACTIONS,
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
      dispatch: (capability, overrideScope, router, proc, input) => {
        if (router === 'features' && proc === 'state') {
          return Promise.resolve(getFeatureStates(currentSettings))
        }
        if (router === 'quota' && proc === 'summary') {
          return this.modules.rpc.agentQuotaAll()
        }
        /**
         * `machines.list` for agents (POD-1386) — "what can I run on?".
         *
         * INHERITED, NOT RESTATED. This calls the SAME `visibleMachinesFor` the
         * router serves at router.ts:399, and that is the whole design: the
         * projection filters the see-set and stamps each row's `use` decision, and
         * a second copy of that scoping decision is precisely how the property
         * would quietly stop holding on ONE path while still holding on the other,
         * with nothing to report it. There is no policy in this arm.
         *
         * WHY REPOS RIDE ALONG, AND WHY THEY ARE FILTERED TWICE. A machine's
         * registered checkout paths are what makes an enumeration actionable —
         * without them "which machine can take this work" is unanswerable — but
         * `repos.listDetailed` returns every row across every machine, unscoped.
         * Allowlisting that proc would disclose checkout paths on machines the
         * caller cannot even see: a worse leak than the gap being closed. So the
         * rows are cut to machines that survived the projection AND carry
         * `use: 'granted'`, putting a checkout path in the same class the model
         * already puts `inventory` in — "what can I run on your hardware, and as
         * whom" is a `use` question, not a `see` question.
         *
         * A `see`-only machine therefore arrives with no repos and no inventory,
         * and the CLI renders that as "not available to this session" rather than
         * "none registered" — the two differ in what they are a fact ABOUT, and
         * only the second would be a lie.
         *
         * TWO PROCS, ONE SHAPE EACH. `list` answers EXACTLY what the router
         * answers — the same projection, the same array — because a proc that
         * returned one shape over HTTP and another over the relay would be a trap
         * for every caller that can reach both (`podium issue start --machine`
         * resolves names over whichever transport it has). The repo join is a
         * SECOND proc rather than a wider `list`.
         */
        if (router === 'machines' && proc === 'list') {
          return Promise.resolve(visibleMachinesFor(this.modules, capability))
        }
        if (router === 'machines' && proc === 'listWithRepos') {
          return Promise.resolve(
            fleetViewFor(this.modules, capability, this.store.repos.listRepos()),
          )
        }
        if (router === 'specs') {
          return specs.has(proc) ? (specs.invoke(proc, input) as Promise<unknown>) : undefined
        }
        // Advisory lease locks [spec:SP-85d1]: the caller's session identity is
        // stamped server-side via the capability (actorSessionId), never from input.
        if (router === 'lock') {
          return lockCommands.dispatch(
            { capability, ...(overrideScope ? { overrideScope } : {}) },
            proc,
            input,
          )
        }
        // Unified messaging command surface (#237) [spec:SP-34d7]: podium mail
        // send/inbox/show/reply + the stop-hook's pendingReminders. Authz lives
        // in the gate (session targets: same containment as the sessions arm).
        if (router === 'messages') {
          return messageGate.dispatch(capability, overrideScope, proc, input)
        }
        // The workflow surface, derived from the contract + query tables
        // (POD-732). `WorkflowService.dispatch` — a reflective call over the
        // deleted `workflowInputs` that served any proc with a schema — is gone;
        // exposure is asked per declaration and both transports enter through
        // the same `execute` door.
        if (router === 'workflows') {
          return dispatchWorkflowRpc(
            workflows,
            workflowCallerForCapability(capability, overrideScope),
            proc,
            input,
          )
        }
        // Lazy cross-machine workspace fetch [POD-658]: materialize another
        // session's working state on the CALLER's machine (fetch), or remove
        // what fetch materialized (clean). Fetch is scope-gated against the
        // TARGET's issue exactly like sessions.status — seeing a peer's dirty
        // tree is a read of that peer.
        if (router === 'workspace') {
          const actorSessionId = capability.actorSessionId
          if (!actorSessionId) {
            throw new Error(`workspace.${proc} is only callable by a session (no actor bound)`)
          }
          if (proc === 'clean') {
            return sessionsSvc.workspace.cleanPeeks({
              callerSessionId: actorSessionId,
            })
          }
          if (proc !== 'fetch') return undefined
          return (async () => {
            const raw = (input ?? {}) as Record<string, unknown>
            if (typeof raw.ref !== 'string' || !raw.ref) throw new Error('ref is required')
            const target = readToolkit.resolveTarget(raw.ref)
            if (!target) throw new Error(`no session found for ${raw.ref}`)
            const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
            if (targetIssueId) {
              checkIssueAccess(
                {
                  capability,
                  ...(overrideScope ? { overrideScope: true } : {}),
                },
                issues,
                'workspace.fetch',
                'write',
                targetIssueId,
              )
            }
            return sessionsSvc.workspace.fetch({
              sourceSessionId: target.sessionId,
              callerSessionId: actorSessionId,
            })
          })()
        }
        // Agent action offer [spec:SP-c7f1]: `podium offer` set/clear. Like
        // sessions.title, the target is ALWAYS the CALLING session (bound from
        // the capability, never from input), so no scope gate is needed — a
        // session is always within its own scope.
        if (router === 'offer') {
          const actorSessionId = capability.actorSessionId
          if (!actorSessionId) {
            throw new Error('offer is only callable by a session (no actor bound)')
          }
          if (proc === 'clear') {
            sessionsSvc.clearOffer(actorSessionId)
            return Promise.resolve({ ok: true, cleared: true })
          }
          if (proc === 'set') {
            const raw = (input ?? {}) as Record<string, unknown>
            const message = typeof raw.message === 'string' ? raw.message.trim() : ''
            if (!message || message.length > 4_000) {
              throw new Error('message must contain 1..4000 characters')
            }
            if (!Array.isArray(raw.actions)) {
              throw new Error('actions must be an array')
            }
            if (raw.actions.length > 6) {
              throw new Error('at most 6 actions are allowed')
            }
            const actions = raw.actions.map((a, i) => {
              const rec = (a ?? {}) as Record<string, unknown>
              const label = typeof rec.label === 'string' ? rec.label.trim() : ''
              const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : ''
              if (!label || label.length > 80) {
                throw new Error(`action ${i + 1}: label must contain 1..80 characters`)
              }
              if (!prompt || prompt.length > 4_000) {
                throw new Error(`action ${i + 1}: prompt must contain 1..4000 characters`)
              }
              // Feedback-collecting action [spec:SP-c7f1]: the UI asks for
              // freeform text before sending, appended to the prompt.
              return rec.input === true ? { label, prompt, input: true } : { label, prompt }
            })
            // Issue-artifact references [POD-120]: bare paths, resolved by the
            // client against the issue panel's artifact list — validated here
            // only for shape (the artifact may legitimately not exist yet).
            let artifacts: string[] | undefined
            if (raw.artifacts !== undefined) {
              if (!Array.isArray(raw.artifacts)) {
                throw new Error('artifacts must be an array')
              }
              if (raw.artifacts.length > 6) {
                throw new Error('at most 6 artifacts are allowed')
              }
              artifacts = raw.artifacts.map((p, i) => {
                const path = typeof p === 'string' ? p.trim() : ''
                if (!path || path.length > 512) {
                  throw new Error(`artifact ${i + 1}: path must contain 1..512 characters`)
                }
                return path
              })
            }
            sessionsSvc.setOffer({
              sessionId: actorSessionId,
              message,
              actions,
              ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
            })
            return Promise.resolve({ ok: true })
          }
          return undefined
        }
        if (router === 'sessions') {
          // Read toolkit tiers 1–2 (#237) [spec:SP-34d7 read-toolkit]: status is
          // a structured snapshot (no transcript text); read is a bounded
          // uuid-cursor transcript window. Both are scope-gated like the send
          // ops against the RESOLVED target's issue and event-logged per read.
          // Tier 4 — the seance (#237) [spec:SP-34d7 read-toolkit]: `podium
          // session ask` rides the messages gate (it IS a message: question +
          // next-turn + wake + bounded ack wait; the gate owns its authz).
          if (proc === 'ask') {
            return messageGate.dispatch(capability, overrideScope, 'ask', input)
          }
          if (proc === 'status' || proc === 'read' || proc === 'recap') {
            return (async () => {
              const raw = (input ?? {}) as Record<string, unknown>
              const ref = proc === 'status' ? raw.ref : raw.sessionId
              if (typeof ref !== 'string' || !ref) {
                throw new Error(`${proc === 'status' ? 'ref' : 'sessionId'} is required`)
              }
              const target = readToolkit.resolveTarget(ref)
              if (!target) throw new Error(`no session found for ${ref}`)
              const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
              if (targetIssueId) {
                checkIssueAccess(
                  {
                    capability,
                    ...(overrideScope ? { overrideScope: true } : {}),
                  },
                  issues,
                  `sessions.${proc}`,
                  'write',
                  targetIssueId,
                )
              } else {
                const isOperator = capability.scope.kind === 'all'
                const isParent =
                  capability.actorSessionId !== undefined &&
                  target.spawnedBy === `session:${capability.actorSessionId}`
                if (!isOperator && !isParent) {
                  throw new Error(
                    'target session has no issue; only its parent or the operator may read it',
                  )
                }
              }
              const reader = capability.actorSessionId ?? 'operator'
              if (proc === 'status') return readToolkit.status(ref, reader)
              // Tier 3 — server-side recap since a watermark (#237)
              // [spec:SP-34d7 read-toolkit]: delta-priced repeated check-ins.
              if (proc === 'recap') {
                return readToolkit.recap(
                  {
                    sessionId: target.sessionId,
                    ...(typeof raw.since === 'string' && raw.since ? { since: raw.since } : {}),
                  },
                  reader,
                )
              }
              const turns = raw.turns != null ? Number(raw.turns) : undefined
              return readToolkit.read(
                {
                  sessionId: target.sessionId,
                  ...(turns != null && Number.isFinite(turns) ? { turns } : {}),
                  ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
                },
                reader,
              )
            })()
          }
          // The agent names its OWN session (#490) — `podium session title "…"`.
          // The target is the CALLING session, taken from the capability exactly as
          // issues.attachSession takes it from the relay context: there is no
          // sessionId in the input, so an agent CANNOT retitle anyone else's
          // session, and no scope gate is needed (a session is always in its own
          // scope). The user's own name is sovereign — the service refuses against
          // it and hands back a reason instead of throwing.
          if (proc === 'title') {
            const actorSessionId = capability.actorSessionId
            if (!actorSessionId) {
              throw new Error('sessions.title is only callable by a session (no actor bound)')
            }
            const raw = (input ?? {}) as Record<string, unknown>
            const name = raw.name ?? raw.title
            if (typeof name !== 'string' || name.trim().length === 0) {
              throw new Error('name is required')
            }
            return Promise.resolve(sessionsSvc.setAgentName({ sessionId: actorSessionId, name }))
          }
          // Clean end [spec:SP-9904]: stop process, free worktree, keep branch.
          // No id → self-stop (the calling session). Outside subtree needs
          // --outside-scope; self / same-issue siblings / subtree are free.
          if (proc === 'stop') {
            return (async () => {
              const raw = (input ?? {}) as Record<string, unknown>
              const actorSessionId = capability.actorSessionId
              const requestedId =
                typeof raw.sessionId === 'string' && raw.sessionId
                  ? asSessionId(raw.sessionId)
                  : undefined
              const sessionId = requestedId ?? actorSessionId
              if (!sessionId) {
                throw new Error(
                  'sessions.stop needs a session id, or must be called from a session (self-stop)',
                )
              }
              const selfStop = actorSessionId !== undefined && sessionId === actorSessionId
              if (!selfStop) {
                const target = sessionsSvc.listSessions().find((s) => s.sessionId === sessionId)
                if (!target) throw new Error('session not found')
                const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
                if (targetIssueId) {
                  checkIssueAccess(
                    { capability, ...(overrideScope ? { overrideScope: true } : {}) },
                    issues,
                    'sessions.stop',
                    'write',
                    targetIssueId,
                  )
                } else {
                  // Issueless: parent/operator free; otherwise --outside-scope
                  // asserts the agent got human OK [spec:SP-9904].
                  const isOperator = capability.scope.kind === 'all'
                  const isParent =
                    actorSessionId !== undefined && target.spawnedBy === `session:${actorSessionId}`
                  if (!isOperator && !isParent && !overrideScope) {
                    throw new Error(
                      'target session has no issue and is outside your tree; re-run with --outside-scope to confirm human permission',
                    )
                  }
                }
              }
              const r = await issueSessionLifecycle.stopSession({
                sessionId,
                force: raw.force === true,
                selfStop,
              })
              if (!r.ok) throw new Error(r.reason ?? 'stop refused')
              return r
            })()
          }
          // MIGRATED (POD-381). sendText / resumeAndSend / continue used to be
          // ~70 lines here: hand-rolled input validation, a hand-rolled subtree
          // gate with its own error strings, and a second application of the
          // idempotency wrapper under a locally-spelled proc name — all of it a
          // near-copy of the tRPC procedure's, differing in ways nobody chose.
          // The contract owns every one of those now, and this arm is transport.
          //
          // The AGENT-vs-OPERATOR differences that were real are preserved
          // because they are properties of the PRINCIPAL, not of the router: an
          // agent's send rides as that agent (senderFromCapability's shape,
          // resolved in the handler from ctx.principal), and an agent addressing
          // an absent session throws `session not found` where the operator's
          // returns the substrate's dead_letter. Both are POD-379-pinned.
          if (isCommandPlaneProc(proc) && isExposedOn(sessionCommandPlane.defs[proc], 'relay')) {
            return Promise.resolve(
              dispatchSessionCommand(
                // `this.modules` is assigned later in this constructor; the
                // closure only runs per request, long after.
                sessionCommandCtx(this.modules, capability, overrideScope, 'relay'),
                proc,
                input,
              ),
            )
          }
          return undefined
        }
        if (router === 'approvals') {
          if (proc === 'request') return Promise.resolve(approvals.request(input))
          if (proc === 'get') return Promise.resolve(approvals.getFromAgent(input))
          return undefined
        }
        const result = issueCommands.dispatch(
          { capability, ...(overrideScope ? { overrideScope } : {}) },
          router,
          proc,
          input,
        )
        const actorSessionId = capability.actorSessionId
        if (result && router === 'issues' && proc === 'prime' && actorSessionId) {
          return Promise.resolve(result).then((issuePrime) => {
            const workflowPrime = featureEnabled('workflows')
              ? workflows.prime({ actor: { kind: 'session', id: actorSessionId }, capability })
              : ''
            // Name-your-own-session (#490): asked for only while the session HAS no
            // name — a named session (by the user or by an earlier turn of this agent)
            // never sees the instruction, so the prime doesn't nag an agent into
            // re-titling something already titled.
            const titlePrime = this.sessionTitlePrime(sessionsSvc, issues, actorSessionId)
            return [String(issuePrime), workflowPrime, titlePrime].filter(Boolean).join('\n\n')
          })
        }
        return result
      },
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
            const meta = sessionsSvc.listSessions().find((s) => s.sessionId === sessionId)
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
      const meta = sessionsSvc.listSessions().find((s) => s.sessionId === sessionId)
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
      },
    })
  }

  /**
   * The "name your own session" block appended to an agent's issue prime (#490).
   *
   * Returns '' — nothing appended — when the session already HAS a name (the user's
   * or one this agent set on an earlier turn), or when it has no issue: a session
   * that doesn't sit under an issue in the sidebar has no siblings to be
   * distinguished from, and nothing to be named relative to.
   *
   * The wording is NOT written here: sessionTitleRule (@podium/protocol) is the one
   * copy of the titling doctrine every surface reuses. What this adds is the local
   * facts — the issue's seq, and the display names of the OTHER sessions on it, so
   * the agent can pick a name that isn't a duplicate of its neighbours'.
   */
  private sessionTitlePrime(
    sessionsSvc: SessionLifecycle,
    issues: IssueService,
    actorSessionId: string,
  ): string {
    const all = sessionsSvc.listSessions()
    const actor = all.find((s) => s.sessionId === actorSessionId)
    if (!actor) return ''
    if (actor.name?.trim()) return ''
    const issueId = actor.issueId ?? issues.issueForCwd(actor.cwd)
    if (!issueId) return ''
    const seq = issues.getMeta(issueId)?.seq
    if (seq === undefined) return ''
    // Siblings = the other sessions on the SAME issue that have a usable label. A
    // session still showing a placeholder ('Claude Code', a spinner frame, an empty
    // OSC title) contributes nothing an agent could distinguish itself from, so it
    // is skipped rather than listed as noise.
    const siblings = all
      .filter((s) => s.sessionId !== actorSessionId && !s.archived)
      .filter((s) => (s.issueId ?? issues.issueForCwd(s.cwd)) === issueId)
      .map((s) => sessionLabel(s))
      .filter((label): label is string => label !== undefined)
    return sessionTitleRule(seq, siblings)
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
