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
 * buckets; `counters.bucketElements` the elements inside them); `rollupsDerived` stays 0 until the worklist phase adds roll-ups.
 * The pool's own counters are in `counters`.
 */

import './enforce'
import {
  autorun,
  computedStruct,
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
import { issueIdsOf, reseed } from './enumerate'
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

/** The pool's own counters, beside the shared `ArmStats`. */
export interface PoolCounters {
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

function createStats(residency: Residency | null): PoolStats {
  const counters: PoolCounters = {
    modelsCreated: 0,
    tableWrites: 0,
    rowsRemoved: 0,
    bucketElements: 0,
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

/** The worklist's order until Mb1 builds the visible collection. */
const EMPTY_ORDER = Object.freeze({ pinnedIds: Object.freeze([]), groups: Object.freeze([]) })

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
  readonly clock: DeadlineClock
  readonly inputs: ViewInputs
  readonly stats: PoolStats
  /** Residency (POD-4567); null when the pool holds every row. */
  readonly residency: Residency | null
  private readonly models: { readonly [E in EntityName]: Map<string, EntityModel> }
  private readonly target: IngestTarget
  private selectedId: string | null

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
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
          })
    this.residency = residency
    this.stats = createStats(residency)
    const stats = this.stats
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
    this.clock = new DeadlineClock(locals.coarseNow)
    this.models = Object.fromEntries(
      ENTITIES.map((entity) => [entity, new Map()]),
    ) as MobxPool['models']
    this.target = {
      read: this.fenced,
      write: this.tables,
      relations: this.graph,
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
      selected: (id) => this.selection.has(id),
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    makeObservable<MobxPool, 'models' | 'target' | 'selectedId' | 'select'>(this, {
      tables: false,
      fenced: false,
      relations: false,
      graph: false,
      selection: false,
      clock: false,
      inputs: false,
      stats: false,
      models: false,
      target: false,
      selectedId: false,
      reads: false,
      residency: false,
      residentIssueIds: false,
      resident: false,
      lazyMany: false,
      hydrate: false,
      issueIds: computedStruct,
      model: false,
      issue: false,
      modelCount: false,
      apply: false,
      applyLocals: false,
      snapshot: false,
      dispose: false,
      select: false,
    })
    runInAction(() => this.select(locals.selectedIssueId))
    residency?.onDue(() => this.hydrate())
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
   * Close the load window now: install every queued cold row, read by id
   * through the feed, in ONE action. The window's timer calls this; so does
   * `snapshot()` while settling.
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
    if (out.writes > 0) this.stats.notifications += 1
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
    })
    for (const [entity, id] of out.removed) this.models[entity].delete(id)
    this.stats.counters.tableWrites += out.writes
    this.stats.counters.rowsRemoved += out.removed.length
    if (out.writes > 0 || out.cold > 0) this.stats.notifications += 1
  }

  /** One locals notification, one action: only the keys it names. */
  applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    const selection = changed.has('selectedIssueId')
    const clock = changed.has('coarseNow')
    if (!selection && !clock) return
    runInAction(() => {
      if (selection) this.select(locals.selectedIssueId)
      if (clock) this.clock.advance(locals.coarseNow)
    })
    this.stats.notifications += 1
  }

  /**
   * The Ma1 slice output: every RESIDENT issue's row, no order yet (Mb1).
   * Settled: reading the rows queues the cold rows they reach, and those are
   * loaded and the rows read again until nothing is queued, as a reader that
   * waits out its loading state would see them.
   */
  snapshot(): SliceSnapshot {
    for (let round = 0; ; round += 1) {
      const snapshot = tracked(() => {
        const rowsById: SliceSnapshot['rowsById'] = {}
        for (const id of this.issueIds) {
          const view = this.issue(id)?.view
          if (view !== undefined) rowsById[id] = sliceRowOf(view)
        }
        return { order: EMPTY_ORDER as unknown as SliceSnapshot['order'], rowsById }
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
      for (const entity of ENTITIES) this.tables[entity].clear()
      this.graph.clear()
      this.selection.clear()
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
