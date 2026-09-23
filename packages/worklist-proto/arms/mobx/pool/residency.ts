/**
 * POD-4567 (Ma3) — residency: which rows the pool holds in memory, and how a
 * cold row comes in (schema doc §5; audit §7, Linear's partial bootstrap).
 *
 * THE RULE, FROM THE SCHEMA. `schema[entity].cold` decides, per row, whether
 * it may stay out of memory (`coldByRule`; the rebuild uses the same
 * function): `own` is the entity's predicate over its row (an issue with a
 * `closedAt`); `via` inherits it through a declared `belongsTo`: the row is
 * cold when the foreign key names a known row that is itself cold by rule (a
 * session of a closed issue). The foreign key is read raw: residency follows
 * the reference, not the relation's membership filter, so a headless session
 * of a closed issue is cold too. `never` is always resident. No entity or
 * field is named here.
 *
 * WHAT COLD MEANS HERE. A cold row is NOT in the pool's observable tables:
 * no table slot, no model, no observable. The registry below holds its id
 * (and, for a `via` row, the id it inherits from), in plain maps. The relation
 * engine still links it: ingest hands the engine the row while it has it, so
 * every bucket holds the ids of hot and cold members alike, and the engine
 * reads a cold row again (a collapse peer) through the feed's per-row read.
 *
 * HOW A ROW BECOMES HOT, and nothing else makes it so:
 * 1. First access. A derivation that reaches a cold row through a lazy
 *    relation (`loading`) gets `true` and queues the row; the first request
 *    arms a 50 ms window, and every row requested inside it is read by id
 *    through the feed (`RowSource.row`, the kernel's `replica.row`) and
 *    installed in ONE action when it closes. Duplicates coalesce. A derivation
 *    cannot write state (MobX), which is why the load is deferred at all.
 * 2. An update that makes the row itself not cold (an issue reopened): the
 *    update carries the value, so it is installed at once, and the rows that
 *    inherited coldness from it (its sessions) are read by id and installed
 *    in the same action (`warmDependents`). Removing a row warms its
 *    dependents too: with the target gone, nothing makes them cold.
 * An update to a cold row that leaves it cold relinks it and is NOT stored:
 * the kernel holds the value, and a later load reads the current one.
 *
 * NOTHING MAKES A HOT ROW COLD except a `replace`, which re-partitions
 * (`enumerate.ts` `reseed`): a row resident before it and still in the slice
 * stays resident; every other row follows the rule. An issue closed while in
 * memory stays in memory: it was just looked at.
 *
 * TRACKED. Whether a row is cold is state a derivation reads, so it must be
 * tracked (pitfall j), yet an observable per cold row is the cost this module
 * exists to avoid. So the registry is plain and each id a derivation asks
 * about gets an atom on that first question, dropped when no derivation
 * observes it: observability on first access, applied to residency itself.
 */

import { createAtom, type IAtom } from 'mobx'
import type { EntityName, ModelSchema } from '../../../shared/src/schema'
import { drop, type IngestOut, type IngestTarget, put, type StoredRow } from './tables'

type Row = Readonly<Record<string, unknown>>

/** The kinds the feed can read by id (`RowSource.row`). */
export type LoadableEntity = 'issue' | 'session'

/** A per-row read: the row's current value, or undefined when it is gone. */
export type LoadRow = (entity: LoadableEntity, id: string) => object | undefined

/** Arms a timer; returns its cancel. Tests pass a manual one. */
export type Schedule = (run: () => void, ms: number) => () => void

/** The batch window: requests within it load in one action. */
export const LOAD_WINDOW_MS = 50

/** Whether the feed can read rows of `entity` by id. */
function loadable(entity: EntityName): entity is LoadableEntity {
  return entity === 'issue' || entity === 'session'
}

/**
 * Whether `row` of `entity` may stay out of memory, by the schema's `cold`
 * spec. `coldTarget(to, id)` answers for a `via` row's referenced row (the
 * pool asks its registry and tables; the rebuild asks the feed).
 */
export function coldByRule(
  schema: ModelSchema,
  entity: EntityName,
  row: object,
  coldTarget: (to: EntityName, id: string) => boolean,
): boolean {
  const spec = schema[entity].cold
  if (spec.kind === 'never') return false
  if (spec.kind === 'own') return spec.predicate(row as Row)
  const target = viaTargetOf(schema, entity, row)
  return target !== null && coldTarget(target.to, target.id)
}

/** The row a `via` entity inherits residency from, or null (raw foreign key). */
export function viaTargetOf(
  schema: ModelSchema,
  entity: EntityName,
  row: object,
): { readonly to: EntityName; readonly id: string } | null {
  const spec = schema[entity].cold
  if (spec.kind !== 'via') return null
  const relation = schema[entity].relations[spec.relation]
  if (relation?.kind !== 'belongsTo') {
    throw new Error(`[pool] ${entity}.cold.via must name a belongsTo (got ${relation?.kind})`)
  }
  const key = (row as Row)[relation.foreignKey]
  return typeof key === 'string' && key.length > 0 ? { to: relation.to, id: key } : null
}

export interface ResidencyOptions {
  readonly schema: ModelSchema
  /** The pool's hot tables, read side (fenced: reads counted). */
  readonly hot: { readonly [E in EntityName]: { get(id: string): unknown } }
  readonly load: LoadRow
  readonly windowMs?: number
  readonly schedule?: Schedule
}

/** What residency did since the last `reset()`. */
export interface ResidencyCounters {
  /** Registry writes: a cold row registered, relinked or forgotten. */
  coldWrites: number
  /** Distinct rows queued for a load. */
  requests: number
  /** Load windows closed (one action each). */
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
  private readonly schema: ModelSchema
  private readonly hot: ResidencyOptions['hot']
  private readonly load: LoadRow
  private readonly schedule: Schedule
  /** Per cold-capable entity: cold id → the id it inherits from (`via`), else null. */
  private readonly cold = new Map<EntityName, Map<string, string | null>>()
  /** Per `via` entity: inherited-from id → its cold rows. */
  private readonly dependents = new Map<EntityName, Map<string, Set<string>>>()
  /** `via` entities by the entity they inherit from. */
  private readonly inheritors = new Map<EntityName, EntityName[]>()
  /** One atom per `entity:id` a derivation has asked about, while observed. */
  private readonly atoms = new Map<string, IAtom>()
  private readonly queue = new Map<LoadableEntity, Set<string>>()
  private cancel: (() => void) | null = null
  /** Runs a closed window's batch (the pool's action). */
  private due: () => void = () => {}

  constructor(options: ResidencyOptions) {
    this.schema = options.schema
    this.hot = options.hot
    this.load = options.load
    this.windowMs = options.windowMs ?? LOAD_WINDOW_MS
    this.schedule = options.schedule ?? realSchedule
    const prefixTargets = new Set<EntityName>()
    for (const spec of Object.values(this.schema)) {
      for (const relation of Object.values(spec.relations)) {
        if (relation.kind === 'prefix') prefixTargets.add(relation.to)
      }
    }
    for (const entity of Object.keys(this.schema) as EntityName[]) {
      const spec = this.schema[entity].cold
      if (spec.kind === 'never') continue
      // A cold row is read back by id through the feed, and the relation
      // engine never re-roots a prefix relation on it: both would break.
      if (!loadable(entity))
        throw new Error(`[pool] ${entity} can be cold but the feed cannot load it by id`)
      if (prefixTargets.has(entity))
        throw new Error(`[pool] ${entity} can be cold but roots a prefix relation`)
      this.cold.set(entity, new Map())
      if (spec.kind === 'via') {
        const relation = this.schema[entity].relations[spec.relation]
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

  /** Whether `id` is known and cold (plain: maintenance, inside actions). */
  isCold(entity: EntityName, id: string): boolean {
    return this.cold.get(entity)?.has(id) ?? false
  }

  /** Cold rows of `entity` (tests, the gate's partition check). */
  size(entity: EntityName): number {
    return this.cold.get(entity)?.size ?? 0
  }

  /** Cold ids of `entity` (the gate's partition check). */
  ids(entity: EntityName): readonly string[] {
    return [...(this.cold.get(entity)?.keys() ?? [])]
  }

  /** The id a cold `via` row inherits from, as registered (the partition check). */
  registeredTarget(entity: EntityName, id: string): string | null | undefined {
    return this.cold.get(entity)?.get(id)
  }

  /** `coldByRule` against the pool's own knowledge. */
  coldRule(entity: EntityName, row: object): boolean {
    return coldByRule(this.schema, entity, row, (to, id) => this.coldTarget(to, id))
  }

  /** Whether the row `to:id` is cold by rule: registered cold, or hot and cold by rule. */
  private coldTarget(to: EntityName, id: string): boolean {
    if (this.isCold(to, id)) return true
    const row = this.hot[to].get(id) as object | undefined
    return row !== undefined && this.coldRule(to, row)
  }

  /**
   * TRACKED: whether `id` is known and cold. When it is, its load is queued:
   * this is the "first access" a derivation makes through a lazy relation.
   */
  loading(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.observe(entity, id)
    if (!this.isCold(entity, id)) return false
    this.request(entity as LoadableEntity, id)
    return true
  }

  /** TRACKED: whether `id` is known and cold, without asking for it. */
  known(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.observe(entity, id)
    return this.isCold(entity, id)
  }

  /** Something a derivation may have read about `id` changed (a plain relation slot). */
  notify(entity: EntityName, id: string): void {
    this.atoms.get(`${entity}:${id}`)?.reportChanged()
  }

  /** Queue `id` for the next load window (arms it if none is open). */
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

  /** Rows queued for a load and not yet taken. */
  queued(): number {
    let rows = 0
    for (const ids of this.queue.values()) rows += ids.size
    return rows
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
   * One live ingest of a cold-capable row (inside the pool's action). The
   * routing is the header's: hot stays hot; known cold stays cold unless its
   * own update says otherwise; a new row goes where the rule says.
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
      else if (this.isCold(entity, id)) this.forget(target, entity, id, out)
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
      this.keepCold(target, entity, id, value, out)
      return
    }
    if (this.isCold(entity, id)) this.unregister(entity, id)
    put(target, entity, id, value, out)
    this.warmDependents(target, entity, id, out)
  }

  /**
   * A `replace` placing one row of the new slice (`reseed`). A row resident
   * before stays resident; any other follows the rule, with `staged` (the new
   * slice) answering for the rows it inherits from.
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
    const coldTarget = (to: EntityName, key: string): boolean => {
      const row = staged(to, key)
      return row !== undefined && coldByRule(this.schema, to, row, coldTarget)
    }
    if (!hot && coldByRule(this.schema, entity, value, coldTarget)) {
      this.keepCold(target, entity, id, value, out)
      return
    }
    if (this.isCold(entity, id)) this.unregister(entity, id)
    put(target, entity, id, value, out)
  }

  /** A cold row left the slice (`replace`, or a removal): unlink and forget it. */
  forget(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
    this.unregister(entity, id)
    target.relations?.changed(entity, id, undefined, undefined)
    out.cold += 1
    this.counters.coldWrites += 1
  }

  /** Install a queued row on access (inside the pool's batch action). */
  hydrate(target: IngestTarget, entity: LoadableEntity, id: string, out: IngestOut): void {
    if (!this.isCold(entity, id)) return
    const value = this.load(entity, id) as StoredRow | undefined
    // Gone from the kernel, its removal not yet published: stays cold until
    // the removal arrives and forgets it.
    if (value === undefined) return
    this.unregister(entity, id)
    put(target, entity, id, value, out)
    this.counters.hydrated += 1
  }

  /** Read a cold row by id (the relation engine's collapse peers). */
  read(entity: EntityName, id: string): object | undefined {
    return this.isCold(entity, id) ? this.load(entity as LoadableEntity, id) : undefined
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
  private keepCold(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow,
    out: IngestOut,
  ): void {
    this.register(entity, id, value)
    target.relations?.changed(entity, id, undefined, value)
    out.cold += 1
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
        const value = this.load(entity as LoadableEntity, dependent) as StoredRow | undefined
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
    const after = viaTargetOf(this.schema, entity, row)?.id ?? null
    ids.set(id, after)
    const byTarget = this.dependents.get(entity)
    if (byTarget !== undefined && before !== after) {
      if (before !== null) unindex(byTarget, before, id)
      if (after !== null) index(byTarget, after, id)
    }
    if (!known) this.atoms.get(`${entity}:${id}`)?.reportChanged()
  }

  private unregister(entity: EntityName, id: string): void {
    const ids = this.cold.get(entity)
    if (ids === undefined || !ids.has(id)) return
    const before = ids.get(id) ?? null
    ids.delete(id)
    const byTarget = this.dependents.get(entity)
    if (byTarget !== undefined && before !== null) unindex(byTarget, before, id)
    this.queue.get(entity as LoadableEntity)?.delete(id)
    if (this.queue.get(entity as LoadableEntity)?.size === 0)
      this.queue.delete(entity as LoadableEntity)
    this.atoms.get(`${entity}:${id}`)?.reportChanged()
  }

  /** Make "is `id` cold" a tracked read: an atom for this id, on first question. */
  private observe(entity: EntityName, id: string): void {
    const key = `${entity}:${id}`
    let atom = this.atoms.get(key)
    if (atom === undefined) {
      const created = createAtom(`pool.cold.${key}`, undefined, () => {
        if (this.atoms.get(key) === created) this.atoms.delete(key)
      })
      this.atoms.set(key, created)
      atom = created
    }
    // Outside any derivation nothing will observe it: do not keep it.
    if (!atom.reportObserved()) this.atoms.delete(key)
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
