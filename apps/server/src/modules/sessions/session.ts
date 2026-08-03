import {
  type AccountId,
  type AgentKind,
  type AgentRuntimeState,
  type Attribution,
  type ConversationId,
  type Geometry,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
  type ResumeRef,
  type SessionMeta,
  type SessionUserOverlay,
  type SessionOffer,
  type SessionOrigin,
  type WorkState,
} from '@podium/model'
import { FIRST_ADMIN_USER_ID, WorkState as WorkStateSchema } from '@podium/model'
import type { ControlMessage, SessionObservationCheckpointV1 } from '@podium/protocol'
import type { SessionRow } from '../../store'
import { SessionTerminal, type SessionTerminalState } from './terminal'

export type Send<T> = (msg: T) => void

export interface PublicationAuthoritySnapshot {
  revision: number
  /** Stable, authority-owned identity for this exact allowed-id set. */
  allowedSignature: string
  /** Immutable for the lifetime of this snapshot. */
  allowedSessionIds: readonly string[]
}

/** Main-authority result used to construct and filter a publication ViewKey. */
export interface PublicationAuthority {
  principal: string
  scope: string
  serverRole: string
  protocolVersion: number
  /** Only a proven global authority may receive unfiltered non-session feeds. */
  global: boolean
  snapshot(): PublicationAuthoritySnapshot
}

export interface ClientPublicationAuthority extends PublicationAuthority {
  sendPrepared: Send<string>
}

/**
 * ONE CLIENT CONNECTION — DEFINED IN THE GATEWAY (POD-390).
 *
 * The record holds the socket (`send` closes over a `ws`), so it moved to
 * `gateway/client-registry.ts` with the connection set itself. A session reads
 * a client's subscription state and delivers to it; it does not own it.
 * Imported (not re-exported) so there is exactly ONE definition site and no
 * forwarding shim: `Session` takes one as an argument, and every other consumer
 * imports it from the gateway too.
 */

export interface SessionInit {
  sessionId: SessionId
  /** Accountable human owner. Required on production mint paths. */
  ownerUserId?: UserId
  agentKind: AgentKind
  cwd: string
  title: string
  /** Resolved launch configuration, immutable for this session [spec:SP-dae6]. */
  model?: string
  effort?: string
  accountId?: AccountId
  origin: SessionOrigin
  createdAt: string
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  /** The machine (daemon) this session runs on. REQUIRED: the caller has resolved a
   *  real machine before a Session object exists (POD-318), so there is no default to
   *  supply and no placeholder to adopt away from later. */
  machineId: MachineId
  resume?: ResumeRef
  /** Resolved by process composition; never derived from ambient env here. */
  durableLabel: string
  lastActiveAt?: string
  /** Persisted completed working/compacting time; absent for legacy sessions. */
  workingMsTotal?: number
  inputCount?: number
  outputCount?: number
  activityCount?: number
  lastOutputAt?: string | null
  lastInputAt?: string | null
  lastResumedAt?: string | null
  status?: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  exitCode?: number
  spawnFailure?: string
  name?: string
  /** WHO set `name` (#490): 'user' (sovereign) | 'agent' (self-named). */
  nameSource?: 'user' | 'agent'
  archived?: boolean
  workState?: WorkState
  /** WHO created this session (provenance, issue #60): 'user', 'issue:<id>',
   *  'superagent:<threadId>', … Absent = unknown (legacy row). */
  spawnedBy?: string
  /** The ADR 9 D5 A3 attribution pair, stamped at spawn from the transport
   *  principal. Optional ONLY so a session reloaded from a pre-POD-1516 row can
   *  exist without one; every live spawn supplies it. */
  createdBy?: Attribution
  /** True for a headless harness session (no PTY; concierge unification). */
  headless?: boolean
  /** Explicit issue attachment (issue-as-workspace). Absent = unattached. */
  issueId?: IssueId
  /** Birth-issue nice-name fields (#474). Absent = not yet named. */
  refIssueId?: IssueId | null
  refLetter?: string | null
  refDraft?: number | null
  /** OPTIONAL workflow pass-through metadata (#285 via #237 [spec:SP-34d7
   *  cross-harness]): stamped at spawn, never interpreted here. */
  workflowRunId?: string
  workflowStepId?: string
  executionProfileId?: string
  stoppedAt?: string | null
  stopReason?: 'self' | 'parent' | 'forced' | 'exited' | null
  /** Called when a meta field changes outside the normal control flow (the
   *  debounced shell `busy` flag) so the registry can rebroadcast the session list. */
  onActivity?: () => void
  /**
   * Called on a TERMINAL transition so the registry can re-arm unread (POD-1076).
   *
   * `readAt` used to be a field here, and an exit simply nulled it — which
   * re-armed unread for the whole instance, because there was only one marker.
   * Per-user it is a store write against EVERY reader's row, which a Session has
   * no business doing, so the session reports the event and the registry performs
   * it. Behaviour is identical; the authority moved to where the rows are.
   */
  onUnreadRearm?: () => void
}

/** One agent's relay state: controller gating, geometry/epoch, and its attached clients. */
export type SessionVolatileField = 'geometry' | 'status' | 'machineId' | 'handoffTarget'

export interface SessionDurableState {
  cwd: string
  issueId: IssueId | undefined
  refIssueId: IssueId | null
  refLetter: string | null
  refDraft: number | null
  machineId: MachineId
  resume: ResumeRef | undefined
  lastActiveAt: string
  title: string
  titleLocked: boolean
  name: string
  nameSource: 'user' | 'agent' | undefined
  archived: boolean
  stoppedAt: string | undefined
  stopReason: 'self' | 'parent' | 'forced' | 'exited' | undefined
  workState: WorkState | undefined
  cmd: string
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  exitCode: number | undefined
  spawnFailure: string | undefined
  agentState: AgentRuntimeState | undefined
  workingMsTotal: number | undefined
  incomingWorkingMsTotal: number | undefined
  agentColor: string | undefined
  observedModel: string | undefined
  observedEffort: string | undefined
  contextUsagePercent: number | undefined
  queuedMessageCount: number
  handoffTarget: string | undefined
  conversationPodiumId: ConversationId | undefined
  draftUpdatedAt: string | undefined
  offer: SessionOffer | undefined
  transcriptAvailable: boolean
  terminal: SessionTerminalState
}

export class Session {
  readonly sessionId: SessionId
  /** Immutable accountable human owner for authorization and delegation. */
  readonly ownerUserId: UserId
  readonly agentKind: AgentKind
  // Mutable: an agent can move into a worktree mid-session (EnterWorktree / cd),
  // reported via the hook payload's cwd; the relay restamps this so the sidebar
  // re-groups the session under the directory it actually moved into.
  cwd: string
  readonly origin: SessionOrigin
  readonly createdAt: string
  readonly durableLabel: string
  /** Creation provenance (issue #60) — immutable for the life of the row. */
  readonly spawnedBy: string | undefined
  /** WHO created this session and FOR WHOM. Immutable after create
   *  (`SESSION_IMMUTABLE_AFTER_CREATE`): nothing re-attributes a live session. */
  readonly createdBy: Attribution | undefined
  /** Actual launch configuration captured once at spawn [spec:SP-dae6]. */
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly accountId: AccountId | undefined
  /** Workflow pass-through metadata (#285) — immutable, uninterpreted. */
  readonly workflowRunId: string | undefined
  readonly workflowStepId: string | undefined
  readonly executionProfileId: string | undefined
  /** True for a headless harness session (no PTY) — immutable for the row's life. */
  readonly headless: boolean
  /** Explicit issue attachment (issue-as-workspace) — mutable: the agent can
   *  re-home itself (attach) and the user can move a session between issues. */
  issueId: IssueId | undefined
  /** BIRTH issue for the permanent human-facing nice name (#474). Set once at
   *  naming time; never changes on re-attach. */
  refIssueId: IssueId | null
  /** Column letter within refIssueId (`POD-13-A`). */
  refLetter: string | null
  /** Per-repo DRAFT ordinal for a truly issueless session (`POD-DRAFT-3`). */
  refDraft: number | null
  /** The machine (daemon) this session runs on. The registry routes this session's
   *  control messages to it. Reassignable rather than readonly because a handoff moves
   *  a session between machines — never because it starts out unattributed. */
  machineId: MachineId
  /** How to bring this session back after its process is gone (hibernate→resume).
   *  Set at spawn for resumes; learned later from the daemon for fresh spawns. */
  resume?: ResumeRef
  lastActiveAt: string
  title: string
  /** Live heuristic (not persisted): a real title — the agent's own summary, or
   *  the first-prompt fallback — has been set, so the generic "Claude Code"
   *  placeholder must not overwrite it and the fallback shouldn't re-fire. */
  titleLocked = false
  /** Curated name; empty = fall back to the live title. */
  name = ''
  /** WHO set `name` (#490). 'user' is sovereign: an agent title is REFUSED against
   *  it, so a hand-picked name is never silently overwritten. 'agent' = the session
   *  named itself and may re-title itself. undefined = nobody named it yet. */
  nameSource: 'user' | 'agent' | undefined = undefined
  archived = false
  /** Terminal-transition hook that re-arms unread; see {@link SessionInit.onUnreadRearm}. */
  private onUnreadRearm: (() => void) | undefined
  /** Set only by the explicit stop lifecycle, not ordinary hibernation/exits. [spec:SP-6144] */
  stoppedAt: string | undefined
  stopReason: 'self' | 'parent' | 'forced' | 'exited' | undefined
  workState: WorkState | undefined
  cmd = ''
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited' = 'starting'
  exitCode: number | undefined
  /** Exact daemon diagnosis when a spawn never reached a running process. */
  spawnFailure: string | undefined
  agentState: AgentRuntimeState | undefined
  private workingMsTotal: number | undefined
  private incomingWorkingMsTotal: number | undefined
  /** The agent's `/color` identity accent (a named colour), learned from the
   *  transcript tail. Undefined = no colour (incl. Claude's 'default'/reset). */
  agentColor: string | undefined
  /** The model OBSERVED producing assistant turns, learned from the transcript
   *  tail (`message.model`). Resolves a spawn-time `auto` selection to the real
   *  id and follows mid-session `/model` switches. Not persisted: like
   *  agentColor it is re-learned from the tail's seed window on reattach. */
  observedModel: string | undefined
  /** The effort tier OBSERVED on assistant turns (transcript top-level `effort`),
   *  learned alongside observedModel. */
  observedEffort: string | undefined
  /** Latest exact harness-reported context-window usage, if this harness exposes it. */
  contextUsagePercent: number | undefined
  /** Count of durable queued messages awaiting delivery (queued_messages table).
   *  Transient mirror maintained by the registry (enqueue/deliver/boot) — the
   *  table is the truth; this exists so toMeta() stays synchronous. */
  queuedMessageCount = 0
  /** Transient UI overlay while the canonical row moves machines ([spec:SP-3f7a]). */
  handoffTarget: string | undefined
  /** Stable Podium conversation identity (conversation registry). Stamped by the
   *  registry when the linkage is learned (resume ref observed/rolled, boot
   *  lookup); transient here — the conversation_segments table is the truth. */
  conversationPodiumId: ConversationId | undefined = undefined
  /** Last-edit time of a non-empty unsent composer draft (undefined = no draft).
   *  Lives in its own `session_drafts` table (not toRow()); the registry seeds it
   *  at load and on every setSessionDraft. Surfaced so the client can show DRAFT
   *  and lift the session in NEEDS YOUR ATTENTION by when its prompt was edited. */
  draftUpdatedAt: string | undefined = undefined
  /** Draft Sync v2 (POD-859): true when this session's daemon runs the composer
   *  scrape/inject engine (reported on bind). Transient — not persisted; re-set on
   *  every (re)bind. Surfaced in toMeta so a client retires its own sampler/flush. */
  draftSyncEngine = false
  /** Agent action offer [spec:SP-c7f1] — a freeform message + action buttons the
   *  agent offers the user as next steps. Lives in its own `offers` table (not
   *  toRow()); the registry seeds it at load and on set/clear. undefined = none.
   *  Cleared on the next user-submitted turn (a button click counts). */
  offer: SessionOffer | undefined = undefined
  /** True once a structured transcript has been seen — drives chat capability. */
  transcriptAvailable = false
  readonly terminal: SessionTerminal

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.ownerUserId = init.ownerUserId ?? FIRST_ADMIN_USER_ID
    this.agentKind = init.agentKind
    this.cwd = init.cwd
    this.title = init.title
    this.origin = init.origin
    this.createdAt = init.createdAt
    this.spawnedBy = init.spawnedBy
    this.createdBy = init.createdBy
    this.model = init.model
    this.effort = init.effort
    this.accountId = init.accountId
    this.workflowRunId = init.workflowRunId
    this.workflowStepId = init.workflowStepId
    this.executionProfileId = init.executionProfileId
    this.headless = init.headless ?? false
    this.issueId = init.issueId
    this.refIssueId = init.refIssueId ?? null
    this.refLetter = init.refLetter ?? null
    this.refDraft = init.refDraft ?? null
    this.terminal = new SessionTerminal({
      sessionId: init.sessionId,
      agentKind: init.agentKind,
      geometry: init.geometry,
      toDaemon: init.toDaemon,
      inputCount: init.inputCount,
      outputCount: init.outputCount,
      activityCount: init.activityCount,
      lastOutputAt: init.lastOutputAt,
      lastInputAt: init.lastInputAt,
      lastResumedAt: init.lastResumedAt,
      onActivity: (at, changed) => {
        this.lastActiveAt = at
        if (changed) init.onActivity?.()
      },
      onTranscriptAvailable: () => {
        this.transcriptAvailable = true
      },
    })
    this.machineId = init.machineId
    this.durableLabel = init.durableLabel
    this.resume = init.resume
    this.lastActiveAt = init.lastActiveAt ?? init.createdAt
    this.workingMsTotal = init.workingMsTotal
    if (init.status) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
    if (init.spawnFailure !== undefined) this.spawnFailure = init.spawnFailure
    if (init.name) this.name = init.name
    if (init.nameSource) this.nameSource = init.nameSource
    if (init.archived) this.archived = init.archived
    this.stoppedAt = init.stoppedAt ?? undefined
    this.stopReason = init.stopReason ?? undefined
    if (init.workState) this.workState = init.workState
    this.onUnreadRearm = init.onUnreadRearm
  }

  /**
   * Mark the session as just resumed/resurrected. Resets the hibernation idle
   * timer (the eligibility check maxes this with lastActiveAt) WITHOUT touching
   * lastActiveAt, which is authoritative for recency ordering.
   */
  markResumed(): void {
    this.stoppedAt = undefined
    this.stopReason = undefined
    this.spawnFailure = undefined
    this.terminal.recordResumeActivity()
  }

  onExit(code: number): void {
    // The PTY is gone — no more output, so it can't be "busy".
    this.terminal.stopOutput()
    // A hibernated session's process exit is the *expected* result of the
    // hibernate kill — don't let it overwrite the hibernated state.
    if (this.status === 'hibernated') return
    this.status = 'exited'
    this.exitCode = code
    // EVERY terminal transition stamps stop metadata and re-arms unread — a
    // daemon-observed death decays (and badges) exactly like an explicit stop.
    // The explicit-stop path may already have stamped a richer reason; keep it.
    // [spec:SP-6144]
    this.stoppedAt ??= new Date().toISOString()
    this.stopReason ??= 'exited'
    // Re-arm unread for every reader (POD-1076): the registry owns the rows.
    this.onUnreadRearm?.()
    // Preserve the final turn diagnosis; lifecycle status owns liveness while
    // the causal checkpoint remains inspectable [spec:SP-cdb2].
    this.terminal.broadcast({ type: 'agentExit', sessionId: this.sessionId, code })
  }

  /** A spawn that never started — surface as an exit so attached clients stop waiting. */
  markSpawnError(message: string): void {
    this.status = 'exited'
    this.exitCode = -1
    this.spawnFailure = message.trim().slice(0, 2000) || 'unknown spawn error'
    this.agentState = undefined
    // Terminal transition — same stop metadata as onExit [spec:SP-6144].
    this.stoppedAt ??= new Date().toISOString()
    this.stopReason ??= 'exited'
    // Re-arm unread for every reader (POD-1076): the registry owns the rows.
    this.onUnreadRearm?.()
    console.warn(`[podium] spawn failed for ${this.sessionId}: ${message}`)
    this.terminal.broadcast({ type: 'agentExit', sessionId: this.sessionId, code: -1 })
  }

  /** Adopt a live terminal title the agent set (OSC). Replaces the cwd-derived default. */
  /** Harness-observed runtime state (hooks-driven). The cumulative compute base is persisted. */
  applyObservationCheckpoint(checkpoint: SessionObservationCheckpointV1): void {
    const state = checkpoint.turnState
    this.workingMsTotal = state.workingMsTotal
    this.incomingWorkingMsTotal = undefined
    this.agentState = state
    const providerAt = checkpoint.providerAt
    if (providerAt && providerAt > this.lastActiveAt) this.lastActiveAt = providerAt
  }

  /**
   * Legacy unfenced state path. Kept during mixed deployment only; causal v1
   * sessions bypass its daemon-counter reset heuristic.
   */
  setAgentState(state: AgentRuntimeState): void {
    // The daemon reducer's total restarts at zero with each tracker. Persist only
    // positive deltas within one tracker epoch on top of our durable total; a
    // lower/reset incoming value becomes the next epoch's baseline.
    const incomingTotal = state.workingMsTotal
    if (incomingTotal !== undefined) {
      if (this.workingMsTotal === undefined) {
        this.workingMsTotal = incomingTotal
      } else if (
        this.incomingWorkingMsTotal !== undefined &&
        incomingTotal >= this.incomingWorkingMsTotal
      ) {
        this.workingMsTotal += incomingTotal - this.incomingWorkingMsTotal
      }
      this.incomingWorkingMsTotal = incomingTotal
    }
    this.agentState =
      this.workingMsTotal === undefined ? state : { ...state, workingMsTotal: this.workingMsTotal }
    // Recency = the phase event-time (state.since), which is the real source-record
    // time (transcript timestamp), never "now" — but MONOTONIC: a boot re-seed that
    // read the wrong transcript (a subagent jsonl registered under the parent's
    // native id, issue #94) carries a stale event-time; an authoritative set let it
    // sink the session below genuinely-older ones and every reattach re-asserted
    // it. The old stale-HIGH poisoning this could correct (mtime-derived stamps) is
    // gone since seeds stamp the last DATED record, so regression buys nothing.
    if (state.since > this.lastActiveAt) this.lastActiveAt = state.since
  }

  /** Adopt a `/color` value from the transcript. Treats Claude's "no colour"
   *  spellings as cleared. Returns true when it actually changed (so the caller
   *  can skip a redundant broadcast). */
  setAgentColor(color: string): boolean {
    const lower = color.trim().toLowerCase()
    const next = Session.NO_COLOR.has(lower) ? undefined : lower
    if (next === this.agentColor) return false
    this.agentColor = next
    return true
  }

  /** Clear the agent action offer [spec:SP-c7f1]. Returns true if it actually
   *  changed (lets the caller skip a redundant broadcast/persist). */
  clearOffer(): boolean {
    if (this.offer === undefined) return false
    this.offer = undefined
    return true
  }

  /** Adopt an observed-model sighting from the transcript tail. Returns true
   *  when it actually changed (so the caller can skip a redundant broadcast). */
  setObservedModel(model: string, effort?: string): boolean {
    const nextModel = model.trim()
    const nextEffort = effort?.trim() || undefined
    if (!nextModel) return false
    const changed =
      nextModel !== this.observedModel ||
      (nextEffort !== undefined && nextEffort !== this.observedEffort)
    if (!changed) return false
    this.observedModel = nextModel
    if (nextEffort !== undefined) this.observedEffort = nextEffort
    return true
  }

  setContextUsagePercent(percent: number): boolean {
    if (!Number.isFinite(percent)) return false
    const next = Math.min(100, Math.max(0, percent))
    if (next === this.contextUsagePercent) return false
    this.contextUsagePercent = next
    return true
  }

  private static readonly NO_COLOR = new Set(['default', 'none', 'reset', 'gray', 'grey'])

  setTitle(title: string): void {
    // A title change is not activity (spinner frames are filtered upstream, but even
    // a stable rename isn't the agent doing work) — it must not move recency. Agent
    // activity flows through setAgentState; shells through the busy path.
    this.title = title
  }

  markLive(cmd: string, geometry: Geometry): void {
    // Reattaching to a surviving PTY is NOT activity — it must not restamp recency
    // (that reshuffled the whole ordering on every daemon redeploy). The persisted
    // lastActiveAt is authoritative; genuine activity (agentState/output) advances it.
    this.cmd = cmd
    // 'exited' is included on purpose: a reattach only produces a bind when the
    // daemon found the durable master alive. That means the row was wrongly
    // marked exited — its attach client died on a daemon restart while the agent
    // survived in its scope. The live master is authoritative, so clear the stale
    // exit and bring the session back.
    if (this.status === 'starting' || this.status === 'reconnecting' || this.status === 'exited') {
      this.status = 'live'
      this.exitCode = undefined
    }
    // Adopt the daemon's geometry only if no controller has resized us yet.
    this.terminal.adoptGeometryIfUncontrolled(geometry)
  }

  /**
   * The daemon holding this session's PTY bridge went away (daemon restart/crash —
   * the durable master survives in its own scope). Drop a live/starting session to
   * 'reconnecting' so the next daemon to attach re-binds it (markLive brings it back
   * on the resulting bind). Returns true if the status changed.
   */
  markReconnecting(): boolean {
    if (this.status === 'live' || this.status === 'starting') {
      this.status = 'reconnecting'
      return true
    }
    return false
  }

  /** Snapshot of all non-connection state represented by a successful session
   * ledger capture. Used to roll live truth back when a durable append fails. */
  captureDurableState(): SessionDurableState {
    return {
      cwd: this.cwd,
      issueId: this.issueId,
      refIssueId: this.refIssueId,
      refLetter: this.refLetter,
      refDraft: this.refDraft,
      machineId: this.machineId,
      resume: this.resume ? { ...this.resume } : undefined,
      lastActiveAt: this.lastActiveAt,
      title: this.title,
      titleLocked: this.titleLocked,
      name: this.name,
      nameSource: this.nameSource,
      archived: this.archived,
      stoppedAt: this.stoppedAt,
      stopReason: this.stopReason,
      workState: this.workState,
      cmd: this.cmd,
      status: this.status,
      exitCode: this.exitCode,
      spawnFailure: this.spawnFailure,
      agentState: this.agentState ? structuredClone(this.agentState) : undefined,
      workingMsTotal: this.workingMsTotal,
      incomingWorkingMsTotal: this.incomingWorkingMsTotal,
      agentColor: this.agentColor,
      observedModel: this.observedModel,
      observedEffort: this.observedEffort,
      contextUsagePercent: this.contextUsagePercent,
      queuedMessageCount: this.queuedMessageCount,
      handoffTarget: this.handoffTarget,
      conversationPodiumId: this.conversationPodiumId,
      draftUpdatedAt: this.draftUpdatedAt,
      offer: this.offer ? structuredClone(this.offer) : undefined,
      transcriptAvailable: this.transcriptAvailable,
      terminal: this.terminal.captureState(),
    }
  }

  restoreDurableState(
    state: SessionDurableState,
    preserve: ReadonlySet<SessionVolatileField> = new Set(),
  ): void {
    this.cwd = state.cwd
    this.issueId = state.issueId
    this.refIssueId = state.refIssueId
    this.refLetter = state.refLetter
    this.refDraft = state.refDraft
    if (!preserve.has('machineId')) this.machineId = state.machineId
    this.resume = state.resume ? { ...state.resume } : undefined
    this.lastActiveAt = state.lastActiveAt
    this.title = state.title
    this.titleLocked = state.titleLocked
    this.name = state.name
    this.nameSource = state.nameSource
    this.archived = state.archived
    this.stoppedAt = state.stoppedAt
    this.stopReason = state.stopReason
    this.workState = state.workState
    this.cmd = state.cmd
    if (!preserve.has('status')) this.status = state.status
    this.exitCode = state.exitCode
    this.spawnFailure = state.spawnFailure
    this.agentState = state.agentState ? structuredClone(state.agentState) : undefined
    this.workingMsTotal = state.workingMsTotal
    this.incomingWorkingMsTotal = state.incomingWorkingMsTotal
    this.agentColor = state.agentColor
    this.observedModel = state.observedModel
    this.observedEffort = state.observedEffort
    this.contextUsagePercent = state.contextUsagePercent
    this.queuedMessageCount = state.queuedMessageCount
    if (!preserve.has('handoffTarget')) this.handoffTarget = state.handoffTarget
    this.conversationPodiumId = state.conversationPodiumId
    this.draftUpdatedAt = state.draftUpdatedAt
    this.offer = state.offer ? structuredClone(state.offer) : undefined
    this.transcriptAvailable = state.transcriptAvailable
    this.terminal.setTranscriptAvailable(state.transcriptAvailable)
    this.terminal.restoreState(state.terminal, preserve.has('geometry'))
  }

  toRow(): SessionRow {
    return {
      id: this.sessionId,
      ownerUserId: this.ownerUserId,
      agentKind: this.agentKind,
      model: this.model ?? null,
      effort: this.effort ?? null,
      accountId: this.accountId ?? null,
      cwd: this.cwd,
      title: this.title,
      name: this.name || null,
      nameSource: this.nameSource ?? null,
      archived: this.archived,
      workState: this.workState ?? null,
      originKind: this.origin.kind,
      conversationId: this.origin.kind === 'resume' ? this.origin.conversationId : null,
      resumeKind: this.resume?.kind ?? null,
      resumeValue: this.resume?.value ?? null,
      status: this.status,
      exitCode: this.exitCode ?? null,
      spawnFailure: this.spawnFailure ?? null,
      durableLabel: this.durableLabel,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      geometry: { ...this.terminal.geometry },
      ...(this.workingMsTotal !== undefined ? { workingMsTotal: this.workingMsTotal } : {}),
      inputCount: this.terminal.inputCount,
      outputCount: this.terminal.outputCount,
      activityCount: this.terminal.activityCount,
      lastOutputAt: Session.msToIso(this.terminal.lastOutputAtMs),
      lastInputAt: Session.msToIso(this.terminal.lastInputAtMs),
      lastResumedAt: Session.msToIso(this.terminal.lastResumedAtMs),
      spawnedBy: this.spawnedBy ?? null,
      ...(this.createdBy ? { createdBy: this.createdBy } : {}),
      machineId: this.machineId,
      headless: this.headless,
      issueId: this.issueId ?? null,
      refIssueId: this.refIssueId,
      refLetter: this.refLetter,
      refDraft: this.refDraft,
      stoppedAt: this.stoppedAt ?? null,
      stopReason: this.stopReason ?? null,
      workflowRunId: this.workflowRunId ?? null,
      workflowStepId: this.workflowStepId ?? null,
      executionProfileId: this.executionProfileId ?? null,
    }
  }

  private static msToIso(ms: number): string | null {
    return ms > 0 ? new Date(ms).toISOString() : null
  }

  /**
   * Project this session for ONE READER (POD-1076).
   *
   * `overlay` carries the caller's per-user markers — `readAt` from
   * `session_user_state`, `snoozedUntil` from `snoozes` — because both are facts
   * about a reader and neither is a field of the session. It is REQUIRED, not
   * optional with an empty default: an optional overlay is a mirror field with
   * extra steps, and "whoever forgot to pass it sees everything as unread" is the
   * failure mode this argument exists to make unreachable silently.
   *
   * The feed is still unscoped (ADR 2 D2), so today every caller passes the
   * broadcast viewer's overlay. POD-1077 passes the request's principal; the
   * signature does not change.
   */
  toMeta(overlay: SessionUserOverlay): SessionMeta {
    return {
      sessionId: this.sessionId,
      agentKind: this.agentKind,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.accountId ? { accountId: this.accountId } : {}),
      title: this.title,
      ...(this.name ? { name: this.name } : {}),
      ...(this.name && this.nameSource ? { nameSource: this.nameSource } : {}),
      cwd: this.cwd,
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.spawnFailure ? { spawnFailure: this.spawnFailure } : {}),
      ...(this.agentState ? { agentState: this.agentState } : {}),
      controllerId: this.terminal.controllerId,
      geometry: { ...this.terminal.geometry },
      epoch: this.terminal.epoch,
      clientCount: this.terminal.clientCount,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      // Last human (controller) input — the offer-artifact freshness fallback
      // [POD-120] compares issue-artifact addedAt against this on the client.
      ...(this.terminal.lastInputAtMs > 0
        ? { lastInputAt: new Date(this.terminal.lastInputAtMs).toISOString() }
        : {}),
      origin: this.origin,
      archived: this.archived,
      // Email-style read state (issue #124). unread = there is activity the operator
      // hasn't seen: never opened (readAt null), or lastActiveAt postdates readAt.
      // Both are ISO-8601, so the lexical compare is chronological.
      readAt: overlay.readAt,
      ...(this.stoppedAt ? { stoppedAt: this.stoppedAt } : {}),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      unread: overlay.readAt == null || this.lastActiveAt > overlay.readAt,
      // The registry overwrites machineName in listSessions() from the machines
      // table; an empty default keeps toMeta() self-contained for callers that
      // read it directly (e.g. tests on a Session in isolation).
      machineId: this.machineId,
      machineName: '',
      ...(this.workState ? { workState: this.workState } : {}),
      ...(this.resume ? { resumable: true, resume: this.resume } : {}),
      ...(this.transcriptAvailable ? { transcriptAvailable: true } : {}),
      ...(this.terminal.busy ? { busy: true } : {}),
      ...(this.agentColor ? { agentColor: this.agentColor } : {}),
      ...(this.observedModel ? { observedModel: this.observedModel } : {}),
      ...(this.observedEffort ? { observedEffort: this.observedEffort } : {}),
      ...(this.contextUsagePercent !== undefined
        ? { contextUsagePercent: this.contextUsagePercent }
        : {}),
      ...(overlay.snoozedUntil !== undefined ? { snoozedUntil: overlay.snoozedUntil } : {}),
      ...(this.draftUpdatedAt !== undefined ? { draftUpdatedAt: this.draftUpdatedAt } : {}),
      ...(this.draftSyncEngine ? { draftSyncEngine: true } : {}),
      ...(this.offer !== undefined ? { offer: this.offer } : {}), // [spec:SP-c7f1]
      ...(this.handoffTarget ? { handoffTarget: this.handoffTarget } : {}),
      ...(this.queuedMessageCount > 0 ? { queuedMessageCount: this.queuedMessageCount } : {}),
      ...(this.conversationPodiumId ? { conversationPodiumId: this.conversationPodiumId } : {}),
      ...(this.spawnedBy ? { spawnedBy: this.spawnedBy } : {}),
      // THE ATTRIBUTION PAIR ON THE WIRE (POD-1516). Server-stamped and read-only:
      // it is projected from the durable pair, and nothing a client sends reaches
      // it. Omitted when none was ever recorded — which is the ONLY thing its
      // absence means, because the spawn path always stamps one.
      ...(this.createdBy ? { createdBy: this.createdBy } : {}),
      ...(this.headless ? { headless: true } : {}),
      ...(this.issueId ? { issueId: this.issueId } : {}),
      ...(this.refIssueId ? { refIssueId: this.refIssueId } : {}),
      ...(this.refLetter ? { refLetter: this.refLetter } : {}),
      ...(this.refDraft != null ? { refDraft: this.refDraft } : {}),
      ...(this.workflowRunId ? { workflowRunId: this.workflowRunId } : {}),
      ...(this.workflowStepId ? { workflowStepId: this.workflowStepId } : {}),
      ...(this.executionProfileId ? { executionProfileId: this.executionProfileId } : {}),
    }
  }

  /** Parse a persisted work_state column; unknown strings read as unsorted. */
  static parseWorkState(raw: string | null): WorkState | undefined {
    if (raw === null) return undefined
    const parsed = WorkStateSchema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }
}
