import { randomBytes } from 'node:crypto'
import type { AgentKind, ConversationSummaryWire, IssueWire, SessionMeta } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { LOCAL_PLACEHOLDER } from './local-machine'
import type { ModelProbe } from './model-catalog'
import { EventBus } from './modules/bus'
import { ConversationsService } from './modules/conversations/service'
import { EventLogRetention } from './modules/events/retention'
import { WriteFunnel } from './modules/funnel'
import { HostsService, type MemoryBreakdown } from './modules/hosts/service'
import { IssueAutoArchive } from './modules/issues/auto-archive'
import { IssuePublisher } from './modules/issues/publish'
import { IssueCommandDispatcher } from './modules/issues/registry'
import { IssueRelayGate } from './modules/issues/relay-gate'
import { IssueService } from './modules/issues/service'
import { UpstreamIssuesService } from './modules/issues/upstream'
import { DaemonRpcService } from './modules/machines/rpc'
import { MachinesService, type PairingCodes, sha256 } from './modules/machines/service'
import {
  DEFAULT_NOTIFICATION_PUSHERS,
  type NotificationPushers,
  NotifyService,
  type SessionNoticeInfo,
} from './modules/notify/service'
import { DEFAULT_GEOMETRY, SessionsService } from './modules/sessions/service'
import type { Session } from './modules/sessions/session'
import { SettingsService, type TelegramSetupClient } from './modules/settings/service'
import { SpecsService } from './modules/specs/service'
import { HeadlessService } from './modules/superagent/headless'
import { inferRepoFromRoots } from './repo-registry'
import { StewardService } from './steward'
import { SessionStore } from './store'

// Re-exported so server.ts/tests keep importing the forwarder seam from './relay'.
export type { IssueUpstreamForwarder } from './modules/issues/upstream'
// Re-exported so repo-registry/superagent/tests keep importing the daemon-RPC
// result shapes from './relay'.
export type { OpResult, ScanReposResult, ScanResult } from './modules/machines/rpc'
export type { MemoryBreakdown }

/**
 * The upstream-token mint primitive (node⇄hub sync §2.1): a long-lived, revocable
 * client_sessions row; the plaintext is returned exactly once (only its sha-256 is
 * stored). Standalone (auth-repo-only) so `scripts/mint-upstream-token.ts` can run it
 * against a hub's DB without constructing a full registry — a second registry's
 * boot reconciliation would append oplog rows behind a live server's back.
 */
export function mintUpstreamTokenInto(
  auth: Pick<SessionStore['auth'], 'createClientSession'>,
  nowMs: number = Date.now(),
): string {
  const token = randomBytes(32).toString('base64url')
  // 10 years ≈ non-expiring, while keeping the ordinary expiry machinery (and
  // revocation via deleteClientSession) intact.
  const expiresAt = new Date(nowMs + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()
  auth.createClientSession(sha256(token), expiresAt)
  return token
}

interface SessionRegistryOptions {
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
}

/** The composed module set (issue #13 Phase 2): the typed seam every caller —
 *  router procs (ctx.modules), server assembly, superagent, tests — reaches
 *  services through. */
export interface RegistryModules {
  bus: EventBus
  funnel: WriteFunnel
  sessions: SessionsService
  machines: MachinesService
  rpc: DaemonRpcService
  conversations: ConversationsService
  hosts: HostsService
  settings: SettingsService
  headless: HeadlessService
  notify: NotifyService
  issues: IssueService
  upstreamIssues: UpstreamIssuesService
  issuePublisher: IssuePublisher
  issueCommands: IssueCommandDispatcher
  specs: SpecsService
}

/**
 * The upstream-mirror surface (node⇄hub sync) is spread across the modules that
 * own each entity — sessions (live-session list + hub-staleness flag),
 * conversations (summaries), and upstreamIssues (the issue mirror). This composes
 * them back into the single `UpstreamMirror` seam `UpstreamSync` consumes, so the
 * spread stays an internal detail of the module graph.
 */
export function upstreamMirrorFor(modules: RegistryModules) {
  return {
    setUpstreamSessions: (list: SessionMeta[]) => modules.sessions.setUpstreamSessions(list),
    setUpstreamConversations: (list: ConversationSummaryWire[]) =>
      modules.conversations.setUpstreamConversations(list),
    setUpstreamIssues: (list: IssueWire[]) => modules.upstreamIssues.setUpstreamIssues(list),
    setUpstreamStale: (stale: boolean) => {
      modules.sessions.setUpstreamStale(stale)
    },
  }
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
  /** The issue tracker, aliased for ergonomics (≡ modules.issues). */
  readonly issues: IssueService
  /** In-process issue command surface (≡ modules.issueCommands) — the registry
   *  dispatcher serving the daemon relay + MCP with router-equal authz. */
  readonly issueCommands: IssueCommandDispatcher

  /** Steward trigger queue over the event log; polls only while settings-enabled. */
  private readonly steward: StewardService
  /** Event-log retention timers (issue #61) — modules/events. */
  private readonly eventRetention: EventLogRetention
  /** Read-gated auto-archive timers (issue #127) — modules/issues. */
  private readonly issueAutoArchive: IssueAutoArchive
  private readonly now: () => number

  constructor(
    private readonly store: SessionStore = new SessionStore(':memory:'),
    notificationPushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
    options: SessionRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    // Live entity maps are owned by modules/sessions; the pre-sessions modules
    // reach them through these lazy closures (sessionsSvc is assigned below, and
    // none of the closures can run before the constructor finishes wiring).
    let sessionsSvc!: SessionsService
    let conversations!: ConversationsService
    let issues!: IssueService
    const liveSessions = () => sessionsSvc.sessions
    const clients = () => sessionsSvc.clients

    const machines = new MachinesService({
      store: this.store,
      ...(options.pairing ? { pairing: options.pairing } : {}),
      retargetPlaceholderSessions: (machineId) => {
        for (const s of liveSessions().values()) {
          if (s.machineId === LOCAL_PLACEHOLDER) s.machineId = machineId
        }
      },
      broadcastSessions: () => sessionsSvc.broadcastSessions(),
      clients: () => clients().values(),
    })
    const rpc = new DaemonRpcService({
      store: this.store.conversations,
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      defaultMachine: () => machines.defaultMachine(),
      resolveMachine: (requested, cwd) => machines.resolveMachine(requested, cwd),
      hasDaemon: (machineId) => machines.hasDaemon(machineId),
      machineName: (id) => machines.machineName(id),
      onlineMachineIds: () => machines.onlineMachineIds(),
      getSession: (sessionId) => liveSessions().get(sessionId),
      // Lazy: the conversations service is constructed after loadFromStore below.
      readTranscriptFromLake: (session, input) =>
        conversations.readTranscriptFromLake(session, input),
    })
    const settings = new SettingsService(this.store.settings, this.bus, {
      ...(options.telegramSetup ? { telegramSetup: options.telegramSetup } : {}),
      ...(options.generateTelegramSetupCode
        ? { generateTelegramSetupCode: options.generateTelegramSetupCode }
        : {}),
      ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
      now: this.now,
    })
    const notify = new NotifyService(
      {
        getSettings: () => this.store.settings.getSettings(),
        appendEvent: (e) => this.store.events.appendEvent(e),
        now: () => this.now(),
        clients: () => clients().values(),
        sessionInfo: (sessionId) => {
          const s = liveSessions().get(sessionId)
          return s ? noticeInfo(s) : undefined
        },
        sessionStates: () =>
          [...liveSessions().values()].map((s) => ({ info: noticeInfo(s), state: s.agentState })),
      },
      notificationPushers,
      this.bus,
    )
    const hosts = new HostsService(
      {
        getSettings: () => this.store.settings.getSettings(),
        clients: () => clients().values(),
        machineName: (id) => machines.machineName(id),
        sessions: () => liveSessions().values(),
        hibernateSession: (input) => sessionsSvc.hibernateSession(input),
        daemonRequest: (pending, prefix, timeoutMs, onTimeout, buildMsg, machineId) =>
          rpc.request(pending, prefix, timeoutMs, onTimeout, buildMsg, machineId),
      },
      this.bus,
    )
    // Issue wire plumbing (modules/issues). Constructed BEFORE loadFromStore: the
    // deps are lazy closures (allWire guards the not-yet-assigned IssueService),
    // and broadcasts triggered during load must find the publisher in place.
    const upstreamIssues = new UpstreamIssuesService({
      store: this.store.events,
      now: () => this.now(),
      localIssueExists: (id) => !!issues?.get(id),
      publish: () => publisher.publishIssues(publisher.safeIssuesList()),
      upstreamStale: () => sessionsSvc.isUpstreamStale(),
    })
    // The write-seam change log ([spec:SP-3fe2] #255/#256/#257): issue, session
    // AND conversation writes append their change rows ATOMICALLY with the
    // entity write (one transact span on the shared connection). One changes
    // table + one seq sequence — changesSince consumers see one unified feed.
    const ledger = new Ledger({
      repo: this.store.sync,
      now: () => this.now(),
      transact: (fn) => this.store.transact(fn),
    })
    // THE write funnel (modules/funnel): authorize → repo write → change append →
    // broadcast. Bridges ledger appends onto the bus and runs THE ordered
    // metadataDelta pipe (#256) — sendDelta is the one seam deltas reach
    // clients through.
    const funnel = new WriteFunnel({
      bus: this.bus,
      ledger,
      fanOutSnapshot: (snapshot, opts) => sessionsSvc.fanOutSnapshot(snapshot, opts),
      sendDelta: (changes) => sessionsSvc.sendMetadataDelta(changes),
    })
    const publisher = new IssuePublisher({
      allWire: () => issues?.allWire(),
      withUpstreamIssues: (local) => upstreamIssues.withUpstreamIssues(local),
      // Write-less full-list rebroadcasts (session churn, staleness flips):
      // reconcile against the ledger baseline (durable append, #255), then fan
      // the committed changes out.
      publishIssueList: (spec) => {
        // The reconcile's appends reach delta clients via the funnel's ordered
        // onAppended pipe; publishComputed carries only the legacy snapshot.
        ledger.reconcile('issue', spec.rows)
        funnel.publishComputed(spec.snapshot)
      },
    })
    const issueCommands = new IssueCommandDispatcher({
      issues: () => issues,
      isUpstreamIssue: (id) => upstreamIssues.isUpstreamIssue(id),
      forwardIssueMutation: (proc, input) => upstreamIssues.forwardIssueMutation(proc, input),
      upstreamIssueRepoPaths: () => upstreamIssues.repoPaths(),
      withMutation: (mutationId, proc, fn) => sessionsSvc.withMutation(mutationId, proc, fn),
      listSessions: () => sessionsSvc.listSessions(),
      repoPaths: () => this.store.repos.listRepoPaths(),
      inferRepoFromPath: (path) => inferRepoFromRoots(this.store.repos.listRepoPaths(), path),
    })
    const specs = new SpecsService({
      repoRoots: () => this.store.repos.listRepoPaths(),
    })
    const issueRelayGate = new IssueRelayGate({
      // issues/repos ops run through the registry dispatcher (guard + schema +
      // handler, router-equal); the specs router (pspec, #135) is served by the
      // specs module — same schemas + repo-root gate as the tRPC slice
      // (RELAY_ALLOWED lists all three routers).
      dispatch: (capability, overrideScope, router, proc, input) => {
        if (router === 'specs') {
          return specs.has(proc) ? (specs.invoke(proc, input) as Promise<unknown>) : undefined
        }
        return issueCommands.dispatch(
          { capability, ...(overrideScope ? { overrideScope } : {}) },
          router,
          proc,
          input,
        )
      },
      capabilityForSession: (sessionId) => sessionsSvc.capabilityForSession(sessionId),
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
    })
    const headless = new HeadlessService({
      getSession: (sessionId) => liveSessions().get(sessionId),
      registerSession: (session) => liveSessions().set(session.sessionId, session),
      resolveMachine: (requested, cwd) => machines.resolveMachine(requested, cwd),
      defaultMachine: () => machines.defaultMachine(),
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      nextRequestId: (prefix) => rpc.nextRequestId(prefix),
      defaultGeometry: () => ({ ...DEFAULT_GEOMETRY }),
      persist: (session) => sessionsSvc.persist(session),
      broadcastSessions: () => sessionsSvc.broadcastSessions(),
      clients: () => clients().values(),
    })
    // The sessions module (core lifecycle + data planes). Its issue-shaped deps
    // are lazy closures — issues/conversations are assigned below, and are only
    // ever invoked after construction completes.
    sessionsSvc = new SessionsService({
      store: this.store,
      now: () => this.now(),
      bus: this.bus,
      funnel,
      // Session writes commit through the write-seam ledger at persist() (#256).
      ledger,
      machines,
      rpc,
      hosts,
      headless,
      conversations: () => conversations,
      issues: () => issues,
      publishIssues: () => publisher.publishIssues(publisher.safeIssuesList()),
      issuesWire: () => upstreamIssues.withUpstreamIssues(publisher.safeIssuesList()),
      runIssueRelay: (machineId, msg) => void issueRelayGate.run(machineId, msg),
    })
    // Hub-staleness flips fan out over the bus: the conversation and issue
    // mirrors follow the sessions-owned flag (spec §2.3 stale-visible).
    this.bus.on('upstream.staleChanged', () => {
      conversations.rebroadcastUpstream()
      upstreamIssues.rebroadcastUpstream()
    })
    // Boot: hydrate sessions (and reconcile the restored state against the
    // write-seam ledger — boot reconciliation lives in the sessions module now).
    sessionsSvc.loadFromStore()
    // Constructed AFTER loadFromStore (same slot the inline mirror construction held).
    conversations = new ConversationsService(
      {
        store: this.store,
        now: () => this.now(),
        // Conversation writes commit through the write-seam ledger (#257):
        // discovery/meta commits + upstream-union reconciles append durably at
        // the write, then the funnel fans out ONLY the legacy snapshot (delta
        // clients ride the ordered onAppended pipe).
        ledger,
        publishSnapshot: (snapshot, opts) => funnel.publishComputed(snapshot, opts),
        daemonRequest: (pending, prefix, timeoutMs, onTimeout, buildMsg, machineId) =>
          rpc.request(pending, prefix, timeoutMs, onTimeout, buildMsg, machineId),
      },
      options.mirrorLakeDir ? { mirrorLakeDir: options.mirrorLakeDir } : {},
    )
    issues = new IssueService({
      store: this.store,
      listSessions: () => sessionsSvc.listSessions(),
      getSettings: () => this.store.settings.getSettings(),
      spawnSession: (o) =>
        sessionsSvc.createSession({
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.effort !== undefined ? { effort: o.effort } : {}),
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
          ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
          ...(o.machineId ? { machineId: o.machineId } : {}),
        }),
      repoOp: (op, cwd, args, machineId) => rpc.repoOp(op, cwd, args, machineId),
      requireMachineForRepo: (machineId, repoPath) =>
        machines.requireMachineForRepo(machineId, repoPath),
      getSessionIssueId: (sessionId) => sessionsSvc.getSessionIssueId(sessionId),
      setSessionIssueId: (sessionId, issueId) => sessionsSvc.setSessionIssueId(sessionId, issueId),
      setSessionArchived: (sessionId, archived) => sessionsSvc.setArchived({ sessionId, archived }),
      // Every issue mutation commits through the write-seam ledger (#255) —
      // change rows land in the same transaction as the row write — and fans
      // out via the funnel's publishComputed tail; the PublishSpecs are built
      // by the publisher (which unions in hub-mirrored issues), so durable-
      // before-fan-out holds by construction — there is NO raw-WS path out of
      // the issue tracker anymore.
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
    // Module boot hook: eager hydration (a corrupt row is quarantined by the
    // store's row-level guard, so boot proceeds minus that row instead of
    // crash-looping), the leaked-draft reap, and the issue ledger boot reconcile.
    issues.boot()
    this.steward = new StewardService({
      store: this.store.events,
      issues,
      listSessions: () => sessionsSvc.listSessions(),
      // Durable outbox path: the nudge survives restarts and waits out a booting TUI.
      sendTextWhenReady: (sessionId, text) => void sessionsSvc.queueText({ sessionId, text }),
      getSettings: () => this.store.settings.getSettings(),
    })
    this.steward.start()
    this.eventRetention = new EventLogRetention(this.store.events)
    this.eventRetention.start()
    this.issueAutoArchive = new IssueAutoArchive(issues)
    this.issueAutoArchive.start()

    this.issues = issues
    this.issueCommands = issueCommands
    this.modules = {
      bus: this.bus,
      funnel,
      sessions: sessionsSvc,
      machines,
      rpc,
      conversations,
      hosts,
      settings,
      headless,
      notify,
      issues,
      upstreamIssues,
      issuePublisher: publisher,
      issueCommands,
      specs,
    }
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  /**
   * Mint a long-lived client-session token for a NODE to sync against this server
   * as its hub (spec §2.1 provisioning). The token rides as the `podium_session`
   * cookie on the node's /client WS upgrade and /trpc calls — a normal, revocable
   * client_sessions row (delete it to cut the node off). Printed once; only the
   * sha-256 is stored.
   */
  mintUpstreamToken(): string {
    return mintUpstreamTokenInto(this.store.auth, this.now())
  }

  dispose(): void {
    this.eventRetention.dispose()
    this.issueAutoArchive.dispose()
    // Also drains any coalesced session broadcast + pending delta batch (the
    // durable change log is already complete — commits happen at persist time).
    this.modules.sessions.dispose()
    this.steward.dispose()
  }
}
