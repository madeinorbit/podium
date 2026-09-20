/**
 * POD-4446 — the hand-rolled store: one RowSourceEvent, one delta batch, one
 * notification pass (methodology §5.2).
 *
 * Dispatch runs the dataflow levels in topology order, each module seeing the
 * batch accumulated so far: tables -> indexes -> summaries -> visible ->
 * rollup -> order/groups -> rows. Every level is an exhaustive switch over
 * the closed delta union; a kind no module handles is a compile error.
 * Subscriptions are per key — row id, `group:<key>`, `order`,
 * `selected:<id>` — with de-duplicated notifies per pass. Selection and the
 * coarse clock are locals: they arrive as synthetic single-delta batches,
 * never as row fields.
 */

import type { ArmHandle, RowSource } from '../../shared/src/arm'
import { CommitLogContext, currentCommitLog } from '../../shared/src/row-shell'
import type { SliceLocals, SliceOrder, SliceSnapshot } from '../../shared/src/slice-types'
import type { ArmStats, RowRecord, RowSourceEvent } from '../../shared/src/stats'
import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { type Delta, type DerivationStats } from './deltas'
import { GroupsModule } from './groups'
import { IndexSet } from './indexes'
import { OrderModule } from './order'
import { HandList } from './react/list'
import { RollupModule } from './rollup'
import { RowsModule } from './rows'
import { SummaryModule } from './summary'
import { IssueTable, SessionTable, WorktreeTable } from './tables'
import { VisibleModule } from './visible'

type Listener = () => void

export class HandStore {
  readonly issues = new IssueTable()
  readonly sessions = new SessionTable()
  readonly worktrees = new WorktreeTable()
  readonly indexes: IndexSet
  readonly summary: SummaryModule
  readonly visible: VisibleModule
  readonly rollup: RollupModule
  readonly order: OrderModule
  readonly groups: GroupsModule
  readonly rows: RowsModule

  readonly stats: ArmStats
  readonly locals: SliceLocals
  private readonly listeners = new Map<string, Set<Listener>>()
  private off: (() => void) | null = null
  private orderCache: SliceOrder | null = null
  private webRoot: { unmount(): void } | null = null

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
      },
    }
    this.stats = stats
    const sink: DerivationStats = {
      summaries: () => {
        stats.rollupsDerived += 1
      },
      aggregates: () => {
        stats.rollupsDerived += 1
      },
      visibility: () => {
        stats.rollupsDerived += 1
      },
      index: () => {
        stats.indexUpdates += 1
      },
      rows: (n: number) => {
        stats.rowsDerived += n
      },
    }
    const tables = { issues: this.issues, sessions: this.sessions, worktrees: this.worktrees }
    this.indexes = new IndexSet(tables)
    this.indexes.stats = sink
    const getNow = (): number => this.locals.coarseNow
    const getSelection = () => ({
      selectedIssueId: this.locals.selectedIssueId,
      selectedIssueWasFolded: this.locals.selectedIssueWasFolded ?? false,
    })
    this.summary = new SummaryModule(tables, this.indexes, getNow, sink)
    this.visible = new VisibleModule(tables, this.indexes, this.summary, getNow, sink)
    this.rollup = new RollupModule(tables, this.indexes, this.summary, this.visible, getNow, sink)
    this.order = new OrderModule(tables, this.indexes, this.summary, this.visible, getNow, sink)
    this.groups = new GroupsModule(
      tables,
      this.summary,
      this.rollup,
      this.order,
      getSelection,
      getNow,
      sink,
    )
    this.rows = new RowsModule(this.summary, this.rollup, this.groups, this.visible, sink)
    this.off = source.subscribe((event) => this.dispatch(event))
    // Bootstrap from the source snapshot (cold path is silent — arms
    // snapshot, per the G3 finding — so construction itself emits nothing).
    this.bootstrap()
    stats.reset()
  }

  // ------------------------------------------------------------ dispatch

  private tableApply(record: RowRecord): Delta | null {
    switch (record.kind) {
      case 'issue':
        return this.issues.apply(record)
      case 'session':
        return this.sessions.apply(record)
      case 'worktree':
        return this.worktrees.apply(record)
    }
  }

  private bootstrap(): void {
    for (const record of this.source.snapshot('issue')) this.issues.apply(record)
    for (const record of this.source.snapshot('session')) this.sessions.apply(record)
    for (const record of this.source.snapshot('worktree')) this.worktrees.apply(record)
    this.indexes.rebuildAll(
      this.issues.rows.entries(),
      this.sessions.rows.entries(),
      this.worktrees.rows.keys(),
      (path) => {
        const lane = this.worktrees.rows.get(path)
        return { repoId: lane?.repoId, prefix: lane?.prefix }
      },
    )
    this.summary.rebuildAll()
    this.visible.rebuildAll()
    this.rollup.rebuildAll()
    this.order.rebuildAll()
    this.groups.rebuildAll()
    this.rows.rebuildAll()
    this.orderCache = null
  }

  /** Replace: atomic reseed in one action, one notification pass. */
  private replace(event: RowSourceEvent): void {
    this.issues.clear()
    this.sessions.clear()
    this.worktrees.clear()
    for (const record of event.rows) this.tableApply(record)
    this.indexes.rebuildAll(
      this.issues.rows.entries(),
      this.sessions.rows.entries(),
      this.worktrees.rows.keys(),
      (path) => {
        const lane = this.worktrees.rows.get(path)
        return { repoId: lane?.repoId, prefix: lane?.prefix }
      },
    )
    this.summary.rebuildAll()
    this.visible.rebuildAll()
    this.rollup.rebuildAll()
    this.order.rebuildAll()
    this.groups.rebuildAll()
    this.rows.rebuildAll()
    this.stats.rows(this.rows.rows.size)
    this.orderCache = null
    // Full install: every key may have moved.
    for (const id of this.rows.rows.keys()) this.emit(id)
    for (const group of this.groups.groups) this.emit(`group:${group.key}`)
    this.emit('order')
  }

  dispatch(event: RowSourceEvent): void {
    if (event.type === 'replace') {
      this.replace(event)
      this.stats.notifications += 1
      return
    }
    const batch: Delta[] = []
    for (const record of event.rows) {
      const delta = this.tableApply(record)
      if (delta !== null) batch.push(delta)
    }
    if (batch.length === 0) {
      this.stats.notifications += 1
      return
    }
    const indexOut: Delta[] = []
    for (const delta of batch) indexOut.push(...this.indexes.apply(delta))
    batch.push(...indexOut)
    batch.push(...this.summary.apply(batch))
    batch.push(...this.visible.apply(batch))
    batch.push(...this.rollup.apply(batch))
    batch.push(...this.order.apply(batch))
    batch.push(...this.groups.apply(batch))
    batch.push(...this.rows.apply(batch))
    this.orderCache = null
    // One notification pass, de-duplicated keys.
    const keys = new Set<string>()
    for (const delta of batch) {
      switch (delta.kind) {
        case 'RowChanged':
          keys.add(delta.id)
          break
        case 'GroupChanged':
          keys.add(delta.key === '' ? 'order' : `group:${delta.key}`)
          keys.add('order')
          break
        case 'OrderChanged':
          keys.add('order')
          break
        case 'SelectionChanged':
          if (delta.previous !== null) keys.add(`selected:${delta.previous}`)
          if (delta.current !== null) keys.add(`selected:${delta.current}`)
          break
        case 'IssueChanged':
        case 'IssueRemoved':
        case 'SessionChanged':
        case 'SessionRemoved':
        case 'WorktreeChanged':
        case 'WorktreeRemoved':
        case 'MembershipChanged':
        case 'ChildrenChanged':
        case 'OriginChanged':
        case 'SummaryChanged':
        case 'RollupChanged':
        case 'VisibilityChanged':
        case 'ClockChanged':
          break
      }
    }
    for (const key of keys) this.emit(key)
    this.stats.notifications += 1
  }

  // ------------------------------------------------------------ locals

  /** Selection is a local (R-SEL): latch + two key notifies, zero data. */
  setSelection(id: string, wasFolded?: boolean): void {
    const previous = this.locals.selectedIssueId
    if (previous === id) return
    const folded = wasFolded ?? this.groups.placement.get(id)?.lane === 'closed' ?? false
    this.locals.selectedIssueId = id
    this.locals.selectedIssueWasFolded = folded
    this.applyLocals([{ kind: 'SelectionChanged', previous, current: id }])
  }

  /** Coarse-tick batch: time-sensitive rows re-derive from the new now. */
  setCoarseNow(now: number): void {
    if (this.locals.coarseNow === now) return
    this.locals.coarseNow = now
    this.applyLocals([{ kind: 'ClockChanged', now }])
  }

  private applyLocals(deltas: Delta[]): void {
    const batch: Delta[] = [...deltas]
    batch.push(...this.summary.apply(batch))
    batch.push(...this.visible.apply(batch))
    batch.push(...this.rollup.apply(batch))
    batch.push(...this.order.apply(batch))
    batch.push(...this.groups.apply(batch))
    batch.push(...this.rows.apply(batch))
    this.orderCache = null
    const keys = new Set<string>()
    for (const delta of batch) {
      if (delta.kind === 'RowChanged') keys.add(delta.id)
      else if (delta.kind === 'GroupChanged') {
        keys.add(delta.key === '' ? 'order' : `group:${delta.key}`)
        keys.add('order')
      } else if (delta.kind === 'OrderChanged') keys.add('order')
      else if (delta.kind === 'SelectionChanged') {
        if (delta.previous !== null) keys.add(`selected:${delta.previous}`)
        if (delta.current !== null) keys.add(`selected:${delta.current}`)
      }
    }
    for (const key of keys) this.emit(key)
    this.stats.notifications += 1
  }

  // ------------------------------------------------------------ read

  /** Per-key snapshot: stored objects by identity (never rebuilt). */
  get(key: string): unknown {
    if (key === 'order') {
      if (this.orderCache === null) {
        this.orderCache = {
          pinnedIds: [...this.groups.pinnedIds],
          groups: this.groups.groups.map((g) => ({
            key: g.key,
            label: g.label,
            rowIds: [...g.rowIds],
            closedIds: [...g.closedIds],
          })),
        }
      }
      return this.orderCache
    }
    if (key.startsWith('group:')) {
      return this.groups.groups.find((g) => g.key === key.slice('group:'.length)) ?? null
    }
    if (key.startsWith('selected:')) {
      return this.locals.selectedIssueId === key.slice('selected:'.length)
    }
    return this.rows.rows.get(key) ?? null
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

  /** Test hook: outstanding subscription count (dispose leaves zero). */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  snapshot(): SliceSnapshot {
    const order = this.get('order') as SliceOrder
    const rowsById: Record<string, SliceRow> = {}
    for (const id of this.order.ordered) {
      const row = this.rows.rows.get(id)
      if (row !== undefined) rowsById[id] = row
    }
    return { order, rowsById }
  }

  mountWeb(el: Element): () => void {
    this.webRoot?.unmount()
    const root = createRoot(el)
    this.webRoot = root
    // Propagate the harness log across this root (Arm contract).
    const log = currentCommitLog()
    root.render(
      createElement(
        CommitLogContext.Provider,
        { value: log },
        createElement(HandList, { store: this }),
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
    this.listeners.clear()
  }
}

  /** Test hook: the live store (native host + unit tests read through it). */
  handle(): ArmHandle {
    const store = this
    return {
      snapshot: () => store.snapshot(),
      stats: store.stats,
      dispose: () => store.dispose(),
      mountWeb: (el: Element) => store.mountWeb(el),
      mountNative: (): ReactElement => {
        throw new Error(
          '[hand] mountNative is async — call preloadHandNative() from ./arm first ' +
            '(react-native loads dynamically, the POD-1220 hazard)',
        )
      },
    }
  }
}
