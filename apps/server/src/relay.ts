import { randomBytes } from 'node:crypto'
import type { AgentKind, ConversationSummaryWire, IssueWire, SessionMeta } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { checkIssueAccess } from './issue-authz'
import { LOCAL_PLACEHOLDER } from './local-machine'
import type { ModelProbe } from './model-catalog'
import { ApprovalService } from './modules/approvals/service'
import { EventBus } from './modules/bus'
import { ConversationsService } from './modules/conversations/service'
import { EventLogRetention } from './modules/events/retention'
import { WriteFunnel } from './modules/funnel'
import { HostsService, type MemoryBreakdown } from './modules/hosts/service'
import { IssueSessionLifecycle } from './modules/issue-session-lifecycle'
import { IssueAutoArchive } from './modules/issues/auto-archive'
import { IssuePublisher } from './modules/issues/publish'
import { IssueCommandDispatcher } from './modules/issues/registry'
import { IssueRelayGate } from './modules/issues/relay-gate'
import { IssueService } from './modules/issues/service'
import { UpstreamIssuesService } from './modules/issues/upstream'
import { LockCommandDispatcher } from './modules/lock/registry'
import { LockService } from './modules/lock/service'
import { DaemonRpcService } from './modules/machines/rpc'
import { MachinesService, type PairingCodes, sha256 } from './modules/machines/service'
import { MessageGate } from './modules/messages/gate'
import { MessageDeliveryService, senderFromCapability } from './modules/messages/service'
import { makeSpawnOnWake } from './modules/messages/spawn'
import {
  DEFAULT_NOTIFICATION_PUSHERS,
  type NotificationPushers,
  NotifyService,
  type SessionNoticeInfo,
} from './modules/notify/service'
import { SessionReadToolkit } from './modules/sessions/read-toolkit'
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
  issueSessionLifecycle: IssueSessionLifecycle
  headless: HeadlessService
  notify: NotifyService
  issues: IssueService
  upstreamIssues: UpstreamIssuesService
  issuePublisher: IssuePublisher
  issueCommands: IssueCommandDispatcher
  specs: SpecsService
  approvals: ApprovalService
  /** Advisory named lease locks [spec:SP-85d1]. */
  locks: LockService
  lockCommands: LockCommandDispatcher
  /** Unified agent messaging (#237) [spec:SP-34d7]. */
  messages: MessageDeliveryService
  /** `podium mail` command surface over the substrate (#237) [spec:SP-34d7]. */
  messageGate: MessageGate
  /** Read toolkit tiers 1–2 — session status/read (#237) [spec:SP-34d7]. */
  readToolkit: SessionReadToolkit
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
  /** Message delivery slow sweep (#237) [spec:SP-34d7]. */
  private readonly messageSweep: ReturnType<typeof setInterval>
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
    // Unified messaging (#237) [spec:SP-34d7] — assigned after the store-backed
    // graph exists; consumed only via lazy closures/per-dispatch calls below.
    let messagesSvc!: MessageDeliveryService
    let messageGate!: MessageGate
    let readToolkit!: SessionReadToolkit
    let conversations!: ConversationsService
    let issues!: IssueService
    let issueSessionLifecycle!: IssueSessionLifecycle
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
      deleteIssue: (id) => issueSessionLifecycle.deleteIssue(id),
      restoreIssue: (id) => issueSessionLifecycle.restoreIssue(id),
      isUpstreamIssue: (id) => upstreamIssues.isUpstreamIssue(id),
      forwardIssueMutation: (proc, input) => upstreamIssues.forwardIssueMutation(proc, input),
      upstreamIssueRepoPaths: () => upstreamIssues.repoPaths(),
      withMutation: (mutationId, proc, fn) => sessionsSvc.withMutation(mutationId, proc, fn),
      listSessions: () => sessionsSvc.listSessions(),
      repoPaths: () => this.store.repos.listRepoPaths(),
      inferRepoFromPath: (path) => inferRepoFromRoots(this.store.repos.listRepoPaths(), path),
      // mailSend rides the unified substrate (#237) [spec:SP-34d7].
      sendMessage: (from, input) => messagesSvc.send(from, input),
    })
    const specs = new SpecsService({
      repoRoots: () => this.store.repos.listRepoPaths(),
    })
    // Approval broker [spec:SP-edbb] (#410): agent-requested management ops.
    const approvals = new ApprovalService({
      store: this.store.approvals,
      now: () => new Date().toISOString(),
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      clients: () => clients().values(),
      sessionIssueId: (sessionId) => {
        const s = sessionsSvc.listSessions().find((x) => x.sessionId === sessionId)
        return s ? (s.issueId ?? issues.issueForCwd(s.cwd)) : null
      },
      issueInfo: (issueId) => {
        const w = issues.get(issueId)
        return w ? { seq: w.seq, title: w.title } : null
      },
      machineName: (machineId) => machines.listMachines().find((m) => m.id === machineId)?.name,
      notifyIssue: (issueId, body) => void issues.sendMail(issueId, 'approval-broker', body),
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
    // Advisory named lease locks [spec:SP-85d1]. Lazy closures: sessionsSvc and
    // issues are assigned below and only ever consulted per-operation.
    const locks = new LockService({
      locks: this.store.locks,
      transact: (fn) => this.store.transact(fn),
      funnel,
      now: () => this.now(),
      resolveRepoId: (repoPath) => this.store.repos.resolveRepoIdForPath(repoPath),
      sessionAlive: (sessionId) => {
        const s = liveSessions().get(sessionId)
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
      locks: () => locks,
      issues: () => issues,
    })
    const issueRelayGate = new IssueRelayGate({
      // issues/repos ops run through the registry dispatcher (guard + schema +
      // handler, router-equal); the specs router (pspec, #135) is served by the
      // specs module — same schemas + repo-root gate as the tRPC slice; the
      // sessions slice exposes ONLY real-turn delivery (sendText/resumeAndSend/
      // continue — never spawn/kill/archive or raw PTY input), scope-gated
      // against the TARGET session's issue exactly like an issue write
      // (RELAY_ALLOWED lists all four routers).
      dispatch: (capability, overrideScope, router, proc, input) => {
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
                  { capability, ...(overrideScope ? { overrideScope: true } : {}) },
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
          if (proc !== 'sendText' && proc !== 'resumeAndSend' && proc !== 'continue') {
            return undefined
          }
          return (async () => {
            const raw = input
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
              throw new Error('invalid session command input')
            }
            const args = raw as { sessionId?: unknown; text?: unknown; mutationId?: unknown }
            if (typeof args.sessionId !== 'string' || !args.sessionId) {
              throw new Error('sessionId is required')
            }
            if (proc !== 'continue') {
              if (
                typeof args.text !== 'string' ||
                args.text.length === 0 ||
                args.text.length > 32_768
              ) {
                throw new Error('text must contain 1..32768 characters')
              }
            }
            if (
              args.mutationId !== undefined &&
              (typeof args.mutationId !== 'string' || args.mutationId.length > 128)
            ) {
              throw new Error('mutationId must be at most 128 characters')
            }
            const target = sessionsSvc
              .listSessions()
              .find((session) => session.sessionId === args.sessionId)
            if (!target) throw new Error('session not found')
            const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
            if (targetIssueId) {
              checkIssueAccess(
                { capability, ...(overrideScope ? { overrideScope: true } : {}) },
                issues,
                `sessions.${proc}`,
                'write',
                targetIssueId,
              )
            } else {
              // Issueless target (#237) [spec:SP-34d7 authz]: no issue to gate
              // on used to mean NO gate at all. Only the operator (unscoped
              // capability) or the target's own parent (spawnedBy provenance)
              // may message an issueless session — --outside-scope confirms
              // scope-crossing on ISSUE targets and never substitutes here.
              const isOperator = capability.scope.kind === 'all'
              const isParent =
                capability.actorSessionId !== undefined &&
                target.spawnedBy === `session:${capability.actorSessionId}`
              if (!isOperator && !isParent) {
                throw new Error(
                  'target session has no issue; only its parent or the operator may message it',
                )
              }
            }
            if (proc === 'continue') {
              return sessionsSvc.continueSession({ sessionId: args.sessionId })
            }
            const commandInput = {
              sessionId: args.sessionId,
              text: args.text as string,
              ...(typeof args.mutationId === 'string' ? { mutationId: args.mutationId } : {}),
            }
            // Unified substrate (#237) [spec:SP-34d7]: relay session sends are
            // messages — sender stamped from the capability, envelope rendered
            // at delivery (operator stays unwrapped), row + ledger durable.
            // sendText → next-turn/wait, resumeAndSend → next-turn/wake.
            return sessionsSvc.withMutation(commandInput.mutationId, `sessions.${proc}`, () => {
              const { ok, queued, reason } = messagesSvc.send(senderFromCapability(capability), {
                to: { kind: 'session', id: commandInput.sessionId },
                body: commandInput.text,
                urgency: 'next-turn',
                lifecycle: proc === 'resumeAndSend' ? 'wake' : 'wait',
              })
              return {
                ok,
                ...(queued !== undefined ? { queued } : {}),
                ...(reason !== undefined ? { reason } : {}),
              }
            })
          })()
        }
        if (router === 'approvals') {
          if (proc === 'request') return Promise.resolve(approvals.request(input))
          if (proc === 'get') return Promise.resolve(approvals.getFromAgent(input))
          return undefined
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
      onApprovalExecResult: (msg) => approvals.onExecResult(msg),
      approvalsPending: () => approvals.listPending(),
    })
    // Session-bound lock auto-release [spec:SP-85d1]: a finished/exited session
    // releases its held locks and leaves every wait queue (the queue advances
    // with a grant-notification mail). Best-effort — the lazy expiry sweep is
    // the backstop if this listener ever misses a death.
    this.bus.on('session.exited', ({ sessionId }) => locks.releaseForSession(sessionId))
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
    // Unified messaging (#237) [spec:SP-34d7]: the one send path. Sender is
    // stamped by each surface from its authenticated caller; issue-addressed
    // sends dual-write the legacy issue_messages mirror so inbox/claim/pending
    // keep working until those readers migrate.
    messagesSvc = new MessageDeliveryService({
      messages: this.store.messages,
      events: this.store.events,
      issues: () => issues,
      sessions: () => sessionsSvc,
      mirrorIssueMail: (row) => funnel.run({ write: () => this.store.issues.addIssueMessage(row) }),
      mirrorMarkIssueMailRead: (issueId, ids) =>
        funnel.run({
          write: () =>
            this.store.issues.markIssueMessagesRead(issueId, ids, new Date().toISOString()),
        }),
      transact: (fn) => this.store.transact(fn),
      // Spawn-on-wake (#237) [spec:SP-34d7 decision 4]: an unresumable wake
      // spawns a fresh agent on the target issue through the SAME machinery
      // issue_start rides (createSession); the service then queues the message
      // as the child's first prompt. Authz (gate.send write check) → spawn
      // budget → cooldown all bite before this seam is reached.
      spawnOnWake: makeSpawnOnWake({
        issues: () => issues,
        createSession: (o) => sessionsSvc.createSession(o),
      }),
      now: () => new Date(this.now()).toISOString(),
    })
    messageGate = new MessageGate({
      messages: () => messagesSvc,
      issues: () => issues,
      listSessions: () => sessionsSvc.listSessions(),
      // Cross-harness subagent spawn (#237) [spec:SP-34d7 cross-harness]: the
      // child is a FULL Podium session through the one spawn path; --new is the
      // deliberate issue-create path (never automatic).
      spawnSession: (o) =>
        sessionsSvc.createSession({
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.effort !== undefined ? { effort: o.effort } : {}),
          ...(o.issueId ? { issueId: o.issueId } : {}),
          ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
          ...(o.machineId ? { machineId: o.machineId } : {}),
          ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
          ...(o.workflowStepId ? { workflowStepId: o.workflowStepId } : {}),
          ...(o.executionProfileId ? { executionProfileId: o.executionProfileId } : {}),
        }),
      createIssue: (o) => issues.create({ ...o, startNow: false }),
      appendEvent: (e) => this.store.events.appendEvent(e),
      now: () => new Date(this.now()).toISOString(),
    })
    readToolkit = new SessionReadToolkit({
      listSessions: () => sessionsSvc.listSessions(),
      issues: () => issues,
      messages: () => messagesSvc,
      events: this.store.events,
      // Tier-3 recap watermarks persist per (reader, target) [spec:SP-34d7].
      watermarks: this.store.readWatermarks,
      repoOp: async (op, cwd, machineId) => rpc.repoOp(op, cwd, undefined, machineId),
      readTranscript: (input) => rpc.readTranscript(input),
      now: () => new Date(this.now()).toISOString(),
    })

    issueSessionLifecycle = new IssueSessionLifecycle({
      issues,
      sessions: sessionsSvc,
      ledger,
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
      // Deterministic ack fallback (#237) [spec:SP-34d7 acks]: stitch issue
      // stage + last commit (best-effort daemon git) into the system notice.
      messaging: {
        ackFallback: (sessionId, outcome) =>
          void (async () => {
            if (messagesSvc.deliveredUnacked(sessionId).length === 0) return
            const meta = sessionsSvc.listSessions().find((s) => s.sessionId === sessionId)
            const issueId = meta ? (meta.issueId ?? issues.issueForCwd(meta.cwd)) : null
            const issue = issueId ? issues.get(issueId) : null
            let lastCommit: string | undefined
            if (meta) {
              try {
                const r = await rpc.repoOp('log', meta.cwd, undefined, meta.machineId)
                if (r.ok) lastCommit = r.output.split('\n')[0]
              } catch {}
            }
            messagesSvc.systemAckFallback(sessionId, {
              outcome,
              ...(issue ? { issueSeq: issue.seq, issueStage: issue.stage } : {}),
              ...(lastCommit ? { lastCommit } : {}),
              // #285 pass-through: a worker that settles without reporting its
              // assigned workflow step gets that flagged in the settle notice.
              ...(meta?.workflowStepId ? { workflowStepId: meta.workflowStepId } : {}),
            })
          })().catch(() => {}),
      },
    })
    this.steward.start()
    // Message delivery retriggers (#237) [spec:SP-34d7]: a turn ending (phase →
    // idle) drains that session's queued messages (and clears its hop context);
    // the slow sweep expires + retries whatever the event triggers missed.
    this.bus.on('session.stateChanged', ({ sessionId, prev, next }) => {
      if (next.phase !== 'idle' || prev?.phase === 'idle') return
      const meta = sessionsSvc.listSessions().find((s) => s.sessionId === sessionId)
      if (meta) messagesSvc.onSessionIdle(meta)
    })
    this.messageSweep = setInterval(() => messagesSvc.sweep(), 60_000)
    this.messageSweep.unref?.()
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
      issueSessionLifecycle,
      upstreamIssues,
      issuePublisher: publisher,
      issueCommands,
      specs,
      approvals,
      locks,
      lockCommands,
      messages: messagesSvc,
      messageGate,
      readToolkit,
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
    clearInterval(this.messageSweep)
    this.issueAutoArchive.dispose()
    // Also drains any coalesced session broadcast + pending delta batch (the
    // durable change log is already complete — commits happen at persist time).
    this.modules.sessions.dispose()
    this.steward.dispose()
  }
}
