import { isFinished } from './predicates'
import {
  type SessionHomes,
  type SessionValueInput,
  sessionView,
} from '@podium/client-core/session-values'
import { type ColdIndex, type ColdQueries, createColdIndex, type HeldSummaries } from './cold-index'
import { ISSUE_SESSION_FACTS_SUMMARY, SCHEMA } from './schema'
/** Addressed replica rows, optionally painted by PoolTransactions.
 * `truth` reads server rows; `pooled` folds the supplied per-row transaction
 * lists. There is no runtime record snapshot or whole-list optimism fold.
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
import { shallowEqual } from '@podium/client-core/store'
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
 *  PoolTransactions, by id; both modes follow the keyed `repos` local. */
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
const NO_PENDING: PendingByRow = {
  sessions: new Map(),
  sessionUserStates: new Map(),
  issueUserStates: new Map(),
  issueProjections: new Map(),
}

function repoNameOf(path: string): string {
  const tail = path.split('/').filter(Boolean).pop()
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

/** Consumers explicitly choose server truth or server truth painted by the
 * pool's transaction log. Transaction changes name rows through `repaint`;
 * runtime local changes signal discovery only. */
export type RowSourceMode = 'truth' | 'pooled'

/** The row kinds the pool's transaction log can own (POD-5432). */
export type PoolOwnedKind = 'issue' | 'session'

export type RowSourceOptions =
  | { readonly mode: 'truth' }
  | {
      readonly mode: 'pooled'
      readonly pending: PooledPending
    }

export function createRowSource(
  runtime: RowSourceRuntime,
  replica: RowSourceReplica,
  options: RowSourceOptions,
): RowSourceHandle & RowSourceRepaint {
  const { mode } = options
  if (mode !== 'truth' && mode !== 'pooled') {
    throw new Error(`createRowSource: mode must be 'truth' or 'pooled', got ${String(mode)}`)
  }
  const pooled = options.mode === 'pooled' ? options.pending : null
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
  const issueRepos = new Map<string, string>()
  const repoIssues = new Map<string, Set<string>>()
  function installIssueRepo(id: string, row: AnyRow | undefined): void {
    const previous = issueRepos.get(id)
    if (previous) repoIssues.get(previous)?.delete(id)
    issueRepos.delete(id)
    if (typeof row?.repoId === 'string') {
      issueRepos.set(id, row.repoId)
      let members = repoIssues.get(row.repoId)
      if (!members) {
        members = new Set()
        repoIssues.set(row.repoId, members)
      }
      members.add(id)
    }
  }
  function installUserKey(key: string): string {
    const { entityId } = parseIssueUserStateRowId(key)
    if (authority('issueUserStates', key)) userStateKeys.set(entityId, key)
    else userStateKeys.delete(entityId)
    return entityId
  }
  function seedIssueJoins(): void {
    userStateKeys.clear()
    issueRepos.clear()
    repoIssues.clear()
    for (const row of replica.rows('issueUserStates')) {
      if (typeof row.userId === 'string' && typeof row.entityId === 'string') {
        // Composite keys use the same encoding as the facade, including removals.
        userStateKeys.set(
          row.entityId,
          issueUserStateRowId(asUserId(row.userId), asIssueId(row.entityId)),
        )
      }
    }
    for (const row of replica.rows('issueProjections')) {
      const id = idOf(row)
      if (id) installIssueRepo(id, row)
    }
  }

  // Only join keys, never another retained copy of session records. Fan-out
  // visits the sessions using the changed companion, not the whole replica.
  const sessionUserKeys = new Map<string, string>()
  const sessionJoins = new Map<string, { repo?: string; machines: string[] }>()
  const repoSessions = new Map<string, Set<string>>()
  const machineSessions = new Map<string, Set<string>>()
  function installSessionJoin(id: string, row: AnyRow | undefined): void {
    const before = sessionJoins.get(id)
    if (before?.repo) repoSessions.get(before.repo)?.delete(id)
    for (const machine of before?.machines ?? EMPTY) machineSessions.get(machine)?.delete(id)
    sessionJoins.delete(id)
    if (!row) return
    const repo = typeof row.refRepoId === 'string' ? row.refRepoId : undefined
    const machines = [
      ...new Set(
        [row.machineId, row.handoffTargetMachineId].filter(
          (id): id is string => typeof id === 'string',
        ),
      ),
    ]
    sessionJoins.set(id, { repo, machines })
    if (repo) {
      let ids = repoSessions.get(repo)
      if (!ids) {
        ids = new Set()
        repoSessions.set(repo, ids)
      }
      ids.add(id)
    }
    for (const machine of machines) {
      let ids = machineSessions.get(machine)
      if (!ids) {
        ids = new Set()
        machineSessions.set(machine, ids)
      }
      ids.add(id)
    }
  }
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
    sessionJoins.clear()
    repoSessions.clear()
    machineSessions.clear()
    for (const row of replica.rows('sessionUserStates')) {
      if (typeof row.userId === 'string' && typeof row.sessionId === 'string') {
        installSessionUserKey(
          sessionUserStateRowId(asUserId(row.userId), asSessionId(row.sessionId)),
        )
      }
    }
    for (const row of replica.rows('sessions')) {
      const id = sessionIdOf(row)
      if (id) installSessionJoin(id, row)
    }
  }
  /** One session's view: its row joined with this principal's per-user row
   *  (read, snooze) folded over that row's own pending overlays (POD-4974 S3),
   *  its repo and its machines. A placeholder with no server row yet is the
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
    return sessionView(value, {
      userStatesLoaded: replica.sessionUserStatesLoaded?.() ?? true,
      userState,
      repo: value.refRepoId ? authority('repos', value.refRepoId) : undefined,
      machine: value.machineId ? authority('machines', value.machineId) : undefined,
      handoffMachine: value.handoffTargetMachineId
        ? authority('machines', value.handoffTargetMachineId)
        : undefined,
    } as SessionHomes) as AnyRow
  }

  // Pending signals since the last flush.
  const pendingAddresses = new Map<string, { kind: ReplicaKind; id: string }>()
  let pendingReplace: 'bootstrap' | 'rescope' | null = null
  let discoveryDirty = false
  let scheduled = false

  /** The value last emitted for each slice row that had overlays at the last
   *  flush, keyed `session:id` / `issue:id`. Bounded by pending writes: rows
   *  without overlays are served by the replica/composition memo instead. */
  const overlaid = new Map<string, RowRecord['value']>()

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
    reset() {
      stats.rowsVisited = 0
      stats.enumerations = 0
      stats.flushes = 0
      stats.events = 0
      stats.applyErrors = 0
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

  /** Truth mode reads nothing else the runtime publishes: only a discovery
   *  (the `repos` array moved) is a signal. */
  function onTruthPublication(): void {
    if (disposed || currentRepos() === heldFrom) return
    discoveryDirty = true
    schedule()
  }

  function readPending(): PendingByRow {
    if (pooled === null) return NO_PENDING
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
  // Two timestamps and a staffing bit, never retained session records.
  // Supplement the retained R2 roster with headless seats (which never take
  // part in resume collapse). Normal/shell staffing uses the existing roster.
  const rawSessionFacts = new Map<
    string,
    {
      owner: string
      replica?: string
      tip?: string
      headlessStaffed: boolean
      headlessOccupied: boolean
    }
  >()
  const sessionsByOwner = new Map<
    string,
    Map<
      string,
      { replica?: string; tip?: string; headlessStaffed: boolean; headlessOccupied: boolean }
    >
  >()
  const issueSessionFacts = new Map<string, NonNullable<SliceIssue['sessionFacts']>>()
  let sessionFactsReady = false

  function installSessionFacts(id: string, row: AnyRow | undefined): string[] {
    const owners = new Set<string>()
    const before = rawSessionFacts.get(id)
    if (before) {
      owners.add(before.owner)
      sessionsByOwner.get(before.owner)?.delete(id)
    }
    rawSessionFacts.delete(id)
    if (row && typeof row.issueId === 'string') {
      const facts = {
        owner: row.issueId,
        replica: row.agentKind === 'shell' ? undefined : (row.lastActiveAt as string | undefined),
        tip: row.archived === true ? undefined : (row.lastActiveAt as string | undefined),
        headlessStaffed: row.headless === true && row.archived !== true && row.status !== 'exited',
        headlessOccupied: ISSUE_SESSION_FACTS_SUMMARY.headlessOccupied.test(row),
      }
      owners.add(facts.owner)
      rawSessionFacts.set(id, facts)
      let members = sessionsByOwner.get(facts.owner)
      if (!members) {
        members = new Map()
        sessionsByOwner.set(facts.owner, members)
      }
      members.set(id, facts)
    }
    const moved: string[] = []
    for (const owner of owners) {
      let replicaActivityAt: string | undefined, tipActivityAt: string | undefined
      let headlessStaffed = false,
        headlessOccupied = false
      for (const facts of sessionsByOwner.get(owner)?.values() ?? EMPTY) {
        if (facts.replica && (!replicaActivityAt || facts.replica > replicaActivityAt))
          replicaActivityAt = facts.replica
        if (facts.tip && (!tipActivityAt || facts.tip > tipActivityAt)) tipActivityAt = facts.tip
        headlessStaffed ||= facts.headlessStaffed
        headlessOccupied ||= facts.headlessOccupied
      }
      const previous = issueSessionFacts.get(owner)
      if (
        !previous ||
        previous.replicaActivityAt !== replicaActivityAt ||
        previous.tipActivityAt !== tipActivityAt ||
        previous.headlessStaffed !== headlessStaffed ||
        previous.headlessOccupied !== headlessOccupied
      ) {
        issueSessionFacts.set(owner, {
          replicaActivityAt,
          tipActivityAt,
          headlessStaffed,
          headlessOccupied,
        })
        moved.push(owner)
      }
      if (sessionsByOwner.get(owner)?.size === 0) sessionsByOwner.delete(owner)
    }
    return moved
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
    const repo =
      typeof projection?.repoId === 'string' ? authority('repos', projection.repoId) : undefined
    const deps = outgoing.get(id) ?? EMPTY
    const blocked = deps.some((edge) => edge.type === 'blocks' && closedInput(edge.id) === false)
    return issueInput(
      projection,
      userState,
      gitState,
      repo,
      deps,
      blocked,
      issueSessionFacts.get(id) ?? NO_SESSION_FACTS,
    )
  }

  function hasOverlays(kind: 'session' | 'issue', id: string, pending: PendingByRow): boolean {
    if (kind === 'session') return pending.sessions.has(id) || pending.sessionUserStates.has(id)
    return pending.issueUserStates.has(id) || pending.issueProjections.has(id)
  }

  function prefixOf(repoId: string): string | null {
    let row: AnyRow | undefined
    try {
      row = readRow('repos', repoId)
    } catch {
      row = undefined
    }
    return typeof row?.prefix === 'string' ? (row.prefix as string) : null
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
    const prefix = repoId !== null ? prefixOf(repoId) : null
    const sig = `${path}|${repoId ?? ''}|${repoPath}|${repoName}|${prefix ?? ''}|${branch ?? ''}|${isMain ?? ''}|${projectIndex ?? ''}|${projectAliases?.join(',') ?? ''}|${projectRoot ?? ''}`
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
      ...(prefix !== null ? { prefix } : {}),
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
        project.path === repo.path,
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
    for (const repo of repos) for (const wt of repo.worktrees ?? []) linked.add(wt.path)
    const roots: RepoEntry[] = []
    const byId = new Map<string, RepoEntry[]>()
    for (const repo of repos) {
      if (linked.has(repo.path)) continue
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
      const key = repoIdOf(repo) ?? (origin || `__no_remote__:${repo.machineId ?? ''}:${repo.path}`)
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

  /** Lanes of the repo whose `repos` row moved — bounded by that repo's lanes. */
  function resolveReposFanout(repoId: string): RowRecord[] {
    const repos = currentRepos()
    const fresh = repoIndex?.from !== repos
    const index = indexFor(repos)
    if (fresh) stats.enumerations += 1
    const out: RowRecord[] = []
    for (const repo of index.byId.get(repoId) ?? EMPTY) {
      for (const lane of lanesOf(repo, index.projects.get(repo)!)) {
        stats.rowsVisited += 1
        out.push({ kind: 'worktree', id: lane.path, value: lane })
        if (held !== null && repos === heldFrom) held.set(lane.path, lane)
      }
    }
    // No lane yet (a repo the scan has not reported): the prefix change is
    // still signalled with the raw row.
    if (out.length === 0) {
      stats.rowsVisited += 1
      let raw: AnyRow | undefined
      try {
        raw = readRow('repos', repoId)
      } catch {
        raw = undefined
      }
      out.push({ kind: 'worktree', id: repoId, value: raw as unknown as SliceWorktree | undefined })
    }
    return out
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
    if (!overlaid.has(key)) return value
    const previous = overlaid.get(key)
    return previous !== undefined && value !== undefined && shallowEqual(previous, value)
      ? previous
      : value
  }

  /** Every row of one kind, once: server truth folded with pending overlays,
   *  plus pending inserts no server row covers yet. Resets that kind's memo
   *  entries (the caller hands every value it returns to the arms). */
  function enumerate(kind: 'session' | 'issue', pending: PendingByRow): RowRecord[] {
    for (const key of [...overlaid.keys()]) if (key.startsWith(`${kind}:`)) overlaid.delete(key)
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
      const value = resolve(kind, id, pending)
      if (kind === 'issue') {
        const closed = closedInput(id)
        if (closed !== undefined) closure.set(id, closed)
      }
      if (hasOverlays(kind, id, pending)) overlaid.set(`${kind}:${id}`, value)
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

  /** Repo facts already persisted before discovery has supplied any lanes.
   *  Only snapshots and replaces enumerate these; ordinary updates keep the
   *  keyed `resolveReposFanout` path. Raw rows never enter the lane diff. */
  function unscannedRepos(): RowRecord[] {
    const index = indexFor(currentRepos())
    const out: RowRecord[] = []
    for (const raw of replica.rows('repos')) {
      const id = idOf(raw)
      if (id === null || index.byId.has(id)) continue
      stats.rowsVisited += 1
      out.push({ kind: 'worktree', id, value: raw as unknown as SliceWorktree })
    }
    return out
  }

  function flush(): RowSourceEvent | null {
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
      rawSessionFacts.clear()
      sessionsByOwner.clear()
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
          ...unscannedRepos(),
        ],
      }
      emit(event, recovering)
      return event
    }

    const byKey = new Map<string, RowRecord>()
    // 0. Discovery: lanes the new `repos` answer moved (O(1) when it did not).
    discoveryRows(byKey)
    // 1. Kernel-addressed rows: always emitted.
    const addressed = new Map<string, { kind: 'session' | 'issue'; id: string }>()
    for (const address of addresses) {
      if (address.kind === 'repos') {
        for (const row of resolveReposFanout(address.id)) byKey.set(`${row.kind}:${row.id}`, row)
        for (const session of repoSessions.get(address.id) ?? EMPTY)
          addressed.set(`session:${session}`, { kind: 'session', id: session })
        for (const owner of repoIssues.get(address.id) ?? EMPTY)
          addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
        continue
      }
      if (address.kind === 'sessionUserStates') {
        const id = installSessionUserKey(address.id)
        if (id) addressed.set(`session:${id}`, { kind: 'session', id })
        continue
      }
      if (address.kind === 'machines') {
        for (const id of machineSessions.get(address.id) ?? EMPTY)
          addressed.set(`session:${id}`, { kind: 'session', id })
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
        installSessionJoin(address.id, authority('sessions', address.id))
        ensureSessionFacts()
        for (const owner of installSessionFacts(address.id, authority('sessions', address.id))) {
          addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
        }
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
        installIssueRepo(address.id, authority('issueProjections', address.id))
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
      const value = retain(key, resolve(kind, id, pending))
      if (hasOverlays(kind, id, pending)) overlaid.set(key, value)
      else overlaid.delete(key)
      byKey.set(key, { kind, id, value })
    }

    // 2. Rows the pool log names — overlaid now, or overlaid at the last flush —
    //    emitted only when their value moved from what the arms hold.
    const pendingRows = new Map<string, { kind: 'session' | 'issue'; id: string }>()
    for (const id of pending.sessions.keys())
      pendingRows.set(`session:${id}`, { kind: 'session', id })
    for (const id of pending.sessionUserStates.keys())
      pendingRows.set(`session:${id}`, { kind: 'session', id })
    for (const id of pending.issueUserStates.keys())
      pendingRows.set(`issue:${id}`, { kind: 'issue', id })
    for (const id of pending.issueProjections.keys())
      pendingRows.set(`issue:${id}`, { kind: 'issue', id })
    for (const key of overlaid.keys()) {
      if (pendingRows.has(key)) continue
      const colon = key.indexOf(':')
      pendingRows.set(key, {
        kind: key.slice(0, colon) as 'session' | 'issue',
        id: key.slice(colon + 1),
      })
    }
    for (const [key, { kind, id }] of pendingRows) {
      if (addressed.has(key)) continue
      stats.rowsVisited += 1
      const held = overlaid.has(key) ? overlaid.get(key) : resolve(kind, id, null)
      const value = retain(key, resolve(kind, id, pending))
      if (hasOverlays(kind, id, pending)) overlaid.set(key, value)
      else overlaid.delete(key)
      if (value !== held) byKey.set(key, { kind, id, value })
    }

    if (byKey.size === 0) return null
    const event: RowSourceEvent = { type: 'update', rows: [...byKey.values()] }
    emit(event)
    return event
  }

  function emit(event: RowSourceEvent, recovering = false): void {
    stats.events += 1
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
    if (kind === 'worktree') return [...allLanes(), ...unscannedRepos()]
    return enumerate(kind, readPending())
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
        rows: [...snapshot('session'), ...snapshot('issue'), ...snapshot('worktree')],
      })
      coldIndex = index
    }
    return coldIndex
  }

  const source: RowSource = {
    diagnostics,
    snapshot,
    row,
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
  // Truth mode, and a pooled feed that owns every kind, read nothing the
  // runtime publishes but discovery: kernel addresses and the log's repaint
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
      const held = overlaid.has(key) ? overlaid.get(key) : resolve(kind, id, null)
      const value = retain(key, resolve(kind, id, pending))
      if (hasOverlays(kind, id, pending)) overlaid.set(key, value)
      else overlaid.delete(key)
      if (value !== held) byKey.set(key, { kind, id, value })
    }
    if (byKey.size === 0) return null
    const event: RowSourceEvent = { type: 'update', rows: [...byKey.values()] }
    emit(event)
    return event
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

  // Seed the overlaid memo with the rows already painted at creation, so the
  // first flush compares against what `snapshot()` would have served. O(pending).
  try {
    const pending = readPending()
    for (const kind of OVERLAID) {
      for (const id of pending[kind].keys()) {
        const row = kind === 'sessions' || kind === 'sessionUserStates' ? 'session' : 'issue'
        overlaid.set(`${row}:${id}`, resolve(row, id, pending))
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
      coldIndex = null
      coldNeedsReseed = false
      diagnostics.resyncPending = false
      pendingAddresses.clear()
      overlaid.clear()
      held = null
      repoIndex = null
    },
  }
}

const EMPTY: readonly never[] = [] as const
const NO_SESSION_FACTS = Object.freeze({})

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
