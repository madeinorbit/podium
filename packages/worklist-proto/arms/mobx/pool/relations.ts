/**
 * POD-4566 (Ma2) — the pool's relations, maintained from the declared schema
 * (`shared/src/schema.ts`), and the shared relation accessor
 * (`RelationReader`, L5a) that answers from them.
 *
 * NO RELATION IS NAMED HERE. The engine reads `schema[entity].relations` at
 * construction: every single-valued relation (`belongsTo`, `prefix`,
 * outgoing `edge`) becomes one LINK, paired with the collection its
 * `inverse` names (`hasMany`, incoming `edge`). A relation added to the
 * schema is maintained with no change to this file (`relations.test.ts`
 * builds a pool over a fixture schema with one extra relation).
 *
 * WHAT A LINK HOLDS (all per link, all written only here, inside the pool's
 * one action per feed event):
 * - `forward`: an observable map, source id → the target key the source
 *   contributes. Only MEMBERS have an entry: a row the declared `where`
 *   rejects, or one the entity's `collapse` rule collapses away, has none.
 *   A `belongsTo` keeps its reference key even while the target is absent
 *   (doc §4.1: an unresolved reference is never an error); `one()` checks
 *   presence, so a re-added target resolves by itself.
 * - `buckets`: an observable map, target key → an observable SET of its
 *   members' ids (the inverse collection), UNORDERED: a reader that needs an
 *   order applies it at view time (schema doc §4, audit §7). A move adds or
 *   deletes ONE element (M3 F1: the old sorted, frozen array was copied and
 *   sorted whole on every change, 4,575 elements for one new issue on the
 *   live export). Moves are netted per action and applied once (`flush`), so
 *   a computed reading one bucket invalidates at most once per change, never
 *   for a bucket the change did not touch, and not at all when the action's
 *   moves cancel out. A bucket is created with its first member and deleted
 *   with its last. Buckets are keyed by the reference, not by the target's
 *   presence: a parent evicted and re-added finds its children where they
 *   were (the round-two hand bug).
 * - for a `prefix` link, `under`: normalized path → the members whose source
 *   path is that path or lies inside it. It is the ONLY way a new root finds
 *   the sessions it now owns without a scan (doc §4.3).
 *
 * MAINTENANCE (`changed`, called by ingest after each table write, doc §4):
 * 1. collapse: when the row's collapse inputs moved, its old and new groups
 *    are re-decided by the declared resolver (`collapseLosers`); every row
 *    whose collapsed state flipped is re-linked in full.
 * 2. the row's own links: for each link whose declared inputs (the key or
 *    path or edge field, plus every `where` field) changed — or all of them
 *    on insert, delete or a collapse flip — resolve the new target and move
 *    the row from the old bucket to the new one (detach, then attach).
 * 3. as a `prefix` TARGET: a new root takes over the members under it that
 *    sit at a shorter root or at none; a removed root hands its members to
 *    the next-longest root (the same for all of them: see `rootRemoved`).
 * Every step is O(edges of the changed row), plus the bounded exceptions the
 * doc names: a collapse group, and the members under one root. No step walks
 * a table.
 *
 * READS. Rows are read through the fenced tables (counted). A `prefix` probe
 * asks the RAW table whether each ancestor path is a root (a miss reads no
 * row) and counts the hit. Bucket moves count no row; `indexUpdates` counts
 * the slots they write, and `bucketElements` (`onElements`) the elements
 * they add or delete: one per edge moved, whatever the bucket's size.
 *
 * COLD ROWS (POD-4567). With a residency hook, a link's slots for a row that
 * is not resident (a cold source's `forward` entry, a bucket keyed by a cold
 * or absent target) live in PLAIN twins (`coldForward`, `coldBuckets`): no
 * observable is built for a row nobody has looked at. A reader that reaches
 * a plain slot observes that row's residency atom, and every plain write
 * reports it changed, so the read is tracked like any other. When the row
 * becomes resident (`changed` with the row in its table) its slots move into
 * the observable maps (`promote`), each move one slot written; a promoted
 * bucket's members are copied into its observable set once (counted as
 * elements), in the row's lifetime. Nothing moves back: a removed resident
 * row keeps its buckets observable, as before.
 *
 * THE READER. `one` = `forward.get` + the target's presence (one counted
 * read: the target); `many` = the bucket's members, unordered (one counted
 * read per member); `size` = the bucket's size (free). Derivations resolve
 * every relation through this reader, `one` included (`views.ts`: the row
 * views' `issue.repo` and `issue.discoveredFrom`), and never themselves.
 */

import { type ObservableMap, type ObservableSet, observable } from 'mobx'
import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import {
  type BelongsToSpec,
  type CollapseSpec,
  collapseLosers,
  type EdgeSpec,
  type EntityName,
  type ModelSchema,
  normalizeRootPath,
  type PrefixSpec,
  type RelationSpec,
  SCHEMA,
} from '../../../shared/src/schema'

type Row = Readonly<Record<string, unknown>>

/** The read surface a relation needs; a fenced table, a MobX map and a `Map` all have it. */
export interface ReadableTable {
  get(id: string): unknown
  has(id: string): boolean
}

export type ReadableTables = { readonly [E in EntityName]: ReadableTable }

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>())

function specOf(schema: ModelSchema, from: EntityName, relation: string): RelationSpec {
  const spec = schema[from].relations[relation]
  if (spec === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
  return spec
}

/** A relation resolved from its own row: `belongsTo`, `prefix`, outgoing `edge`. */
export type LinkSpec = BelongsToSpec | PrefixSpec | (EdgeSpec & { readonly direction: 'out' })

export function isLinkSpec(spec: RelationSpec): spec is LinkSpec {
  return (
    spec.kind === 'belongsTo' ||
    spec.kind === 'prefix' ||
    (spec.kind === 'edge' && spec.direction === 'out')
  )
}

/**
 * The target key a `belongsTo` or outgoing `edge` names on `source` (the
 * foreign key; the first edge of the declared type), after the declared
 * membership filter, WITHOUT checking the target is present. Reading it costs
 * the source row only. The engine computes a link's forward key with it, and
 * the from-scratch scan (`enumerate.ts`) its oracle's; derivations never call
 * it (they read `one`).
 */
export function relationRef(
  from: EntityName,
  relation: string,
  source: object,
  schema: ModelSchema = SCHEMA,
): string | null {
  const spec = specOf(schema, from, relation)
  const row = source as Row
  if (spec.where !== undefined && !spec.where.test(row)) return null
  let target: unknown
  if (spec.kind === 'belongsTo') {
    if (spec.targetKey !== schema[spec.to].key) {
      throw new Error(`[pool] ${from}.${relation} joins on a non-key field; not a keyed read`)
    }
    target = row[spec.foreignKey]
  } else if (spec.kind === 'edge' && spec.direction === 'out') {
    const edges = row[spec.edgeField]
    if (!Array.isArray(edges)) return null
    const hit = (edges as readonly Row[]).find((edge) => edge[spec.edgeTypeKey] === spec.edgeType)
    target = hit?.[spec.edgeIdKey]
  } else {
    throw new Error(`[pool] ${from}.${relation} is not resolved from its own row (${spec.kind})`)
  }
  return typeof target === 'string' && target.length > 0 ? target : null
}

/** The fields a link's answer depends on: a change to any re-resolves it (doc §4.2). */
export function linkInputs(spec: LinkSpec): readonly string[] {
  const own =
    spec.kind === 'belongsTo'
      ? spec.foreignKey
      : spec.kind === 'prefix'
        ? spec.sourceField
        : spec.edgeField
  return [own, ...(spec.where?.fields ?? [])]
}

/**
 * `normalized` and every ancestor at a `/` boundary, longest first: exactly
 * the normalized roots `longestPrefixPath` matches for this probe (a root R
 * matches P when P === R or P starts with `R/`).
 */
export function* ancestorPaths(normalized: string): Generator<string> {
  yield normalized
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i] === '/') yield normalized.slice(0, i)
  }
}

/**
 * The root KEYS that could match `normalized`, longest first: each ancestor
 * path in every spelling that normalizes to it (`a` and `a/`,
 * `normalizeRootPath`).
 */
export function* prefixCandidates(normalized: string): Generator<string> {
  for (const path of ancestorPaths(normalized)) {
    if (normalizeRootPath(path) === path) yield path
    const slashed = `${path}/`
    if (normalizeRootPath(slashed) === path) yield slashed
  }
}

interface Link {
  readonly from: EntityName
  readonly name: string
  readonly spec: LinkSpec
  /** `${to}.${inverse}`: the collection this link maintains. */
  readonly collection: string
  readonly inputs: readonly string[]
  readonly forward: ObservableMap<string, string>
  readonly buckets: ObservableMap<string, ObservableSet<string>>
  /** `prefix` only: normalized path → members at or under it. */
  readonly under: Map<string, Set<string>> | null
  /** `prefix` only: member → its indexed normalized source path. */
  readonly placed: Map<string, string> | null
  /** Forward entries of sources that are not resident (POD-4567). */
  readonly coldForward: Map<string, string>
  /** Buckets keyed by targets that are not resident (POD-4567). */
  readonly coldBuckets: Map<string, Set<string>>
}

/**
 * Residency, as the engine needs it (POD-4567, `residency.ts`). Without it
 * every slot is observable (the Ma2 engine).
 */
export interface ColdSlots {
  /** Whether `id` is resident (in its table; always, for an entity that is never cold). */
  resident(entity: EntityName, id: string): boolean
  /** Track a read of a plain slot that belongs to `id` (a derivation reached it). */
  observe(entity: EntityName, id: string): void
  /** A plain slot of `id` was written. */
  changed(entity: EntityName, id: string): void
}

/** One entity's collapse state. */
interface Collapse {
  readonly rule: CollapseSpec
  readonly groups: Map<string, Set<string>>
  readonly groupOf: Map<string, string>
  readonly collapsed: Set<string>
}

/** The write surface the engine probes roots on: the RAW tables. */
export type ProbeTables = { readonly [E in EntityName]: { has(id: string): boolean } }

export interface PoolRelationsOptions {
  /** Row reads (the fenced tables in the live pool). */
  readonly tables: ReadableTables
  /** The raw tables, for `prefix` root probes (a miss reads no row). */
  readonly probe: ProbeTables
  readonly reads: ReadFence
  readonly schema?: ModelSchema
  /** Bumped once per slot written (forward entries and buckets). */
  readonly onWrite?: (slots: number) => void
  /** Bumped by the bucket elements a write touched (POD-4568 rework, M3 F1). */
  readonly onElements?: (elements: number) => void
  /** Residency (POD-4567): slots of rows that are not resident stay plain. */
  readonly cold?: ColdSlots
}

/** What ingest needs from the engine. */
export interface RelationMaintenance {
  changed(entity: EntityName, id: string, prev: object | undefined, next: object | undefined): void
  /** A collection's members, including this action's pending moves. */
  members(from: EntityName, id: string, relation: string): readonly string[]
}

export class PoolRelations implements RelationReader, RelationMaintenance {
  readonly schema: ModelSchema
  /** The slots the current (or last) action wrote, `collection:key` / `from.name→id`. */
  readonly lastWrites: string[] = []
  /** Bucket elements the current (or last) action touched. */
  lastElements = 0
  private readonly tables: ReadableTables
  private readonly probe: ProbeTables
  private readonly reads: ReadFence
  private readonly onWrite: (slots: number) => void
  private readonly onElements: (elements: number) => void
  private readonly cold: ColdSlots | null
  private readonly links = new Map<string, Link>()
  /** Links by the entity their collection belongs to (buckets keyed by its ids). */
  private readonly incoming = new Map<EntityName, Link[]>()
  private readonly collections = new Map<string, Link>()
  private readonly outgoing = new Map<EntityName, Link[]>()
  private readonly prefixTargets = new Map<EntityName, Link[]>()
  private readonly collapses = new Map<EntityName, Collapse>()
  /**
   * Bucket moves of this action, netted (member → added, or deleted), applied
   * once at its end (`flush`).
   */
  private readonly pending = new Map<Link, Map<string, Map<string, boolean>>>()

  constructor(options: PoolRelationsOptions) {
    this.schema = options.schema ?? SCHEMA
    this.tables = options.tables
    this.probe = options.probe
    this.reads = options.reads
    this.onWrite = options.onWrite ?? (() => {})
    this.onElements = options.onElements ?? (() => {})
    this.cold = options.cold ?? null
    for (const from of Object.keys(this.schema) as EntityName[]) {
      const entity = this.schema[from]
      this.outgoing.set(from, [])
      this.incoming.set(from, [])
      if (entity.collapse !== undefined) {
        this.collapses.set(from, {
          rule: entity.collapse,
          groups: new Map(),
          groupOf: new Map(),
          collapsed: new Set(),
        })
      }
    }
    for (const from of Object.keys(this.schema) as EntityName[]) {
      for (const [name, spec] of Object.entries(this.schema[from].relations)) {
        if (!isLinkSpec(spec)) continue
        const prefix = spec.kind === 'prefix'
        const link: Link = {
          from,
          name,
          spec,
          collection: `${spec.to}.${spec.inverse}`,
          inputs: linkInputs(spec),
          forward: observable.map<string, string>(undefined, {
            deep: false,
            name: `pool.${from}.${name}`,
          }),
          buckets: observable.map<string, ObservableSet<string>>(undefined, {
            deep: false,
            name: `pool.${spec.to}.${spec.inverse}`,
          }),
          under: prefix ? new Map() : null,
          placed: prefix ? new Map() : null,
          coldForward: new Map(),
          coldBuckets: new Map(),
        }
        this.links.set(`${from}.${name}`, link)
        this.collections.set(link.collection, link)
        this.outgoing.get(from)?.push(link)
        this.incoming.get(spec.to)?.push(link)
        if (prefix)
          this.prefixTargets.set(spec.to, [...(this.prefixTargets.get(spec.to) ?? []), link])
      }
    }
    // Every collection must be some link's inverse (the schema's duality rule).
    for (const from of Object.keys(this.schema) as EntityName[]) {
      for (const [name, spec] of Object.entries(this.schema[from].relations)) {
        if (!isLinkSpec(spec) && !this.collections.has(`${from}.${name}`)) {
          throw new Error(`[pool] ${from}.${name} is a collection no relation maintains`)
        }
      }
    }
  }

  // ------------------------------------------------------------------ reader

  one(from: EntityName, id: string, relation: string): string | null {
    const link = this.links.get(`${from}.${relation}`)
    if (link === undefined) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    }
    let target = link.forward.get(id)
    if (target === undefined && this.cold !== null && !this.cold.resident(from, id)) {
      this.cold.observe(from, id)
      target = link.coldForward.get(id)
    }
    if (target === undefined) return null
    return this.tables[link.spec.to].has(target) ? target : null
  }

  many(from: EntityName, id: string, relation: string): Iterable<string> {
    return this.bucket(from, id, relation)
  }

  size(from: EntityName, id: string, relation: string): number {
    return this.bucket(from, id, relation).size
  }

  private bucket(from: EntityName, id: string, relation: string): ReadonlySet<string> {
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    const bucket = link.buckets.get(id)
    if (bucket !== undefined || this.cold === null || this.cold.resident(from, id)) {
      return bucket ?? NONE
    }
    this.cold.observe(from, id)
    return link.coldBuckets.get(id) ?? NONE
  }

  // ------------------------------------------------------------- maintenance

  /** Whether `id`'s row is collapsed away by its entity's rule (tests). */
  isCollapsed(entity: EntityName, id: string): boolean {
    return this.collapses.get(entity)?.collapsed.has(id) ?? false
  }

  /**
   * Maintenance only: a copy, in id order (a removed root's members all move;
   * a released repo row passes to its first remaining lane, deterministically).
   */
  members(from: EntityName, id: string, relation: string): readonly string[] {
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) throw new Error(`[pool] ${from}.${relation} is not a collection`)
    const members = new Set(peekBucket(link, id))
    for (const [member, added] of this.pending.get(link)?.get(id) ?? []) {
      if (added) members.add(member)
      else members.delete(member)
    }
    return [...members].sort()
  }

  /** Start an action: forget the previous action's write record. */
  begin(): void {
    this.lastWrites.length = 0
    this.lastElements = 0
  }

  /** One table write happened: maintain every relation it touches (doc §4). */
  changed(
    entity: EntityName,
    id: string,
    prev: object | undefined,
    next: object | undefined,
  ): void {
    const before = prev as Row | undefined
    const after = next as Row | undefined
    if (after !== undefined) this.promote(entity, id)
    const flipped = this.recollapse(entity, id, before, after)
    const selfFlipped = flipped.delete(id)
    for (const link of this.outgoing.get(entity) ?? []) {
      if (after === undefined) {
        this.relink(link, id, undefined)
        continue
      }
      if (before !== undefined && !selfFlipped && sameInputs(link.inputs, before, after)) continue
      this.relink(link, id, after)
    }
    for (const other of flipped) {
      const row = this.tables[entity].get(other) as Row | undefined
      for (const link of this.outgoing.get(entity) ?? []) this.relink(link, other, row)
    }
    if ((before === undefined) !== (after === undefined)) {
      for (const link of this.prefixTargets.get(entity) ?? []) {
        if (after !== undefined) this.rootAdded(link, id)
        else this.rootRemoved(link, id)
      }
    }
  }

  /**
   * End of the action: apply every bucket's net moves, once. Each member
   * added or deleted is one element touched; the rest of the bucket is not
   * read.
   */
  flush(): void {
    for (const [link, targets] of this.pending) {
      for (const [target, moves] of targets) {
        if (moves.size === 0) continue
        // A bucket is written where it lives. An observable one stays
        // observable even once its target is gone (nothing moves back;
        // POD-4568: writing the plain twin left the observable one stale).
        // Only a bucket that does not exist yet is placed by residency.
        const observed = link.buckets.get(target)
        const plain =
          observed === undefined && this.cold !== null && !this.cold.resident(link.spec.to, target)
        let bucket: Set<string> | ObservableSet<string> | undefined = plain
          ? link.coldBuckets.get(target)
          : observed
        let created = false
        let adopted = false
        if (bucket === undefined) {
          bucket = plain ? new Set<string>() : newBucket(link)
          created = true
          // A resident target whose bucket is still a plain twin (`promote`
          // runs first on every path today): take its members along.
          const twin = plain ? undefined : link.coldBuckets.get(target)
          if (twin !== undefined) {
            link.coldBuckets.delete(target)
            for (const member of twin) bucket.add(member)
            this.touched(twin.size)
            adopted = true
          }
        }
        let elements = 0
        for (const [member, added] of moves) {
          if (added === bucket.has(member)) continue
          if (added) bucket.add(member)
          else bucket.delete(member)
          elements += 1
        }
        if (elements === 0 && !adopted) continue
        if (bucket.size === 0) {
          if (plain) link.coldBuckets.delete(target)
          else link.buckets.delete(target)
        } else if (created) {
          if (plain) link.coldBuckets.set(target, bucket as Set<string>)
          else link.buckets.set(target, bucket as ObservableSet<string>)
        }
        if (plain && this.cold !== null) this.cold.changed(link.spec.to, target)
        this.wrote(`${link.collection}:${target}`)
        this.touched(elements)
      }
    }
    this.pending.clear()
  }

  /** Forget everything (the pool's dispose). Call inside an action. */
  clear(): void {
    for (const link of this.links.values()) {
      link.forward.clear()
      link.buckets.clear()
      link.coldForward.clear()
      link.coldBuckets.clear()
      link.under?.clear()
      link.placed?.clear()
    }
    for (const collapse of this.collapses.values()) {
      collapse.groups.clear()
      collapse.groupOf.clear()
      collapse.collapsed.clear()
    }
    this.pending.clear()
    this.lastWrites.length = 0
  }

  /**
   * Re-decide the collapse groups `id` leaves and joins, when its collapse
   * inputs moved. Returns the ids whose collapsed state flipped (`id`
   * included when it flipped itself).
   */
  private recollapse(
    entity: EntityName,
    id: string,
    before: Row | undefined,
    after: Row | undefined,
  ): Set<string> {
    const flipped = new Set<string>()
    const collapse = this.collapses.get(entity)
    if (collapse === undefined) return flipped
    const { rule, groups, groupOf, collapsed } = collapse
    if (before !== undefined && after !== undefined && sameInputs(rule.fields, before, after)) {
      return flipped
    }
    const oldKey = groupOf.get(id) ?? null
    const newKey = after === undefined ? null : rule.groupKey(after)
    if (oldKey !== newKey) {
      if (oldKey !== null) {
        const group = groups.get(oldKey)
        group?.delete(id)
        if (group?.size === 0) groups.delete(oldKey)
        groupOf.delete(id)
      }
      if (newKey !== null) {
        let group = groups.get(newKey)
        if (group === undefined) {
          group = new Set()
          groups.set(newKey, group)
        }
        group.add(id)
        groupOf.set(id, newKey)
      }
    }
    if (newKey === null && collapsed.delete(id)) flipped.add(id)
    for (const key of new Set([oldKey, newKey])) {
      if (key === null) continue
      const group = groups.get(key)
      if (group === undefined) continue
      const table = this.tables[entity]
      const members = [...group].map((member) => ({
        id: member,
        row: (member === id ? after : table.get(member)) as Row,
      }))
      const losers = new Set(collapseLosers(rule, members))
      for (const { id: member } of members) {
        if (losers.has(member) === collapsed.has(member)) continue
        if (losers.has(member)) collapsed.add(member)
        else collapsed.delete(member)
        flipped.add(member)
      }
    }
    return flipped
  }

  /** Resolve `link` for source `id` (row `row`, or gone) and move it there. */
  private relink(link: Link, id: string, row: Row | undefined): void {
    const member =
      row !== undefined &&
      (link.spec.where === undefined || link.spec.where.test(row)) &&
      !this.isCollapsed(link.from, id)
    let target: string | null = null
    if (member && link.spec.kind === 'prefix') {
      const path = row[link.spec.sourceField]
      const normalized = typeof path === 'string' ? normalizeRootPath(path) : null
      this.place(link, id, normalized)
      target = normalized === null ? null : this.probeRoot(link, normalized)
    } else {
      if (link.placed !== null) this.place(link, id, null)
      if (member) target = relationRef(link.from, link.name, row, this.schema)
    }
    this.point(link, id, target)
  }

  /** Point source `id` at `target` (null: nothing): detach, then attach. */
  private point(link: Link, id: string, target: string | null): void {
    const old = peekForward(link, id)
    if ((old ?? null) === target) return
    if (old !== undefined) {
      this.move(link, old, id, false)
      if (!link.forward.delete(id)) link.coldForward.delete(id)
    }
    if (target !== null) {
      this.move(link, target, id, true)
      if (this.cold !== null && !this.cold.resident(link.from, id)) link.coldForward.set(id, target)
      else link.forward.set(id, target)
    }
    if (this.cold !== null && !this.cold.resident(link.from, id)) this.cold.changed(link.from, id)
    this.wrote(`${link.from}.${link.name}→${id}`)
  }

  /** Index `id` under every ancestor of its source path (prefix links). */
  private place(link: Link, id: string, normalized: string | null): void {
    const under = link.under as Map<string, Set<string>>
    const placed = link.placed as Map<string, string>
    const old = placed.get(id) ?? null
    if (old === normalized) return
    if (old !== null) {
      for (const path of ancestorPaths(old)) {
        const set = under.get(path)
        set?.delete(id)
        if (set?.size === 0) under.delete(path)
      }
      placed.delete(id)
    }
    if (normalized !== null) {
      for (const path of ancestorPaths(normalized)) {
        let set = under.get(path)
        if (set === undefined) {
          set = new Set()
          under.set(path, set)
        }
        set.add(id)
      }
      placed.set(id, normalized)
    }
  }

  /** The longest present root containing `normalized`, by keyed probes. */
  private probeRoot(link: Link, normalized: string): string | null {
    const roots = this.probe[link.spec.to]
    for (const candidate of prefixCandidates(normalized)) {
      if (!roots.has(candidate)) continue
      this.reads.touch(link.spec.to, candidate, 'get')
      return candidate
    }
    return null
  }

  /** A new root takes the members under it that sit at a shorter root or none. */
  private rootAdded(link: Link, root: string): void {
    const normalized = normalizeRootPath(root)
    const candidates = link.under?.get(normalized)
    if (candidates === undefined) return
    for (const id of [...candidates]) {
      const current = peekForward(link, id)
      if (current !== undefined && normalizeRootPath(current).length >= normalized.length) continue
      this.point(link, id, root)
    }
  }

  /**
   * A removed root's members move to the next-longest root. Every member's
   * path lies at or under the removed root, so their next root is the same:
   * the longest present root containing the removed one.
   */
  private rootRemoved(link: Link, root: string): void {
    const members = this.members(link.spec.to, root, link.spec.inverse)
    if (members.length === 0) return
    const next = this.probeRoot(link, normalizeRootPath(root))
    for (const id of members) this.point(link, id, next)
  }

  /**
   * `id` is resident now: move its plain slots (its forward entries, the
   * buckets keyed by it) into the observable maps, one slot write each.
   */
  private promote(entity: EntityName, id: string): void {
    if (this.cold === null || !this.cold.resident(entity, id)) return
    let moved = false
    for (const link of this.outgoing.get(entity) ?? []) {
      const target = link.coldForward.get(id)
      if (target === undefined) continue
      link.coldForward.delete(id)
      link.forward.set(id, target)
      this.wrote(`${link.from}.${link.name}→${id}`)
      moved = true
    }
    for (const link of this.incoming.get(entity) ?? []) {
      const bucket = link.coldBuckets.get(id)
      if (bucket === undefined) continue
      link.coldBuckets.delete(id)
      const promoted = newBucket(link)
      for (const member of bucket) promoted.add(member)
      link.buckets.set(id, promoted)
      this.wrote(`${link.collection}:${id}`)
      this.touched(bucket.size)
      moved = true
    }
    if (moved) this.cold.changed(entity, id)
  }

  /** Record a move of `member` into (`added`) or out of `target`'s bucket, netted. */
  private move(link: Link, target: string, member: string, added: boolean): void {
    let targets = this.pending.get(link)
    if (targets === undefined) {
      targets = new Map()
      this.pending.set(link, targets)
    }
    let moves = targets.get(target)
    if (moves === undefined) {
      moves = new Map()
      targets.set(target, moves)
    }
    if (moves.get(member) === !added) moves.delete(member)
    else moves.set(member, added)
  }

  private touched(elements: number): void {
    this.lastElements += elements
    this.onElements(elements)
  }

  private wrote(slot: string): void {
    this.lastWrites.push(slot)
    this.onWrite(1)
  }
}

/** A source's forward entry, wherever it lives (maintenance: untracked). */
function peekForward(link: Link, id: string): string | undefined {
  return link.forward.get(id) ?? link.coldForward.get(id)
}

/** A target's bucket, wherever it lives (maintenance: untracked). */
function peekBucket(link: Link, target: string): ReadonlySet<string> {
  return link.buckets.get(target) ?? link.coldBuckets.get(target) ?? NONE
}

function newBucket(link: Link): ObservableSet<string> {
  return observable.set<string>(undefined, {
    deep: false,
    name: `pool.${link.collection}.bucket`,
  })
}

function sameInputs(fields: readonly string[], a: Row, b: Row): boolean {
  for (const field of fields) if (a[field] !== b[field]) return false
  return true
}
