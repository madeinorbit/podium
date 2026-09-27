/**
 * POD-4565 (Ma1) — the MobX pool: one per principal. Entity tables from the
 * declared schema (`tables.ts`), models built on first access (`models.ts`),
 * row views (`views.ts`), and the locals as tracked state (selection as a
 * one-entry map, the clock as deadlines, `clock.ts`).
 *
 * WRITE PATH. `apply(event)` is one `runInAction`: an `update` ingests each
 * record (`ingestRecord`; the same object is a no-op, `undefined` removes);
 * a `replace` reseeds every table in the same action (`reseed`,
 * `enumerate.ts`), so no observer sees a half-installed pool. Removed rows
 * drop their model. `applyLocals` is the other action: a click moves two
 * selection keys, a tick fires the deadlines it crosses.
 *
 * RELATIONS (POD-4566, `relations.ts`). Every table write inside that action
 * tells the relation engine, which maintains every declared relation from
 * the schema; the action ends with one `flush`, which applies each touched
 * bucket's net moves once, one element per member added or removed.
 * `indexUpdates` counts the relation slots written, `counters.bucketElements`
 * the bucket elements touched (M3 F1).
 *
 * RESIDENCY (POD-4567, `residency.ts`). With a per-row read (`lazy.load`, the
 * feed's `RowSource.row`), rows the schema lets be cold (closed issues and
 * their sessions) never enter the tables: ingest registers their ids and the
 * relation engine links them. A derivation that reaches one through a lazy
 * relation gets `loading` and queues it; the 50 ms window's batch installs
 * every queued row in ONE action (`hydrate`). `snapshot()` settles the loader
 * before it answers. Without `lazy` every row is resident (Ma1/Ma2 tests).
 *
 * READ PATH. Every table read goes through the reads fence
 * (`reads.wrapTables`), every relation read through `reads.wrapRelations`;
 * with the fence disabled both are the identity. Derivations run lazily: a
 * row view computes when a mounted row (or `snapshot()`) reads it and
 * suspends when nothing does (no `keepAlive`).
 *
 * STATS (`README.md` has the definitions): `rowsDerived` counts row-view
 * body runs; `notifications` counts actions that changed pool state;
 * `indexUpdates` counts relation slots written (forward entries and
 * buckets; `counters.bucketElements` the elements inside them);
 * `rollupsDerived` counts runs of the two roll-up compositions (Mb3,
 * `worklist/rollup.ts`: a node's attention `aggregate` and its `unitsBelow`).
 * The pool's own counters are in `counters`.
 */

import './enforce'
import {
  autorun,
  computedStruct,
  type IObservableArray,
  type IObservableValue,
  makeObservable,
  type ObservableMap,
  observable,
  runInAction,
} from 'mobx'
import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import { sliceRowOf } from '../../../shared/src/row-view'
import { type EntityName, type ModelSchema, SCHEMA } from '../../../shared/src/schema'
import type {
  LocalsKey,
  SliceIssue,
  SliceLocals,
  SliceSession,
  SliceSnapshot,
} from '../../../shared/src/slice-types'
import type { ArmStats, RowSourceEvent } from '../../../shared/src/stats'
import { DeadlineClock } from './clock'
import { issueIdsOf, knownIssueIds, reseed } from './enumerate'
import { type EntityModel, MODEL_CLASSES, type ModelOf, type SessionModel } from './models'
import { PoolRelations, type ReadableTables } from './relations'
import { type LoadRow, Residency, type Schedule } from './residency'
import {
  createObservableTables,
  ENTITIES,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  type PoolTables,
} from './tables'
import type { RepoRow, ViewInputs } from './views'
import { sliceOrderOf, WorklistGroups } from './worklist/groups'
import { LOADING, type Loaded } from './worklist/rollup'
import {
  directNested,
  directSessionVisibility,
  directVisibility,
  type IssueVisibility,
  readAtOf,
  standingOf,
  VisibleCollection,
  type VisibleCounters,
  type VisibleInputs,
} from './worklist/visible'

/** The pool's own counters, beside the shared `ArmStats`. */
export interface PoolCounters extends VisibleCounters {
  /** Models built (first access). Zero after bootstrap until something reads. */
  modelsCreated: number
  /** Table slots written (set to a different object, or deleted). */
  tableWrites: number
  /** Rows removed (evict or remove), each with its model dropped. */
  rowsRemoved: number
  /**
   * Relation bucket ELEMENTS touched: each member added to or removed from a
   * bucket, and each member moved when a cold bucket turns resident (M3 F1).
   * `indexUpdates` counts slots; this counts the work inside them.
   */
  bucketElements: number
}

export type PoolStats = ArmStats & { readonly counters: PoolCounters }

/**
 * POD-4678 (item 2): lower bound by id in a sorted seat list (default
 * `.sort()` order, UTF-16 code units via `<`): first index with
 * `list[i] >= id`. Insert there to keep id order; remove there when it holds
 * `id`. Family-small: binary search + splice shifting is trivial.
 */
function sortedIndex(list: { readonly length: number; readonly [i: number]: string }, id: string): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] as string) < id) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** POD-4678 (item 2): no seats (shared frozen, never written; `seatList` absent case). */
const EMPTY_SEAT_LIST: readonly string[] = Object.freeze([])

function createStats(residency: Residency | null): PoolStats {
  const counters: PoolCounters = {
    modelsCreated: 0,
    tableWrites: 0,
    rowsRemoved: 0,
    bucketElements: 0,
    issueNodes: 0,
    sessionNodes: 0,
    orderSorts: 0,
    orderElements: 0,
    membershipFlips: 0,
    groupRuns: 0,
    groupElements: 0,
  }
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
      counters.modelsCreated = 0
      counters.tableWrites = 0
      counters.rowsRemoved = 0
      counters.bucketElements = 0
      counters.issueNodes = 0
      counters.sessionNodes = 0
      counters.orderSorts = 0
      counters.orderElements = 0
      counters.membershipFlips = 0
      counters.groupRuns = 0
      counters.groupElements = 0
      if (residency !== null) {
        const r = residency.counters
        r.coldWrites = 0
        r.requests = 0
        r.batches = 0
        r.hydrated = 0
        r.warmed = 0
      }
    },
  }
  return stats
}

/** JSON-ish equality for one row field (a mark-read arrives as new identities for nothing it changes). */
function fieldEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => fieldEqual(item, b[index]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (key) =>
      Object.hasOwn(b, key) &&
      fieldEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/**
 * Whether the hot issue update `previous` → `next` moves only the read
 * cursor: the cursor differs (as a value) and every other field is equal.
 * Content-equal, so a new identity for an unchanged `deps` array still
 * counts; a new value anywhere else does not.
 */
function cursorOnlyChange(previous: object, next: object): boolean {
  const a = previous as Record<string, unknown>
  const b = next as Record<string, unknown>
  if (Object.is(a['readAt'], b['readAt'])) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('readAt')
  for (const key of keys) {
    if (!fieldEqual(a[key], b[key])) return false
  }
  return true
}

/** Residency options: the per-row read, and (tests) the window and timer. */
export interface PoolLazyOptions {
  readonly load: LoadRow
  readonly windowMs?: number
  readonly schedule?: Schedule
}

/** Where a row stands, for a reader that asked for it by id (tracked). */
export type Residence = 'resident' | 'loading' | 'absent'

/** A lazy collection read: the members in memory, and how many are on their way. */
export interface LazyMembers {
  readonly ready: readonly string[]
  readonly pending: number
}

/** Settle rounds before `snapshot()` gives up (a load that never lands). */
const MAX_SETTLE_ROUNDS = 64

/**
 * Run `read` inside a transient reaction and return its result, so reads made
 * outside any reaction (the harness's `snapshot()`) are tracked reads and
 * never trip `computedRequiresReaction` / `observableRequiresReaction`.
 */
export function tracked<T>(read: () => T): T {
  let result: { value: T } | null = null
  let failure: { error: unknown } | null = null
  const stop = autorun(() => {
    try {
      result = { value: read() }
    } catch (error) {
      // Rethrown to the caller below; inside the reaction MobX would log it
      // and the caller would see only a missing result.
      failure = { error }
    }
  })
  stop()
  if (failure !== null) throw (failure as { error: unknown }).error
  if (result === null)
    throw new Error('[pool] tracked() ran inside a batch; read after the action ends')
  return (result as { value: T }).value
}

export class MobxPool {
  /** The raw tables (writes only; the copy sweep reaches the pool through them). */
  readonly tables: PoolTables
  /** The same tables through the reads fence: every read in the pool goes here. */
  readonly fenced: PoolTables
  readonly relations: RelationReader
  /** The relation engine itself (tests read its write record; unfenced). */
  readonly graph: PoolRelations
  /** The selection local: at most one entry, the selected issue id. */
  readonly selection: ObservableMap<string, true>
  /**
   * The read-state lane (POD-4686): each known issue's read cursor, per-key
   * tracked, readable by id only. A mark-read writes one key; only that row's
   * `unread` (and a decay row's `flat`) re-runs. Uncounted by the reads fence
   * by design: it is derived state populated from the row the update arrived
   * on (counted there), read like a cached computed.
   */
  readonly readStates: ObservableMap<string, string | null>
  readonly clock: DeadlineClock
  readonly inputs: ViewInputs
  /** What the visibility parts read (POD-4569, `worklist/visible.ts`). */
  readonly visibleInputs: VisibleInputs
  /** The visible collection and its order (POD-4569). */
  readonly worklist: VisibleCollection
  /** The groups and closed folds over that order (POD-4570). */
  readonly groups: WorklistGroups
  /** `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch). */
  readonly foldLatch: IObservableValue<boolean>
  readonly stats: PoolStats
  /** Residency (POD-4567); null when the pool holds every row. */
  readonly residency: Residency | null
  private readonly models: { readonly [E in EntityName]: Map<string, EntityModel> }
  private readonly target: IngestTarget
  private selectedId: string | null
  /**
   * POD-4678 — clears the maintained seat mirror (a closure over it, so the
   * copy sweep never walks the mirror: it holds only ids, never rows).
   * Functions are skipped by the sweep; closures stay a review item.
   */
  private readonly clearSeats: () => void

  constructor(
    readonly reads: ReadFence,
    locals: SliceLocals,
    schema?: ModelSchema,
    lazy?: PoolLazyOptions,
  ) {
    this.tables = createObservableTables()
    this.fenced = reads.wrapTables(this.tables)
    const fenced = this.fenced
    const residency =
      lazy === undefined
        ? null
        : new Residency({
            schema: schema ?? SCHEMA,
            hot: fenced,
            load: lazy.load,
            // Read at ingest, after the constructor has built the clock.
            now: () => this.clock.current,
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
          })
    this.residency = residency
    this.stats = createStats(residency)
    const stats = this.stats
    /**
     * POD-4678 (sent back items 1-2) — the explicit seats (`issue.sessions`),
     * maintained SORTED from the relation's own bucket deltas (one element
     * per move: binary search + splice at its id-order position, never the
     * family). The rule is declared once in the schema (`issue.sessions`);
     * this mirror follows the engine's delta in the same action. Held in a
     * closure (not a field) so the copy sweep never walks it: it holds only
     * ids, never rows (closures stay a review item).
     *
     * TWO DOORS (item 1 vs item 2):
     * - `seats(id)` (fenced, below): every yielded id counts as a relation
     *   read, exactly as `many()` yields do. `[...seats].sort()` (the landed
     *   code verbatim) re-reads the whole family here: over budget (true
     *   state). The plant uses it and must FAIL #10 at both scales.
     * - `seatList(id)` (unfenced, below): the maintained SORTED array itself,
     *   returned without iterating it. A membership change yields the new
     *   member only: O(1) for real. `seatIdsPartOf` / `sessionIdsPartOf` read
     *   it, never `seats()` nor `many()`.
     */
    const seats = observable.map<string, IObservableArray<string>>(undefined, {
      deep: false,
      name: 'pool.seats',
    })
    this.clearSeats = () => {
      seats.clear()
    }
    // The engine sees every KNOWN row: a resident one in its table, a cold one
    // by id (read back through the feed only when the engine needs its fields).
    const known =
      residency === null
        ? fenced
        : (Object.fromEntries(
            ENTITIES.map((entity) => [
              entity,
              {
                get: (id: string) => fenced[entity].get(id) ?? residency.read(entity, id),
                has: (id: string) => fenced[entity].has(id) || residency.known(entity, id),
              },
            ]),
          ) as ReadableTables)
    this.graph = new PoolRelations({
      tables: known,
      probe: this.tables,
      reads,
      ...(schema === undefined ? {} : { schema }),
      onWrite: (slots) => {
        stats.indexUpdates += slots
      },
      onElements: (elements) => {
        stats.counters.bucketElements += elements
      },
      // POD-4678 (item 2): file the explicit seat delta (one element) into
      // the maintained SORTED list, in the same action that moved the bucket:
      // binary search by id (default `.sort()` order, UTF-16 code units) +
      // splice at its position. No per-session reactions; the schema declares
      // the rule once. Family-small (2-3 ids): splice shifting is trivial.
      onBucket: (collection, target, member, added) => {
        if (collection !== 'issue.sessions') return
        if (added) {
          let list = seats.get(target)
          if (list === undefined) {
            list = observable.array<string>([], {
              deep: false,
              name: 'pool.seats.bucket',
            })
            seats.set(target, list)
          }
          list.splice(sortedIndex(list, member), 0, member)
        } else {
          const list = seats.get(target)
          if (list === undefined) return
          const at = sortedIndex(list, member)
          if (at < list.length && list[at] === member) list.splice(at, 1)
          if (list.length === 0) seats.delete(target)
        }
      },
      ...(residency === null
        ? {}
        : {
            cold: {
              // Through the fence (M3 N4): a presence probe is a counted read.
              resident: (entity: EntityName, id: string) =>
                !residency.capable(entity) || fenced[entity].has(id),
              observe: (entity: EntityName, id: string) => {
                residency.known(entity, id)
              },
              changed: (entity: EntityName, id: string) => residency.notify(entity, id),
            },
          }),
    })
    this.relations = reads.wrapRelations(this.graph)
    this.selection = observable.map<string, true>(undefined, {
      deep: false,
      name: 'pool.selection',
    })
    this.readStates = observable.map<string, string | null>(undefined, {
      deep: false,
      name: 'pool.reads',
    })
    this.clock = new DeadlineClock(locals.coarseNow)
    this.models = Object.fromEntries(
      ENTITIES.map((entity) => [entity, new Map()]),
    ) as MobxPool['models']
    this.target = {
      read: this.fenced,
      write: this.tables,
      relations: this.graph,
      volatile: {
        absorbIssueRead: (id, previous, next) => {
          if (!cursorOnlyChange(previous, next)) return false
          this.readStates.set(id, readAtOf((next as { readAt?: unknown }).readAt))
          return true
        },
        setIssueRead: (id, row) => {
          this.readStates.set(id, readAtOf((row as { readAt?: unknown }).readAt))
        },
        removeIssueRead: (id) => {
          this.readStates.delete(id)
        },
      },
      ...(residency === null ? {} : { residency }),
    }
    this.selectedId = null
    this.inputs = {
      relations: this.relations,
      issue: (id) => fenced.issue.get(id) as SliceIssue | undefined,
      session: (id) => fenced.session.get(id) as SliceSession | undefined,
      // The member's cached value. A model already built is taken from the
      // identity memo without a presence read: it reads its own slot, so a
      // removed member answers null, and the bucket that listed it has moved.
      sessionActivity: (id) =>
        ((this.models.session.get(id) as SessionModel | undefined) ?? this.model('session', id))
          ?.activityMs ?? null,
      repo: (id) => fenced.repo.get(id) as RepoRow | undefined,
      present: (entity, id) => fenced[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      parts: (id) => this.issue(id),
      rollup: (id) => this.worklist.issue(id)?.rollup,
      retainedSeats: (id) => this.worklist.issue(id)?.retainedSeatIds ?? [],
      // POD-4678 (sent back item 1, plant/old): the mirror IS the relation —
      // every id it yields counts, exactly as `many()` yields do.
      // `[...seats].sort()` (landed code verbatim) re-reads the whole family
      // here: over budget (true state). The plant uses it and must FAIL #10.
      // Closure-held (never walked by the copy sweep: ids only, never rows).
      seats: (id) => ({
        *[Symbol.iterator](): Generator<string> {
          const list = seats.get(id)
          if (list === undefined) return
          for (const member of list) {
            reads.touch('session', member, 'relation')
            yield member
          }
        },
      }),
      // POD-4678 (item 2, O(1) real): the maintained SORTED list itself,
      // returned without iterating it. A membership change yields the new
      // member only (its own row reads, already counted there); the family
      // is never yielded here, so never counted. Closure-held, ids only.
      seatList: (id) => seats.get(id) ?? EMPTY_SEAT_LIST,
      selected: (id) => this.selection.has(id),
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    this.visibleInputs = {
      relations: this.relations,
      issueRow: (id) =>
        (fenced.issue.get(id) ?? this.coldRow('issue', id)) as SliceIssue | undefined,
      sessionRow: (id) =>
        (fenced.session.get(id) ?? this.coldRow('session', id)) as SliceSession | undefined,
      issue: (id) => this.worklist.issue(id),
      session: (id) => this.worklist.session(id),
      passed: (t) => this.clock.passed(t),
      reached: (t) => this.clock.reached(t),
      loadedIssue: (id) => this.loaded('issue', id) as Loaded<SliceIssue>,
      loadedSession: (id) => this.loaded('session', id) as Loaded<SliceSession>,
      // Option A (POD-4571): progress reads a cold child through `coldRow`, never loading it.
      progressFacts: (id) => this.visibleInputs.issueRow(id),
      issueRead: (id) => this.readStates.get(id),
      nested: (id) => this.worklist.nested(id),
      formalChildren: (id) => this.worklist.formalChildren(id),
      // POD-4678 (item 1, plant/old): the mirror IS the relation — every id
      // yielded counts, exactly as `many()` yields do. Spread + sort
      // (`[...seats].sort()`, landed code verbatim) re-reads the whole family:
      // over budget (true state). The plant uses it and must FAIL #10.
      // Closure-held (never walked by the copy sweep: ids only, never rows).
      seats: (id) => ({
        *[Symbol.iterator](): Generator<string> {
          const list = seats.get(id)
          if (list === undefined) return
          for (const member of list) {
            reads.touch('session', member, 'relation')
            yield member
          }
        },
      }),
      // POD-4678 (item 2, O(1) real): the maintained SORTED list itself,
      // returned without iterating it — a membership change yields the new
      // member only. `seatIdsPartOf` reads it, never `seats()` nor `many()`.
      seatList: (id) => seats.get(id) ?? EMPTY_SEAT_LIST,
      counted: () => {
        stats.rollupsDerived += 1
      },
    }
    this.worklist = new VisibleCollection({
      visibleInputs: this.visibleInputs,
      counters: stats.counters,
      filePlacement: (id, placement) => this.groups.file(id, placement),
    })
    this.foldLatch = observable.box(locals.selectedIssueWasFolded === true, {
      name: 'pool.foldLatch',
    })
    this.groups = new WorklistGroups({
      order: () => this.worklist.order,
      node: (id) => this.worklist.issue(id),
      // At most one entry (`select`): the key walk is the selection itself.
      selectedId: () => this.selection.keys().next().value ?? null,
      foldLatch: () => this.foldLatch.get(),
      counters: stats.counters,
    })
    makeObservable<MobxPool, 'models' | 'target' | 'selectedId' | 'select' | 'syncWorklist' | 'clearSeats'>(this, {
      tables: false,
      fenced: false,
      relations: false,
      graph: false,
      selection: false,
      readStates: false,
      clock: false,
      inputs: false,
      visibleInputs: false,
      worklist: false,
      groups: false,
      foldLatch: false,
      coldRow: false,
      loaded: false,
      knows: false,
      stats: false,
      models: false,
      target: false,
      selectedId: false,
      clearSeats: false,
      reads: false,
      residency: false,
      residentIssueIds: false,
      resident: false,
      lazyMany: false,
      hydrate: false,
      settleLoads: false,
      pendingLoads: false,
      issueIds: computedStruct,
      model: false,
      issue: false,
      modelCount: false,
      apply: false,
      applyLocals: false,
      snapshot: false,
      dispose: false,
      select: false,
      syncWorklist: false,
    })
    runInAction(() => this.select(locals.selectedIssueId))
    residency?.onDue(() => this.hydrate())
  }

  /**
   * TRACKED: a COLD row's current value, read by id through the feed and
   * counted as a read (POD-4569): the visibility parts answer a closed
   * issue without loading it. Tracked by residency's per-id atom, which
   * reports every relink. Undefined when the row is not cold.
   */
  coldRow(entity: EntityName, id: string): object | undefined {
    const residency = this.residency
    if (residency === null || !residency.known(entity, id)) return undefined
    this.reads.touch(entity, id, 'get')
    return residency.read(entity, id)
  }

  /**
   * TRACKED: a RESIDENT row, or `LOADING` when the row is cold (the read
   * queues its load, as `resident` does), or undefined. The roll-ups read
   * rows only this way (Mb3): a cold row is a pending marker, never read.
   */
  loaded(entity: EntityName, id: string): Loaded<object> {
    const row = this.fenced[entity].get(id)
    if (row !== undefined) return row as object
    return this.residency?.loading(entity, id) === true ? LOADING : undefined
  }

  /** Whether the pool knows the issue `id`, hot or cold (plain: maintenance, inside actions). */
  knows(id: string): boolean {
    return this.tables.issue.has(id) || this.residency?.isCold('issue', id) === true
  }

  /** Every RESIDENT issue id, in table order. Re-derived only when membership changes. */
  get issueIds(): readonly string[] {
    return issueIdsOf(this)
  }

  /** The model of a row in the pool, built on first access; undefined when absent (tracked). */
  model<E extends EntityName>(entity: E, id: string): ModelOf[E] | undefined {
    if (!this.fenced[entity].has(id)) return undefined
    const models = this.models[entity]
    let model = models.get(id)
    if (model === undefined) {
      model = new MODEL_CLASSES[entity](id, this)
      models.set(id, model)
      this.stats.counters.modelsCreated += 1
    }
    return model as ModelOf[E]
  }

  issue(id: string): ModelOf['issue'] | undefined {
    return this.model('issue', id)
  }

  /**
   * TRACKED: where the row `entity:id` stands. A cold row answers `loading`
   * and is queued (first access); a reader renders that as loading, never as
   * an empty row.
   */
  resident(entity: EntityName, id: string): Residence {
    if (this.fenced[entity].has(id)) return 'resident'
    return this.residency?.loading(entity, id) === true ? 'loading' : 'absent'
  }

  /**
   * TRACKED: a lazy collection (Rule L) as its resident members plus the
   * count still loading, every cold one queued. The shape a roll-up reads
   * (Mb3): it derives from `ready` and reports loading while `pending > 0`.
   * `ready` is in bucket order, which is unordered (M3 F1).
   */
  lazyMany(from: EntityName, id: string, relation: string): LazyMembers {
    const to = this.graph.schema[from].relations[relation]?.to
    if (to === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
    const ready: string[] = []
    let pending = 0
    for (const member of this.relations.many(from, id, relation)) {
      if (this.fenced[to].has(member)) ready.push(member)
      else if (this.residency?.loading(to, member) === true) pending += 1
    }
    return { ready, pending }
  }

  /**
   * POD-4705 — the visibility parts over plain reads (call only inside an
   * action, where reads subscribe to nothing): the same part functions the
   * live nodes memoize (`directVisibility`), evaluated without building a
   * node, a reaction or a fence count. Hot rows come from the raw tables,
   * cold ones are never evaluated (a cold row is hidden by rule, and the
   * rebuild this mirrors stops at them the same way); relations come from
   * the raw engine; the read-state lane and the clock read as plain values.
   * Sessions recompute per read (pure functions of their row, no memo).
   *
   * `nested` is real when the caller passes the known ids (a `replace`'s one
   * sanctioned walk) and a loud stub otherwise: the per-change read set
   * (present/keeps/formalParent) never reaches the nest index, so a read
   * there means the read set grew and the scope must grow with it.
   * `formalChildren` answers from the parts' own children (what the live
   * filing mirrors); `seats` is unused since POD-4678 item 2
   * (`seatIdsPartOf` reads the maintained list).
   */
  private plainScope(knownIds: readonly string[] | null): {
    readonly partsOf: (id: string) => IssueVisibility
  } {
    const memo = new Map<string, IssueVisibility>()
    const partsOf = (id: string): IssueVisibility => directVisibility(plain, id, memo)
    let nested: ReadonlyMap<string, readonly string[]> | null = null
    const rawRelations: RelationReader = {
      one: (from, id, relation) => this.rawOne(from, id, relation),
      many: (from, id, relation) => this.rawMany(from, id, relation),
      size: (from, id, relation) => this.graph.size(from, id, relation),
    }
    const plain: VisibleInputs = {
      relations: rawRelations,
      issueRow: (id) =>
        (this.tables.issue.get(id) ?? this.residency?.read('issue', id)) as
          | SliceIssue
          | undefined,
      sessionRow: (id) =>
        (this.tables.session.get(id) ?? this.residency?.read('session', id)) as
          | SliceSession
          | undefined,
      // Hot rows only, exactly like the rebuild: a cold row reads as unknown
      // (hidden, keeping nothing), which is what a missing node answers live.
      issue: (id) => (this.tables.issue.has(id) ? partsOf(id) : undefined),
      session: (id) => directSessionVisibility(plain, id),
      issueRead: (id) => this.readStates.get(id),
      passed: (t) => this.clock.passed(t),
      reached: (t) => this.clock.reached(t),
      loadedIssue: (id) => {
        const row = this.tables.issue.get(id)
        if (row !== undefined) return row as SliceIssue
        return this.residency?.isCold('issue', id) === true ? LOADING : undefined
      },
      loadedSession: (id) => {
        const row = this.tables.session.get(id)
        if (row !== undefined) return row as SliceSession
        return this.residency?.isCold('session', id) === true ? LOADING : undefined
      },
      progressFacts: (id) => plain.issueRow(id),
      nested: (id) => {
        if (knownIds === null) {
          throw new Error('[pool] plain pass read the nest index on a per-change scope')
        }
        nested ??= directNested(knownIds, partsOf)
        return nested.get(id) ?? []
      },
      formalChildren: (id) => partsOf(id).childIds,
      seats: () => [],
      seatList: (id) => this.inputs.seatList(id),
      counted: () => {},
    }
    return { partsOf }
  }

  /**
   * POD-4705 — an issue's own row, hot or cold (call in-action): the raw
   * table first, the feed by id second. A field read on it is free when the
   * row arrived on this action's event (the pool stores the event's own
   * object, already touched) and one cold feed read at most otherwise.
   */
  private issueRowOf(id: string): SliceIssue | undefined {
    return (this.tables.issue.get(id) ?? this.residency?.read('issue', id)) as
      | SliceIssue
      | undefined
  }

  /**
   * POD-4705 — expand `roots` to the lazy node closure (call in-action),
   * returned as a plain array (arrays count nothing; sets and maps do):
   * each root's ancestor chain by raw `parentId` (the same field the nest
   * walk follows, through any issue), the started-by owner of a parentless
   * started-by root, then every formal subtree under the union. Ancestors
   * are noded even when cold: the nest walk passes THROUGH a hidden parent
   * to the grandparent, so a missing node would stop it early. Formal
   * descendants are noded even when hidden: the parent's progress composes
   * over their cached units. Every root verifies its first hop (so a
   * reparented held row picks up its new parent); the walk stops at a
   * pre-existing held chain (complete by induction) and at unknown ids; it
   * reads rows, never tables, and builds no observable.
   */
  private expandRoots(
    roots: readonly string[],
    partsOf: (id: string) => IssueVisibility,
  ): string[] {
    const closure: string[] = []
    const visit = (id: string): boolean => {
      if (closure.includes(id) || !this.knows(id)) return false
      closure.push(id)
      return true
    }
    for (const root of roots) {
      // Every root verifies its first hop (one row read, free when the row
      // arrived on this action's event), so a reparented held row still
      // picks up its new parent; the walk stops at a pre-existing held
      // chain (complete by induction) and at unknown ids. Membership in the
      // closure strictly grows per step, so adversarial parent cycles end.
      let current: string | null = root
      let first = true
      while (current !== null) {
        const id = current
        if (!this.knows(id)) break
        const held = this.worklist.has(id)
        if (held && !first) break
        if (!held && !visit(id)) break
        const row = this.issueRowOf(id)
        if (row === undefined) break
        const standing = standingOf(row)
        if (standing.parentId !== null) {
          current = standing.parentId
        } else if (standing.startedBy !== null && this.tables.issue.has(id)) {
          // Parentless with a starter: the present owner carries the nest.
          // Evaluated (hot rows only) for a member that needs it; anything
          // else holds its owner already, since a present row is always
          // noded. A cold member nests under nothing (hidden by rule).
          const owner = partsOf(id).nestParent
          current = owner
        } else {
          break
        }
        first = false
      }
    }
    // Formal subtrees under unheld members only: a held member's subtree is
    // complete by the same induction. Unordered engine buckets, no copies.
    const below: string[] = closure.filter((id) => !this.worklist.has(id))
    for (let head = 0; head < below.length; head += 1) {
      const id = below[head] as string
      for (const child of this.rawMany('issue', id, 'children')) {
        if (this.knows(child) && visit(child)) below.push(child)
      }
    }
    return closure
  }

  /**
   * POD-4705 — the engine without the fence (call only inside an action).
   * `rawOne` is what `one` answers before its presence probe, residency
   * observation and fence count (presence is re-checked against the raw
   * tables instead); `rawMany` is the live bucket itself. Maintenance (the
   * linked-issue lookup and the plain pass) resolves through them and
   * filters by the pool's own knowledge; derivations keep reading the
   * fenced relations.
   */
  private rawOne(from: EntityName, id: string, relation: string): string | null {
    const target = this.graph.forwardTarget(from, id, relation)
    if (target === null) return null
    const to = this.graph.schema[from].relations[relation]?.to
    if (to === undefined) return null
    const resident = !this.residencyCapable(to) || this.tables[to].has(target)
    return resident ? target : null
  }

  /** Whether rows of `entity` can be cold (fence-free; `residency.capable`). */
  private residencyCapable(entity: EntityName): boolean {
    return this.residency?.capable(entity) === true
  }

  /**
   * The engine's buckets without the fence (maintenance only, post-flush):
   * the live unordered set, iterated in place — no copy, no sort. A missing
   * bucket probes residency through the fence (like any absent read); the
   * expansion runs it only where a node is genuinely being built.
   */
  private rawMany(from: EntityName, id: string, relation: string): Iterable<string> {
    return this.graph.many(from, id, relation)
  }

  /**
   * The issues a changed session can show (call in-action, post-flush): its
   * explicit owner and every issue checked out at its lane. Answered through
   * the raw engine without walking anything or counting a read.
   */
  private sessionLinkedIssues(sessionId: string): string[] {
    const linked = new Set<string>()
    const explicit = this.rawOne('session', sessionId, 'issue')
    if (explicit !== null && this.knows(explicit)) linked.add(explicit)
    const lane = this.rawOne('session', sessionId, 'worktree')
    if (lane !== null) {
      for (const issueId of this.rawMany('worktree', lane, 'issues')) {
        if (this.knows(issueId)) linked.add(issueId)
      }
    }
    return [...linked]
  }

  /**
   * Close the load window now: install every queued cold row, read by id
   * through the feed, in ONE action. The window's timer calls this; so does
   * `snapshot()` while settling.
   *
   * POD-4705: warming installs the feed's current value, which is what the
   * cold reads already answered, so no visibility flips here and no node
   * work follows. A row a change shows is warmed synchronously inside that
   * change's action (`apply`), where the closure covers it.
   */
  hydrate(): void {
    const residency = this.residency
    if (residency === null) return
    const batch = residency.take()
    if (batch.length === 0) return
    const out = ingestOut()
    this.graph.begin()
    runInAction(() => {
      for (const [entity, id] of batch) residency.hydrate(this.target, entity, id, out)
      this.graph.flush()
    })
    this.stats.counters.tableWrites += out.writes
    if (out.writes > 0 || out.volatile > 0) this.stats.notifications += 1
  }

  /**
   * Close the load window until nothing is queued: every queued row, and
   * every row those rows' installation queues in turn (G2: the fence's
   * `settleLoads`, inside the measured step). Returns the windows closed.
   */
  settleLoads(): number {
    const residency = this.residency
    if (residency === null) return 0
    let rounds = 0
    while (residency.hasQueued()) {
      if (rounds >= MAX_SETTLE_ROUNDS) {
        throw new Error(`[pool] loads did not settle in ${MAX_SETTLE_ROUNDS} load rounds`)
      }
      this.hydrate()
      rounds += 1
    }
    return rounds
  }

  /** Rows queued for a load and not yet landed (G2: the fence's `pendingLoads`). */
  pendingLoads(): number {
    return this.residency?.queued() ?? 0
  }

  /** Models currently held, per entity (tests: lifecycle). */
  modelCount(entity: EntityName): number {
    return this.models[entity].size
  }

  /** One feed publication, one action. */
  apply(event: RowSourceEvent): void {
    const out = ingestOut()
    this.graph.begin()
    runInAction(() => {
      if (event.type === 'replace') reseed(this.target, event.rows, out)
      else for (const record of event.rows) ingestRecord(this.target, record, out)
      this.graph.flush()
      this.syncWorklist(event)
    })
    for (const [entity, id] of out.removed) this.models[entity].delete(id)
    this.stats.counters.tableWrites += out.writes
    this.stats.counters.rowsRemoved += out.removed.length
    if (out.writes > 0 || out.cold > 0 || out.volatile > 0) this.stats.notifications += 1
  }

  /**
   * The visible collection's nodes follow the event (inside its action).
   * - a `replace` re-seeds them to the lazy closure: the plain pass
   *   evaluates every HOT known issue (the one whole walk, `knownIssueIds`)
   *   and nodes the present and keeping rows (visible implies present, so no
   *   placement chain runs at bootstrap) with their ancestors and formal
   *   subtrees — the only rows a derivation can read. Cold rows are hidden
   *   by rule and never evaluated.
   * - an update ensures the closure over what it named: every named issue
   *   (exactly as the eager collection did — a rename walks nothing, a
   *   reparent or re-add walks its raw chain), plus the issues a touched
   *   session can show (explicit owner, lane) and the lane of a touched
   *   worktree when the plain pass shows them (present or keeping) or their
   *   formal parent holds a node. Cold linked rows stay out (hidden by rule;
   *   warming makes them resident first, which re-includes them); removals
   *   only hide. A removed session drops its node; a removed issue leaves
   *   through `ensure`'s known check.
   */
  private syncWorklist(event: RowSourceEvent): void {
    const knows = (id: string) => this.knows(id)
    if (event.type === 'replace') {
      const knownIds = knownIssueIds(this)
      const { partsOf } = this.plainScope(knownIds)
      const roots: string[] = []
      for (const id of knownIds) {
        // Hot rows only: cold rows are hidden by rule, and evaluating them
        // would traverse (and count) rows no derivation will read.
        if (!this.tables.issue.has(id)) continue
        const parts = partsOf(id)
        if (parts.present || parts.keeps) roots.push(id)
      }
      this.worklist.syncReplace(this.expandRoots(roots, partsOf), knows)
      this.worklist.forgetSessions(
        (id) => this.tables.session.has(id) || this.residency?.isCold('session', id) === true,
      )
      return
    }
    const isColdIssue = (id: string): boolean => this.residency?.isCold('issue', id) === true
    const named: string[] = []
    const candidates: string[] = []
    const gone: string[] = []
    const consider = (id: string): void => {
      if (!this.worklist.has(id) && !isColdIssue(id) && !candidates.includes(id)) {
        candidates.push(id)
      }
    }
    for (const record of event.rows) {
      if (record.kind === 'issue') {
        if (record.value === undefined) gone.push(record.id)
        else if (!named.includes(record.id)) named.push(record.id)
      } else if (record.kind === 'session') {
        if (record.value === undefined) {
          this.worklist.forgetSession(record.id)
        } else {
          for (const issueId of this.sessionLinkedIssues(record.id)) consider(issueId)
        }
      } else if (record.kind === 'worktree' && record.value !== undefined) {
        for (const issueId of this.rawMany('worktree', record.id, 'issues')) {
          consider(issueId)
        }
      }
    }
    if (named.length === 0 && candidates.length === 0) {
      if (gone.length > 0) this.worklist.ensure(gone, knows)
      return
    }
    const { partsOf } = this.plainScope(null)
    // An unheld linked candidate earns a node when the plain pass shows it
    // (present or keeping — visible implies present) or when its FORMAL
    // parent holds one: a hidden row flips or lands under a held parent only
    // through these. The check is the where-filtered formal parent (what the
    // filing files), not the raw one: an archived row names a raw parent it
    // never files under. Anything else has no held reader, so building it
    // would only commit filings.
    const roots: string[] = [...named]
    for (const id of candidates) {
      const parts = partsOf(id)
      const parent = parts.formalParent
      if (
        parts.present ||
        parts.keeps ||
        (parent !== null && this.worklist.has(parent))
      ) {
        roots.push(id)
      }
    }
    if (roots.length === 0) return
    this.worklist.ensure([...this.expandRoots(roots, partsOf), ...gone], knows)
  }

  /** One locals notification, one action: only the keys it names. */
  applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    const selection = changed.has('selectedIssueId')
    const latch = changed.has('selectedIssueWasFolded')
    const clock = changed.has('coarseNow')
    if (!selection && !latch && !clock) return
    runInAction(() => {
      if (selection) this.select(locals.selectedIssueId)
      if (latch) this.foldLatch.set(locals.selectedIssueWasFolded === true)
      if (clock) this.clock.advance(locals.coarseNow)
    })
    this.stats.notifications += 1
  }

  /**
   * The slice output: every VISIBLE issue's row (POD-4569), grouped with
   * closed folds and no selection (POD-4570, `groups.layout`). Settled: a visible row that is cold is
   * asked for (it loads, as a drawn row does), and reading the rows queues
   * the cold rows they reach; those are loaded and the rows read again until
   * nothing is queued, as a reader that waits out its loading state would
   * see them.
   */
  snapshot(): SliceSnapshot {
    for (let round = 0; ; round += 1) {
      const snapshot = tracked(() => {
        const rowsById: SliceSnapshot['rowsById'] = {}
        for (const id of this.worklist.order) {
          const view = this.issue(id)?.view
          if (view === undefined) {
            this.resident('issue', id)
            continue
          }
          rowsById[id] = sliceRowOf(view)
        }
        return { order: sliceOrderOf(this.groups.layout), rowsById }
      })
      if (this.residency?.hasQueued() !== true) return snapshot
      if (round >= MAX_SETTLE_ROUNDS) {
        throw new Error(`[pool] snapshot() did not settle in ${MAX_SETTLE_ROUNDS} load rounds`)
      }
      this.hydrate()
    }
  }

  /** The resident issue ids (the rebuild's residency input). */
  residentIssueIds(): ReadonlySet<string> {
    return new Set(tracked(() => this.issueIds))
  }

  /** Empty every table, model cache, selection and clock registration. */
  dispose(): void {
    runInAction(() => {
      this.worklist.clear()
      this.groups.clear()
      for (const entity of ENTITIES) this.tables[entity].clear()
      this.graph.clear()
      this.clearSeats()
      this.selection.clear()
      this.readStates.clear()
    })
    for (const entity of ENTITIES) this.models[entity].clear()
    this.residency?.clear()
    this.clock.clear()
    this.selectedId = null
  }

  private select(id: string | null): void {
    if (id === this.selectedId) return
    if (this.selectedId !== null) this.selection.delete(this.selectedId)
    if (id !== null) this.selection.set(id, true)
    this.selectedId = id
  }
}
