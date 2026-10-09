import { isFinished } from './predicates'
import { type SessionValueInput, sessionValues } from '@podium/client-core/session-values'
import { machinePathKey, machinePathsEqual } from '@podium/model'
import { machinePathBasename } from '@podium/model/browser'
import { type ColdIndex, type ColdQueries, createColdIndex, type HeldSummaries } from './cold-index'
import { SCHEMA } from './schema'
import { comparer, runInAction } from 'mobx'
import { IssueSessionFactsIndex } from './issue-session-facts'
/** Addressed replica rows, optionally painted by PoolTransactions.
 * The feed folds the supplied per-row transaction lists over kernel truth. There is no runtime record snapshot or whole-list optimism fold.
 * Kernel addresses and transaction repaint calls name exactly the touched
 * rows; ordinary locals are followed only for discovery worktree lanes.
 * Bootstrap/rescope and explicit snapshots enumerate identities. All other
 * updates use keyed reads, and evictions carry no tombstone. Pending changes
 * survive outside the slice and repaint on readmission. Resume-twin collapse
 * belongs to the pool's existing relation index.
 */

import {
  foldRowOverlays,
  type OverlayTarget,
  type PendingOverlay,
} from '@podium/client-core/command-reducers'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import {
  asIssueId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
  normalizeOriginUrl,
  parseIssueUserStateRowId,
  parseSessionUserStateRowId,
  repoNameFromOrigin,
  sessionUserStateRowId,
} from '@podium/model'
import { FeedDiagnostics } from './feed-diagnostics'
import { issueInput } from './issue-input'
import type { SliceIssue, SliceSession, SliceWorktree } from './slice-types'
import type { RowRecord, RowSource, RowSourceEvent } from './source'

type AnyRow = { [k: string]: unknown }

interface SessionMemo {
  next: WeakMap<object, SessionMemo>
  value?: AnyRow
}
/** One composed session object per raw row and user-state identity, like
 *  `issueInput`'s memo: event, `row()` and `snapshot()` share it, so an
 *  unchanged row keeps its identity without re-reading companions (S6 reads
 *  none here, so companion changes never invalidate it). */
const composedSessions: SessionMemo = { next: new WeakMap() }
const NO_USER_STATE = Object.freeze({})

interface RepoEntry {
  path: string
  repoId?: string | null
  name?: string
  branch?: string
  originUrl?: string
  machineId?: string
  machines?: readonly { path: string }[]
  worktrees?: readonly { path: string; branch?: string; isMain?: boolean }[]
}

/** The runtime discovery surface. Entity rows come from the replica and
 *  PoolTransactions, by id; discovery follows the keyed `repos` local. */
export interface RowSourceRuntime {
  /** Keyed locals (POD-5433): the feed wakes on discovery (`repos`) and, while
   *  discovery reports a changed scan. */
  onLocals(keys: readonly RowSourceLocal[], listener: () => void): () => void
  readLocal(key: 'repos'): readonly RepoEntry[]
  readonly principal?: { userId: string }
}

/** The runtime locals the feed follows: discovery, only. Replicated records use the kernel address channel. */
export type RowSourceLocal = 'repos'

/** The replica surface the row source reads. `row()` and the addressed seam
 *  are optional on the replica contract; this source refuses to start without
 *  them rather than degrading to kind-grained refreshes. */
export interface RowSourceReplica {
  exitKind?(entity: string, id: string): 'removed' | 'evicted' | undefined
  sessionUserStatesLoaded?(): boolean
  subscribeAddressedBatch?(cb: (batch: ReplicaAddressedBatch) => void): () => void
  rows<K extends ReplicaKind>(kind: K): readonly AnyRow[]
  row?<K extends ReplicaKind>(kind: K, id: string): AnyRow | undefined
  issueIdByRef?(ref: string): string | undefined
  issueIdsByRef?(ref: string): readonly string[]
}

/** Counts-first instrumentation (methodology §5.7). `rowsVisited` counts slice
 *  rows resolved (one per session, issue or lane read); per flush it equals
 *  the addressed rows plus the pending-overlay rows, plus, on a discovery,
 *  the lanes the new answer names and the lanes that left. `enumerations`
 *  counts whole-list passes — one per replace, one per `snapshot()` call, one
 *  per discovery (a `repos` address before any lane was indexed counts the
 *  index build instead) — and is 0 on every ordinary publication. `flushes`
 *  counts drains that had a signal, emitting or not. */
export interface RowSourceStats {
  rowsVisited: number
  enumerations: number
  flushes: number
  events: number
  /** Failed cold-index or listener applications, including recovery attempts. */
  applyErrors: number
  sessionFactsVisited: number
  sessionFactsRescanned: number
  sessionStaffingChanges: number
  reset(): void
}

export interface RowSourceHandle {
  readonly source: RowSource
  readonly stats: RowSourceStats
  /** Drain pending signals synchronously; returns the emitted event, if any.
   *  The microtask scheduler calls this too — same drain, no second path. */
  flush(): RowSourceEvent | null
  dispose(): void
}

/** What the pool's transaction log reaches through the feed (POD-5431). */
export interface RowSourceRepaint {
  /**
   * `pooled` mode (POD-5431): re-read these rows now, with the pool's log as it
   * stands, and emit those whose value moved from what the arms hold, as one
   * update. The transaction layer calls it inside the action that changed its
   * log, so the change and the visible row land together. Visits exactly the
   * rows named.
   */
  repaint(
    rows: Iterable<{ readonly kind: 'session' | 'issue'; readonly id: string }>,
  ): RowSourceEvent | null
  /**
   * The server-truth row a pending overlay is judged against, by overlay
   * target and row id: the session view with this principal's truth markers
   * joined, the issue projection, or this principal's per-user row. Undefined
   * when absent. One keyed read.
   */
  truth(entity: OverlayTarget, id: string): Readonly<Record<string, unknown>> | undefined
}

const SLICE_KINDS: ReadonlySet<ReplicaKind> = new Set([
  'sessions',
  'sessionUserStates',
  'machines',
  'issueUserStates',
  'issueGitStates',
  'issueProjections',
  'issueDeps',
  'repos',
])

const OVERLAID: readonly OverlayTarget[] = [
  'sessions',
  'sessionUserStates',
  'issueUserStates',
  'issueProjections',
]
const NO_OVERLAYS: readonly PendingOverlay[] = []
type PendingByRow = Record<OverlayTarget, PendingRows>

function repoNameOf(path: string): string {
  const tail = machinePathBasename(path)
  return tail ?? path
}

function sessionIdOf(row: AnyRow): string | null {
  return typeof row.sessionId === 'string' ? (row.sessionId as string) : null
}

function idOf(row: AnyRow): string | null {
  return typeof row.id === 'string' ? (row.id as string) : null
}

/**
 * The pool's transaction log as the feed reads it (POD-5431): the same
 * per-row overlay lists, in the same fold order, as the transaction log's
 * `pendingByRow`. O(1) to ask for: the log keeps them per row.
 */
export interface PooledPending {
  byRow(entity: OverlayTarget): PendingRows
}

/** One target's pending overlays by row, as the feed reads the pool log. */
export interface PendingRows {
  get(id: string): readonly PendingOverlay[] | undefined
  has(id: string): boolean
  keys(): Iterable<string>
}

/** The row source folds the pool's per-row transaction overlays over kernel truth. */
export interface RowSourceOptions {
  readonly pending: PooledPending
}

export function createRowSource(
  runtime: RowSourceRuntime,
  replica: RowSourceReplica,
  options: RowSourceOptions,
): RowSourceHandle & RowSourceRepaint {
  const pooled = options.pending
  if (!pooled) throw new Error('createRowSource: pending overlays are required')
  const rowOf = replica.row?.bind(replica)
  const addressedOf = replica.subscribeAddressedBatch?.bind(replica)
  if (rowOf === undefined || addressedOf === undefined) {
    throw new Error(
      'createRowSource: the per-row feed needs replica.row() and replica.subscribeAddressedBatch() ' +
        '(the kernel facade has both). A replica without them would force a per-kind rebuild.',
    )
  }

  const readRow: NonNullable<RowSourceReplica['row']> = rowOf
  const subscribeAddressed: NonNullable<RowSourceReplica['subscribeAddressedBatch']> = addressedOf
  const listeners = new Set<(event: RowSourceEvent) => void>()
  let disposed = false
  const diagnostics = new FeedDiagnostics()

  const userStateKeys = new Map<string, string>()
  function installUserKey(key: string): string {
    const { entityId } = parseIssueUserStateRowId(key)
    if (authority('issueUserStates', key)) userStateKeys.set(entityId, key)
    else userStateKeys.delete(entityId)
    return entityId
  }
  function seedIssueJoins(): void {
    userStateKeys.clear()
    for (const row of replica.rows('issueUserStates')) {
      if (typeof row.userId === 'string' && typeof row.entityId === 'string') {
        // Composite keys use the same encoding as the facade, including removals.
        userStateKeys.set(
          row.entityId,
          issueUserStateRowId(asUserId(row.userId), asIssueId(row.entityId)),
        )
      }
    }

  }

  const sessionUserKeys = new Map<string, string>()
  function installSessionUserKey(key: string): string | undefined {
    const parsed = parseSessionUserStateRowId(key)
    if (runtime.principal && parsed.userId !== runtime.principal.userId) return undefined
    const id = parsed.sessionId
    if (authority('sessionUserStates', key)) sessionUserKeys.set(id, key)
    else sessionUserKeys.delete(id)
    return id
  }
  function seedSessionJoins(): void {
    sessionUserKeys.clear()
    for (const row of replica.rows('sessionUserStates')) {
      if (typeof row.userId === 'string' && typeof row.sessionId === 'string') {
        installSessionUserKey(
          sessionUserStateRowId(asUserId(row.userId), asSessionId(row.sessionId)),
        )
      }
    }

  }
  /** One session's view: its row joined with this principal's per-user row
   *  (read, snooze) folded over that row's own pending overlays (POD-4974 S3),
   *  its own fields. Machine and repo companions are joined by readers. A placeholder with no server row yet is the
   *  spawn insert, joined the same way. */
  function sessionInput(id: string, pending: PendingByRow | null): AnyRow | undefined {
    const overlays = pending?.sessions.get(id) ?? NO_OVERLAYS
    const raw =
      authority('sessions', id) ??
      (
        overlays.find((o) => o.op === 'insert') as
          | Extract<PendingOverlay, { op: 'insert' }>
          | undefined
      )?.insert
    if (!raw) return undefined
    const value = raw as AnyRow & SessionValueInput
    const userState = foldRowOverlays(
      sessionUserKeys.has(id)
        ? authority('sessionUserStates', sessionUserKeys.get(id)!)
        : undefined,
      pending?.sessionUserStates.get(id) ?? NO_OVERLAYS,
    )
    const { readAt, unread, snoozedUntil } = sessionValues(value, {
      userStatesLoaded: replica.sessionUserStatesLoaded?.() ?? true,
      userState: userState as { readAt: string | null; snoozedUntil?: string | null } | undefined,
    })
    const { machineName: _machineName, condition: _condition, handoffTarget: _handoffTarget, displayRef: _displayRef, ...own } = value
    let memo = composedSessions
    for (const key of [raw, userState ?? NO_USER_STATE]) {
      let next = memo.next.get(key)
      if (!next) {
        next = { next: new WeakMap() }
        memo.next.set(key, next)
      }
      memo = next
    }
    const current = memo.value
    if (
      current !== undefined &&
      current.readAt === readAt &&
      current.unread === unread &&
      current.snoozedUntil === snoozedUntil
    )
      return current
    memo.value = { ...own, readAt, unread, snoozedUntil }
    return memo.value

  }

  // Pending signals since the last flush.
  const pendingAddresses = new Map<string, { kind: ReplicaKind; id: string }>()
  let pendingReplace: 'bootstrap' | 'rescope' | null = null
  let discoveryDirty = false
  let scheduled = false

  /** Last published values, including bootstrap snapshots. Compare by the
   *  record's own fields before waking the pool; a new replica object alone
   *  is not a client change. Removed rows and scope replacements drop entries. */
  const published = new Map<string, RowRecord['value']>()
  const seededKinds = new Set<RowRecord['kind']>()

  // Worktree lanes memoized by path signature (path|repoId|repoPath|name|prefix).
  const laneCache = new Map<string, { sig: string; lane: SliceWorktree }>()
  /** The latest repo index, memoized by the `repos` array it was built from. */
  let repoIndex: RepoIndex | null = null
  /** The lanes the arms hold, by path, and the `repos` array they come from.
   *  `held === null` means "the lanes of `heldFrom`, not derived yet": the
   *  source starts that way, so creation reads no repo. */
  let heldFrom: readonly RepoEntry[] = EMPTY
  let held: Map<string, SliceWorktree> | null = null

  const stats: RowSourceStats = {
    rowsVisited: 0,
    enumerations: 0,
    flushes: 0,
    events: 0,
    applyErrors: 0,
    sessionFactsVisited: 0,
    sessionFactsRescanned: 0,
    sessionStaffingChanges: 0,
    reset() {
      stats.rowsVisited = 0
      stats.enumerations = 0
      stats.flushes = 0
      stats.events = 0
      stats.applyErrors = 0
      stats.sessionFactsVisited = 0
      stats.sessionFactsRescanned = 0
      stats.sessionStaffingChanges = 0
    },
  }

  function schedule(): void {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      flush()
    })
  }

  function onAddressed(batch: ReplicaAddressedBatch): void {
    if (disposed) return
    if (batch.type === 'replace') {
      pendingReplace = batch.reason
      pendingAddresses.clear()
    } else {
      if (pendingReplace !== null) return
      for (const row of batch.rows) {
        if (!SLICE_KINDS.has(row.kind)) continue
        pendingAddresses.set(`${row.kind}:${row.id}`, { kind: row.kind, id: row.id })
      }
    }
    schedule()
  }

  /** Only discovery is read from runtime publications: a change to
   *  the `repos` array is a signal. */
  function onTruthPublication(): void {
    if (disposed || currentRepos() === heldFrom) return
    discoveryDirty = true
    schedule()
  }

  function readPending(): PendingByRow {
    return {
      sessions: pooled.byRow('sessions'),
      sessionUserStates: pooled.byRow('sessionUserStates'),
      issueUserStates: pooled.byRow('issueUserStates'),
      issueProjections: pooled.byRow('issueProjections'),
    }
  }

  function authority(kind: ReplicaKind, id: string): AnyRow | undefined {
    try {
      return readRow(kind, id)
    } catch {
      // The facade's row() never throws; a fake that does reads as gone.
      return undefined
    }
  }

  function folded(
    kind: OverlayTarget,
    id: string,
    pending: PendingByRow | null,
  ): AnyRow | undefined {
    const overlays = pending?.[kind].get(id) ?? NO_OVERLAYS
    return foldRowOverlays(authority(kind, id), overlays)
  }

  /** One slice row's current value. `pending: null` resolves server truth
   *  alone — the value the arms hold for a row that had no overlay. */
  const edgeRows = new Map<string, { from: string; to: string; type: string }>()
  const outgoing = new Map<string, SliceIssue['deps']>()
  const incoming = new Map<string, Set<string>>()
  const closure = new Map<string, boolean>()
  let edgesReady = false
  // Maintained raw ownership facts are read as scalars by IssueModel. They
  // never become part of an issue row or a synthetic issue publication.
  const issueSessionFacts = new IssueSessionFactsIndex()
  let sessionFactsReady = false

  function installSessionFacts(id: string, row: AnyRow | undefined): void {
    const scanned = issueSessionFacts.stats.rescanned
    const staffing = issueSessionFacts.stats.staffingChanges
    issueSessionFacts.install(id, row)
    stats.sessionFactsVisited += 1 + issueSessionFacts.stats.rescanned - scanned
    stats.sessionFactsRescanned += issueSessionFacts.stats.rescanned - scanned
    stats.sessionStaffingChanges += issueSessionFacts.stats.staffingChanges - staffing
  }

  function ensureSessionFacts(): void {
    if (sessionFactsReady) return
    sessionFactsReady = true
    for (const row of replica.rows('sessions')) {
      const id = sessionIdOf(row)
      if (id !== null) installSessionFacts(id, row)
    }
  }

  function installEdge(id: string, raw: AnyRow | undefined): string[] {
    const before = edgeRows.get(id)
    const after =
      raw === undefined
        ? undefined
        : {
            from: String(raw.fromId ?? raw.from ?? ''),
            to: String(raw.toId ?? raw.to ?? ''),
            type: String(raw.type ?? ''),
          }
    const owners = new Set<string>()
    if (before !== undefined) {
      owners.add(before.from)
      outgoing.set(
        before.from,
        (outgoing.get(before.from) ?? []).filter(
          (e) => !(e.id === before.to && e.type === before.type),
        ),
      )
      if (before.type === 'blocks') incoming.get(before.to)?.delete(before.from)
    }
    edgeRows.delete(id)
    if (after !== undefined && after.from && after.to) {
      edgeRows.set(id, after)
      owners.add(after.from)
      outgoing.set(after.from, [
        ...(outgoing.get(after.from) ?? []),
        { id: after.to, type: after.type },
      ])
      if (after.type === 'blocks') {
        let ownersOf = incoming.get(after.to)
        if (ownersOf === undefined) {
          ownersOf = new Set()
          incoming.set(after.to, ownersOf)
        }
        ownersOf.add(after.from)
      }
    }
    return [...owners]
  }

  function ensureEdges(): void {
    if (edgesReady) return
    edgesReady = true
    for (const raw of replica.rows('issueDeps')) {
      const id = idOf(raw)
      if (id !== null) installEdge(id, raw)
    }
  }

  function closedInput(id: string): boolean | undefined {
    // Replica blocking is a truth fact. Optimistic stages change their own
    // row immediately, but a neighbour stops blocking only on the server echo.
    const projection = authority('issueProjections', id)
    return projection === undefined ? undefined : isFinished(projection)
  }

  function resolve(
    kind: 'session' | 'issue',
    id: string,
    pending: PendingByRow | null,
  ): RowRecord['value'] {
    if (kind === 'session')
      return foldRowOverlays(sessionInput(id, pending), pending?.sessions.get(id) ?? NO_OVERLAYS) as
        | SliceSession
        | undefined
    ensureEdges()
    ensureSessionFacts()
    const projection = folded('issueProjections', id, pending)
    const userState = foldRowOverlays(
      authority('issueUserStates', userStateKeys.get(id) ?? ''),
      pending?.issueUserStates.get(id) ?? NO_OVERLAYS,
    )
    const gitState = authority('issueGitStates', id)
    const deps = outgoing.get(id) ?? EMPTY
    const blocked = deps.some((edge) => edge.type === 'blocks' && closedInput(edge.id) === false)
    return issueInput(
      projection,
      userState,
      gitState,
      deps,
      blocked,
    )
  }

  function laneFor(
    path: string,
    repoId: string | null,
    repoPath: string,
    branch?: string,
    isMain?: boolean,
    projectIndex?: number,
    projectAliases?: readonly string[],
    name?: string,
    projectRoot?: boolean,
  ): SliceWorktree {
    const repoName = name ?? repoNameOf(repoPath)
    const sig = `${path}|${repoId ?? ''}|${repoPath}|${repoName}|${branch ?? ''}|${isMain ?? ''}|${projectIndex ?? ''}|${projectAliases?.join(',') ?? ''}|${projectRoot ?? ''}`
    const cached = laneCache.get(path)
    if (cached !== undefined && cached.sig === sig) return cached.lane
    const lane: SliceWorktree = {
      path,
      ...(repoId !== null ? { repoId } : {}),
      repoPath,
      repoName,
      branch,
      isMain,
      projectIndex,
      projectAliases,
      projectRoot,
    }
    laneCache.set(path, { sig, lane })
    return lane
  }

  function repoIdOf(repo: RepoEntry): string | null {
    return typeof repo.repoId === 'string' && repo.repoId.length > 0 ? repo.repoId : null
  }

  function lanesOf(repo: RepoEntry, project: RepoProject): SliceWorktree[] {
    const repoId = repoIdOf(repo)
    const lanes = [
      laneFor(
        repo.path,
        repoId,
        repo.path,
        repo.branch,
        true,
        project.index,
        project.aliases,
        project.name,
        machinePathsEqual(project.path, repo.path),
      ),
    ]
    for (const wt of repo.worktrees ?? [])
      lanes.push(
        laneFor(
          wt.path,
          repoId,
          repo.path,
          wt.branch,
          false,
          project.index,
          project.aliases,
          project.name,
          false,
        ),
      )
    return lanes
  }

  function currentRepos(): readonly RepoEntry[] {
    try {
      return runtime.readLocal('repos')
    } catch {
      return EMPTY
    }
  }

  /** The repo roots (standalone duplicates of linked worktrees dropped) and
   *  the repoId → roots index, rebuilt only when discovery hands the engine a
   *  new `repos` array. A whole-list pass: callers count it. */
  function indexFor(repos: readonly RepoEntry[]): RepoIndex {
    if (repoIndex?.from === repos) return repoIndex
    const linked = new Set<string>()
    for (const repo of repos) for (const wt of repo.worktrees ?? []) linked.add(machinePathKey(wt.path))
    const roots: RepoEntry[] = []
    const byId = new Map<string, RepoEntry[]>()
    for (const repo of repos) {
      if (linked.has(machinePathKey(repo.path))) continue
      roots.push(repo)
      const id = repoIdOf(repo)
      if (id === null) continue
      const list = byId.get(id)
      if (list) list.push(repo)
      else byId.set(id, [repo])
    }
    const groups = new Map<string, RepoEntry[]>()
    for (const repo of roots) {
      const origin = normalizeOriginUrl(repo.originUrl)
      const key = repoIdOf(repo) ?? (origin || `__no_remote__:${repo.machineId ?? ''}:${machinePathKey(repo.path)}`)
      const group = groups.get(key)
      if (group) group.push(repo)
      else groups.set(key, [repo])
    }
    const projects: RepoIndex['projects'] = new Map()
    let index = 0
    for (const group of groups.values()) {
      const first = group[0]!
      const origin = group.map((repo) => normalizeOriginUrl(repo.originUrl)).find(Boolean)
      const aliases = [
        repoIdOf(first),
        first.path,
        ...group.filter((repo) => repo.machineId !== undefined).map((repo) => repo.path),
      ].filter((key): key is string => key !== null)
      const project = {
        index: index++,
        path: first.path,
        aliases,
        name: repoNameFromOrigin(origin) ?? repoNameOf(first.path),
      }
      for (const repo of group) projects.set(repo, project)
    }
    repoIndex = { from: repos, roots, byId, projects }
    return repoIndex
  }

  /** Every lane of `repos`, by path, each one resolved (and counted). */
  function lanesByPath(repos: readonly RepoEntry[]): Map<string, SliceWorktree> {
    const out = new Map<string, SliceWorktree>()
    const index = indexFor(repos)
    for (const repo of index.roots) {
      for (const lane of lanesOf(repo, index.projects.get(repo)!)) {
        stats.rowsVisited += 1
        out.set(lane.path, lane)
      }
    }
    return out
  }

  function repoRow(id: string): AnyRow | undefined {
    const raw = authority('repos', id)
    if (!raw) return undefined
    const roots = indexFor(currentRepos()).byId.get(id)
    return { ...raw, repoPath: raw.repoPath ?? roots?.[0]?.path ?? '' }
  }

  function companions(kind: 'repo' | 'machine'): RowRecord[] {
    return replica.rows(kind === 'repo' ? 'repos' : 'machines').flatMap(raw => {
      const id = idOf(raw)
      if (!id) return []
      stats.rowsVisited += 1
      return [{ kind, id, value: kind === 'repo' ? repoRow(id) : raw }]
    })
  }

  /** A discovery since the last flush: the lanes that appeared, changed value
   *  or left, diffed by path against what the arms hold (POD-4606). */
  function discoveryRows(into: Map<string, RowRecord>): void {
    const repos = currentRepos()
    if (repos === heldFrom) return
    stats.enumerations += 1
    const before = held ?? lanesByPath(heldFrom)
    const after = lanesByPath(repos)
    for (const [path, lane] of after) {
      if (before.get(path) !== lane)
        into.set(`worktree:${path}`, { kind: 'worktree', id: path, value: lane })
    }
    for (const path of before.keys()) {
      if (after.has(path)) continue
      stats.rowsVisited += 1
      laneCache.delete(path)
      into.set(`worktree:${path}`, { kind: 'worktree', id: path, value: undefined })
    }
    heldFrom = repos
    held = after
  }

  /** Keep the previously emitted object when the fold recomposed an equal one. */
  function retain(key: string, value: RowRecord['value']): RowRecord['value'] {
    if (!published.has(key)) return value
    const previous = published.get(key)
    return previous !== undefined && value !== undefined && comparer.structural(previous, value)
      ? previous
      : value
  }

  /** Every row of one kind, once: server truth folded with pending overlays,
   *  plus pending inserts no server row covers yet. */
  function enumerate(kind: 'session' | 'issue', pending: PendingByRow): RowRecord[] {
    const ids: string[] = []
    const seen = new Set<string>()
    const add = (id: string | null): void => {
      if (id === null || seen.has(id)) return
      seen.add(id)
      ids.push(id)
    }
    if (kind === 'session') {
      for (const row of replica.rows('sessions')) add(sessionIdOf(row))
      for (const id of pending.sessions.keys()) add(id)
      for (const id of pending.sessionUserStates.keys()) add(id)
    } else {
      for (const row of replica.rows('issueProjections')) add(idOf(row))
      for (const id of pending.issueUserStates.keys()) add(id)
      for (const id of pending.issueProjections.keys()) add(id)
    }
    const out: RowRecord[] = []
    for (const id of ids) {
      stats.rowsVisited += 1
      const value = retain(`${kind}:${id}`, resolve(kind, id, pending))
      if (kind === 'issue') {
        const closed = closedInput(id)
        if (closed !== undefined) closure.set(id, closed)
      }
      // An insert a server row already covers, or a patch on a row that is
      // gone, resolves to nothing: not a row.
      if (value !== undefined) out.push({ kind, id, value })
    }
    return out
  }

  /** Every current lane, inside a replace or a `snapshot()` (whose one
   *  enumeration covers it). Derived for the array the arms hold, it is that
   *  array's lanes: kept, so a later discovery diffs without re-deriving. */
  function allLanes(): RowRecord[] {
    const repos = currentRepos()
    const lanes = lanesByPath(repos)
    if (held === null && repos === heldFrom) held = lanes
    const out: RowRecord[] = []
    for (const [path, lane] of lanes) out.push({ kind: 'worktree', id: path, value: lane })
    return out
  }

  function flush(): RowSourceEvent | null {
    return runInAction(flushPending)
  }

  function flushPending(): RowSourceEvent | null {
    if (disposed) return null
    const recovering = diagnostics.resyncPending
    const hadReplace = pendingReplace !== null || recovering
    const addresses = [...pendingAddresses.values()]
    const hadRuntime = discoveryDirty
    pendingAddresses.clear()
    pendingReplace = null
    discoveryDirty = false
    if (!hadReplace && addresses.length === 0 && !hadRuntime) return null

    const pending = readPending()

    stats.flushes += 1
    if (hadReplace) {
      diagnostics.resyncPending = false
      if (recovering) diagnostics.replaceResyncs += 1
      seedIssueJoins()
      seedSessionJoins()
      edgesReady = false
      edgeRows.clear()
      outgoing.clear()
      incoming.clear()
      closure.clear()
      ensureEdges()
      sessionFactsReady = false
      issueSessionFacts.clear()
      ensureSessionFacts()
      stats.enumerations += 1
      const lanes = allLanes()
      // Every subscriber now holds these lanes.
      heldFrom = currentRepos()
      held = new Map(lanes.map((row) => [row.id, row.value as SliceWorktree]))
      const event: RowSourceEvent = {
        type: 'replace',
        rows: [
          ...enumerate('session', pending),
          ...enumerate('issue', pending),
          ...lanes,
          ...companions('repo'),
          ...companions('machine'),
        ],
      }
      emit(event, recovering)
      return event
    }

    const byKey = new Map<string, RowRecord>()
    // 0. Discovery: lanes the new `repos` answer moved (O(1) when it did not).
    discoveryRows(byKey)
    // 1. Resolve kernel-addressed rows; publish only changed client values.
    const addressed = new Map<string, { kind: 'session' | 'issue'; id: string }>()
    for (const address of addresses) {
      if (address.kind === 'repos') {
        stats.rowsVisited += 1
        byKey.set(`repo:${address.id}`, { kind: 'repo', id: address.id, value: repoRow(address.id) })
        continue
      }
      if (address.kind === 'sessionUserStates') {
        const id = installSessionUserKey(address.id)
        if (id) addressed.set(`session:${id}`, { kind: 'session', id })
        continue
      }
      if (address.kind === 'machines') {
        stats.rowsVisited += 1
        byKey.set(`machine:${address.id}`, { kind: 'machine', id: address.id, value: authority('machines', address.id) })
        continue
      }
      if (address.kind === 'issueUserStates') {
        const owner = installUserKey(address.id)
        addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
        continue
      }
      if (address.kind === 'issueGitStates') {
        addressed.set(`issue:${address.id}`, { kind: 'issue', id: address.id })
        continue
      }
      if (address.kind === 'sessions') {
        ensureSessionFacts()
        installSessionFacts(address.id, authority('sessions', address.id))
        addressed.set(`session:${address.id}`, { kind: 'session', id: address.id })
        continue
      }
      if (address.kind === 'issueDeps') {
        ensureEdges()
        for (const owner of installEdge(address.id, authority('issueDeps', address.id))) {
          addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
        }
      } else {
        addressed.set(`issue:${address.id}`, { kind: 'issue', id: address.id })
        const closed = closedInput(address.id)
        if (closure.get(address.id) !== closed) {
          for (const owner of incoming.get(address.id) ?? EMPTY)
            addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
        }
        if (closed === undefined) closure.delete(address.id)
        else closure.set(address.id, closed)
      }
    }
    for (const [key, { kind, id }] of addressed) {
      stats.rowsVisited += 1
      byKey.set(key, { kind, id, value: resolve(kind, id, pending) })
    }

    // Pending-log changes (including retirement and rollback) already name
    // their rows through repaint. Feed changes above reconcile their own
    // overlays; unrelated pending rows need no work on this publication.

    return publishUpdate(byKey.values())
  }

  function publishUpdate(records: Iterable<RowRecord>): RowSourceEvent | null {
    const rows: RowRecord[] = []
    for (const record of records) {
      const key = `${record.kind}:${record.id}`
      const value = retain(key, record.value)
      if (published.has(key) && value === published.get(key)) continue
      rows.push({ ...record, value })
    }
    if (rows.length === 0) return null
    const event: RowSourceEvent = { type: 'update', rows }
    emit(event)
    return event
  }

  function emit(event: RowSourceEvent, recovering = false): void {
    stats.events += 1
    if (event.type === 'replace') published.clear()
    for (const { kind, id, value } of event.rows) {
      seededKinds.add(kind)
      const key = `${kind}:${id}`
      if (value === undefined) published.delete(key)
      else published.set(key, value)
    }
    function failed(kind: 'listener' | 'cold-index', error: unknown): void {
      stats.applyErrors += 1
      diagnostics.resyncPending = true
      // One automatic recovery per failing publication. A recovery that also
      // fails waits for the next signal/explicit flush, rather than starving
      // the event loop with an unbounded microtask chain.
      if (!recovering) schedule()
      diagnostics.report(`${kind}:${event.type}`, error)
    }
    if (coldIndex !== null) {
      try {
        if (coldNeedsReseed) {
          // Use this replacement's rows and every declared summary field.
          // Never let a reader silently rebuild the damaged index on demand.
          const index = createColdIndex(SCHEMA, coldHeld)
          index.apply(event)
          coldIndex = index
          coldNeedsReseed = false
        } else coldIndex.apply(event)
      } catch (error) {
        coldNeedsReseed = true
        failed('cold-index', error)
        // The pool must not consume a publication backed by a partial index.
        return
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        // Preserve observer isolation, but replace the potentially partial
        // pool before delivering another incremental publication.
        failed('listener', error)
      }
    }
  }

  function snapshot(kind: RowRecord['kind']): RowRecord[] {
    // Fail fast (POD-4574): reading a disposed source silently serves
    // whatever it last held — a stale arm reads stale rows and matches
    // nothing, which once looked like a 54-row rollup bug. Both arms get it.
    if (disposed) {
      throw new Error(
        'createRowSource: snapshot() on a disposed source (the principal switched; rebind first)',
      )
    }
    stats.enumerations += 1
    const initial = !seededKinds.has(kind)
    seededKinds.add(kind)
    const rows = kind === 'repo' || kind === 'machine' ? companions(kind)
      : kind === 'worktree' ? allLanes() : enumerate(kind, readPending())
    return rows.map(record => {
      const key = `${record.kind}:${record.id}`
      const value = retain(key, record.value)
      // Later snapshots may serve fresh truth before its scheduled flush.
      // They must not hide that change from existing subscribers.
      if (initial && !published.has(key)) published.set(key, value)
      return { ...record, value }
    })
  }

  /** One row by id, as `snapshot(kind)` would carry it, with no enumeration
   *  (POD-4567: a pool hydrating a cold row). Keeps the object last emitted
   *  when the fold recomposed an equal one; leaves the emit memo alone, so
   *  the next flush still emits whatever moved. Throws on a disposed source,
   *  like `snapshot()` (POD-4574). */
  function row(kind: 'issue' | 'session', id: string): RowRecord['value'] {
    if (disposed) {
      throw new Error(
        'createRowSource: row() on a disposed source (the principal switched; rebind first)',
      )
    }
    stats.rowsVisited += 1
    return retain(`${kind}:${id}`, resolve(kind, id, readPending()))
  }

  /** POD-5405 — the cold index, built on the first question and fed by `emit`. */
  let coldIndex: ColdIndex | null = null
  let coldNeedsReseed = false
  /** POD-5407 — the declared summary fields it holds (the union of every caller's), and the last declaration found held. */
  let coldHeld: HeldSummaries = {}
  let coldChecked: HeldSummaries | undefined
  function cold(summaries?: HeldSummaries): ColdQueries {
    if (disposed) {
      throw new Error(
        'createRowSource: cold() on a disposed source (the principal switched; rebind first)',
      )
    }
    if (coldNeedsReseed) {
      throw new Error('createRowSource: cold index awaiting replacement resync')
    }
    if (coldIndex !== null && summaries !== undefined && summaries !== coldChecked) {
      if (coldIndex.holds(summaries)) coldChecked = summaries
      else coldIndex = null
    }
    if (coldIndex === null) {
      const held: Record<string, readonly string[]> = { ...coldHeld }
      for (const [entity, fields] of Object.entries(summaries ?? {})) {
        held[entity] = [...new Set([...(held[entity] ?? []), ...(fields ?? [])])]
      }
      coldHeld = held as HeldSummaries
      coldChecked = summaries
      const index = createColdIndex(SCHEMA, coldHeld)
      index.apply({
        type: 'replace',
        rows: [...snapshot('session'), ...snapshot('issue'), ...snapshot('worktree'), ...snapshot('repo'), ...snapshot('machine')],
      })
      coldIndex = index
    }
    return coldIndex
  }

  const source: RowSource = {
    diagnostics,
    issueSessionFact: issueSessionFacts.read,
    snapshot,
    companions: () => [...snapshot('repo'), ...snapshot('machine')],
    row,
    exitKind(kind, id) {
      const entity = kind === 'issue' ? 'issueProjection' : kind
      return replica.exitKind?.(entity, id)
    },
    cold,
    ...(replica.issueIdByRef
      ? {
          issueIdByRef(ref: string): string | undefined {
            if (disposed) throw new Error('createRowSource: issueIdByRef() on a disposed source')
            return replica.issueIdByRef!(ref)
          },
        }
      : {}),
    ...(replica.issueIdsByRef
      ? {
          issueIdsByRef(ref: string): readonly string[] {
            if (disposed) throw new Error('createRowSource: issueIdsByRef() on a disposed source')
            return replica.issueIdsByRef!(ref)
          },
        }
      : {}),
    subscribe(listener: (event: RowSourceEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const offs: Array<() => void> = []
  offs.push(subscribeAddressed(onAddressed))
  // The feed reads no runtime publication but discovery: kernel addresses and the log's repaint
  // name their rows, so only a moved `repos` array is a signal.
  heldFrom = currentRepos()
  offs.push(runtime.onLocals(['repos'], onTruthPublication))

  function repaint(
    rows: Iterable<{ readonly kind: 'session' | 'issue'; readonly id: string }>,
  ): RowSourceEvent | null {
    if (disposed) return null
    if (diagnostics.resyncPending) return flush()
    const pending = readPending()
    const byKey = new Map<string, RowRecord>()
    for (const { kind, id } of rows) {
      const key = `${kind}:${id}`
      if (byKey.has(key)) continue
      stats.rowsVisited += 1
      const held = published.has(key) ? published.get(key) : resolve(kind, id, null)
      const value = retain(key, resolve(kind, id, pending))
      if (value !== held) byKey.set(key, { kind, id, value })
    }
    return publishUpdate(byKey.values())
  }

  function truth(entity: OverlayTarget, id: string): AnyRow | undefined {
    if (disposed) return undefined
    switch (entity) {
      case 'sessions':
        return sessionInput(id, null)
      case 'issueProjections':
        return authority('issueProjections', id)
      // The per-user keys are computed from the principal rather than read off
      // the join maps: those are installed by the next flush, and a truth read
      // inside a kernel batch (settlement) must see the row that batch wrote.
      case 'issueUserStates': {
        const principal = runtime.principal?.userId
        const key =
          principal === undefined
            ? userStateKeys.get(id)
            : issueUserStateRowId(asUserId(principal), asIssueId(id))
        return key === undefined ? undefined : authority('issueUserStates', key)
      }
      case 'sessionUserStates': {
        const principal = runtime.principal?.userId
        const key =
          principal === undefined
            ? sessionUserKeys.get(id)
            : sessionUserStateRowId(asUserId(principal), asSessionId(id))
        return key === undefined ? undefined : authority('sessionUserStates', key)
      }
    }
  }

  // Bootstrap the declared small summaries here, before an addressed update
  // can arrive. Neither the first heartbeat nor the first edge change may
  // hide a whole-kind scan inside an ordinary publication.
  ensureEdges()
  ensureSessionFacts()
  seedIssueJoins()
  seedSessionJoins()

  // Seed the publication memo with the rows already painted at creation, so the
  // first flush compares against what `snapshot()` would have served. O(pending).
  try {
    const pending = readPending()
    for (const kind of OVERLAID) {
      for (const id of pending[kind].keys()) {
        const row = kind === 'sessions' || kind === 'sessionUserStates' ? 'session' : 'issue'
        published.set(`${row}:${id}`, resolve(row, id, pending))
      }
    }
  } catch {
    // A runtime that cannot answer yet seeds empty; the first flush heals.
  }

  return {
    source,
    stats,
    flush,
    repaint,
    truth,
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch {
          // Teardown is best-effort, matching the engine lifecycle contract.
        }
      }
      listeners.clear()
      issueSessionFacts.clear()
      coldIndex = null
      coldNeedsReseed = false
      diagnostics.resyncPending = false
      pendingAddresses.clear()
      published.clear()
      seededKinds.clear()
      held = null
      repoIndex = null
    },
  }
}

const EMPTY: readonly never[] = [] as const

interface RepoProject {
  index: number
  path: string
  aliases: string[]
  name: string
}

interface RepoIndex {
  from: readonly RepoEntry[]
  roots: RepoEntry[]
  byId: Map<string, RepoEntry[]>
  projects: Map<RepoEntry, RepoProject>
}
