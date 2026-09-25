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
 * `rollupsDerived` counts runs of the two roll-up compositions (Hb3,
 * `worklist/rollup.ts`: a node's attention `aggregate` and its `unitsBelow`).
 * The pool's own counters are in `stats.counters`.
 *
 * THE WORKLIST (POD-4582, Hb1; `worklist/visible.ts`). The visible
 * collection's parts are cells like every other; each resident issue has a
 * `visible` cell, created when its row enters the table (`admit`, only the
 * ids the commit moved). A commit runs two more steps after the drain:
 * `admit`, then the order handler (`settle`), which places exactly the ids
 * whose `visible` or `rank` cell moved. The list and `snapshot()` read the
 * order; order listeners are called in `publish` when it moved.
 *
 * THE GROUPS (POD-4583, Hb2; `worklist/groups.ts`). Each visible issue has a
 * `placement` cell (pinned, group key and label, fold verdict and stamp, from
 * the own row hot or cold); the commit's settle step recomputes the layout
 * only when the order moved or a placement reported, and the per-group lanes
 * (the R-GROUP 5 latch applied) only when the layout or the selection moved.
 * The list reads the grouped view, each header its own group's lanes, each
 * row its own view.
 *
 * THE ROLL-UPS (POD-4584, Hb3; `worklist/rollup.ts`). Each row's `phase`,
 * progress, `working`, `asking` and `workingSince` is a composition over
 * declared relations: the row's own seats plus its children's cached results,
 * never a subtree walk. Every known issue holds filing cells (its nest and
 * formal parents), maintained into two filings the compositions read; every
 * other part is a cell that recorded what it read, so a change re-runs its
 * own row's part and then each ancestor's composition once. The commit syncs
 * the filings for the issues its deltas named (or every known issue after a
 * `replace`), then settles the reported moves before the groups run, so the
 * fold placement reads a current `waiting`.
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
import { issueIdsOf, knownIssueIds, reseed } from './enumerate'
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
  sessionActivityOf,
  type ViewInputs,
} from './views'
import {
  retainedSeatIdsOf,
  VisibleCollection,
  type VisibleCounters,
  type VisibleInputs,
} from './worklist/visible'
import { RollupCollection } from './worklist/rollup'
import {
  sliceOrderOf,
  type GroupsView,
  type GroupLanes,
  WorklistGroups,
} from './worklist/groups'

/**
 * Everything that can change under the pool, as one closed union. Every
 * handler switches over it with a never-check, so a new kind fails typecheck
 * in each until it is handled.
 */
export type Delta =
  | ({ readonly kind: 'row' } & RowDelta)
  /** A relation slot the engine wrote: `relation` is `${entity}.${name}`, keyed by `id`. */
  | { readonly kind: 'relation'; readonly relation: string; readonly id: string }
  /** A cold row entered or left the registry (POD-4580): its `coldness` and `coldRows` readers re-run. */
  | { readonly kind: 'residency'; readonly entity: EntityName; readonly id: string }
  /** A known cold row was updated and stays cold (POD-4582): its `coldRows` readers re-run. */
  | { readonly kind: 'coldRow'; readonly entity: EntityName; readonly id: string }
  | { readonly kind: 'selection'; readonly to: string | null }
  /** `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch, POD-4583). */
  | { readonly kind: 'foldLatch'; readonly to: boolean }
  | { readonly kind: 'clock'; readonly to: number }

function unhandled(delta: never): never {
  throw new Error(`[pool] unhandled delta ${JSON.stringify(delta)}`)
}

/** The pool's own counters, beside the shared `ArmStats` (`README.md`, "Stats"). */
export interface PoolCounters extends CellCounters, VisibleCounters {
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
    visibleIssues: 0,
    visibleSessions: 0,
    membershipFlips: 0,
    orderMoves: 0,
    orderShifted: 0,
    orderSorts: 0,
    orderSorted: 0,
    groupRuns: 0,
    groupElements: 0,
  } satisfies Omit<PoolCounters, keyof CellCounters>) as PoolCounters
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
      if (cold !== undefined)
        for (const key of Object.keys(cold) as (keyof typeof cold)[]) cold[key] = 0
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
  /** The cells that read a cold row by id (`Residency.peek`), keyed `${entity}:${id}` (POD-4582). */
  readonly coldRows: DepIndex<string>
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
  /**
   * Per session: its contribution to its issue's `activityAt`, a cell created
   * when an issue's part first asks, disposed when the session leaves the pool
   * (POD-4581).
   */
  readonly sessionCells = new Map<string, Cell<number | null>>()
  /** Per entity: records built on first access, dropped with the row. */
  readonly records: TableSet<Map<string, EntityRecord>>
  /** Per issue id: the listeners of its row view. */
  readonly listeners = new Map<string, Set<() => void>>()
  /** Listeners of the id list. */
  readonly idsListeners = new Set<() => void>()
  /** The visible collection and its order (POD-4582, Hb1). */
  readonly worklist: VisibleCollection
  /** The row roll-ups over declared relations (POD-4584, Hb3). */
  readonly rollup: RollupCollection
  /** The inputs the visibility parts read, behind the same tracked doors. */
  readonly visibleInputs: VisibleInputs
  /** Listeners of the order. */
  readonly orderListeners = new Set<() => void>()
  /** The groups and closed folds over that order (POD-4583, `worklist/groups.ts`). */
  readonly groups: WorklistGroups
  /** Listeners of the grouped view (the list). */
  readonly groupsListeners = new Set<() => void>()
  /** Listeners per group key (its header). */
  readonly groupListeners = new Map<string, Set<() => void>>()
  private readonly idsCell: Cell<readonly string[]>
  private readonly target: IngestTarget
  private selectedId: string | null
  /** `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch, POD-4583). */
  private foldLatch: boolean
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
    const coldRows = new DepIndex<string>('coldRows')
    this.coldRows = coldRows
    this.selection = new DepIndex<string>('selection')
    this.clock = new DeadlineClock(graph, locals.coarseNow)
    this.selectedId = locals.selectedIssueId
    this.foldLatch = locals.selectedIssueWasFolded === true
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
            now: () => this.clock.current,
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
            asked: (entity, id) => graph.track(coldness, `${entity}:${id}`),
            changed: (entity, id) => coldMoves.push({ kind: 'residency', entity, id }),
            peeked: (entity, id) => graph.track(coldRows, `${entity}:${id}`),
            rewritten: (entity, id) => coldMoves.push({ kind: 'coldRow', entity, id }),
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
      present: (entity, id) => tracked[entity].has(id) || (residency?.known(entity, id) ?? false),
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
      sessionActivity: (id) => this.sessionActivity(id),
      present: (entity, id) => tracked[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      parts: (id) => (tracked.issue.has(id) ? this.cellsOf(id) : undefined),
      rollup: (id) => this.rollup.rollupViewOf(id),
      retainedSeats: (id) => {
        const parts = this.visibleInputs.issue(id)
        return parts === undefined ? [] : retainedSeatIdsOf(this.visibleInputs, id, parts, false)
      },
      selected: (id) => {
        graph.track(this.selection, id)
        return this.selectedId === id
      },
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    const knownDoor = (entity: 'issue' | 'session', id: string): boolean =>
      tracked[entity].has(id) || (residency?.known(entity, id) ?? false)
    const knownRaw = (entity: 'issue' | 'session', id: string): boolean =>
      this.tables[entity].has(id) || (this.residency?.isCold(entity, id) ?? false)
    this.visibleInputs = {
      relations: this.relations,
      resident: (entity, id) => tracked[entity].has(id),
      issueRow: (id) =>
        (tracked.issue.get(id) ?? residency?.peek('issue', id)) as SliceIssue | undefined,
      sessionRow: (id) =>
        (tracked.session.get(id) ?? residency?.peek('session', id)) as SliceSession | undefined,
      // Held parts first (no table touch at all): the hot paths (rosters over
      // bucket members) re-check membership on every recompute, and a fenced
      // presence check there counts every member on the fence (#2's budget).
      // Otherwise the raw check decides without counting; an unknown id falls
      // back to the tracked door, so its later appearance still wakes this
      // cell (a re-added parent re-nests its descendants). Removals still
      // reach every reader: the row and relation deltas dirty their cells,
      // and the commit forgets the holders.
      issue: (id) =>
        this.worklist.peekIssue(id) ??
        (knownRaw('issue', id)
          ? this.worklist.issue(id)
          : knownDoor('issue', id)
            ? this.worklist.issue(id)
            : undefined),
      session: (id) =>
        this.worklist.peekSession(id) ??
        (knownRaw('session', id)
          ? this.worklist.session(id)
          : knownDoor('session', id)
            ? this.worklist.session(id)
            : undefined),
      sessionActivity: (id) => this.sessionActivity(id),
      own: (id) => (tracked.issue.has(id) ? this.cellsOf(id).own : undefined),
      passed: (t) => this.clock.passed(t),
    }
    this.worklist = new VisibleCollection({
      graph,
      inputs: this.visibleInputs,
      counters: this.stats.counters,
    })
    const worklist = this.worklist
    this.rollup = new RollupCollection({
      graph,
      relations: this.relations,
      forward: (from, id, relation) => this.engine.forward(from, id, relation),
      issueRow: (id) => this.visibleInputs.issueRow(id),
      sessionRow: (id) => this.visibleInputs.sessionRow(id),
      resident: (entity, id) => this.visibleInputs.resident(entity, id),
      loading: (entity, id) => this.inputs.loading(entity, id),
      knownIssue: (id) => this.tables.issue.has(id) || (this.residency?.isCold('issue', id) ?? false),
      visibleIssue: (id) => this.visibleInputs.issue(id),
      sessionParts: (id) => this.visibleInputs.session(id),
      rosterOf: (id) => {
        const parts = this.visibleInputs.issue(id)
        return parts === undefined ? [] : retainedSeatIdsOf(this.visibleInputs, id, parts, true)
      },
      seatActivity: (id) => this.sessionActivity(id),
      counted: () => {
        this.stats.rollupsDerived += 1
      },
    })
    this.groups = new WorklistGroups({
      graph,
      inputs: {
        ...this.visibleInputs,
        waiting: (id) => this.rollup.waitingOf(id),
      },
      order: () => worklist.order(),
      has: (id) => worklist.has(id),
      rankOf: (id) => worklist.placedRankOf(id),
      selectedId: () => this.selectedId,
      foldLatch: () => this.foldLatch,
      counters: this.stats.counters,
    })
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

  /**
   * TRACKED: session `id`'s contribution to `activityAt`, from its cell. The
   * cell reads the session's row (a cold or absent one reads as null, and its
   * arrival re-runs the cell); a reader of the cell re-runs only when the
   * value moves. It asks nothing else, so a roll-up over N members that
   * re-composes after one member's change reads that one row, not N.
   */
  sessionActivity(id: string): number | null {
    let cell = this.sessionCells.get(id)
    if (cell === undefined) {
      cell = this.graph.cell(
        `activity:${id}`,
        () => sessionActivityOf(this.inputs.session(id)),
        Object.is,
      )
      this.sessionCells.set(id, cell)
    }
    return this.graph.read(cell)
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

  /** Rows queued for a load that has not landed yet (the fence refuses a step that leaves any). */
  pendingLoads(): number {
    return this.residency?.queued() ?? 0
  }

  /**
   * Land every pending load NOW, and whatever those loads queue in turn,
   * until nothing is queued: one commit per round, as the window would. The
   * rows installed are returned, so a caller can charge them to the change
   * that asked for them (the shared fence's drain hook, POD-4568's G2).
   */
  drainLoads(): number {
    const residency = this.residency
    if (residency === null) return 0
    const before = residency.counters.hydrated
    for (let round = 0; residency.hasQueued(); round += 1) {
      if (round >= MAX_SETTLE_ROUNDS) {
        throw new Error(`[pool] loads did not drain in ${MAX_SETTLE_ROUNDS} rounds`)
      }
      this.hydrate()
    }
    return residency.counters.hydrated - before
  }

  /** The resident issue ids, untracked (the rebuild's residency input). */
  residentIssueIds(): ReadonlySet<string> {
    return new Set(issueIdsOf(this.tables.issue))
  }

  /** The visible issue ids in rank order (POD-4582); a new array only when the order moved. */
  readonly order = (): readonly string[] => this.worklist.order()

  /** Listen to the order; returns the unsubscribe. */
  readonly subscribeOrder = (listener: () => void): (() => void) => {
    this.orderListeners.add(listener)
    return () => {
      this.orderListeners.delete(listener)
    }
  }

  /**
   * What the list draws: the pinned ids and group keys with the latch
   * applied; a new object only when the lanes moved (POD-4583). Reads no
   * row: the list subscribes to this, never to rows.
   */
  readonly groupsView = (): GroupsView => this.groups.drawn()

  /** One group's UI lanes (identity-kept: the same object while its lists are equal). */
  readonly groupLanes = (key: string): GroupLanes => this.groups.lanesOf(key)

  /** Listen to the grouped view; returns the unsubscribe. */
  readonly subscribeGroups = (listener: () => void): (() => void) => {
    this.groupsListeners.add(listener)
    return () => {
      this.groupsListeners.delete(listener)
    }
  }

  /** Listen to one group's lanes; returns the unsubscribe. */
  readonly subscribeGroup = (key: string, listener: () => void): (() => void) => {
    let set = this.groupListeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.groupListeners.set(key, set)
    }
    set.add(listener)
    return () => {
      const current = this.groupListeners.get(key)
      if (current === undefined || !current.delete(listener) || current.size > 0) return
      this.groupListeners.delete(key)
    }
  }

  /**
   * The slice output: the VISIBLE rows in rank order, grouped with closed
   * folds and no selection (POD-4583, `worklist/groups.ts`). Settled: reading
   * the rows (and deciding visibility) queues the cold rows they reach, and
   * those are loaded and the rows read again until nothing is queued, as a
   * reader that waits out its loading state would see them.
   */
  snapshot(): SliceSnapshot {
    for (let round = 0; ; round += 1) {
      const rowsById: SliceSnapshot['rowsById'] = {}
      for (const id of this.order()) {
        const view = this.view(id)
        if (view === undefined) continue
        rowsById[id] = sliceRowOf(view)
      }
      if (this.residency?.hasQueued() !== true) {
        return { order: sliceOrderOf(this.groups.snapshot()), rowsById }
      }
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
    this.commitIngest(out, event.type === 'replace')
  }

  /** One ingest's table, relation and registry writes as deltas, then one commit. */
  private commitIngest(out: IngestOut, fullSync = false): void {
    this.stats.counters.tableWrites += out.deltas.length
    const deltas: Delta[] = out.deltas.map((delta) => ({ kind: 'row', ...delta }))
    for (const write of this.engine.lastWrites) deltas.push({ kind: 'relation', ...write })
    deltas.push(...this.coldMoves)
    this.coldMoves.length = 0
    this.commit(deltas, fullSync)
  }

  /** One locals notification: only the keys it names that the pool uses. */
  applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    const deltas: Delta[] = []
    if (changed.has('selectedIssueId') && locals.selectedIssueId !== this.selectedId) {
      deltas.push({ kind: 'selection', to: locals.selectedIssueId })
    }
    if (
      changed.has('selectedIssueWasFolded') &&
      (locals.selectedIssueWasFolded === true) !== this.foldLatch
    ) {
      deltas.push({ kind: 'foldLatch', to: locals.selectedIssueWasFolded === true })
    }
    if (changed.has('coarseNow')) deltas.push({ kind: 'clock', to: locals.coarseNow })
    this.commit(deltas)
  }

  /**
   * POD-4586 (Hc1) — one optimistic overlay commit: the write layer dirtied
   * exactly the pending keys it moved via `invalidate`, then this drains,
   * settles the filings, the order and the groups, and publishes once. No
   * table, relation or residency write is involved; filings do not move on a
   * title/stage/readAt edit, so no filing sync is needed.
   */
  commitOverlay(invalidate: () => void): void {
    invalidate()
    this.graph.flush()
    this.rollup.settleFilings()
    this.graph.flush()
    this.worklist.settle()
    const orderDelta = this.worklist.takeMoved()
    this.groups.settle(orderDelta, false)
    const groupsMoved = this.groups.takeMoved()
    this.publish(orderDelta.moved, groupsMoved)
    this.stats.notifications += 1
  }

  /** Called by a view cell whose value changed. */
  changed(id: string): void {
    this.changedIds.add(id)
  }

  /** Empty every table, cell, index, record and listener. */
  dispose(): void {
    this.worklist.clear()
    this.rollup.clear()
    this.groups.clear()
    for (const cells of this.issues.values()) cells.dispose()
    this.issues.clear()
    for (const cell of this.sessionCells.values()) this.graph.dispose(cell)
    this.sessionCells.clear()
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
    this.coldRows.clear()
    this.coldMoves.length = 0
    this.membership.clear()
    this.selection.clear()
    this.clock.clear()
    this.graph.clear()
    this.listeners.clear()
    this.idsListeners.clear()
    this.orderListeners.clear()
    this.groupsListeners.clear()
    this.groupListeners.clear()
    this.changedIds.clear()
    this.selectedId = null
    this.foldLatch = false
  }

  // ------------------------------------------------------------- handlers

  private commit(deltas: readonly Delta[], fullSync = false): void {
    if (deltas.length === 0 && !fullSync) return
    for (const delta of deltas) this.invalidate(delta)
    for (const delta of deltas) this.release(delta)
    // Handler 2b: the roll-ups. The issues this commit named gain or lose
    // their filing cells (a `replace` re-files every known issue: raw doors,
    // no fence); the drain then runs the new and moved filings.
    if (fullSync) {
      this.rollup.syncAll(knownIssueIds(this))
    } else {
      const named: string[] = []
      for (const delta of deltas) {
        if (delta.kind === 'row' && delta.entity === 'issue') named.push(delta.id)
        else if (delta.kind === 'residency' && delta.entity === 'issue') named.push(delta.id)
      }
      this.rollup.sync(named)
    }
    this.graph.flush()
    // Handler 3: the worklist. The issues this commit moved into or out of
    // the tables gain or lose their `visible` cell, then the order places
    // exactly the ids whose `visible` or `rank` cell moved.
    const entered: string[] = []
    for (const delta of deltas) {
      if (delta.kind === 'row' && delta.membership && delta.entity === 'issue') {
        entered.push(delta.id)
      }
    }
    this.worklist.admit(entered, (id) => this.fenced.issue.has(id))
    this.graph.flush()
    // Handler 3a: the filings. Move exactly the reported ids and dirty their
    // old and new parents' slots, then run the compositions they woke.
    this.rollup.settleFilings()
    this.graph.flush()
    this.worklist.settle()
    // Handler 3b: the groups. The filings move exactly the rows that moved
    // (placements that reported, ids that entered or left); the lanes only
    // for the touched groups, or the latch's on a selection move (POD-4694).
    const orderDelta = this.worklist.takeMoved()
    const selectionMoved = deltas.some(
      (delta) => delta.kind === 'selection' || delta.kind === 'foldLatch',
    )
    this.groups.settle(orderDelta, selectionMoved)
    const groupsMoved = this.groups.takeMoved()
    this.publish(orderDelta.moved, groupsMoved)
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
        this.graph.invalidateKey(this.coldRows, `${delta.entity}:${delta.id}`)
        return
      case 'coldRow':
        this.graph.invalidateKey(this.coldRows, `${delta.entity}:${delta.id}`)
        return
      case 'selection': {
        const from = this.selectedId
        this.selectedId = delta.to
        if (from !== null) this.graph.invalidateKey(this.selection, from)
        if (delta.to !== null) this.graph.invalidateKey(this.selection, delta.to)
        return
      }
      case 'foldLatch':
        this.foldLatch = delta.to
        return
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
        if (delta.entity === 'session') this.releaseSession(delta.id)
        if (delta.entity !== 'issue') return
        const cells = this.issues.get(delta.id)
        if (cells !== undefined) {
          cells.dispose()
          this.issues.delete(delta.id)
        }
        if (this.residency?.isCold('issue', delta.id) !== true) this.worklist.forgetIssue(delta.id)
        if (this.residency?.isCold('issue', delta.id) !== true) this.groups.forgetIssue(delta.id)
        return
      }
      case 'residency':
        // A session removed while cold leaves the registry and no table.
        if (
          delta.entity === 'session' &&
          !this.tables.session.has(delta.id) &&
          this.residency?.isCold('session', delta.id) !== true
        ) {
          this.releaseSession(delta.id)
        }
        // An issue removed while cold leaves the registry and no table.
        if (
          delta.entity === 'issue' &&
          !this.tables.issue.has(delta.id) &&
          this.residency?.isCold('issue', delta.id) !== true
        ) {
          this.worklist.forgetIssue(delta.id)
          this.groups.forgetIssue(delta.id)
        }
        return
      case 'relation':
      case 'coldRow':
      case 'selection':
      case 'foldLatch':
      case 'clock':
        return
      default:
        unhandled(delta)
    }
  }

  /** A session left the pool: its activity cell goes (its readers re-run). */
  private releaseSession(id: string): void {
    if (this.residency?.isCold('session', id) !== true) this.worklist.forgetSession(id)
    this.rollup.forgetSession(id)
    const cell = this.sessionCells.get(id)
    if (cell === undefined) return
    this.graph.dispose(cell)
    this.sessionCells.delete(id)
  }

  /** Handler 4 (after the drain): each changed key's listeners, once. */
  private publish(
    orderMoved: boolean,
    groupsMoved: { readonly moved: boolean; readonly changedKeys: readonly string[] },
  ): void {
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
    if (orderMoved) {
      for (const listener of [...this.orderListeners]) {
        this.stats.counters.listenerCalls += 1
        listener()
      }
    }
    if (groupsMoved.moved) {
      for (const listener of [...this.groupsListeners]) {
        this.stats.counters.listenerCalls += 1
        listener()
      }
    }
    for (const key of groupsMoved.changedKeys) {
      const set = this.groupListeners.get(key)
      if (set === undefined) continue
      for (const listener of [...set]) {
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
