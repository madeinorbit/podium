/**
 * A DRAFT-AGENT START, PAINTED FROM ITS LAUNCH EFFECT (ADR 12 D5, POD-6408).
 *
 * Starting a new agent in a repo is a `session.launch` effect record: the
 * device queues `effects.create` with an effect id and a session id it minted,
 * and the server launches it when a daemon can take it (POD-6398). This paints
 * the starting session (and its draft task) for as long as that launch is on
 * its way, from DATA only, and no timer:
 *
 *  - while the create is queued or awaiting confirmation: from the outbox entry;
 *  - after it is confirmed: from the replica's effect record, `pending` or
 *    `running` (also for hours while the machine is offline), and through a
 *    reload, because both sources are durable;
 *  - `succeeded`: still the placeholder until the session row under that id
 *    arrives, then the row (the transaction log retires a placeholder exactly
 *    when its row lands), so the handover has no gap in either arrival order;
 *  - `failed`, `expired`, `cancelled`, `unknown`: the session painted as exited
 *    with the launch's error, until Dismiss takes the record off the feed
 *    (`effects.dismiss`).
 */

import type { OverlayTarget, PendingOverlay } from '@podium/client-core/command-reducers'
import { insertOverlay } from '@podium/client-core/command-reducers'
import type { SpawnPlaceholderEvent, StoreNotices } from '@podium/client-core/engine'
import { randomUUID } from '@podium/client-core/id'
import type { OutboxEntry } from '@podium/client-core/outbox'
import {
  draftLaunchEffect,
  type EffectCreateInput,
  SESSION_LAUNCH_KIND,
  type SpawnDraftAgentArgs,
  type SpawnTarget,
} from '@podium/client-core/spawn-agent'
import {
  optimisticDraftIssue,
  optimisticSessionUserState,
  optimisticStartingSession,
} from '@podium/client-core/values'
import {
  type AgentKind,
  asIssueId,
  asSessionId,
  type EffectRecordWire,
  type IssueId,
  IssueProjection,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'

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
  /** The replica's effect records of kind `session.launch`. */
  launchEffects(): Iterable<EffectRecordWire>
}

const ENDED = new Set(['failed', 'expired', 'cancelled', 'unknown'])

interface Launch {
  readonly effectId: string
  readonly sessionId: SessionId
  readonly input: LaunchInput
  readonly createdAt: string
  /** `queued` before the server has the record. */
  readonly status: string
  readonly error?: string
}

/** What a launch's published input says about where it starts. */
interface LaunchInput {
  readonly agentKind?: AgentKind
  readonly cwd?: string
  readonly machineId?: MachineId
  readonly draftIssue?: { readonly repoPath: string; readonly issueId: IssueId }
}

interface Painted {
  readonly effectId: string
  readonly issueId: IssueId | undefined
  readonly ended: boolean
}

const PROJECTION_KEYS = Object.keys(IssueProjection.shape)

export class PoolLaunches {
  private disposed = false
  /** Launch placeholders this pool paints, by session id. */
  private readonly painted = new Map<SessionId, Painted>()
  /** What this device knows of a start it made itself (its repo, its prompt). */
  private readonly local = new Map<SessionId, { target: SpawnTarget; prompt?: string }>()
  private readonly settlers = new Map<SessionId, (started: boolean) => void>()
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
    this.show({
      effectId: create.id,
      sessionId,
      input: create.input as LaunchInput,
      createdAt: new Date().toISOString(),
      status: 'queued',
    })
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
          `Couldn't start the agent — ${error instanceof Error ? error.message : 'unknown error'}`,
        )
        this.settle(sessionId, false)
      },
    )
    return { sessionId, issueId, settled }
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
      let set = this.waiters.get(sessionId)
      if (!set) this.waiters.set(sessionId, (set = new Set()))
      set.add(resolve)
    })
  }

  /** Dismiss an ended launch: true when the session was one. */
  dismiss(sessionId: SessionId): boolean {
    const painted = this.painted.get(sessionId)
    if (painted === undefined || !painted.ended) return false
    this.hide(sessionId)
    this.local.delete(sessionId)
    void this.ports.write('effectDismiss', { id: painted.effectId }).catch(() => {})
    return true
  }

  /**
   * Bring the paint in line with the data: the queued creates and the
   * replica's launch records. Called on every outbox change and every replica
   * batch; idempotent.
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
      if (create.kind !== SESSION_LAUNCH_KIND || create.target?.kind !== 'session') continue
      live.set(create.target.id as SessionId, {
        effectId: create.id,
        sessionId: create.target.id as SessionId,
        input: create.input as LaunchInput,
        createdAt: new Date(entry.queuedAt).toISOString(),
        status: 'queued',
      })
    }
    for (const record of this.ports.launchEffects()) {
      if (record.kind !== SESSION_LAUNCH_KIND || record.target.kind !== 'session') continue
      // The record supersedes its queued create.
      this.recorded.add(record.target.id as SessionId)
      live.set(record.target.id as SessionId, {
        effectId: record.id,
        sessionId: record.target.id as SessionId,
        input: (record.input ?? {}) as LaunchInput,
        createdAt: record.createdAt,
        status: record.effect.status,
        ...(record.effect.error ? { error: record.effect.error.message } : {}),
      })
    }
    for (const [sessionId, launch] of live) {
      if (dismissing.has(launch.effectId)) live.delete(sessionId)
    }
    for (const launch of live.values()) {
      if (this.ports.truth('sessions', launch.sessionId) !== undefined) {
        // The row is here: the log retired the placeholder as it landed.
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
    }
    this.wake()
  }

  dispose(): void {
    this.disposed = true
    for (const settle of this.settlers.values()) settle(false)
    this.settlers.clear()
    for (const set of this.waiters.values()) for (const resolve of set) resolve()
    this.waiters.clear()
  }

  private show(launch: Launch): void {
    const ended = ENDED.has(launch.status)
    const current = this.painted.get(launch.sessionId)
    if (current !== undefined && current.ended === ended) return
    if (current !== undefined) this.hide(launch.sessionId)
    const issueId = launch.input.draftIssue?.issueId
    this.ports.paint({
      type: 'painted',
      overlays: this.placeholders(launch, ended),
      sessionId: launch.sessionId,
      ...(!ended && this.local.get(launch.sessionId)?.prompt
        ? { prompt: this.local.get(launch.sessionId)?.prompt }
        : {}),
    } as SpawnPlaceholderEvent)
    this.painted.set(launch.sessionId, { effectId: launch.effectId, issueId, ended })
    if (ended) {
      if (this.local.has(launch.sessionId) && !this.told.has(launch.effectId)) {
        this.told.add(launch.effectId)
        this.ports.notices.error(
          `Couldn't start the agent — ${launch.error ?? 'the launch did not run'}`,
        )
      }
      this.settle(launch.sessionId, false)
    }
  }

  private placeholders(launch: Launch, ended: boolean): PendingOverlay[] {
    const local = this.local.get(launch.sessionId)
    const cwd = launch.input.cwd ?? local?.target.path ?? ''
    const machineId = launch.input.machineId ?? local?.target.machineId
    const agentKind = launch.input.agentKind ?? 'claude-code'
    const session: SessionMeta = {
      ...optimisticStartingSession({
        sessionId: launch.sessionId,
        ...(launch.input.draftIssue ? { issueId: launch.input.draftIssue.issueId } : {}),
        agentKind,
        cwd,
        ...(machineId !== undefined ? { machineId } : {}),
        nowIso: launch.createdAt,
      } as Parameters<typeof optimisticStartingSession>[0]),
      ...(ended
        ? { status: 'exited' as const, spawnFailure: launch.error ?? 'the launch did not run' }
        : {}),
    } as SessionMeta
    const overlays: PendingOverlay[] = [
      insertOverlay('sessions', launch.sessionId, session),
      insertOverlay(
        'sessionUserStates',
        launch.sessionId,
        optimisticSessionUserState({
          userId: this.ports.userId,
          sessionId: launch.sessionId,
          nowIso: launch.createdAt,
        }),
      ),
    ]
    // An ended launch made no task (the server discards an unlaunched draft).
    const draft = launch.input.draftIssue
    if (
      !ended &&
      draft !== undefined &&
      this.ports.truth('issueProjections', draft.issueId) === undefined
    ) {
      const target: SpawnTarget = local?.target ?? { path: cwd, repoPath: draft.repoPath }
      const issue = optimisticDraftIssue({
        userId: this.ports.userId,
        issueId: draft.issueId,
        repoPath: draft.repoPath,
        ...(target.repoId !== undefined ? { repoId: target.repoId } : {}),
        sortKey: this.ports.sortKey(target),
        agentKind,
        nowIso: launch.createdAt,
      })
      const row: Record<string, unknown> = {}
      const source = issue as unknown as Record<string, unknown>
      for (const key of PROJECTION_KEYS) {
        const value = source[key]
        if (value !== undefined && value !== null) row[key] = value
      }
      row.description = { value: issue.description ?? '' }
      overlays.push(
        insertOverlay('issueProjections', draft.issueId, row as unknown as IssueProjection),
        insertOverlay('issueUserStates', draft.issueId, {
          userId: this.ports.userId,
          entityId: draft.issueId,
          readAt: issue.readAt ?? null,
          tuckedAt: issue.tuckedAt ?? null,
          pinned: issue.pinned === true,
        }),
      )
    }
    return overlays
  }

  private hide(sessionId: SessionId): void {
    const painted = this.painted.get(sessionId)
    if (painted === undefined) return
    this.painted.delete(sessionId)
    this.ports.paint({
      type: 'removed',
      ids: painted.issueId !== undefined ? [sessionId, painted.issueId] : [sessionId],
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
