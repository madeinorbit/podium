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
 * READ PATH. Every row a model, view, visibility part, roll-up or group
 * placement reads comes from ONE reader, `row(entity, id, absent)`
 * (POD-4743): the server row with the write layer's pending edits overlaid
 * (`WriteSeam`, the seam the write layer passes at construction), the server
 * object itself when nothing is pending, and for a row not in memory the
 * answer the caller names (`AbsentRead`: `LOADING` with its load queued,
 * `LOADING` alone, or its current value by id through the feed). Every table
 * read goes through the reads fence (`reads.wrapTables`), every relation read
 * through `reads.wrapRelations`; with the fence disabled both are the
 * identity. Derivations run lazily: a row view computes when a mounted row
 * (or `snapshot()`) reads it and suspends when nothing does (no `keepAlive`).
 *
 * STATS (`README.md` has the definitions): `rowsDerived` counts row-view
 * body runs; `notifications` counts actions that changed pool state;
 * `indexUpdates` counts relation slots written (forward entries and
 * buckets; `counters.bucketElements` the elements inside them);
 * `rollupsDerived` counts runs of the three roll-up compositions (Mb3,
 * `worklist/rollup.ts`: a node's attention `aggregate`, its `unitsBelow`,
 * and its `seatActivity`).
 * The pool's own counters are in `counters`.
 */

import './enforce'
import {
  autorun,
  compareStructural,
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
import {
  type EditPatch,
  type TxId,
  type WritableKind,
  WriteContractError,
} from '../../../shared/src/write-contract'
import { DeadlineClock } from './clock'
import { issueIdsOf, knownIssueIds, reseed } from './enumerate'
import { type EntityModel, type IssueModel, MODEL_CLASSES, type ModelOf, type SessionModel } from './models'
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
import { LOADING, type Loaded, type RollupInputs } from './worklist/rollup'
import {
  directNested,
  directSessionVisibility,
  directVisibility,
  type IssueVisibility,
  readAtOf,
  rollupInputsOf,
  standingOf,
  VisibleCollection,
  type VisibleCounters,
  type VisibleInputs,
} from './worklist/visible'

/** The pool's own counters, beside the shared `ArmStats`. */
export interface PoolCounters extends VisibleCounters {
  /** Models built (first access): the worklist's held issues and their sessions, and drawn rows. */
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
    if (!compareStructural(a[key], b[key])) return false
  }
  return true
}

/** Residency options: the per-row read, and (tests) the window and timer. */
export interface PoolLazyOptions {
  readonly load: LoadRow
  readonly windowMs?: number
  readonly schedule?: Schedule
  /**
   * Rows kept out of memory beside the schema's cold rule, until first read
   * (`ResidencyOptions.outOfMemory`). Tests use it to take the not-in-memory
   * path on a row the rule keeps resident (a visible one).
   */
  readonly outOfMemory?: (entity: EntityName, id: string) => boolean
}

/**
 * The write layer, as the pool sees it: the seam the write layer implements
 * and passes at construction (`write/overlay.ts`), so no reader is ever
 * replaced.
 * - `pending` is what the one reader lays over a row. TRACKED: it reads the
 *   entry for `entity:id` (present or not), so a derivation that read the row
 *   re-runs when its pending display changes. It holds only the pending
 *   fields, never a row.
 * - `edit` is a model's setter (`issue.title = x`, `issue.update(patch)`):
 *   one transaction of the write layer's edit log.
 */
export interface WriteSeam {
  /** The newest pending value per edited field of `entity:id`, or undefined when nothing is pending. */
  pending(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined
  /** One transaction: paint the patch at once, remember the prior values, send. */
  edit<K extends WritableKind>(entity: K, id: string, patch: EditPatch<K>): TxId
}

/**
 * What `MobxPool.row` answers for a row that is not in memory (a cold row):
 * - `load`: `LOADING`, and the row is queued for the next load window (a
 *   derivation's first access);
 * - `mark`: `LOADING`, nothing queued (maintenance inside an action, which
 *   must not arm the window);
 * - `peek`: the row's current value, read by id through the feed and counted,
 *   nothing queued (the visibility parts decide a cold row without loading it).
 * Unknown rows answer undefined in every mode.
 */
export type AbsentRead = 'load' | 'mark' | 'peek'

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
  /** What the visibility parts read (`worklist/visible.ts`). */
  readonly visibleInputs: VisibleInputs
  /** What the roll-up parts read (`worklist/rollup.ts`), over the visibility inputs. */
  readonly rollupInputs: RollupInputs
  /** The visible collection and its order. */
  readonly worklist: VisibleCollection
  /** The groups and closed folds over that order. */
  readonly groups: WorklistGroups
  /** `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch). */
  readonly foldLatch: IObservableValue<boolean>
  readonly stats: PoolStats
  /** Residency (POD-4567); null when the pool holds every row. */
  readonly residency: Residency | null
  /** The write layer (pending edits and model edits); null without one. */
  readonly writes: WriteSeam | null
  /** The one object per row, by entity: built on first request, never twice. */
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
    writes?: WriteSeam,
  ) {
    this.writes = writes ?? null
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
            ...(lazy.outOfMemory === undefined ? {} : { outOfMemory: lazy.outOfMemory }),
            // The rule's lane source (R3, POD-4745) reads the engine, built below.
            lanes: () => this.graph,
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
            onIssuelessJoin: (collection: string, _target: string, member: string) =>
              residency.laneJoined(collection, member),
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
    // Every row below comes from the one reader (`row`); none of these
    // functions is replaced after construction (the write layer's pending
    // edits arrive through `writes`). A view reads rows in memory: a row that
    // is not answers undefined, its load queued.
    const inMemory = (row: Loaded<object>): object | undefined => (row === LOADING ? undefined : row)
    this.inputs = {
      relations: this.relations,
      issue: (id) => inMemory(this.row('issue', id)) as SliceIssue | undefined,
      session: (id) => inMemory(this.row('session', id)) as SliceSession | undefined,
      // The member's cached stamp, while its row is in memory.
      sessionActivity: (id) => this.model('session', id)?.activityMs ?? null,
      repo: (id) => inMemory(this.row('repo', id)) as RepoRow | undefined,
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
      // Hot or cold: a cold row is read by id through the feed, never loaded.
      issueRow: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      sessionRow: (id) => this.row('session', id, 'peek') as SliceSession | undefined,
      issue: (id) => this.worklist.issue(id),
      session: (id) => this.object('session', id) as SessionModel,
      passed: (t) => this.clock.passed(t),
      reached: (t) => this.clock.reached(t),
      loadedIssue: (id) => this.row('issue', id) as Loaded<SliceIssue>,
      loadedSession: (id) => this.row('session', id) as Loaded<SliceSession>,
      // Option A (POD-4571): progress reads a cold child by id, never loading it.
      progressFacts: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      issueRead: (id) => this.readCursor(id),
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
    this.rollupInputs = rollupInputsOf(this.visibleInputs)
    this.worklist = new VisibleCollection({
      counters: stats.counters,
      issue: (id) => this.object('issue', id) as IssueModel,
      released: (id) => this.release('issue', id),
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
    makeObservable<
      MobxPool,
      | 'models'
      | 'target'
      | 'selectedId'
      | 'select'
      | 'syncWorklist'
      | 'clearSeats'
      | 'plainScope'
      | 'issueRowOf'
      | 'expandRoots'
      | 'rawOne'
      | 'residencyCapable'
      | 'rawMany'
      | 'sessionLinkedIssues'
      | 'ensureIssues'
      | 'object'
      | 'release'
    >(this, {
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
      writes: false,
      rollupInputs: false,
      object: false,
      release: false,
      edit: false,
      row: false,
      readCursor: false,
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
      // POD-4705: maintenance called inside actions, never observed.
      plainScope: false,
      issueRowOf: false,
      expandRoots: false,
      rawOne: false,
      residencyCapable: false,
      rawMany: false,
      sessionLinkedIssues: false,
      ensureIssues: false,
    })
    runInAction(() => this.select(locals.selectedIssueId))
    residency?.onDue(() => this.hydrate())
  }

  /**
   * TRACKED: THE row reader (POD-4743). Every row a model, view, visibility
   * part, roll-up or placement reads comes from here, so they all see one
   * value.
   *
   * In memory: the server row with the write layer's pending edits overlaid
   * (`WriteSeam`), or the server object itself when nothing is pending (same
   * identity, so an idle write layer adds no commit). The overlaid object is
   * transient, never stored; a reader subscribes to the table slot and the
   * overlay entry, never to it.
   *
   * Not in memory (cold, POD-4567): what `absent` names (`AbsentRead`). A
   * cold row's value is read by id through the feed and counted as a read
   * (POD-4569); it is tracked by residency's per-id atom, which reports every
   * relink and the load. Unknown rows answer undefined. Never blocks.
   */
  row(entity: EntityName, id: string, absent: 'peek'): object | undefined
  row(entity: EntityName, id: string, absent?: 'load' | 'mark'): Loaded<object>
  row(entity: EntityName, id: string, absent: AbsentRead = 'load'): Loaded<object> {
    let server = this.fenced[entity].get(id) as object | undefined
    if (server === undefined) {
      const residency = this.residency
      if (residency === null) return undefined
      if (absent === 'load') return residency.loading(entity, id) ? LOADING : undefined
      if (!residency.known(entity, id)) return undefined
      if (absent === 'mark') return LOADING
      this.reads.touch(entity, id, 'get')
      server = residency.read(entity, id)
      if (server === undefined) return undefined
    }
    const pending = this.writes?.pending(entity, id)
    return pending === undefined ? server : { ...server, ...pending }
  }

  /**
   * TRACKED: an issue's read cursor, pending mark-read first (the overlay's
   * `readAt`, an explicit null included), else the read-state lane (POD-4686:
   * server truth, per key, so a mark-read re-validates only its own row).
   */
  readCursor(id: string): string | null | undefined {
    const pending = this.writes?.pending('issue', id)
    if (pending !== undefined && pending['readAt'] !== undefined) {
      return pending['readAt'] as string | null
    }
    return this.readStates.get(id)
  }

  /** Whether the pool knows the issue `id`, hot or cold (plain: maintenance, inside actions). */
  knows(id: string): boolean {
    return this.tables.issue.has(id) || this.residency?.isCold('issue', id) === true
  }

  /** Every RESIDENT issue id, in table order. Re-derived only when membership changes. */
  get issueIds(): readonly string[] {
    return issueIdsOf(this)
  }

  /** The model of a row in memory, built on first request; undefined when absent (tracked). */
  model<E extends EntityName>(entity: E, id: string): ModelOf[E] | undefined {
    if (!this.fenced[entity].has(id)) return undefined
    return this.object(entity, id) as ModelOf[E]
  }

  /**
   * The one object of `entity:id`, built on first request, whether or not its
   * row is in memory (the worklist holds cold issues too; their visibility
   * reads the cold row by id). Untracked: an identity memo.
   */
  private object(entity: EntityName, id: string): EntityModel {
    const models = this.models[entity]
    let model = models.get(id)
    if (model === undefined) {
      model = new MODEL_CLASSES[entity](id, this)
      models.set(id, model)
      this.stats.counters.modelsCreated += 1
    }
    return model
  }

  /**
   * Forget the object of `entity:id` once nothing can ask for it again as
   * the same row: an issue neither in memory nor held by the worklist, a
   * session no longer known, any other row no longer in memory.
   */
  private release(entity: EntityName, id: string): void {
    if (this.tables[entity].has(id)) return
    if (entity === 'issue' && this.worklist.has(id)) return
    if (entity === 'session' && this.residency?.isCold('session', id) === true) return
    this.models[entity].delete(id)
  }

  /** A model's edit (`issue.title = x`): one transaction of the write layer's log. */
  edit<K extends WritableKind>(entity: K, id: string, patch: EditPatch<K>): TxId {
    if (this.writes === null) {
      throw new WriteContractError(`the pool has no write layer: cannot edit ${entity} ${id}`)
    }
    return this.writes.edit(entity, id, patch)
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
   * node or a reaction. Row reads go through the live inputs (fenced, and
   * projecting pending edits under the write arm), so the pass answers what
   * the nodes would; cold rows are never evaluated (a cold row reads as
   * hidden, exactly as a missing node does, and the rebuild this mirrors
   * stops at them the same way); relations come from the raw engine.
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
      // POD-4671: the maintained issueless set, engine-direct like size
      // (the plain pass counts nothing; both arms resolved in favour of both).
      issueless: (from, id, relation) => this.graph.issueless(from, id, relation),
    }
    // Row reads go through the one reader (fenced, and projecting pending
    // edits): the plain pass answers what the nodes would, including
    // optimism. Bootstrap counts nothing, and per-change evaluation runs
    // only where a node may genuinely be built.
    const live = this.visibleInputs
    const plain: VisibleInputs = {
      relations: rawRelations,
      issueRow: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      sessionRow: (id) => this.row('session', id, 'peek') as SliceSession | undefined,
      // Exactly what a live derivation reads: a held row's parts (hot or
      // cold — a cold ancestor's node carries the nest walk past it), else
      // unknown for hot rows without a node. Cold unheld rows read as
      // hidden, which is what their missing node answers live. (The rebuild
      // has no cold rows and evaluates all of them; the pass only needs
      // live-equivalence.)
      issue: (id) =>
        this.tables.issue.has(id) || this.worklist.has(id) ? partsOf(id) : undefined,
      session: (id) => directSessionVisibility(plain, id),
      issueRead: (id) => live.issueRead(id),
      passed: (t) => live.passed(t),
      reached: (t) => live.reached(t),
      // Maintenance reads, never derivation access: a cold row answers its
      // pending marker WITHOUT queuing its load (`mark`; the live reads queue,
      // which would arm the window from inside the pass). A session's verdict
      // reads its row here; the roll-up paths are unread.
      loadedIssue: (id) => this.row('issue', id, 'mark') as Loaded<SliceIssue>,
      loadedSession: (id) => this.row('session', id, 'mark') as Loaded<SliceSession>,
      progressFacts: (id) => live.progressFacts(id),
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
   *
   * The one read that bypasses `row` (POD-4743): the closure walk reads only
   * the structural keys (`parentId`, the started-by owner), which no pending
   * edit writes, and it is maintenance, so it must not count a fenced read
   * per ancestor the way a derivation's read does.
   */
  private issueRowOf(id: string): SliceIssue | undefined {
    return (this.tables.issue.get(id) ?? this.residency?.read('issue', id)) as
      | SliceIssue
      | undefined
  }

  /**
   * POD-4705 — expand `roots` to the lazy node closure (call in-action):
   * each root's ancestor chain by raw `parentId` (the same field the nest
   * walk follows, through any issue), the started-by owner of a parentless
   * started-by root, then every formal subtree under the union. Membership
   * lives in a `Set` (counted like any other map/set work — a linear scan
   * here would be O(closure²) work hidden from every counter); the walk
   * queues below are plain arrays, iterated once each, never membership
   * checked. Ancestors are noded even when cold: the nest walk passes
   * THROUGH a hidden parent to the grandparent, so a missing node would stop
   * it early. Formal descendants are noded even when hidden: the parent's
   * progress composes over their cached units. Every root verifies its first
   * hop (so a reparented held row picks up its new parent); the walk stops
   * at a pre-existing held chain (complete by induction) and at unknown ids;
   * it reads rows, never tables, and builds no observable.
   */
  private expandRoots(
    roots: Iterable<string>,
    partsOf: (id: string) => IssueVisibility,
  ): Set<string> {
    const closure = new Set<string>()
    // Members whose formal subtree still needs walking queue here, seeded
    // during the ancestor walk (no second pass over the closure): only ids
    // with a children bucket walk at all.
    const below: string[] = []
    const visit = (id: string): boolean => {
      if (closure.has(id) || !this.knows(id)) return false
      closure.add(id)
      if (!this.worklist.has(id) && this.graph.hasMembers('issue', id, 'children')) {
        below.push(id)
      }
      return true
    }
    for (const root of roots) {
      // Every root joins (held roots stay: the replace drops held rows
      // outside the closure) and verifies its first hop (one row read, free
      // when the row arrived on this action's event), so a reparented held
      // row still picks up its new parent. The walk stops at a pre-existing
      // held chain (complete by induction) and at unknown ids; membership
      // strictly grows per step, so adversarial parent cycles end.
      if (!this.knows(root)) continue
      visit(root)
      let current = root
      for (;;) {
        const row = this.issueRowOf(current)
        if (row === undefined) break
        const standing = standingOf(row)
        let next: string | null = null
        if (standing.parentId !== null) {
          next = standing.parentId
        } else if (standing.startedBy !== null && this.tables.issue.has(current)) {
          // Parentless with a starter: the present owner carries the nest.
          // Evaluated (hot rows only) for a member that needs it; anything
          // else holds its owner already, since a present row is always
          // noded. A cold member nests under nothing (hidden by rule).
          next = partsOf(current).nestParent
        } else {
          break
        }
        if (next === null || !this.knows(next)) break
        // Already a member (a parent cycle) ends the walk; a pre-existing
        // held chain above is complete by induction.
        if (!visit(next)) break
        if (this.worklist.has(next)) break
        current = next
      }
    }
    for (let head = 0; head < below.length; head += 1) {
      const id = below[head] as string
      for (const child of this.rawMany('issue', id, 'children')) {
        if (this.knows(child)) visit(child)
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
   * the raw engine without walking anything or counting a read. Split so the
   * caller can treat them differently: an explicit member warms its cold
   * owner through residency (no evaluation needed), while a lane-only
   * session (no foreign key, never warmed) is the only way a cold lane
   * owner flips visible (R3) and must be evaluated.
   */
  private sessionLinkedIssues(sessionId: string): {
    readonly explicit: string | null
    readonly lane: readonly string[]
  } {
    const explicit = this.rawOne('session', sessionId, 'issue')
    const lanePath = this.rawOne('session', sessionId, 'worktree')
    const lane: string[] = []
    if (lanePath !== null) {
      for (const issueId of this.rawMany('worktree', lanePath, 'issues')) {
        if (this.knows(issueId)) lane.push(issueId)
      }
    }
    return {
      explicit: explicit !== null && this.knows(explicit) ? explicit : null,
      lane,
    }
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
      else {
        for (const record of event.rows) ingestRecord(this.target, record, out)
        // POD-4745: a lane member that can now keep a cold owner shown warms it.
        this.residency?.settleLanes(this.target, out)
      }
      this.graph.flush()
      this.syncWorklist(event)
    })
    for (const [entity, id] of out.removed) this.release(entity, id)
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
        // Every known issue, hot or cold: a cold row kept visible by its
        // lane (R3, never warmed for lack of a foreign key) must still node,
        // and bootstrap counts nothing. Cross-reads answer hot-only (a cold
        // row reads as hidden, exactly as a missing node does), so the pass
        // terminates like the rebuild's.
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
      this.worklist.syncReplace(this.expandRoots(roots, partsOf), knows)
      for (const id of [...this.models.session.keys()]) this.release('session', id)
      return
    }
    const isColdIssue = (id: string): boolean => this.residency?.isCold('issue', id) === true
    // Membership in counted Sets (POD-4705 addendum 2): a lane fan-out over
    // a family must not scan an array per member. `named` and `gone` stay
    // plain arrays: they are append-only event order, never membership
    // checked (the closure Set dedupes).
    const named: string[] = []
    const candidates = new Set<string>()
    const gone: string[] = []
    const consider = (id: string): void => {
      if (!this.worklist.has(id) && !isColdIssue(id)) candidates.add(id)
    }
    // A lane-linked cold row is evaluated, never skipped: a lane-only
    // session (no foreign key, never warmed) is the only way one flips
    // visible (R3). An explicit member warms its cold owner through
    // residency instead, so explicit cold rows stay out (and the heartbeat
    // fence stays quiet).
    const considerLane = (id: string): void => {
      if (!this.worklist.has(id)) candidates.add(id)
    }
    for (const record of event.rows) {
      if (record.kind === 'issue') {
        if (record.value === undefined) gone.push(record.id)
        else named.push(record.id)
      } else if (record.kind === 'session') {
        if (record.value === undefined) {
          this.release('session', record.id)
        } else {
          const linked = this.sessionLinkedIssues(record.id)
          if (linked.explicit !== null) consider(linked.explicit)
          for (const issueId of linked.lane) considerLane(issueId)
        }
      } else if (record.kind === 'worktree' && record.value !== undefined) {
        for (const issueId of this.rawMany('worktree', record.id, 'issues')) {
          considerLane(issueId)
        }
      }
    }
    if (named.length === 0 && candidates.size === 0) {
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
    const closure = this.expandRoots(roots, partsOf)
    for (const id of gone) closure.add(id)
    this.worklist.ensure(closure, knows)
    if (gone.length > 0) this.worklist.ensure(gone, knows)
  }

  /**
   * POD-4705 — ensure nodes for rows the write layer's pending display
   * touches (call inside an action): a queued (or settled) edit projects
   * through the reader's overlay, which only derivations read — a row
   * without a node would never follow its pending verdict. The row is
   * touched, so like any named row it earns its closure; held rows skip
   * free. Called from the overlay refresh, after the entry is mirrored.
   */
  ensureIssues(ids: Iterable<string>): void {
    const roots = [...ids]
    if (roots.length === 0) return
    const { partsOf } = this.plainScope(null)
    this.worklist.ensure(this.expandRoots(roots, partsOf), (id) => this.knows(id))
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
