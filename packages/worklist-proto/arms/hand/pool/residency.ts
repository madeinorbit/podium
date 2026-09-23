/**
 * POD-4580 (Ha3) — residency: which rows the hand pool holds, and how a cold
 * row comes in (schema doc §5; audit §7, Linear's partial bootstrap). Written
 * for this arm after the MobX build (Ma3, POD-4567) and to its contract: the
 * same rule, the same transitions, the same 50 ms window, the same shared
 * seams (`RowSource.row`, `RowView.loading`).
 *
 * THE RULE, FROM THE SCHEMA. `coldByRule` (`shared/src/schema.ts`) over
 * `schema[entity].cold`: an issue is cold when `closedAt` is set; a session
 * when its raw `issueId` names a known issue that is cold by rule; a lane or
 * repo never. No entity or field is named here; the constructor refuses a
 * schema whose cold entity the feed cannot read by id or that roots a
 * `prefix` relation (a cold root would break both).
 *
 * WHAT COLD MEANS. A cold row is not in the pool's tables: no slot, no cell,
 * no record. The registry below holds its id and, for a `via` row, the id it
 * inherits from (so a reopen finds its sessions). The relation engine links
 * it all the same (ingest hands it the row while it has it), so every bucket
 * holds hot and cold ids alike, and the engine reads a cold row again (a
 * collapse peer, a flipped twin) by id through the feed (`read`).
 *
 * HOW A ROW BECOMES HOT, and nothing else makes it so:
 * 1. First access: a cell that reaches a cold row through a lazy relation
 *    asks `loading(entity, id)`, gets true, and the row is queued. The first
 *    request arms a 50 ms window; every row requested inside it is read by
 *    id through the feed (`RowSource.row`, the kernel's `replica.row`) and
 *    installed in ONE commit when it closes (`HandPool.hydrate`). Duplicates
 *    coalesce. The load is deferred rather than done inside the cell because
 *    a cell must not write the tables it is reading mid-drain.
 * 2. An update that makes the row itself not cold (an issue reopened): the
 *    update carries the value, so it is installed at once, and the rows that
 *    inherited coldness from it (its sessions) are read by id and installed
 *    in the same commit (`warmDependents`). A removed row warms its
 *    dependents too: with the target gone, nothing makes them cold.
 * AN UPDATE TO A COLD ROW THAT LEAVES IT COLD relinks it and is not stored
 * (the choice the brief asks for, and Ma3's): the kernel holds the value and
 * a later load reads the current one, so a heartbeat on a closed issue's
 * session costs a registry write and a relink, never a load, and a reopen
 * never paints loading.
 *
 * NOTHING MAKES A HOT ROW COLD except a `replace`, which re-partitions
 * (`enumerate.ts` `reseed`): a row resident before and still in the slice
 * stays; every other row follows the rule over the new slice. An issue closed
 * while resident stays resident: it was just looked at.
 *
 * TRACKED, THE HAND WAY. "Is this row cold" is state a cell reads, so it goes
 * through a door (pitfall j): `loading` and `known` call `asked`, which the
 * pool turns into a record of the running cell under `entity:id` in its
 * `coldness` index; every registry entry that appears or disappears is
 * reported through `changed`, which the pool turns into a `residency` delta
 * that dirties exactly those cells. A key costs an index entry only once a
 * cell has asked about it: observability on first access, applied to
 * residency itself. The registry, the dependents index and the queue are
 * plain maps no cell reads.
 */

import { coldByRule, type EntityName, type ModelSchema, viaTargetOf } from '../../../shared/src/schema'
import {
  drop,
  type IngestOut,
  type IngestTarget,
  put,
  type ReadableTable,
  type StoredRow,
  type TableSet,
} from './tables'

/** The kinds the feed can read by id (`RowSource.row`). */
export type LoadableEntity = 'issue' | 'session'

/** A per-row read: the row's current value, or undefined when it is gone. */
export type LoadRow = (entity: LoadableEntity, id: string) => object | undefined

/** Arms a timer; returns its cancel. Tests pass one that never fires. */
export type Schedule = (run: () => void, ms: number) => () => void

/** The batch window: rows requested within it load in one commit. */
export const LOAD_WINDOW_MS = 50

function loadable(entity: EntityName): entity is LoadableEntity {
  return entity === 'issue' || entity === 'session'
}

export interface ResidencyOptions {
  readonly schema: ModelSchema
  /** The pool's tables, read side (fenced: reads counted). */
  readonly hot: TableSet<ReadableTable>
  readonly load: LoadRow
  readonly windowMs?: number
  readonly schedule?: Schedule
  /** A cell asked whether `entity:id` is cold (the pool records the running cell). */
  asked(entity: EntityName, id: string): void
  /** `entity:id` entered or left the registry (the pool emits a `residency` delta). */
  changed(entity: EntityName, id: string): void
}

/** What residency did since the last reset (the pool's stats reset zeroes it). */
export interface ResidencyCounters {
  /** Registry writes: a cold row registered, relinked or forgotten. */
  coldWrites: number
  /** Distinct rows queued for a load. */
  requests: number
  /** Load windows closed (one commit each). */
  batches: number
  /** Rows installed by a load on access. */
  hydrated: number
  /** Rows installed because the row they inherit from stopped being cold. */
  warmed: number
}

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

export class Residency {
  readonly counters: ResidencyCounters = {
    coldWrites: 0,
    requests: 0,
    batches: 0,
    hydrated: 0,
    warmed: 0,
  }
  readonly windowMs: number
  private readonly options: ResidencyOptions
  private readonly schedule: Schedule
  /** Per cold-capable entity: cold id → the id it inherits from (`via`), else null. */
  private readonly cold = new Map<EntityName, Map<string, string | null>>()
  /** Per `via` entity: inherited-from id → its cold rows. */
  private readonly dependents = new Map<EntityName, Map<string, Set<string>>>()
  /** `via` entities by the entity they inherit from. */
  private readonly inheritors = new Map<EntityName, EntityName[]>()
  private readonly queue = new Map<LoadableEntity, Set<string>>()
  private cancel: (() => void) | null = null
  /** Runs a closed window's batch (the pool's `hydrate`). */
  private due: () => void = () => {}

  constructor(options: ResidencyOptions) {
    this.options = options
    this.windowMs = options.windowMs ?? LOAD_WINDOW_MS
    this.schedule = options.schedule ?? realSchedule
    const { schema } = options
    const prefixTargets = new Set<EntityName>()
    for (const spec of Object.values(schema)) {
      for (const relation of Object.values(spec.relations)) {
        if (relation.kind === 'prefix') prefixTargets.add(relation.to)
      }
    }
    for (const entity of Object.keys(schema) as EntityName[]) {
      const spec = schema[entity].cold
      if (spec.kind === 'never') continue
      if (!loadable(entity))
        throw new Error(`[pool] ${entity} can be cold but the feed cannot load it by id`)
      if (prefixTargets.has(entity))
        throw new Error(`[pool] ${entity} can be cold but roots a prefix relation`)
      this.cold.set(entity, new Map())
      if (spec.kind === 'via') {
        const relation = schema[entity].relations[spec.relation]
        if (relation?.kind !== 'belongsTo') {
          throw new Error(`[pool] ${entity}.cold.via must name a belongsTo (got ${relation?.kind})`)
        }
        this.inheritors.set(relation.to, [...(this.inheritors.get(relation.to) ?? []), entity])
        this.dependents.set(entity, new Map())
      }
    }
  }

  /** The pool's batch runner, called when a window closes. */
  onDue(run: () => void): void {
    this.due = run
  }

  /** Whether rows of `entity` can be cold at all. */
  capable(entity: EntityName): boolean {
    return this.cold.has(entity)
  }

  /** UNTRACKED: whether `id` is known and cold (ingest, checks, tests). */
  isCold(entity: EntityName, id: string): boolean {
    return this.cold.get(entity)?.has(id) ?? false
  }

  /** Cold rows of `entity`. */
  size(entity: EntityName): number {
    return this.cold.get(entity)?.size ?? 0
  }

  /** Cold ids of `entity` (reseed, the gate's partition check and checkpoint). */
  ids(entity: EntityName): readonly string[] {
    return [...(this.cold.get(entity)?.keys() ?? [])]
  }

  /** The id a cold `via` row is registered under (the partition check). */
  registeredTarget(entity: EntityName, id: string): string | null | undefined {
    return this.cold.get(entity)?.get(id)
  }

  /** `coldByRule` against the pool's own knowledge. */
  coldRule(entity: EntityName, row: object): boolean {
    return coldByRule(this.options.schema, entity, row, (to, id) => this.coldTarget(to, id))
  }

  /** Whether `to:id` is cold by rule: registered cold, or held and cold by rule. */
  private coldTarget(to: EntityName, id: string): boolean {
    if (this.isCold(to, id)) return true
    const row = this.options.hot[to].get(id) as object | undefined
    return row !== undefined && this.coldRule(to, row)
  }

  /**
   * TRACKED: whether `id` is known and cold; when it is, it is queued. This is
   * the "first access" a cell makes through a lazy relation.
   */
  loading(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.options.asked(entity, id)
    if (!this.isCold(entity, id)) return false
    this.request(entity as LoadableEntity, id)
    return true
  }

  /** TRACKED: whether `id` is known and cold, without asking for it. */
  known(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.options.asked(entity, id)
    return this.isCold(entity, id)
  }

  /** Queue `id` for the next load window (arms one if none is open). */
  request(entity: LoadableEntity, id: string): void {
    let ids = this.queue.get(entity)
    if (ids === undefined) {
      ids = new Set()
      this.queue.set(entity, ids)
    }
    if (ids.has(id)) return
    ids.add(id)
    this.counters.requests += 1
    if (this.cancel === null) {
      this.cancel = this.schedule(() => {
        this.cancel = null
        this.due()
      }, this.windowMs)
    }
  }

  hasQueued(): boolean {
    return this.queue.size > 0
  }

  /** Close the window now: the queued rows, cleared. */
  take(): [LoadableEntity, string][] {
    this.cancel?.()
    this.cancel = null
    const batch: [LoadableEntity, string][] = []
    for (const [entity, ids] of this.queue) for (const id of ids) batch.push([entity, id])
    this.queue.clear()
    if (batch.length > 0) this.counters.batches += 1
    return batch
  }

  /**
   * One live ingest of a cold-capable row. Hot stays hot; a known cold row
   * stays cold unless its own update says otherwise; a new row goes where the
   * rule says.
   */
  ingest(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow | undefined,
    out: IngestOut,
  ): void {
    const hot = target.read[entity].get(id) !== undefined
    if (value === undefined) {
      if (hot) drop(target, entity, id, out)
      else if (this.isCold(entity, id)) this.forget(target, entity, id)
      else return
      this.warmDependents(target, entity, id, out)
      return
    }
    if (hot) {
      put(target, entity, id, value, out)
      this.warmDependents(target, entity, id, out)
      return
    }
    if (this.coldRule(entity, value)) {
      this.keepCold(target, entity, id, value)
      return
    }
    this.unregister(entity, id)
    put(target, entity, id, value, out)
    this.warmDependents(target, entity, id, out)
  }

  /**
   * A `replace` placing one row of the new slice (`reseed`): a row resident
   * before stays; any other follows the rule, with `staged` (the new slice)
   * answering for the rows it inherits from.
   */
  place(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow,
    staged: (to: EntityName, id: string) => object | undefined,
    out: IngestOut,
  ): void {
    const hot = target.read[entity].get(id) !== undefined
    const { schema } = this.options
    const coldTarget = (to: EntityName, key: string): boolean => {
      const row = staged(to, key)
      return row !== undefined && coldByRule(schema, to, row, coldTarget)
    }
    if (!hot && coldByRule(schema, entity, value, coldTarget)) {
      this.keepCold(target, entity, id, value)
      return
    }
    this.unregister(entity, id)
    put(target, entity, id, value, out)
  }

  /** A cold row left the slice (a removal, or a `replace`): unlink and forget it. */
  forget(target: IngestTarget, entity: EntityName, id: string): void {
    this.unregister(entity, id)
    target.relations?.changed(entity, id, undefined, undefined)
    this.counters.coldWrites += 1
  }

  /** Install a queued row on access (inside the pool's batch commit). */
  hydrate(target: IngestTarget, entity: LoadableEntity, id: string, out: IngestOut): void {
    if (!this.isCold(entity, id)) return
    const value = this.options.load(entity, id) as StoredRow | undefined
    // Gone from the kernel, its removal not yet published: stays cold until
    // the removal arrives and forgets it.
    if (value === undefined) return
    this.unregister(entity, id)
    put(target, entity, id, value, out)
    this.counters.hydrated += 1
  }

  /** Read a cold row by id (the relation engine's collapse peers and flipped twins). */
  read(entity: EntityName, id: string): object | undefined {
    return this.isCold(entity, id) ? this.options.load(entity as LoadableEntity, id) : undefined
  }

  /** Forget everything (the pool's dispose). */
  clear(): void {
    this.cancel?.()
    this.cancel = null
    this.queue.clear()
    for (const ids of this.cold.values()) ids.clear()
    for (const byTarget of this.dependents.values()) byTarget.clear()
  }

  /** Relink a cold row with its new value, keeping only its id. */
  private keepCold(target: IngestTarget, entity: EntityName, id: string, value: StoredRow): void {
    this.register(entity, id, value)
    // No previous value is held: the engine re-resolves every link of the row
    // (a link that did not move writes nothing) and re-decides its collapse
    // group, reading cold peers back by id.
    target.relations?.changed(entity, id, undefined, value)
    this.counters.coldWrites += 1
  }

  /**
   * The rows that inherit coldness from `to:id` and are no longer cold by
   * rule (it reopened, or left): read each by id and install it now.
   */
  private warmDependents(target: IngestTarget, to: EntityName, id: string, out: IngestOut): void {
    const entities = this.inheritors.get(to)
    if (entities === undefined || this.coldTarget(to, id)) return
    for (const entity of entities) {
      const ids = this.dependents.get(entity)?.get(id)
      if (ids === undefined) continue
      for (const dependent of [...ids]) {
        const value = this.options.load(entity as LoadableEntity, dependent) as
          | StoredRow
          | undefined
        if (value === undefined) continue // its removal is on the way
        this.unregister(entity, dependent)
        put(target, entity, dependent, value, out)
        this.counters.warmed += 1
        this.warmDependents(target, entity, dependent, out)
      }
    }
  }

  private register(entity: EntityName, id: string, row: object): void {
    const ids = this.cold.get(entity) as Map<string, string | null>
    const known = ids.has(id)
    const before = ids.get(id) ?? null
    const after = viaTargetOf(this.options.schema, entity, row)?.id ?? null
    ids.set(id, after)
    const byTarget = this.dependents.get(entity)
    if (byTarget !== undefined && before !== after) {
      if (before !== null) unindex(byTarget, before, id)
      if (after !== null) index(byTarget, after, id)
    }
    if (!known) this.options.changed(entity, id)
  }

  private unregister(entity: EntityName, id: string): void {
    const ids = this.cold.get(entity)
    if (ids === undefined || !ids.has(id)) return
    const before = ids.get(id) ?? null
    ids.delete(id)
    const byTarget = this.dependents.get(entity)
    if (byTarget !== undefined && before !== null) unindex(byTarget, before, id)
    const queued = this.queue.get(entity as LoadableEntity)
    queued?.delete(id)
    if (queued?.size === 0) this.queue.delete(entity as LoadableEntity)
    this.options.changed(entity, id)
  }
}

function index(byTarget: Map<string, Set<string>>, target: string, id: string): void {
  let ids = byTarget.get(target)
  if (ids === undefined) {
    ids = new Set()
    byTarget.set(target, ids)
  }
  ids.add(id)
}

function unindex(byTarget: Map<string, Set<string>>, target: string, id: string): void {
  const ids = byTarget.get(target)
  ids?.delete(id)
  if (ids?.size === 0) byTarget.delete(target)
}
