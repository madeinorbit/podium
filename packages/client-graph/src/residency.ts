/**
 * POD-4567 (Ma3) — residency: which rows the pool holds in memory, and how a
 * cold row comes in (schema doc §5; audit §7, Linear's partial bootstrap).
 *
 * THE RULE, FROM THE SCHEMA. `schema[entity].cold` decides, per row, whether
 * it may stay out of memory (`coldByRule` in `shared/src/schema.ts`, one
 * rule for both arms, the rebuild and the gate): `own` is the entity's
 * predicate over its row; `unlessShown` adds that nothing can keep the row in
 * the list at the clock (an issue with a `closedAt` and no session or own
 * standing that can show it, POD-4665); `via` inherits it through a declared
 * `belongsTo`: the row is cold when the foreign key names a known row that is
 * itself cold by rule (a session of a closed issue). `never` is always
 * resident. No entity or field is named here.
 *
 * POD-5407 — NO REGISTRY. The rule is evaluated by the row source's cold
 * index (`shared/cold-index.ts`), which holds the rule's inputs for every row
 * the feed carries, once. A row is COLD here when the index knows it and the
 * pool's tables do not hold it: no table slot, no model, no observable, and
 * nothing kept per row in this module either (the former registry, its
 * summaries, finish bounds, member and lane deadlines and `via` dependents
 * were a second copy of the index: POD-5417 finding 14). What this module
 * keeps per cold row is only what a derivation has ASKED about: one atom
 * while observed, and the ids asked (`ids()`, the gate's view of the cold
 * rows the pool has seen), forgotten at the next attach.
 *
 * ATTACH (`attach`, a `replace`). The pool places the index's resident
 * candidates (the rows not cold by rule at the clock), each read once by id,
 * plus every row of an entity that is never cold. A row resident before and
 * still known stays resident. No other row is visited: the attach is
 * O(resident), not O(history) (POD-5391).
 *
 * HOW A ROW BECOMES HOT, and nothing else makes it so. A row whose value the
 * publication at hand carries is installed at once from it; any other row is
 * ASKED FOR: queued for the load window like a first access, and it answers
 * `LOADING` until the window's one action installs it.
 * 1. First access. A derivation that reaches a cold row through a lazy
 *    relation (`loading`) gets `true` and queues the row; the first request
 *    arms a 50 ms window, and every row requested inside it is read by id
 *    through the feed (`RowSource.row`, the kernel's `replica.row`) and
 *    installed in ONE action when it closes.
 * 2. The rule no longer holds it. Once a publication's rows are in
 *    (`settle`), every cold row whose rule inputs it may have moved is asked
 *    of the index; one that is no longer cold by rule is warmed (from the
 *    publication, else asked for). Those rows are: the publication's own
 *    rows; the owners its member rows name (`keeperOf`); the owners of every
 *    lane whose seated subset moved, or whose member's keep changed; the
 *    descendants of an issue whose `canShow` inputs moved; and the `via`
 *    dependents of any row that is not cold by rule. Each warmed row is
 *    checked the same way, until nothing is left.
 * An update to a cold row that leaves it cold is NOT stored: the kernel and
 * the index hold the value, and a later load reads the current one.
 *
 * NOTHING MAKES A HOT ROW COLD except a `replace` that no longer names it.
 * An issue closed while in memory stays in memory: it was just looked at.
 *
 * TRACKED. Whether a row is cold is state a derivation reads, so it must be
 * tracked (pitfall j), yet an observable per cold row is the cost this module
 * exists to avoid. So each id a derivation asks about gets an atom on that
 * first question, dropped when no derivation observes it: observability on
 * first access, applied to residency itself.
 */

import { createDemandAtoms } from '@podium/mobx-helpers'
import { debugName } from './debug-name'
import type { ColdQueries } from './shared/cold-index'
import type { RelationDelta } from './shared/relation-index'
import {
  type EntityName,
  keeperEntities,
  keeperOf,
  type LaneSource,
  laneSources,
  type ModelSchema,
} from './shared/schema'
import { drop, type IngestOut, type IngestTarget, put, type StoredRow } from './tables'

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

export interface ResidencyOptions {
  readonly schema: ModelSchema
  /** The pool's hot tables, read side. */
  readonly hot: { readonly [E in EntityName]: { get(id: string): unknown; has(id: string): boolean } }
  /** The one per-row read through the feed. */
  readonly load: LoadRow
  /** The cold index (the row source's, or the pool's own), read at every call. */
  readonly index: () => ColdQueries
  /** The slice clock (`coarseNow`): what an `unlessShown` rule's deadlines are read against. */
  readonly now: () => number
  readonly windowMs?: number
  readonly schedule?: Schedule
  /**
   * POD-4753 — per entity, the fields its readers need of a row that is
   * cold: a small declared summary, projected from the row on read (`summary`).
   */
  readonly summaries?: Partial<Readonly<Record<EntityName, readonly string[]>>>
}

/** What an attach placed (POD-5407): the gate's bound on attach work. */
export interface AttachStats {
  /** Rows of cold-capable entities the attach put in the tables. */
  rowsPlaced: number
  /** The index's resident candidates at the attach. */
  candidates: number
}

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

type Row = Readonly<Record<string, unknown>>

export class Residency {
  readonly windowMs: number
  private readonly schema: ModelSchema
  private readonly hot: ResidencyOptions['hot']
  private readonly load: LoadRow
  private readonly index: () => ColdQueries
  private readonly clock: () => number
  private readonly schedule: Schedule
  private readonly summaryFields: Partial<Readonly<Record<EntityName, readonly string[]>>>
  private readonly coldListeners = new Set<(entity: EntityName, id: string) => void>()
  private readonly capableKinds = new Set<EntityName>()
  private readonly keeperKinds: ReadonlySet<EntityName>
  private readonly laneSources: readonly LaneSource[]
  /** Per entity whose `canShow` walks ancestors: the collection its descendants sit in. */
  private readonly descendants = new Map<EntityName, string>()
  /** `via` entities by the entity they inherit from. */
  private readonly inheritors = new Map<EntityName, EntityName[]>()
  /** The highest clock seen (`now`). */
  private high = Number.NEGATIVE_INFINITY
  /** Cold ids a derivation or reader has asked about since the last attach. */
  private readonly asked = new Map<EntityName, Set<string>>()
  /** Header-only catalog subscriptions, ids only, released when unobserved. */
  private readonly idAtoms = createDemandAtoms<EntityName>((entity) => debugName(() => `residency.ids.${entity}`) ?? 'Atom')
  /** One atom per `entity:id` a derivation has asked about, while observed. */
  private readonly atoms = createDemandAtoms<string>((key) => debugName(() => `pool.cold.${key}`) ?? 'Atom')
  /** Declared summaries read this publication (each read once by id). */
  private readonly summaryMemo = new Map<string, Row | undefined>()
  private readonly queue = new Map<LoadableEntity, Set<string>>()
  private readonly referenceQueue = new Set<string>()
  private cancel: (() => void) | null = null
  /** Runs a closed window's batch (the pool's action). */
  private due: () => void = () => {}
  /**
   * The rows the publication being applied carries (an update's records, a
   * `replace`'s rows): a warm installs from here before it asks.
   */
  private inHand: ((entity: EntityName, id: string) => StoredRow | undefined) | null = null
  /**
   * The row being installed right now: no longer cold, not yet in its table.
   * Consumers of cold summaries hear of it in that state (`onColdChange`), as
   * they did when a registry entry was dropped before the row was put.
   */
  private readonly installing = new Set<string>()
  /** Rows to check against the rule once the publication's rows are in. */
  private readonly check = new Map<string, readonly [EntityName, string]>()
  /** Rows this publication carried or installed (their own verdict may have moved). */
  private readonly moved = new Set<string>()
  /** Ancestors whose `canShow` inputs moved this publication. */
  private readonly ancestors = new Map<string, readonly [EntityName, string]>()
  /** The last attach's counts. */
  readonly attachStats: AttachStats = { rowsPlaced: 0, candidates: 0 }

  constructor(options: ResidencyOptions) {
    this.schema = options.schema
    this.hot = options.hot
    this.load = options.load
    this.index = options.index
    this.clock = options.now
    this.keeperKinds = keeperEntities(this.schema)
    this.laneSources = laneSources(this.schema)
    this.windowMs = options.windowMs ?? LOAD_WINDOW_MS
    this.schedule = options.schedule ?? realSchedule
    this.summaryFields = { ...options.summaries }
    for (const [entity, declared] of Object.entries(this.schema)) {
      const spec = declared.cold
      if (spec.kind !== 'unlessShown' || spec.canShow === undefined) continue
      const kind = entity as EntityName
      ;(this.summaryFields as Partial<Record<EntityName, readonly string[]>>)[kind] = [
        ...new Set([...(this.summaryFields[kind] ?? []), ...spec.canShow.fields]),
      ]
      const through = declared.relations[spec.canShow.through]
      if (through?.kind === 'belongsTo') this.descendants.set(kind, through.inverse)
    }
    const prefixTargets = new Set<EntityName>()
    for (const spec of Object.values(this.schema)) {
      for (const relation of Object.values(spec.relations)) {
        if (relation.kind === 'prefix') prefixTargets.add(relation.to)
      }
    }
    for (const entity of Object.keys(this.schema) as EntityName[]) {
      const spec = this.schema[entity].cold
      if (spec.kind === 'never') continue
      // A cold row is read back by id through the feed, and a prefix relation
      // is never rooted on it: both would break.
      if (!loadable(entity))
        throw new Error(`[pool] ${entity} can be cold but the feed cannot load it by id`)
      if (prefixTargets.has(entity))
        throw new Error(`[pool] ${entity} can be cold but roots a prefix relation`)
      this.capableKinds.add(entity)
      this.asked.set(entity, new Set())
      if (spec.kind === 'via') {
        const relation = this.schema[entity].relations[spec.relation]
        if (relation?.kind !== 'belongsTo') {
          throw new Error(`[pool] ${entity}.cold.via must name a belongsTo (got ${relation?.kind})`)
        }
        this.inheritors.set(relation.to, [...(this.inheritors.get(relation.to) ?? []), entity])
      }
    }
  }

  /** The pool's batch runner, called when a window closes. */
  onDue(run: () => void): void {
    this.due = run
  }

  /** A cold row came, changed, left, or was installed (consumers of declared summaries). */
  onColdChange(listener: (entity: EntityName, id: string) => void): () => void {
    this.coldListeners.add(listener)
    return () => {
      this.coldListeners.delete(listener)
    }
  }

  /** Whether rows of `entity` can be cold at all. */
  capable(entity: EntityName): boolean {
    return this.capableKinds.has(entity)
  }

  /** Whether `id` is known and cold (plain: maintenance, inside actions). */
  isCold(entity: EntityName, id: string): boolean {
    return this.capable(entity) && !this.hot[entity].has(id) && this.index().known(entity, id) &&
      !this.installing.has(`${entity}:${id}`)
  }

  /**
   * The cold ids of `entity` the pool has seen since the last attach: asked
   * about by a reader, requested, or carried by a publication (the gate's
   * partition check). Never every cold row: the index holds those.
   */
  ids(entity: EntityName, tracked = false): readonly string[] {
    if (tracked) this.idAtoms.observe(entity)
    return [...(this.asked.get(entity) ?? [])].filter((id) => this.isCold(entity, id))
  }

  /**
   * The clock the rule is read against: the highest `coarseNow` seen. The
   * locals channel does not promise monotony (`clock.ts`), and deadlines
   * only pass forward, so a rewind never warms a cold row; a row a rewind
   * shows again loads on first access. The gate's partition check reads this.
   */
  now(): number {
    this.high = Math.max(this.high, this.clock())
    return this.high
  }

  /**
   * `coldByRule` at the pool's clock: for the row in hand when given (it may
   * be newer than the index's), else for the row the index holds.
   */
  coldRule(entity: EntityName, id: string, row?: object): boolean {
    return row === undefined ? this.index().coldByRule(entity, id, this.now()) : this.index().coldRow(entity, row, this.now())
  }

  /**
   * TRACKED: whether `id` is known and cold. When it is, its load is queued:
   * this is the "first access" a derivation makes through a lazy relation.
   */
  loading(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.observe(entity, id)
    if (!this.isCold(entity, id)) return false
    this.see(entity, id)
    this.request(entity as LoadableEntity, id)
    return true
  }

  /** TRACKED: whether `id` is cold, so hidden from the list unless loaded. */
  hidden(entity: EntityName, id: string): boolean {
    return this.known(entity, id)
  }

  /**
   * TRACKED: the declared cold fields of a cold row, read through the one
   * per-row reader (`RowSource.row`) and projected; worklist readers also
   * get `flatUntil` from the index. Undefined for a row in memory or unknown.
   */
  summary(entity: EntityName, id: string, decorate = true): Readonly<Record<string, unknown>> | undefined {
    if (!this.capable(entity)) return undefined
    this.observe(entity, id)
    if (!this.isCold(entity, id)) return undefined
    this.see(entity, id)
    const key = `${entity}:${id}`
    let summary: Row | undefined
    if (this.summaryMemo.has(key)) summary = this.summaryMemo.get(key)
    else {
      const fields = this.summaryFields[entity]
      // The index holds every declared field (the pool names them when it
      // asks for the index). A field it does not hold is never read row by
      // row here: the summary is absent, so the reader answers LOADING and
      // the row comes in through one batched load (the cutoff rule).
      summary = fields === undefined ? undefined : this.index().heldFields(entity, id, fields)
      if (summary === undefined) return undefined
      this.summaryMemo.set(key, summary)
    }
    if (!decorate || summary === undefined) return summary
    const flatUntil = this.index().flatUntil(entity, id, this.now())
    return flatUntil === undefined ? summary : { ...summary, flatUntil }
  }

  /** TRACKED: whether `id` is known and cold, without asking for it. */
  known(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.observe(entity, id)
    const cold = this.isCold(entity, id)
    if (cold) this.see(entity, id)
    return cold
  }

  /** Something a derivation may have read about `id` changed (its row: the summary is read again). */
  notify(entity: EntityName, id: string): void {
    this.summaryMemo.delete(`${entity}:${id}`)
    this.atoms.get(`${entity}:${id}`)?.reportChanged()
  }

  /** Queue `id` for the next load window (arms it if none is open); false when already queued. */
  request(entity: LoadableEntity, id: string): boolean {
    let ids = this.queue.get(entity)
    if (ids === undefined) {
      ids = new Set()
      this.queue.set(entity, ids)
    }
    if (ids.has(id)) return false
    ids.add(id)
    this.arm()
    return true
  }

  /** Unknown reference identities share the existing row-load window. */
  requestReference(ref: string): boolean {
    if (this.referenceQueue.has(ref)) return false
    this.referenceQueue.add(ref)
    this.arm()
    return true
  }

  private arm(): void {
    if (this.cancel === null) {
      this.cancel = this.schedule(() => {
        this.cancel = null
        this.due()
      }, this.windowMs)
    }
  }

  /** Local identity requests share the cold-row window; no transport batch. */
  takeReferences(): string[] {
    const batch = [...this.referenceQueue]
    this.referenceQueue.clear()
    return batch
  }

  /** Close the window now: the queued rows, cleared. */
  take(): [LoadableEntity, string][] {
    this.cancel?.()
    this.cancel = null
    const batch: [LoadableEntity, string][] = []
    for (const [entity, ids] of this.queue) for (const id of ids) batch.push([entity, id])
    this.queue.clear()
    return batch
  }

  /** Read a cold row by id: the one reader's `peek` (`MobxPool.row`), and nothing else. */
  read(entity: EntityName, id: string): object | undefined {
    if (!this.isCold(entity, id)) return undefined
    this.see(entity, id)
    return this.load(entity as LoadableEntity, id)
  }

  // ------------------------------------------------------------ maintenance

  /**
   * An update is about to be applied: its records are the rows at hand until
   * it is settled (`settle`). Read lazily, the last record of a row winning.
   */
  publication(rows: readonly { kind: string; id: string; value?: unknown }[]): void {
    let byKey: Map<string, StoredRow | undefined> | null = null
    this.inHand = (entity, id) => {
      if (byKey === null) {
        byKey = new Map()
        for (const record of rows) byKey.set(`${record.kind}:${record.id}`, record.value as StoredRow | undefined)
      }
      return byKey.get(`${entity}:${id}`)
    }
  }

  /**
   * One live ingest of a cold-capable row (inside the pool's action, after
   * the index applied the publication). Hot stays hot; a row the rule keeps
   * cold is not stored; any other row is installed. What it may warm is
   * checked once every row is in (`settle`).
   */
  ingest(target: IngestTarget, entity: EntityName, id: string, value: StoredRow | undefined, out: IngestOut): void {
    const previous = target.read[entity].get(id) as Row | undefined
    this.marks(entity, id, previous, value as Row | undefined)
    if (value === undefined) {
      if (previous !== undefined) drop(target, entity, id, out)
      else {
        // A cold row left: reported as removed, so its model is released.
        if (entity === 'issue') target.volatile?.removeIssueRead(id)
        out.removed.push([entity, id])
        this.coldChanged(entity, id)
      }
      return
    }
    if (previous !== undefined) {
      put(target, entity, id, value, out)
      return
    }
    if (this.coldRule(entity, id, value)) {
      // Its read cursor is the row's (`MobxPool.readCursor`); none is kept.
      if (entity === 'issue') target.volatile?.removeIssueRead(id)
      this.see(entity, id)
      this.coldChanged(entity, id)
      return
    }
    this.putWarm(target, entity, id, value, out)
  }

  /** A row that was cold (or new) enters its table: its cold consumers hear first. */
  private putWarm(target: IngestTarget, entity: EntityName, id: string, value: StoredRow, out: IngestOut): void {
    const key = `${entity}:${id}`
    this.installing.add(key)
    try {
      this.coldChanged(entity, id)
    } finally {
      this.installing.delete(key)
    }
    put(target, entity, id, value, out)
  }

  /**
   * An attach (`replace`): the index already holds the new slice. Every row
   * in the tables the index no longer knows leaves; every other row of a
   * cold-capable entity stays as it was. The index's resident candidates
   * not in the tables are put, read from the publication at hand when it
   * carries them, else once by id. Nothing else is visited.
   */
  attach(
    target: IngestTarget,
    rows: ((entity: EntityName, id: string) => StoredRow | undefined) | null,
    out: IngestOut,
    unknown?: Iterable<readonly [EntityName, string, StoredRow]>,
  ): AttachStats {
    const index = this.index()
    const now = this.now()
    // The cold rows readers asked about may have left the slice or changed:
    // they hear once the attach is in (as each dropped registry entry used to).
    const asked: [EntityName, string][] = []
    for (const [entity, ids] of this.asked) for (const id of ids) asked.push([entity, id])
    this.clearAsked()
    let placed = 0
    let candidates = 0
    this.inHand = rows
    for (const entity of this.capableKinds) {
      const table = target.write[entity]
      const gone: string[] = []
      for (const id of table.keys()) if (!index.known(entity, id)) gone.push(id)
      for (const id of gone) drop(target, entity, id, out)
      // A row resident before and still in the slice takes its new value.
      if (rows !== null) {
        for (const id of [...table.keys()]) {
          const value = rows(entity, id)
          if (value !== undefined) put(target, entity, id, value, out)
        }
      }
      for (const id of index.residentCandidates(entity, now)) {
        candidates += 1
        if (table.has(id)) continue
        const value = rows?.(entity, id) ?? (this.load(entity as LoadableEntity, id) as StoredRow | undefined)
        if (value === undefined) continue
        this.putWarm(target, entity, id, value, out)
        placed += 1
      }
    }
    // A row handed over that the index does not know is never cold (an
    // unknown row is not cold by the rule): it is resident as it stands.
    for (const [entity, id, value] of unknown ?? []) {
      if (target.write[entity].has(id) || index.known(entity, id)) continue
      put(target, entity, id, value, out)
      placed += 1
    }
    this.inHand = null
    this.attachStats.rowsPlaced = placed
    this.attachStats.candidates = candidates
    this.summaryMemo.clear()
    for (const [entity, id] of asked) if (!target.write[entity].has(id)) this.coldChanged(entity, id)
    for (const atom of [...this.atoms.values()]) atom.reportChanged()
    for (const [entity, atom] of this.idAtoms) if (this.capable(entity)) atom.reportChanged()
    return this.attachStats
  }

  /**
   * A closed window's rows (inside the pool's batch action): each one still
   * cold is read by id and installed. Then the rows that inherited coldness
   * from an installed row are checked against the rule (`settle`). Returns
   * how many rows the window installed.
   */
  install(target: IngestTarget, batch: readonly [LoadableEntity, string][], out: IngestOut): number {
    let installed = 0
    for (const [entity, id] of batch) {
      if (!this.isCold(entity, id)) continue
      const value = this.load(entity, id) as StoredRow | undefined
      // Gone from the kernel, its removal not yet published: stays cold until
      // the removal arrives.
      if (value === undefined) continue
      this.putWarm(target, entity, id, value, out)
      this.mark(entity, id)
      this.moved.add(`${entity}:${id}`)
      this.ancestor(entity, id)
      installed += 1
    }
    this.settle(target, out)
    return installed
  }

  /**
   * The publication's rows are in (inside its action, or the load window's):
   * check every row whose rule inputs it may have moved, and warm the cold
   * ones the rule no longer holds, until nothing is left. Then the
   * publication is over: nothing is at hand.
   */
  settle(target: IngestTarget, out: IngestOut, delta?: RelationDelta): void {
    const index = this.index()
    const relations = index.relations
    // Lanes: a seated subset this publication moved, at its target.
    for (const [key, at] of delta?.subsets ?? []) {
      for (const lane of this.laneSources) {
        if (`${lane.lane}.${lane.relation}.${lane.subsetName}` === key) this.laneOwners(lane, at)
      }
    }
    for (;;) {
      // Descendants of an ancestor whose canShow inputs moved, the whole subtree.
      for (const [key, [entity, id]] of this.ancestors) {
        this.ancestors.delete(key)
        const collection = this.descendants.get(entity)
        if (collection === undefined) continue
        const todo = [id]
        const seen = new Set<string>()
        while (todo.length > 0) {
          const ancestor = todo.pop()!
          if (seen.has(ancestor)) continue
          seen.add(ancestor)
          for (const child of relations.members(entity, ancestor, collection)) {
            todo.push(child)
            this.mark(entity, child)
          }
        }
      }
      const next = this.check.entries().next()
      if (next.done === true) break
      const [key, [entity, id]] = next.value
      this.check.delete(key)
      if (!this.capable(entity)) continue
      const cold = this.isCold(entity, id)
      // A row in memory that did not move keeps its verdict's consequences:
      // only a moved row that others inherit from is asked about.
      if (!cold && (!this.moved.has(key) || !this.inheritors.has(entity))) continue
      const row = this.inHand?.(entity, id)
      if (this.coldRule(entity, id, row)) continue
      // Not cold by rule: what inherits from it is not either.
      for (const inheritor of this.inheritors.get(entity) ?? []) {
        for (const dependent of index.dependents(inheritor, entity, id)) this.mark(inheritor, dependent)
      }
      if (!cold) continue
      if (row !== undefined) {
        this.putWarm(target, entity, id, row, out)
        this.moved.add(key)
        this.ancestor(entity, id)
      } else this.request(entity as LoadableEntity, id)
    }
    this.moved.clear()
    this.inHand = null
  }

  /** Forget everything (the pool's dispose). */
  clear(): void {
    this.referenceQueue.clear()
    this.cancel?.()
    this.cancel = null
    this.queue.clear()
    this.clearAsked()
    this.inHand = null
    this.check.clear()
    this.moved.clear()
    this.ancestors.clear()
    this.summaryMemo.clear()
  }

  // ------------------------------------------------------------ internals

  /** What one record may move: itself, the owner it keeps, its lane's owners, its descendants. */
  private marks(entity: EntityName, id: string, previous: Row | undefined, value: Row | undefined): void {
    this.mark(entity, id)
    this.moved.add(`${entity}:${id}`)
    this.notify(entity, id)
    if (this.keeperKinds.has(entity)) {
      // What a member keeps moved: its owners' cold summaries (`flatUntil`) re-read.
      const before = previous === undefined ? null : keeperOf(this.schema, entity, previous)
      if (before !== null) this.notify(before.to, before.id)
    }
    if (this.keeperKinds.has(entity) && value !== undefined) {
      const keeper = keeperOf(this.schema, entity, value)
      if (keeper !== null) {
        this.mark(keeper.to, keeper.id)
        this.notify(keeper.to, keeper.id)
      }
      for (const lane of this.laneSources) {
        if (lane.member !== entity) continue
        const at = this.index().relations.forward(lane.member, id, lane.prefixName)
        if (at !== null) this.laneOwners(lane, at)
      }
    }
    // A cursor or timestamp can change without moving any visibility bound;
    // a row not in memory has no previous value here, so it counts as moved.
    const spec = this.schema[entity].cold
    if (spec.kind === 'unlessShown' && spec.canShow !== undefined) {
      const moved = previous === undefined || value === undefined ||
        spec.canShow.fields.some((field) => previous[field] !== value[field]) ||
        spec.predicate(previous) !== spec.predicate(value) ||
        spec.shownUntil(previous) !== spec.shownUntil(value) || spec.finishOf(previous) !== spec.finishOf(value)
      if (moved) this.ancestor(entity, id)
    }
    // A removed target leaves its `via` rows bound to nothing known: not cold.
    if (value === undefined) {
      for (const inheritor of this.inheritors.get(entity) ?? []) {
        for (const dependent of this.index().dependents(inheritor, entity, id)) this.mark(inheritor, dependent)
      }
    }
  }

  private laneOwners(lane: LaneSource, at: string): void {
    for (const owner of this.index().relations.members(lane.lane, at, lane.owners)) {
      this.mark(lane.owner, owner)
      this.notify(lane.owner, owner)
    }
  }

  private mark(entity: EntityName, id: string): void {
    this.check.set(`${entity}:${id}`, [entity, id])
  }

  private ancestor(entity: EntityName, id: string): void {
    if (this.descendants.has(entity)) this.ancestors.set(`${entity}:${id}`, [entity, id])
  }

  private coldChanged(entity: EntityName, id: string): void {
    this.notify(entity, id)
    for (const listener of this.coldListeners) listener(entity, id)
  }

  private see(entity: EntityName, id: string): void {
    const asked = this.asked.get(entity)
    if (asked === undefined || asked.has(id)) return
    asked.add(id)
  }

  private clearAsked(): void {
    for (const asked of this.asked.values()) asked.clear()
  }

  /** Make "is `id` cold" a tracked read: an atom for this id, on first question. */
  private observe(entity: EntityName, id: string): void {
    this.atoms.observe(`${entity}:${id}`)
  }
}
