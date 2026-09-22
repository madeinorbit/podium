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
 * READ PATH. Every table read goes through the reads fence
 * (`reads.wrapTables`), every relation read through `reads.wrapRelations`;
 * with the fence disabled both are the identity. Derivations run lazily: a
 * row view computes when a mounted row (or `snapshot()`) reads it and
 * suspends when nothing does (no `keepAlive`).
 *
 * STATS (`README.md` has the definitions): `rowsDerived` counts row-view
 * body runs; `notifications` counts actions that changed pool state;
 * `rollupsDerived` and `indexUpdates` stay 0 until the worklist phase and
 * Ma2 add roll-ups and buckets. The pool's own counters are in `counters`.
 */

import './enforce'
import { autorun, comparer, computed, makeObservable, observable, type ObservableMap, runInAction } from 'mobx'
import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import { sliceRowOf } from '../../../shared/src/row-view'
import type { EntityName } from '../../../shared/src/schema'
import type { LocalsKey, SliceIssue, SliceLocals, SliceSession, SliceSnapshot } from '../../../shared/src/slice-types'
import type { ArmStats, RowSourceEvent } from '../../../shared/src/stats'
import { DeadlineClock } from './clock'
import { issueIdsOf, reseed } from './enumerate'
import { type EntityModel, type IssueModel, MODEL_CLASSES, type ModelOf } from './models'
import { PoolRelations } from './relations'
import { createObservableTables, ENTITIES, type IngestTarget, ingestOut, ingestRecord, type PoolTables } from './tables'
import type { RepoRow, ViewInputs } from './views'

/** The pool's own counters, beside the shared `ArmStats`. */
export interface PoolCounters {
  /** Models built (first access). Zero after bootstrap until something reads. */
  modelsCreated: number
  /** Table slots written (set to a different object, or deleted). */
  tableWrites: number
  /** Rows removed (evict or remove), each with its model dropped. */
  rowsRemoved: number
}

export type PoolStats = ArmStats & { readonly counters: PoolCounters }

function createStats(): PoolStats {
  const counters: PoolCounters = { modelsCreated: 0, tableWrites: 0, rowsRemoved: 0 }
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
    },
  }
  return stats
}

/** The worklist's order until Mb1 builds the visible collection. */
const EMPTY_ORDER = Object.freeze({ pinnedIds: Object.freeze([]), groups: Object.freeze([]) })

/**
 * Run `read` inside a transient reaction and return its result, so reads made
 * outside any reaction (the harness's `snapshot()`) are tracked reads and
 * never trip `computedRequiresReaction` / `observableRequiresReaction`.
 */
export function tracked<T>(read: () => T): T {
  let result: { value: T } | null = null
  const stop = autorun(() => {
    result = { value: read() }
  })
  stop()
  if (result === null) throw new Error('[pool] tracked() ran inside a batch; read after the action ends')
  return (result as { value: T }).value
}

export class MobxPool {
  /** The raw tables (writes only; the copy sweep reaches the pool through them). */
  readonly tables: PoolTables
  /** The same tables through the reads fence: every read in the pool goes here. */
  readonly fenced: PoolTables
  readonly relations: RelationReader
  /** The selection local: at most one entry, the selected issue id. */
  readonly selection: ObservableMap<string, true>
  readonly clock: DeadlineClock
  readonly inputs: ViewInputs
  readonly stats: PoolStats
  private readonly models: { readonly [E in EntityName]: Map<string, EntityModel> }
  private readonly target: IngestTarget
  private selectedId: string | null

  constructor(
    readonly reads: ReadFence,
    locals: SliceLocals,
  ) {
    this.tables = createObservableTables()
    this.fenced = reads.wrapTables(this.tables)
    this.relations = reads.wrapRelations(new PoolRelations(this.fenced))
    this.selection = observable.map<string, true>(undefined, { deep: false, name: 'pool.selection' })
    this.clock = new DeadlineClock(locals.coarseNow)
    this.stats = createStats()
    this.models = Object.fromEntries(ENTITIES.map((entity) => [entity, new Map()])) as MobxPool['models']
    this.target = { read: this.fenced, write: this.tables }
    this.selectedId = null
    const fenced = this.fenced
    this.inputs = {
      relations: this.relations,
      issue: (id) => fenced.issue.get(id) as SliceIssue | undefined,
      session: (id) => fenced.session.get(id) as SliceSession | undefined,
      repo: (id) => fenced.repo.get(id) as RepoRow | undefined,
      selected: (id) => this.selection.has(id),
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    makeObservable<MobxPool, 'models' | 'target' | 'selectedId' | 'select'>(this, {
      tables: false,
      fenced: false,
      relations: false,
      selection: false,
      clock: false,
      inputs: false,
      stats: false,
      models: false,
      target: false,
      selectedId: false,
      reads: false,
      issueIds: computed({ equals: comparer.structural }),
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
  }

  /** Every issue id in the pool, in table order. Re-derived only when membership changes. */
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

  issue(id: string): IssueModel | undefined {
    return this.model('issue', id)
  }

  /** Models currently held, per entity (tests: lifecycle). */
  modelCount(entity: EntityName): number {
    return this.models[entity].size
  }

  /** One feed publication, one action. */
  apply(event: RowSourceEvent): void {
    const out = ingestOut()
    runInAction(() => {
      if (event.type === 'replace') reseed(this.target, event.rows, out)
      else for (const record of event.rows) ingestRecord(this.target, record, out)
    })
    for (const [entity, id] of out.removed) this.models[entity].delete(id)
    this.stats.counters.tableWrites += out.writes
    this.stats.counters.rowsRemoved += out.removed.length
    if (out.writes > 0) this.stats.notifications += 1
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

  /** The Ma1 slice output: every pool issue's row, no order yet (Mb1). */
  snapshot(): SliceSnapshot {
    return tracked(() => {
      const rowsById: SliceSnapshot['rowsById'] = {}
      for (const id of this.issueIds) {
        const view = this.issue(id)?.view
        if (view !== undefined) rowsById[id] = sliceRowOf(view)
      }
      return { order: EMPTY_ORDER as unknown as SliceSnapshot['order'], rowsById }
    })
  }

  /** Empty every table, model cache, selection and clock registration. */
  dispose(): void {
    runInAction(() => {
      for (const entity of ENTITIES) this.tables[entity].clear()
      this.selection.clear()
    })
    for (const entity of ENTITIES) this.models[entity].clear()
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
