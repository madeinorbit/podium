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
 * RELATIONS (POD-4579, Ha2). Ingest hands every table write to the relation
 * engine (`relations.ts`), which maintains every declared relation from the
 * schema and records each relation slot it wrote; the pool turns those into
 * `relation` deltas, which dirty exactly the cells that read the slot. A
 * cell reading a relation reads it through `relations` (the fence's wrapper
 * over the engine), which records the slot, and `one()`'s presence check is
 * tracked on the target's PRESENCE (`presence`), not its row: a repo's
 * rename does not re-run the issues that point at it, only the parts that
 * read its row.
 *
 * RESIDENCY (POD-4580, Ha3; `residency.ts`). With a per-row read (`lazy.load`,
 * the feed's `RowSource.row`), rows the schema lets be cold (closed issues and
 * their sessions) never enter the tables: ingest registers their ids and the
 * relation engine links them. A cell that reaches one through a lazy relation
 * asks `inputs.loading`, which records it under the row's `coldness` key and
 * queues the row; the 50 ms window's batch installs every queued row in ONE
 * commit (`hydrate`). A registry entry that appears or leaves is a
 * `residency` delta, handled like every other. `snapshot()` settles the
 * loader before it answers. Without `lazy` every row is resident (the Ha1/Ha2
 * tests that build the pool directly).
 *
 * READ PATH. Every table read goes through the reads fence
 * (`reads.wrapTables`) behind a tracked door (`tracked`), every relation read
 * through `reads.wrapRelations`; with the fence disabled both are the raw
 * objects. A row view is a cell per part, created when a mounted row (or
 * `snapshot()`) first reads it and kept current by the drain after that.
 *
 * STATS (`README.md` has the definitions): `rowsDerived` counts view-cell
 * runs; `notifications` counts commits that changed pool state;
 * `indexUpdates` counts relation ELEMENTS the engine touched (a bucket
 * member, a forward entry, a prefix-index entry, a collapse entry), never
 * slots, so a bucket-sized walk cannot hide behind one count;
 * `rollupsDerived` stays 0 until the worklist phase. The pool's own counters
 * are in `stats.counters`.
 */

import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import { type RowView, sliceRowOf } from '../../../shared/src/row-view'
import { type EntityName, type ModelSchema, SCHEMA } from '../../../shared/src/schema'
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
import { type LoadRow, Residency, type Schedule } from './residency'
import {
  createTables,
  ENTITIES,
  type IngestOut,
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
  /** A relation slot the engine wrote: `relation` is `${entity}.${name}`, keyed by `id`. */
  | { readonly kind: 'relation'; readonly relation: string; readonly id: string }
  /** A cold row entered or left the registry (POD-4580): its `coldness` readers re-run. */
  | { readonly kind: 'residency'; readonly entity: EntityName; readonly id: string }
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

function createStats(graph: CellGraph, residency: () => Residency | null): PoolStats {
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
      const cold = residency()?.counters
      if (cold !== undefined) for (const key of Object.keys(cold) as (keyof typeof cold)[]) cold[key] = 0
    },
  }
  return stats
}

/** Residency options: the per-row read, and (tests) the window and timer. */
export interface PoolLazyOptions {
  readonly load: LoadRow
  readonly windowMs?: number
  readonly schedule?: Schedule
}

/** Where a row stands (`HandPool.resident`). */
export type Residence = 'resident' | 'loading' | 'absent'

/** A lazy collection: its resident members, and how many are still loading. */
export interface LazyMembers {
  readonly ready: readonly string[]
  readonly pending: number
}

/** Load rounds `snapshot()` settles before it gives up (a load that queues another, and so on). */
const MAX_SETTLE_ROUNDS = 64

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
  /** Per entity: the cells that asked whether a row is present (its slot's membership only). */
  readonly presence: TableSet<DepIndex<string>>
  /** The cells that read each relation slot, keyed `${entity}.${name}:${id}`. */
  readonly relationReaders: DepIndex<string>
  /** The relation engine; derivations read it only through `relations` (the fence). */
  readonly engine: PoolRelations
  /** The cells that asked whether a row is cold, keyed `${entity}:${id}` (POD-4580). */
  readonly coldness: DepIndex<string>
  /** Residency (POD-4580); null when the pool holds every row. */
  readonly residency: Residency | null
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
  /** Registry moves since the last commit, as deltas (residency reports them mid-ingest). */
  private readonly coldMoves: Delta[] = []

  constructor(
    readonly reads: ReadFence,
    locals: SliceLocals,
    schema: ModelSchema = SCHEMA,
    lazy?: PoolLazyOptions,
  ) {
    const graph = new CellGraph()
    this.graph = graph
    this.tables = createTables()
    this.fenced = reads.wrapTables(this.tables)
    this.rowReaders = tablesOf((entity) => new DepIndex<string>(`rows.${entity}`))
    this.presence = tablesOf((entity) => new DepIndex<string>(`presence.${entity}`))
    this.relationReaders = new DepIndex<string>('relations')
    this.membership = new DepIndex<EntityName>('membership')
    const coldness = new DepIndex<string>('coldness')
    this.coldness = coldness
    this.selection = new DepIndex<string>('selection')
    this.clock = new DeadlineClock(graph, locals.coarseNow)
    this.selectedId = locals.selectedIssueId
    const { fenced, rowReaders, presence, relationReaders } = this
    this.tracked = tablesOf((entity) => ({
      get(id: string): unknown {
        graph.track(rowReaders[entity], id)
        return fenced[entity].get(id)
      },
      has(id: string): boolean {
        graph.track(presence[entity], id)
        return fenced[entity].has(id)
      },
    }))
    const tracked = this.tracked
    const coldMoves = this.coldMoves
    const residency =
      lazy === undefined
        ? null
        : new Residency({
            schema,
            hot: fenced,
            load: lazy.load,
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
            asked: (entity, id) => graph.track(coldness, `${entity}:${id}`),
            changed: (entity, id) => coldMoves.push({ kind: 'residency', entity, id }),
          })
    this.residency = residency
    this.stats = createStats(graph, () => this.residency)
    const stats = this.stats
    // The engine sees every KNOWN row: a resident one in its table, a cold one
    // by id (read back through the feed only when maintenance needs its fields).
    const known: TableSet<ReadableTable> =
      residency === null
        ? fenced
        : tablesOf((entity) => ({
            get: (id: string) => fenced[entity].get(id) ?? residency.read(entity, id),
            has: (id: string) => fenced[entity].has(id) || residency.isCold(entity, id),
          }))
    this.engine = new PoolRelations({
      schema,
      rows: known,
      roots: this.tables,
      present: (entity, id) =>
        tracked[entity].has(id) || (residency?.known(entity, id) ?? false),
      touch: (entity, id) => reads.touch(entity, id, 'get'),
      read: (relation, id) => graph.track(relationReaders, `${relation}:${id}`),
      onWrite: (elements) => {
        stats.indexUpdates += elements
      },
    })
    this.relations = reads.wrapRelations(this.engine)
    this.inputs = {
      relations: this.relations,
      issue: (id) => tracked.issue.get(id) as SliceIssue | undefined,
      session: (id) => tracked.session.get(id) as SliceSession | undefined,
      repo: (id) => tracked.repo.get(id) as RepoRow | undefined,
      present: (entity, id) => tracked[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      parts: (id) => (tracked.issue.has(id) ? this.cellsOf(id) : undefined),
      selected: (id) => {
        graph.track(this.selection, id)
        return this.selectedId === id
      },
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    this.records = tablesOf(() => new Map<string, EntityRecord>())
    this.target = {
      read: this.fenced,
      write: this.tables,
      relations: this.engine,
      ...(residency === null ? {} : { residency }),
    }
    this.idsCell = graph.cell<readonly string[]>(
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
    residency?.onDue(() => this.hydrate())
  }

  // ---------------------------------------------------------------- reads

  /** Every issue id in the pool, in table order; a new array only when membership changed. */
  readonly issueIds = (): readonly string[] => this.graph.read(this.idsCell)

  /**
   * The row view of issue `id`, derived on first read; undefined when absent.
   * Cells exist only for a present row (`release` drops them with it), so
   * only a first read asks the table.
   */
  readonly view = (id: string): RowView | undefined => {
    const cells = this.issues.get(id)
    if (cells !== undefined) return cells.view
    return this.fenced.issue.has(id) ? this.cellsOf(id).view : undefined
  }

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

  /**
   * TRACKED: where the row `entity:id` stands. A cold row answers `loading`
   * and is queued (first access); a reader renders that as loading, never as
   * an empty row.
   */
  resident(entity: EntityName, id: string): Residence {
    if (this.tracked[entity].has(id)) return 'resident'
    return this.residency?.loading(entity, id) === true ? 'loading' : 'absent'
  }

  /**
   * TRACKED: a lazy collection (Rule L) as its resident members plus the
   * count still loading, every cold one queued. The shape a roll-up reads
   * (Hb3): a parent's progress derives from `ready` and it reports loading
   * while `pending > 0`. `ready` is in bucket order, which is none.
   */
  lazyMany(from: EntityName, id: string, relation: string): LazyMembers {
    const to = this.engine.schema[from].relations[relation]?.to
    if (to === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
    const ready: string[] = []
    let pending = 0
    for (const member of this.relations.many(from, id, relation)) {
      if (this.tracked[to].has(member)) ready.push(member)
      else if (this.residency?.loading(to, member) === true) pending += 1
    }
    return { ready, pending }
  }

  /**
   * Close the load window now: install every queued cold row, read by id
   * through the feed, in ONE commit. The window's timer calls this; so does
   * `snapshot()` while settling.
   */
  hydrate(): void {
    const residency = this.residency
    if (residency === null) return
    const batch = residency.take()
    if (batch.length === 0) return
    const out = ingestOut()
    this.engine.begin()
    for (const [entity, id] of batch) residency.hydrate(this.target, entity, id, out)
    this.commitIngest(out)
  }

  /** The resident issue ids, untracked (the rebuild's residency input). */
  residentIssueIds(): ReadonlySet<string> {
    return new Set(this.tables.issue.keys())
  }

  /**
   * The a1 slice output: every RESIDENT issue's row, no order yet (Hb1).
   * Settled: reading the rows queues the cold rows they reach, and those are
   * loaded and the rows read again until nothing is queued, as a reader that
   * waits out its loading state would see them.
   */
  snapshot(): SliceSnapshot {
    for (let round = 0; ; round += 1) {
      const rowsById: SliceSnapshot['rowsById'] = {}
      for (const id of this.issueIds()) {
        const view = this.view(id)
        if (view !== undefined) rowsById[id] = sliceRowOf(view)
      }
      if (this.residency?.hasQueued() !== true) return { order: EMPTY_ORDER, rowsById }
      if (round >= MAX_SETTLE_ROUNDS) {
        throw new Error(`[pool] snapshot() did not settle in ${MAX_SETTLE_ROUNDS} load rounds`)
      }
      this.hydrate()
    }
  }

  // --------------------------------------------------------------- writes

  /** One feed publication: ingest all of it, then one commit. */
  apply(event: RowSourceEvent): void {
    const out = ingestOut()
    this.engine.begin()
    if (event.type === 'replace') reseed(this.target, event.rows, out, this.residency ?? undefined)
    else for (const record of event.rows) ingestRecord(this.target, record, out)
    this.commitIngest(out)
  }

  /** One ingest's table, relation and registry writes as deltas, then one commit. */
  private commitIngest(out: IngestOut): void {
    this.stats.counters.tableWrites += out.deltas.length
    const deltas: Delta[] = out.deltas.map((delta) => ({ kind: 'row', ...delta }))
    for (const write of this.engine.lastWrites) deltas.push({ kind: 'relation', ...write })
    deltas.push(...this.coldMoves)
    this.coldMoves.length = 0
    this.commit(deltas)
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
      this.presence[entity].clear()
    }
    this.engine.clear()
    this.relationReaders.clear()
    this.residency?.clear()
    this.coldness.clear()
    this.coldMoves.length = 0
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
        if (delta.membership) {
          this.graph.invalidateKey(this.presence[delta.entity], delta.id)
          this.graph.invalidateKey(this.membership, delta.entity)
        }
        return
      case 'relation':
        this.graph.invalidateKey(this.relationReaders, `${delta.relation}:${delta.id}`)
        return
      case 'residency':
        this.graph.invalidateKey(this.coldness, `${delta.entity}:${delta.id}`)
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
        if (this.fenced[delta.entity].has(delta.id)) return
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
      case 'relation':
      case 'residency':
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
