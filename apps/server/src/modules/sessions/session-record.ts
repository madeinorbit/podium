import {
  type AccountId,
  AgentKind,
  type AgentRuntimeState,
  type Attribution,
  type HarnessAgent,
  type SessionDelegation,
  type SessionDesired,
  type SessionId,
  type SessionLifecycleFailure,
  type SessionMeta,
  type SessionOrigin,
  type UserId,
  type WorkState,
  WorkState as WorkStateSchema,
} from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { driverFamilyForId } from '../../harness-manifest'
import type { SessionLifecycleRow, SessionRow } from '../../store'
import { NO_LIFECYCLE } from '../../store/types'
import type { SessionDurableFields, SessionDurableState, SessionInit } from './session'

/**
 * THE TWO HALVES OF A SESSION, AS PLAIN VALUES (POD-6160, design §6).
 *
 * A session's DURABLE RECORD is its identity (fixed at birth) and its durable
 * state: what its row and satellites say, and what a restart restores. Its LIVE
 * PLANE is the terminal and the bound driver, which exist only while it runs.
 * A running session is a `Session` object holding both; a session that does not
 * run is only its record, read from the database (`records.ts`) and never built
 * into a `Session`.
 *
 * The functions here are the ONE definition of how a row becomes durable state
 * and how a session projects onto the wire. `Session`'s constructor and
 * `toMeta` call them, and so does a record, which is why a record and a session
 * restored at boot agree by construction (records.parity.test.ts proves it on
 * the benchmark corpus).
 */

/** The statuses of a session whose process runs or is expected back. */
export function isRunningStatus(status: SessionDurableFields['status']): boolean {
  return status === 'live' || status === 'starting'
}

/** Fixed for the life of the row: who, what and how it was born. */
export interface SessionIdentity {
  readonly sessionId: SessionId
  readonly ownerUserId: UserId
  readonly agentKind: AgentKind
  readonly origin: SessionOrigin
  readonly createdAt: string
  readonly durableLabel: string
  readonly spawnedBy: string | undefined
  readonly delegation: SessionDelegation | undefined
  readonly createdBy: Attribution | undefined
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly accountId: AccountId | undefined
  readonly loginHarness: HarnessAgent | undefined
  readonly workflowRunId: string | undefined
  readonly workflowStepId: string | undefined
  readonly agentProfileId: string | undefined
  readonly headless: boolean
}

/**
 * What server code reads off a session's terminal beside its durable state: the
 * last input time (the offer staleness rule) and whether it is busy (the
 * session facts). Neither reaches the synced record (POD-6764): clients read
 * them from the `session.condition` topic.
 */
export interface SessionLiveView {
  readonly lastInputAtMs: number
  readonly busy: boolean
}

/**
 * A SESSION THAT DOES NOT RUN: its identity and durable state, read from the
 * database, with the live plane at rest (no terminal anyone attached to, no
 * bound driver) exactly as a freshly restored `Session` reports it.
 */
export interface SessionRecord extends SessionIdentity, SessionDurableState {
  readonly live: SessionLiveView
}

export function identityFromInit(init: StoredSessionInit): SessionIdentity {
  return {
    sessionId: init.sessionId,
    ownerUserId: init.ownerUserId,
    agentKind: init.agentKind,
    origin: init.origin,
    createdAt: init.createdAt,
    durableLabel: init.durableLabel,
    spawnedBy: init.spawnedBy,
    delegation: init.delegation,
    createdBy: init.createdBy,
    model: init.model,
    effort: init.effort,
    accountId: init.accountId,
    loginHarness: init.loginHarness,
    workflowRunId: init.workflowRunId,
    workflowStepId: init.workflowStepId,
    agentProfileId: init.agentProfileId,
    headless: init.headless ?? false,
  }
}

/**
 * How close a kernel OOM kill has to be to a process death to be called its
 * cause (POD-2413).
 *
 * Wide enough for the supervisor's sampling lag in one direction and a slow
 * death in the other; narrow enough that a build OOM-killed inside a session
 * that keeps working for another few minutes never renames that session's
 * eventual, unrelated exit.
 */
export const OOM_ATTRIBUTION_WINDOW_MS = 60_000

/** Was a kernel OOM kill observed close enough to `exitedAtMs` to be its cause? */
export function oomExplainsExit(exitedAtMs: number, d: Pick<SessionDurableFields, 'oomKilledAt'>): boolean {
  if (!d.oomKilledAt) return false
  const killed = Date.parse(d.oomKilledAt)
  if (!Number.isFinite(killed) || !Number.isFinite(exitedAtMs)) return false
  return Math.abs(exitedAtMs - killed) <= OOM_ATTRIBUTION_WINDOW_MS
}

/**
 * The durable state a session is born or restored with.
 *
 * A stated resume ref is itself the proof of a conversation, so it promotes a
 * stored `conversationBinding`; a row read back as `exited` with a kernel OOM
 * kill beside it is an OOM death, by the same window the live path applies.
 */
export function durableStateFromInit(init: StoredSessionInit): SessionDurableState {
  const status = init.status ?? 'starting'
  const stoppedAt = init.stoppedAt ?? undefined
  let stopReason = init.stopReason ?? undefined
  let oomKilledAt = init.oomKilledAt ?? undefined
  if (oomKilledAt) {
    oomKilledAt = Number.isFinite(Date.parse(oomKilledAt)) ? oomKilledAt : new Date().toISOString()
    if (
      status === 'exited' &&
      stopReason === 'exited' &&
      oomExplainsExit(Date.parse(stoppedAt ?? ''), { oomKilledAt })
    ) {
      stopReason = 'oom'
    }
  }
  return {
    selectedDriverId: init.selectedDriverId,
    requestedDriverId: init.requestedDriverId,
    boundDriverId: init.boundDriverId,
    boundDriverCapabilities: init.boundDriverCapabilities,
    cwd: init.cwd,
    issueId: init.issueId,
    refIssueId: init.refIssueId ?? null,
    refLetter: init.refLetter ?? null,
    refDraft: init.refDraft ?? null,
    machineId: init.machineId,
    resume: init.resume,
    conversationBinding: init.resume ? 'bound' : init.conversationBinding,
    lastActiveAt: init.lastActiveAt ?? init.createdAt,
    title: init.title,
    titleLocked: false,
    name: init.name || '',
    nameSource: init.nameSource || undefined,
    archived: init.archived === true,
    stoppedAt,
    stopReason,
    oomKilledAt,
    workState: init.workState || undefined,
    lifecycle: init.lifecycle ?? NO_LIFECYCLE,
    cmd: '',
    status,
    exitCode: init.exitCode,
    spawnFailure: init.spawnFailure,
    agentState: undefined,
    workingMsTotal: init.workingMsTotal,
    incomingWorkingMsTotal: undefined,
    // Stored since POD-6764: a restart keeps what the transcript tail last
    // showed, and a move in flight keeps its target.
    agentColor: init.agentColor,
    observedModel: init.observedModel,
    observedEffort: init.observedEffort,
    requestedModel: init.requestedModel,
    requestedEffort: init.requestedEffort,
    draftSyncEngine: init.draftSyncEngine === true,
    handoffTargetMachineId: init.handoffTargetMachineId,
    conversationPodiumId: undefined,
    draftUpdatedAt: undefined,
    offer: undefined,
    transcriptAvailable: false,
  }
}

/** A stored ISO time as epoch milliseconds; absent or unparseable is 0. */
export function seedMs(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0
  return Number.isNaN(parsed) ? 0 : parsed
}

/** The live plane of a session nothing runs: its stored last input time, not busy. */
export function liveViewAtRest(init: Pick<SessionInit, 'lastInputAt'>): SessionLiveView {
  return { lastInputAtMs: seedMs(init.lastInputAt), busy: false }
}

/** A restored record: identity, durable state and the live plane at rest. */
export function recordFromInit(init: StoredSessionInit): SessionRecord {
  return { ...identityFromInit(init), ...durableStateFromInit(init), live: liveViewAtRest(init) }
}

/** A session's construction input, without the daemon and activity closures
 *  only a resident session has. */
export type StoredSessionInit = Omit<SessionInit, 'toDaemon' | 'sendInput' | 'onActivity'>

/** Parse a persisted work_state column; unknown strings read as unsorted. */
export function parseWorkState(raw: string | null): WorkState | undefined {
  if (raw === null) return undefined
  const parsed = WorkStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/**
 * HOW A STORED ROW IS RESTORED — the one mapping the boot load, an issue
 * restore and a durable record share. `undefined` for a row whose agent kind
 * is not one this build knows (the caller logs it).
 *
 * A boot restore keeps a live or starting row's status and marks it
 * `awaitingRebind`: its process may have survived the restart, and a daemon
 * rebind decides. A headless row is not marked (no terminal to reconnect). An
 * issue restore brings a tombstone back as `exited`: deletion killed its
 * runtime.
 */
export function storedSessionInit(
  r: SessionRow,
  mode: 'boot' | 'restore',
  ownerFallback: UserId,
): StoredSessionInit | undefined {
  const kind = AgentKind.safeParse(r.agentKind)
  if (!kind.success) return undefined
  const reloadStatus = mode === 'restore' ? 'exited' : r.status
  const awaitingRebind =
    mode === 'boot' && !r.headless && (r.status === 'live' || r.status === 'starting')
  const exitCode = mode === 'restore' || r.status !== 'exited' ? null : r.exitCode
  return {

    sessionId: r.id,
    ownerUserId: r.ownerUserId ?? ownerFallback,
    agentKind: kind.data,
    cwd: r.cwd,
    title: r.title,
    origin:
      r.originKind === 'resume'
        ? { kind: 'resume', conversationId: r.conversationId ?? '' }
        : { kind: 'spawn' },
    createdAt: r.createdAt,
    geometry: { ...(r.geometry ?? { cols: 80, rows: 24 }) },
    machineId: r.machineId,
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
    ...(awaitingRebind ? { awaitingRebind: true } : {}),
    exitCode: exitCode ?? undefined,
    ...(exitCode === -1 && r.spawnFailure ? { spawnFailure: r.spawnFailure } : {}),
    ...(r.name ? { name: r.name } : {}),
    // Survives a restart — otherwise a reboot would forget that the USER named this
    // session and the next agent title would sail straight through (#490).
    ...(r.name && r.nameSource ? { nameSource: r.nameSource } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
    /**
     * THE RUNTIME REQUEST SURVIVES THE RESTART (POD-3081). Without this line
     * the columns are written and never read back, which is worse than not
     * having them: a reconfigured session comes back displaying the model it
     * was LAUNCHED with while its driver — whose own journal did survive —
     * goes on answering as the one it was configured to. That is the
     * requested-vs-observed split saying the thing it exists to prevent.
     *
     * Absent on the row = never configured, which is different from
     * "configured back to the launch value" and must stay different.
     */
    ...(r.requestedModel ? { requestedModel: r.requestedModel } : {}),
    ...(r.requestedEffort ? { requestedEffort: r.requestedEffort } : {}),
    ...(r.accountId ? { accountId: r.accountId } : {}),
    ...(r.loginHarness ? { loginHarness: r.loginHarness } : {}),
    ...(r.spawnedBy ? { spawnedBy: r.spawnedBy } : {}),
    // The pair survives a restart. Absent on the row = none was ever recorded
    // (a session from before the columns existed); it is not reconstructed here
    // from ownerUserId or spawnedBy, which would invent one.
    ...(r.delegation ? { delegation: r.delegation } : {}),
    ...(r.createdBy ? { createdBy: r.createdBy } : {}),
    ...(r.headless ? { headless: true } : {}),
    ...(r.issueId ? { issueId: r.issueId } : {}),
    ...(r.refIssueId ? { refIssueId: r.refIssueId } : {}),
    ...(r.refLetter ? { refLetter: r.refLetter } : {}),
    ...(r.refDraft != null ? { refDraft: r.refDraft } : {}),
    ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
    ...(r.workflowStepId ? { workflowStepId: r.workflowStepId } : {}),
    ...(r.agentProfileId ? { agentProfileId: r.agentProfileId } : {}),
    archived: r.archived,
    stoppedAt: r.stoppedAt ?? null,
    stopReason: r.stopReason ?? null,
    ...(r.lifecycle ? { lifecycle: r.lifecycle } : {}),
    ...(parseWorkState(r.workState)
      ? { workState: parseWorkState(r.workState) }
      : {}),
    ...(r.resumeKind && r.resumeValue
      ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
      : {}),
    /**
     * THE FIX THIS COLUMN EXISTS FOR (POD-2290 round 2). A boot restore holds a
     * persisted live/starting row with no daemon bound until one rebinds, and
     * such a row with no driver family is exactly where the panel falls
     * back to "assume a terminal" — the original bug's screen, driven live by
     * the reviewer with the daemon held down. `driverId` is deliberately NOT
     * restored beside it: that one names a live handle, and this row has none
     * until a daemon rebinds.
     */
    ...(r.selectedDriverId ? { selectedDriverId: r.selectedDriverId } : {}),
    ...(r.requestedDriverId ? { requestedDriverId: r.requestedDriverId } : {}),
    ...(r.boundDriverId ? { boundDriverId: r.boundDriverId } : {}),
    ...(r.boundDriverCapabilities ? { boundDriverCapabilities: r.boundDriverCapabilities } : {}),
    // What a daemon last reported and the transcript tail last showed (POD-6764).
    // They describe the session until it starts again, when a bind and the
    // tail's seed window state them afresh.
    ...(r.draftSyncEngine ? { draftSyncEngine: true } : {}),
    ...(r.agentColor ? { agentColor: r.agentColor } : {}),
    ...(r.observedModel ? { observedModel: r.observedModel } : {}),
    ...(r.observedEffort ? { observedEffort: r.observedEffort } : {}),
    ...(r.handoffTargetMachineId ? { handoffTargetMachineId: r.handoffTargetMachineId } : {}),
    // Passed through, never defaulted: a row from before this column exists
    // makes no claim about whether its launch ever had a conversation, and
    // inventing `'never'` for it would authorize discarding one.
    ...(r.conversationBinding ? { conversationBinding: r.conversationBinding } : {}),
  }
}

/** Has this launch PROVABLY never had a native conversation (POD-2392)? */
export function isNeverBound(d: Pick<SessionDurableFields, 'conversationBinding' | 'resume'>): boolean {
  return d.conversationBinding === 'never' && d.resume === undefined
}

/** Record that this launch has a native conversation. One-way: never writes `'never'`. */
export function markConversationBound(d: Pick<SessionDurableFields, 'conversationBinding'>): void {
  d.conversationBinding = 'bound'
}

/** Fold an accepted observation checkpoint into durable state. */
export function applyObservationCheckpointTo(
  d: SessionDurableFields,
  checkpoint: SessionObservationCheckpointV1,
  advanceRecency = true,
): void {
  const state = checkpoint.turnState
  d.workingMsTotal = state.workingMsTotal
  d.incomingWorkingMsTotal = undefined
  d.agentState = state
  const providerAt = checkpoint.providerAt
  if (advanceRecency && providerAt && providerAt > d.lastActiveAt) d.lastActiveAt = providerAt
  // An observer bound to a concrete provider thread is a conversation, even
  // if no `sessionResumeRef` ever reached us — this is the arm that closes the
  // gap for a harness whose id we learn only through the observation plane.
  if (checkpoint.providerSessionId) markConversationBound(d)
}

/**
 * Restore a runtime-driven session's turn state (POD-6160 D2h): the phase and
 * working time its runtime checkpoint recorded with its last event. Its
 * working total is the row's already; the state is what a restart lost.
 */
export function applyRuntimeTurnStateTo(d: SessionDurableFields, state: AgentRuntimeState): void {
  d.agentState = state
  d.incomingWorkingMsTotal = undefined
}

/**
 * THE wire projection of a session's shared facts (S6): identity and durable
 * state (the live object's or a draft's).
 *
 * EVERY INPUT IS STORED (POD-6764). Nothing here reads a terminal or a bound
 * driver handle, so a record read from the database and a session running in
 * this process project the same value, and the record can be built by any
 * process by id. What only a running process knows (who controls the terminal
 * and at what size, busy, gated requests, last input time, context use, how
 * many clients watch) is not a record field: clients read it from the
 * `session.terminalState` and `session.condition` topics and the presence room.
 */
export function projectSessionMeta(s: SessionIdentity, d: SessionDurableFields): SessionMeta {
  // BOUND WINS OVER SELECTED, and both beat nothing (POD-2290). The selection
  // is what the daemon decided before it started the harness; the binding is
  // what it ended up with. They agree on every path that works, and where
  // they can differ — a launch that failed and fell back — the one that
  // describes a running session has to win.
  // The binding is the STORED one: what a daemon last bound, written with the
  // bind. A server restart does not change the daemon's binding, and the live
  // handle (`Session.driverId`) stays server-side routing state.
  const driverId = d.boundDriverId
  const configureFields = d.boundDriverCapabilities?.configureFields
  const attachKinds = d.boundDriverCapabilities?.attachKinds
  const driverFamily = driverFamilyForId(driverId ?? d.selectedDriverId ?? '')
  return {
    sessionId: s.sessionId,
    agentKind: s.agentKind,
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.accountId ? { accountId: s.accountId } : {}),
    title: d.title,
    ...(d.name ? { name: d.name } : {}),
    ...(d.name && d.nameSource ? { nameSource: d.nameSource } : {}),
    cwd: d.cwd,
    status: d.status,
    ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
    ...(d.spawnFailure ? { spawnFailure: d.spawnFailure } : {}),
    ...(d.agentState ? { agentState: d.agentState } : {}),
    createdAt: s.createdAt,
    lastActiveAt: d.lastActiveAt,
    origin: s.origin,
    archived: d.archived,
    ...(d.stoppedAt ? { stoppedAt: d.stoppedAt } : {}),
    ...(d.stopReason ? { stopReason: d.stopReason } : {}),
    machineId: d.machineId,
    ...(d.workState ? { workState: d.workState } : {}),
    ...lifecycleWire(d.lifecycle),
    ...(d.resume ? { resumable: true, resume: d.resume } : {}),
    // ONLY when proven. A recovery surface reads this to offer starting the
    // agent again instead of removing the row, so its absence has to stay the
    // safe answer for every session whose history we cannot vouch for.
    ...(isNeverBound(d) ? { neverBound: true as const } : {}),
    ...(d.transcriptAvailable ? { transcriptAvailable: true } : {}),
    ...(d.agentColor ? { agentColor: d.agentColor } : {}),
    ...(d.observedModel ? { observedModel: d.observedModel } : {}),
    ...(d.observedEffort ? { observedEffort: d.observedEffort } : {}),
    ...(d.requestedModel ? { requestedModel: d.requestedModel } : {}),
    ...(d.requestedEffort ? { requestedEffort: d.requestedEffort } : {}),
    // POD-3087. Published even when EMPTY, because empty is an answer — "this
    // driver changes nothing" — and a client that could not tell it from
    // "nobody told me" would hide the control on both.
    ...(configureFields ? { configureFields: [...configureFields] } : {}),
    ...(attachKinds ? { attachKinds: [...attachKinds] } : {}),
    ...(d.draftUpdatedAt !== undefined ? { draftUpdatedAt: d.draftUpdatedAt } : {}),
    ...(d.draftSyncEngine ? { draftSyncEngine: true } : {}),
    ...(d.offer !== undefined ? { offer: d.offer } : {}), // [spec:SP-c7f1]
    ...(d.handoffTargetMachineId ? { handoffTargetMachineId: d.handoffTargetMachineId } : {}),
    ...(driverId ? { driverId } : {}),
    ...(d.requestedDriverId ? { requestedDriverId: d.requestedDriverId } : {}),
    // The bound driver's FAMILY, so a client can pick a surface without
    // learning driver ids (POD-2290). Resolved through the manifests — the
    // same lookup the reap guard uses — and omitted when the id is absent or
    // no manifest claims it, because for this field absent means UNKNOWN and
    // every client reads unknown as "assume a terminal".
    //
    // THIS ASSIGNMENT IS ALSO THE ONLY THING KEEPING THE TWO SPELLINGS OF THE
    // TAXONOMY IN SYNC. `DriverFamily` lives in `@podium/harness` beside the
    // manifest axis that declares it; the wire field is a zod enum in
    // `@podium/model`, which may not import harness. Nothing reconciles them
    // except this line, where a `DriverFamily` flows into the enum's type — so
    // a fourth family added to the manifests fails HERE, at typecheck, rather
    // than being silently dropped from every client's view.
    ...(driverFamily ? { driverFamily } : {}),
    ...(d.conversationPodiumId ? { conversationPodiumId: d.conversationPodiumId } : {}),
    ...(s.spawnedBy ? { spawnedBy: s.spawnedBy } : {}),
    // THE ATTRIBUTION PAIR ON THE WIRE (POD-1516). Server-stamped and read-only:
    // it is projected from the durable pair, and nothing a client sends reaches
    // it. Omitted when none was ever recorded — which is the ONLY thing its
    // absence means, because the spawn path always stamps one.
    ...(s.delegation ? { delegation: s.delegation } : {}),
    ...(s.createdBy ? { createdBy: s.createdBy } : {}),
    ...(s.headless ? { headless: true } : {}),
    ...(d.issueId ? { issueId: d.issueId } : {}),
    ...(d.refIssueId ? { refIssueId: d.refIssueId } : {}),
    ...(d.refLetter ? { refLetter: d.refLetter } : {}),
    ...(d.refDraft != null ? { refDraft: d.refDraft } : {}),
    ...(s.workflowRunId ? { workflowRunId: s.workflowRunId } : {}),
    ...(s.workflowStepId ? { workflowStepId: s.workflowStepId } : {}),
    ...(s.agentProfileId ? { agentProfileId: s.agentProfileId } : {}),
  }
}

/**
 * The lifecycle on the wire (POD-6356): each key only when it says something,
 * so a session nobody has edited projects exactly as before. An absent
 * `revision` or `observedRevision` reads as 1.
 */
export function lifecycleWire(l: SessionLifecycleRow): {
  desired?: SessionDesired
  force?: boolean
  revision?: number
  observedRevision?: number
  lifecycleFailure?: SessionLifecycleFailure
} {
  return {
    ...(l.desired ? { desired: l.desired } : {}),
    ...(l.desired && l.force ? { force: true } : {}),
    ...(l.revision !== 1 ? { revision: l.revision } : {}),
    ...(l.observedRevision !== 1 ? { observedRevision: l.observedRevision } : {}),
    ...(l.failure ? { lifecycleFailure: l.failure } : {}),
  }
}
