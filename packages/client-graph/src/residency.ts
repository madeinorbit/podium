/**
 * POD-4567 (Ma3) — residency: which rows the pool holds in memory, and how a
 * cold row comes in (schema doc §5; audit §7, Linear's partial bootstrap).
 *
 * THE RULE, FROM THE SCHEMA. `schema[entity].cold` decides, per row, whether
 * it may stay out of memory (`coldByRule` in `shared/src/schema.ts`, one
 * rule for both arms, the rebuild and the gate): `own` is the entity's
 * predicate over its row; `unlessShown` adds that nothing can keep the row in
 * the list at the clock (an issue with a `closedAt` and no session or own
 * standing that can show it, POD-4665); `via` inherits it through a declared `belongsTo`: the row is
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
 * every bucket holds the ids of hot and cold members alike, and the fields the
 * engine needs of it again (a collapse peer) it keeps from that row
 * (`relations.ts`, POD-4753): the engine never reads a cold row by id.
 *
 * HOW A ROW BECOMES HOT, and nothing else makes it so. A row whose value the
 * publication at hand carries (the update or `replace` being applied) is
 * installed at once from it; any other row is ASKED FOR: queued for the load
 * window like a first access, and it answers `LOADING` until the window's one
 * action installs it. No path reads a row by id inside a feed event
 * (POD-4753): the window is the only loader.
 * 1. First access. A derivation that reaches a cold row through a lazy
 *    relation (`loading`) gets `true` and queues the row; the first request
 *    arms a 50 ms window, and every row requested inside it is read by id
 *    through the feed (`RowSource.row`, the kernel's `replica.row`) and
 *    installed in ONE action when it closes. Duplicates coalesce. A derivation
 *    cannot write state (MobX), which is why the load is deferred at all.
 * 2. An update that makes the row itself not cold (an issue reopened): the
 *    update carries the value, so it is installed at once, and the rows that
 *    inherited coldness from it (its sessions) are asked for, all in one
 *    window (`warmDependents`). Removing a row warms its dependents too: with
 *    the target gone, nothing makes them cold. A row the window installs
 *    warms its own dependents the same way, if the rule no longer keeps it.
 * 3. A member that can keep it shown (POD-4665): the issue's rule is
 *    `unlessShown`, so a session whose deadline (`keptBy.keep`) has not passed
 *    keeps its closed issue resident. Every member row's deadline is indexed
 *    here by its raw foreign key (plain maps, ids and numbers, no row); a
 *    member ingest that can keep a COLD row shown marks it, and once the
 *    publication's rows are in (`settle`) that row is warmed with its
 *    dependents (`warm`: from the publication, else asked for). A cold row's `finishOf`
 *    is kept beside its id, so deciding it reads nothing. Deadlines only
 *    pass, so the clock never makes a cold row hot.
 *    The rule's `lane` source (R3, POD-4745) keeps an issue shown by the
 *    issueless sessions its own checkout seats. Which sessions those are is
 *    the relation engine's maintained subset (`lanes`), not a row
 *    field, so every way a session can JOIN one (a new or moved cwd, a lost
 *    `issueId`, a twin collapse flipping, a root appearing or disappearing)
 *    arrives as the engine's join delta (`laneJoined`), and a session's own
 *    update re-checks its lane; both are settled once the publication's rows
 *    are in (`settle`), where a member that can keep a COLD owner of its
 *    lane shown warms it exactly as above. Only this deadline map and the
 *    owners of the one lane are read.
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

import { _isComputingDerivation, createAtom, type IAtom } from 'mobx'
import {
  type ColdContext,
  coldByRule,
  coldFinishOf,
  coldFlatUntil,
  type EntityName,
  type KeptBySpec,
  keepDeadline,
  keptByKey,
  keeperEntities,
  keeperOf,
  type LaneSource,
  laneKeepOf,
  laneSources,
  type MemberKeep,
  type ModelSchema,
  viaTargetOf,
} from './shared/schema'
import { drop, type IngestOut, type IngestTarget, put, type StoredRow } from './tables'

/** The kinds the feed can read by id (`RowSource.row`). */
export type LoadableEntity = 'issue' | 'session'

/** A per-row read: the row's current value, or undefined when it is gone. */
export type LoadRow = (entity: LoadableEntity, id: string) => object | undefined

export type ResolveIssueReferences = (refs: readonly string[]) => Promise<readonly { ref: string; id: string | null }[]>

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
  readonly hot: { readonly [E in EntityName]: { get(id: string): unknown } }
  /** The pool's one reader, in maintenance mode; cold rows use their summary instead. */
  readonly residentRow?: (entity: EntityName, id: string) => object | undefined
  readonly load: LoadRow
  /** The slice clock (`coarseNow`): what an `unlessShown` rule's deadlines are read against. */
  readonly now: () => number
  readonly windowMs?: number
  readonly schedule?: Schedule
  /**
   * The relation engine, as the rule's `lane` source reads it (POD-4745): a
   * collection's members at a target (this action's moves included), a
   * collection's declared subset, and a link's raw forward. Read
   * lazily: the engine is built after residency. Without it a `lane` source
   * keeps nothing.
   */
  readonly lanes?: () => LaneReader
  /**
   * POD-4753 — per entity, the fields its readers need of a row that is cold
   * BY THE RULE (so hidden: nothing can show it): a small declared summary,
   * kept beside the cold id from the row ingest hands over (`summary`), never
   * the row itself.
   */
  readonly summaries?: Partial<Readonly<Record<EntityName, readonly string[]>>>
}

/** What a `lane` source reads of the relation engine (uncounted maintenance reads). */
export interface LaneReader {
  members(from: EntityName, id: string, relation: string): readonly string[]
  subset(from: EntityName, id: string, relation: string, subset: string): Iterable<string>
  forwardTarget(from: EntityName, id: string, relation: string): string | null
}

/** What residency did since the last `reset()`. */

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

export class Residency {
  readonly windowMs: number
  private readonly schema: ModelSchema
  private readonly hot: ResidencyOptions['hot']
  private readonly residentRow: NonNullable<ResidencyOptions['residentRow']>
  private readonly load: LoadRow
  private readonly clock: () => number
  private readonly schedule: Schedule
  private readonly summaryFields: Partial<Readonly<Record<EntityName, readonly string[]>>>
  /** `entity:id` → the declared summary of a cold row (entities that declare one). */
  private readonly summaries = new Map<string, Readonly<Record<string, unknown>>>()
  /** Entities whose rows can keep an `unlessShown` row resident (the schema's `keptBy`). */
  private readonly keeperKinds: ReadonlySet<EntityName>
  /** Per `members` source: owner id → member id → how long it keeps the owner shown, for EVERY known member row. */
  private readonly keeps = new Map<KeptBySpec, Map<string, Map<string, MemberKeep>>>()
  /** `member:id` → the source and owner id it is indexed under. */
  private readonly keeperKey = new Map<string, { source: KeptBySpec; owner: string; to: EntityName }>()
  /** The schema's `lane` sources (R3, POD-4745). */
  private readonly laneSources: readonly LaneSource[]
  /** Per `lane` source: member id → how long it keeps the owners of its lane shown, for every UNOWNED member row. */
  private readonly laneKeeps = new Map<KeptBySpec, Map<string, MemberKeep>>()
  /** Per `lane` source: members whose lane may keep a cold owner shown, settled by `settleLanes`. */
  private readonly laneDirty = new Map<LaneSource, Set<string>>()
  private readonly lanes: () => LaneReader | null
  /**
   * A `replace`'s rule over the new slice while it is being placed (`reindex`
   * → `replaced`): the staged rows, the members index, and no lane (the
   * engine holds the new lanes only once every row is placed).
   */
  private placing: ColdContext | null = null
  /** A cold `unlessShown` row's `finishOf`, kept with its id (its members decay from it). */
  private readonly finish = new Map<string, { finish: number | null; shownUntil: number }>()
  /** Changed ancestors, only until this publication settles; no known-row index. */
  private readonly ancestorDirty = new Map<EntityName, Set<string>>()
  /** The highest clock seen (`now`). */
  private high = Number.NEGATIVE_INFINITY
  /** Per cold-capable entity: cold id → the id it inherits from (`via`), else null. */
  private readonly cold = new Map<EntityName, Map<string, string | null>>()
  /** Per `via` entity: inherited-from id → its cold rows. */
  private readonly dependents = new Map<EntityName, Map<string, Set<string>>>()
  /** `via` entities by the entity they inherit from. */
  private readonly inheritors = new Map<EntityName, EntityName[]>()
  /** Header-only catalog subscriptions, ids only, released when unobserved. */
  private readonly idAtoms = new Map<EntityName, IAtom>()
  /** One atom per `entity:id` a derivation has asked about, while observed. */
  private readonly atoms = new Map<string, IAtom>()
  private readonly queue = new Map<LoadableEntity, Set<string>>()
  private readonly referenceQueue = new Set<string>()
  private cancel: (() => void) | null = null
  /** Runs a closed window's batch (the pool's action). */
  private due: () => void = () => {}
  /**
   * The rows the publication being applied carries (an update's records, a
   * `replace`'s staged rows): a warm installs from here before it asks.
   * Null between publications and inside the load window.
   */
  private inHand: ((entity: EntityName, id: string) => StoredRow | undefined) | null = null
  /** Cold rows a member ingest can keep shown, warmed once the publication's rows are in (`settle`). */
  private readonly kept = new Map<string, [EntityName, string]>()

  constructor(options: ResidencyOptions) {
    this.schema = options.schema
    this.hot = options.hot
    this.residentRow = options.residentRow ?? ((entity, id) => this.hot[entity].get(id) as object | undefined)
    this.load = options.load
    this.clock = options.now
    this.keeperKinds = keeperEntities(this.schema)
    this.laneSources = laneSources(this.schema)
    const lanes = options.lanes
    this.lanes = lanes === undefined ? () => null : lanes
    for (const lane of this.laneSources) {
      this.laneKeeps.set(lane.source, new Map())
      this.laneDirty.set(lane, new Set())
    }
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
      this.ancestorDirty.set(kind, new Set())
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

  /** Cold ids of `entity` (the gate's partition check). */
  ids(entity: EntityName, tracked = false): readonly string[] {
    if (tracked && _isComputingDerivation()) {
      let atom = this.idAtoms.get(entity)
      let fresh = false
      if (!atom) {
        const created = createAtom(`residency.ids.${entity}`, undefined, () => {
          if (this.idAtoms.get(entity) === created) this.idAtoms.delete(entity)
        })
        atom = created
        this.idAtoms.set(entity, atom)
        fresh = true
      }
      if (!atom.reportObserved() && fresh) this.idAtoms.delete(entity)
    }
    return [...(this.cold.get(entity)?.keys() ?? [])]
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

  /** `coldByRule` against the pool's own knowledge. */
  coldRule(entity: EntityName, row: object): boolean {
    return coldByRule(this.schema, entity, row, this.context())
  }

  /** The pool's answers to the rule: what it holds, its member indexes, its lanes, its clock. */
  private context(): ColdContext {
    return {
      now: this.now(),
      summary: (entity, id) => this.ruleSummary(entity, id),
      coldTarget: (to, id) => this.coldTarget(to, id),
      keeps: (_entity, source, key) => this.keepsAt(source, key),
    }
  }

  /** The declared placement summary; cold rows never require a row read. */
  private ruleSummary(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    const input = this.inHand?.(entity, id)
    if (input === undefined && this.isCold(entity, id)) return this.summaries.get(`${entity}:${id}`)
    const row = input ?? this.residentRow(entity, id)
    if (row === undefined) return this.summaries.get(`${entity}:${id}`)
    const spec = this.schema[entity].cold
    if (spec.kind !== 'unlessShown' || spec.canShow === undefined) return undefined
    const fields = row as Readonly<Record<string, unknown>>
    return Object.fromEntries(spec.canShow.fields.map((field) => [field, fields[field]]))
  }

  private canShow(entity: EntityName, id: string): boolean {
    const spec = this.schema[entity].cold
    const summary = this.ruleSummary(entity, id)
    return spec.kind !== 'unlessShown' || spec.canShow === undefined || summary === undefined ||
      spec.canShow.test(summary, this.context())
  }

  /** Recheck only the raw-tree descendants of changed ancestors, using existing relation buckets. */
  private settleAncestors(target: IngestTarget, out: IngestOut): void {
    const reader = this.lanes()
    if (reader === null) return
    for (const [entity, dirty] of this.ancestorDirty) {
      const spec = this.schema[entity].cold
      if (spec.kind !== 'unlessShown' || spec.canShow === undefined) continue
      const through = this.schema[entity].relations[spec.canShow.through]
      if (through?.kind !== 'belongsTo') continue
      const todo = [...dirty]
      dirty.clear()
      const seen = new Set<string>()
      while (todo.length > 0) {
        const ancestor = todo.pop()!
        if (seen.has(ancestor)) continue
        seen.add(ancestor)
        for (const child of reader.members(entity, ancestor, through.inverse)) {
          todo.push(child)
          if (!this.isCold(entity, child) || !this.canShow(entity, child)) continue
          const summary = this.ruleSummary(entity, child)
          const bound = this.finish.get(`${entity}:${child}`)
          if (summary === undefined || bound === undefined) continue
          const ctx = this.context()
          const kept = ctx.now <= bound.shownUntil || spec.keptBy.some((source) => {
            const key = keptByKey(this.schema, entity, { ...summary, [this.schema[entity].key]: child }, source)
            return key !== null && [...ctx.keeps(entity, source, key)].some(
              (keep) => ctx.now <= keepDeadline(keep, bound.finish),
            )
          })
          if (kept) this.warm(target, entity, child, out)
        }
      }
      // Warming a descendant marks it too; this traversal already visited its children.
      dirty.clear()
    }
  }

  /**
   * The keeps `source` holds at `key`: a `members` source from its index; a
   * `lane` source from the engine's issueless set of the lane named `key`
   * (the lane's own members, never a scan) and each one's indexed deadline.
   */
  private keepsAt(source: KeptBySpec, key: string): Iterable<MemberKeep> {
    if (source.kind === 'members') return this.keeps.get(source)?.get(key)?.values() ?? []
    const lane = this.laneSources.find((found) => found.source === source)
    const reader = this.lanes()
    if (lane === undefined || reader === null) return []
    const deadlines = this.laneKeeps.get(source) as Map<string, MemberKeep>
    const out: MemberKeep[] = []
    for (const member of reader.subset(lane.lane, key, lane.relation, lane.subsetName)) {
      const keep = deadlines.get(member)
      if (keep !== undefined) out.push(keep)
    }
    return out
  }

  /** Whether the row `to:id` is cold by rule: registered cold, or hot and cold by rule. */
  private coldTarget(to: EntityName, id: string): boolean {
    if (this.isCold(to, id)) return true
    const row = this.residentRow(to, id)
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

  /**
   * TRACKED: whether `id` is cold BY THE RULE, so hidden: nothing can show it
   * (POD-4745's complete rule).
   */
  hidden(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.observe(entity, id)
    return this.isCold(entity, id)
  }

  /** TRACKED: the declared summary of a cold row (`ResidencyOptions.summaries`), else undefined. */
  summary(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    if (!this.capable(entity)) return undefined
    this.observe(entity, id)
    const key = `${entity}:${id}`
    const summary = this.summaries.get(key)
    const bound = this.finish.get(key)
    return summary === undefined || bound === undefined ? summary :
      { ...summary, flatUntil: coldFlatUntil(this.schema, entity, id, summary, bound, this.context()) }
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

  /** One bounded identity query per closed window, without walking the rest
   * of the queue. Remaining references join the next existing load window. */
  takeReferences(): string[] {
    const batch: string[] = []
    for (const ref of this.referenceQueue) {
      this.referenceQueue.delete(ref)
      batch.push(ref)
      if (batch.length === 200) break
    }
    if (this.referenceQueue.size) this.arm()
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
    const previous = target.read[entity].get(id) as StoredRow | undefined
    const spec = this.schema[entity].cold
    if (spec.kind === 'unlessShown' && spec.canShow !== undefined) {
      const summary = this.summaries.get(`${entity}:${id}`)
      const bound = this.finish.get(`${entity}:${id}`)
      const row = value as Readonly<Record<string, unknown>> | undefined
      const before = previous as Readonly<Record<string, unknown>> | undefined
      // A cursor or timestamp can change without changing any visibility bound.
      const changed = row === undefined || (before === undefined
        ? summary === undefined || bound === undefined ||
          spec.canShow.fields.some((field) => summary[field] !== row[field]) ||
          bound.shownUntil !== spec.shownUntil(row) || bound.finish !== spec.finishOf(row)
        : spec.canShow.fields.some((field) => before[field] !== row[field]) ||
          spec.predicate(before) !== spec.predicate(row) ||
          spec.shownUntil(before) !== spec.shownUntil(row) || spec.finishOf(before) !== spec.finishOf(row))
      if (changed) this.ancestorDirty.get(entity)?.add(id)
    }
    if (this.keeperKinds.has(entity)) this.member(target, entity, id, value, out)
    const hot = previous !== undefined
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
   * A `replace` placing one row of the new slice (`reseed`, between `reindex`
   * and `replaced`). A row resident before stays resident; any other follows
   * the rule over the new slice (`reindex`), which answers for the rows it
   * inherits from and its members; what its lane keeps is settled once every
   * row is placed (`replaced`).
   */
  place(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow,
    out: IngestOut,
  ): void {
    const hot = target.read[entity].get(id) !== undefined
    const ctx = this.placing
    if (ctx === null) throw new Error('[pool] place() outside a replace (reindex first)')
    const byRule = !hot && coldByRule(this.schema, entity, value, ctx)
    if (byRule) {
      this.keepCold(target, entity, id, value, out)
      return
    }
    if (this.isCold(entity, id)) this.unregister(entity, id)
    put(target, entity, id, value, out)
  }

  /** A cold row left the slice (`replace`, or a removal): unlink and forget it. */
  forget(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
    this.unregister(entity, id)
    if (entity === 'issue') target.volatile?.removeIssueRead(id)
    target.relations?.changed(entity, id, undefined, undefined)
    // Reported as removed, like a table drop: the pool releases the row's
    // model (it can never be asked for as the same row again).
    out.removed.push([entity, id])
  }

  /**
   * A closed window's rows (inside the pool's batch action): each one still
   * cold is read by id and installed. Then every row installed whose rule no
   * longer holds warms the rows that inherit from it (asked for: the next
   * window), and the lanes the new rows moved are settled. Returns how many
   * rows the window installed.
   */
  install(target: IngestTarget, batch: readonly [LoadableEntity, string][], out: IngestOut): number {
    const installed: [LoadableEntity, string][] = []
    for (const [entity, id] of batch) {
      if (!this.isCold(entity, id)) continue
      const value = this.load(entity, id) as StoredRow | undefined
      // Gone from the kernel, its removal not yet published: stays cold until
      // the removal arrives and forgets it.
      if (value === undefined) continue
      this.unregister(entity, id)
      put(target, entity, id, value, out)
      this.ancestorDirty.get(entity)?.add(id)
      installed.push([entity, id])
    }
    // After the whole batch: a dependent that landed with its target is no
    // longer registered, so only the ones still cold are asked for.
    for (const [entity, id] of installed) this.warmDependents(target, entity, id, out)
    this.settle(target, out)
    return installed.length
  }

  /** Read a cold row by id: the one reader's `peek` (`MobxPool.row`), and nothing else. */
  read(entity: EntityName, id: string): object | undefined {
    return this.isCold(entity, id) ? this.load(entity as LoadableEntity, id) : undefined
  }

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

  /** Forget everything (the pool's dispose). */
  clear(): void {
    this.referenceQueue.clear()
    this.cancel?.()
    this.cancel = null
    this.queue.clear()
    for (const [entity, ids] of this.cold) {
      if (ids.size) this.idAtoms.get(entity)?.reportChanged()
      ids.clear()
    }
    for (const byTarget of this.dependents.values()) byTarget.clear()
    this.keeps.clear()
    this.keeperKey.clear()
    for (const deadlines of this.laneKeeps.values()) deadlines.clear()
    for (const dirty of this.laneDirty.values()) dirty.clear()
    this.placing = null
    this.inHand = null
    this.kept.clear()
    this.finish.clear()
    for (const dirty of this.ancestorDirty.values()) dirty.clear()
    this.summaries.clear()
  }

  /**
   * A `replace` (`reseed`), before any row is placed: the member indexes over
   * the NEW slice (each member row read once, as an update would), and the
   * rule that places its rows: the staged rows for what a row inherits from,
   * the members index, and no lane. The engine's lanes move only as rows are
   * placed, so a lane cannot answer here; `replaced` settles them after.
   */
  reindex(staged: (entity: EntityName) => ReadonlyMap<string, unknown>): void {
    this.keeps.clear()
    this.keeperKey.clear()
    for (const deadlines of this.laneKeeps.values()) deadlines.clear()
    for (const entity of this.keeperKinds) {
      for (const [id, row] of staged(entity)) {
        // A row with an explicit owner is no lane member: read it once.
        const keeper = this.indexMember(entity, id, row as object)
        this.indexLane(entity, id, keeper === null ? (row as object) : undefined)
      }
    }
    const ctx: ColdContext = {
      now: this.now(),
      summary: (entity, id) => {
        const row = staged(entity).get(id) as Readonly<Record<string, unknown>> | undefined
        const spec = this.schema[entity].cold
        return row === undefined || spec.kind !== 'unlessShown' || spec.canShow === undefined ? undefined :
          Object.fromEntries(spec.canShow.fields.map((field) => [field, row[field]]))
      },
      coldTarget: (to, key) => {
        const row = staged(to).get(key) as object | undefined
        return row !== undefined && coldByRule(this.schema, to, row, ctx)
      },
      keeps: (_entity, source, key) =>
        source.kind === 'members' ? (this.keeps.get(source)?.get(key)?.values() ?? []) : [],
    }
    this.placing = ctx
    this.inHand = (entity, id) => staged(entity).get(id) as StoredRow | undefined
  }

  /**
   * A `replace` has placed every row, and the engine holds the new slice's
   * lanes: every unowned member whose deadline can still keep is checked
   * against its lane (`settleLanes`), so a row only its lane keeps is warmed
   * in the same action. Engine reads only (the lanes' own members and
   * owners), never a second pass over the rows.
   */
  replaced(target: IngestTarget, out: IngestOut): void {
    this.placing = null
    const now = this.now()
    for (const lane of this.laneSources) {
      const dirty = this.laneDirty.get(lane) as Set<string>
      dirty.clear()
      for (const [member, keep] of this.laneKeeps.get(lane.source) ?? []) {
        if (typeof keep === 'function' || now <= keep) dirty.add(member)
      }
    }
    this.settle(target, out)
  }

  /**
   * The engine moved `member` into `subset` of `collection` (POD-4745,
   * POD-4758): a lane whose source counts that subset may now be kept by it.
   * Settled with the publication (`settleLanes`), never inside the engine's
   * own maintenance.
   */
  laneJoined(collection: string, subset: string, member: string): void {
    for (const lane of this.laneSources) {
      if (`${lane.lane}.${lane.relation}` !== collection || lane.subsetName !== subset) continue
      this.laneDirty.get(lane)?.add(member)
    }
  }

  /**
   * The publication's rows are in (inside its action, or the load window's):
   * warm every COLD row a member ingest marked as kept, then every COLD owner
   * a lane's member can now keep shown: for each member that joined a lane or
   * changed, its current lane (the engine's forward), when the engine counts
   * it there (issueless, not collapsed), and each cold owner checked out at
   * that lane whose finish its deadline has not passed. A warm installed from
   * the publication can move lanes again, so it runs until nothing is left.
   * Then the publication is over: nothing is at hand.
   */
  settle(target: IngestTarget, out: IngestOut): void {
    for (const [entity, id] of this.kept.values()) {
      if (this.isCold(entity, id)) this.warm(target, entity, id, out)
    }
    this.kept.clear()
    this.settleLanes(target, out)
    this.settleAncestors(target, out)
    this.inHand = null
  }

  private settleLanes(target: IngestTarget, out: IngestOut): void {
    const reader = this.lanes()
    if (reader === null) return
    for (;;) {
      let work: [LaneSource, string] | null = null
      for (const [lane, dirty] of this.laneDirty) {
        const first = dirty.values().next()
        if (first.done === true) continue
        dirty.delete(first.value)
        work = [lane, first.value]
        break
      }
      if (work === null) return
      const [lane, member] = work
      const keep = this.laneKeeps.get(lane.source)?.get(member)
      if (keep === undefined) continue
      const at = reader.forwardTarget(lane.member, member, lane.prefixName)
      if (at === null) continue
      let counted = false
      for (const id of reader.subset(lane.lane, at, lane.relation, lane.subsetName)) {
        if (id === member) {
          counted = true
          break
        }
      }
      if (!counted) continue
      for (const owner of reader.members(lane.lane, at, lane.owners)) {
        this.ancestorDirty.get(lane.owner)?.add(owner)
        this.notify(lane.owner, owner)
        if (!this.isCold(lane.owner, owner)) continue
        const finish = this.finish.get(`${lane.owner}:${owner}`)?.finish ?? null
        if (this.now() > keepDeadline(keep, finish)) continue
        this.warm(target, lane.owner, owner, out)
      }
    }
  }

  /**
   * A member row's ingest (POD-4665): re-index what it keeps, and when it can
   * keep a COLD row shown at the clock, mark that row: once the publication's
   * rows are in (`settle`) it is warmed with the rows that inherit from it
   * (this one among them). Nothing is read to decide: the member's deadline
   * and the cold row's `finishOf` are both held.
   */
  private member(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow | undefined,
    out: IngestOut,
  ): void {
    const priorKey = this.keeperKey.get(`${entity}:${id}`)
    const priorKeep = priorKey === undefined ? undefined : this.keeps.get(priorKey.source)?.get(priorKey.owner)?.get(id)
    this.unindexMember(entity, id)
    const keeper = value === undefined ? null : this.indexMember(entity, id, value)
    if (priorKey !== undefined && (keeper === null || keeper.id !== priorKey.owner || priorKeep !== keeper.keep)) {
      this.notify(priorKey.to, priorKey.owner)
    }
    if (keeper !== null && (priorKey?.owner !== keeper.id || priorKeep !== keeper.keep)) {
      this.ancestorDirty.get(keeper.to)?.add(keeper.id)
      this.notify(keeper.to, keeper.id)
    }
    // A lane member's deadline (a row with an explicit owner is none), and a
    // re-check of its lane once the publication is in when it can keep: its
    // own update can extend how long.
    if (this.indexLane(entity, id, keeper === null ? value : undefined)) {
      for (const lane of this.laneSources) {
        if (lane.member === entity) this.laneDirty.get(lane)?.add(id)
      }
    }
    if (keeper === null || !this.isCold(keeper.to, keeper.id)) return
    const finish = this.finish.get(`${keeper.to}:${keeper.id}`)?.finish ?? null
    if (this.now() > keepDeadline(keeper.keep, finish)) return
    this.kept.set(`${keeper.to}:${keeper.id}`, [keeper.to, keeper.id])
  }

  /**
   * The cold row `entity:id` is no longer cold by rule (a member keeps it
   * shown, its target reopened or left): installed from the publication at
   * hand, else asked for. The rows that inherit coldness from it follow it
   * the same way, so what the publication does not carry lands in ONE window.
   */
  private warm(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
    if (!this.canShow(entity, id)) return
    const row = this.inHand?.(entity, id)
    if (row !== undefined) {
      this.unregister(entity, id)
      put(target, entity, id, row, out)
      this.ancestorDirty.get(entity)?.add(id)
    } else {
      this.request(entity as LoadableEntity, id)
    }
    for (const inheritor of this.inheritors.get(entity) ?? []) {
      const ids = this.dependents.get(inheritor)?.get(id)
      if (ids !== undefined) for (const dependent of [...ids]) this.warm(target, inheritor, dependent, out)
    }
  }

  private indexMember(entity: EntityName, id: string, row: object): ReturnType<typeof keeperOf> {
    const keeper = keeperOf(this.schema, entity, row)
    if (keeper === null) return null
    let byOwner = this.keeps.get(keeper.source)
    if (byOwner === undefined) {
      byOwner = new Map()
      this.keeps.set(keeper.source, byOwner)
    }
    let members = byOwner.get(keeper.id)
    if (members === undefined) {
      members = new Map()
      byOwner.set(keeper.id, members)
    }
    members.set(id, keeper.keep)
    this.keeperKey.set(`${entity}:${id}`, { source: keeper.source, owner: keeper.id, to: keeper.to })
    return keeper
  }

  private unindexMember(entity: EntityName, id: string): void {
    const key = this.keeperKey.get(`${entity}:${id}`)
    if (key === undefined) return
    this.keeperKey.delete(`${entity}:${id}`)
    const byOwner = this.keeps.get(key.source)
    const members = byOwner?.get(key.owner)
    members?.delete(id)
    if (members?.size === 0) byOwner?.delete(key.owner)
  }

  /**
   * Index (or, with no row, drop) `entity:id`'s deadline under every `lane`
   * source it is a member entity of. True when it is an unowned member whose
   * deadline has not passed at the clock (a function of its owner's finish
   * may not have): only then can it keep anything.
   */
  private indexLane(entity: EntityName, id: string, row: object | undefined): boolean {
    let live = false
    for (const lane of this.laneSources) {
      if (lane.member !== entity) continue
      const deadlines = this.laneKeeps.get(lane.source) as Map<string, MemberKeep>
      const keep = row === undefined ? null : laneKeepOf(lane, row)
      const previous = deadlines.get(id)
      if (keep === null) deadlines.delete(id)
      else {
        deadlines.set(id, keep)
        if (previous !== keep && (typeof keep === 'function' || this.now() <= keep)) live = true
      }
    }
    return live
  }

  /** Relink a cold row with its new value, keeping only its id (and its declared summary). */
  private keepCold(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow,
    out: IngestOut,
  ): void {
    this.register(entity, id, value)
    if (entity === 'issue') target.volatile?.setIssueRead(id, value)
    target.relations?.changed(entity, id, undefined, value)
  }

  /**
   * The rows that inherit coldness from `to:id` and are no longer cold by
   * rule (it reopened, left, or landed while kept): each is warmed.
   */
  private warmDependents(target: IngestTarget, to: EntityName, id: string, out: IngestOut): void {
    const entities = this.inheritors.get(to)
    if (entities === undefined || this.coldTarget(to, id)) return
    for (const entity of entities) {
      const ids = this.dependents.get(entity)?.get(id)
      if (ids === undefined) continue
      for (const dependent of [...ids]) this.warm(target, entity, dependent, out)
    }
  }

  private register(entity: EntityName, id: string, row: object): void {
    const ids = this.cold.get(entity) as Map<string, string | null>
    const added = !ids.has(id)
    const before = ids.get(id) ?? null
    const after = viaTargetOf(this.schema, entity, row)?.id ?? null
    ids.set(id, after)
    if (added) this.idAtoms.get(entity)?.reportChanged()
    const key = `${entity}:${id}`
    if (this.schema[entity].cold.kind === 'unlessShown') {
      const spec = this.schema[entity].cold
      if (spec.kind === 'unlessShown') this.finish.set(`${entity}:${id}`, {
        finish: coldFinishOf(this.schema, entity, row),
        shownUntil: spec.shownUntil(row as Readonly<Record<string, unknown>>),
      })
    }
    const fields = this.summaryFields[entity]
    if (fields !== undefined) {
      const values = row as Readonly<Record<string, unknown>>
      const summary: Record<string, unknown> = {}
      for (const field of fields) {
        const value = values[field]
        if (value !== undefined) summary[field] = value
      }
      this.summaries.set(key, summary)
    }
    const byTarget = this.dependents.get(entity)
    if (byTarget !== undefined && before !== after) {
      if (before !== null) unindex(byTarget, before, id)
      if (after !== null) index(byTarget, after, id)
    }
    // A relink is a new value too: a derivation that read the cold row by id
    // (`MobxPool.row` in `peek`, POD-4569) must see it.
    this.atoms.get(`${entity}:${id}`)?.reportChanged()
  }

  private unregister(entity: EntityName, id: string): void {
    const ids = this.cold.get(entity)
    if (ids === undefined || !ids.has(id)) return
    const before = ids.get(id) ?? null
    ids.delete(id)
    this.idAtoms.get(entity)?.reportChanged()
    this.finish.delete(`${entity}:${id}`)
    this.summaries.delete(`${entity}:${id}`)
    const byTarget = this.dependents.get(entity)
    if (byTarget !== undefined && before !== null) unindex(byTarget, before, id)
    this.queue.get(entity as LoadableEntity)?.delete(id)
    if (this.queue.get(entity as LoadableEntity)?.size === 0)
      this.queue.delete(entity as LoadableEntity)
    this.atoms.get(`${entity}:${id}`)?.reportChanged()
  }

  /** Make "is `id` cold" a tracked read: an atom for this id, on first question. */
  private observe(entity: EntityName, id: string): void {
    // Maintenance reads the same declared summaries through the same reader,
    // but cannot acquire a subscription. Avoid creating an atom only to drop
    // it immediately on every ingest/owner filing probe.
    if (!_isComputingDerivation()) return
    const key = `${entity}:${id}`
    let atom = this.atoms.get(key)
    let fresh = false
    if (atom === undefined) {
      const created = createAtom(`pool.cold.${key}`, undefined, () => {
        if (this.atoms.get(key) === created) this.atoms.delete(key)
      })
      this.atoms.set(key, created)
      atom = created
      fresh = true
    }
    // Outside any derivation nothing will observe an atom made just now: do
    // not keep it. An atom made earlier is kept whatever this read is: a
    // derivation may observe it, and dropping it would leave that derivation
    // deaf to the row's next change (POD-4569: an untracked presence check
    // between two steps, the gate's partition check, orphaned a visibility
    // node's atom). It drops itself once unobserved (`onBecomeUnobserved`).
    if (!atom.reportObserved() && fresh) this.atoms.delete(key)
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
