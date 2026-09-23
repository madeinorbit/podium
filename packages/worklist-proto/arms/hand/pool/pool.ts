/**
 * POD-4578 (Ha1) — the hand-rolled pool: one per principal. Entity tables
 * from the declared schema (`tables.ts`), derived values as cells that record
 * what they read (`cells.ts`), row views from one rule table (`views.ts`),
 * typed records from the schema (`records.ts`), and the locals as tracked
 * keys (the selection by issue id, the clock by deadline, `clock.ts`).
 *
 * WRITE PATH: one change, one pass. `apply(event)` ingests the whole feed
 * event into the tables (`ingestRecord`, or `reseed` for a `replace`), which
 * reports one {@link Delta} per slot written; `applyLocals` makes one per
 * local the pool uses. `commit` then runs the handlers in order, each with a
 * never-check over the closed delta union: dirty the readers of each delta's
 * key (`invalidate`), dispose what removed rows held (`release`), drain the
 * dirty cells once (`CellGraph.flush`), and call each changed key's
 * listeners once (`publish`). No handler knows which derived value reads
 * what: the cells recorded that themselves.
 *
 * READ PATH. Every table read goes through the reads fence
 * (`reads.wrapTables`) behind a tracked door (`tracked`), every relation read
 * through `reads.wrapRelations`; with the fence disabled both are the raw
 * objects. A row view is a cell per part, created when a mounted row (or
 * `snapshot()`) first reads it and kept current by the drain after that.
 *
 * STATS (`README.md` has the definitions): `rowsDerived` counts view-cell
 * runs; `notifications` counts commits that changed pool state;
 * `rollupsDerived` and `indexUpdates` stay 0 until the worklist phase and
 * Ha2 add roll-ups and relation buckets. The pool's own counters are in
 * `stats.counters`.
 */

import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import { type RowView, sliceRowOf } from '../../../shared/src/row-view'
import type { EntityName } from '../../../shared/src/schema'
import type {
  LocalsKey,
  SliceIssue,
  SliceLocals,
  SliceSession,
  SliceSnapshot,
} from '../../../shared/src/slice-types'
import type { ArmStats, RowSourceEvent } from '../../../shared/src/stats'
import { type Cell, type CellCounters, CellGraph, DepIndex, sameData } from './cells'
import { DeadlineClock } from './clock'
import { issueIdsOf, reseed } from './enumerate'
import { type EntityRecord, RECORD_CLASSES, type RecordOf } from './records'
import { PoolRelations } from './relations'
import {
  createTables,
  ENTITIES,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  type ReadableTable,
  type RowDelta,
  type StoredRow,
  type TableSet,
  type Tables,
  tablesOf,
} from './tables'
import {
  buildRowView,
  type IssueParts,
  PART_NAMES,
  PART_RULES,
  type PartName,
  type RepoRow,
  type ViewInputs,
} from './views'

/**
 * Everything that can change under the pool, as one closed union. Every
 * handler switches over it with a never-check, so a new kind fails typecheck
 * in each until it is handled.
 */
export type Delta =
  | ({ readonly kind: 'row' } & RowDelta)
  | { readonly kind: 'selection'; readonly to: string | null }
  | { readonly kind: 'clock'; readonly to: number }

function unhandled(delta: never): never {
  throw new Error(`[pool] unhandled delta ${JSON.stringify(delta)}`)
}

/** The pool's own counters, beside the shared `ArmStats` (`README.md`, "Stats"). */
export interface PoolCounters extends CellCounters {
  /** Table slots written (set to a different object, or deleted). */
  tableWrites: number
  /** Rows that left the pool, each with its cells and record disposed. */
  rowsRemoved: number
  /** Records built (first accesses). */
  recordsCreated: number
  /** Listener calls made by `publish` (one per listener per changed key). */
  listenerCalls: number
}

export type PoolStats = ArmStats & { readonly counters: PoolCounters }

function createStats(graph: CellGraph): PoolStats {
  const counters = Object.assign(graph.counters, {
    tableWrites: 0,
    rowsRemoved: 0,
    recordsCreated: 0,
    listenerCalls: 0,
  }) as PoolCounters
  const stats: PoolStats = {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    counters,
    reset(): void {
      stats.rowsDerived = 0
      stats.rollupsDerived = 0
      stats.indexUpdates = 0
      stats.notifications = 0
      for (const key of Object.keys(counters) as (keyof PoolCounters)[]) counters[key] = 0
    },
  }
  return stats
}

/** The worklist's order until Hb1 builds the visible collection. */
const EMPTY_ORDER: SliceSnapshot['order'] = Object.freeze({
  pinnedIds: [],
  groups: [],
}) as unknown as SliceSnapshot['order']

/** One issue's parts, each its own cell, plus the view cell over them. */
export class IssueCells {
  readonly cells = new Map<PartName | 'view', Cell<unknown>>()

  constructor(
    readonly id: string,
    private readonly pool: HandPool,
  ) {}

  /** The L1b row view; undefined once the row has left. */
  get view(): RowView | undefined {
    let cell = this.cells.get('view') as Cell<RowView | undefined> | undefined
    if (cell === undefined) {
      const { pool, id } = this
      cell = pool.graph.cell(
        `view:${id}`,
        () => {
          pool.stats.rowsDerived += 1
          return buildRowView(pool.inputs, id, this as unknown as IssueParts)
        },
        sameData,
        () => pool.changed(id),
      )
      this.cells.set('view', cell as Cell<unknown>)
    }
    return this.pool.graph.read(cell)
  }

  part<K extends PartName>(name: K): IssueParts[K] {
    let cell = this.cells.get(name) as Cell<IssueParts[K]> | undefined
    if (cell === undefined) {
      const { pool, id } = this
      const rule = PART_RULES[name]
      cell = pool.graph.cell(
        `${name}:${id}`,
        () => rule(pool.inputs, id, this as unknown as IssueParts),
        sameData,
      )
      this.cells.set(name, cell as Cell<unknown>)
    }
    return this.pool.graph.read(cell)
  }

  dispose(): void {
    for (const cell of this.cells.values()) this.pool.graph.dispose(cell)
    this.cells.clear()
  }
}

for (const name of PART_NAMES) {
  Object.defineProperty(IssueCells.prototype, name, {
    get(this: IssueCells) {
      return this.part(name)
    },
  })
}

export class HandPool {
  /** The raw tables (writes only). */
  readonly tables: Tables
  /** The same tables through the reads fence. */
  readonly fenced: TableSet<ReadonlyMap<string, StoredRow>>
  readonly graph: CellGraph
  /** Per entity: the cells that read each row slot. */
  readonly rowReaders: TableSet<DepIndex<string>>
  /** The cells that read a table's membership (its id list). */
  readonly membership: DepIndex<EntityName>
  /** The cells that asked whether an issue is the selected one. */
  readonly selection: DepIndex<string>
  readonly clock: DeadlineClock
  /** The fenced tables behind tracked doors: every read records the running cell. */
  readonly tracked: TableSet<ReadableTable>
  readonly relations: RelationReader
  readonly inputs: ViewInputs
  readonly stats: PoolStats
  /** Per issue: its cells, created on first read, disposed with the row. */
  readonly issues = new Map<string, IssueCells & IssueParts>()
  /** Per entity: records built on first access, dropped with the row. */
  readonly records: TableSet<Map<string, EntityRecord>>
  /** Per issue id: the listeners of its row view. */
  readonly listeners = new Map<string, Set<() => void>>()
  /** Listeners of the id list. */
  readonly idsListeners = new Set<() => void>()
  private readonly idsCell: Cell<readonly string[]>
  private readonly target: IngestTarget
  private selectedId: string | null
  /** Keys whose value changed in this commit; published once at its end. */
  private readonly changedIds = new Set<string>()
  private idsChanged = false

  constructor(
    readonly reads: ReadFence,
    locals: SliceLocals,
  ) {
    const graph = new CellGraph()
    this.graph = graph
    this.tables = createTables()
    this.fenced = reads.wrapTables(this.tables)
    this.rowReaders = tablesOf((entity) => new DepIndex<string>(`rows.${entity}`))
    this.membership = new DepIndex<EntityName>('membership')
    this.selection = new DepIndex<string>('selection')
    this.clock = new DeadlineClock(graph, locals.coarseNow)
    this.selectedId = locals.selectedIssueId
    const { fenced, rowReaders } = this
    this.tracked = tablesOf((entity) => ({
      get(id: string): unknown {
        graph.track(rowReaders[entity], id)
        return fenced[entity].get(id)
      },
      has(id: string): boolean {
        graph.track(rowReaders[entity], id)
        return fenced[entity].has(id)
      },
    }))
    const tracked = this.tracked
    this.relations = reads.wrapRelations(new PoolRelations(tracked))
    this.inputs = {
      relations: this.relations,
      issue: (id) => tracked.issue.get(id) as SliceIssue | undefined,
      session: (id) => tracked.session.get(id) as SliceSession | undefined,
      repo: (id) => tracked.repo.get(id) as RepoRow | undefined,
      present: (entity, id) => tracked[entity].has(id),
      parts: (id) => (tracked.issue.has(id) ? this.cellsOf(id) : undefined),
      selected: (id) => {
        graph.track(this.selection, id)
        return this.selectedId === id
      },
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    this.stats = createStats(graph)
    this.records = tablesOf(() => new Map<string, EntityRecord>())
    this.target = { read: this.fenced, write: this.tables }
    this.idsCell = graph.cell(
      'ids:issue',
      () => {
        graph.track(this.membership, 'issue')
        return issueIdsOf(fenced.issue)
      },
      sameData,
      () => {
        this.idsChanged = true
      },
    )
  }

  // ---------------------------------------------------------------- reads

  /** Every issue id in the pool, in table order; a new array only when membership changed. */
  readonly issueIds = (): readonly string[] => this.graph.read(this.idsCell)

  /** The row view of issue `id`, derived on first read; undefined when absent. */
  readonly view = (id: string): RowView | undefined =>
    this.fenced.issue.has(id) ? this.cellsOf(id).view : undefined

  /** Listen to one row view; returns the unsubscribe. */
  readonly subscribe = (id: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(id)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(id)
      if (current === undefined || !current.delete(listener) || current.size > 0) return
      this.listeners.delete(id)
    }
  }

  /** Listen to the id list; returns the unsubscribe. */
  readonly subscribeIds = (listener: () => void): (() => void) => {
    this.idsListeners.add(listener)
    return () => {
      this.idsListeners.delete(listener)
    }
  }

  /** The cells of issue `id`, created on first use. */
  cellsOf(id: string): IssueCells & IssueParts {
    let cells = this.issues.get(id)
    if (cells === undefined) {
      cells = new IssueCells(id, this) as IssueCells & IssueParts
      this.issues.set(id, cells)
    }
    return cells
  }

  /** The schema record of a row in the pool, built on first access; undefined when absent. */
  record<E extends EntityName>(entity: E, id: string): RecordOf[E] | undefined {
    if (!this.tracked[entity].has(id)) return undefined
    const records = this.records[entity]
    let record = records.get(id)
    if (record === undefined) {
      record = new RECORD_CLASSES[entity](entity, id, this.tracked)
      records.set(id, record)
      this.stats.counters.recordsCreated += 1
    }
    return record as RecordOf[E]
  }

  /** The a1 slice output: every pool issue's row, no order yet (Hb1). */
  snapshot(): SliceSnapshot {
    const rowsById: SliceSnapshot['rowsById'] = {}
    for (const id of this.issueIds()) {
      const view = this.view(id)
      if (view !== undefined) rowsById[id] = sliceRowOf(view)
    }
    return { order: EMPTY_ORDER, rowsById }
  }

  // --------------------------------------------------------------- writes

  /** One feed publication: ingest all of it, then one commit. */
  apply(event: RowSourceEvent): void {
    const out = ingestOut()
    if (event.type === 'replace') reseed(this.target, event.rows, out)
    else for (const record of event.rows) ingestRecord(this.target, record, out)
    this.stats.counters.tableWrites += out.deltas.length
    this.commit(out.deltas.map((delta) => ({ kind: 'row', ...delta })))
  }

  /** One locals notification: only the keys it names that the pool uses. */
  applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    const deltas: Delta[] = []
    if (changed.has('selectedIssueId') && locals.selectedIssueId !== this.selectedId) {
      deltas.push({ kind: 'selection', to: locals.selectedIssueId })
    }
    if (changed.has('coarseNow')) deltas.push({ kind: 'clock', to: locals.coarseNow })
    this.commit(deltas)
  }

  /** Called by a view cell whose value changed. */
  changed(id: string): void {
    this.changedIds.add(id)
  }

  /** Empty every table, cell, index, record and listener. */
  dispose(): void {
    for (const cells of this.issues.values()) cells.dispose()
    this.issues.clear()
    this.graph.dispose(this.idsCell)
    for (const entity of ENTITIES) {
      this.tables[entity].clear()
      this.records[entity].clear()
      this.rowReaders[entity].clear()
    }
    this.membership.clear()
    this.selection.clear()
    this.clock.clear()
    this.graph.clear()
    this.listeners.clear()
    this.idsListeners.clear()
    this.changedIds.clear()
    this.selectedId = null
  }

  // ------------------------------------------------------------- handlers

  private commit(deltas: readonly Delta[]): void {
    if (deltas.length === 0) return
    for (const delta of deltas) this.invalidate(delta)
    for (const delta of deltas) this.release(delta)
    this.graph.flush()
    this.publish()
    this.stats.notifications += 1
  }

  /** Handler 1: dirty the readers of the delta's key (and move the local it names). */
  private invalidate(delta: Delta): void {
    switch (delta.kind) {
      case 'row':
        this.graph.invalidateKey(this.rowReaders[delta.entity], delta.id)
        if (delta.membership) this.graph.invalidateKey(this.membership, delta.entity)
        return
      case 'selection': {
        const from = this.selectedId
        this.selectedId = delta.to
        if (from !== null) this.graph.invalidateKey(this.selection, from)
        if (delta.to !== null) this.graph.invalidateKey(this.selection, delta.to)
        return
      }
      case 'clock':
        this.clock.move(delta.to)
        return
      default:
        unhandled(delta)
    }
  }

  /**
   * Handler 2: an issue that entered or left the pool is news to its row's
   * listeners — no cell of it may exist to say so (a row evicted and re-added
   * lost its cells on the way out) — and a row that left gives up its cells
   * and record.
   */
  private release(delta: Delta): void {
    switch (delta.kind) {
      case 'row': {
        if (!delta.membership) return
        if (delta.entity === 'issue') this.changedIds.add(delta.id)
        if (this.tables[delta.entity].has(delta.id)) return
        this.stats.counters.rowsRemoved += 1
        this.records[delta.entity].delete(delta.id)
        if (delta.entity !== 'issue') return
        const cells = this.issues.get(delta.id)
        if (cells !== undefined) {
          cells.dispose()
          this.issues.delete(delta.id)
        }
        return
      }
      case 'selection':
      case 'clock':
        return
      default:
        unhandled(delta)
    }
  }

  /** Handler 4 (after the drain): each changed key's listeners, once. */
  private publish(): void {
    const ids = this.idsChanged
    this.idsChanged = false
    const changed = [...this.changedIds]
    this.changedIds.clear()
    if (ids) {
      for (const listener of [...this.idsListeners]) {
        this.stats.counters.listenerCalls += 1
        listener()
      }
    }
    for (const id of changed) {
      const set = this.listeners.get(id)
      if (set === undefined) continue
      for (const listener of [...set]) {
        this.stats.counters.listenerCalls += 1
        listener()
      }
    }
  }
}
