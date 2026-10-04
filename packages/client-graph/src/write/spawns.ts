/** Spawn creation belongs to the pool's transaction log. The transport can fail
 * after truth landed, so a failed create retains its grace window and partial
 * task outcome. No replica rows or whole-list snapshot are held here. */
import { createLogger } from '@podium/logger'
import { asIssueId, asMutationId, asSessionId, IssueProjection,
  type AgentKind, type IssueId, type MutationId, type SessionId,
  type SessionMeta, type UserId } from '@podium/model'
import { type PodiumClientApi, assertSpawnPlacement, createDraftAgent, createIssueAgent,
  type SpawnDraftAgentArgs, type SpawnTarget, type TaskSpawnOutcome } from '@podium/client-core'
import { randomUUID } from '@podium/client-core/id'
import { insertOverlay, type OverlayTarget, type PendingOverlay } from '@podium/client-core/command-reducers'
import type { StoreNotices, SpawnPlaceholderEvent } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import { optimisticDraftIssue, optimisticSessionUserState, optimisticStartedIssue,
  optimisticStartingSession, type StartingSessionRow } from '@podium/client-core/values'
const log = createLogger('client-graph:spawns')
const PROJECTION_KEYS = Object.keys(IssueProjection.shape)
function placeholderProjection(issue: IssueViewModel): IssueProjection {
  const source = issue as unknown as Record<string, unknown>
  const row: Record<string, unknown> = {}
  for (const key of PROJECTION_KEYS) {
    const value = source[key]
    if (value !== undefined && value !== null) row[key] = value
  }
  row.description = { value: issue.description ?? '' }
  if (typeof source.notes === 'string') row.notes = { value: source.notes }
  return row as unknown as IssueProjection
}
export interface PoolSpawnPorts {
  api: PodiumClientApi
  userId: UserId
  notices: StoreNotices
  truth(entity: OverlayTarget, id: string): object | undefined
  pending(sessionId: string): boolean
  sortKey(target: SpawnTarget): string
  paint(event: SpawnPlaceholderEvent): void
  graceMs?: number
}
export class PoolSpawns {
  private disposed = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly waiters = new Map<string, Set<() => void>>()
  constructor(private readonly ports: PoolSpawnPorts) {}
  waitForSpawnConfirmed(sessionId: SessionId): Promise<void> {
    if (!this.ports.pending(sessionId)) return Promise.resolve()
    return new Promise(resolve => {
      let waiters = this.waiters.get(sessionId)
      if (!waiters) this.waiters.set(sessionId, waiters = new Set())
      waiters.add(resolve)
    })
  }
  confirmed(): void {
    for (const [id, waiters] of this.waiters) {
      if (this.ports.pending(id)) continue
      this.waiters.delete(id)
      for (const resolve of waiters) resolve()
    }
  }
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const waiters of this.waiters.values()) for (const resolve of waiters) resolve()
    this.waiters.clear()
  }
  private paintSpawn(args: {
    sessionId: SessionId
    issueId: IssueId
    session: StartingSessionRow
    issue: IssueViewModel
    prompt?: string
    create: () => Promise<void>
    failureSubject: 'agent' | 'task'
    recognizePartialIssue?: boolean
  }): {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
  } {
    const { sessionId, issueId } = args
    // A temporary issue projection and personal markers accompany the starting
    // session. Markers retire with their issue: create need not publish a row
    // whose markers are all unset.
    const placeholders: PendingOverlay[] = [
      insertOverlay('sessions', sessionId, args.session as SessionMeta),
      insertOverlay(
        'sessionUserStates',
        sessionId,
        optimisticSessionUserState({
          userId: this.ports.userId,
          sessionId,
          nowIso: args.session.lastActiveAt,
        }),
      ),
      insertOverlay('issueProjections', issueId, placeholderProjection(args.issue)),
      insertOverlay('issueUserStates', issueId, {
        userId: this.ports.userId,
        entityId: issueId,
        readAt: args.issue.readAt ?? null,
        tuckedAt: args.issue.tuckedAt ?? null,
        pinned: args.issue.pinned === true,
      }),
    ]
    this.ports.paint({
      type: 'painted',
      overlays: placeholders,
      sessionId,
      ...(args.prompt ? { prompt: args.prompt } : {}),
    })
    let settle: (outcome: TaskSpawnOutcome) => void = () => {}
    const outcome = new Promise<TaskSpawnOutcome>((resolve) => {
      settle = resolve
    })
    const settled = outcome.then((value) => value === 'started')
    void args.create().then(
      () => settle('started'),
      (error) => {
        if (this.disposed) { settle('failed'); return }
        const arrived = (): boolean =>
          this.ports.truth('sessions', sessionId) !== undefined
        const issueArrived = (): boolean =>
          this.ports.truth('issueProjections', issueId) !== undefined
        const settleFailure = (): void => {
          if (arrived()) {
            log.debug(
              'spawn transport failed after the session was created — treating as success',
              {
                sessionId,
                err: error,
              },
            )
            settle('started')
            return
          }
          if (args.recognizePartialIssue === true && issueArrived()) {
            this.ports.paint({ type: 'removed', ids: [sessionId, issueId] })
                    this.ports.notices.error(
              `The task was saved, but its agent couldn't start — ${error instanceof Error ? error.message : 'unknown error'}`,
            )
            settle('issue-only')
            return
          }
          this.ports.paint({ type: 'removed', ids: [sessionId, issueId] })
                this.ports.notices.error(
            `Couldn't start the ${args.failureSubject} — ${error instanceof Error ? error.message : 'unknown error'}`,
          )
          settle('failed')
        }
        if (arrived()) {
          settleFailure()
        } else {
          const timer = setTimeout(() => {
            this.timers.delete(timer)
            settleFailure()
          }, this.ports.graceMs ?? 2000)
          this.timers.add(timer)
        }
      },
    )
    return { sessionId, issueId, settled, outcome }
  }

  /** The #119 placeholder pair: paint a starting session and its draft issue
   *  before the create round-trips, and settle them when it answers. */
  spawnDraftAgent(args: SpawnDraftAgentArgs): {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
  } {
    if (this.disposed) throw new Error('PoolSpawns: spawn after dispose')
    assertSpawnPlacement(args.target)
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issueId = args.issueId ?? asIssueId(`iss_${randomUUID()}`)
    const nowIso = new Date().toISOString()
    const sortKey = this.ports.sortKey(args.target)
    return this.paintSpawn({
      sessionId,
      issueId,
      session: optimisticStartingSession({
        sessionId,
        issueId,
        agentKind: args.agentKind,
        cwd: args.target.path,
        ...(args.target.machineId !== undefined ? { machineId: args.target.machineId } : {}),
        nowIso,
      }),
      issue: optimisticDraftIssue({
        userId: this.ports.userId,
        issueId,
        repoPath: args.target.repoPath,
        repoId: args.target.repoId,
        sortKey,
        agentKind: args.agentKind,
        nowIso,
      }),
      ...(args.firstPrompt ? { prompt: args.firstPrompt } : {}),
      failureSubject: 'agent',
      create: () =>
        createDraftAgent({
          trpc: this.ports.api,
          sessionId,
          issueId,
          ...(args.mutationId ? { mutationId: args.mutationId } : {}),
          ...(args.draftArtifacts?.length ? { draftArtifacts: args.draftArtifacts } : {}),
          target: args.target,
          agentKind: args.agentKind,
          firstPrompt: args.firstPrompt,
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.requestedDriverId !== undefined
            ? { requestedDriverId: args.requestedDriverId }
            : {}),
        }),
    })
  }

  /** Paint a real named task, its first session and its first chat turn before
   * the create-and-start mutation leaves this client. */
  spawnIssueAgent(args: {
    issueId?: IssueId
    sessionId?: SessionId
    mutationId?: MutationId
    target: SpawnTarget
    title: string
    description: string
    brief?: string
    parentBranch?: string
    agentKind: AgentKind
    model?: string
    effort?: string
  }): {
    sessionId: SessionId
    issueId: IssueId
    mutationId: MutationId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
  } {
    if (this.disposed) throw new Error('PoolSpawns: spawn after dispose')
    assertSpawnPlacement(args.target)
    const sessionId = args.sessionId ?? asSessionId(randomUUID())
    const issueId = args.issueId ?? asIssueId(`iss_${randomUUID()}`)
    const mutationId = args.mutationId ?? asMutationId(randomUUID())
    const nowIso = new Date().toISOString()
    const sortKey = this.ports.sortKey(args.target)
    const painted = this.paintSpawn({
      sessionId,
      issueId,
      session: optimisticStartingSession({
        sessionId,
        issueId,
        agentKind: args.agentKind,
        cwd: args.target.path,
        ...(args.target.machineId !== undefined ? { machineId: args.target.machineId } : {}),
        nowIso,
      }),
      issue: optimisticStartedIssue({
        userId: this.ports.userId,
        issueId,
        repoPath: args.target.repoPath,
        repoId: args.target.repoId,
        sortKey,
        title: args.title,
        description: args.description,
        ...(args.target.machineId !== undefined ? { machineId: args.target.machineId } : {}),
        ...(args.brief !== undefined ? { brief: args.brief } : {}),
        ...(args.parentBranch !== undefined ? { parentBranch: args.parentBranch } : {}),
        agentKind: args.agentKind,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        nowIso,
      }),
      prompt: args.description,
      failureSubject: 'task',
      recognizePartialIssue: true,
      create: () =>
        createIssueAgent({
          trpc: this.ports.api,
          sessionId,
          issueId,
          mutationId,
          target: args.target,
          title: args.title,
          description: args.description,
          ...(args.brief !== undefined ? { brief: args.brief } : {}),
          ...(args.parentBranch !== undefined ? { parentBranch: args.parentBranch } : {}),
          agentKind: args.agentKind,
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
        }),
    })
    return { ...painted, mutationId }
  }
}
