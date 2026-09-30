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
 *
 * RESIDENCY (POD-4567, `residency.ts`). With a per-row read (`lazy.load`, the
 * feed's `RowSource.row`), rows the schema lets be cold (closed issues and
 * their sessions) never enter the tables: ingest registers their ids and the
 * relation engine links them. A derivation that reaches one through a lazy
 * relation gets `loading` and queues it; the 50 ms window's batch installs
 * every queued row in ONE action (`hydrate`). A row that stops being cold (a
 * reopen's sessions, an issue a session keeps shown) is installed from the
 * publication when it carries the row, else asked for the same way: the
 * window is the only per-row read (POD-4753). The harness drains the window
 * (`hydrate` in a loop) before it reads. Without `lazy` every row is
 * resident (Ma1/Ma2 tests).
 *
 * READ PATH. Every row a model, view, visibility part, roll-up or group
 * placement reads comes from ONE reader, `row(entity, id, absent)`
 * (POD-4743): the server row with the write layer's pending edits overlaid
 * (`WriteSeam`, the seam the write layer passes at construction), the server
 * object itself when nothing is pending, and for a row not in memory the
 * answer the caller names (`AbsentRead`: `LOADING` with its load queued,
 * `LOADING` alone, or its current value by id through the feed). Every table
 * read goes through the tables, every relation read through the relation
 * engine. Derivations run lazily: a row field computes when a mounted row
 * reads it and suspends when nothing does (no `keepAlive`).
 *
 * STRICT FLAGS (POD-4760) live only in tests (`harness/src/mobx-enforce.ts`
 * exports them, `harness/src/mobx-trap.ts` applies them): importing the pool
 * never configures MobX.
 */

import {
  compareStructural,
  type IObservableArray,
  type IObservableValue,
  makeObservable,
  type ObservableMap,
  observable,
  observe,
  runInAction,
  untracked,
} from 'mobx'
import type { RelationReader } from '../../../shared/src/instrument/reads'
import { relationLinks } from '../../../shared/src/links'
import { type EntityName, type ModelSchema, SCHEMA } from '../../../shared/src/schema'
import type {
  LocalsKey,
  SliceIssue,
  SliceLocals,
  SliceSession,
} from '../../../shared/src/slice-types'
import type { RowSourceEvent } from '../../../shared/src/stats'
import {
  type EditPatch,
  type TxId,
  type WritableKind,
  WriteContractError,
} from '../../../shared/src/write-contract'
import { DeadlineClock } from './clock'
import { reseed } from './enumerate'
import {
  type EntityModel,
  type IssueModel,
  MODEL_CLASSES,
  type ModelOf,
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
import { WorklistGroups } from './worklist/groups'
import { LOADING, type Loaded, type RollupInputs } from './worklist/rollup'
import {
  type HeldIssue,
  HIDDEN_ISSUE_FIELDS,
  readAtOf,
  rollupInputsOf,
  VisibleCollection,
  type VisibleInputs,
} from './worklist/visible'

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

export class MobxPool {
  /** The tables: every read and write in the pool goes here. */
  readonly tables: PoolTables
  readonly relations: RelationReader
  /** The relation engine itself. */
  readonly graph: PoolRelations
  /** The selection local: at most one entry, the selected issue id. */
  readonly selection: ObservableMap<string, true>
  /**
   * The read-state lane (POD-4686): each known issue's read cursor, per-key
   * tracked, readable by id only. A mark-read writes one key; only that row's
   * `unread` (and a decay row's `flat`) re-runs. It is derived state populated
   * from the row the update arrived on, read like a cached computed.
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
    locals: SliceLocals,
    schema?: ModelSchema,
    lazy?: PoolLazyOptions,
    writes?: WriteSeam,
  ) {
    this.writes = writes ?? null
    this.tables = createObservableTables()
    const tables = this.tables
    const residency =
      lazy === undefined
        ? null
        : new Residency({
            schema: schema ?? SCHEMA,
            hot: tables,
            load: lazy.load,
            // Read at ingest, after the constructor has built the clock.
            now: () => this.clock.current,
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
            // What visibility reads of a hidden issue (POD-4753), never the row.
            summaries: { issue: HIDDEN_ISSUE_FIELDS },
            // The rule's lane source (R3, POD-4745) reads the engine, built below.
            lanes: () => this.graph,
          })
    this.residency = residency
    /**
     * The explicit seats (`issue.sessions`), maintained SORTED from the
     * relation's own bucket deltas (one element per move: binary search +
     * splice at its id-order position, never the family). The rule is declared
     * once in the schema (`issue.sessions`); this mirror follows the engine's
     * delta in the same action. Held in a closure (not a field) so the copy
     * sweep never walks it: it holds only ids, never rows (closures stay a
     * review item).
     *
     * The maintained SORTED array itself is returned without iterating it. A
     * membership change yields the new member only: O(1) for real.
     * `seatIdsPartOf` / `sessionIdsPartOf` read it, never the relation.
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
        ? tables
        : (Object.fromEntries(
            ENTITIES.map((entity) => [
              entity,
              {
                get: (id: string) => tables[entity].get(id),
                has: (id: string) => tables[entity].has(id) || residency.known(entity, id),
              },
            ]),
          ) as ReadableTables)
    this.graph = new PoolRelations({
      tables: known,
      probe: this.tables,
      ...(schema === undefined ? {} : { schema }),
      // File the explicit seat delta (one element) into the maintained SORTED
      // list, in the same action that moved the bucket: binary search by id
      // (default `.sort()` order, UTF-16 code units) + splice at its position.
      // No per-session reactions; the schema declares the rule once.
      // Family-small (2-3 ids): splice shifting is trivial.
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
              resident: (entity: EntityName, id: string) =>
                !residency.capable(entity) || tables[entity].has(id),
              observe: (entity: EntityName, id: string) => {
                residency.known(entity, id)
              },
              changed: (entity: EntityName, id: string) => residency.notify(entity, id),
            },
            onSubsetJoin: (collection: string, subset: string, _target: string, member: string) =>
              residency.laneJoined(collection, subset, member),
          }),
    })
    this.relations = this.graph
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
      read: this.tables,
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
          : tables[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      // Only asked for an issue in memory (`originTickPartOf`): its object.
      parts: (id) => this.issueObject(id),
      rollup: (id) => this.knownIssue(id)?.rollup,
      retainedSeats: (id) => this.knownIssue(id)?.retainedSeatIds ?? [],
      // The maintained SORTED list itself, returned without iterating it. A
      // membership change yields the new member only; the family is never
      // yielded here. Closure-held, ids only.
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
      issueRead: (id) => this.readCursor(id),
      nested: (id) => this.issueObject(id).nested,
      formalChildren: (id) => links.issue.children.ids(id),
      // The maintained SORTED list itself, returned without iterating it — a
      // membership change yields the new member only. `seatIdsPartOf` reads
      // it, never the relation.
      seatList: (id) => seats.get(id) ?? EMPTY_SEAT_LIST,
    }
    this.rollupInputs = rollupInputsOf(this.visibleInputs)
    this.worklist = new VisibleCollection({
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
    })
    makeObservable<
      MobxPool,
      | 'models'
      | 'target'
      | 'selectedId'
      | 'select'
      | 'followTable'
      | 'clearSeats'
      | 'object'
      | 'release'
    >(this, {
      tables: false,
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
      models: false,
      target: false,
      selectedId: false,
      clearSeats: false,
      residency: false,
      resident: false,
      lazyMany: false,
      hidden: false,
      hydrate: false,
      model: false,
      issue: false,
      apply: false,
      applyLocals: false,
      dispose: false,
      select: false,
      // Maintenance called inside actions, never observed.
      followTable: false,
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
   * cold row's value is read by id through the feed; it is tracked by
   * residency's per-id atom, which reports every relink and the load.
   * Unknown rows answer undefined. Never blocks.
   */
  row(entity: EntityName, id: string, absent: 'peek'): object | undefined
  row(entity: EntityName, id: string, absent?: 'load' | 'mark'): Loaded<object>
  row(entity: EntityName, id: string, absent: AbsentRead = 'load'): Loaded<object> {
    let server = this.tables[entity].get(id) as object | undefined
    if (server === undefined) {
      const residency = this.residency
      if (residency === null) return undefined
      if (absent === 'load') return residency.loading(entity, id) ? LOADING : undefined
      if (!residency.known(entity, id)) return undefined
      if (absent === 'mark') return LOADING
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

  /** The model of a row in memory, built on first request; undefined when absent (tracked). */
  model<E extends EntityName>(entity: E, id: string): ModelOf[E] | undefined {
    if (!this.tables[entity].has(id)) return undefined
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
    if (this.tables[entity].has(id)) return 'resident'
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
      if (this.tables[to].has(member)) ready.push(member)
      else if (this.residency?.loading(to, member) === true) pending += 1
    }
    return { ready, pending }
  }

  /**
   * Close the load window now: install every queued cold row, read by id
   * through the feed, in ONE action. The window's timer calls this; the
   * harness drains it in a loop before it reads. Returns how many rows the
   * window installed.
   *
   * A row it installs enters the issue table, which gives it its filing
   * reaction (`followTable`); the rows it no longer keeps cold are asked for
   * in turn, and the lanes it moved are settled (`Residency.install`).
   */
  hydrate(): number {
    const residency = this.residency
    if (residency === null) return 0
    const batch = residency.take()
    if (batch.length === 0) return 0
    const out = ingestOut()
    this.graph.begin()
    return runInAction(() => {
      const rows = residency.install(this.target, batch, out)
      this.graph.flush()
      return rows
    })
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
    })
    for (const [entity, id] of out.removed) this.release(entity, id)
  }

  /**
   * The issue table moved (inside the action that moved it): a row entering
   * memory takes its filing reaction, a row leaving releases it.
   */
  private followTable(type: 'add' | 'update' | 'delete', id: string): void {
    if (type === 'add') {
      this.worklist.track(id)
    } else if (type === 'delete') {
      this.worklist.untrack(id)
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
