/**
 * POD-4555 (L4a) — applies generated changes through the real scenario engine.
 *
 * ONE ENGINE. `startGenRun` boots `startEngineOnCorpus` (the one boot path)
 * with three additions, all real kernel surfaces:
 *
 * - the production KERNEL OUTBOX (`outbox: 'kernel'`, what web runs):
 *   per-issue partitions, the mark-read collapse, durable across a reload;
 * - a SCRIPTED SERVER ({@link GenServer}) behind `issues.update` and
 *   `issues.markRead`: every call is HELD until a change answers it, so a
 *   receipt, a rejection and the echo can land in any order the sequence
 *   says. A re-sent call the server already applied is answered at once
 *   (deduped by mutation id), which is the duplicate receipt;
 * - CONNECTIVITY the sequence drives (`offline`/`online` changes).
 *
 * Row changes are server truth: they read the CACHE (the replica's server
 * rows), never the runtime's folded snapshot, which carries the pending
 * overlay — writing a heartbeat from the folded row would broadcast our own
 * pending title as the server's. Issue writes dual-write wire and projection
 * in one `replica.batch()`, as the scenarios do.
 *
 * Edits go through the runtime ACTIONS (`updateIssue`, `markIssueRead`), so
 * the kernel mints, persists and sends them and fires its own outbox events;
 * the runner learns each edit's mutation id from the outbox it landed in.
 *
 * EVENTS. The per-row feed (POD-4553) over the current runtime collects the
 * `RowSourceEvent`s each step published (`StepResult.events`); a reload
 * re-binds it. Default mode `'truth'` (server rows, no overlay: what a
 * phase-c arm reads, write contract W12); `feedMode`/`feed` override it.
 *
 * SETTLING. After each step the runner yields macrotasks until the engine is
 * quiet (no publication, no server call, no outbox movement for three turns):
 * every async edge here is a promise chain, so this is deterministic without
 * a wall-clock wait. No step reads `Date.now()` or `Math.random()`.
 */

import type { OnlineEvents } from '@podium/client-core/outbox'
import { createRowSource, type RowSourceHandle } from '@podium/client-graph/shared/row-source'
import {
  evict,
  remove,
  type ScenarioEngine,
  startEngineOnCorpus,
  upsert,
} from '../scenarios'
import type { RowSourceEvent } from '../stats'
import type { FixtureCorpus } from '../../../harness/src/fixture/index'
import type { TxId } from '@podium/client-graph/shared/write-contract'
import type { ArmEditPatch } from './arm-edits'
import { type Change, genCorpus, ROW_KINDS, type RowChange } from './changes'

// --------------------------------------------------------------------- server

type Command = 'issues.update' | 'issues.markRead'

interface HeldCall {
  command: Command
  input: { id: string; mutationId: string; patch?: Record<string, unknown> }
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** A definitive refusal the kernel dead-letters (D10: zero retries). */
export function refusal(): Error {
  return Object.assign(new Error('generated refusal'), { data: { code: 'CONFLICT', httpStatus: 409 } })
}

/**
 * The server behind the slice's two write commands. Holds every call until a
 * change answers it; remembers what it applied so a re-send after a reload
 * is answered at once (the duplicate receipt).
 */
export class GenServer {
  /** Calls at the server, unanswered, by mutation id. */
  readonly held = new Map<string, HeldCall>()
  /** Mutation ids the server applied (answered ok, or echoed). */
  readonly applied = new Set<string>()
  readonly refused = new Set<string>()
  /** Every call in arrival order (re-sends included). */
  readonly arrivals: { mutationId: string; command: Command; deduped: boolean }[] = []
  /** Bumped on every arrival; the runner's quiet check reads it. */
  activity = 0

  readonly handlers = {
    issueUpdate: (input: HeldCall['input']) => this.arrive('issues.update', input),
    issueMarkRead: (input: HeldCall['input']) => this.arrive('issues.markRead', input),
  }

  private arrive(command: Command, input: HeldCall['input']): Promise<unknown> {
    this.activity += 1
    const id = input.mutationId
    if (this.applied.has(id)) {
      this.arrivals.push({ mutationId: id, command, deduped: true })
      return Promise.resolve({})
    }
    if (this.refused.has(id)) {
      this.arrivals.push({ mutationId: id, command, deduped: true })
      return Promise.reject(refusal())
    }
    this.arrivals.push({ mutationId: id, command, deduped: false })
    return new Promise((resolve, reject) => {
      this.held.set(id, { command, input, resolve, reject })
    })
  }

  accept(mutationId: string): boolean {
    const call = this.held.get(mutationId)
    if (!call) return false
    this.held.delete(mutationId)
    this.applied.add(mutationId)
    call.resolve({})
    return true
  }

  reject(mutationId: string): boolean {
    const call = this.held.get(mutationId)
    if (!call || this.applied.has(mutationId)) return false
    this.held.delete(mutationId)
    this.refused.add(mutationId)
    call.reject(refusal())
    return true
  }

  /** A reload: the old tab's open calls die unanswered (their promises are
   *  dropped; the successor re-sends under the same mutation ids). */
  abandonHeld(): void {
    this.held.clear()
  }
}

// ----------------------------------------------------------------------- run

/** One edit as the runner knows it: the change that made it and the kernel
 *  mutation id it rides. */
export interface EditRecord {
  handle: string
  issueId: string
  field: 'title' | 'stage' | 'readAt'
  /** The value set (title/stage); a mark-read's stamp is the runtime's. */
  value: string | null
  mutationId: string
  echoed: boolean
}

export interface StepResult {
  index: number
  change: Change
  /** Row-source events this step published, in order. */
  events: RowSourceEvent[]
  /** Why the change did not apply (target gone, edit not at the server, …). */
  skipped?: string
  /** What the change resolved to: the mutation id it answered, the value an
   *  echo carried, the duplicate receipt a reload produced, … */
  detail?: Record<string, unknown>
}

export interface GenRunOptions {
  corpus?: FixtureCorpus
  /** The per-row feed's mode (POD-4553). Default `'truth'`: server rows with
   *  no ledger overlay, what a phase-c arm reads (write contract W12).
   *  `'overlaid'` is the legacy fold's view. */
  feedMode?: 'truth' | 'overlaid'
  /** Replace the feed outright (overrides `feedMode`). */
  feed?: (ctx: ScenarioEngine) => RowSourceHandle
  /** Called after every step settled, before the next (the L4b checker). */
  onStep?: (step: StepResult, run: GenRun) => void | Promise<void>
  /**
   * POD-4574 (Mc2) — route generated edits through a phase-c arm's write API
   * instead of the runtime actions, so the arm (not the kernel) owns the
   * optimism the gate compares with the overlaid oracle. Called with the
   * generated patch (a mark-read press carries a stamp the arm displays; the
   * kernel stamps its own independently and the slice never compares the
   * two); returns the arm's txId, recorded on the step as `detail.armTxId`
   * (`detail.armTxIds` for a supersede pair) beside the kernel `mutationId`
   * claimed from the outbox as today. A throw skips the change. Absent: edits
   * go through the runtime actions, as before.
   */
  editViaArm?: (id: string, patch: ArmEditPatch) => TxId
}

export interface GenRun {
  readonly ctx: ScenarioEngine
  readonly server: GenServer
  readonly edits: ReadonlyMap<string, EditRecord>
  /** The current feed (re-bound on reload). */
  feed(): RowSourceHandle
  online(): boolean
  apply(change: Change): Promise<StepResult>
  dispose(): void
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Boot the engine the generator drives. */
export async function startGenRun(opts: GenRunOptions = {}): Promise<GenRun> {
  const corpus = opts.corpus ?? genCorpus()
  const server = new GenServer()
  let online = true
  const onlineListeners = new Set<() => void>()
  const onlineEvents: OnlineEvents = {
    add: (cb) => void onlineListeners.add(cb),
    remove: (cb) => void onlineListeners.delete(cb),
  } as OnlineEvents
  const ctx = await startEngineOnCorpus(corpus, {
    settleMs: 20,
    outbox: 'kernel',
    server: server.handlers,
    network: { isOnline: () => online, onlineEvents },
  })
  const mode = opts.feedMode ?? 'truth'
  const makeFeed = opts.feed ?? ((c: ScenarioEngine) => createRowSource(c.engine, c.replica, { mode }))

  let publications = 0
  let offEngine = ctx.engine.subscribe(() => {
    publications += 1
  })
  let feed = makeFeed(ctx)
  let buffer: RowSourceEvent[] = []
  let offFeed = feed.source.subscribe((e) => buffer.push(e))
  const bind = (): void => {
    offEngine = ctx.engine.subscribe(() => {
      publications += 1
    })
    feed = makeFeed(ctx)
    offFeed = feed.source.subscribe((e) => buffer.push(e))
  }
  const unbind = (): void => {
    offEngine()
    offFeed()
    feed.dispose()
  }

  const edits = new Map<string, EditRecord>()
  const byMutation = new Map<string, EditRecord>()
  const known = new Set<string>()
  const evicted = new Map<string, { wire: unknown; projection: unknown }>()
  let index = 0

  const outboxIds = (): string[] => [
    ...ctx.engine.outbox.pending().map((e) => e.mutationId as string),
    ...ctx.engine.outbox.awaiting().map((e) => e.mutationId as string),
    ...server.arrivals.map((a) => a.mutationId),
  ]
  const activity = (): string =>
    `${publications}:${server.activity}:${ctx.engine.outbox.size()}:${ctx.engine.outbox.awaiting().length}`

  const quiesce = async (): Promise<void> => {
    let quiet = 0
    for (let turn = 0; turn < 200 && quiet < 3; turn += 1) {
      const before = activity()
      await macrotask()
      quiet = activity() === before ? quiet + 1 : 0
    }
  }

  /** The mutation id the last action enqueued: the one id the outbox (or
   *  the server) holds that no earlier edit claimed. */
  const claimNewMutation = (): string | null => {
    const fresh = outboxIds().filter((id) => !known.has(id))
    for (const id of fresh) known.add(id)
    return fresh[0] ?? null
  }

  // ------------------------------------------------------------- server rows

  const readRow = (entity: string, id: string): Record<string, unknown> | undefined =>
    ctx.cache.read(entity, id)?.value as Record<string, unknown> | undefined

  /** Dual-write an issue change onto SERVER truth (wire + projection). */
  const patchIssue = (id: string, patch: Record<string, unknown>): string | null => {
    const wire = readRow('issue', id)
    if (!wire) return `issue ${id} not in scope`
    const projection = readRow('issueProjection', id) ?? {}
    const updatedAt = ctx.stamp()
    ctx.replica.batch(() => {
      upsert(ctx, 'issue', id, { ...wire, ...patch, updatedAt })
      upsert(ctx, 'issueProjection', id, { ...projection, ...patch, updatedAt })
    })
    return null
  }

  const patchSession = (sessionId: string, patch: (s: Record<string, unknown>) => Record<string, unknown>): string | null => {
    const s = readRow('session', sessionId)
    if (!s) return `session ${sessionId} not in scope`
    upsert(ctx, 'session', sessionId, patch({ ...s }))
    return null
  }

  const newSession = (sessionId: string, issueId: string, phase: string): Record<string, unknown> => {
    const now = ctx.stamp()
    const issue = readRow('issue', issueId)
    return {
      sessionId,
      issueId,
      agentKind: 'codex',
      cwd: (issue?.['worktreePath'] as string | undefined) ?? (issue?.['repoPath'] as string | undefined) ?? '/repo-0',
      title: `Session ${sessionId}`,
      status: 'live',
      controllerId: `c-${sessionId}`,
      geometry: { cols: 80, rows: 24 },
      epoch: 1,
      clientCount: 1,
      createdAt: now,
      lastActiveAt: now,
      origin: { kind: 'spawn' },
      archived: false,
      readAt: now,
      unread: false,
      agentState: { phase, since: now, nativeSubagentCount: 0 },
    }
  }

  /** One row change, synchronously (so a batch can hold several). Returns a
   *  skip reason, or null when it applied. */
  const applyRow = (c: RowChange): string | null => {
    switch (c.kind) {
      case 'newIssue': {
        if (readRow('issue', c.id)) return `issue ${c.id} exists`
        const parent = c.parentId ? readRow('issue', c.parentId) : undefined
        if (c.parentId && !parent) return `parent ${c.parentId} not in scope`
        const repo = parent ?? readRow('issue', ctx.targets.visibleRootId)
        const now = ctx.stamp()
        const seq = corpus.issues.length + Number(c.id.replace(/\D/g, ''))
        const common = {
          id: c.id,
          seq,
          title: c.title,
          stage: 'in_progress',
          parentId: c.parentId,
          createdAt: now,
          updatedAt: now,
          archived: false,
          audience: c.audience ?? 'human',
          repoId: repo?.['repoId'] ?? ctx.targets.newIssueRepo.repoId,
        }
        ctx.replica.batch(() => {
          upsert(ctx, 'issue', c.id, {
            ...common,
            repoPath: repo?.['repoPath'] ?? ctx.targets.newIssueRepo.repoPath,
            readAt: null,
            unread: true,
            needsHuman: false,
            blocked: false,
          })
          upsert(ctx, 'issueProjection', c.id, { ...common, description: { value: '' }, priority: 2, type: 'task' })
        })
        return null
      }
      case 'newSession': {
        if (readRow('session', c.sessionId)) return `session ${c.sessionId} exists`
        if (!readRow('issue', c.issueId)) return `issue ${c.issueId} not in scope`
        upsert(ctx, 'session', c.sessionId, newSession(c.sessionId, c.issueId, c.phase))
        return null
      }
      case 'heartbeat':
        return patchSession(c.sessionId, (s) => ({ ...s, lastActiveAt: ctx.stamp() }))
      case 'phaseChange': {
        return patchSession(c.sessionId, (s) => {
          const now = ctx.stamp()
          return { ...s, lastActiveAt: now, agentState: { ...(s['agentState'] as object), phase: c.phase, since: now } }
        })
      }
      case 'offerChange': {
        return patchSession(c.sessionId, (s) => {
          if (!c.offer) {
            const { offer: _gone, ...rest } = s
            return rest
          }
          return { ...s, offer: { message: 'Needs input', actions: [], createdAt: ctx.stamp() } }
        })
      }
      case 'remove': {
        if (c.entity === 'session') {
          if (!readRow('session', c.id)) return `session ${c.id} not in scope`
          remove(ctx, 'session', c.id)
          return null
        }
        if (!readRow('issue', c.id)) return `issue ${c.id} not in scope`
        ctx.replica.batch(() => {
          remove(ctx, 'issue', c.id)
          remove(ctx, 'issueProjection', c.id)
        })
        return null
      }
      case 'reparent': {
        if (c.parentId && !readRow('issue', c.parentId)) return `parent ${c.parentId} not in scope`
        return patchIssue(c.id, { parentId: c.parentId })
      }
      case 'stageChange': {
        if (c.stage === 'done') {
          const now = ctx.stamp()
          return patchIssue(c.id, { stage: 'done', closedAt: now, closedReason: 'done' })
        }
        return patchIssue(c.id, { stage: c.stage, closedAt: null, closedReason: null, tuckedAt: null })
      }
      case 'archive':
        return patchIssue(c.id, { archived: c.archived })
      case 'rankMove':
        return patchIssue(c.id, { sortKey: c.sortKey })
      case 'evict': {
        const wire = readRow('issue', c.id)
        if (!wire) return `issue ${c.id} not in scope`
        evicted.set(c.id, { wire, projection: readRow('issueProjection', c.id) })
        ctx.replica.batch(() => {
          evict(ctx, 'issue', c.id)
          evict(ctx, 'issueProjection', c.id)
        })
        return null
      }
      case 'reAdd': {
        const rows = evicted.get(c.id)
        if (!rows) return `issue ${c.id} was not evicted`
        if (readRow('issue', c.id)) return `issue ${c.id} already back`
        evicted.delete(c.id)
        ctx.replica.batch(() => {
          upsert(ctx, 'issue', c.id, rows.wire, 2, true)
          if (rows.projection) upsert(ctx, 'issueProjection', c.id, rows.projection, 2, true)
        })
        return null
      }
      case 'newWorktree': {
        const at = (ctx.discovery.repos as { repoId?: string; worktrees?: unknown[] }[]).findIndex(
          (r) => r.repoId === c.repoId,
        )
        if (at < 0) return `repo ${c.repoId} not discovered`
        const repos = [...ctx.discovery.repos] as { worktrees?: unknown[] }[]
        const repo = repos[at] as { worktrees?: unknown[] }
        repos[at] = { ...repo, worktrees: [...(repo.worktrees ?? []), { path: c.path, branch: 'gen' }] }
        ctx.discovery.repos = repos
        // The server's push; the runtime refreshes discovery itself.
        ctx.hub.emit('worktreesChanged')
        return null
      }
      case 'newOrphanSession': {
        if (readRow('session', c.sessionId)) return `session ${c.sessionId} exists`
        const owner = readRow('issue', c.ownerId)
        if (!owner) return `issue ${c.ownerId} not in scope`
        const wt = owner['worktreePath'] as string | undefined
        if (!wt) return `issue ${c.ownerId} has no worktree`
        const now = ctx.stamp()
        upsert(ctx, 'session', c.sessionId, {
          sessionId: c.sessionId,
          agentKind: 'codex',
          cwd: `${wt}/sub`,
          title: `Session ${c.sessionId}`,
          status: 'live',
          controllerId: `c-${c.sessionId}`,
          geometry: { cols: 80, rows: 24 },
          epoch: 1,
          clientCount: 1,
          createdAt: now,
          lastActiveAt: now,
          origin: { kind: 'spawn' },
          archived: false,
          readAt: now,
          unread: false,
          agentState: { phase: c.phase, since: now, nativeSubagentCount: 0 },
        })
        return null
      }
      case 'newDraftIssue': {
        if (readRow('issue', c.id)) return `issue ${c.id} exists`
        const now = ctx.stamp()
        const seq = corpus.issues.length + Number(c.id.replace(/\D/g, ''))
        const common = {
          id: c.id,
          seq,
          title: c.title,
          stage: 'backlog',
          parentId: null,
          createdAt: now,
          updatedAt: now,
          archived: false,
          audience: 'agent',
          draft: true,
          repoId: ctx.targets.newIssueRepo.repoId,
        }
        ctx.replica.batch(() => {
          upsert(ctx, 'issue', c.id, {
            ...common,
            repoPath: ctx.targets.newIssueRepo.repoPath,
            readAt: null,
            unread: true,
            needsHuman: false,
            blocked: false,
          })
          upsert(ctx, 'issueProjection', c.id, { ...common, description: { value: '' }, priority: 2, type: 'task' })
        })
        return null
      }
      case 'setWorktree':
        return patchIssue(c.id, { worktreePath: c.path })
      case 'setStartedBy':
        return patchIssue(c.id, { startedBySession: c.sessionId })
      case 'setBranch':
        // `patchIssue` dual-writes wire and projection, as the authority
        // does for `branch` (POD-4940): the app reads the verdict off the
        // projection's branch and the wire's git state.
        return patchIssue(c.id, {
          branch: c.branch,
          gitState: {
            updatedAt: ctx.stamp(),
            branch: c.branch,
            shared: false,
            ahead: 2,
            dirtyFiles: 0,
          },
        })
      case 'issueFacts': {
        const now = ctx.engine.getSnapshot().coarseNow
        const stamp = new Date(now).toISOString()
        const patches: Record<string, unknown>[] = [
          { pinned: true, readAt: stamp, commentCount: 3, color: 'violet', linearIdentifier: 'EXT-42' },
          { pinned: false, deferUntil: new Date(now + 60_000).toISOString() },
          { deferUntil: new Date(now - 60_000).toISOString(), readAt: null },
          { deferUntil: 'next-message', needsHuman: true, humanQuestion: 'Which path?', humanQuestionOptions: ['A', 'B'],
            asked: { question: 'Which path?', options: ['A', 'B'], at: stamp, by: 'sidebar-asker' } },
          { deferUntil: null, needsHuman: false, humanQuestion: null, humanQuestionOptions: null, asked: null, tuckedAt: stamp },
          { tuckedAt: null, branch: 'issue/sidebar-facts', gitState: { shared: false, merged: false, ahead: 4, dirtyFiles: 2, updatedAt: stamp } },
          { gitState: { shared: true, merged: true, ahead: 0, dirtyFiles: 0, updatedAt: stamp }, commentCount: 5, color: 'blue', linearIdentifier: null },
          { audience: 'agent', draft: true, isDraftVessel: true, origin: 'agent', intentOrigin: 'agent', worktreePath: null },
        ]
        return patchIssue(c.id, patches[c.variant % patches.length]!)
      }
      case 'sessionFacts': {
        const now = ctx.engine.getSnapshot().coarseNow
        const stamp = new Date(now).toISOString()
        const patches: Record<string, unknown>[] = [
          { name: 'Named seat', agentKind: 'claude-code', status: 'live', agentColor: '#8b5cf6',
            createdBy: { actor: { kind: 'user', id: 'u-sidebar' }, onBehalfOf: 'u-sidebar' },
            agentState: { phase: 'working', since: stamp, workingMsTotal: 1200, nativeSubagentCount: 3 } },
          { name: null, title: 'New seat', snoozedUntil: null, draftUpdatedAt: stamp },
          { snoozedUntil: new Date(now - 60_000).toISOString(), agentState: { phase: 'needs_user', since: stamp, workingMsTotal: 1800, nativeSubagentCount: 2 } },
          { snoozedUntil: new Date(now + 60_000).toISOString(), agentState: { phase: 'errored', since: stamp, error: { class: 'auth', retryable: true }, nativeSubagentCount: 0 } },
          { status: 'hibernated', stoppedAt: stamp, stopReason: 'parent', agentState: { phase: 'idle', since: stamp, idle: { kind: 'done', summary: 'Turn finished' }, workingMsTotal: 2000, nativeSubagentCount: 4 } },
          { status: 'exited', stoppedAt: stamp, stopReason: 'oom', agentState: { phase: 'ended', since: stamp, workingMsTotal: 2300 } },
          { status: 'live', snoozedUntil: undefined, stoppedAt: undefined, stopReason: undefined, agentColor: '#3b82f6',
            createdBy: { actor: { kind: 'session', id: c.sessionId }, onBehalfOf: 'u-sidebar' },
            agentKind: 'codex', name: null, title: 'Codex', agentState: { phase: 'idle', since: stamp, idle: { kind: 'open_todos', summary: '' } } },
          { status: 'live', name: null, title: 'Codex', agentState: { phase: 'idle', since: stamp, idle: { kind: 'done', summary: '' }, workingMsTotal: 2500, nativeSubagentCount: 0 } },
        ]
        return patchSession(c.sessionId, s => ({ ...s, ...patches[c.variant % patches.length], lastActiveAt: stamp }))
      }
    }
  }

  // --------------------------------------------------------------- write path

  const editFor = (handle: string): EditRecord | string => edits.get(handle) ?? `edit ${handle} never enqueued`

  /** Server truth for one edit's field (echo, remote value, stale repeat). */
  const serverWrite = (edit: EditRecord, value: string | null): string | null => {
    const v = edit.field === 'readAt' ? ctx.stamp() : value
    return patchIssue(edit.issueId, { [edit.field]: v, ...(edit.field === 'readAt' ? { unread: false } : {}) })
  }

  /**
   * POD-4574 (Mc2) — the mark-read stamp both the arm and the reference
   * oracle press: the engine's coarse clock at this step, never the wall
   * clock. The same seed and step always press the same stamp on both
   * sides (zero-gap agreement on recency verdicts), and reruns are
   * byte-identical. Never compared directly (SliceSnapshot drops readAt).
   */
  const markStamp = (): string => new Date(ctx.engine.getSnapshot().coarseNow).toISOString()

  const applyWrite = async (c: Change, detail: Record<string, unknown>): Promise<string | null> => {
    switch (c.kind) {
      case 'edit': {
        if (!readRow('issue', c.id)) return `issue ${c.id} not in scope`
        const actions = ctx.engine.getSnapshot()
        const field = 'title' in c.patch ? 'title' : 'stage' in c.patch ? 'stage' : 'readAt'
        if (opts.editViaArm) {
          // A mark-read press carries the run-clock stamp (markStamp): the
          // arm displays it while pending and the unread rollup branches on
          // it, so both sides press the same deterministic value per step.
          // The default (action) path is untouched.
          const armPatch: ArmEditPatch =
            'title' in c.patch
              ? { title: c.patch.title }
              : 'stage' in c.patch
                ? { stage: c.patch.stage }
                : { readAt: markStamp() }
          try {
            detail['armTxId'] = opts.editViaArm(c.id, armPatch)
          } catch (error) {
            return `arm refused edit: ${error instanceof Error ? error.message : String(error)}`
          }
        } else if ('readAt' in c.patch) void actions.markIssueRead(c.id)
        else void actions.updateIssue(c.id, c.patch as { title?: string; stage?: string } as never)
        await quiesce()
        const mutationId = claimNewMutation()
        if (!mutationId) return 'no outbox entry (deduped by the action)'
        const value = 'title' in c.patch ? c.patch.title : 'stage' in c.patch ? c.patch.stage : null
        const record: EditRecord = { handle: c.handle, issueId: c.id, field, value, mutationId, echoed: false }
        edits.set(c.handle, record)
        byMutation.set(mutationId, record)
        detail['mutationId'] = mutationId
        return null
      }
      case 'supersede': {
        if (!readRow('issue', c.id)) return `issue ${c.id} not in scope`
        const ids: string[] = []
        const armTxIds: string[] = []
        for (const handle of c.handles) {
          if (opts.editViaArm) {
            try {
              // Run-clock stamp like the edit branch above.
              armTxIds.push(opts.editViaArm(c.id, { readAt: markStamp() }))
            } catch {
              continue
            }
          } else void ctx.engine.getSnapshot().markIssueRead(c.id)
          await quiesce()
          const mutationId = claimNewMutation()
          if (!mutationId) continue
          const record: EditRecord = { handle, issueId: c.id, field: 'readAt', value: null, mutationId, echoed: false }
          edits.set(handle, record)
          byMutation.set(mutationId, record)
          ids.push(mutationId)
        }
        detail['mutationIds'] = ids
        if (armTxIds.length > 0) detail['armTxIds'] = armTxIds
        const queued = new Set(ctx.engine.outbox.pending().map((e) => e.mutationId as string))
        detail['collapsed'] = ids.length === 2 && !queued.has(ids[0] as string) && queued.has(ids[1] as string)
        return ids.length === 0 ? 'no outbox entry' : null
      }
      case 'accept':
      case 'reject': {
        const edit = editFor(c.handle)
        if (typeof edit === 'string') return edit
        detail['mutationId'] = edit.mutationId
        const ok = c.kind === 'accept' ? server.accept(edit.mutationId) : server.reject(edit.mutationId)
        return ok ? null : `edit ${c.handle} not held at the server`
      }
      case 'echo': {
        const edit = editFor(c.handle)
        if (typeof edit === 'string') return edit
        const atServer = server.held.has(edit.mutationId) || server.applied.has(edit.mutationId)
        if (!atServer || server.refused.has(edit.mutationId)) return `edit ${c.handle} not applied at the server`
        if (edit.echoed) return `edit ${c.handle} already echoed`
        const skip = serverWrite(edit, edit.value)
        if (skip) return skip
        edit.echoed = true
        // The server applied it; a later answer is the receipt of an applied write.
        server.applied.add(edit.mutationId)
        detail['mutationId'] = edit.mutationId
        detail['beforeReceipt'] = server.held.has(edit.mutationId)
        return null
      }
      case 'remoteOnPending': {
        const edit = editFor(c.handle)
        if (typeof edit === 'string') return edit
        detail['field'] = edit.field
        detail['mutationId'] = edit.mutationId
        // Unanswered: the edit's call has no receipt or refusal yet (S3);
        // otherwise it lands after the receipt (the W8 overtake window).
        detail['unanswered'] = !server.applied.has(edit.mutationId) && !server.refused.has(edit.mutationId)
        return serverWrite(edit, c.value)
      }
      case 'staleRepeat': {
        const edit = editFor(c.handle)
        if (typeof edit === 'string') return edit
        if (server.held.has(edit.mutationId) || !server.applied.has(edit.mutationId))
          return `edit ${c.handle} has no receipt`
        // The same editable values, riding a full-row upsert.
        return patchIssue(edit.issueId, {})
      }
      case 'offline':
        if (!online) return 'already offline'
        online = false
        return null
      case 'online': {
        if (online) return 'already online'
        online = true
        for (const cb of [...onlineListeners]) cb()
        return null
      }
      case 'refresh': {
        const before = server.arrivals.length
        unbind()
        server.abandonHeld()
        await ctx.reload()
        bind()
        await quiesce()
        detail['resent'] = server.arrivals.length - before
        detail['duplicateReceipts'] = server.arrivals.slice(before).filter((a) => a.deduped).length
        return null
      }
      default:
        return `not a write change: ${c.kind}`
    }
  }

  const run: GenRun = {
    ctx,
    server,
    edits,
    feed: () => feed,
    online: () => online,
    async apply(change) {
      const detail: Record<string, unknown> = {}
      let skipped: string | null
      if (change.kind === 'clockTick') {
        ctx.advanceClock(change.ms)
        skipped = null
      } else if (change.kind === 'batch') {
        const reasons: string[] = []
        const skippedMembers: number[] = []
        ctx.replica.batch(() => {
          change.changes.forEach((inner, member) => {
            const r = applyRow(inner)
            if (r) {
              reasons.push(r)
              skippedMembers.push(member)
            }
          })
        })
        skipped = reasons.length === change.changes.length ? `all skipped: ${reasons.join('; ')}` : null
        if (reasons.length > 0) {
          detail['skippedMembers'] = skippedMembers
          detail['reasons'] = reasons
        }
      } else if (isRowChange(change)) {
        skipped = applyRow(change)
      } else {
        skipped = await applyWrite(change, detail)
      }
      await quiesce()
      feed.flush()
      // Anything the settle turned up (a re-send answered, a drain).
      claimNewMutation()
      const events = buffer
      buffer = []
      const step: StepResult = {
        index: index++,
        change,
        events,
        ...(skipped ? { skipped } : {}),
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      }
      await opts.onStep?.(step, run)
      return step
    },
    dispose() {
      unbind()
      ctx.engine.destroy()
    },
  }
  return run
}

const ROW_KIND_SET: ReadonlySet<string> = new Set(ROW_KINDS)

function isRowChange(c: Change): c is RowChange {
  return ROW_KIND_SET.has(c.kind)
}

/** Apply `changes` in order on a fresh engine; returns every step. */
export async function runChanges(
  changes: readonly Change[],
  opts: GenRunOptions = {},
): Promise<{ steps: StepResult[]; run: GenRun }> {
  const run = await startGenRun(opts)
  const steps: StepResult[] = []
  for (const change of changes) steps.push(await run.apply(change))
  return { steps, run }
}
