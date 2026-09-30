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
 * `residency` delta, handled like every other. The harness drains the window
 * (`hydrate` in a loop) before it reads. Without `lazy` every row is
 * resident (the Ha1/Ha2 tests that build the pool directly).
 *
 * READ PATH. Every table read goes through the reads fence
 * (`reads.wrapTables`) behind a tracked door (`tracked`), every relation read
 * through `reads.wrapRelations`; with the fence disabled both are the raw
 * objects. A row view is a cell per part, created when a mounted row reads
 * it and kept current by the drain after that.
 *
 * STRICT DOORS (POD-4933) live only in the harness
 * (`harness/src/adapters/hand-pool.ts`): the pool has no drain loop, no
 * pending probe, no resident-ids helper and no settling snapshot.
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
 * collection's parts are cells like every other; each closure issue has a
 * `visible` cell (POD-4707), created when the closure admits its row
 * (`admit`: the closure's resident members, never the corpus). A commit
 * runs two more steps after the drain:
 * `admit`, then the order handler (`settle`), which places exactly the ids
 * whose `visible` or `rank` cell moved. The list reads the order; order
 * listeners are called in `publish` when it moved.
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
 *   never a subtree walk. Every closure issue holds filing cells (its nest and
 *   formal parents: POD-4707 — the visible rows, their visibility
 *   dependencies and anything touched since, computed in one plain pass at a
 *   `replace` and materialised on first access after that), maintained into
 *   two filings the compositions read; every other part is a cell that
 *   recorded what it read, so a change re-runs its own row's part and then
 *   each ancestor's composition once. The commit syncs the filings for the
 *   closure of what it touched (or the whole closure, recomputed, after a
 *   `replace`), then settles the reported moves before the groups run, so
 *   the fold placement reads a current `waiting`.
 */

import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import type { RowView } from '../../../shared/src/row-view'
import { type EntityName, type ModelSchema, SCHEMA } from '../../../shared/src/schema'
import type {
  LocalsKey,
  SliceIssue,
  SliceLocals,
  SliceSession,
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
import { type GroupLanes, type GroupsView, WorklistGroups } from './worklist/groups'
import { LOADING, type Loaded, RollupCollection } from './worklist/rollup'
import {
  COLD_SESSION_FIELDS,
  directSessionParts,
  directVisibleParts,
  HIDDEN_ISSUE_FIELDS,
  retainedSeatIdsOf,
  type SessionVisibleParts,
  standingOf,
  VisibleCollection,
  type VisibleCounters,
  type VisibleInputs,
  type VisibleParts,
} from './worklist/visible'

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

/**
 * What `HandPool.row` answers for a row that is not in memory (a cold row),
 * the hand mirror of the MobX pool's `AbsentRead` (POD-4743):
 * - `load`: `LOADING`, and the row is queued for the next load window (a
 *   cell's first access);
 * - `mark`: `LOADING`, nothing queued (maintenance inside a commit, which
 *   must not arm the window);
 * - `peek`: the row's declared summary (a hidden issue's `HIDDEN_ISSUE_FIELDS`),
 *   nothing queued (the visibility parts decide a cold row without loading it).
 * Unknown rows answer undefined in every mode. Never blocks.
 */
export type AbsentRead = 'load' | 'mark' | 'peek'

/** The editable fields of an issue row, as the pending overlay holds them. */
export type PendingOverlay = { title?: string; stage?: string; readAt?: string | null }

/** A lazy collection: its resident members, and how many are still loading. */
export interface LazyMembers {
  readonly ready: readonly string[]
  readonly pending: number
}

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
  /**
   * The cells that read a cold row's declared summary, keyed
   * `${entity}:${id}` (POD-4753; was `Residency.peek`, POD-4582).
   */
  readonly coldRows: DepIndex<string>
  /** The cells that read a row's pending overlay, keyed `issue:${id}` (POD-4586). */
  readonly pendingReaders: DepIndex<string>
  /** The pending display per edited issue row (the write layer's newest values). */
  private readonly pendingOverlays = new Map<string, PendingOverlay>()
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
  /**
   * POD-4706 — issue ids carrying a pending edit. The write layer adds an id
   * when it paints an overlay and removes it when nothing is pending for the
   * row; a `replace` keeps a pinned row resident even when the cold rule
   * would evict it, so a pending display never loses its server row.
   */
  readonly writePins = new Set<string>()
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
    const pendingReaders = new DepIndex<string>('write.pending')
    this.pendingReaders = pendingReaders
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
            // What visibility and roll-ups read of cold rows (POD-4753,
            // POD-5024), never the row.
            summaries: { issue: HIDDEN_ISSUE_FIELDS, session: COLD_SESSION_FIELDS },
            asked: (entity, id) => graph.track(coldness, `${entity}:${id}`),
            changed: (entity, id) => coldMoves.push({ kind: 'residency', entity, id }),
            peeked: (entity, id) => graph.track(coldRows, `${entity}:${id}`),
            rewritten: (entity, id) => coldMoves.push({ kind: 'coldRow', entity, id }),
            // The rule's lane source (R3, POD-4745) reads the engine, built below.
            lanes: () => this.engine,
          })
    this.residency = residency
    this.stats = createStats(graph, () => this.residency)
    const stats = this.stats
    // The engine knows every KNOWN row (a target is present hot or cold) and
    // reads only resident ones: a cold row's fields it needs again it keeps
    // itself, from the row ingest hands it (POD-4753), never read by id.
    const known: TableSet<ReadableTable> =
      residency === null
        ? fenced
        : tablesOf((entity) => ({
            get: (id: string) => fenced[entity].get(id),
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
      onIssuelessJoin: (collection, _target, member) => residency?.laneJoined(collection, member),
    })
    this.relations = reads.wrapRelations(this.engine)
    const inMemory = (row: Loaded<object>): object | undefined =>
      row === LOADING ? undefined : row
    this.inputs = {
      relations: this.relations,
      issue: (id) => inMemory(this.row('issue', id)) as SliceIssue | undefined,
      session: (id) => inMemory(this.row('session', id)) as SliceSession | undefined,
      repo: (id) => inMemory(this.row('repo', id)) as RepoRow | undefined,
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
      issueRow: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      sessionRow: (id) => this.row('session', id, 'peek') as SliceSession | undefined,
      hidden: (id) => this.hidden('issue', id) as Record<string, unknown> | undefined,
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
      row: (entity, id, absent: AbsentRead = 'load'): Loaded<object> => {
        if (absent === 'peek') return this.row(entity, id, 'peek') as Loaded<object>
        return this.row(entity, id, absent)
      },
      knownIssue: (id) =>
        this.tables.issue.has(id) || (this.residency?.isCold('issue', id) ?? false),
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
   * only a first read asks the table. A pure read: filings are maintained on
   * the change path (bootstrap, replace, per-change closure, residency
   * admission), never here — this is React's getSnapshot
   * (`useSyncExternalStore(subscribe, () => pool.view(id))`), which must not
   * flush, settle or notify.
   */
  readonly view = (id: string): RowView | undefined => {
    const cells = this.issues.get(id)
    if (cells !== undefined) return cells.view
    if (!this.fenced.issue.has(id)) return undefined
    return this.cellsOf(id).view
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
   * TRACKED: the pending display for `entity:id`, or undefined when nothing
   * is pending (the write layer's newest values per edited field). The one
   * reader lays it over the row; a reader subscribes to the overlay entry,
   * never to the transient overlaid object.
   */
  pending(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    if (entity !== 'issue') return undefined
    this.graph.track(this.pendingReaders, `issue:${id}`)
    return this.pendingOverlays.get(`issue:${id}`)
  }

  /**
   * The write layer's pending display, as the one reader sees it: set the
   * overlay for `entity:id` (or clear it with undefined). Tracking is via
   * `pending()`; invalidation via `commitOverlay` (the write layer dirties
   * both the overlay entry and the row slot, so cells created before the
   * layer wrapped still wake).
   */
  setPendingOverlay(entity: EntityName, id: string, overlay: PendingOverlay | undefined): void {
    const key = `${entity}:${id}`
    if (overlay === undefined) {
      this.pendingOverlays.delete(key)
      return
    }
    this.pendingOverlays.set(key, overlay)
  }

  /**
   * TRACKED: THE row reader (POD-4743, the hand mirror of `MobxPool.row`).
   * Every row a view, visibility part, roll-up or group placement reads comes
   * from here, so they all see one value.
   *
   * In memory: the server row with the write layer's pending edits overlaid,
   * or the server object itself when nothing is pending (same identity, so an
   * idle write layer adds no commit). The overlaid object is transient, never
   * stored; a reader subscribes to the table slot and the overlay entry,
   * never to it.
   *
   * Not in memory (cold, POD-4580): what `absent` names. A cold row's load is
   * queued in `load` mode (`LOADING`), never queued in `mark` mode
   * (`LOADING`), and its declared summary answered in `peek` mode (hidden
   * issues: `HIDDEN_ISSUE_FIELDS`, never the row). Unknown rows answer
   * undefined. Never blocks.
   */
  row(entity: EntityName, id: string, absent: 'peek'): object | undefined
  row(entity: EntityName, id: string, absent?: 'load' | 'mark'): Loaded<object>
  row(entity: EntityName, id: string, absent: AbsentRead = 'load'): Loaded<object> {
    const pending = this.pending(entity, id)
    const server = this.fenced[entity].get(id) as object | undefined
    if (server !== undefined) {
      this.graph.track(this.rowReaders[entity], id)
      return pending === undefined ? server : { ...server, ...pending }
    }
    const residency = this.residency
    if (residency === null) {
      this.graph.track(this.presence[entity], id)
      return undefined
    }
    if (absent === 'load') {
      if (residency.loading(entity, id)) return LOADING
      this.graph.track(this.presence[entity], id)
      return undefined
    }
    if (!residency.known(entity, id)) {
      this.graph.track(this.presence[entity], id)
      return undefined
    }
    if (absent === 'mark') return LOADING
    const summary = residency.summary(entity, id)
    if (summary === undefined) return undefined
    return pending === undefined
      ? (summary as object)
      : { ...(summary as Record<string, unknown>), ...pending }
  }

  /**
   * TRACKED: the declared summary of a row the cold rule keeps hidden
   * (POD-4753): a hidden issue's visibility reads it instead of its row.
   * Undefined for a row in memory, one held out beside the rule, or unknown.
   */
  hidden(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    const residency = this.residency
    if (residency === null) return undefined
    // A row in memory is never hidden, and its reader already tracks its
    // table slot: asked untracked, so no residency atom is made per issue in
    // memory.
    if (this.tables[entity].has(id)) return undefined
    if (!residency.hidden(entity, id)) return undefined
    return residency.summary(entity, id) ?? {}
  }

  // --------------------------------------------- the lazy closure (POD-4707)

  /**
   * POD-4707 — whether the pool knows the issue, hot or cold (raw doors:
   * the table plus the cold registry, no fence, no tracking).
   */
  private knowsIssue(id: string): boolean {
    return this.tables.issue.has(id) || (this.residency?.isCold('issue', id) ?? false)
  }

  /**
   * POD-4707 — a single-valued relation through raw doors (the filing's
   * shape): the engine's forward key with the target's presence re-checked
   * against the raw tables and the cold registry. Identical values to the
   * fenced `one()` derivations read; counted nowhere (the fence counts the
   * wrapped reader only, and `forward` itself touches no row). Callers pass
   * links only, as the derivations do.
   */
  private plainOne(from: EntityName, id: string, relation: string): string | null {
    const target = this.engine.forward(from, id, relation)
    if (target === null) return null
    const to = (this.engine.schema[from].relations[relation] as { readonly to?: EntityName })?.to
    if (to === undefined) return null
    return this.tables[to].has(target) || (this.residency?.isCold(to, target) ?? false)
      ? target
      : null
  }

  /**
   * POD-4707 — the visibility parts over plain reads: the same rule table
   * the live cells run (`VISIBLE_RULES` through `directVisibleParts`),
   * evaluated without building a cell or a filing. Relations come from the
   * raw engine (`forward` + `members`: no fence, no tracking — identical
   * ids to the fenced doors derivations read); rows from the raw tables
   * with cold rows answered through their declared summary (never a full
   * peek, never a load); the clock from the live clock (tracking no-ops
   * outside a cell). The row view (`own`) is a loud stub: rank is outside
   * the closure read set, so a read there means the scope grew and must
   * grow with it.
   *
   * Values equal the live derivations' at a quiescent point, with one
   * stated exception: pending write overlays project through the live row
   * doors only. That is safe here: the closure inputs the pass reads for
   * an unheld row (its parentId, startedBy link and the standing fields
   * the nest walk uses) are not overlay fields, and a row carrying an
   * overlay is always held — the write layer ensures it before it paints.
   */
  private plainScope(): {
    readonly partsOf: (id: string) => VisibleParts
    readonly rowOf: (id: string) => SliceIssue | undefined
  } {
    const memo = new Map<string, VisibleParts>()
    const sessMemo = new Map<string, SessionVisibleParts>()
    // One row read per id per pass: the ancestor walk re-reaches shared
    // ancestors, and each cold row answers its declared summary at most once
    // here (the live derivations read it again when they run).
    const rowMemo = new Map<string, SliceIssue | undefined>()
    const rowOf = (id: string): SliceIssue | undefined => {
      if (!rowMemo.has(id)) {
        rowMemo.set(
          id,
          (this.tables.issue.get(id) ?? this.residency?.summary('issue', id)) as
            | SliceIssue
            | undefined,
        )
      }
      return rowMemo.get(id)
    }
    const raw: RelationReader = {
      one: (from, id, relation) => this.plainOne(from, id, relation),
      many: (from, id, relation) => this.engine.members(from, id, relation),
      size: (from, id, relation) => this.engine.members(from, id, relation).size,
      // POD-4671: the maintained issueless set, engine-direct like many/size
      // (the plain pass counts nothing; both arms resolved in favour of both).
      subset: (from, id, relation, subset) => this.engine.subset(from, id, relation, subset),
    }
    const plain: VisibleInputs = {
      relations: raw,
      resident: (entity, id) => this.tables[entity].has(id),
      issueRow: (id) => rowOf(id),
      hidden: (id) => {
        if (this.tables.issue.has(id)) return undefined
        if (!(this.residency?.isCold('issue', id) ?? false)) return undefined
        return this.residency?.summary('issue', id) as Record<string, unknown> | undefined
      },
      sessionRow: (id) =>
        (this.tables.session.get(id) ?? this.residency?.summary('session', id)) as
          | SliceSession
          | undefined,
      issue: (id) => (this.knowsIssue(id) ? directVisibleParts(plain, id, memo) : undefined),
      session: (id) => {
        if (!this.tables.session.has(id) && !(this.residency?.isCold('session', id) ?? false))
          return undefined
        let parts = sessMemo.get(id)
        if (parts === undefined) {
          parts = directSessionParts(plain, id)
          sessMemo.set(id, parts)
        }
        return parts
      },
      sessionActivity: (id) =>
        sessionActivityOf(this.tables.session.get(id) as SliceSession | undefined),
      own: () => {
        throw new Error('[pool] plain pass read the row view: rank is outside the closure read set')
      },
      passed: (t) => this.clock.passed(t),
    }
    return {
      partsOf: (id) => directVisibleParts(plain, id, memo),
      rowOf,
    }
  }

  /**
   * POD-4707 — expand `roots` to the lazy closure: each root's ancestor
   * chain by the raw `parentId` (the same field the nest walk follows,
   * through any issue), the started-by owner of a parentless started-by
   * root evaluated through the plain pass (hot rows only: a cold member
   * nests under nothing), then every formal subtree under the union.
   * Ancestors join even when cold (the nest walk passes through a hidden
   * parent) and even when held (a reparented held row picks up its new
   * parent: every root verifies its first hop); the walk stops at a
   * pre-existing held chain (complete by induction) and at unknown ids.
   * Formal descendants join even when hidden (the parent's progress
   * composes over their cached units), walked under unheld members only
   * (a held member's subtree is complete by the same induction). Reads
   * rows, never tables; builds no cell. Membership is a `Set`, so the
   * expansion is linear in the closure, never a scan per member.
   *
   * POD-4706: a `replace` passes a never-held predicate, so the closure is
   * computed purely over the new slice — exactly as a fresh bootstrap over
   * the same slice computes it (its worklist is empty). Reading the live
   * worklist here would root hidden rows under parents that were visible
   * before the replace and prune walks at chains that no longer hold,
   * and the back-replace would keep filings and member cells a fresh
   * bootstrap never builds.
   */
  private expandRoots(
    roots: readonly string[],
    partsOf: (id: string) => VisibleParts,
    rowOf: (id: string) => SliceIssue | undefined,
    held: (id: string) => boolean = (id) => this.worklist.has(id),
  ): Set<string> {
    const closure = new Set<string>()
    const visit = (id: string): boolean => {
      if (closure.has(id) || !this.knowsIssue(id)) return false
      closure.add(id)
      return true
    }
    for (const root of roots) {
      if (!this.knowsIssue(root)) continue
      visit(root)
      let current = root
      for (;;) {
        const row = rowOf(current)
        if (row === undefined) break
        const standing = standingOf(row)
        let next: string | null = null
        if (standing.parentId !== null) {
          next = standing.parentId
        } else if (standing.startedBy !== null && this.tables.issue.has(current)) {
          next = partsOf(current).nestParent
        } else {
          break
        }
        if (next === null || !this.knowsIssue(next)) break
        if (!visit(next)) break
        if (held(next)) break
        current = next
      }
    }
    const below = [...closure].filter((id) => !held(id))
    for (let head = 0; head < below.length; head += 1) {
      const id = below[head] as string
      for (const child of this.engine.members('issue', id, 'children')) {
        if (visit(child)) below.push(child)
      }
    }
    return closure
  }

  /**
   * POD-4707 — the issues a changed session can show: its explicit owner
   * and every issue checked out at its lane (the MobX arm's split,
   * POD-4705). Answered through raw doors without walking anything or
   * counting a read; filtered by the pool's own knowledge.
   */
  private sessionLinkedIssues(sessionId: string): {
    readonly explicit: string | null
    readonly lane: readonly string[]
  } {
    const explicit = this.plainOne('session', sessionId, 'issue')
    const lanePath = this.plainOne('session', sessionId, 'worktree')
    const lane: string[] = []
    if (lanePath !== null) {
      for (const issueId of this.engine.members('worktree', lanePath, 'issues')) {
        if (this.knowsIssue(issueId)) lane.push(issueId)
      }
    }
    return {
      explicit: explicit !== null && this.knowsIssue(explicit) ? explicit : null,
      lane,
    }
  }

  /**
   * POD-4707 — the lazy closure at a `replace`: the plain pass evaluates
   * every known issue (the one sanctioned walk, over `knownIssueIds`) and
   * roots the present and keeping rows (visible implies present, so no
   * placement chain runs) with their ancestors and formal subtrees — the
   * only rows a visible derivation can read. Cold rows answer their live values
   * (peeked, never loaded): a cold row kept visible by its lane still
   * roots, exactly as its live parts would answer. Held rows re-verify by
   * the same rule (held outsiders leave); a hidden row is also rooted when
   * its where-filtered formal parent is held (what the filing files, so a
   * hidden formal child of a held parent still files and its progress
   * counts).
   *
   * POD-4706: nothing here reads the live worklist. At a fresh bootstrap
   * the worklist is empty, so the held-parent rule never fires and no walk
   * stops early; a back-replace must compute the same closure over the same
   * slice, but the live worklist still shows the grown visible set — rooting
   * hidden rows under leaving parents and pruning walks at leaving chains,
   * which keeps filings and member cells a fresh bootstrap never builds.
   * The update path (`updateClosure`, `ensureIssues`) keeps the live
   * worklist: there the held chains are current, and the induction holds.
   *
   * POD-4707 send-back (H3 seed 1 snapshot 1: i1093/i1182/i1691/i2141): the
   * visible closure is not enough. A hidden formal parent related to no
   * visible row — hidden itself, ancestor of no visible row, owner of none —
   * is outside it, so its formal children stay unfiled and its progress
   * reads solo while the direct rebuild composes over its bucket. But any
   * resident row's view can be read (`view()` is React's getSnapshot and
   * must stay a pure read: no read-path filing), and the review probe reads
   * every resident's. So every KNOWN formal parent roots as well — bucket
   * probe only, no row read, residency-independent so the lazy and
   * all-resident arms file the same closure — with its ancestors and formal
   * subtree. What it adds over the visible closure is exactly hidden
   * parents and their hidden subtrees; top-level hidden leaves stay out.
   * Returns both closures: filings follow `formal`, member cells follow
   * `visible` (a hidden resident holds no member cell — eager construction
   * held one per resident issue).
   */
  private replaceClosure(): { visible: Set<string>; formal: Set<string> } {
    const { partsOf, rowOf } = this.plainScope()
    const held = (_id: string): boolean => false
    const roots: string[] = []
    const formalRoots: string[] = []
    for (const id of knownIssueIds(this)) {
      const parts = partsOf(id)
      if (parts.present || parts.keeps) {
        roots.push(id)
        continue
      }
      if (this.engine.members('issue', id, 'children').size > 0) formalRoots.push(id)
      const parent = this.engine.forward('issue', id, 'parent')
      if (parent !== null && held(parent)) roots.push(id)
    }
    const visible = this.expandRoots(roots, partsOf, rowOf, held)
    const formal = this.expandRoots([...roots, ...formalRoots], partsOf, rowOf, held)
    return { visible, formal }
  }

  /**
   * POD-4707 — the lazy closure over one commit's deltas, with the rows
   * that left. Every touched KNOWN issue joins unconditionally — resident
   * or cold: a cold row's filings self-heal edge moves through their own
   * cells, while gating it instead would leave a re-added cold row
   * unfiled (or a reparented one filed stale) with no held reader to
   * notice. Plus the issues a touched session or worktree can show
   * (explicit owner, lane) gated by the plain pass — present, keeping, or
   * filed under a held parent. Anything else has no held reader, so
   * building it would only commit filings. An explicit member warms its
   * cold owner through residency instead, so explicit cold rows stay out
   * (resident owners are still considered); a lane-only session never
   * warms, so cold lane rows are evaluated. Removals only hide. The
   * candidate set is a `Set`: no scan per member.
   */
  private updateClosure(deltas: readonly Delta[]): { closure: Set<string>; gone: string[] } {
    const named = new Set<string>()
    const candidates = new Set<string>()
    const gone: string[] = []
    const consider = (id: string): void => {
      if (!this.worklist.has(id) && this.tables.issue.has(id)) candidates.add(id)
    }
    const considerLane = (id: string): void => {
      if (!this.worklist.has(id)) candidates.add(id)
    }
    const considerLinkedSession = (sessionId: string): void => {
      const linked = this.sessionLinkedIssues(sessionId)
      if (linked.explicit !== null) consider(linked.explicit)
      for (const issueId of linked.lane) considerLane(issueId)
    }
    for (const delta of deltas) {
      if (
        (delta.kind === 'row' || delta.kind === 'residency' || delta.kind === 'coldRow') &&
        delta.entity === 'issue'
      ) {
        if (this.knowsIssue(delta.id)) named.add(delta.id)
        else gone.push(delta.id)
      } else if (delta.kind === 'row' && delta.entity === 'session') {
        if (this.tables.session.has(delta.id)) considerLinkedSession(delta.id)
      } else if (delta.kind === 'row' && delta.entity === 'worktree') {
        if (this.tables.worktree.has(delta.id)) {
          for (const issueId of this.engine.members('worktree', delta.id, 'issues'))
            considerLane(issueId)
        }
      } else if (delta.kind === 'coldRow' && delta.entity === 'session') {
        considerLinkedSession(delta.id)
      }
    }
    if (named.size === 0 && candidates.size === 0) return { closure: new Set(), gone }
    const { partsOf, rowOf } = this.plainScope()
    const roots = [...named]
    for (const id of candidates) {
      const parts = partsOf(id)
      if (parts.present || parts.keeps) {
        roots.push(id)
        continue
      }
      const parent = this.engine.forward('issue', id, 'parent')
      if (parent !== null && this.worklist.has(parent)) roots.push(id)
    }
    if (roots.length === 0) return { closure: new Set(), gone }
    return { closure: this.expandRoots(roots, partsOf, rowOf), gone }
  }

  /**
   * POD-4707 — admit every resident closure member (held ones skip free;
   * raw doors, no fence). The order handler then places exactly the ids
   * whose `visible` or `rank` cell moved.
   *
   * POD-4706: the whole closure goes in, not just the resident members, so
   * a member cell for a row that is no longer resident is dropped. A
   * `replace` evicts resident-but-cold rows; without this their grown-phase
   * member cells would linger (the order ignores them — an unplaced member
   * never moves — but they and the rank reads they pull keep heap a fresh
   * bootstrap never builds).
   *
   * POD-4707 send-back: at a `replace` the caller passes the visible
   * closure, not the formal one — hidden formal parents hold filings (so
   * their progress composes) but no member cell.
   */
  private admitClosure(closure: ReadonlySet<string>): void {
    this.worklist.admit(closure, (id) => this.tables.issue.has(id))
  }

  /**
   * POD-4707 — file and admit the closure of touched rows (the write
   * layer's pending display touches rows only derivations read: a row
   * without filing or member cells would never follow its pending
   * verdict — the MobX arm's overlay gap, POD-4705). Idempotent: held
   * rows skip free. No flush: the caller drains.
   */
  ensureIssues(ids: Iterable<string>): void {
    const roots: string[] = []
    for (const id of ids) if (this.knowsIssue(id)) roots.push(id)
    if (roots.length === 0) return
    const { partsOf, rowOf } = this.plainScope()
    const closure = this.expandRoots(roots, partsOf, rowOf)
    this.rollup.sync(closure)
    this.admitClosure(closure)
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
   * through the feed, in ONE commit. The window's timer calls this; the
   * harness drains it in a loop before it reads.
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

  // --------------------------------------------------------------- writes

  /** One feed publication: ingest all of it, then one commit. */
  apply(event: RowSourceEvent): void {
    const out = ingestOut()
    this.engine.begin()
    if (event.type === 'replace') {
      const pins = this.writePins
      reseed(
        this.target,
        event.rows,
        out,
        this.residency ?? undefined,
        pins.size === 0 ? undefined : (entity, id) => entity === 'issue' && pins.has(id),
      )
      this.clearCachesForReplace()
    } else {
      for (const record of event.rows) ingestRecord(this.target, record, out)
      // POD-4745: a lane member that can now keep a cold owner shown warms it.
      this.residency?.settleLanes(this.target, out)
    }
    this.commitIngest(out, event.type === 'replace')
  }

  /**
   * POD-4706 — drop every per-row derived cache before a `replace` commits,
   * so the commit rebuilds deterministically from the new slice: exactly as
   * a fresh bootstrap over the same slice builds, whose caches start empty.
   * Tables, residency, the engine and locals are already the new slice's
   * (reseed ran first); only derived caches go — row views and their parts,
   * session activity cells, records, the visible collection (members, ranks,
   * parts, order), the roll-up filings/nodes/verdicts, the group
   * placements/layout, and the queued loads. Placement by rule already
   * evicted what the rule calls cold and the residency deltas already
   * reported it; what stays resident re-derives below. Pins survive: a
   * pending edit still holds its row. Disposing a cell unlinks it from every
   * index it read and dirties its readers, so nothing below reads stale
   * entries; every door re-creates on next read.
   */
  private clearCachesForReplace(): void {
    for (const cells of this.issues.values()) cells.dispose()
    this.issues.clear()
    for (const cell of this.sessionCells.values()) this.graph.dispose(cell)
    this.sessionCells.clear()
    for (const entity of ENTITIES) this.records[entity].clear()
    this.worklist.clear()
    this.rollup.clear()
    this.groups.clear()
    this.residency?.dropQueued()
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
    this.writePins.clear()
    this.pendingOverlays.clear()
    this.pendingReaders.clear()
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
    // Handler 2b: the roll-ups. POD-4707: filings follow the lazy closure,
    // never the corpus. A `replace` computes the closure in one plain pass
    // over every known issue and files exactly it (held outsiders leave);
    // an update files the closure of what it touched and unfiles what
    // left. The drain then runs the new and moved filings.
    if (fullSync) {
      const { visible, formal } = this.replaceClosure()
      this.rollup.syncReplace(formal, knownIssueIds(this))
      this.admitClosure(visible)
      for (const id of this.worklist.heldMemberIds()) {
        if (!formal.has(id)) {
          this.worklist.forgetIssue(id)
          this.groups.forgetIssue(id)
        }
      }
    } else {
      const { closure, gone } = this.updateClosure(deltas)
      if (closure.size > 0 || gone.length > 0) {
        this.rollup.sync([...closure, ...gone])
        this.admitClosure(closure)
      }
    }
    this.graph.flush()
    // Handler 3: the worklist. The commit's resident closure members hold
    // their `visible` cell (admitted above: a resident one gets its cell,
    // read once, and a gone one loses it), then the order places exactly
    // the ids whose `visible` or `rank` cell moved.
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
