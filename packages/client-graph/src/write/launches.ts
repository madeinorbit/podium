/**
 * A START, PAINTED FROM ITS LAUNCH EFFECT (ADR 12 D5; POD-6408, POD-6410).
 *
 * Starting an agent is an effect record the device writes with ids it minted:
 * a draft-agent start is `session.launch` (its target the session; the server
 * makes its draft task), and a named task with its first agent is
 * `issue.start` (its target the issue; the session id rides in its input).
 * The server runs it when a daemon can take it. This paints the starting
 * session, and its task, for as long as that start is on its way, from DATA
 * only, and no timer:
 *
 *  - while the create is queued or awaiting confirmation: from the outbox entry;
 *  - after it is confirmed: from its effect record (the pool's effect model),
 *    `pending` or `running` (also for hours while the machine is offline), and
 *    through a reload, because both sources are durable;
 *  - `succeeded`: still the placeholders until the rows under those ids
 *    arrive, then the rows (the transaction log retires a placeholder exactly
 *    when its row lands), so the handover has no gap in either arrival order;
 *  - `failed`, `expired`, `cancelled`, `unknown`: the session painted as exited
 *    with the error, until Dismiss takes the record off the feed
 *    (`effects.dismiss`). An `issue.start` that filed its task and then failed
 *    to start its agent keeps the task: the failed session shows on it.
 *  - its create REFUSED: one parked for recovery (it carries typed text) leaves
 *    the paint, and the recovery surface offers retry and discard. One the
 *    queue discarded (POD-6622) is in no list the paint reads, which is how a
 *    refused start used to stay "starting" for ever: it is painted ended with
 *    the refusal instead, and Dismiss lets it go here (nothing was recorded).
 *
 * A session started on an EXISTING issue (POD-6526) is `issue.begin` (its
 * first session, with its worktree) or `issue.addSession` (one more agent, or
 * a shell): the target is the issue, which is already a row, and the session
 * id rides in the input. Only the session is painted, in the issue's checkout.
 * A begin of an issue that was already started is the server's deliberate
 * no-op: its record succeeds naming no session of ours, and the paint goes.
 */

import type { OverlayTarget, PendingOverlay } from '@podium/client-core/command-reducers'
import { insertOverlay } from '@podium/client-core/command-reducers'
import type { SpawnPlaceholderEvent, StoreNotices } from '@podium/client-core/engine'
import { randomUUID } from '@podium/client-core/id'
import type { OutboxEntry } from '@podium/client-core/outbox'
import type { IssueViewModel } from '@podium/client-core/replica'
import {
  draftLaunchEffect,
  type EffectCreateInput,
  ISSUE_ADD_SESSION_KIND,
  ISSUE_BEGIN_KIND,
  ISSUE_START_KIND,
  ISSUE_START_PROPOSED,
  type IssueSessionMode,
  issueSessionEffect,
  issueStartEffect,
  type LaunchSessionArgs,
  SESSION_LAUNCH_KIND,
  type SpawnDraftAgentArgs,
  type SpawnIssueAgentArgs,
  type SpawnTarget,
  type StartIssueSessionArgs,
  sessionLaunchEffect,
  startEffectId,
  type TaskSpawnOutcome,
} from '@podium/client-core/spawn-agent'
import {
  type AgentKind,
  asIssueId,
  asMutationId,
  asSessionId,
  type EffectRecordWire,
  type IssueBoardStage,
  type IssueId,
  IssueProjection,
  type MachineId,
  type MutationId,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import { draftIssueRow, startedIssueRow, starterUserState, startingSessionRow } from './launch-rows'

export interface PoolLaunchPorts {
  readonly userId: UserId
  readonly notices: StoreNotices
  truth(entity: OverlayTarget, id: string): object | undefined
  sortKey(target: SpawnTarget): string
  paint(event: SpawnPlaceholderEvent): void
  /** Queue one effect command through the transaction log. */
  write(
    kind: 'effectCreate' | 'effectDismiss',
    input: EffectCreateInput | { id: string },
  ): Promise<void>
  /** The outbox's queued and awaiting entries, in order. */
  queued(): readonly OutboxEntry[]
  /** The outbox's refused entries (dead letters). */
  refused(): readonly { readonly kind: string; readonly input: unknown }[]
  /** The effect records of the start kinds (`session.launch`, `issue.start`,
   *  `issue.begin`, `issue.addSession`): in the app, the pool's own effect
   *  models (POD-6411). */
  launchEffects(): Iterable<LaunchRecord>
}

/** What a start paints from of its effect record: a wire record or the pool's
 *  `EffectModel`, which answers the same fields. */
export type LaunchRecord = Readonly<
  Pick<EffectRecordWire, 'kind' | 'target' | 'input' | 'createdAt' | 'effect'>
> & {
  /** The kind's answer: a begin's names the session it started, if any. */
  readonly result?: unknown
  readonly id: string
}

const ENDED = new Set(['failed', 'expired', 'cancelled', 'unknown'])

const PROPOSED_NOTICE = 'Filed as a proposal; an admin starts it.'

/** Why the server refused a start's create, in the words a failed start shows.
 *  The queue's durable reason (`OutboxRejectionReason`) carries a code only:
 *  `unauthorized` covers a target the caller may not see too (no oracle). */
export function refusedStartText(reason: unknown): string {
  const code =
    reason !== null && typeof reason === 'object' ? (reason as { code?: unknown }).code : undefined
  switch (code) {
    case 'unauthorized':
      return 'the server refused it: you may not start it there'
    case 'conflict':
      return 'the server refused it: it was already started'
    case 'invalid':
      return 'the server refused it as invalid'
    case 'confirmation-required':
      return 'the server refused it until it is confirmed'
    case 'max-age':
      return 'it waited too long to be sent'
    default:
      return 'the server refused it'
  }
}

/** What a refused start's rejection names: the queued kind and its input. */
export interface RefusedStart {
  readonly kind: string
  readonly input: unknown
  /** Parked for recovery (it carries typed text): the recovery surface holds
   *  it, with retry and discard, and the paint goes (`refused()` port). */
  readonly parked: boolean
  readonly reason?: unknown
}

/** An `issue.start` the family filed as a proposal: no agent by design. */
const isProposal = (launch: Launch): boolean =>
  launch.kind === ISSUE_START_KIND &&
  launch.status === 'failed' &&
  launch.errorCode === ISSUE_START_PROPOSED

/** The start kinds this paints. */
type LaunchKind =
  | typeof SESSION_LAUNCH_KIND
  | typeof ISSUE_START_KIND
  | typeof ISSUE_BEGIN_KIND
  | typeof ISSUE_ADD_SESSION_KIND

/** A session started on an existing issue (POD-6526): the issue is a row. */
const onExistingIssue = (kind: LaunchKind): boolean =>
  kind === ISSUE_BEGIN_KIND || kind === ISSUE_ADD_SESSION_KIND

interface Launch {
  readonly effectId: string
  readonly kind: LaunchKind
  readonly sessionId: SessionId
  /** The task it starts in: its draft task, or the named task it files. */
  readonly issueId: IssueId | undefined
  readonly input: LaunchInput
  readonly createdAt: string
  /** `queued` before the server has the record. */
  readonly status: string
  readonly error?: string
  /** The record's error code: `proposed` is a proposal, not a failure. */
  readonly errorCode?: string
  /** It succeeded and started no session under this id: a begin of an issue
   *  that was already started (the server's deliberate no-op). */
  readonly startedNothing?: boolean
}

/** What a start's published input says about where it starts. */
interface LaunchInput {
  readonly agentKind?: AgentKind
  readonly cwd?: string
  readonly machineId?: MachineId
  readonly draftIssue?: { readonly repoPath: string; readonly issueId: IssueId }
  /** A plain start's existing task (POD-6523): joined, never painted. */
  readonly issueId?: IssueId
  // `issue.start`: the create's fields (the description only while queued here).
  readonly sessionId?: SessionId
  readonly repoPath?: string
  readonly title?: string
  readonly description?: string
  readonly brief?: string
  readonly parentBranch?: string
  readonly defaultAgent?: AgentKind
  readonly defaultModel?: string
  readonly defaultEffort?: string
  // `issue.begin` / `issue.addSession` (POD-6526).
  readonly shell?: boolean
  readonly priority?: number
  readonly stage?: IssueBoardStage
}

/** The start an effect create or record describes, or none for another kind. */
function launchOf(
  effect: {
    readonly id: string
    readonly kind: string
    readonly target?: { kind: string; id: string }
  },
  input: LaunchInput,
): Pick<Launch, 'effectId' | 'kind' | 'sessionId' | 'issueId' | 'input'> | undefined {
  if (effect.kind === SESSION_LAUNCH_KIND && effect.target?.kind === 'session') {
    return {
      effectId: effect.id,
      kind: SESSION_LAUNCH_KIND,
      sessionId: effect.target.id as SessionId,
      issueId: input.draftIssue?.issueId ?? input.issueId,
      input,
    }
  }
  if (
    (effect.kind === ISSUE_START_KIND ||
      effect.kind === ISSUE_BEGIN_KIND ||
      effect.kind === ISSUE_ADD_SESSION_KIND) &&
    effect.target?.kind === 'issue' &&
    input.sessionId
  ) {
    return {
      effectId: effect.id,
      kind: effect.kind,
      sessionId: input.sessionId,
      issueId: effect.target.id as IssueId,
      input,
    }
  }
  return undefined
}

/** Whether a succeeded start's answer names the session it started under
 *  `sessionId`. A begin of an already-started issue answers the issue alone
 *  (no `agentId`); a spawn that ran before answers `sessionId`. */
function startedSession(result: unknown, sessionId: SessionId): boolean {
  if (result === null || typeof result !== 'object') return false
  const answer = result as { agentId?: unknown; sessionId?: unknown }
  return answer.agentId === sessionId || answer.sessionId === sessionId
}

interface Painted {
  readonly effectId: string
  readonly issueId: IssueId | undefined
  readonly ended: boolean
  /** The task's placeholder is among the overlays (it is not a row yet). */
  readonly withIssue: boolean
  /** Filed as a proposal: the task alone, no session (POD-6410). */
  readonly proposed: boolean
}

const PROJECTION_KEYS = Object.keys(IssueProjection.shape)

export class PoolLaunches {
  private disposed = false
  /** Launch placeholders this pool paints, by session id. */
  private readonly painted = new Map<SessionId, Painted>()
  /** What this device knows of a start it made itself (its repo, its prompt). */
  private readonly local = new Map<
    SessionId,
    {
      target: SpawnTarget
      /** The agent it starts: painted also when the record names none. */
      agentKind?: AgentKind
      prompt?: string
      description?: string
      brief?: string
    }
  >()
  private readonly settlers = new Map<SessionId, (started: boolean) => void>()
  /** Own named-task starts waiting to learn whether they became a proposal. */
  private readonly proposals = new Map<SessionId, (proposed: boolean) => void>()
  private readonly waiters = new Map<SessionId, Set<() => void>>()
  /** Failures already told, so a reload or a repaint never tells one twice. */
  private readonly told = new Set<string>()
  /** Starts whose create this device is still writing: live, though the queue
   *  may not list them yet. */
  private readonly writing = new Set<SessionId>()
  /** Own starts whose record this pool has seen: from then on, the record's
   *  absence means it was dismissed. Before, it is on its way (the replica's
   *  commit that retires the entry is the one that brings the record). */
  private readonly recorded = new Set<SessionId>()
  /** Starts whose create the server refused (POD-6622): no record will come.
   *  Painted ended with the refusal until dismissed here, or until a retry of
   *  the same create is queued again. */
  private readonly refusedCreates = new Map<SessionId, Launch>()

  constructor(private readonly ports: PoolLaunchPorts) {}

  /** Paint a starting session and its draft task, then queue its launch. */
  spawnDraftAgent(args: SpawnDraftAgentArgs): {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
  } {
    if (this.disposed) throw new Error('PoolLaunches: spawn after dispose')
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issueId = args.issueId ?? asIssueId(`iss_${randomUUID()}`)
    const create = draftLaunchEffect({
      effectId: `eff_${randomUUID()}`,
      sessionId,
      issueId,
      target: args.target,
      agentKind: args.agentKind,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      ...(args.firstPrompt ? { firstPrompt: args.firstPrompt } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.requestedDriverId !== undefined
        ? { requestedDriverId: args.requestedDriverId }
        : {}),
    })
    this.local.set(sessionId, {
      target: args.target,
      ...(args.firstPrompt ? { prompt: args.firstPrompt } : {}),
    })
    const settled = new Promise<boolean>((resolve) => this.settlers.set(sessionId, resolve))
    this.begin(create, sessionId, 'agent')
    return { sessionId, issueId, settled }
  }

  /** Paint a starting session in a folder (and the task it joins, which is
   *  already a row), then queue its launch (POD-6523). */
  launchSession(args: LaunchSessionArgs): { sessionId: SessionId; settled: Promise<boolean> } {
    if (this.disposed) throw new Error('PoolLaunches: spawn after dispose')
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const create = sessionLaunchEffect({
      effectId: `eff_${randomUUID()}`,
      sessionId,
      target: args.target,
      agentKind: args.agentKind,
      ...(args.issueId !== undefined ? { issueId: args.issueId } : {}),
      ...(args.requestedDriverId !== undefined
        ? { requestedDriverId: args.requestedDriverId }
        : {}),
    })
    this.local.set(sessionId, { target: args.target })
    const settled = new Promise<boolean>((resolve) => this.settlers.set(sessionId, resolve))
    this.begin(create, sessionId, 'agent')
    return { sessionId, settled }
  }

  /** Paint a named task, its first session and its first chat turn, then
   *  queue the `issue.start` that files and starts it. */
  spawnIssueAgent(args: SpawnIssueAgentArgs): {
    sessionId: SessionId
    issueId: IssueId
    mutationId: MutationId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
    /** True once its record says the task was filed as a proposal (no agent
     *  comes); false when it ends any other way. */
    proposed: Promise<boolean>
  } {
    if (this.disposed) throw new Error('PoolLaunches: spawn after dispose')
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issueId = args.issueId ?? asIssueId(`iss_${randomUUID()}`)
    const mutationId = args.mutationId ?? asMutationId(randomUUID())
    const create = issueStartEffect({
      // The reservation's own record: a retry of this start writes it again.
      effectId: startEffectId(mutationId, randomUUID),
      sessionId,
      issueId,
      target: args.target,
      title: args.title,
      description: args.description,
      ...(args.brief !== undefined ? { brief: args.brief } : {}),
      ...(args.parentBranch !== undefined ? { parentBranch: args.parentBranch } : {}),
      agentKind: args.agentKind,
      ...(args.inheritAgent ? { inheritAgent: true } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.stage !== undefined ? { stage: args.stage } : {}),
    })
    this.local.set(sessionId, {
      target: args.target,
      agentKind: args.agentKind,
      ...(args.description ? { prompt: args.description, description: args.description } : {}),
      ...(args.brief ? { brief: args.brief } : {}),
    })
    const settled = new Promise<boolean>((resolve) => this.settlers.set(sessionId, resolve))
    const proposed = new Promise<boolean>((resolve) => this.proposals.set(sessionId, resolve))
    this.begin(create, sessionId, 'task')
    // Durably queued is started: the record carries the task and survives a
    // reload, and a later failure shows on the task's session.
    const outcome = settled.then((ok): TaskSpawnOutcome => (ok ? 'started' : 'failed'))
    return { sessionId, issueId, mutationId, settled, outcome, proposed }
  }

  /**
   * Paint a session starting on an existing issue, then queue its
   * `issue.begin` or `issue.addSession` (POD-6526): the issue's first session
   * with its worktree, one more agent, or a shell. Without a mode it adds an
   * agent, or begins the issue when it has never been started (no branch; a
   * freed checkout keeps its branch, and adding rebuilds it there).
   */
  startIssueSession(args: StartIssueSessionArgs): {
    sessionId: SessionId
    effectId: string
    mode: IssueSessionMode
    settled: Promise<boolean>
  } {
    if (this.disposed) throw new Error('PoolLaunches: spawn after dispose')
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issue = this.issueRow(args.issueId)
    const mode: IssueSessionMode =
      args.mode ?? (issue !== undefined && !issue.branch && !issue.worktreePath ? 'begin' : 'agent')
    const effectId =
      mode === 'begin' ? startEffectId(args.mutationId, randomUUID) : `eff_${randomUUID()}`
    const create = issueSessionEffect({
      effectId,
      issueId: args.issueId,
      sessionId,
      mode,
      ...(args.agentKind !== undefined ? { agentKind: args.agentKind } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
      ...(args.forceUnknownModel === true ? { forceUnknownModel: true } : {}),
    })
    const path = issue?.worktreePath ?? issue?.repoPath ?? ''
    this.local.set(sessionId, {
      target: {
        path,
        repoPath: issue?.repoPath ?? path,
        ...(issue?.machineId ? { machineId: issue.machineId as MachineId } : {}),
      },
    })
    const settled = new Promise<boolean>((resolve) => this.settlers.set(sessionId, resolve))
    this.begin(create, sessionId, mode === 'shell' ? 'shell' : 'agent')
    return { sessionId, effectId, mode, settled }
  }

  /** The issue's row as the pool holds it, for where its session starts. */
  private issueRow(issueId: IssueId):
    | {
        readonly branch?: string | null
        readonly worktreePath?: string | null
        readonly repoPath?: string
        readonly machineId?: string | null
        readonly defaultAgent?: string | null
      }
    | undefined {
    return this.ports.truth('issueProjections', issueId) as
      | ReturnType<PoolLaunches['issueRow']>
      | undefined
  }

  /** Paint an own start as queued and write its create. */
  private begin(
    create: EffectCreateInput,
    sessionId: SessionId,
    subject: 'agent' | 'task' | 'shell',
  ): void {
    const launch = launchOf(create, create.input as LaunchInput)
    if (launch === undefined) throw new Error(`PoolLaunches: not a start (${create.kind})`)
    this.show({ ...launch, createdAt: new Date().toISOString(), status: 'queued' })
    this.writing.add(sessionId)
    void this.ports.write('effectCreate', create).then(
      () => {
        this.writing.delete(sessionId)
        // Durably queued: the launch carries the prompt and survives a reload,
        // so the composer may let go. A later failure shows on the session.
        this.settle(sessionId, true)
        this.reconcile()
      },
      (error: unknown) => {
        this.writing.delete(sessionId)
        if (this.disposed) return
        this.hide(sessionId)
        this.ports.notices.error(
          `Couldn't start the ${subject} — ${error instanceof Error ? error.message : 'unknown error'}`,
        )
        this.settle(sessionId, false)
        this.answer(sessionId, false)
      },
    )
  }

  /** Whether any start is painted: only then can a late record move the paint. */
  get painting(): boolean {
    return this.painted.size > 0
  }

  /** Whether this pool paints a launch for the session (it is not a row yet). */
  owns(sessionId: string): boolean {
    return this.painted.has(sessionId as SessionId)
  }

  /** Resolves once the session row exists or its launch has ended. */
  waitForSpawnConfirmed(sessionId: SessionId): Promise<void> {
    const painted = this.painted.get(sessionId)
    if (this.disposed || painted === undefined || painted.ended) return Promise.resolve()
    return new Promise((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set()
      this.waiters.set(sessionId, set)
      set.add(resolve)
    })
  }

  /** Dismiss an ended launch: true when the session was one. */
  dismiss(sessionId: SessionId): boolean {
    const painted = this.painted.get(sessionId)
    if (painted === undefined || !painted.ended) return false
    this.hide(sessionId)
    this.local.delete(sessionId)
    // A refused create made no record: there is nothing to take off the feed.
    if (this.refusedCreates.delete(sessionId)) return true
    void this.ports.write('effectDismiss', { id: painted.effectId }).catch(() => {})
    return true
  }

  /**
   * The server refused a start's create and the queue let it go (POD-6622):
   * nothing was written, so no record will ever end it, and no list this reads
   * holds it. It is painted ended with the refusal, here, where it was
   * started, until dismissed. A parked refusal is the recovery surface's.
   */
  refused(rejection: RefusedStart): void {
    if (this.disposed || rejection.parked || rejection.kind !== 'effectCreate') return
    const create = rejection.input as EffectCreateInput
    const launch = launchOf(create, (create.input ?? {}) as LaunchInput)
    if (launch === undefined) return
    if (!this.local.has(launch.sessionId) && !this.painted.has(launch.sessionId)) return
    this.refusedCreates.set(launch.sessionId, {
      ...launch,
      createdAt: new Date().toISOString(),
      status: 'failed',
      error: refusedStartText(rejection.reason),
      errorCode: 'refused',
    })
    this.reconcile()
  }

  /**
   * Bring the paint in line with the data: the queued creates and the launch
   * records. Called on every outbox change, every replica batch and every
   * change of the records themselves; idempotent.
   */
  reconcile(): void {
    if (this.disposed) return
    const live = new Map<SessionId, Launch>()
    // A dismiss on its way: the record leaves the feed when the server has it,
    // and until then it is gone here too.
    const dismissing = new Set<string>()
    for (const entry of this.ports.queued()) {
      if (entry.kind === 'effectDismiss') dismissing.add((entry.input as { id: string }).id)
    }
    for (const entry of this.ports.queued()) {
      if (entry.kind !== 'effectCreate') continue
      const create = entry.input as EffectCreateInput
      const launch = launchOf(create, (create.input ?? {}) as LaunchInput)
      if (launch === undefined) continue
      live.set(launch.sessionId, {
        ...launch,
        createdAt: new Date(entry.queuedAt).toISOString(),
        status: 'queued',
      })
    }
    for (const record of this.ports.launchEffects()) {
      const launch = launchOf(record, (record.input ?? {}) as LaunchInput)
      if (launch === undefined) continue
      // The record supersedes its queued create.
      this.recorded.add(launch.sessionId)
      live.set(launch.sessionId, {
        ...launch,
        createdAt: record.createdAt,
        status: record.effect.status,
        ...(record.effect.error
          ? { error: record.effect.error.message, errorCode: record.effect.error.code }
          : {}),
        ...(onExistingIssue(launch.kind) &&
        record.effect.status === 'succeeded' &&
        !startedSession(record.result, launch.sessionId)
          ? { startedNothing: true }
          : {}),
      })
    }
    for (const [sessionId, launch] of this.refusedCreates) {
      // Queued again (a retry of the same create) or recorded after all: the
      // queue and the record speak for it from here.
      if (live.has(sessionId)) this.refusedCreates.delete(sessionId)
      else live.set(sessionId, launch)
    }
    for (const [sessionId, launch] of live) {
      if (dismissing.has(launch.effectId)) live.delete(sessionId)
    }
    for (const launch of live.values()) {
      if (this.ports.truth('sessions', launch.sessionId) !== undefined) {
        // The row is here: the log retired the placeholder as it landed.
        this.forget(launch.sessionId)
        this.settle(launch.sessionId, true)
        this.answer(launch.sessionId, false)
        continue
      }
      if (launch.startedNothing === true) {
        // The issue was already started: no row will come under this id.
        this.hide(launch.sessionId)
        this.forget(launch.sessionId)
        this.settle(launch.sessionId, true)
        continue
      }
      this.show(launch)
    }
    const refused = new Set<string>()
    for (const entry of this.ports.refused()) {
      if (entry.kind === 'effectCreate') refused.add((entry.input as EffectCreateInput).id)
    }
    for (const sessionId of [...this.painted.keys()]) {
      if (this.ports.truth('sessions', sessionId) !== undefined) {
        this.forget(sessionId)
        this.settle(sessionId, true)
        this.answer(sessionId, false)
        continue
      }
      if (live.has(sessionId) || this.writing.has(sessionId)) continue
      const own = this.local.has(sessionId)
      const effectId = this.painted.get(sessionId)?.effectId
      if (own && !this.recorded.has(sessionId) && !(effectId && refused.has(effectId))) continue
      // Dismissed, or the create was refused: nothing waits for it any more.
      this.hide(sessionId)
      this.local.delete(sessionId)
      this.recorded.delete(sessionId)
      this.settle(sessionId, false)
      this.answer(sessionId, false)
    }
    this.wake()
  }

  dispose(): void {
    this.disposed = true
    for (const settle of this.settlers.values()) settle(false)
    this.settlers.clear()
    for (const answer of this.proposals.values()) answer(false)
    this.proposals.clear()
    for (const set of this.waiters.values()) for (const resolve of set) resolve()
    this.waiters.clear()
  }

  private show(launch: Launch): void {
    const ended = ENDED.has(launch.status)
    const proposed = isProposal(launch)
    const withIssue = this.paintsIssue(launch, ended && !proposed)
    const current = this.painted.get(launch.sessionId)
    if (
      current !== undefined &&
      current.ended === ended &&
      current.withIssue === withIssue &&
      current.proposed === proposed
    ) {
      return
    }
    if (current !== undefined) this.hide(launch.sessionId)
    const prompt = this.local.get(launch.sessionId)?.prompt
    const overlays = this.placeholders(launch, ended, withIssue, proposed)
    if (overlays.length > 0) {
      this.ports.paint({
        type: 'painted',
        overlays,
        sessionId: launch.sessionId,
        ...(!ended && prompt ? { prompt } : {}),
      } as SpawnPlaceholderEvent)
    }
    this.painted.set(launch.sessionId, {
      effectId: launch.effectId,
      issueId: launch.issueId,
      ended,
      withIssue,
      proposed,
    })
    if (proposed) {
      // The expected outcome of a member's top-level task: the task is there,
      // an admin starts it. Said once, plainly; never as an error.
      if (this.local.has(launch.sessionId) && !this.told.has(launch.effectId)) {
        this.told.add(launch.effectId)
        this.ports.notices.info(launch.error ?? PROPOSED_NOTICE)
      }
      this.answer(launch.sessionId, true)
      return
    }
    if (ended) {
      if (this.local.has(launch.sessionId) && !this.told.has(launch.effectId)) {
        this.told.add(launch.effectId)
        this.ports.notices.error(this.failureText(launch))
      }
      this.settle(launch.sessionId, false)
      this.answer(launch.sessionId, false)
    }
  }

  private failureText(launch: Launch): string {
    const why = launch.error ?? 'it did not run'
    if (launch.kind === SESSION_LAUNCH_KIND) return `Couldn't start the agent — ${why}`
    if (onExistingIssue(launch.kind)) {
      return launch.input.shell === true
        ? `Couldn't open the shell — ${why}`
        : `Couldn't start the agent — ${why}`
    }
    return launch.issueId !== undefined &&
      this.ports.truth('issueProjections', launch.issueId) !== undefined
      ? `The task was saved, but its agent couldn't start — ${why}`
      : `Couldn't start the task — ${why}`
  }

  /** Whether the start's task is painted too: while it waits and the task is
   *  not a row yet. An ended start made no task (the server discards an
   *  unlaunched draft, and an `issue.start` that filed one has its row). */
  private paintsIssue(launch: Launch, ended: boolean): boolean {
    if (ended || launch.issueId === undefined) return false
    if (onExistingIssue(launch.kind)) return false
    if (launch.kind === SESSION_LAUNCH_KIND && launch.input.draftIssue === undefined) return false
    return this.ports.truth('issueProjections', launch.issueId) === undefined
  }

  private placeholders(
    launch: Launch,
    ended: boolean,
    withIssue: boolean,
    proposed: boolean,
  ): PendingOverlay[] {
    const local = this.local.get(launch.sessionId)
    const input = launch.input
    // A session on an existing issue starts in the issue's checkout (its
    // repo until a begin has cut one), on the issue's machine.
    const home =
      onExistingIssue(launch.kind) && launch.issueId !== undefined
        ? this.issueRow(launch.issueId)
        : undefined
    const cwd =
      input.cwd ??
      local?.target.path ??
      input.repoPath ??
      home?.worktreePath ??
      home?.repoPath ??
      ''
    const machineId =
      input.machineId ?? local?.target.machineId ?? (home?.machineId as MachineId | undefined)
    const agentKind =
      input.shell === true
        ? ('shell' as AgentKind)
        : (input.agentKind ??
          input.defaultAgent ??
          (home?.defaultAgent && home.defaultAgent !== 'auto'
            ? (home.defaultAgent as AgentKind)
            : // A task left on the configured agent names none: this device
              // paints the one it chose; another the fallback, until the row lands.
              (local?.agentKind ?? 'claude-code')))
    const session: SessionMeta = {
      ...startingSessionRow({
        sessionId: launch.sessionId,
        ...(launch.issueId !== undefined ? { issueId: launch.issueId } : {}),
        agentKind,
        cwd,
        ...(machineId !== undefined ? { machineId } : {}),
        nowIso: launch.createdAt,
      } as Parameters<typeof startingSessionRow>[0]),
      ...(ended
        ? { status: 'exited' as const, spawnFailure: launch.error ?? 'the start did not run' }
        : {}),
    } as SessionMeta
    // A proposal starts no session: the task alone, until its row lands.
    const overlays: PendingOverlay[] = proposed
      ? []
      : [
          insertOverlay('sessions', launch.sessionId, session),
          insertOverlay(
            'sessionUserStates',
            launch.sessionId,
            starterUserState({
              userId: this.ports.userId,
              sessionId: launch.sessionId,
              nowIso: launch.createdAt,
            }),
          ),
        ]
    if (!withIssue || launch.issueId === undefined) return overlays
    const repoPath = input.draftIssue?.repoPath ?? input.repoPath ?? local?.target.repoPath ?? cwd
    const target: SpawnTarget = local?.target ?? { path: cwd, repoPath }
    const common = {
      userId: this.ports.userId,
      issueId: launch.issueId,
      repoPath,
      ...(target.repoId !== undefined ? { repoId: target.repoId } : {}),
      sortKey: this.ports.sortKey(target),
      agentKind,
      nowIso: launch.createdAt,
    }
    const issue: IssueViewModel =
      launch.kind === SESSION_LAUNCH_KIND
        ? draftIssueRow(common)
        : startedIssueRow({
            ...common,
            ...(machineId !== undefined ? { machineId } : {}),
            title: input.title ?? '',
            // The feed carries no description: this device's own, or none
            // until the row lands.
            description: input.description ?? local?.description ?? '',
            ...((input.brief ?? local?.brief) ? { brief: input.brief ?? local?.brief } : {}),
            ...(input.parentBranch !== undefined ? { parentBranch: input.parentBranch } : {}),
            ...(input.defaultModel !== undefined ? { model: input.defaultModel } : {}),
            ...(input.defaultEffort !== undefined ? { effort: input.defaultEffort } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.stage !== undefined ? { stage: input.stage } : {}),
          })
    const shown: IssueViewModel = proposed ? { ...issue, stage: 'proposed' } : issue
    const row: Record<string, unknown> = {}
    const source = shown as unknown as Record<string, unknown>
    for (const key of PROJECTION_KEYS) {
      const value = source[key]
      if (value !== undefined && value !== null) row[key] = value
    }
    row.description = { value: shown.description ?? '' }
    overlays.push(
      insertOverlay('issueProjections', launch.issueId, row as unknown as IssueProjection),
      insertOverlay('issueUserStates', launch.issueId, {
        userId: this.ports.userId,
        entityId: launch.issueId,
        readAt: issue.readAt ?? null,
        tuckedAt: issue.tuckedAt ?? null,
        pinned: issue.pinned === true,
      }),
    )
    return overlays
  }

  private hide(sessionId: SessionId): void {
    const painted = this.painted.get(sessionId)
    if (painted === undefined) return
    this.painted.delete(sessionId)
    this.ports.paint({
      type: 'removed',
      ids:
        painted.withIssue && painted.issueId !== undefined
          ? [sessionId, painted.issueId]
          : [sessionId],
    })
  }

  /** The row landed and the log retired the paint: drop the bookkeeping only. */
  private forget(sessionId: SessionId): void {
    // The log retires each placeholder exactly when its own row lands (the
    // draft task's may land a moment after the session's): removing it here
    // would open the very gap this exists to close.
    this.painted.delete(sessionId)
    this.local.delete(sessionId)
    this.recorded.delete(sessionId)
    this.refusedCreates.delete(sessionId)
  }

  private answer(sessionId: SessionId, proposed: boolean): void {
    const answer = this.proposals.get(sessionId)
    if (answer === undefined) return
    this.proposals.delete(sessionId)
    answer(proposed)
  }

  private settle(sessionId: SessionId, started: boolean): void {
    const settle = this.settlers.get(sessionId)
    if (settle === undefined) return
    this.settlers.delete(sessionId)
    settle(started)
  }

  private wake(): void {
    for (const [sessionId, set] of this.waiters) {
      const painted = this.painted.get(sessionId)
      if (painted !== undefined && !painted.ended) continue
      this.waiters.delete(sessionId)
      for (const resolve of set) resolve()
    }
  }
}
