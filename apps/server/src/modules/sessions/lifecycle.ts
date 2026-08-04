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
import { spawnedByParentSessionId } from '@podium/model'

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
export { APPLIED_MUTATIONS_MAX_AGE_MS } from './session-shared'

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
import type { SessionKill } from './session-kill'
import type { SessionClientPlane } from './session-client-plane'
import type { SessionAuthz } from './session-authz'
import type { SessionMetaOps } from './session-meta-ops'
import type { SessionRevival } from './session-revival'
import { wireSessionLifecycle } from './session-wiring'
import { SessionStateRegistry, sessionStatePrincipalFor } from './session-state/registry'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'
import type { SessionTerminalProof } from './terminal-proof'
import type { SessionView } from './view'
import type { SessionWorkspace } from './workspace'

/** Composition types — live in session-lifecycle-types.ts (POD-1396). */
export type {
  SessionLedger,
  SessionDeletePlan,
  SessionRestorePlan,
  SessionLifecycleDeps,
} from './session-lifecycle-types'
import type { SessionLifecycleDeps } from './session-lifecycle-types'

/** Session lifecycle runtime + composition boundary (POD-1396 facade). */
export class SessionLifecycle {
  /** Live maps — public: the composition root's cross-module closures (and the
   *  relay tests, via `(reg as any).sessions/.clients`) reach them directly. */
  readonly sessions!: Map<SessionId, Session>
  /** THE CLIENT CONNECTION SET — OWNED BY THE GATEWAY (POD-390). */
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
  private readonly sessionKill!: SessionKill
  private readonly sessionClientPlane!: SessionClientPlane
  private readonly sessionAuthz!: SessionAuthz
  private readonly sessionMetaOps!: SessionMetaOps
  /** Resume / resurrect / handoff (POD-1396). */
  private readonly sessionRevival!: SessionRevival
  private readonly store!: SessionStore
  private readonly now!: () => number
  private readonly bus!: EventBus
  private readonly machines!: MachinesService
  private readonly toMachine = (machineId: string, msg: ControlMessage): void =>
    this.machines.toMachine(machineId, msg)
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
  private prepareInboxSend(...args: any[]): void {
    (this.sessionMetaOps as any).prepareInboxSend(...args)
  }
  authorizeQueuedInputAtApply(...args: any[]): any {
    return (this.sessionAuthz as any).authorizeQueuedInputAtApply(...args)
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
  sessionsChangedForMachine(...args: any[]): void {
    (this.sessionClientPlane as any).sessionsChangedForMachine(...args)
  }
  onMachineAttached(...args: any[]): void {
    (this.sessionClientPlane as any).onMachineAttached(...args)
  }
  onMachineDetached(...args: any[]): void {
    (this.sessionClientPlane as any).onMachineDetached(...args)
  }
  private reattachMessageFor(...args: any[]): any {
    return (this.sessionClientPlane as any).reattachMessageFor(...args)
  }
  private rebindHeadless(...args: any[]): void {
    (this.sessionClientPlane as any).rebindHeadless(...args)
  }
  private pushPriorities(): void {
    this.state.pushPriorities()
  }
  listSessions(forPrincipal?: SessionWirePrincipal): SessionMeta[] {
    return this.view.list(forPrincipal)
  }
  /** The member sessions of ONE issue, without wiring the rest [POD-1639].
   *  Same set and same fields as `sessionsForIssue(path, listSessions(), id)`;
   *  see {@link SessionView.listForIssue}. */
  listSessionsForIssue(
    worktreePath: string | null,
    issueId: string | undefined,
    forPrincipal?: SessionWirePrincipal,
  ): SessionMeta[] {
    return this.view.listForIssue(worktreePath, issueId, forPrincipal)
  }
  /** ONE session by id, without wiring the rest [POD-1646]. Same value as
   *  `listSessions(p).find((s) => s.sessionId === id)`; see
   *  {@link SessionView.byId}. */
  sessionById(sessionId: SessionId, forPrincipal?: SessionWirePrincipal): SessionMeta | undefined {
    return this.view.byId(sessionId, forPrincipal)
  }
  /** One session's `spawnedBy`, skipping the wire entirely [POD-1646];
   *  see {@link SessionView.spawnedByOf}. */
  sessionSpawnedBy(sessionId: SessionId, forPrincipal?: SessionWirePrincipal): string | undefined {
    return this.view.spawnedByOf(sessionId, forPrincipal)
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
  setSnooze(...args: any[]): void {
    (this.sessionMetaOps as any).setSnooze(...args)
  }
  clearSnooze(...args: any[]): void {
    (this.sessionMetaOps as any).clearSnooze(...args)
  }
  sessionOwner(...args: any[]): any {
    return (this.sessionAuthz as any).sessionOwner(...args)
  }
  machineUseForClient(...args: any[]): any {
    return (this.sessionAuthz as any).machineUseForClient(...args)
  }
  authorizeClientDrive(...args: any[]): any {
    return (this.sessionAuthz as any).authorizeClientDrive(...args)
  }
  setOffer(...args: any[]): void {
    (this.sessionMetaOps as any).setOffer(...args)
  }
  clearOffer(...args: any[]): void {
    (this.sessionMetaOps as any).clearOffer(...args)
  }
  createSession(input: Parameters<SessionStart['create']>[0]): SessionSpawnResult {
    return this.sessionStart.create(input)
  }
  capabilityForSession(...args: any[]): any {
    return (this.sessionAuthz as any).capabilityForSession(...args)
  }
  inboxPrincipalForCapability(...args: any[]): any {
    return (this.sessionAuthz as any).inboxPrincipalForCapability(...args)
  }
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
  continueSession(...args: any[]): any {
    return (this.sessionMetaOps as any).continueSession(...args)
  }
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
  /** Idempotency is MutationLedger's (POD-382); not re-exposed here. */
  /** The write funnel's session-metadata face: apply the field write, persist the */
  private mutateSessionMeta(...args: any[]): void {
    (this.sessionMetaOps as any).mutateSessionMeta(...args)
  }
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
  setArchived(...args: any[]): void {
    (this.sessionMetaOps as any).setArchived(...args)
  }
  private parkArchivedSession(sessionId: SessionId): void {
    this.sessionTeardown.parkArchivedSession(sessionId)
  }
  tryAutoArchiveStoppedObserved(...args: any[]): any {
    return (this.sessionMetaOps as any).tryAutoArchiveStoppedObserved(...args)
  }
  markSessionRead(...args: any[]): void {
    (this.sessionMetaOps as any).markSessionRead(...args)
  }
  markSessionUnread(...args: any[]): void {
    (this.sessionMetaOps as any).markSessionUnread(...args)
  }
  private rearmUnread(sessionId: SessionId): void {
    this.state.rearmUnreadForAll(sessionId)
  }
  setSessionIssueId(...args: any[]): void {
    (this.sessionMetaOps as any).setSessionIssueId(...args)
  }
  getSessionIssueId(...args: any[]): any {
    return (this.sessionMetaOps as any).getSessionIssueId(...args)
  }
  setWorkState(...args: any[]): void {
    (this.sessionMetaOps as any).setWorkState(...args)
  }
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
  /** Park a live session: kill process, keep row/transcript/resume ref. */
  hibernateSession(input: {
    sessionId: SessionId
    requireTerminalProof?: boolean
  }): { ok: boolean; reason?: string } {
    return this.sessionTeardown.hibernateSession(input)
  }
  /** Move one resumable worktree session to another machine ([spec:SP-3f7a]). */
  handoffSession(
    input: { sessionId: SessionId; machineId: string },
    caller: HandoffCaller,
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: true; newCwd: string }> {
    return this.sessionRevival.handoffSession(input, caller, issues)
  }
  /** HOW A CALLER'S `use` RIGHTS ON A MACHINE ARE RESOLVED — the seam, deliberately */
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
        spawnedByParentSessionId(
          // POD-1646: one field, one visibility check — not a full pass.
          this.sessionSpawnedBy(sessionId),
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
    this.sessionKill.maybeReapDraftIssue(issueId)
  }
  private sessionRemovalSpecs(sessionId: SessionId): EntityChangeSpec[] {
    return this.sessionKill.sessionRemovalSpecs(sessionId)
  }
  prepareIssueSessionDelete(...args: any[]): any {
    return (this.sessionMetaOps as any).prepareIssueSessionDelete(...args)
  }
  prepareIssueSessionRestore(...args: any[]): any {
    return (this.sessionMetaOps as any).prepareIssueSessionRestore(...args)
  }
  private removeSessionRuntime(
    sessionId: SessionId,
    terminalRetirement?: { retiredAt: string },
  ): void {
    this.sessionKill.removeSessionRuntime(sessionId, terminalRetirement)
  }
  killSession(input: { sessionId: SessionId }): void {
    this.sessionKill.killSession(input)
  }
  private emitSessionExited(
    sessionId: SessionId,
    code: number,
    spawnedBy?: string | null,
    sourceSession?: Session,
  ): void {
    this.sessionKill.emitSessionExited(sessionId, code, spawnedBy, sourceSession)
  }
  private spawn(input: Parameters<SessionStart['spawn']>[0]): SessionSpawnResult {
    return this.sessionStart.spawn(input)
  }
  settingsViewer(...args: any[]): any {
    return (this.sessionAuthz as any).settingsViewer(...args)
  }
  onClientAttached(...args: any[]): void {
    (this.sessionClientPlane as any).onClientAttached(...args)
  }
  onRoomJoined(...args: any[]): void {
    (this.sessionClientPlane as any).onRoomJoined(...args)
  }
  refreshClientPublication(id: string): void {
    this.publication.refreshClient(id)
  }
  publicationMetrics(): SessionPublicationMetrics {
    return this.publication.metrics()
  }
  onClientReclaim(...args: any[]): void {
    (this.sessionClientPlane as any).onClientReclaim(...args)
  }
  onClientDetached(...args: any[]): void {
    (this.sessionClientPlane as any).onClientDetached(...args)
  }
  onOpenUrl(...args: any[]): void {
    (this.sessionClientPlane as any).onOpenUrl(...args)
  }
  onSessionClientFrame(...args: any[]): void {
    (this.sessionClientPlane as any).onSessionClientFrame(...args)
  }
  onSessionDaemonFrame(principal: MachinePrincipal, msg: SessionsDaemonFrame): void {
    this.daemonLifecycle.handle(principal, msg)
  }
  transcriptFor(...args: any[]): any {
    return (this.sessionMetaOps as any).transcriptFor(...args)
  }
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
  deliverEntityMessage(...args: any[]): void {
    (this.sessionClientPlane as any).deliverEntityMessage(...args)
  }
  syncChangesSince(
    cursor: number | null,
    authority?: PublicationAuthority,
  ): SyncChangesSinceResult {
    return this.publication.syncChangesSince(cursor, authority)
  }
}
