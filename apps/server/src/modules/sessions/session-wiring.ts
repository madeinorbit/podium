/**
 * SESSION LIFECYCLE WIRING (POD-1396).
 *
 * Constructor body, moved verbatim — ORDER UNCHANGED.
 *
 * This function is an ENROLLED composition site in
 * scripts/server-construction-order.ts (POD-1411). Because the write surface is
 * an any-cast, TypeScript's definite-assignment analysis does NOT cover this
 * body; that audit is what checks its order instead. It fails when a value read
 * eagerly here — a direct `bag.x` argument — is assigned further down. Reads
 * inside a closure are deferred and stay legal.
 *
 * Private fields written through a single any-cast. Dispose: none here
 * (activityFlushTimer stays a field initializer on SessionLifecycle).
 */

import { asUserId, computePriorities, type SessionId } from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import { MutationLedger, type SyncRepository } from '@podium/sync'
import { AutoContinueController } from '../../auto-continue'
import { userCommandPrincipal } from '../../command-principal'
import { isFeatureEnabled } from '../../features'
import { BrowserOpenGateway } from '../../gateway/browser-open'
import { ClientRegistry } from '../../gateway/client-registry'
import {
  harnessDisplayName,
  harnessInterrupt,
  harnessNeedsSubmitVerification,
  harnessUsesRawFirstTurn,
} from '../../harness-manifest'
import { selectMailNudgeSession } from '../../issue-util'
import { HeadlessService } from '../superagent/headless'
import { SessionClientControl } from './client-control'
import { machinesForPrincipal as projectMachinesForPrincipal } from './command-ctx'
import { AgentConcurrencyHistory } from './concurrency-history'
import { SessionDaemonLifecycle } from './daemon-lifecycle'
import { SessionDaemonProjection } from './daemon-projection'
import {
  inboxActorColumns,
  inboxActorFromColumns,
  SessionInbox,
  SYSTEM_INBOX_PRINCIPAL,
} from './inbox'
import { SessionLaunchConfig } from './launch-config'
import type { SessionLifecycle, SessionLifecycleDeps } from './lifecycle'
import type { Session } from './session'

type QueuedMessageRow = ReturnType<SyncRepository['listQueuedMessages']>[number]

import { SessionMachineReconciler } from './machine-reconciler'
import { SessionNaming } from './naming'
import { SessionBroadcastCoordinator } from './publication/broadcast'
import { SessionRepository } from './repository'
import { ReceiptSender } from './receipt-send'
import { SessionRuntimeGateway } from './runtime-gateway'
import type { RuntimeDurableQueuePort } from './runtime-gateway'
import { SessionAuthz } from './session-authz'
import { SessionBindingReceipts } from './session-binding'
import { SessionClientPlane } from './session-client-plane'
import { SessionKill } from './session-kill'
import { SessionMetaOps } from './session-meta-ops'
import { SessionRevival } from './session-revival'
import { APPLIED_MUTATIONS_MAX_AGE_MS, DEFAULT_GEOMETRY } from './session-shared'
import { SessionStart } from './session-start'
import { sessionStatePrincipalFor } from './session-state/registry'
import { SessionStateService } from './session-state/service'
import { SessionTeardown } from './session-teardown'
import { SessionTerminalProof } from './terminal-proof'
import { SessionView } from './view'
import { SessionWorkspace } from './workspace'

export function wireSessionLifecycle(life: SessionLifecycle, deps: SessionLifecycleDeps): void {
  // Private-field write surface for this composition function only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bag = life as any

  bag.store = deps.store
  bag.sessions = deps.sessions ?? new Map()
  bag.now = deps.now
  bag.mutations = deps.mutations ?? new MutationLedger(bag.store.sync, () => bag.now())
  bag.clients = deps.clients ?? new ClientRegistry()
  bag.bus = deps.bus
  bag.machines = deps.machines
  bag.rpc = deps.rpc
  bag.activityFlushTimer.unref?.()
  bag.funnel = deps.funnel
  bag.concurrencyHistory = new AgentConcurrencyHistory({
    sessions: () => bag.sessions.values(),
    events: bag.store.events,
    bus: bag.bus,
    now: () => bag.now(),
  })
  bag.terminalProof = new SessionTerminalProof({
    now: () => bag.now(),
    leases: bag.observationLeases,
    checkpoints: bag.store.observationCheckpoints,
    sessions: () => bag.sessions.values(),
    session: (sessionId) => bag.sessions.get(sessionId),
    pendingForProof: (sessionId, atIso) =>
      bag.store.messages.pendingForSessionProof(sessionId, atIso),
    isDraining: (sessionId) => bag.inbox.isDraining(sessionId),
    autoContinueActive: (sessionId) => bag.autoContinue.isActive(sessionId),
  })
  bag.launchConfig = new SessionLaunchConfig({
    store: bag.store,
    settingsViewer: () => bag.settingsViewer(),
  })
  bag.naming = new SessionNaming({
    session: (sessionId) => bag.sessions.get(sessionId),
    mutate: (sessionId, write) => bag.mutateSessionMeta(sessionId, write),
  })
  bag.machineReconciler = new SessionMachineReconciler({
    sessions: () => bag.sessions.values(),
    drainInbox: (sessionId) => bag.inbox.drain(sessionId),
    triggerLakeSweep: (machineId) => bag.deps.memory.triggerLakeSweep(machineId),
    resetPriorities: () => bag.state.resetPriorities(),
    pushPriorities: () => bag.pushPriorities(),
    parkArchivedSession: (sessionId) => bag.parkArchivedSession(sessionId),
    reattachMessage: (session, machineId) => bag.reattachMessageFor(session, machineId),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    viewTiers: (sessionIds) => computePriorities([...bag.clients.values()], sessionIds),
    rebindHeadless: (session) => bag.rebindHeadless(session),
    markVolatileSessionDirty: (sessionId, fields) =>
      bag.repository.markVolatileSessionDirty(sessionId, fields),
    persist: (session) => bag.repository.persist(session),
    broadcastSessions: () => bag.broadcastSessions(),
  })
  // Emergency rollback for the bridge rollout; sampled once at composition.
  const unslicedVolatile = process.env.PODIUM_UNSLICED_VOLATILE === '1'
  bag.broadcasts = new SessionBroadcastCoordinator({
    hasPendingVolatile: () => bag.repository.hasPendingVolatile(),
    scheduleVolatileCapture: () => bag.repository.scheduleVolatileSessionCapture(),
    drainVolatileSlice: () => {
      if (unslicedVolatile) {
        bag.repository.flushVolatileSessionCaptures()
        return { remaining: 0 }
      }
      const result = bag.repository.drainVolatileCaptureSlice()
      return { remaining: result.remaining }
    },
    flushVolatileCaptures: () => {
      bag.repository.flushVolatileSessionCaptures()
    },
    flushDeltas: () => bag.funnel.flushDeltas(),
  })
  bag.browserOpen = new BrowserOpenGateway({
    now: () => bag.now(),
    clients: bag.clients,
    subscriptions: bag.deps.subscriptions,
    session: (sessionId) => bag.sessions.get(sessionId),
    sessionOwner: (sessionId) => bag.sessionOwner(sessionId),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
  })
  bag.bindingReceipts = new SessionBindingReceipts({
    memory: bag.deps.memory,
    now: () => bag.now(),
    sessions: () => bag.sessions.values(),
    session: (sessionId) => bag.sessions.get(sessionId),
    sessionOwner: (sessionId) => bag.sessionOwner(sessionId),
    persist: (session) => bag.repository.persist(session),
    broadcastSessions: () => bag.broadcastSessions(),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
  })
  bag.daemonProjection = new SessionDaemonProjection({
    sessions: bag.sessions,
    recordSessionGitActivity: (sessionId, input) =>
      bag.bus.emit('issue.sessionDerived', { kind: 'gitActivity', sessionId, ...input }),
    binding: bag.bindingReceipts,
    persist: (session) => bag.repository.persist(session),
    broadcastSessions: () => bag.broadcastSessions(),
    broadcastToClients: (message) => bag.broadcastToClients(message),
    adoptWorktree: (issueId, message) =>
      bag.bus.emit('issue.sessionDerived', { kind: 'adoptWorktree', issueId, message }),
  })

  bag.workspace = new SessionWorkspace({
    store: bag.store,
    rpc: bag.rpc,
    machines: bag.machines,
    issueAccess: bag.deps.issueAccess,
    getSession: (sessionId) => bag.sessions.get(sessionId),
    settingsViewer: () => bag.settingsViewer(),
    onWorktreesChanged: (repoPath, machineId) => bag.deps.onWorktreesChanged(repoPath, machineId),
  })

  bag.state = new SessionStateService({
    store: bag.store,
    now: () => bag.now(),
    getSession: (sessionId) => bag.sessions.get(sessionId),
    sessionIds: () => bag.sessions.keys(),
    clients: () => bag.clients.values(),
    // One object, so the memo CANNOT be dropped here again [POD-1653] — see
    // the port's own comment for why the two-parameter form was unsafe.
    sessionOwner: ({ sessionId, memo }) => bag.sessionOwner(sessionId, memo),
    primeOwnerMemo: (memo, sessionIds) => bag.primeOwnerMemo(memo, sessionIds),
    persistSession: (sessionId, additionalWrite) => {
      const session = bag.sessions.get(sessionId)
      if (session) bag.repository.persist(session, additionalWrite)
    },
    mutateSession: (sessionId, mutate) => {
      bag.mutateSessionMeta(sessionId, (session: Session) => mutate(session))
    },
    broadcastSessions: () => bag.broadcastSessions(),
    broadcastToClients: (message, options) => bag.broadcastToClients(message, options),
    deliverToClient: (clientId, message) => {
      const client = bag.clients.get(clientId)
      if (client) bag.clients.deliver(client, message)
    },
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    onArchived: (sessionId) => {
      bag.bus.emit('issue.sessionDerived', { kind: 'removedOrArchived', sessionId })
      bag.parkArchivedSession(sessionId)
    },
  })
  bag.view = new SessionView({
    sessions: bag.sessions,
    store: bag.store,
    machines: bag.machines,
    state: bag.state,
    sessionOccupancyCount: bag.deps.sessionOccupancyCount
      ? (sessionId) => bag.deps.sessionOccupancyCount?.(sessionId)
      : undefined,
  })
  bag.repository = new SessionRepository({
    sessions: bag.sessions,
    store: bag.store,
    memory: bag.deps.memory,
    ledger: bag.deps.ledger,
    funnel: bag.funnel,
    view: bag.view,
    state: bag.state,
    observationLeases: bag.observationLeases,
    autoContinue: () => bag.autoContinue,
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    broadcastSessions: () => bag.broadcastSessions(),
    flushBroadcasts: () => bag.broadcasts.flush(),
    runScheduledBroadcast: () => bag.broadcasts.runScheduled(),
    listSessions: () => bag.view.list(),
    now: () => bag.now(),
    appliedMutationMaxAgeMs: APPLIED_MUTATIONS_MAX_AGE_MS,
  })
  // CONSTRUCTED HERE, NOT EARLIER, AND THE POSITION IS LOAD-BEARING.
  // SessionStart takes view, repository and state as direct references, so it
  // must be built after all three exist. The compiler caught this when it was
  // placed with the other POD-1396 modules near the top of the constructor
  // ("Property 'view' is used before being assigned"). That compiler check no
  // longer runs here — the any-cast write surface disabled it — so the
  // construction-order audit now enforces the same rule (POD-1411). Moving this
  // block above `bag.view` fails `bun scripts/server-construction-order.ts`.
  bag.sessionStart = new SessionStart({
    store: bag.store,
    view: bag.view,
    repository: bag.repository,
    state: bag.state,
    launchConfig: bag.launchConfig,
    terminalProof: bag.terminalProof,
    settingsViewer: () => bag.settingsViewer(),
    durableLabelFor: (sessionId) => bag.deps.durableLabelFor(sessionId),
    hasSession: (sessionId) => bag.sessions.has(sessionId),
    registerSession: (session) => {
      bag.sessions.set(session.sessionId, session)
    },
    sessionMachineId: (sessionId) => bag.sessions.get(sessionId)?.machineId,
    defaultMachine: () => bag.machines.defaultMachine(),
    machineName: (machineId) => bag.machines.machineName(machineId),
    nativeAccountIdForMachine: (machineId, agentKind, accountId) =>
      bag.machines.nativeAccountIdForMachine(machineId, agentKind, accountId),
    resolveMachineForAgent: (requested, cwd, agentKind, use) =>
      bag.machines.resolveMachineForAgent(requested, cwd, agentKind, use),
    onSpawnTargetLogin: (input) => bag.deps.onSpawnTargetLogin?.(input),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    broadcastSessions: () => bag.broadcastSessions(),
    soleOwnerForCwd: (cwd) => bag.deps.issueAccess.soleOwnerForCwd(cwd) ?? undefined,
    instructionsForStart: (i) => bag.deps.instructionsForStart(i),
    sessionOwner: (sessionId) => bag.sessionOwner(sessionId),
    setSessionDraft: (i, fromClientId) => bag.setSessionDraft(i, fromClientId),
    emitSessionCreated: (payload) => bag.bus.emit('session.created', payload),
  })
  bag.headless = new HeadlessService({
    durableLabelFor: (sessionId) => bag.deps.durableLabelFor(sessionId),
    getSession: (sessionId) => bag.sessions.get(sessionId),
    registerSession: (session) => bag.sessions.set(session.sessionId, session),
    resolveMachine: (requested, cwd, agentKind) =>
      bag.machines.resolveMachineForAgent(requested, cwd, agentKind),
    defaultMachine: () => bag.machines.defaultMachine(),
    toMachine: (machineId, message) => bag.machines.toMachine(machineId, message),
    nextRequestId: (prefix) => bag.rpc.nextRequestId(prefix),
    defaultGeometry: () => ({ ...DEFAULT_GEOMETRY }),
    persist: (session) => bag.persist(session),
    broadcastSessions: () => bag.broadcastSessions(),
    clients: () => bag.clients.values(),
  })
  bag.inbox = new SessionInbox({
    getSession: (sessionId) => bag.sessions.get(sessionId),
    queue: {
      enqueue: (row) => {
        const actor = inboxActorColumns(row.principal.attribution.actor)
        return bag.store.sync.enqueueMessage({
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
        bag.store.sync.listQueuedMessages(sessionId).map((row: QueuedMessageRow) => ({
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
      bumpAttempts: (id) => bag.store.sync.bumpQueuedAttempts(id),
      resetAttempts: (id) => bag.store.sync.resetQueuedAttempts(id),
      delete: (id) => bag.store.sync.deleteQueuedMessage(id),
    },
    daemon: {
      sendInput: (machineId, message) => bag.toMachine(machineId, message),
    },
    authorization: {
      authorizeAtDrain: (input) => bag.authorizeQueuedInputAtApply(input),
      applied: ({ sourceMessageId, sessionId }) =>
        bag.deps.confirmQueuedMessageApplied?.(sourceMessageId, sessionId),
      injected: ({ sourceMessageId, sessionId }) =>
        bag.deps.noteQueuedMessageInjected?.(sourceMessageId, sessionId),
      rejected: ({ sourceMessageId, reason }) => {
        if (sourceMessageId) bag.deps.rejectQueuedMessage?.(sourceMessageId, reason)
      },
    },
    attention: {
      stateChanged: (input) => bag.bus.emit('session.stateChanged', input),
      answered: ({ ownerUserId, sessionId, attribution }) => {
        bag.store.events.appendEvent({
          ts: new Date(bag.now()).toISOString(),
          kind: 'session.inbox.answered',
          subject: sessionId,
          payload: { sessionId, ownerUserId, attribution },
        })
      },
    },
    now: () => bag.now(),
    persist: (session, options) =>
      bag.repository.persist(
        session,
        options?.cancelTerminalCandidate
          ? () => bag.store.observationCheckpoints.cancelTerminalCandidate(session.sessionId)
          : undefined,
      ),
    broadcast: () => bag.broadcastSessions(),
    needsSubmitVerification: harnessNeedsSubmitVerification,
    usesRawFirstTurn: harnessUsesRawFirstTurn,
    harnessInterrupt,
    harnessName: harnessDisplayName,
    prepareSend: (sessionId, attribution, kind, origin) =>
      bag.prepareInboxSend(sessionId, attribution, kind, origin),
    ownerOf: (sessionId) => bag.sessionOwner(sessionId)?.owner,
    resurrect: (sessionId, principal) => {
      bag.bus.emit('session.wakeRequested', { sessionId, principal })
    },
    // Take-control / hold-control re-auth at every apply (POD-1081).
    authorizeDrive: (principal, sessionId) => bag.authorizeClientDrive(principal, sessionId),
  })
  bag.sendText = (input: any) => bag.inbox.sendText(input)
  bag.interruptText = (input: any) => bag.inbox.interruptText(input)
  bag.interruptTurn = (input: any) => bag.inbox.interruptTurn(input)
  bag.queueText = (input: any) => bag.inbox.queueText(input)
  bag.cancelQueuedMessage = (sessionId: SessionId, sourceMessageId: string) =>
    bag.inbox.cancelQueuedMessage(sessionId, sourceMessageId)
  bag.hasQueuedMessage = (sessionId: SessionId, sourceMessageId: string) =>
    bag.inbox.hasQueuedMessage(sessionId, sourceMessageId)
  bag.resumeAndSend = (input: any) => bag.inbox.resumeAndSend(input)
  bag.answerAskUserQuestion = (input: any) =>
    bag.inbox.answerAskUserQuestion({
      ...input,
      principal: input.principal ?? SYSTEM_INBOX_PRINCIPAL,
    })
  bag.setSessionDraft = (input: any, fromClientId: string) =>
    bag.state.setDraft(input, fromClientId)
  bag.draftRevision = (sessionId: SessionId) => bag.state.draftRevision(sessionId)
  bag.draftInjectionActive = () => bag.state.draftSyncEnabled()
  bag.clientControl = new SessionClientControl({
    sessions: bag.sessions,
    state: bag.state,
    inbox: bag.inbox,
    machinesForPrincipal: (principal) =>
      projectMachinesForPrincipal(
        { machines: bag.machines },
        userCommandPrincipal(asUserId(principal.user), principal.role),
      ),
    browserOpen: bag.browserOpen,
    mutate: (sessionId, change, issueRelevant) =>
      bag.repository.mutateSessionView(sessionId, change, issueRelevant),
    broadcastSessions: () => bag.broadcastSessions(),
    pushPriorities: () => bag.pushPriorities(),
    setDraft: (principal, clientId, sessionId, text) => {
      bag
        .sessionStateEnvelope()
        .execute(
          'sessions.setDraft',
          { sessionId, edit: { kind: 'replace', text } },
          sessionStatePrincipalFor(
            userCommandPrincipal(asUserId(principal.user), principal.role),
            clientId,
          ),
          'ws',
        )
    },
    editDraft: (message, clientId) => bag.state.handleDraftEdit(message, clientId),
    sessionOwner: (sessionId) => bag.sessionOwner(sessionId),
    machineUseFor: (principal, sessionId) => bag.machineUseForClient(principal, sessionId),
    sessionOccupancyCount: bag.deps.sessionOccupancyCount
      ? (sessionId) => bag.deps.sessionOccupancyCount?.(sessionId)
      : undefined,
    sessionRoomJoin: bag.deps.sessionRoomJoin
      ? (client, sessionId) => bag.deps.sessionRoomJoin?.(client, sessionId)
      : undefined,
    sessionRoomLeave: bag.deps.sessionRoomLeave
      ? (client, sessionId) => bag.deps.sessionRoomLeave?.(client, sessionId)
      : undefined,
  })

  bag.autoContinue = new AutoContinueController({
    // PERSONAL (POD-1213): auto-continue governs the reader's OWN sessions,
    // so it is resolved for a user. See `settingsViewer` below for why that
    // user is spelled out rather than defaulted.
    isEnabled: () => bag.store.settings.getSettingsFor(bag.settingsViewer()).autoContinue.enabled,
    sendContinue: (sessionId) => {
      bag.continueSession({ sessionId })
    },
    getSession: (sessionId) => {
      // The controller re-arms off fresh agentState events, so overnight recovery
      // after a daemon reattach relies on reattach re-seeding agentState (seedBootState).
      const s = bag.sessions.get(sessionId)
      if (!s) return undefined
      return { live: s.status === 'live' || s.status === 'starting', state: s.agentState }
    },
  })
  /**
   * THE DURABLE FIFO, BUILT ONCE AND SHARED (POD-1761 W3, extracted by W4).
   *
   * Both the gateway and the send seam complete `queue` through this port, and
   * they must complete it through the SAME one: two enqueues that agreed today
   * and drifted tomorrow would be two queues with one name, differing in exactly
   * the place — position, refusal vocabulary, resurrect — where callers read a
   * promise about ordering.
   *
   * It is the reason `queue` never crosses the socket at all: the table survives
   * a daemon restart, a machine going offline and a parked session, and
   * forwarding it would move that promise to the one place that cannot keep it.
   */
  const durableQueue: RuntimeDurableQueuePort = {
    enqueue: (input) => {
      const queued = bag.inbox.queueText({
        sessionId: input.sessionId,
        text: input.text,
        inputOrigin: input.origin,
        // THE SENDER'S OWN PRINCIPAL, carried into the durable row so
        // `authorizeAtDrain` re-resolves the right delegation immediately
        // before the bytes cross. Hardcoding the system principal here — which
        // this did until POD-2021's review — authorized every contract-routed
        // turn as system, which is a privilege escalation the moment W4 routes
        // a real caller.
        principal: input.principal,
        // CARRIED THROUGH, not defaulted away: the idempotency key that makes a
        // steward/automation retry a no-op, and the ledger id the messages
        // module confirms, cancels and sweep-guards a queued row by.
        ...(input.mutationId ? { mutationId: input.mutationId } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      })
      if (!queued.ok) {
        return {
          ok: false as const,
          reason:
            queued.reason === 'no resume ref'
              ? ('no_resume_ref' as const)
              : ('not_running' as const),
          ...(queued.reason ? { detail: queued.reason } : {}),
        }
      }
      return {
        ok: true as const,
        // The position is the table's real depth, read back rather than counted
        // here — a number that drifted from the table would be a promise about
        // ordering that nothing kept.
        position: bag.store.sync.listQueuedMessages(input.sessionId).length,
      }
    },
  }
  /**
   * THE AGENT RUNTIME CONTRACT'S SERVER HALF (POD-1761 W3).
   *
   * Built here so the daemon lifecycle below can route `runtimeEvent` frames
   * into it, and so W4's send seam has a contract path to route through.
   */
  bag.runtimeGateway = new SessionRuntimeGateway({
    rpc: bag.rpc,
    queue: durableQueue,
    machineOf: (sessionId: SessionId) => bag.sessions.get(sessionId)?.machineId,
    // The one place "an unattributed turn acts as the system" is written down.
    systemPrincipal: () => SYSTEM_INBOX_PRINCIPAL,
    now: () => bag.now(),
  })
  /**
   * THE SEND SEAM W4'S MIGRATED CALLERS ROUTE THROUGH.
   *
   * One place reads the flag, so "is this session on the contract" is answered
   * identically for messages, steward, the superagent and automations — and so
   * the answer can be watched changing in one place rather than in ~29.
   */
  bag.receiptSender = new ReceiptSender({
    legacy: bag.inbox,
    contract: bag.runtimeGateway,
    queue: durableQueue,
    // REPORTED BY THE DAEMON ON BIND, never computed here: the daemon ORs a
    // machine-wide env var it owns with the per-spawn field and declines the flag
    // for harnesses with no turns to be honest about, so a server that inferred
    // the answer would be wrong in both directions.
    onContract: (sessionId: SessionId) => bag.sessions.get(sessionId)?.runtimeContract === true,
    liveWithEmptyQueue: (sessionId: SessionId) => {
      const s = bag.sessions.get(sessionId)
      return s?.status === 'live' && s.queuedMessageCount === 0
    },
    // The SAME condition `SessionInbox.sendText` uses to queue instead of type,
    // and for the same reason: order. Once a driver exists there are two queues
    // and nothing sequences between them, so a live send past a non-empty
    // durable queue would land ahead of older messages still waiting to drain.
    queueNotEmpty: (sessionId: SessionId) => {
      const s = bag.sessions.get(sessionId)
      return (s?.queuedMessageCount ?? 0) > 0 || bag.inbox.isDraining(sessionId)
    },
    systemPrincipal: () => SYSTEM_INBOX_PRINCIPAL,
    now: () => bag.now(),
  })
  bag.daemonLifecycle = new SessionDaemonLifecycle({
    sessions: bag.sessions,
    bus: bag.bus,
    browserOpen: bag.browserOpen,
    autoContinue: bag.autoContinue,
    inbox: bag.inbox,
    state: bag.state,
    projection: bag.daemonProjection,
    store: bag.store,
    memory: bag.deps.memory,
    observationLeases: bag.observationLeases,
    persist: (session, additionalWrite) => bag.repository.persist(session, additionalWrite),
    broadcastSessions: () => bag.broadcastSessions(),
    onSessionActivity: (sessionId) =>
      bag.bus.emit('issue.sessionDerived', { kind: 'activity', sessionId }),
    onSessionAttention: (sessionId) =>
      bag.bus.emit('issue.sessionDerived', { kind: 'attention', sessionId }),
    onSessionTurnEnd: (sessionId) =>
      bag.bus.emit('issue.sessionDerived', { kind: 'turnEnd', sessionId }),
    emitSessionExited: (sessionId, code, spawnedBy) =>
      bag.emitSessionExited(sessionId, code, spawnedBy),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    now: () => bag.now(),
    terminalCandidateFacts: (session, lease, checkpoint) =>
      bag.terminalProof.facts(session, lease, checkpoint),
    broadcastToClients: (message) => bag.broadcastToClients(message),
    clearOffer: (sessionId) => bag.clearOffer(sessionId),
    // Liveness repair belongs to the reconciler (POD-1953) — the module whose
    // rule is that the durable host, not the row, decides what is running.
    reviveParkedButAlive: (session, machineId, reason) =>
      bag.machineReconciler.reviveParkedButAlive(session, machineId, reason),
    onDurableSessionCensus: (principal, labels) =>
      bag.machineReconciler.onDurableSessionCensus(principal, labels),
    runtimeEvents: bag.runtimeGateway,
    /**
     * THE PROTOCOL ASK INGRESS (POD-2023).
     *
     * A server-family driver's `permission`/`question` asks arrive as
     * `runtimeInteractionAsked` and go straight into W2's durable aggregate with
     * the DRIVER's own id, `source: 'protocol'` and `answerable: 'structured'`.
     * Nothing is synthesized and nothing is fingerprint-deduped into an existing
     * row by content: a protocol ask has a real request id, which is exactly the
     * identity `hasReliableIdentity` branches on.
     */
    runtimeInteractions: {
      // DEFERRED READ, deliberately: `interactionAsk` is assigned by the
      // composition root after the interactions aggregate is built, which is
      // after this function runs. Reading it inside the closure is what the
      // construction-order audit permits and what makes the cycle unnecessary.
      ask: (msg) => bag.interactionAsk?.(msg),
    },
  })
  // Teardown needs repository/view/state and autoContinue/daemonProjection.
  // Built here so every port target already exists. Early constructor ports
  // still call thin lifecycle facades that forward into this collaborator.
  // No dispose: this module owns no timer, loop, or async work.
  bag.sessionTeardown = new SessionTeardown({
    store: bag.store,
    view: bag.view,
    repository: bag.repository,
    state: bag.state,
    terminalProof: bag.terminalProof,
    autoContinue: bag.autoContinue,
    sessions: bag.sessions,
    clients: bag.clients,
    bus: bag.bus,
    machines: bag.machines,
    rpc: bag.rpc,
    daemonProjection: bag.daemonProjection,
    now: () => bag.now(),
    listSessions: () => bag.listSessions(),
    setArchived: (input) => bag.setArchived(input),
    rearmUnread: (sessionId) => bag.rearmUnread(sessionId),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    broadcastSessions: () => bag.broadcastSessions(),
    issueAccess: bag.deps.issueAccess,
    snapshotTail: () => bag.deps.snapshotTail(),
  })
  bag.sessionKill = new SessionKill({
    store: bag.store,
    repository: bag.repository,
    state: bag.state,
    autoContinue: bag.autoContinue,
    sessions: bag.sessions,
    clients: bag.clients,
    bus: bag.bus,
    machines: bag.machines,
    daemonProjection: bag.daemonProjection,
    now: () => bag.now(),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    broadcastSessions: () => bag.broadcastSessions(),
    ledger: bag.deps.ledger,
  })

  bag.sessionClientPlane = new SessionClientPlane({
    browserOpen: bag.browserOpen,
    clientControl: bag.clientControl,
    clients: bag.clients,
    headless: bag.headless,
    machineReconciler: bag.machineReconciler,
    machines: bag.machines,
    repository: bag.repository,
    rpc: bag.rpc,
    state: bag.state,
    terminalProof: bag.terminalProof,
  })
  bag.sessionAuthz = new SessionAuthz({
    clientControl: bag.clientControl,
    deps: bag.deps,
    listSessions: () => bag.listSessions(),
    sessionById: (sessionId: SessionId) => bag.view.byId(sessionId),
    machines: bag.machines,
    sessions: bag.sessions,
    store: bag.store,
  })
  bag.sessionMetaOps = new SessionMetaOps({
    broadcastSessions: () => bag.broadcastSessions(),
    funnel: bag.funnel,
    mutations: bag.mutations,
    now: () => bag.now(),
    removeSessionRuntime: (id: SessionId, ret: unknown) =>
      bag.sessionKill.removeSessionRuntime(id, ret),
    repository: bag.repository,
    sessionRemovalSpecs: (id: SessionId) => bag.sessionKill.sessionRemovalSpecs(id),
    sessionTeardown: bag.sessionTeardown,
    sessions: bag.sessions,
    state: bag.state,
    store: bag.store,
    toMachine: (mid: string, msg: unknown) => bag.toMachine(mid, msg),
    view: bag.view,
  })
  // Revival needs sessionStart.spawn, workspace, repository, launchConfig,
  // terminalProof, state, autoContinue — all exist by this point.
  // No dispose: the coordinator holds only a single-flight map.
  bag.sessionRevival = new SessionRevival({
    store: bag.store,
    repository: bag.repository,
    state: bag.state,
    terminalProof: bag.terminalProof,
    launchConfig: bag.launchConfig,
    workspace: bag.workspace,
    autoContinue: bag.autoContinue,
    sessions: bag.sessions,
    machines: bag.machines,
    rpc: bag.rpc,
    listSessions: () => bag.listSessions(),
    broadcastSessions: () => bag.broadcastSessions(),
    toMachine: (machineId, message) => bag.toMachine(machineId, message),
    spawn: (input) => bag.sessionStart.spawn(input),
    machineUseGate: (caller) => bag.machineUseGate(caller),
    issueAccess: bag.deps.issueAccess,
    instructionsForStart: (i) => bag.deps.instructionsForStart(i),
    onWorktreesChanged: (repoPath, machineId) => bag.deps.onWorktreesChanged(repoPath, machineId),
  })
  // Auto-continue re-arm on the settings flip — the reaction needs the sessions
  // map, so it lives here as a bus subscriber (this service is constructed AFTER
  // NotifyService, so the notification replay keeps firing first).
  bag.bus.on('settings.changed', ({ previous, next }: { previous: any; next: any }) => {
    // Keep the cached draftSync flag current (POD-859). Resolved through the
    // canonical experiments system (channel/config/user) [spec:SP-f4b9].
    bag.state.setDraftSyncEnabled(isFeatureEnabled('draft-sync', next))
    const wasEnabled = previous.autoContinue.enabled
    const nowEnabled = next.autoContinue.enabled
    if (nowEnabled === wasEnabled) return
    const ids = nowEnabled
      ? [...bag.sessions.values()]
          .filter(
            (s) =>
              (s.status === 'live' || s.status === 'starting') &&
              s.agentState?.phase === 'errored' &&
              s.agentState.error?.retryable === true,
          )
          .map((s) => s.sessionId)
      : []
    bag.autoContinue.onSettingsChanged(nowEnabled, ids)
  })
  // Agent mail send-time nudge (issue #103): poke the target issue's live agent
  // session so mail is noticed without polling. The nudge carries NO message
  // body — an idempotent "check your inbox" poke. Selection: a single idle
  // live agent gets an immediate sendText; otherwise the most recently active
  // live agent gets a durable queued send; no live agents → nothing (the mail
  // surfaces via prime / the stop-hook).
  bag.bus.on(
    'issue.mailSent',
    ({ seq, worktreePath }: { seq: number; worktreePath?: string | null }) => {
      const members = bag.view.listForIssue(worktreePath ?? null, undefined)
      const target = selectMailNudgeSession(members)
      if (!target) return
      const text = `You have mail on issue #${seq}: run 'podium issue mail inbox' (claim with 'podium issue mail claim <id>' only if you will act on it).`
      // MIGRATED, WITH BOTH ARMS PRESERVED EXACTLY (POD-1761 W4, C4).
      //
      // The obvious move is to collapse these two into one `when-ready`: that is
      // what the mode has always been approximating — "now if it can take it,
      // next turn boundary otherwise" — and it is what would finally retire
      // `selectMailNudgeSession`'s phase peek, which W4 was asked to do.
      //
      // I did not, and the reason is durability rather than nerve. `when-ready`
      // is the daemon's IN-MEMORY path; the busy-agent arm here is the DURABLE
      // outbox, so collapsing them would silently drop any outstanding nudge
      // across a daemon restart. That is a delivery-semantics change, and this
      // item's rule is that behavioural improvements leave as subissues rather
      // than riding in on a migration. POD-2043 carries the collapse, to be done
      // when the operator flips the default and the trade can be judged on its
      // own.
      //
      // What DOES change: both arms stop calling the legacy verbs directly, so
      // the nudge gets a receipt and the C5 guard has nothing to except here.
      if (target.mode === 'send') bag.receiptSender.send('now', { sessionId: target.sessionId, text })
      else void bag.receiptSender.send('queue', { sessionId: target.sessionId, text })
    },
  )
}
