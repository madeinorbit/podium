/**
 * POD-4444 — the kernel's effective per-row change stream, as the arms see it.
 *
 * One publication from the runtime is one {@link RowSourceEvent}: kernel
 * addresses collected from the facade's `subscribeAddressedBatch` seam are
 * resolved against the runtime's folded (post-optimism) snapshot, so arms
 * never diff collections and never read the kernel themselves. That isolation
 * is what round one lacked (methodology §3: the comparison measured the port,
 * not the approach).
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
 * is where the replica binding publishes the runtime snapshot), then addressed
 * listeners. A kernel batch therefore lands as: runtime publication FIRST,
 * addressed batch SECOND, in the same synchronous drain. Buffering addresses
 * and draining on the runtime publication would miss them, so this source
 * coalesces both signals into one microtask flush: whatever arrived
 * synchronously since the last flush — kernel addresses, a runtime
 * publication, or both — becomes exactly one event. "One publication, one
 * event" holds even when the runtime nests `apply()` calls inside a batch,
 * and a `replica.batch()` of 50 upserts yields exactly one update with 50
 * rows. Tests that need determinism call `flush()` synchronously instead of
 * awaiting the microtask; both go through the same drain.
 *
 * OPTIMISTIC-ONLY PUBLICATIONS (no kernel address — a press, an echo
 * retirement, a rejection) still emit: the touched ids are found by diffing
 * the folded snapshot against the previous flush's maps. That diff is O(N) in
 * the touched KIND's size and is counted in `rebuilds`; kernel-addressed
 * publications cost O(addresses) plus at most one index rebuild per kind
 * whose array identity moved (the legacy fold allocates fresh arrays even for
 * one row — that is the inherited write-path cost, reported in the cost
 * table, not charged to `rowsVisited`).
 *
 * LOCALS-ONLY PUBLICATIONS (selection, drafts, host metrics, a coarse tick
 * that moved no band) carry no kernel address and no folded-row change, so
 * they emit NO event. Arms already receive locals (`SliceLocals`) out of
 * band; waking them with an empty update would rebuild the idle cost the
 * slice removes. `selectionClick (locals only)` therefore yields zero events.
 *
 * OUT-OF-SLICE KINDS (`issueEvents`, `pendingInteractions`, `shipOrders`,
 * `conversations`, `automations`, `automationRuns`, `userLayouts`) never
 * produce rows. A publication touching only those kinds emits no event.
 *
 * ISSUE DUAL-WRITE ASSUMPTION. An `issue` row carries the wire row
 * (`IssueWire`, cast to `SliceIssue` — the wire holds every slice field the
 * legacy views read). A projection-only address resolves to the wire row when
 * one exists, else to the projection row cast up. The scenarios keep wire and
 * projection dual-written, so a projection change always arrives with its
 * wire change in the same batch and dedupes to one row. A projection-only
 * write with a stale wire would paint stale — that has not been observed on
 * this branch; if it appears it is a finding for the write-path decision
 * (methodology §6.4), not a silent miss.
 *
 * DEP EDGES. An `issueDeps` address resolves through the dep row's `fromId`
 * to the owning issue and emits that issue's wire row. A dep removal whose
 * row is already gone cannot resolve its owner and is skipped; the scenarios
 * always update the wire alongside the edge, so the issue event still lands.
 * The full continuation walk is out of slice (§6) — R4 is the single edge.
 *
 * WORKTREE LANES. One `SliceWorktree` per repo root plus one per scanned
 * worktree, from `EngineState.repos` (`GitRepositoryWire`) joined with the
 * replica `repos` prefix map. A `repos` address (prefix change) emits only the
 * lanes of that repo — bounded fan-out; arms re-derive affected `displayRef`s
 * through their own prefix index. Lanes are memoized by path signature, so an
 * unrelated heartbeat rebuilds no lane object.
 *
 * DISPOSAL. `dispose()` unsubscribes from both the runtime and the replica; a
 * disposed source never emits again (principal switch, methodology #11).
 */

import type {
  ReplicaAddressedBatch,
  ReplicaKind,
} from '@podium/client-core/replica'
import type { RowSource } from './arm'
import type {
  SliceIssue,
  SliceSession,
  SliceWorktree,
} from './slice-types'
import type { RowRecord, RowSourceEvent } from './stats'

/** The runtime surface the row source reads. Structural so tests can drive it
 *  with a fake; the real `ClientRuntime` satisfies it by shape (`subscribe`,
 *  `getSnapshot` with the folded entity lists). */
export interface RowSourceRuntime {
  subscribe(listener: () => void): () => void
  getSnapshot(): {
    sessions: readonly { sessionId: string }[]
    issues: readonly { id: string }[]
    issueProjections: readonly { id: string }[]
    repos: readonly {
      path: string
      repoId?: string | null
      worktrees?: readonly { path: string }[]
    }[]
  }
}

/** The replica surface the row source reads. The addressed seam is optional —
 *  without it the source still emits optimistic-only events, but kernel
 *  changes arrive kind-grained and resolve to per-kind refreshes rather than
 *  per-row addresses (documented degradation, not a silent miss). */
export interface RowSourceReplica {
  subscribeAddressedBatch?(
    cb: (batch: ReplicaAddressedBatch) => void,
  ): () => void
  subscribeRowBatch?(cb: (changed: ReadonlySet<ReplicaKind>) => void): () => void
  rows<K extends ReplicaKind>(kind: K): readonly { [k: string]: unknown }[]
  row?<K extends ReplicaKind>(
    kind: K,
    id: string,
  ): { [k: string]: unknown } | undefined
}

/** Counts-first instrumentation (methodology §5.7). `rowsVisited` is the
 *  verdict-carrying counter: map gets per emitted row, O(addresses) on the
 *  kernel path. `rebuilds` counts per-kind index rebuilds forced by fresh
 *  array identities (the legacy fold cost). A heartbeat visits 1 row at every
 *  scale; if rebuilds dominate at 4x, that is a write-path finding (§6.4). */
export interface RowSourceStats {
  rowsVisited: number
  rebuilds: number
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

type PendingAddress = { kind: ReplicaKind; id: string }

const SLICE_KINDS: ReadonlySet<ReplicaKind> = new Set([
  'sessions',
  'issues',
  'issueProjections',
  'issueDeps',
  'repos',
])

function repoNameOf(path: string): string {
  const tail = path.split('/').filter(Boolean).pop()
  return tail ?? path
}

export function createRowSource(
  runtime: RowSourceRuntime,
  replica: RowSourceReplica,
): RowSourceHandle {
  const listeners = new Set<(event: RowSourceEvent) => void>()
  let disposed = false

  // Pending signals since the last flush.
  const pending = new Map<string, PendingAddress>()
  let pendingReplace: 'bootstrap' | 'rescope' | null = null
  let runtimeDirty = false
  let scheduled = false

  // Memoized per-kind indexes over the folded snapshot. Rebuilt only when the
  // array identity moves; a heartbeat re-indexes the sessions kind once and
  // visits exactly its addressed row.
  let sessionArray: readonly { sessionId: string }[] | null = null
  let sessionMap = new Map<string, { sessionId: string }>()
  let wireArray: readonly { id: string }[] | null = null
  let wireMap = new Map<string, { id: string }>()
  let projectionArray: readonly { id: string }[] | null = null
  let projectionMap = new Map<string, { id: string }>()
  let reposSnapshotArray: readonly {
    path: string
    repoId?: string | null
    worktrees?: readonly { path: string }[]
  }[] | null = null
  let prefixArray: readonly { [k: string]: unknown }[] | null = null
  let prefixByRepoId = new Map<string, string | null>()
  // Worktree lanes memoized by path signature (path|repoId|repoPath|name|prefix).
  const laneCache = new Map<string, { sig: string; lane: SliceWorktree }>()

  const stats: RowSourceStats = {
    rowsVisited: 0,
    rebuilds: 0,
    events: 0,
    reset() {
      stats.rowsVisited = 0
      stats.rebuilds = 0
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
      pending.clear()
    } else {
      if (pendingReplace !== null) return
      for (const row of batch.rows) {
        if (!SLICE_KINDS.has(row.kind)) continue
        pending.set(`${row.kind}:${row.id}`, { kind: row.kind, id: row.id })
      }
    }
    schedule()
  }

  function onKindBatch(changed: ReadonlySet<ReplicaKind>): void {
    if (disposed) return
    // Degradation path when the addressed seam is absent: refresh per kind.
    // Kept coarse on purpose — without addresses there is no per-row truth to
    // resolve, and inventing one would be the silent miss. The facade on this
    // branch always carries the seam, so this path is untested by the budgets.
    if (replica.subscribeAddressedBatch !== undefined) return
    if (pendingReplace !== null) return
    for (const kind of changed) {
      if (!SLICE_KINDS.has(kind)) continue
      pending.set(`${kind}:*`, { kind, id: '*' })
    }
    schedule()
  }

  function onRuntimePublication(): void {
    if (disposed) return
    runtimeDirty = true
    schedule()
  }

  function rebuildIndexes(
    snap: ReturnType<RowSourceRuntime['getSnapshot']>,
  ): void {
    if (snap.sessions !== sessionArray) {
      sessionArray = snap.sessions
      sessionMap = new Map(snap.sessions.map((row) => [row.sessionId, row]))
      stats.rebuilds += 1
    }
    if (snap.issues !== wireArray) {
      wireArray = snap.issues
      wireMap = new Map(snap.issues.map((row) => [row.id, row]))
      stats.rebuilds += 1
    }
    if (snap.issueProjections !== projectionArray) {
      projectionArray = snap.issueProjections
      projectionMap = new Map(snap.issueProjections.map((row) => [row.id, row]))
      stats.rebuilds += 1
    }
    if (snap.repos !== reposSnapshotArray) {
      reposSnapshotArray = snap.repos
      stats.rebuilds += 1
    }
    let prefixRows: readonly { [k: string]: unknown }[] = EMPTY
    try {
      prefixRows = replica.rows('repos')
    } catch {
      prefixRows = EMPTY
    }
    if (prefixRows !== prefixArray) {
      prefixArray = prefixRows
      prefixByRepoId = new Map()
      for (const row of prefixRows) {
        const id = typeof row['id'] === 'string' ? (row['id'] as string) : null
        if (id === null) continue
        const prefix =
          typeof row['prefix'] === 'string' ? (row['prefix'] as string) : null
        prefixByRepoId.set(id, prefix)
      }
      stats.rebuilds += 1
    }
  }

  function laneFor(
    path: string,
    repoId: string | null,
    repoPath: string,
  ): SliceWorktree {
    const repoName = repoNameOf(repoPath)
    const prefix = repoId !== null ? (prefixByRepoId.get(repoId) ?? null) : null
    const sig = `${path}|${repoId ?? ''}|${repoPath}|${repoName}|${prefix ?? ''}`
    const cached = laneCache.get(path)
    if (cached !== undefined && cached.sig === sig) return cached.lane
    const lane: SliceWorktree = {
      path,
      ...(repoId !== null ? { repoId } : {}),
      repoPath,
      repoName,
      ...(prefix !== null ? { prefix } : {}),
    }
    laneCache.set(path, { sig, lane })
    return lane
  }

  function currentLanes(): SliceWorktree[] {
    const repos = reposSnapshotArray ?? []
    const lanes: SliceWorktree[] = []
    for (const repo of repos) {
      const repoId =
        typeof repo.repoId === 'string' && repo.repoId.length > 0
          ? repo.repoId
          : null
      lanes.push(laneFor(repo.path, repoId, repo.path))
      for (const wt of repo.worktrees ?? []) {
        lanes.push(laneFor(wt.path, repoId, repo.path))
      }
    }
    return lanes
  }

  function resolveAddress(address: PendingAddress): RowRecord | null {
    const { kind, id } = address
    if (kind === 'sessions') {
      const value = sessionMap.get(id) as unknown as SliceSession | undefined
      stats.rowsVisited += 1
      return { kind: 'session', id, value }
    }
    if (kind === 'issues' || kind === 'issueProjections') {
      const wire = wireMap.get(id) as unknown as SliceIssue | undefined
      stats.rowsVisited += 1
      if (wire !== undefined) return { kind: 'issue', id, value: wire }
      const projection = projectionMap.get(id) as unknown as
        | SliceIssue
        | undefined
      return { kind: 'issue', id, value: projection }
    }
    if (kind === 'issueDeps') {
      // A star address from the kind-batch degradation path cannot resolve an
      // owner; skip rather than emit an unusable row.
      if (id === '*') return null
      let fromId: string | null = null
      try {
        const dep = replica.row?.('issueDeps', id) as
          | { fromId?: unknown; from?: unknown }
          | undefined
        const raw = dep?.fromId ?? dep?.from
        if (typeof raw === 'string') fromId = raw
      } catch {
        fromId = null
      }
      if (fromId === null) return null
      const wire = wireMap.get(fromId) as unknown as SliceIssue | undefined
      stats.rowsVisited += 1
      if (wire !== undefined) return { kind: 'issue', id: fromId, value: wire }
      const projection = projectionMap.get(fromId) as unknown as
        | SliceIssue
        | undefined
      return { kind: 'issue', id: fromId, value: projection }
    }
    if (kind === 'repos') {
      if (id === '*') return null
      stats.rowsVisited += 1
      // A prefix change fans out to the repo's lanes (bounded by that repo's
      // lane count); the lanes themselves are memoized, so untouched repos
      // keep their object identities. Emit the first changed lane here and
      // the rest below — callers dedupe by id, so returning one row per lane
      // needs the fan-out list, which `resolveReposFanout` provides.
      void id
      return null
    }
    return null
  }

  /** Lanes of the repo whose `repos` row moved. Bounded by that repo's lane
   *  count, never the corpus. */
  function resolveReposFanout(repoId: string): RowRecord[] {
    const lanes = currentLanes()
    const out: RowRecord[] = []
    for (const lane of lanes) {
      if (lane.repoId !== repoId) continue
      stats.rowsVisited += 1
      out.push({ kind: 'worktree', id: lane.path, value: lane })
    }
    // Fall back to the raw projection row when no lane matches (a repo the
    // scan has not reported yet): the prefix change is still signalled.
    if (out.length === 0) {
      const raw = prefixArray?.find((row) => row['id'] === repoId) as unknown as
        | SliceWorktree
        | undefined
      out.push({ kind: 'worktree', id: repoId, value: raw })
    }
    return out
  }

  // The optimistic diff needs the PREVIOUS maps, but `rebuildIndexes` replaces
  // them in place. Keep the previous references across the rebuild for the
  // diff, then drop them.
  let prevSessionMap: Map<string, { sessionId: string }> | null = null
  let prevWireMap: Map<string, { id: string }> | null = null
  let prevProjectionMap: Map<string, { id: string }> | null = null

  function flush(): RowSourceEvent | null {
    if (disposed) return null
    const hadReplace = pendingReplace
    const addresses = [...pending.values()]
    const hadRuntime = runtimeDirty
    pending.clear()
    pendingReplace = null
    runtimeDirty = false
    if (!hadReplace && addresses.length === 0 && !hadRuntime) return null

    const snap = runtime.getSnapshot()
    prevSessionMap = sessionMap
    prevWireMap = wireMap
    prevProjectionMap = projectionMap
    rebuildIndexes(snap)

    if (hadReplace) {
      const rows: RowRecord[] = []
      for (const row of sessionMap.values()) {
        stats.rowsVisited += 1
        const value = row as unknown as SliceSession
        rows.push({ kind: 'session', id: row.sessionId, value })
      }
      for (const row of wireMap.values()) {
        stats.rowsVisited += 1
        const value = row as unknown as SliceIssue
        rows.push({ kind: 'issue', id: row.id, value })
      }
      // Projections without a wire row still install (a wire that arrives a
      // beat later upserts over them).
      for (const [id, row] of projectionMap) {
        if (wireMap.has(id)) continue
        stats.rowsVisited += 1
        const value = row as unknown as SliceIssue
        rows.push({ kind: 'issue', id, value })
      }
      for (const lane of currentLanes()) {
        stats.rowsVisited += 1
        rows.push({ kind: 'worktree', id: lane.path, value: lane })
      }
      const event: RowSourceEvent = { type: 'replace', rows }
      emit(event)
      return event
    }

    if (addresses.length > 0) {
      const byId = new Map<string, RowRecord>()
      for (const address of addresses) {
        if (address.kind === 'repos') {
          if (address.id === '*') continue
          for (const row of resolveReposFanout(address.id)) {
            byId.set(`${row.kind}:${row.id}`, row)
          }
          continue
        }
        const row = resolveAddress(address)
        if (row === null) continue
        byId.set(`${row.kind}:${row.id}`, row)
      }
      if (byId.size === 0) return null
      const event: RowSourceEvent = { type: 'update', rows: [...byId.values()] }
      emit(event)
      return event
    }

    // Optimistic-only publication: diff folded rows against the pre-rebuild maps.
    const rows: RowRecord[] = []
    if (sessionArray !== null && prevSessionMap !== null) {
      for (const [id, row] of sessionMap) {
        if (prevSessionMap.get(id) !== row) {
          stats.rowsVisited += 1
          rows.push({
            kind: 'session',
            id,
            value: row as unknown as SliceSession,
          })
        }
      }
      for (const [id, prev] of prevSessionMap) {
        void prev
        if (!sessionMap.has(id)) {
          stats.rowsVisited += 1
          rows.push({ kind: 'session', id, value: undefined })
        }
      }
    }
    if (wireArray !== null && prevWireMap !== null) {
      for (const [id, row] of wireMap) {
        if (prevWireMap.get(id) !== row) {
          stats.rowsVisited += 1
          rows.push({
            kind: 'issue',
            id,
            value: row as unknown as SliceIssue,
          })
        }
      }
      for (const [id, prev] of prevWireMap) {
        void prev
        if (!wireMap.has(id)) {
          stats.rowsVisited += 1
          rows.push({ kind: 'issue', id, value: undefined })
        }
      }
    }
    if (projectionArray !== null && prevProjectionMap !== null) {
      for (const [id, row] of projectionMap) {
        if (wireMap.has(id)) continue
        if (prevProjectionMap.get(id) !== row) {
          stats.rowsVisited += 1
          rows.push({
            kind: 'issue',
            id,
            value: row as unknown as SliceIssue,
          })
        }
      }
      for (const [id, prev] of prevProjectionMap) {
        void prev
        if (!projectionMap.has(id) && !wireMap.has(id)) {
          stats.rowsVisited += 1
          rows.push({ kind: 'issue', id, value: undefined })
        }
      }
    }
    prevSessionMap = null
    prevWireMap = null
    prevProjectionMap = null
    if (rows.length === 0) return null
    // One row per issue id: a wire change shadows its projection twin.
    const byId = new Map<string, RowRecord>()
    for (const row of rows) byId.set(`${row.kind}:${row.id}`, row)
    const event: RowSourceEvent = { type: 'update', rows: [...byId.values()] }
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
    const snap = runtime.getSnapshot()
    rebuildIndexes(snap)
    if (kind === 'session') {
      return [...sessionMap.values()].map((row) => ({
        kind,
        id: row.sessionId,
        value: row as unknown as SliceSession,
      }))
    }
    if (kind === 'issue') {
      const out: RowRecord[] = []
      for (const row of wireMap.values()) {
        out.push({
          kind,
          id: row.id,
          value: row as unknown as SliceIssue,
        })
      }
      for (const [id, row] of projectionMap) {
        if (wireMap.has(id)) continue
        out.push({ kind, id, value: row as unknown as SliceIssue })
      }
      return out
    }
    return currentLanes().map((lane) => ({ kind, id: lane.path, value: lane }))
  }

  const source: RowSource = {
    snapshot,
    subscribe(listener: (event: RowSourceEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const offs: Array<() => void> = []
  if (replica.subscribeAddressedBatch !== undefined) {
    offs.push(replica.subscribeAddressedBatch(onAddressed))
  } else if (replica.subscribeRowBatch !== undefined) {
    offs.push(replica.subscribeRowBatch(onKindBatch))
  }
  offs.push(runtime.subscribe(onRuntimePublication))

  // Prime the maps against the current snapshot so creation itself emits
  // nothing; the first change diffs against this baseline. A source created
  // BEFORE `runtime.start()` primes empty and therefore reports the initial
  // install as a `replace` — which is exactly the cold-bootstrap event.
  try {
    rebuildIndexes(runtime.getSnapshot())
  } catch {
    // A runtime that cannot snapshot yet primes empty; the first flush heals.
  }
  // Priming is bookkeeping, not measurement: the cost table starts clean.
  stats.rebuilds = 0

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
      pending.clear()
    },
  }
}

const EMPTY: readonly never[] = [] as const
