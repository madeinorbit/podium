import { sessionView, type SessionValueInput, type SessionHomes } from '@podium/client-core/session-values'
import { ISSUE_SESSION_FACTS_SUMMARY } from './schema'
/**
 * POD-4444, rewritten per-row by POD-4553 — the kernel's effective per-row
 * change stream, as the arms see it.
 *
 * MODES. `overlaid` (ledger overlays folded in, as the app paints) or `truth`
 * (server rows only, for pools that own their optimism). Every consumer names
 * one; see {@link RowSourceMode}. The rest of this header describes
 * `overlaid`; `truth` is the same feed with the ledger read as empty.
 *
 * One publication from the runtime is one {@link RowSourceEvent}. Each row in
 * it is read BY ID: the authority row from the kernel replica
 * (`replica.row(kind, id)`), with that row's own pending optimistic overlays
 * from the runtime's ledger (`runtime.pendingOverlaysByRow(entity)`) folded
 * over it by `foldRowOverlays` — the ledger's own fold rules, applied to one
 * row. Nothing here indexes a collection per publication: the work of one
 * flush is the rows it names, never the corpus. Arms never diff collections
 * and never read the kernel themselves (methodology §3: round one measured the
 * port, not the approach).
 *
 * WHICH ROWS A FLUSH VISITS (the fence `row-source.test.ts` asserts at 1x and
 * 4x): the distinct slice rows named by the kernel's addressed batch, plus the
 * rows with pending overlays now or at the previous flush, and the owners
 * whose declared small dependency/session summaries moved. The
 * pending set is O(pending writes) — a handful — and it is the only way an
 * optimistic-only publication (a press, an echo retirement, a rejection) can
 * name its rows without diffing arrays.
 *
 * WHAT A FLUSH EMITS. Every kernel-addressed row, always (a heartbeat emits
 * its row even when the fold hides the change). A row visited only because of
 * the ledger is emitted only when its value identity moved from what the arms
 * last received, so a durable commit that repaints the press's own overlay
 * emits nothing (POD-1053).
 *
 * IDENTITY. Sessions without overlays borrow the replica's row object. Issue
 * composition is memoized by projection, user markers, git observation, repo and declared summary
 * identities, so a rejection restores the previous composed issue itself.
 * A folded value that is shallow-equal to the one last emitted
 * for that row keeps the earlier object, as the ledger's whole-list fold does.
 *
 * SPEC CITATIONS (frozen slice `docs/plans/pod-4441-round-two-slice.md`).
 * - §2 maintenance rule: evict carries no tombstone — a row with `value:
 *   undefined` deletes the row and every index bucket holding it. Removed and
 *   evicted look the same to the arm, and that is intended.
 * - §8 measurement interface: `RowRecord` / `RowSourceEvent` in
 *   `shared/src/stats.ts`; `RowSource` in `shared/src/arm.ts`.
 * - Methodology §5.8: scenarios 1–13 drive this stream; §1a budgets judge it.
 *
 * ORDERING. The facade drains row listeners, then kind-batch listeners (which
 * is where the replica binding publishes the runtime snapshot and the ledger
 * recomputes), then addressed listeners. A kernel batch therefore lands as:
 * runtime publication FIRST, addressed batch SECOND, in the same synchronous
 * drain. This source coalesces both signals into one microtask flush:
 * whatever arrived synchronously since the last flush — kernel addresses, a
 * runtime publication, or both — becomes exactly one event, read after the
 * ledger has retired whatever the batch covered. "One publication, one event"
 * holds when the runtime nests `apply()` calls inside a batch, and a
 * `replica.batch()` of 50 upserts yields one update with 50 rows. Tests that
 * need determinism call `flush()` synchronously; both go through one drain.
 *
 * ONE ROW BY ID (POD-4567, shared contract: `RowSource.row`, `arm.ts`).
 * `row(kind, id)` serves one issue or session row exactly as `snapshot(kind)`
 * would carry it — the replica's row by id (`replica.row`), with that row's
 * own overlays folded in `overlaid` mode and the ledger never read in
 * `truth` mode, the previously emitted object kept when the fold recomposed
 * an equal one — and enumerates nothing. It is how a lazy pool loads a cold
 * row it holds only the id of (both round-three pools use it); the reads
 * fence counts it as one keyed read of that row (`reads.ts` `wrapSource`).
 * It leaves the emit memo alone, so the next flush still emits whatever
 * moved. A disposed source throws on reads.
 *
 * REPLACE. A bootstrap or rescope is the one place a flush enumerates the
 * slice (`replica.rows()` per kind, plus pending inserts); `snapshot()` is the
 * other row enumeration. Small edge/session summaries are seeded at source
 * creation and replaced on rescope, never lazily by the first update.
 * Row enumerations count in `stats.enumerations`, which the scenarios
 * assert is 0 on every non-replace publication.
 *
 * LOCALS-ONLY PUBLICATIONS (selection, drafts, host metrics, a coarse tick
 * that moved no band) carry no kernel address and move no overlaid row, so
 * they emit NO event. Arms receive locals through the `LocalsSource` channel
 * (`arm.ts`, POD-4608), which names the keys that moved.
 *
 * OUT-OF-SLICE KINDS (`issueEvents`, `pendingInteractions`, `shipOrders`,
 * `conversations`, `automations`, `automationRuns`, `userLayouts`) never
 * produce rows. A publication touching only those kinds emits no event.
 *
 * ISSUE INPUT. Durable facts come from issueProjections; user markers,
 * git observations and repo paths come from their normalized kinds. Address
 * summaries retain only keys so each update resolves just its affected rows.
 *
 * SESSION RESUME TWINS (a known divergence, not a silent one). The runtime
 * hides all-parked legacy sessions that share a resume ref
 * (`dedupeSessionsByResume`), a whole-kind rule. A per-row feed cannot apply
 * it without a resume-ref index, which is a relation for the declared pool
 * (POD-4546), not for the feed: the feed passes `resume` through on every
 * session row and the pool applies the collapse. The corpus carries one
 * twin group per branch of the rule per scale unit (`corpus.resumeTwins`,
 * POD-4551) and the oracle collapses them as the runtime does, so a pool
 * that forgets the rule fails parity.
 *
 * DEP EDGES. An `issueDeps` address resolves through the dep row's `fromId`
 * to the owning issue and emits that issue's row. A plain edge index remembers
 * the owner through removal. A target's completion boolean is a declared small
 * summary: only a changed server completion fans out to its incoming blocking
 * edges. Pending target stages do not change replica blocking. No worklist
 * selector is read.
 *
 * WORKTREE LANES. One `SliceWorktree` per repo root plus one per scanned
 * worktree, from `EngineState.repos` (`GitRepositoryWire`, engine-local, not a
 * replica kind) joined with the replica `repos` row's prefix, read by id. A
 * top-level entry whose path is another entry's linked worktree is dropped,
 * as legacy `reposToViews` does: a real scan reports each linked worktree
 * twice, and the lane belongs to its parent root. A `repos` address emits
 * only that repo's lanes. Before discovery has reported a repo, snapshots
 * and replaces carry its borrowed replica row (the same raw-row signal as
 * a `repos` address), so persisted prefixes are available offline too.
 *
 * DISCOVERY LANES (POD-4606). Discovery is not a kernel row: `refreshRepos`
 * publishes a whole new `repos` array, with no address. A flush that sees the
 * array's identity move (O(1), in both modes: truth mode subscribes to the
 * runtime for this check alone) diffs the lanes of the new answer against the
 * lanes the arms hold, by path, and emits each lane that appeared or changed
 * value, and `value: undefined` for each that left. Lane objects are memoized
 * by value signature, so a routine refresh that moves nothing visible emits
 * nothing. The discovery answer is the batch: the flush visits every lane it
 * names plus every lane that left, and counts one `enumerations` pass. That
 * pass happens only when the array moves, never on an ordinary publication.
 * Lanes carry no optimism, so `overlaid` and `truth` emit the same rows.
 *
 * DISPOSAL. `dispose()` unsubscribes from both the runtime and the replica; a
 * disposed source never emits again (principal switch, methodology #11), and
 * its `snapshot()` and `row()` throw instead of serving whatever they last
 * held (POD-4574: silent stale reads once looked like a 54-row rollup bug).
 */

import {
  foldRowOverlays,
  type OverlayTarget,
  type PendingOverlay,
} from '@podium/client-core/engine'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { issueInput } from './issue-input'
import { shallowEqual } from '@podium/client-core/store'
import { normalizeOriginUrl, repoNameFromOrigin, parseIssueUserStateRowId, issueUserStateRowId, asUserId, asIssueId, asSessionId, parseSessionUserStateRowId, sessionUserStateRowId } from '@podium/model'
import type { RowSource } from './source'
import type { SliceIssue, SliceSession, SliceWorktree } from './slice-types'
import type { RowRecord, RowSourceEvent } from './source'

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

/** The runtime surface the row source reads. Structural so tests can drive it
 *  with a fake; the real `ClientRuntime` satisfies it by shape. The snapshot is
 *  read for `repos` (worktree lanes) only — entity rows come from the replica
 *  and the ledger, by id. Both modes subscribe: `truth` only to see the
 *  `repos` array move (discovery). */
export interface RowSourceRuntime {
  subscribe(listener: () => void): () => void
  getSnapshot(): { repos: readonly RepoEntry[] }
  readonly principal?: { userId: string }
  pendingOverlaysByRow(entity: OverlayTarget): ReadonlyMap<string, readonly PendingOverlay[]>
}

/** The replica surface the row source reads. `row()` and the addressed seam
 *  are optional on the replica contract; this source refuses to start without
 *  them rather than degrading to kind-grained refreshes. */
export interface RowSourceReplica {
  subscribeAddressedBatch?(cb: (batch: ReplicaAddressedBatch) => void): () => void
  rows<K extends ReplicaKind>(kind: K): readonly AnyRow[]
  row?<K extends ReplicaKind>(kind: K, id: string): AnyRow | undefined
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
type PendingByRow = Record<OverlayTarget, ReadonlyMap<string, readonly PendingOverlay[]>>
const NO_PENDING: PendingByRow = {
  sessions: new Map(),
  sessionUserStates: new Map(),
  issues: new Map(),
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
 * Which rows the feed hands out — chosen by every consumer, no default
 * (coordinator ruling on POD-4553 after the L1c write contract):
 *
 * - `overlaid`: server truth with the runtime ledger's pending overlays folded
 *   over it — what the app paints today. For phase a/b pools, which do not own
 *   optimism, and for parity with the legacy derivation.
 * - `truth`: server truth only; the ledger is never read and a runtime
 *   publication alone never produces a row. For phase c pools, which apply
 *   their own optimistic edits (`write-contract.ts`): an overlay here would
 *   hide a remote value for a locally pending field and rewind a rejection
 *   twice.
 */
export type RowSourceMode = 'overlaid' | 'truth'

export interface RowSourceOptions {
  readonly mode: RowSourceMode
}

export function createRowSource(
  runtime: RowSourceRuntime,
  replica: RowSourceReplica,
  options: RowSourceOptions,
): RowSourceHandle {
  const { mode } = options
  if (mode !== 'overlaid' && mode !== 'truth') {
    throw new Error(`createRowSource: mode must be 'overlaid' or 'truth', got ${String(mode)}`)
  }
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
      if (!members) { members = new Set(); repoIssues.set(row.repoId, members) }
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
    userStateKeys.clear(); issueRepos.clear(); repoIssues.clear()
    for (const row of replica.rows('issueUserStates')) {
      if (typeof row.userId === 'string' && typeof row.entityId === 'string') {
        // Composite keys use the same encoding as the facade, including removals.
        userStateKeys.set(row.entityId, issueUserStateRowId(asUserId(row.userId), asIssueId(row.entityId)))
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
    const machines = [...new Set([row.machineId, row.handoffTargetMachineId].filter((id): id is string => typeof id === 'string'))]
    sessionJoins.set(id, { repo, machines })
    if (repo) { let ids = repoSessions.get(repo); if (!ids) { ids = new Set(); repoSessions.set(repo, ids) }; ids.add(id) }
    for (const machine of machines) { let ids = machineSessions.get(machine); if (!ids) { ids = new Set(); machineSessions.set(machine, ids) }; ids.add(id) }
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
    sessionUserKeys.clear(); sessionJoins.clear(); repoSessions.clear(); machineSessions.clear()
    for (const row of replica.rows('sessionUserStates')) {
      if (typeof row.userId === 'string' && typeof row.sessionId === 'string') {
        installSessionUserKey(sessionUserStateRowId(asUserId(row.userId), asSessionId(row.sessionId)))
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
      (overlays.find((o) => o.op === 'insert') as Extract<PendingOverlay, { op: 'insert' }> | undefined)
        ?.insert
    if (!raw) return undefined
    const value = raw as AnyRow & SessionValueInput
    const userState = foldRowOverlays(
      sessionUserKeys.has(id) ? authority('sessionUserStates', sessionUserKeys.get(id)!) : undefined,
      pending?.sessionUserStates.get(id) ?? NO_OVERLAYS,
    )
    return sessionView(value, {
      userState,
      repo: value.refRepoId ? authority('repos', value.refRepoId) : undefined,
      machine: value.machineId ? authority('machines', value.machineId) : undefined,
      handoffMachine: value.handoffTargetMachineId ? authority('machines', value.handoffTargetMachineId) : undefined,
    } as SessionHomes) as AnyRow
  }

  // Pending signals since the last flush.
  const pendingAddresses = new Map<string, { kind: ReplicaKind; id: string }>()
  let pendingReplace: 'bootstrap' | 'rescope' | null = null
  let runtimeDirty = false
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
    reset() {
      stats.rowsVisited = 0
      stats.enumerations = 0
      stats.flushes = 0
      stats.events = 0
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

  function onRuntimePublication(): void {
    if (disposed) return
    runtimeDirty = true
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
    if (mode === 'truth') return NO_PENDING
    return {
      sessions: runtime.pendingOverlaysByRow('sessions'),
      sessionUserStates: runtime.pendingOverlaysByRow('sessionUserStates'),
      issues: new Map(),
      issueUserStates: runtime.pendingOverlaysByRow('issueUserStates'),
      issueProjections: runtime.pendingOverlaysByRow('issueProjections'),
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
  const rawSessionFacts = new Map<string, { owner: string; replica?: string; tip?: string; headlessStaffed: boolean; headlessOccupied: boolean }>()
  const sessionsByOwner = new Map<string, Map<string, { replica?: string; tip?: string; headlessStaffed: boolean; headlessOccupied: boolean }>>()
  const issueSessionFacts = new Map<string, NonNullable<SliceIssue['sessionFacts']>>()
  let sessionFactsReady = false

  function installSessionFacts(id: string, row: AnyRow | undefined): string[] {
    const owners = new Set<string>()
    const before = rawSessionFacts.get(id)
    if (before) { owners.add(before.owner); sessionsByOwner.get(before.owner)?.delete(id) }
    rawSessionFacts.delete(id)
    if (row && typeof row.issueId === 'string') {
      const facts = { owner: row.issueId,
        replica: row.agentKind === 'shell' ? undefined : row.lastActiveAt as string | undefined,
        tip: row.archived === true ? undefined : row.lastActiveAt as string | undefined,
        headlessStaffed: row.headless === true && row.archived !== true && row.status !== 'exited',
        headlessOccupied: ISSUE_SESSION_FACTS_SUMMARY.headlessOccupied.test(row) }
      owners.add(facts.owner)
      rawSessionFacts.set(id, facts)
      let members = sessionsByOwner.get(facts.owner)
      if (!members) { members = new Map(); sessionsByOwner.set(facts.owner, members) }
      members.set(id, facts)
    }
    const moved: string[] = []
    for (const owner of owners) {
      let replicaActivityAt: string | undefined, tipActivityAt: string | undefined
      let headlessStaffed = false, headlessOccupied = false
      for (const facts of sessionsByOwner.get(owner)?.values() ?? EMPTY) {
        if (facts.replica && (!replicaActivityAt || facts.replica > replicaActivityAt)) replicaActivityAt = facts.replica
        if (facts.tip && (!tipActivityAt || facts.tip > tipActivityAt)) tipActivityAt = facts.tip
        headlessStaffed ||= facts.headlessStaffed
        headlessOccupied ||= facts.headlessOccupied
      }
      const previous = issueSessionFacts.get(owner)
      if (!previous || previous.replicaActivityAt !== replicaActivityAt || previous.tipActivityAt !== tipActivityAt || previous.headlessStaffed !== headlessStaffed || previous.headlessOccupied !== headlessOccupied) {
        issueSessionFacts.set(owner, { replicaActivityAt, tipActivityAt, headlessStaffed, headlessOccupied }); moved.push(owner)
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
    const after = raw === undefined ? undefined : {
      from: String(raw.fromId ?? raw.from ?? ''),
      to: String(raw.toId ?? raw.to ?? ''), type: String(raw.type ?? ''),
    }
    const owners = new Set<string>()
    if (before !== undefined) {
      owners.add(before.from)
      outgoing.set(before.from, (outgoing.get(before.from) ?? []).filter(e => !(e.id === before.to && e.type === before.type)))
      if (before.type === 'blocks') incoming.get(before.to)?.delete(before.from)
    }
    edgeRows.delete(id)
    if (after !== undefined && after.from && after.to) {
      edgeRows.set(id, after)
      owners.add(after.from)
      outgoing.set(after.from, [...(outgoing.get(after.from) ?? []), { id: after.to, type: after.type }])
      if (after.type === 'blocks') {
        let ownersOf = incoming.get(after.to)
        if (ownersOf === undefined) { ownersOf = new Set(); incoming.set(after.to, ownersOf) }
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
    return projection === undefined ? undefined : projection.stage === 'done'
  }

  function resolve(
    kind: 'session' | 'issue',
    id: string,
    pending: PendingByRow | null,
  ): RowRecord['value'] {
    if (kind === 'session') return foldRowOverlays(sessionInput(id, pending), pending?.sessions.get(id) ?? NO_OVERLAYS) as SliceSession | undefined
    ensureEdges()
    ensureSessionFacts()
    const projection = folded('issueProjections', id, pending)
    const userState = foldRowOverlays(authority('issueUserStates', userStateKeys.get(id) ?? ''), pending?.issueUserStates.get(id) ?? NO_OVERLAYS)
    const gitState = authority('issueGitStates', id)
    const repo = typeof projection?.repoId === 'string' ? authority('repos', projection.repoId) : undefined
    const deps = outgoing.get(id) ?? EMPTY
    const blocked = deps.some(edge => edge.type === 'blocks' && closedInput(edge.id) === false)
    return issueInput(projection, userState, gitState, repo, deps, blocked, issueSessionFacts.get(id) ?? NO_SESSION_FACTS)
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

  function laneFor(path: string, repoId: string | null, repoPath: string, branch?: string, isMain?: boolean, projectIndex?: number, projectAliases?: readonly string[], name?: string, projectRoot?: boolean): SliceWorktree {
    const repoName = name ?? repoNameOf(repoPath)
    const prefix = repoId !== null ? prefixOf(repoId) : null
    const sig = `${path}|${repoId ?? ''}|${repoPath}|${repoName}|${prefix ?? ''}|${branch ?? ''}|${isMain ?? ''}|${projectIndex ?? ''}|${projectAliases?.join(',') ?? ''}|${projectRoot ?? ''}`
    const cached = laneCache.get(path)
    if (cached !== undefined && cached.sig === sig) return cached.lane
    const lane: SliceWorktree = {
      path,
      ...(repoId !== null ? { repoId } : {}),
      repoPath,
      repoName, branch, isMain, projectIndex, projectAliases, projectRoot,
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
    const lanes = [laneFor(repo.path, repoId, repo.path, repo.branch, true, project.index, project.aliases, project.name, project.path === repo.path)]
    for (const wt of repo.worktrees ?? []) lanes.push(laneFor(wt.path, repoId, repo.path, wt.branch, false, project.index, project.aliases, project.name, false))
    return lanes
  }

  function currentRepos(): readonly RepoEntry[] {
    try {
      return runtime.getSnapshot().repos
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
      const origin = group.map(repo => normalizeOriginUrl(repo.originUrl)).find(Boolean)
      const aliases = [repoIdOf(first), first.path, ...group.filter(repo => repo.machineId !== undefined).map(repo => repo.path)].filter((key): key is string => key !== null)
      const project = { index: index++, path: first.path, aliases, name: repoNameFromOrigin(origin) ?? repoNameOf(first.path) }
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
      if (before.get(path) !== lane) into.set(`worktree:${path}`, { kind: 'worktree', id: path, value: lane })
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
      if (kind === 'issue') { const closed = closedInput(id); if (closed !== undefined) closure.set(id, closed) }
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
    const hadReplace = pendingReplace
    const addresses = [...pendingAddresses.values()]
    const hadRuntime = runtimeDirty || discoveryDirty
    pendingAddresses.clear()
    pendingReplace = null
    runtimeDirty = false
    discoveryDirty = false
    if (!hadReplace && addresses.length === 0 && !hadRuntime) return null

    const pending = readPending()

    stats.flushes += 1
    if (hadReplace) {
      seedIssueJoins()
      seedSessionJoins()
      edgesReady = false
      edgeRows.clear(); outgoing.clear(); incoming.clear(); closure.clear()
      ensureEdges()
      sessionFactsReady = false
      rawSessionFacts.clear(); sessionsByOwner.clear(); issueSessionFacts.clear()
      ensureSessionFacts()
      stats.enumerations += 1
      const lanes = allLanes()
      // Every subscriber now holds these lanes.
      heldFrom = currentRepos()
      held = new Map(lanes.map((row) => [row.id, row.value as SliceWorktree]))
      const event: RowSourceEvent = {
        type: 'replace',
        rows: [
          ...enumerate('session', pending), ...enumerate('issue', pending),
          ...lanes, ...unscannedRepos(),
        ],
      }
      emit(event)
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
        for (const session of repoSessions.get(address.id) ?? EMPTY) addressed.set(`session:${session}`, { kind: 'session', id: session })
        for (const owner of repoIssues.get(address.id) ?? EMPTY) addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
        continue
      }
      if (address.kind === 'sessionUserStates') {
        const id = installSessionUserKey(address.id)
        if (id) addressed.set(`session:${id}`, { kind: 'session', id })
        continue
      }
      if (address.kind === 'machines') {
        for (const id of machineSessions.get(address.id) ?? EMPTY) addressed.set(`session:${id}`, { kind: 'session', id })
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
          for (const owner of incoming.get(address.id) ?? EMPTY) addressed.set(`issue:${owner}`, { kind: 'issue', id: owner })
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

    // 2. Rows the ledger names — overlaid now, or overlaid at the last flush —
    //    emitted only when their value moved from what the arms hold.
    const ledgerRows = new Map<string, { kind: 'session' | 'issue'; id: string }>()
    for (const id of pending.sessions.keys())
      ledgerRows.set(`session:${id}`, { kind: 'session', id })
    for (const id of pending.sessionUserStates.keys())
      ledgerRows.set(`session:${id}`, { kind: 'session', id })
    for (const id of pending.issueUserStates.keys()) ledgerRows.set(`issue:${id}`, { kind: 'issue', id })
    for (const id of pending.issueProjections.keys())
      ledgerRows.set(`issue:${id}`, { kind: 'issue', id })
    for (const key of overlaid.keys()) {
      if (ledgerRows.has(key)) continue
      const colon = key.indexOf(':')
      ledgerRows.set(key, {
        kind: key.slice(0, colon) as 'session' | 'issue',
        id: key.slice(colon + 1),
      })
    }
    for (const [key, { kind, id }] of ledgerRows) {
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

  function emit(event: RowSourceEvent): void {
    stats.events += 1
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // One throwing arm must not stop the others; matches the facade's
        // observer isolation contract.
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

  const source: RowSource = {
    snapshot,
    row,
    subscribe(listener: (event: RowSourceEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const offs: Array<() => void> = []
  offs.push(subscribeAddressed(onAddressed))
  // Truth mode reads nothing the runtime publishes but discovery: kernel
  // addresses name its rows, so only a moved `repos` array is a signal.
  heldFrom = currentRepos()
  offs.push(runtime.subscribe(mode === 'overlaid' ? onRuntimePublication : onTruthPublication))

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
