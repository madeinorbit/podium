/**
 * POD-4448 — the TanStack store: RowSourceEvents in, SliceSnapshot out.
 *
 * Dataflow (all synchronous, one notification pass per publication):
 * RowSourceEvent → prefix seats → entity sync writes (+locals version bump)
 * → live-query propagation → rollup sync (batched) → commit layer
 * (identity-stable rows, order surface, per-key notify). Selection and the
 * coarse clock are locals: setSelection notifies two keys + the latch rows;
 * setCoarseNow writes the locals row and lets the joined queries re-run.
 * A replace reseeds entities + prefix atomically (one notify) and rebuilds
 * the rollup from current collections.
 *
 * Stats (hand-aligned): rowsDerived counts committed rows; rollupsDerived
 * counts post-gate per-issue derivation bodies (summary folds, rollup
 * recomputes, rows folds); indexUpdates counts relation-seat writes;
 * notifications counts dispatches including no-ops. Per-query fn runs live
 * in GraphRuns for the NOTES tables, not in ArmStats.
 */

import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ArmHandle, RowSource } from '../../shared/src/arm'
import { CommitLogContext, currentCommitLog } from '../../shared/src/row-shell'
import type {
  SliceIssue,
  SliceLocals,
  SliceOrder,
  SliceRow,
  SliceSession,
  SliceSnapshot,
  SliceWorktree,
} from '../../shared/src/slice-types'
import type { ArmStats, RowSourceEvent } from '../../shared/src/stats'
import {
  applyEventRows,
  createEntityCollections,
  PrefixIndex,
  type EntityCollections,
  type LocalsRow,
} from './collections'
import {
  createBaseQueries,
  createGraphRuns,
  createTopQueries,
  type BaseQueries,
  type ChildRow,
  type GraphRuns,
  type LaneRow,
  type LiveQuery,
  type RowsRow,
  type TopQueries,
  type VerdictRow,
} from './queries'
import { RollupSync, type OriginTick, type RollupRow } from './rollup'
import { inClosedFold } from './rules'
import { TanStackList } from './react/list'

type Listener = () => void

export class TanStackStore {
  readonly prefix: PrefixIndex
  readonly runs: GraphRuns
  readonly stats: ArmStats
  readonly locals: SliceLocals
  /** Rebuilt on every `replace` (rescope): the bulk reseed goes through the
   *  proven bootstrap path (seed entities, then build the graph over settled
   *  state) instead of pushing thousands of inserts through the live graph,
   *  where the 0.9.2 join canonicalization throws on transient same-key
   *  contributors (M3 rescope finding). One replace event in, full-once
   *  install out; the commit layer still transitions rows incrementally
   *  against the retained `rows` map. */
  entities!: EntityCollections
  base!: BaseQueries
  rollup!: RollupSync
  top!: TopQueries
  /** Committed rows by id (identity-stable unless the value moved). */
  readonly rows = new Map<string, SliceRow>()
  private readonly lastTick = new Map<string, OriginTick | null>()
  private readonly graceSensitive = new Set<string>()
  private orderCache: SliceOrder | null = null
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly unsubs: Array<() => void> = []
  private off: (() => void) | null = null
  private webRoot: { unmount(): void } | null = null
  private rowsDirty = new Set<string>()
  private orderDirty = false
  private markSummary = 0
  private markRows = 0
  /**
   * Named multi-row walks (H4 residual R-T1 slope material). Same convention
   * as the MobX arm: cumulative visits since the last `stats.reset()`, so
   * each count-harness step reads its own delta. Recording a walk never
   * changes derivation behavior.
   */
  private readonly scanTotals = new Map<string, number>()
  /**
   * Cumulative computation-share walls per phase (M3 stats split,
   * methodology §6.4): index = sync-write + prefix + version-bump walls
   * EXCLUSIVE of the query-graph and rollup work they synchronously drive
   * (TanStack pushes eagerly inside writes — inseparable at this boundary,
   * so the exclusive wall is the section wall minus the fn/rollup deltas
   * inside it); rollup = query fn bodies + RollupSync entries + order
   * rebuild; row = commit shaping (refreshRows). Plain totals beside
   * ArmStats (the `scan()` precedent): mutated from callbacks, never
   * observed, cleared by `stats.reset()`. Happy-dom proxy only — browser
   * walls belong to POD-4489.
   */
  private readonly phaseMsTotals = { indexMs: 0, rollupMs: 0, rowMs: 0 }

  constructor(
    private readonly source: RowSource,
    locals: SliceLocals,
  ) {
    this.locals = { ...locals }
    const stats: ArmStats = {
      rowsDerived: 0,
      rollupsDerived: 0,
      indexUpdates: 0,
      notifications: 0,
      reset: () => {
        stats.rowsDerived = 0
        stats.rollupsDerived = 0
        stats.indexUpdates = 0
        stats.notifications = 0
        this.scanTotals.clear()
        this.phaseMsTotals.indexMs = 0
        this.phaseMsTotals.rollupMs = 0
        this.phaseMsTotals.rowMs = 0
      },
    }
    this.stats = stats
    this.runs = createGraphRuns()
    const countIndex = (): void => {
      stats.indexUpdates += 1
    }
    this.prefix = new PrefixIndex(countIndex, (name, visits) => this.scan(name, visits))

    // Seed from the source snapshot (cold path is silent — arms snapshot).
    const seedOf = <T>(kind: 'issue' | 'session' | 'worktree'): T[] =>
      source
        .snapshot(kind)
        .map((r) => r.value as T | undefined)
        .filter((v): v is T => v !== undefined)
    this.buildGraph({
      issues: seedOf<SliceIssue>('issue'),
      sessions: seedOf<SliceSession>('session'),
      worktrees: seedOf<SliceWorktree>('worktree'),
      now: this.locals.coarseNow,
    })

    this.rebuildRows(
      (this.top.rowsQ.toArray as RowsRow[]).map((row) => row.id),
    )
    this.rebuildOrder()
    this.off = source.subscribe((event) => this.dispatch(event))
    stats.reset()
    this.runs.reset()
    this.markSummary = 0
    this.markRows = 0
  }

  /**
   * Seed entities, then build the query graph + rollup over settled state
   * (the bootstrap path). Rows/order are NOT touched here: the constructor
   * commits them explicitly after, and `replace` reconciles against the
   * retained commit layer so only moved rows re-commit.
   */
  private buildGraph(seed: {
    issues: SliceIssue[]
    sessions: SliceSession[]
    worktrees: SliceWorktree[]
    now: number
  }): void {
    this.entities = createEntityCollections({
      issues: seed.issues,
      sessions: seed.sessions,
      worktrees: seed.worktrees,
      now: seed.now,
    })
    this.prefix.seed(
      this.entities.issues.collection.toArray.map((row) => [row.id, row] as [string, SliceIssue]),
      this.entities.worktrees.collection.toArray.map(
        (row) => [row.path, row] as [string, SliceWorktree],
      ),
    )

    this.base = createBaseQueries(this.entities, this.prefix, this.runs)
    const baseSubs: Array<[string, LiveQuery]> = [
      ['narrow', this.base.narrowQ],
      ['resolve', this.base.resolveQ],
      ['verdict', this.base.verdictQ],
      ['verdictR', this.base.verdictR],
      ['agg', this.base.aggQ],
      ['aggR', this.base.aggR],
      ['issuesN', this.base.issuesN],
      ['child', this.base.childQ],
      ['summary', this.base.summaryQ],
      ['visible', this.base.visibleQ],
    ]
    for (const [name, collection] of baseSubs) {
      const sub = collection.subscribeChanges((changes) => {
        this.runs.changes[name] = (this.runs.changes[name] ?? 0) + changes.length
      })
      this.unsubs.push(() => sub.unsubscribe())
    }

    this.rollup = new RollupSync(
      {
        issues: {
          get: (id: string) =>
            this.entities.issues.collection.get(id) as unknown as SliceIssue | undefined,
          keys: () => this.entities.issues.keys(),
        },
        issuesEvents: this.entities.issues.collection,
        resolveQ: this.base.resolveQ,
        childQ: this.base.childQ,
        verdictR: this.base.verdictR,
        verdictQ: this.base.verdictQ,
        summaryQ: this.base.summaryQ,
        prefix: this.prefix,
      },
      () => {
        this.stats.rollupsDerived += 1
      },
      () => {
        this.stats.indexUpdates += 1
      },
      (name, visits) => this.scan(name, visits),
      (ms) => {
        this.phaseMsTotals.rollupMs += ms
      },
    )
    this.rollup.subscribe()
    this.rollup.rebuildAll({
      children: this.base.childQ.toArray as unknown as ChildRow[],
      verdicts: [
        ...(this.base.verdictQ.toArray as unknown as VerdictRow[]),
        ...(this.base.verdictR.toArray as unknown as VerdictRow[]),
      ],
      flatIds: (this.base.visibleQ.toArray as Array<{ id: string }>).map((row) => row.id),
      issues: this.entities.issues.keys(),
    })

    this.top = createTopQueries(this.entities, this.base, this.rollup, this.runs)
    const topSubs: Array<[string, LiveQuery]> = [
      ['order', this.top.orderQ],
      ['lane', this.top.laneQ],
      ['groups', this.top.groupsQ],
      ['rows', this.top.rowsQ],
    ]
    for (const [name, collection] of topSubs) {
      const sub = collection.subscribeChanges((changes) => {
        this.runs.changes[name] = (this.runs.changes[name] ?? 0) + changes.length
        if (name === 'rows') {
          for (const c of changes) this.rowsDirty.add(String(c.key))
        } else if (changes.length > 0) {
          this.orderDirty = true
        }
      })
      this.unsubs.push(() => sub.unsubscribe())
    }
    {
      const sub = this.rollup.collection.subscribeChanges((changes) => {
        this.runs.changes['rollup'] = (this.runs.changes['rollup'] ?? 0) + changes.length
        if (changes.length > 0) this.orderDirty = true
      })
      this.unsubs.push(() => sub.unsubscribe())
    }
  }

  /**
   * Tear down the query graph + rollup + entities, dependent-first (the
   * verified reverse-topology order: cleaning a source while a live query
   * still depends on it poisons the graph). Counter subscriptions and the
   * rollup's query subscriptions are dropped with it. The source
   * subscription, the commit layer (`rows`, `orderCache`, listeners) and
   * locals survive — `replace` reconciles against them.
   */
  private teardownGraph(): void {
    for (const off of this.unsubs.splice(0)) {
      try {
        off()
      } catch {
        // Teardown is best-effort.
      }
    }
    this.rollup.dispose()
    const collections = [
      this.top.rowsQ,
      this.top.groupsQ,
      this.top.laneQ,
      this.top.orderQ,
      this.rollup.collection,
      this.base.visibleQ,
      this.base.summaryQ,
      this.base.aggQ,
      this.base.aggR,
      this.base.verdictQ,
      this.base.verdictR,
      this.base.childQ,
      this.base.resolveQ,
      this.base.narrowQ,
      this.base.issuesN,
      this.entities.locals.collection,
      this.entities.worktrees.collection,
      this.entities.sessions.collection,
      this.entities.issues.collection,
    ]
    for (const collection of collections) {
      try {
        void (collection.cleanup() as Promise<void>).catch(() => {})
      } catch {
        // Cleanup is best-effort; listener state is already cleared.
      }
    }
  }

  // ------------------------------------------------------------ dispatch

  dispatch(event: RowSourceEvent): void {
    if (event.type === 'replace') {
      // Rescope goes through the bootstrap path (see `replace`): the graph
      // is rebuilt over settled state, so there is no incremental
      // propagation to separate from the section wall — the rebuild IS the
      // index work, and the fn/rollup deltas inside it still attribute.
      this.timedWrite(() => {
        this.replace(event)
      })
    } else {
      this.timedWrite(() => {
        this.rollup.batchDuring(() => {
          const { prefixMoved } = applyEventRows(this.entities, event.rows, this.prefix)
          if (prefixMoved) {
            this.bumpWtVersion()
            // Prefix seats moved: displayRef joins (summaryQ) re-run via the
            // version bump; origin ticks re-read the prefix map here.
            this.rollup.notePrefixChanged()
          }
          // Sync deletes apply silently (verified): drive removals explicitly.
          const issueRemovals = this.entities.issues.takeRemoved()
          for (const id of issueRemovals) {
            this.rollup.ingestIssue(id, undefined)
            this.rowsDirty.add(id)
          }
          if (issueRemovals.length > 0) this.orderDirty = true
          for (const sid of this.entities.sessions.takeRemoved()) {
            this.rollup.dropSession(sid)
          }
          this.entities.worktrees.takeRemoved()
        })
      })
    }
    this.finishCycle()
  }

  /**
   * Time one kernel-driven write section (M3 stats split). The section wall
   * contains synchronous query-graph propagation (eager IVM) plus the
   * RollupSync entries it drives; both are timed at their own level
   * (`runs.ms`, the rollup `addMs` callback), so the exclusive index wall is
   * the section wall minus those deltas: sync-write overhead + IVM
   * internals + prefix + version bump + explicit removal driving.
   */
  private timedWrite(section: () => void): void {
    const fnBefore = totalFnMs(this.runs)
    const rollupBefore = this.phaseMsTotals.rollupMs
    const t0 = performance.now()
    section()
    const wall = performance.now() - t0
    const fnDelta = totalFnMs(this.runs) - fnBefore
    const rollupDelta = this.phaseMsTotals.rollupMs - rollupBefore
    this.phaseMsTotals.rollupMs += fnDelta
    this.phaseMsTotals.indexMs += Math.max(0, wall - fnDelta - rollupDelta)
  }

  /**
   * Rescope: tear down the graph and rebuild it over the new corpus (the
   * bootstrap path — one replace event in, full-once install out). Bulk
   * reseeds must NOT flow through the live graph: pushing thousands of
   * inserts through running queries trips the 0.9.2 join canonicalization
   * ("contributors with the same row key are not congruent", M3 finding —
   * transient same-key contributors mid-drain). The fresh graph evaluates
   * its fns once over settled state, exactly like a cold mount. The commit
   * layer is retained, so `reconcileAfterReplace` + `finishCycle` transition
   * rows incrementally (only moved rows re-commit). No version bump: there
   * is nothing stale to re-trigger — resolution computes current at build.
   */
  private replace(event: RowSourceEvent): void {
    const issues: SliceIssue[] = []
    const sessions: SliceSession[] = []
    const worktrees: SliceWorktree[] = []
    for (const row of event.rows) {
      if (row.value === undefined) continue
      if (row.kind === 'issue') issues.push(row.value as SliceIssue)
      else if (row.kind === 'session') {
        sessions.push(row.value as SliceSession)
      } else worktrees.push(row.value as SliceWorktree)
    }
    this.teardownGraph()
    this.buildGraph({ issues, sessions, worktrees, now: this.locals.coarseNow })
    this.reconcileAfterReplace()
    this.orderDirty = true
  }

  private bumpWtVersion(): void {
    const current = this.entities.locals.collection.get('locals') as LocalsRow | undefined
    if (current === undefined) return
    this.entities.locals.write([
      { op: 'upsert', key: 'locals', value: { ...current, wtVersion: current.wtVersion + 1 } },
    ])
  }

  /** Transfer per-issue fn runs into ArmStats, refresh commits, notify once. */
  private finishCycle(): void {
    this.stats.rollupsDerived += this.runs.summary - this.markSummary + (this.runs.rows - this.markRows)
    this.markSummary = this.runs.summary
    this.markRows = this.runs.rows
    const tRows = performance.now()
    this.refreshRows()
    this.phaseMsTotals.rowMs += performance.now() - tRows
    // H4 residual R-T1: the order surface is rebuilt ONLY when an
    // order-affecting collection moved (orderDirty). rowsQ-only changes
    // (title renames, unread flips, band-neutral ticks) cannot move the
    // surface — it is built from orderQ + laneQ alone — so skipping the
    // full re-bucket + whole-order compare is exact, not lossy.
    if (this.orderDirty) {
      const tOrder = performance.now()
      this.rebuildOrder()
      this.phaseMsTotals.rollupMs += performance.now() - tOrder
    }
    this.rowsDirty.clear()
    this.orderDirty = false
    this.stats.notifications += 1
  }

  // ------------------------------------------------------------ commit layer

  /** Baseline (unlatched) closed predicate; the latch overlays selection. */
  closedOf(id: string): boolean {
    const r = this.rollup.collection.get(id) as unknown as RollupRow | undefined
    if (r === undefined) return false
    return inClosedFold({
      issue: r as unknown as Parameters<typeof inClosedFold>[0]['issue'],
      waiting: r.asking,
      selectedIssueId: this.locals.selectedIssueId,
      selectedIssueWasFolded: this.locals.selectedIssueWasFolded ?? false,
      now: this.locals.coarseNow,
    })
  }

  private refreshRows(): void {
    for (const id of this.rowsDirty) {
      this.refreshRow(id)
    }
  }

  private refreshRow(id: string): void {
    const found = this.top.rowsQ.get(id) as RowsRow | undefined
    const prev = this.rows.get(id)
    if (found === undefined) {
      if (prev !== undefined) {
        this.rows.delete(id)
        this.lastTick.delete(id)
        this.graceSensitive.delete(id)
        this.stats.rowsDerived += 1
        this.emit(id)
      }
      return
    }
    const tick = found.tickId === null ? null : {
      id: found.tickId,
      seq: found.tickSeq as number,
      title: found.tickTitle as string,
      ref: found.tickRef as string,
    }
    const next: SliceRow = {
      id: found.id,
      displayRef: found.displayRef,
      title: found.title,
      phase: found.phase,
      progressDone: found.progressDone,
      progressTotal: found.progressTotal,
      working: found.working,
      asking: found.asking,
      band: found.band,
      repoKey: found.repoKey,
      closed: this.closedOf(id),
    }
    const snap = JSON.stringify([next, tick])
    const prevSnap =
      prev === undefined ? null : JSON.stringify([prev, this.lastTick.get(id) ?? null])
    if (prevSnap !== snap) {
      this.rows.set(id, next)
      this.lastTick.set(id, tick)
      this.stats.rowsDerived += 1
      this.emit(id)
    }
    const rollupRow = this.rollup.collection.get(id) as unknown as RollupRow | undefined
    if (
      rollupRow !== undefined &&
      (rollupRow.stage === 'done' || rollupRow.closedReason != null)
    ) {
      this.graceSensitive.add(id)
    } else {
      this.graceSensitive.delete(id)
    }
  }

  /** Drop committed rows the replace left without a rowsQ row (truncate
   *  does not reliably surface per-row deletes through the queries). */
  private reconcileAfterReplace(): void {
    const current = new Set<string>()
    for (const entry of this.top.rowsQ.toArray as RowsRow[]) {
      current.add(entry.id)
      this.rowsDirty.add(entry.id)
    }
    for (const id of [...this.rows.keys()]) {
      if (!current.has(id)) this.rowsDirty.add(id)
    }
  }

  private rebuildRows(ids: string[]): void {
    for (const id of ids) this.rowsDirty.add(id)
    this.refreshRows()
    this.rowsDirty.clear()
  }

  private rebuildOrder(): void {
    const pinnedIds: string[] = []
    const buckets = new Map<string, { label: string; open: string[]; closed: string[] }>()
    const orderEntries = this.top.orderQ.toArray as Array<{ id: string }>
    // H4 residual R-T1: the full order array is re-bucketed (plus a
    // whole-order compare) on every call — counted here, gated in M2.
    this.scan('order-rebuild', orderEntries.length)
    for (const entry of orderEntries) {
      const id = entry.id
      const lane = this.top.laneQ.get(id) as LaneRow | undefined
      if (lane === undefined) continue
      // Selection latch: the clicked settled row stays in its clicked lane.
      let placed = lane.lane
      if (id === this.locals.selectedIssueId && placed !== 'pinned') {
        placed = (this.locals.selectedIssueWasFolded ?? false) ? 'closed' : 'open'
      }
      if (placed === 'pinned') {
        pinnedIds.push(id)
        continue
      }
      let bucket = buckets.get(lane.groupKey)
      if (bucket === undefined) {
        bucket = { label: lane.label, open: [], closed: [] }
        buckets.set(lane.groupKey, bucket)
      }
      if (placed === 'closed') bucket.closed.push(id)
      else bucket.open.push(id)
    }
    const rollupGet = (id: string): number => {
      const lane = this.top.laneQ.get(id) as LaneRow | undefined
      return lane?.foldAt ?? 0
    }
    for (const bucket of buckets.values()) {
      bucket.closed.sort((a, b) => rollupGet(b) - rollupGet(a))
    }
    const prev = this.orderCache
    const next: SliceOrder = {
      pinnedIds,
      groups: [...buckets].map(([key, bucket]) => ({
        key,
        label: bucket.label,
        rowIds: bucket.open,
        closedIds: bucket.closed,
      })),
    }
    const prevJson = prev === null ? null : JSON.stringify(prev)
    if (prevJson !== JSON.stringify(next)) {
      const prevGroups = new Map((prev?.groups ?? []).map((g) => [g.key, g]))
      this.orderCache = next
      this.emit('order')
      const nextKeys = new Set(next.groups.map((g) => g.key))
      for (const group of next.groups) {
        const old = prevGroups.get(group.key)
        if (
          old === undefined ||
          old.label !== group.label ||
          !sameIds(old.rowIds, group.rowIds) ||
          !sameIds(old.closedIds, group.closedIds)
        ) {
          this.emit(`group:${group.key}`)
        }
      }
      for (const old of prev?.groups ?? []) {
        if (!nextKeys.has(old.key)) this.emit(`group:${old.key}`)
      }
    }
  }

  // ------------------------------------------------------------ locals

  /** Selection is a local (R-SEL): latch + key notifies, zero data. */
  setSelection(id: string, wasFolded?: boolean): void {
    const previous = this.locals.selectedIssueId
    if (previous === id) return
    const lane = this.top.laneQ.get(id) as LaneRow | undefined
    const folded = wasFolded ?? lane?.lane === 'closed'
    this.locals.selectedIssueId = id
    this.locals.selectedIssueWasFolded = folded
    if (previous !== null) {
      this.rowsDirty.add(previous)
      this.emit(`selected:${previous}`)
    }
    this.rowsDirty.add(id)
    this.emit(`selected:${id}`)
    const tRows = performance.now()
    this.refreshRows()
    this.phaseMsTotals.rowMs += performance.now() - tRows
    this.rowsDirty.clear()
    const tOrder = performance.now()
    this.rebuildOrder()
    this.phaseMsTotals.rollupMs += performance.now() - tOrder
    this.stats.notifications += 1
  }

  /** Coarse-tick: time is data via the locals row; bands/decay/grace follow. */
  setCoarseNow(now: number): void {
    if (this.locals.coarseNow === now) return
    this.locals.coarseNow = now
    const current = this.entities.locals.collection.get('locals') as LocalsRow | undefined
    if (current !== undefined) {
      this.timedWrite(() => {
        this.rollup.batchDuring(() => {
          this.entities.locals.write([{ op: 'upsert', key: 'locals', value: { ...current, now } }])
        })
      })
    }
    for (const id of this.graceSensitive) this.rowsDirty.add(id)
    this.finishCycle()
  }

  // ------------------------------------------------------------ read

  get(key: string): unknown {
    if (key === 'order') return this.orderCache
    if (key.startsWith('group:')) {
      return this.orderCache?.groups.find((g) => g.key === key.slice('group:'.length)) ?? null
    }
    if (key.startsWith('selected:')) {
      return this.locals.selectedIssueId === key.slice('selected:'.length)
    }
    return this.rows.get(key) ?? null
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      const live = this.listeners.get(key)
      if (live !== undefined) {
        live.delete(listener)
        if (live.size === 0) this.listeners.delete(key)
      }
    }
  }

  private emit(key: string): void {
    const set = this.listeners.get(key)
    if (set === undefined) return
    for (const listener of [...set]) listener()
  }

  /** Record a multi-row walk (H4 slope material); cleared by `stats.reset()`. */
  scan(name: string, visits: number): void {
    this.scanTotals.set(name, (this.scanTotals.get(name) ?? 0) + visits)
  }

  /** Cumulative scan visits since the last `stats.reset()` (M2 slope record). */
  scanCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, visits] of this.scanTotals) out[name] = visits
    return out
  }

  /**
   * Cumulative computation-share walls since the last `stats.reset()` (M3
   * stats split, methodology §6.4). Happy-dom proxy only.
   */
  phaseMs(): { indexMs: number; rollupMs: number; rowMs: number } {
    return { ...this.phaseMsTotals }
  }

  /** Test hook: outstanding subscription count (dispose leaves zero). */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  snapshot(): SliceSnapshot {
    const order = (this.get('order') as SliceOrder) ?? { pinnedIds: [], groups: [] }
    const rowsById: Record<string, SliceRow> = {}
    for (const id of this.rows.keys()) {
      const row = this.rows.get(id)
      if (row !== undefined) rowsById[id] = row
    }
    return { order, rowsById }
  }

  mountWeb(el: Element): () => void {
    this.webRoot?.unmount()
    const root = createRoot(el)
    this.webRoot = root
    const log = currentCommitLog()
    root.render(
      createElement(
        CommitLogContext.Provider,
        { value: log },
        createElement(TanStackList, { store: this }),
      ),
    )
    return () => {
      root.unmount()
      if (this.webRoot === root) this.webRoot = null
    }
  }

  dispose(): void {
    this.off?.()
    this.off = null
    this.webRoot?.unmount()
    this.webRoot = null
    this.teardownGraph()
    this.listeners.clear()
  }

  /** Test hook: the live store. */
  handle(): ArmHandle {
    const store = this
    return {
      snapshot: () => store.snapshot(),
      stats: store.stats,
      dispose: () => store.dispose(),
      mountWeb: (el: Element) => store.mountWeb(el),
      mountNative: (): ReactElement => {
        throw new Error('[tanstack] mountNative is async — preloadTanStackNative() first')
      },
    }
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Total query-fn wall accumulated in `runs.ms` (M3 stats split input). */
function totalFnMs(runs: GraphRuns): number {
  let total = 0
  for (const ms of Object.values(runs.ms)) total += ms
  return total
}
