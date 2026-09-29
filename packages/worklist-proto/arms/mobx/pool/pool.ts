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
 * every queued row in ONE action (`hydrate`). A row that stops being cold (a
 * reopen's sessions, an issue a session keeps shown) is installed from the
 * publication when it carries the row, else asked for the same way: the
 * window is the only per-row read (POD-4753). `snapshot()` settles the loader
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
 * identity. Derivations run lazily: a row field computes when a mounted row
 * (or `snapshot()`) reads it and suspends when nothing does (no `keepAlive`).
 *
 * STATS (`README.md` has the definitions): `rowsDerived` counts row-field
 * body runs; `notifications` counts actions that changed pool state;
 * `indexUpdates` counts relation slots written (forward entries and
 * buckets; `counters.bucketElements` the elements inside them);
 * `rollupsDerived` counts runs of an issue's two roll-up compositions
 * (`worklist/rollup.ts` `attentionOf`: its own attention, the subtree
 * aggregate and seat activity; `unitsBelowPartOf`: the units below).
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
  observe,
  runInAction,
  untracked,
} from 'mobx'
import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import { relationLinks } from '../../../shared/src/links'
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
import { builtIds, issueIdsOf, reseed } from './enumerate'
import {
  type EntityModel,
  type IssueModel,
  MODEL_CLASSES,
  type ModelOf,
  rowViewOf,
  type SessionModel,
} from './models'
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
  type HeldIssue,
  HIDDEN_ISSUE_FIELDS,
  readAtOf,
  rollupInputsOf,
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
   * Issues kept out of memory beside the cold rule (`PoolLazyOptions
   * .outOfMemory`) that the rule would keep resident: they may show, so they
   * hold a filing reaction like an issue in memory (their visibility reads
   * the row by id). Empty unless the option is given.
   */
  private readonly heldOut = new Set<string>()
  private readonly outOfMemory: (entity: EntityName, id: string) => boolean
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
    this.outOfMemory = lazy?.outOfMemory ?? (() => false)
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
            // What visibility reads of a hidden issue (POD-4753), never the row.
            summaries: { issue: HIDDEN_ISSUE_FIELDS },
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
    // The engine knows every KNOWN row (a target is present hot or cold) and
    // reads only resident ones: a cold row's fields it needs again it keeps
    // itself, from the row ingest hands it (POD-4753), never read by id.
    const known =
      residency === null
        ? fenced
        : (Object.fromEntries(
            ENTITIES.map((entity) => [
              entity,
              {
                get: (id: string) => fenced[entity].get(id),
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
            onSubsetJoin: (collection: string, subset: string, _target: string, member: string) =>
              residency.laneJoined(collection, subset, member),
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
    const links = relationLinks(this.relations, this.graph.schema)
    this.inputs = {
      links,
      issue: (id) => inMemory(this.row('issue', id)) as SliceIssue | undefined,
      session: (id) => inMemory(this.row('session', id)) as SliceSession | undefined,
      // The member's cached stamp (its object's, hot or cold): no row read.
      sessionActivity: (id) => (this.object('session', id) as SessionModel).activityMs,
      repo: (id) => inMemory(this.row('repo', id)) as RepoRow | undefined,
      // An issue answers from its object's cached in-memory read (no table
      // probe per run); other entities from the table.
      present: (entity, id) =>
        entity === 'issue'
          ? this.issueObject(id).loaded.facts.state === 'ready'
          : fenced[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      // Only asked for an issue in memory (`originTickPartOf`): its object.
      parts: (id) => this.issueObject(id),
      rollup: (id) => this.knownIssue(id)?.rollup,
      retainedSeats: (id) => this.knownIssue(id)?.retainedSeatIds ?? [],
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
      links,
      // Hot or cold: a cold row is read by id through the feed, never loaded.
      issueRow: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      sessionRow: (id) => this.row('session', id, 'peek') as SliceSession | undefined,
      issue: (id) => this.knownIssue(id),
      session: (id) => this.object('session', id) as SessionModel,
      passed: (t) => this.clock.passed(t),
      reached: (t) => this.clock.reached(t),
      loadedIssue: (id) => this.row('issue', id) as Loaded<SliceIssue>,
      loadedSession: (id) => this.row('session', id) as Loaded<SliceSession>,
      // Option A (POD-4571): progress reads a cold child by id, never loading it.
      progressFacts: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      issueRead: (id) => this.readCursor(id),
      nested: (id) => this.issueObject(id).nested,
      formalChildren: (id) => links.issue.children.ids(id),
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
      issue: (id) => this.issueObject(id),
      fileGroups: (id, filing) => this.groups.file(id, filing),
    })
    this.foldLatch = observable.box(locals.selectedIssueWasFolded === true, {
      name: 'pool.foldLatch',
    })
    this.groups = new WorklistGroups({
      node: (id) => this.knownIssue(id),
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
      | 'heldOut'
      | 'outOfMemory'
      | 'select'
      | 'followTable'
      | 'followHeldOut'
      | 'clearSeats'
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
      issueObject: false,
      knownIssue: false,
      release: false,
      edit: false,
      row: false,
      readCursor: false,
      stats: false,
      models: false,
      target: false,
      selectedId: false,
      heldOut: false,
      outOfMemory: false,
      clearSeats: false,
      reads: false,
      residency: false,
      residentIssueIds: false,
      resident: false,
      lazyMany: false,
      hidden: false,
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
      // Maintenance called inside actions, never observed.
      followTable: false,
      followHeldOut: false,
    })
    // Every issue in memory holds its filing reaction: taken when its row
    // enters the table, released when it leaves (inside the action that
    // moved it; the reaction first runs when that action ends).
    observe(this.tables.issue, (change) => this.followTable(change.type, change.name))
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
   * the same row: an issue neither in memory nor tracked by the worklist, a
   * session no longer known, any other row no longer in memory.
   */
  private release(entity: EntityName, id: string): void {
    if (this.tables[entity].has(id)) return
    if (entity === 'issue' && this.worklist.tracks(id)) return
    if (entity === 'session' && this.residency?.isCold('session', id) === true) return
    this.models[entity].delete(id)
  }

  /** The one object of issue `id`, built on first request (untracked: an identity memo). */
  issueObject(id: string): IssueModel {
    return this.object('issue', id) as IssueModel
  }

  /**
   * TRACKED: the object of issue `id` while the pool knows the issue (in
   * memory or cold), else undefined: a cross-issue read (a parent, a child,
   * a starter's owner) that reaches an unknown id re-runs when it becomes
   * known. A presence probe, not a row read.
   */
  knownIssue(id: string): HeldIssue | undefined {
    const known = this.tables.issue.has(id) || this.residency?.known('issue', id) === true
    return known ? this.issueObject(id) : undefined
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
   * TRACKED: the declared summary of a row the cold rule keeps hidden
   * (POD-4753): a hidden issue's visibility reads it instead of its row.
   * Undefined for a row in memory, one held out beside the rule, or unknown.
   */
  hidden(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    const residency = this.residency
    if (residency === null) return undefined
    // A row in memory is never hidden, and its reader already tracks its
    // table slot (a `replace` that makes it cold rewrites that slot): asked
    // untracked, so no residency atom is made per issue in memory.
    if (untracked(() => this.tables[entity].has(id))) return undefined
    if (!residency.hidden(entity, id)) return undefined
    return residency.summary(entity, id) ?? {}
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
   * Close the load window now: install every queued cold row, read by id
   * through the feed, in ONE action. The window's timer calls this; so does
   * `snapshot()` while settling.
   *
   * A row it installs enters the issue table, which gives it its filing
   * reaction (`followTable`); the rows it no longer keeps cold are asked for
   * in turn, and the lanes it moved are settled (`Residency.install`).
   */
  hydrate(): void {
    const residency = this.residency
    if (residency === null) return
    const batch = residency.take()
    if (batch.length === 0) return
    const out = ingestOut()
    this.graph.begin()
    runInAction(() => {
      residency.install(this.target, batch, out)
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
        // POD-4753: a row this update carries is installed from it; any
        // other row it warms is asked for (the load window).
        this.residency?.publication(event.rows)
        for (const record of event.rows) ingestRecord(this.target, record, out)
        // POD-4745: a member or a lane member that can now keep a cold row
        // shown warms it, once every row of the update is in.
        this.residency?.settle(this.target, out)
      }
      this.graph.flush()
      this.followHeldOut(event)
    })
    for (const [entity, id] of out.removed) this.release(entity, id)
    this.stats.counters.tableWrites += out.writes
    this.stats.counters.rowsRemoved += out.removed.length
    if (out.writes > 0 || out.cold > 0 || out.volatile > 0) this.stats.notifications += 1
  }

  /**
   * The issue table moved (inside the action that moved it): a row entering
   * memory takes its filing reaction, a row leaving releases it, unless the
   * row is still kept out of memory beside the rule (`heldOut`).
   */
  private followTable(type: 'add' | 'update' | 'delete', id: string): void {
    if (type === 'add') {
      this.heldOut.delete(id)
      this.worklist.track(id)
    } else if (type === 'delete' && !this.heldOut.has(id)) {
      this.worklist.untrack(id)
    }
  }

  /**
   * An issue the option keeps out of memory, although the cold rule would
   * keep it resident, may show: it holds a filing reaction while the pool
   * knows it cold (inside the event's action). Nothing to do without the
   * option.
   */
  private followHeldOut(event: RowSourceEvent): void {
    const residency = this.residency
    if (residency === null) return
    for (const record of event.rows) {
      if (record.kind !== 'issue' || !this.outOfMemory('issue', record.id)) continue
      if (!this.tables.issue.has(record.id) && residency.isCold('issue', record.id)) {
        this.heldOut.add(record.id)
        this.worklist.track(record.id)
      }
    }
    for (const id of [...this.heldOut]) {
      if (this.tables.issue.has(id) || residency.isCold('issue', id)) continue
      this.heldOut.delete(id)
      this.worklist.untrack(id)
    }
    if (event.type === 'replace') {
      for (const id of builtIds(this.models.session)) this.release('session', id)
    }
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
          // The row read as a drawn row reads it, every field (so the loads
          // its fields reach, a spin-off's origin, settle below), then
          // projected for parity. The issue IS its row: this copy is the
          // snapshot's, never drawn.
          const view = rowViewOf(this.issue(id))
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
      this.heldOut.clear()
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
