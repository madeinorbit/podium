import { randomBytes } from 'node:crypto'
import type { PodiumSettings } from '@podium/core'
import type {
  AgentKind,
  AgentQuotaWire,
  ClientMessage,
  ControlMessage,
  ConversationSummaryWire,
  DaemonHandshake,
  DaemonMessage,
  DirListResultMessage,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
  HarnessAgent,
  HeadlessActivityEvent,
  HeadlessTurnEvent,
  IssueWire,
  MachineQuotaWire,
  MachineWire,
  RepoOp,
  ResumeRef,
  ServerMessage,
  SessionMeta,
  SyncChangesSinceResult,
  TranscriptItem,
  UsageBucketWire,
  WorkState,
} from '@podium/protocol'
import type { Capability } from './issue-authz'
import { selectMailNudgeSession, sessionsForIssue } from './issue-util'
import { IssueService } from './issues'
import { LOCAL_PLACEHOLDER } from './local-machine'
import type { ModelCatalogSnapshot, ModelProbe } from './model-catalog'
import { EventBus } from './modules/bus'
import { ConversationsService } from './modules/conversations/service'
import { WriteFunnel } from './modules/funnel'
import { HostsService, type MemoryBreakdown } from './modules/hosts/service'
import { IssuePublisher } from './modules/issues/publish'
import { IssueRelayGate } from './modules/issues/relay-gate'
import { type IssueUpstreamForwarder, UpstreamIssuesService } from './modules/issues/upstream'
import {
  DaemonRpcService,
  type OpResult,
  type ScanReposResult,
  type ScanResult,
} from './modules/machines/rpc'
import { MachinesService, sha256 } from './modules/machines/service'
import {
  DEFAULT_NOTIFICATION_PUSHERS,
  type NotificationPushers,
  NotifyService,
  type SessionNoticeInfo,
} from './modules/notify/service'
import {
  DEFAULT_GEOMETRY,
  SessionsService,
  UPSTREAM_COMMAND_REJECTION,
} from './modules/sessions/service'
import {
  SettingsService,
  type TelegramSetupClient,
  type TelegramSetupPollResult,
  type TelegramSetupStartResult,
} from './modules/settings/service'
import { HeadlessService } from './modules/superagent/headless'
import type { ClientConn, Send, Session } from './session'
import { StewardService } from './steward'
import { type PinKind, SessionStore } from './store'

// Re-exported so server.ts/tests keep importing the forwarder seam from './relay'.
export type { IssueUpstreamForwarder } from './modules/issues/upstream'
// Re-exported so repo-registry/superagent/tests keep importing the daemon-RPC
// result shapes from './relay'.
export type { OpResult, ScanReposResult, ScanResult } from './modules/machines/rpc'

/**
 * The upstream-token mint primitive (node⇄hub sync §2.1): a long-lived, revocable
 * client_sessions row; the plaintext is returned exactly once (only its sha-256 is
 * stored). Standalone (store-only) so `scripts/mint-upstream-token.ts` can run it
 * against a hub's DB without constructing a full registry — a second registry's
 * boot reconciliation would append oplog rows behind a live server's back.
 */
export function mintUpstreamTokenInto(
  store: Pick<SessionStore, 'createClientSession'>,
  nowMs: number = Date.now(),
): string {
  const token = randomBytes(32).toString('base64url')
  // 10 years ≈ non-expiring, while keeping the ordinary expiry machinery (and
  // revocation via deleteClientSession) intact.
  const expiresAt = new Date(nowMs + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()
  store.createClientSession(sha256(token), expiresAt)
  return token
}

// podium_events retention (issue #61): pruned on a sparse timer — first run
// shortly after boot, then every 6h. Hardcoded (no settings knob yet); revisit
// as a setting when the steward goes always-on.
const EVENT_RETENTION_MAX_AGE_DAYS = 14
const EVENT_RETENTION_MAX_ROWS = 50_000
const EVENT_PRUNE_BOOT_DELAY_MS = 60_000
const EVENT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
// Read-gated auto-archive sweep (issue #127): first pass shortly after boot (so a
// restart promptly clears issues that crossed the 24h read window while down),
// then hourly. Hourly is ample for a 24h-granularity rule and the sweep is cheap.
const AUTO_ARCHIVE_BOOT_DELAY_MS = 90_000
const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000

export type { MemoryBreakdown }

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
}

/**
 * Composition root + public facade over the server's modules (issue #13 Phase 2).
 * The session lifecycle/data planes live in modules/sessions; daemon sockets and
 * machine admin in modules/machines (+ rpc); conversations, issues wire plumbing,
 * hosts, notify, settings and headless harnesses in their modules. This class
 * wires them together with constructor-injected closures and keeps thin delegates
 * so every existing caller (router/wsServer/server/superagent/tests) is unchanged.
 */
export class SessionRegistry {
  /** Typed in-process event bus — modules subscribe here (issue #13 Phase 2). */
  readonly bus = new EventBus()
  /** Attention notifications (ntfy/telegram/in-app) — subscribes to the bus. */
  readonly notify: NotifyService
  /** Daemon gateway: sockets + offline queues, pairing/auth, machines admin and
   *  routing (modules/machines). Constructed FIRST — Session toDaemon closures
   *  route through it from loadFromStore on. */
  private readonly machines: MachinesService
  /** Daemon request/response plumbing — pending maps + requestId mint (modules/machines). */
  private readonly rpc: DaemonRpcService
  /** THE write funnel (modules/funnel): authorize → repo write → oplog append →
   *  broadcast. Owns the durable metadata oplog; every publish pipeline ends here. */
  private readonly funnel: WriteFunnel
  /** Core session lifecycle + client/daemon data planes + broadcast pipeline
   *  (modules/sessions). */
  private readonly sessionsSvc: SessionsService
  /** Settings + model catalog + telegram-setup flow (modules/settings). */
  private readonly settingsService: SettingsService
  /** Server-side issue tracker — constructed after loadFromStore() in the constructor. */
  readonly issues: IssueService
  /** Injected by server.ts: builds a tRPC caller bound to a capability — the scope-gate
   *  seam. A relayed agent op is run through this so the issueCapabilityGuard middleware
   *  enforces the subtree scope; it is NOT re-implemented here. Left undefined in tests that
   *  don't exercise the relay. */
  makeIssueCaller?: (
    capability: Capability,
    overrideScope?: boolean,
  ) => { [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined }
  /** Steward trigger queue over the event log; polls only while settings-enabled. */
  private steward!: StewardService
  /** Conversation index + upstream mirror + transcript lake (modules/conversations). */
  private readonly conversations: ConversationsService
  /** Hub-issue mirror + write forwarding (modules/issues). */
  private readonly upstreamIssuesSvc: UpstreamIssuesService
  /** Issue wire publishing — oplog record + split fan-out (modules/issues). */
  private readonly issuePublisher: IssuePublisher
  /** Relayed agent issue ops — allowlist + capability-scoped caller (modules/issues). */
  private readonly issueRelayGate: IssueRelayGate
  /** Headless harness sessions — superagent-driven, PTY-less (modules/superagent). */
  private readonly headless: HeadlessService
  /** Host health samples + auto-hibernate + memory breakdown (modules/hosts). */
  private readonly hosts: HostsService

  private readonly now: () => number
  // Sparse podium_events retention timers (issue #61): a one-shot boot delay that
  // hands off to the 6h interval. Both unref'd so they never hold the process open.
  private eventPruneBootTimer: ReturnType<typeof setTimeout> | undefined
  private eventPruneTimer: ReturnType<typeof setInterval> | undefined
  // Read-gated auto-archive sweep timers (issue #127) — same boot-delay→interval
  // shape as the event-prune pair above; both unref'd so neither holds the process.
  private autoArchiveBootTimer: ReturnType<typeof setTimeout> | undefined
  private autoArchiveTimer: ReturnType<typeof setInterval> | undefined

  // Live entity maps, surfaced from modules/sessions. Private getters so internal
  // wiring closures — and the relay tests, via `(reg as any).sessions/.clients` —
  // keep reaching the maps exactly as before the module split.
  private get sessions(): Map<string, Session> {
    return this.sessionsSvc.sessions
  }
  private get clients(): Map<string, ClientConn> {
    return this.sessionsSvc.clients
  }
  /** Hub-staleness flag (modules/sessions) — read by the issue mirror's overlay. */
  private get upstreamStale(): boolean {
    return this.sessionsSvc.isUpstreamStale()
  }

  constructor(
    private readonly store: SessionStore = new SessionStore(':memory:'),
    private readonly notificationPushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
    options: SessionRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.machines = new MachinesService({
      store: this.store,
      retargetPlaceholderSessions: (machineId) => {
        for (const s of this.sessions.values()) {
          if (s.machineId === LOCAL_PLACEHOLDER) s.machineId = machineId
        }
      },
      broadcastSessions: () => this.broadcastSessions(),
      clients: () => this.clients.values(),
    })
    this.rpc = new DaemonRpcService({
      store: this.store,
      toMachine: (machineId, msg) => this.machines.toMachine(machineId, msg),
      defaultMachine: () => this.machines.defaultMachine(),
      resolveMachine: (requested, cwd) => this.machines.resolveMachine(requested, cwd),
      hasDaemon: (machineId) => this.machines.hasDaemon(machineId),
      machineName: (id) => this.machines.machineName(id),
      onlineMachineIds: () => this.machines.onlineMachineIds(),
      getSession: (sessionId) => this.sessions.get(sessionId),
      // Lazy: the conversations service is constructed after loadFromStore below.
      readTranscriptFromLake: (session, input) =>
        this.conversations.readTranscriptFromLake(session, input),
    })
    this.settingsService = new SettingsService(this.store, this.bus, {
      ...(options.telegramSetup ? { telegramSetup: options.telegramSetup } : {}),
      ...(options.generateTelegramSetupCode
        ? { generateTelegramSetupCode: options.generateTelegramSetupCode }
        : {}),
      ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
      now: this.now,
    })
    this.notify = new NotifyService(
      {
        getSettings: () => this.store.getSettings(),
        appendEvent: (e) => this.store.appendEvent(e),
        now: () => this.now(),
        clients: () => this.clients.values(),
        sessionInfo: (sessionId) => {
          const s = this.sessions.get(sessionId)
          return s ? SessionRegistry.noticeInfo(s) : undefined
        },
        sessionStates: () =>
          [...this.sessions.values()].map((s) => ({
            info: SessionRegistry.noticeInfo(s),
            state: s.agentState,
          })),
      },
      this.notificationPushers,
      this.bus,
    )
    this.hosts = new HostsService(
      {
        getSettings: () => this.store.getSettings(),
        clients: () => this.clients.values(),
        machineName: (id) => this.machineName(id),
        sessions: () => this.sessions.values(),
        hibernateSession: (input) => this.hibernateSession(input),
        daemonRequest: (pending, prefix, timeoutMs, onTimeout, buildMsg, machineId) =>
          this.rpc.request(pending, prefix, timeoutMs, onTimeout, buildMsg, machineId),
      },
      this.bus,
    )
    // Issue wire plumbing (modules/issues). Constructed BEFORE loadFromStore: the
    // deps are lazy closures (allWire guards the not-yet-assigned IssueService),
    // and broadcasts triggered during load must find the publisher in place.
    this.upstreamIssuesSvc = new UpstreamIssuesService({
      store: this.store,
      now: () => this.now(),
      localIssueExists: (id) => !!this.issues?.get(id),
      publish: () => this.publishIssues(this.safeIssuesList()),
      upstreamStale: () => this.upstreamStale,
    })
    // The write funnel: owns the metadata oplog; its fan-out reaches the client
    // set via modules/sessions (lazy closure — sessionsSvc is assigned below and
    // no broadcast can run before the constructor finishes wiring).
    this.funnel = new WriteFunnel({
      store: this.store,
      now: () => this.now(),
      bus: this.bus,
      fanOut: (snapshot, changes, opts) => this.sessionsSvc.fanOutMetadata(snapshot, changes, opts),
    })
    this.issuePublisher = new IssuePublisher({
      allWire: () => this.issues?.allWire(),
      withUpstreamIssues: (local) => this.upstreamIssuesSvc.withUpstreamIssues(local),
      publish: (rows, snapshot, opts) => this.funnel.publish('issue', rows, snapshot, opts),
    })
    this.issueRelayGate = new IssueRelayGate({
      makeIssueCaller: () => this.makeIssueCaller,
      capabilityForSession: (sessionId) => this.capabilityForSession(sessionId),
      toMachine: (machineId, msg) => this.machines.toMachine(machineId, msg),
    })
    this.headless = new HeadlessService({
      getSession: (sessionId) => this.sessions.get(sessionId),
      registerSession: (session) => this.sessions.set(session.sessionId, session),
      resolveMachine: (requested, cwd) => this.machines.resolveMachine(requested, cwd),
      defaultMachine: () => this.machines.defaultMachine(),
      toMachine: (machineId, msg) => this.machines.toMachine(machineId, msg),
      nextRequestId: (prefix) => this.rpc.nextRequestId(prefix),
      defaultGeometry: () => ({ ...DEFAULT_GEOMETRY }),
      persist: (session) => this.persist(session),
      broadcastSessions: () => this.broadcastSessions(),
      clients: () => this.clients.values(),
    })
    // The sessions module (core lifecycle + data planes). Its issue-shaped deps
    // are lazy closures — this.issues/this.conversations are assigned below, and
    // are only ever invoked after construction completes.
    this.sessionsSvc = new SessionsService({
      store: this.store,
      now: () => this.now(),
      bus: this.bus,
      funnel: this.funnel,
      machines: this.machines,
      rpc: this.rpc,
      hosts: this.hosts,
      headless: this.headless,
      conversations: () => this.conversations,
      issues: () => this.issues,
      publishIssues: () => this.publishIssues(this.safeIssuesList()),
      issuesWire: () => this.withUpstreamIssues(this.safeIssuesList()),
      runIssueRelay: (machineId, msg) => void this.issueRelayGate.run(machineId, msg),
    })
    this.sessionsSvc.loadFromStore()
    // Constructed AFTER loadFromStore (same slot the inline mirror construction held).
    this.conversations = new ConversationsService(
      {
        store: this.store,
        now: () => this.now(),
        publish: (rows, snapshot, opts) =>
          this.funnel.publish('conversation', rows, snapshot, opts),
        daemonRequest: (pending, prefix, timeoutMs, onTimeout, buildMsg, machineId) =>
          this.rpc.request(pending, prefix, timeoutMs, onTimeout, buildMsg, machineId),
      },
      options.mirrorLakeDir ? { mirrorLakeDir: options.mirrorLakeDir } : {},
    )
    this.issues = new IssueService({
      store: this.store,
      listSessions: () => this.listSessions(),
      getSettings: () => this.store.getSettings(),
      spawnSession: (o) =>
        this.createSession({
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.effort !== undefined ? { effort: o.effort } : {}),
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
          ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
          ...(o.machineId ? { machineId: o.machineId } : {}),
        }),
      repoOp: (op, cwd, args, machineId) => this.repoOp(op, cwd, args, machineId),
      requireMachineForRepo: (machineId, repoPath) =>
        this.requireMachineForRepo(machineId, repoPath),
      getSessionIssueId: (sessionId) => this.getSessionIssueId(sessionId),
      setSessionIssueId: (sessionId, issueId) => this.setSessionIssueId(sessionId, issueId),
      setSessionArchived: (sessionId, archived) => this.setArchived({ sessionId, archived }),
      broadcast: (msg) => {
        // Full issue-list fan-outs funnel through the oplog so delta-cap clients get
        // per-issue changes; single-issue updates ride the SAME oplog stream as a
        // partial record (#22) so a persist never serializes the whole list.
        if (msg.type === 'issuesChanged') this.publishIssues(msg.issues)
        else if (msg.type === 'issueUpdated') this.publishIssueUpdate(msg.issue)
        else for (const c of this.clients.values()) c.send(msg)
      },
      // Agent mail send-time nudge (issue #103): poke the target issue's live agent
      // session so mail is noticed without polling. The nudge carries NO message
      // body — an idempotent "check your inbox" poke. Selection: a single idle
      // live agent gets an immediate sendText; otherwise the most recently active
      // live agent gets a durable queued send; no live agents → nothing (the mail
      // surfaces via prime / the stop-hook).
      onMailSent: (row) => {
        const members = sessionsForIssue(row.worktreePath, this.listSessions())
        const target = selectMailNudgeSession(members)
        if (!target) return
        const text = `You have mail on issue #${row.seq}: run 'podium issue mail inbox' (claim with 'podium issue mail claim <id>' only if you will act on it).`
        if (target.mode === 'send') this.sendText({ sessionId: target.sessionId, text })
        else void this.queueText({ sessionId: target.sessionId, text })
      },
    })
    // Explicit hydration at the composition root (issue rows are loaded HERE,
    // not in the IssueService constructor): a corrupt row is quarantined by the
    // store's row-level guard, so boot proceeds minus that row instead of
    // crash-looping the server.
    this.issues.init()
    // Boot-time reconciliation: reap draft issues leaked before the kill-path
    // reaper existed (sessions killed/removed while attached to an empty draft).
    // Sessions are already hydrated (loadFromStore ran above), so the emptiness
    // predicate sees real statuses: live sessions come back as 'reconnecting'
    // (not 'exited') and hibernated stays 'hibernated' — both block the reap,
    // so only truly dead drafts go.
    try {
      const reaped = this.issues.reapLeakedDrafts()
      if (reaped > 0) {
        console.warn(`[podium:issues] boot sweep reaped ${reaped} leaked draft issue(s)`)
      }
    } catch (err) {
      console.warn('[podium:issues] boot draft sweep failed:', err)
    }
    this.steward = new StewardService({
      store: this.store,
      issues: this.issues,
      listSessions: () => this.listSessions(),
      // Durable outbox path: the nudge survives restarts and waits out a booting TUI.
      sendTextWhenReady: (sessionId, text) => void this.queueText({ sessionId, text }),
      getSettings: () => this.store.getSettings(),
    })
    this.steward.start()
    // Event-log retention (issue #61): first prune ~1min after boot (off the boot
    // hot path), then every 6h. try/catch lives in pruneEventLog.
    this.eventPruneBootTimer = setTimeout(() => {
      this.pruneEventLog()
      this.eventPruneTimer = setInterval(() => this.pruneEventLog(), EVENT_PRUNE_INTERVAL_MS)
      this.eventPruneTimer.unref?.()
    }, EVENT_PRUNE_BOOT_DELAY_MS)
    this.eventPruneBootTimer.unref?.()
    // Read-gated auto-archive (issue #127): first sweep ~90s after boot, then hourly.
    this.autoArchiveBootTimer = setTimeout(() => {
      this.runAutoArchiveSweep()
      this.autoArchiveTimer = setInterval(
        () => this.runAutoArchiveSweep(),
        AUTO_ARCHIVE_INTERVAL_MS,
      )
      this.autoArchiveTimer.unref?.()
    }, AUTO_ARCHIVE_BOOT_DELAY_MS)
    this.autoArchiveBootTimer.unref?.()
    // Boot reconciliation: record what changed across the restart (sessions restored
    // by loadFromStore, issues from the store) so a cursor-holding client that
    // reconnects can heal via changesSince instead of silently missing the gap.
    // Conversations are deliberately NOT reconciled here: they are daemon-fed, and
    // an empty list at boot means "not scanned yet", not "all gone" — recording it
    // would spam remove-all/re-upsert pairs around every restart.
    this.funnel.record(
      'session',
      this.listSessions().map((s) => ({ id: s.sessionId, value: s })),
    )
    this.funnel.record(
      'issue',
      this.safeIssuesList().map((i) => ({ id: i.id, value: i })),
    )
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  private persist(session: Session): void {
    this.sessionsSvc.persist(session)
  }

  /** Persist every session whose activity counters advanced since the last flush. */
  flushActivity(): void {
    this.sessionsSvc.flushActivity()
  }

  /** One retention pass over podium_events. Failures are logged, never thrown —
   *  a broken prune must not take down the timer or the registry. */
  private pruneEventLog(): void {
    try {
      const deleted = this.store.pruneEvents({
        maxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
        maxRows: EVENT_RETENTION_MAX_ROWS,
      })
      if (deleted > 0) console.log(`[podium:events] pruned ${deleted} event log rows`)
    } catch (err) {
      console.warn('[podium:events] event log prune failed:', err)
    }
  }

  /** One read-gated auto-archive pass (issue #127). Failures are logged, never
   *  thrown — a broken sweep must not take down the timer or the registry. */
  private runAutoArchiveSweep(): void {
    try {
      const archived = this.issues.sweepAutoArchive()
      if (archived.length > 0) {
        console.log(`[podium:issues] auto-archived ${archived.length} read+done issue(s)`)
      }
    } catch (err) {
      console.warn('[podium:issues] auto-archive sweep failed:', err)
    }
  }

  dispose(): void {
    if (this.eventPruneBootTimer) clearTimeout(this.eventPruneBootTimer)
    if (this.eventPruneTimer) clearInterval(this.eventPruneTimer)
    if (this.autoArchiveBootTimer) clearTimeout(this.autoArchiveBootTimer)
    if (this.autoArchiveTimer) clearInterval(this.autoArchiveTimer)
    // Also runs any coalesced session broadcast so the oplog records the final
    // state (clients are going away, but the durable log must not drop the tail).
    this.sessionsSvc.dispose()
    this.steward.dispose()
  }

  attachDaemon(machineId: string, send: Send<ControlMessage>): void {
    this.sessionsSvc.attachDaemon(machineId, send)
  }

  detachDaemon(machineId: string): void {
    this.sessionsSvc.detachDaemon(machineId)
  }

  // ---- tRPC control plane ----
  listSessions(): SessionMeta[] {
    return this.sessionsSvc.listSessions()
  }

  // ---- upstream mirror (node⇄hub sync, docs/spec/node-hub-sync.md §2.3) ----

  /** Rejection every command path returns for a hub-mirrored session (spec §2.3). */
  static readonly UPSTREAM_COMMAND_REJECTION = UPSTREAM_COMMAND_REJECTION

  setUpstreamOwnMachineIds(ids: Iterable<string>): void {
    this.sessionsSvc.setUpstreamOwnMachineIds(ids)
  }

  /** True when `sessionId` is a hub-mirrored (read-only) session. */
  isUpstreamSession(sessionId: string): boolean {
    return this.sessionsSvc.isUpstreamSession(sessionId)
  }

  /** Replace the mirrored session list with the hub's truth (modules/sessions). */
  setUpstreamSessions(list: SessionMeta[]): void {
    this.sessionsSvc.setUpstreamSessions(list)
  }

  /** Replace the mirrored conversation list (modules/conversations). */
  setUpstreamConversations(list: ConversationSummaryWire[]): void {
    this.conversations.setUpstreamConversations(list)
  }

  /**
   * Hub reachability flip. Unreachable → mirrored entries are KEPT and marked stale
   * (spec §2.3: degrade to stale-visible, never to blank); local entities are never
   * affected. Both directions rebroadcast so clients see the flag change — the
   * sessions module owns the flag; the conversation/issue mirrors follow here.
   */
  setUpstreamStale(stale: boolean): void {
    if (!this.sessionsSvc.setUpstreamStale(stale)) return
    this.conversations.rebroadcastUpstream()
    this.upstreamIssuesSvc.rebroadcastUpstream()
  }

  // ---- upstream issue mirror + write forwarding — delegates to modules/issues ----

  setUpstreamForwarder(forwarder: IssueUpstreamForwarder): void {
    this.upstreamIssuesSvc.setForwarder(forwarder)
  }

  /** True when `id` is a hub-mirrored issue — the router's forwarding-detection key. */
  isUpstreamIssue(id: string): boolean {
    return this.upstreamIssuesSvc.isUpstreamIssue(id)
  }

  /** repoPaths that exist among hub issues (modules/issues). */
  upstreamIssueRepoPaths(): Set<string> {
    return this.upstreamIssuesSvc.repoPaths()
  }

  /** Replace the mirrored issue list with the hub's truth (modules/issues). */
  setUpstreamIssues(list: IssueWire[]): void {
    this.upstreamIssuesSvc.setUpstreamIssues(list)
  }

  /** Local ∪ upstream issues — the single union seam every issue wire path uses. */
  private withUpstreamIssues(local: IssueWire[]): IssueWire[] {
    return this.upstreamIssuesSvc.withUpstreamIssues(local)
  }

  /** Forward one issue mutation to the hub (modules/issues). */
  forwardIssueMutation(proc: string, input: Record<string, unknown>): Promise<unknown> {
    return this.upstreamIssuesSvc.forwardIssueMutation(proc, input)
  }

  /** A queued forwarded mutation was definitively rejected by the hub (issue #25). */
  upstreamMutationRejected(proc: string, input: Record<string, unknown>, message: string): void {
    this.upstreamIssuesSvc.mutationRejected(proc, input, message)
  }

  /** Outbox contents changed — recompute pendingSync overlays and re-publish. */
  upstreamOutboxChanged(): void {
    this.upstreamIssuesSvc.outboxChanged()
  }

  /**
   * Mint a long-lived client-session token for a NODE to sync against this server
   * as its hub (spec §2.1 provisioning). The token rides as the `podium_session`
   * cookie on the node's /client WS upgrade and /trpc calls — a normal, revocable
   * client_sessions row (delete it to cut the node off). Printed once; only the
   * sha-256 is stored.
   */
  mintUpstreamToken(): string {
    return mintUpstreamTokenInto(this.store, this.now())
  }

  // ---- machine routing/selection — delegates to modules/machines ----

  /** Display name for a machineId (cached; modules/machines). */
  machineName(id: string): string {
    return this.machines.machineName(id)
  }

  /** machineIds with a live daemon socket right now. Public for RepoRegistry fan-out. */
  onlineMachineIds(): string[] {
    return this.machines.onlineMachineIds()
  }

  /** Guard an explicit machine pin BEFORE any work is routed to it (modules/machines). */
  requireMachineForRepo(machineId: string, repoPath: string): void {
    this.machines.requireMachineForRepo(machineId, repoPath)
  }

  /** Pick the best online machine for a repo (modules/machines). */
  pickMachineForRepo(originUrl: string | undefined, cwd: string): string {
    return this.machines.pickMachineForRepo(originUrl, cwd)
  }

  listPins() {
    return this.store.listPins()
  }

  setPin(kind: PinKind, id: string, pinned: boolean) {
    this.store.setPin(kind, id, pinned)
  }

  listSnoozes() {
    return this.store.listSnoozes()
  }

  setSnooze(input: { sessionId: string; until: string | null }): void {
    this.sessionsSvc.setSnooze(input)
  }

  clearSnooze(sessionId: string): void {
    this.sessionsSvc.clearSnooze(sessionId)
  }

  listTabOrders() {
    return this.store.listTabOrders()
  }

  setTabOrder(worktree: string, sessionIds: string[]) {
    this.store.setTabOrder(worktree, sessionIds)
  }

  // ---- settings / model catalog / telegram setup — delegates to modules/settings ----

  getModelCatalog(): ModelCatalogSnapshot {
    return this.settingsService.getModelCatalog()
  }

  refreshModelCatalog(): Promise<ModelCatalogSnapshot> {
    return this.settingsService.refreshModelCatalog()
  }

  getSettings(): PodiumSettings {
    return this.settingsService.getSettings()
  }

  setSettings(settings: PodiumSettings): PodiumSettings {
    return this.settingsService.setSettings(settings)
  }

  startTelegramSetup(): Promise<TelegramSetupStartResult> {
    return this.settingsService.startTelegramSetup()
  }

  pollTelegramSetup(setupId: string): Promise<TelegramSetupPollResult> {
    return this.settingsService.pollTelegramSetup(setupId)
  }

  // ---- session lifecycle + command paths — delegates to modules/sessions ----

  createSession(input: {
    agentKind?: AgentKind
    cwd: string
    title?: string
    machineId?: string
    initialPrompt?: string
    model?: string
    effort?: string
    spawnedBy?: string
    issueId?: string
    sessionId?: string
  }): { sessionId: string } {
    return this.sessionsSvc.createSession(input)
  }

  /** The capability a relayed agent session presents (modules/sessions). */
  capabilityForSession(sessionId: string): Capability {
    return this.sessionsSvc.capabilityForSession(sessionId)
  }

  resumeSession(input: {
    agentKind: AgentKind
    cwd: string
    resume: ResumeRef
    conversationId: string
    title?: string
    machineId?: string
    spawnedBy?: string
  }): { sessionId: string } {
    return this.sessionsSvc.resumeSession(input)
  }

  continueSession(input: { sessionId: string }): { ok: boolean } {
    return this.sessionsSvc.continueSession(input)
  }

  sendText(input: { sessionId: string; text: string }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    return this.sessionsSvc.sendText(input)
  }

  answerAskUserQuestion(input: { sessionId: string; choices: { optionIndices: number[] }[] }): {
    ok: boolean
  } {
    return this.sessionsSvc.answerAskUserQuestion(input)
  }

  setSessionDraft(input: { sessionId: string; text: string }, fromClientId?: string): void {
    this.sessionsSvc.setSessionDraft(input, fromClientId)
  }

  queueText(input: { sessionId: string; text: string; mutationId?: string }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    return this.sessionsSvc.queueText(input)
  }

  /** Idempotency wrapper (docs/spec/outbox-write-path.md §2.1) — modules/sessions. */
  withMutation<T>(mutationId: string | undefined, proc: string, fn: () => T): T {
    return this.sessionsSvc.withMutation(mutationId, proc, fn)
  }

  /** Set (or clear with '') the user-facing session name. */
  renameSession(input: { sessionId: string; name: string }): void {
    this.sessionsSvc.renameSession(input)
  }

  setArchived(input: { sessionId: string; archived: boolean }): void {
    this.sessionsSvc.setArchived(input)
  }

  /** Mark a session read (issue #124) — modules/sessions. */
  markSessionRead(sessionId: string): void {
    this.sessionsSvc.markSessionRead(sessionId)
  }

  /** Set (or clear with null) a session's explicit issue attachment. */
  setSessionIssueId(sessionId: string, issueId: string | null): void {
    this.sessionsSvc.setSessionIssueId(sessionId, issueId)
  }

  /** The session's explicit issue attachment (issue-as-workspace), if any. */
  getSessionIssueId(sessionId: string): string | null {
    return this.sessionsSvc.getSessionIssueId(sessionId)
  }

  setWorkState(input: { sessionId: string; workState: WorkState | null }): void {
    this.sessionsSvc.setWorkState(input)
  }

  hibernateSession(input: { sessionId: string }): { ok: boolean; reason?: string } {
    return this.sessionsSvc.hibernateSession(input)
  }

  resumeAndSend(input: { sessionId: string; text: string; mutationId?: string }): {
    ok: boolean
    reason?: string
  } {
    return this.sessionsSvc.resumeAndSend(input)
  }

  /** Wake a hibernated session: respawn under the same id with its resume ref. */
  resurrectSession(input: { sessionId: string }): { ok: boolean; reason?: string } {
    return this.sessionsSvc.resurrectSession(input)
  }

  killSession(input: { sessionId: string }): void {
    this.sessionsSvc.killSession(input)
  }

  /** The default machine for host-scoped requests (modules/machines) — used by
   *  RepoRegistry when no machineId is provided. */
  defaultMachineId(): string {
    return this.machines.defaultMachine()
  }

  // ---- daemon round-trips — delegates to modules/machines/rpc ----

  scan(): Promise<ScanResult> {
    return this.rpc.scan()
  }

  scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<ScanReposResult> {
    return this.rpc.scanRepos(roots, opts)
  }

  /** Per-machine variant of scanRepos — RepoRegistry fans out to each online daemon. */
  scanReposForMachine(
    roots: string[],
    machineId: string,
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<ScanReposResult> {
    return this.rpc.scanRepos(roots, opts, machineId)
  }

  /** Token-usage buckets from the daemon's transcript harvest (empty on timeout). */
  usage(sinceMs?: number): Promise<{ hostname: string; buckets: UsageBucketWire[] }> {
    return this.rpc.usage(sinceMs)
  }

  /** Per-agent plan-quota on one daemon host (modules/machines/rpc). */
  agentQuota(
    refresh?: boolean,
    machineId?: string,
  ): Promise<{ hostname: string; agents: AgentQuotaWire[] }> {
    return this.rpc.agentQuota(refresh, machineId)
  }

  /** Per-agent plan-quota fanned out to every online daemon (modules/machines/rpc). */
  agentQuotaAll(refresh?: boolean): Promise<MachineQuotaWire[]> {
    return this.rpc.agentQuotaAll(refresh)
  }

  /** Allowlisted git op on a dev machine (superagent tools). */
  repoOp(
    op: RepoOp,
    cwd: string,
    args?: Record<string, string>,
    machineId?: string,
  ): Promise<OpResult> {
    return this.rpc.repoOp(op, cwd, args, machineId)
  }

  /** One-shot `claude -p` / `codex exec` / `grok -p` on a dev machine. */
  harnessExec(input: {
    agent: 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'
    model?: string
    prompt: string
    cwd?: string
    systemPrompt?: string
    mcpConfig?: string
    allowedTools?: string[]
    timeoutMs?: number
  }): Promise<OpResult> {
    return this.rpc.harnessExec(input)
  }

  // ---- Headless harness sessions — delegates to modules/superagent/headless ----

  createHeadlessSession(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    spawnedBy?: string
    machineId?: string
  }): { sessionId: string } {
    return this.headless.createHeadlessSession(input)
  }

  setHeadlessResume(sessionId: string, resume: ResumeRef): void {
    this.headless.setHeadlessResume(sessionId, resume)
  }

  broadcastHeadlessActivity(sessionId: string, event: HeadlessActivityEvent): void {
    this.headless.broadcastHeadlessActivity(sessionId, event)
  }

  headlessTurn(
    input: {
      sessionId: string
      threadId: string
      agent: HarnessAgent
      model?: string
      effort?: string
      cwd: string
      prompt: string
      systemPrompt?: string
      mcpConfig?: string
      allowedTools?: string[]
      permissionMode?: string
      resumeValue?: string
      sessionUuid?: string
      timeoutMs?: number
    },
    onEvent?: (event: HeadlessTurnEvent) => void,
  ): Promise<{ ok: boolean; error?: string; harnessSessionId?: string; output?: string }> {
    return this.headless.headlessTurn(input, onEvent)
  }

  headlessInterrupt(sessionId: string): void {
    this.headless.headlessInterrupt(sessionId)
  }

  headlessBind(input: {
    sessionId: string
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ ok: boolean; error?: string }> {
    return this.headless.headlessBind(input)
  }

  /** Route an image upload to the owning daemon (modules/machines/rpc). */
  uploadImage(input: {
    sessionId: string
    filename: string
    mimeType: string
    dataBase64: string
  }): Promise<{ path: string; error?: string }> {
    return this.rpc.uploadImage(input)
  }

  /** Ask a daemon who owns the used memory (modules/hosts). */
  memoryBreakdown(roots: string[], machineId?: string): Promise<MemoryBreakdown | undefined> {
    return this.hosts.memoryBreakdown(roots, machineId)
  }

  // ---- ws data planes — delegates to modules/sessions ----

  attachClient(send: Send<ServerMessage>): string {
    return this.sessionsSvc.attachClient(send)
  }

  detachClient(id: string): void {
    this.sessionsSvc.detachClient(id)
  }

  onClientMessage(id: string, msg: ClientMessage): void {
    this.sessionsSvc.onClientMessage(id, msg)
  }

  /** Inbound daemon message, tagged with the machine it came from (modules/sessions). */
  onDaemonMessageFrom(machineId: string, msg: DaemonMessage): void {
    this.sessionsSvc.onDaemonMessageFrom(machineId, msg)
  }

  searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return this.conversations.searchConversations(opts)
  }

  transcriptFor(sessionId: string): TranscriptItem[] {
    return this.sessionsSvc.transcriptFor(sessionId)
  }

  /** Transcript window for the chat view — daemon-first, lake fallback
   *  (modules/machines/rpc). */
  readTranscript(input: {
    sessionId: string
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<{ items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }> {
    return this.rpc.readTranscript(input)
  }

  listDir(input: {
    machineId?: string
    root: string
    path?: string
  }): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>> {
    return this.rpc.listDir(input)
  }

  readFile(
    input: { sessionId: string; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    return this.rpc.readFile(input)
  }

  readAsset(
    input: { sessionId: string; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>> {
    return this.rpc.readAsset(input)
  }

  writeFile(
    input:
      | { sessionId: string; path: string; content: string; baseHash?: string }
      | { machineId?: string; root: string; path: string; content: string; baseHash?: string },
  ): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    return this.rpc.writeFile(input)
  }

  setConversationMeta(input: { id: string; name?: string; summary?: string }): void {
    this.conversations.setConversationMeta(input)
  }

  /** Projection of a Session to the fields an attention notice needs. */
  private static noticeInfo(session: Session): SessionNoticeInfo {
    return {
      sessionId: session.sessionId,
      ...(session.name ? { name: session.name } : {}),
      ...(session.title ? { title: session.title } : {}),
      cwd: session.cwd,
      agentKind: session.agentKind,
    }
  }

  // ---- machine admin + daemon pairing/auth — delegates to modules/machines ----

  /** Issue a short-lived, single-use pairing code for a new daemon (UI shows it). */
  mintPairingCode(): string {
    return this.machines.mintPairingCode()
  }

  /** Authenticate a daemon's handshake frame (modules/machines). */
  authenticateDaemon(
    frame: DaemonHandshake,
  ): { ok: true; machineId: string; name: string; token?: string } | { ok: false; reason: string } {
    return this.machines.authenticateDaemon(frame)
  }

  /** All known machines with live online status (a daemon socket is attached). */
  listMachines(): MachineWire[] {
    return this.machines.listMachines()
  }

  renameMachine(id: string, name: string): void {
    this.machines.renameMachine(id, name)
  }

  revokeMachine(id: string): void {
    this.machines.revokeMachine(id)
  }

  /** Provision the local machine at SERVER STARTUP (modules/machines). */
  ensureLocalMachine(hostname?: string, secret?: string): string {
    return this.machines.ensureLocalMachine(hostname, secret)
  }

  // ---- broadcast pipeline — delegates to modules/sessions ----

  private broadcastSessions(): void {
    this.sessionsSvc.broadcastSessions()
  }

  /** Run any coalesced (pending) session broadcast NOW. Test seam + dispose. */
  flushBroadcasts(): void {
    this.sessionsSvc.flushBroadcasts()
  }

  /** Safe issue-list build — delegates to modules/issues/publish. */
  private safeIssuesList(): IssueWire[] {
    return this.issuePublisher.safeIssuesList()
  }

  /** Full issue-list fan-out (modules/issues/publish). */
  private publishIssues(localIssues: IssueWire[]): void {
    this.issuePublisher.publishIssues(localIssues)
  }

  /** Single-issue fan-out, issue #22 (modules/issues/publish). */
  private publishIssueUpdate(issue: IssueWire): void {
    this.issuePublisher.publishIssueUpdate(issue)
  }

  /** Cursor catch-up for `sync.changesSince` (spec §2.3) — modules/sessions. */
  syncChangesSince(cursor: number | null): SyncChangesSinceResult {
    return this.sessionsSvc.syncChangesSince(cursor)
  }
}
