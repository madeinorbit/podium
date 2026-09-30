/**
 * POD-4580 (Ha3) — residency: which rows the hand pool holds, and how a cold
 * row comes in (schema doc §5; audit §7, Linear's partial bootstrap). Written
 * for this arm after the MobX build (Ma3, POD-4567) and to its contract: the
 * same rule, the same transitions, the same 50 ms window, the same shared
 * seams (`RowSource.row`, `RowView.loading`).
 *
 * THE RULE, FROM THE SCHEMA. `coldByRule` (`shared/src/schema.ts`) over
 * `schema[entity].cold`: an issue is cold when `closedAt` is set and nothing
 * can keep it in the list at the clock (`unlessShown`, POD-4665); a session
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
 * 3. A member that can keep it shown (POD-4665): the issue's rule is
 *    `unlessShown`, so a session whose deadline (`keptBy.keep`) has not passed
 *    keeps its closed issue resident. Every member row's deadline is indexed
 *    here by its raw foreign key (plain maps, ids and numbers, no row); a
 *    member ingest that can keep a COLD row shown reads that row by id and
 *    installs it with its dependents (`member`). A cold row's `finishOf` is
 *    kept beside its id, so deciding it reads nothing. Deadlines only pass,
 *    so the clock never makes a cold row hot. The rule's `lane` source (R3,
 *    POD-4745) is applied the MobX pool's way: the engine's issueless-set
 *    joins and a lane member's own update are settled once the publication's
 *    rows are in (`settleLanes`), warming a cold owner of the lane a member
 *    can keep shown.
 * AN UPDATE TO A COLD ROW THAT LEAVES IT COLD relinks it and is not stored
 * (the choice the brief asks for, and Ma3's): the kernel holds the value and
 * a later load reads the current one, so a heartbeat on a closed issue's
 * session costs a registry write and a relink, never a load, and a reopen
 * never paints loading. It is REPORTED (`rewritten`), so a cell that read
 * the row's fields without loading it (`peek`, POD-4582) re-reads them.
 *
 * READ WITHOUT LOADING (POD-4582, Hb1; the MobX pool's `coldRow`). A cell
 * that needs a few of a cold row's own fields to decide something the row
 * itself never shows (the worklist's rescue and nesting walks pass through
 * closed issues) reads it by id through the feed (`peek`): counted by the
 * reads fence, recorded under the row's key (`peeked`), never installed.
 *
 * NOTHING MAKES A HOT ROW COLD except a `replace`, which re-partitions
 * (`enumerate.ts` `reseed`): every named row follows the rule over the new
 * slice, resident before or not (POD-4706). A resident row the rule calls
 * cold is evicted — dropped from the tables and registered cold — so its
 * cells go with the membership delta and its filings follow the closure;
 * the only pin is a row carrying a pending edit, which stays resident while
 * the write layer holds it. A live update still keeps a resident row
 * resident (`ingest` is unchanged): an issue closed while resident stays
 * resident — it was just looked at.
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

import {
  type ColdContext,
  coldByRule,
  coldFinishOf,
  type EntityName,
  type KeptBySpec,
  keepDeadline,
  keeperEntities,
  keeperOf,
  type LaneSource,
  laneKeepOf,
  laneSources,
  type MemberKeep,
  type ModelSchema,
  tableColdContext,
  viaTargetOf,
} from '@podium/client-graph/shared/schema'
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
  /** The slice clock (`coarseNow`): what an `unlessShown` rule's deadlines are read against. */
  readonly now: () => number
  readonly windowMs?: number
  readonly schedule?: Schedule
  /**
   * The relation engine, as the rule's `lane` source reads it (POD-4745),
   * read lazily (the engine is built after residency). Without it a `lane`
   * source keeps nothing.
   */
  readonly lanes?: () => LaneReader
  /**
   * POD-4753 — per entity, the fields its readers need of a row that is cold
   * BY THE RULE (so hidden: nothing can show it): a small declared summary,
   * kept beside the cold id from the row ingest hands over, never the row.
   */
  readonly summaries?: Partial<Readonly<Record<EntityName, readonly string[]>>>
  /** A cell asked whether `entity:id` is cold (the pool records the running cell). */
  asked(entity: EntityName, id: string): void
  /** `entity:id` entered or left the registry (the pool emits a `residency` delta). */
  changed(entity: EntityName, id: string): void
  /** A cell read cold `entity:id` by id (`peek`; the pool records the running cell). */
  peeked(entity: EntityName, id: string): void
  /** A known cold row was updated and stays cold (the pool emits a `coldRow` delta). */
  rewritten(entity: EntityName, id: string): void
}

/** What a `lane` source reads of the relation engine (uncounted maintenance reads). */
export interface LaneReader {
  members(from: EntityName, id: string, relation: string): Iterable<string>
  subset(from: EntityName, id: string, relation: string, subset: string): Iterable<string>
  forwardTarget(from: EntityName, id: string, relation: string): string | null
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
  /** Rows installed because the row they inherit from stopped being cold, or a member can keep them shown. */
  warmed: number
  /** Cold rows read by id without loading (`peek`), each read counted. */
  peeks: number
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
    peeks: 0,
  }
  readonly windowMs: number
  private readonly options: ResidencyOptions
  private readonly schedule: Schedule
  private readonly summaryFields: Partial<Readonly<Record<EntityName, readonly string[]>>>
  /** `entity:id` → the declared summary of a cold row (entities that declare one). */
  private readonly summaries = new Map<string, Readonly<Record<string, unknown>>>()
  /** Entities whose rows can keep an `unlessShown` row resident (the schema's `keptBy`). */
  private readonly keeperKinds: ReadonlySet<EntityName>
  /** Per `members` source: owner id → member id → how long it keeps the owner shown, for EVERY known member row. */
  private readonly keeps = new Map<KeptBySpec, Map<string, Map<string, MemberKeep>>>()
  /** `member:id` → the source and owner id it is indexed under. */
  private readonly keeperKey = new Map<string, { source: KeptBySpec; owner: string }>()
  /** The schema's `lane` sources (R3, POD-4745). */
  private readonly laneSources: readonly LaneSource[]
  /** Per `lane` source: member id → how long it keeps the owners of its lane shown, for every UNOWNED member row. */
  private readonly laneKeeps = new Map<KeptBySpec, Map<string, MemberKeep>>()
  /** Per `lane` source: members whose lane may keep a cold owner shown, settled by `settleLanes`. */
  private readonly laneDirty = new Map<LaneSource, Set<string>>()
  /** A `replace`'s rule over the new slice, while it is being placed (`reindex` → `replaced`). */
  private placing: ColdContext | null = null
  /** A cold `unlessShown` row's `finishOf`, kept with its id (its members decay from it). */
  private readonly finish = new Map<string, number | null>()
  /** The highest clock seen (`now`). */
  private high = Number.NEGATIVE_INFINITY
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
    this.summaryFields = options.summaries ?? {}
    const { schema } = options
    this.keeperKinds = keeperEntities(schema)
    this.laneSources = laneSources(schema)
    for (const lane of this.laneSources) {
      this.laneKeeps.set(lane.source, new Map())
      this.laneDirty.set(lane, new Set())
    }
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

  /**
   * The clock the rule is read against: the highest `coarseNow` seen. The
   * locals channel does not promise monotony (`clock.ts`), and deadlines
   * only pass forward, so a rewind never warms a cold row; a row a rewind
   * shows again loads on first access. The gate's partition check reads this.
   */
  now(): number {
    this.high = Math.max(this.high, this.options.now())
    return this.high
  }

  /** `coldByRule` against the pool's own knowledge. */
  coldRule(entity: EntityName, row: object): boolean {
    return coldByRule(this.options.schema, entity, row, this.context())
  }

  /** The pool's answers to the rule: what it holds, its member indexes, its lanes, its clock. */
  private context(): ColdContext {
    return {
      now: this.now(),
      coldTarget: (to, id) => this.coldTarget(to, id),
      keeps: (_entity, source, key) => this.keepsAt(source, key),
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
    const reader = this.options.lanes?.() ?? null
    if (lane === undefined || reader === null) return []
    const deadlines = this.laneKeeps.get(source) as Map<string, MemberKeep>
    const out: MemberKeep[] = []
    for (const member of reader.subset(lane.lane, key, lane.relation, lane.subsetName)) {
      const keep = deadlines.get(member)
      if (keep !== undefined) out.push(keep)
    }
    return out
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

  /**
   * TRACKED: whether `id` is cold BY THE RULE, so hidden: nothing can show it.
   * The hand mirror of the MobX pool's `hidden` (POD-4753): a cold issue the
   * complete rule keeps out of memory is never flat or present, so visibility
   * answers it from its declared summary without reading its row.
   */
  hidden(entity: EntityName, id: string): boolean {
    if (!this.capable(entity)) return false
    this.options.asked(entity, id)
    return this.isCold(entity, id)
  }

  /** TRACKED: the declared summary of a cold row, else undefined. */
  summary(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    if (!this.capable(entity)) return undefined
    this.options.peeked(entity, id)
    return this.summaries.get(`${entity}:${id}`)
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

  /** Rows queued for the open window. */
  queued(): number {
    let count = 0
    for (const ids of this.queue.values()) count += ids.size
    return count
  }

  /**
   * Drop every queued row without loading it (POD-4706). A `replace` clears
   * the pool's caches and rebuilds them from the new slice; loads queued by
   * the old state's cells are stale asks — what the new state's derivations
   * reach, they queue again on their next read.
   */
  dropQueued(): void {
    this.cancel?.()
    this.cancel = null
    this.queue.clear()
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
    if (this.keeperKinds.has(entity)) this.member(target, entity, id, value, out)
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
   * A `replace` placing one row of the new slice (`reseed`): every named row
   * follows the rule, with `staged` (the new slice) answering for the rows
   * it inherits from. A resident row the rule calls cold is evicted (POD-4706:
   * dropped from the tables, then registered cold like any cold row), except
   * a row carrying a pending edit (`pinned`), which stays resident while the
   * write layer holds it. The drop-then-register is deliberate: the drop's
   * membership delta is what disposes the row's cells and records (`release`),
   * and the register's `changed` delta is what re-runs its coldness readers.
   */
  place(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow,
    out: IngestOut,
    pinned = false,
  ): void {
    const hot = target.read[entity].get(id) !== undefined
    const ctx = this.placing
    if (ctx === null) throw new Error('[pool] place() outside a replace (reindex first)')
    if (coldByRule(this.options.schema, entity, value, ctx)) {
      if (pinned) {
        this.unregister(entity, id)
        put(target, entity, id, value, out)
        return
      }
      if (hot) drop(target, entity, id, out)
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

  /**
   * TRACKED: a cold row's current value, read by id through the feed and not
   * installed (POD-4582); undefined when the row is not cold. Its next update
   * (`rewritten`) or its leaving the registry (`changed`) re-runs the reader.
   */
  peek(entity: EntityName, id: string): object | undefined {
    if (!this.isCold(entity, id)) return undefined
    this.options.peeked(entity, id)
    this.counters.peeks += 1
    return this.options.load(entity as LoadableEntity, id)
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
    this.keeps.clear()
    this.keeperKey.clear()
    for (const deadlines of this.laneKeeps.values()) deadlines.clear()
    for (const dirty of this.laneDirty.values()) dirty.clear()
    this.placing = null
    this.finish.clear()
    this.summaries.clear()
  }

  /**
   * A `replace` (`reseed`), before any row is placed: the member indexes over
   * the NEW slice, and the rule over it (`tableColdContext`: its rows, its
   * members, its lanes resolved from scratch), so each placed row's rule
   * reads what it will have. The engine's lanes move only as rows are placed,
   * so they cannot answer here.
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
    this.placing = tableColdContext(this.options.schema, staged, this.now())
  }

  /**
   * A `replace` has placed every row: its rule decided each one over the
   * whole new slice, so the lane joins its placement caused are settled.
   */
  replaced(): void {
    this.placing = null
    for (const dirty of this.laneDirty.values()) dirty.clear()
  }

  /**
   * The engine moved `member` into the issueless set of `collection`
   * (POD-4745): a lane may now be kept by it. Settled with the publication
   * (`settleLanes`), never inside the engine's own maintenance.
   */
  laneJoined(collection: string, member: string): void {
    for (const lane of this.laneSources) {
      if (`${lane.lane}.${lane.relation}` === collection) this.laneDirty.get(lane)?.add(member)
    }
  }

  /**
   * Warm every COLD owner a lane's member can now keep shown (after the
   * publication's rows are in): for each member that joined a lane or
   * changed, its current lane (the engine's forward), when the engine counts
   * it there (issueless, not collapsed), and each cold owner checked out at
   * that lane whose finish its deadline has not passed. Warming can move
   * lanes again, so it runs until nothing is left.
   */
  settleLanes(target: IngestTarget, out: IngestOut): void {
    const reader = this.options.lanes?.() ?? null
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
      for (const owner of [...reader.members(lane.lane, at, lane.owners)]) {
        if (!this.isCold(lane.owner, owner)) continue
        const finish = this.finish.get(`${lane.owner}:${owner}`) ?? null
        if (this.now() > keepDeadline(keep, finish)) continue
        this.warm(target, lane.owner, owner, out)
      }
    }
  }

  /**
   * A member row's ingest (POD-4665): re-index what it keeps, and when it can
   * keep a COLD row shown at the clock, install that row now, with the rows
   * that inherit from it (this one among them), before the member itself is
   * routed. Nothing is read unless it warms: the member's deadline and the
   * cold row's `finishOf` are both held.
   */
  private member(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow | undefined,
    out: IngestOut,
  ): void {
    this.unindexMember(entity, id)
    const keeper = value === undefined ? null : this.indexMember(entity, id, value)
    // A lane member's deadline (a row with an explicit owner is none), and a
    // re-check of its lane once the publication is in when it can keep: its
    // own update can extend how long.
    if (this.indexLane(entity, id, keeper === null ? value : undefined)) {
      for (const lane of this.laneSources) {
        if (lane.member === entity) this.laneDirty.get(lane)?.add(id)
      }
    }
    if (keeper === null || !this.isCold(keeper.to, keeper.id)) return
    const finish = this.finish.get(`${keeper.to}:${keeper.id}`) ?? null
    if (this.now() > keepDeadline(keeper.keep, finish)) return
    this.warm(target, keeper.to, keeper.id, out)
  }

  /** Install the cold row `entity:id` because a member can keep it shown, with its dependents. */
  private warm(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
    const row = this.options.load(entity as LoadableEntity, id) as StoredRow | undefined
    if (row === undefined) return // its removal is on the way
    this.unregister(entity, id)
    put(target, entity, id, row, out)
    this.counters.warmed += 1
    this.warmDependents(target, entity, id, out)
  }

  private indexMember(entity: EntityName, id: string, row: object): ReturnType<typeof keeperOf> {
    const keeper = keeperOf(this.options.schema, entity, row)
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
    this.keeperKey.set(`${entity}:${id}`, { source: keeper.source, owner: keeper.id })
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
      if (keep === null) deadlines.delete(id)
      else {
        deadlines.set(id, keep)
        if (typeof keep === 'function' || this.now() <= keep) live = true
      }
    }
    return live
  }

  /** Relink a cold row with its new value, keeping only its id. */
  private keepCold(target: IngestTarget, entity: EntityName, id: string, value: StoredRow): void {
    const known = this.isCold(entity, id)
    this.register(entity, id, value)
    if (known) this.options.rewritten(entity, id)
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
    if (this.options.schema[entity].cold.kind === 'unlessShown') {
      this.finish.set(`${entity}:${id}`, coldFinishOf(this.options.schema, entity, row))
    }
    const fields = this.summaryFields[entity]
    if (fields !== undefined) {
      const values = row as Readonly<Record<string, unknown>>
      const summary: Record<string, unknown> = {}
      for (const field of fields) {
        const value = values[field]
        if (value !== undefined) summary[field] = value
      }
      this.summaries.set(`${entity}:${id}`, summary)
    }
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
    this.finish.delete(`${entity}:${id}`)
    this.summaries.delete(`${entity}:${id}`)
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
