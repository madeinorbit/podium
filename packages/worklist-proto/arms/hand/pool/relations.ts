/**
 * POD-4579 (Ha2) — the pool's relations, maintained from the declared schema
 * (`shared/src/schema.ts`), and the shared relation accessor (`RelationReader`,
 * L5a) that answers from them.
 *
 * NO RELATION IS NAMED HERE. The engine reads `schema[entity].relations` at
 * construction: every single-valued relation (`belongsTo`, `prefix`, outgoing
 * `edge`) becomes one LINK, paired with the collection its `inverse` names
 * (`hasMany`, incoming `edge`). A collection no link maintains throws at
 * construction. A relation added to the schema is maintained with no change
 * to this file (`relations.test.ts`, "a relation added to the schema").
 *
 * WHAT A LINK HOLDS (plain maps, written only here, during ingest):
 * - `forward`: source id → the target key the source contributes. Only
 *   MEMBERS have an entry: a row the declared `where` rejects, or one its
 *   entity's `collapse` rule collapses away, has none. A `belongsTo` keeps its
 *   reference while the target is absent (schema doc §4.1: an unresolved
 *   reference is never an error); `one()` checks presence, so a re-added
 *   target resolves by itself.
 * - `buckets`: target key → a `Set` of member ids (the inverse collection),
 *   keyed by the reference, not by the target's presence: a parent evicted and
 *   re-added finds its children where they were (the round-two hand bug).
 *   A bucket is edited one member at a time, never copied or sorted: on the
 *   live export `repo.issues` holds 4,574 of 5,170 issues, and the MobX shape
 *   review failed a copy-per-change (M3 F1). A bucket has no order; a reader
 *   that needs one imposes it (`views.ts`, a draft's first member).
 * - for a `prefix` link, `under`: normalized path → the members whose source
 *   path is that path or lies inside it, the only way a new root finds the
 *   sessions it now owns without a scan (doc §4.3).
 *
 * MAINTENANCE (`changed`, called by ingest after each table write, doc §4):
 * 1. collapse: when the row's collapse inputs moved, its old and new groups
 *    are re-decided by the declared resolver (`collapseLosers`); every row
 *    whose collapsed state flipped is re-linked in full. A row that keeps its
 *    group before and after (a live session's heartbeat) decides nothing.
 * 2. the row's own links: for each link whose declared inputs (the key, path
 *    or edge field, plus every `where` field) changed — or all of them on
 *    insert, delete or a collapse flip — resolve the new target and move the
 *    row from the old bucket to the new one (detach, then attach).
 * 3. as a `prefix` TARGET: a new root takes the members under it that sit at a
 *    shorter root or at none; a removed root hands its members to the
 *    next-longest root (the same for all of them).
 * Every step is O(edges of the changed row), plus the bounded exceptions the
 * doc names: one collapse group, the members under one root. No step walks a
 * table or a bucket it does not change.
 *
 * WHAT IT REPORTS. Every slot written — a source's forward entry
 * (`issue.parent:I2`) or a target's bucket (`issue.children:I1`) — is
 * recorded in `lastWrites`; the pool turns each into a `relation` delta that
 * dirties exactly the cells that read that slot. `onWrite` counts every
 * element touched (bucket member, forward entry, `under` entry, collapse
 * entry), which is the pool's `indexUpdates`.
 *
 * THE READER. `one` = the forward slot + the target's presence (one counted
 * read: the target); `many` = the bucket (one counted read per member, by the
 * fence's wrapper); `size` = the bucket's size (free). Each records the slot
 * it read through the `read` option. Derivations read relations only through this
 * reader and never resolve one themselves.
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import {
  type BelongsToSpec,
  type CollapseSpec,
  collapseLosers,
  type EdgeSpec,
  type EntityName,
  type ModelSchema,
  extraRootOf,
  normalizeRootPath,
  type PrefixSpec,
  prefixAncestors,
  prefixCandidates,
  type RelationSpec,
  SCHEMA,
} from '../../../shared/src/schema'
import type { ReadableTable, TableSet } from './tables'

type Row = Readonly<Record<string, unknown>>

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
 * The target key a `belongsTo` or outgoing `edge` names on `row` (the foreign
 * key; the first edge of the declared type), WITHOUT the membership filter or
 * the target's presence. The engine computes forward entries with it; the
 * from-scratch scan (`enumerate.ts`) resolves with it too.
 */
export function relationRef(spec: LinkSpec, row: Row, schema: ModelSchema = SCHEMA): string | null {
  let target: unknown
  if (spec.kind === 'belongsTo') {
    if (spec.targetKey !== schema[spec.to].key) {
      throw new Error(`[pool] a belongsTo onto ${spec.to}.${spec.targetKey} is not a keyed join`)
    }
    target = row[spec.foreignKey]
  } else if (spec.kind === 'edge') {
    const edges = row[spec.edgeField]
    if (!Array.isArray(edges)) return null
    const hit = (edges as readonly Row[]).find((edge) => edge[spec.edgeTypeKey] === spec.edgeType)
    target = hit?.[spec.edgeIdKey]
  } else {
    throw new Error(`[pool] a prefix relation is resolved against its roots, not its row`)
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

interface Link {
  readonly from: EntityName
  readonly name: string
  readonly spec: LinkSpec
  /** `${from}.${name}`: the forward slots' relation. */
  readonly relation: string
  /** `${to}.${inverse}`: the collection this link maintains. */
  readonly collection: string
  readonly inputs: readonly string[]
  readonly forward: Map<string, string>
  readonly buckets: Map<string, Set<string>>
  /** `prefix` only: normalized path → members at or under it. */
  readonly under: Map<string, Set<string>> | null
  /** `prefix` only: member → its indexed normalized source path. */
  readonly placed: Map<string, string> | null
  /** POD-4671 — `prefix` with `alsoRoots` only: raw extra root → rows naming it. */
  readonly extraCounts: Map<string, number> | null
  /** POD-4671 — `prefix` with `alsoRoots` only: `${entity}:${id}` → raw root or null. */
  readonly extraByRow: Map<string, string | null> | null
  /** POD-4671 ruling Sep27 — prefix from issueId holder only: target → issueless members. */
  readonly issueless: Map<string, Set<string>> | null
}

/** One entity's collapse state. */
interface Collapse {
  readonly rule: CollapseSpec
  readonly groups: Map<string, Set<string>>
  readonly groupOf: Map<string, string>
  readonly collapsed: Set<string>
}

/** One relation slot written: `relation` is `${entity}.${name}`, `id` the row it is keyed by. */
export interface RelationWrite {
  readonly relation: string
  readonly id: string
}

export interface PoolRelationsOptions {
  readonly schema?: ModelSchema
  /**
   * Rows maintenance reads besides the changed one (collapse groups, flipped
   * rows): every KNOWN row, so in a lazy pool a cold one is read back by id
   * (POD-4580).
   */
  readonly rows: TableSet<ReadableTable>
  /** The raw tables, for `prefix` root probes: a miss reads no row. */
  readonly roots: TableSet<{ has(id: string): boolean }>
  /**
   * Whether `id` is present, for `one()` (tracked in the live pool). In a lazy
   * pool a KNOWN row is present, cold or not: `one()` names a cold target and
   * the reader decides whether it needs it loaded (POD-4580).
   */
  present(entity: EntityName, id: string): boolean
  /** A root probe hit (the reads fence counts it). */
  touch?(entity: EntityName, id: string): void
  /** A reader read a relation slot (the live pool records the running cell). */
  read?(relation: string, id: string): void
  /** Elements touched by maintenance (`indexUpdates`). */
  onWrite?(elements: number): void
}

export class PoolRelations implements RelationReader {
  readonly schema: ModelSchema
  /** The slots written since the last `begin()`, in write order (repeats kept). */
  readonly lastWrites: RelationWrite[] = []
  private readonly options: PoolRelationsOptions
  private readonly links = new Map<string, Link>()
  private readonly collections = new Map<string, Link>()
  private readonly outgoing = new Map<EntityName, Link[]>()
  private readonly prefixTargets = new Map<EntityName, Link[]>()
  /** POD-4671: prefix links by the entities their `alsoRoots` name. */
  private readonly extraSources = new Map<EntityName, Link[]>()
  private readonly collapses = new Map<EntityName, Collapse>()
  /** The answer for a key no bucket holds (per engine: the lint refuses module state). */
  private readonly none: ReadonlySet<string> = new Set()

  constructor(options: PoolRelationsOptions) {
    this.options = options
    const schema = options.schema ?? SCHEMA
    this.schema = schema
    const entities = Object.keys(schema) as EntityName[]
    for (const from of entities) {
      this.outgoing.set(from, [])
      const rule = schema[from].collapse
      if (rule !== undefined) {
        this.collapses.set(from, {
          rule,
          groups: new Map(),
          groupOf: new Map(),
          collapsed: new Set(),
        })
      }
    }
    for (const from of entities) {
      for (const [name, spec] of Object.entries(schema[from].relations)) {
        if (!isLinkSpec(spec)) continue
        const prefix = spec.kind === 'prefix'
        const extra = prefix && spec.alsoRoots !== undefined && spec.alsoRoots.length > 0
        const issueless =
          prefix && (schema[from].fields as Record<string, unknown>)['issueId'] !== undefined
        const link: Link = {
          from,
          name,
          spec,
          relation: `${from}.${name}`,
          collection: `${spec.to}.${spec.inverse}`,
          inputs: linkInputs(spec),
          forward: new Map(),
          buckets: new Map(),
          under: prefix ? new Map() : null,
          placed: prefix ? new Map() : null,
          extraCounts: extra ? new Map() : null,
          extraByRow: extra ? new Map() : null,
          issueless: issueless ? new Map() : null,
        }
        this.links.set(link.relation, link)
        this.collections.set(link.collection, link)
        this.outgoing.get(from)?.push(link)
        if (prefix)
          this.prefixTargets.set(spec.to, [...(this.prefixTargets.get(spec.to) ?? []), link])
        if (prefix && spec.alsoRoots !== undefined) {
          for (const source of spec.alsoRoots) {
            this.extraSources.set(
              source.entity,
              [...(this.extraSources.get(source.entity) ?? []), link],
            )
          }
        }
      }
    }
    for (const from of entities) {
      for (const [name, spec] of Object.entries(schema[from].relations)) {
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
    this.options.read?.(link.relation, id)
    const target = link.forward.get(id)
    if (target === undefined) return null
    // POD-4671: a prefix with `alsoRoots` is present in the union.
    if (link.extraCounts?.has(target) === true) return target
    if (this.options.present(link.spec.to, target)) return target
    // POD-4671: an issue's own checkout resolves in the same union.
    for (const other of this.links.values()) {
      if (other.spec.to !== link.spec.to || other.extraCounts === null) continue
      if (other.extraCounts.has(target)) return target
    }
    return null
  }

  many(from: EntityName, id: string, relation: string): Iterable<string> {
    return this.bucket(from, id, relation)
  }

  size(from: EntityName, id: string, relation: string): number {
    return this.bucket(from, id, relation).size
  }

  issueless(from: EntityName, id: string, relation: string): Iterable<string> {
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with issueless()`)
    }
    // POD-4671 ruling Sep27: maintained issueless set, never session rows.
    if (link.issueless === null) {
      throw new Error(`[pool] ${from}.${relation} has no issueless index`)
    }
    this.options.read?.(link.collection, id)
    return link.issueless.get(id) ?? this.none
  }

  /**
   * The raw forward key of a single-valued relation (`belongsTo`, outgoing
   * `edge`): what the engine filed this row under, WITHOUT the target's
   * presence. The membership filter (`where`) and the collapse rule are
   * already applied (a rejected row files nowhere); a re-added target
   * resolves by itself, as with `one()`.
   *
   * Hb3's progress filing reads this, never `one()`: `one()` also reads the
   * target's presence, so loading a parent would re-run every cold child's
   * filing (one presence probe each). This door subscribes the running cell
   * to the row's own forward slot only, so a re-parent re-files exactly the
   * moved row. Not entity rows: the reads fence does not count it.
   */
  forward(from: EntityName, id: string, relation: string): string | null {
    const link = this.links.get(`${from}.${relation}`)
    if (link === undefined) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    }
    this.options.read?.(link.relation, id)
    return link.forward.get(id) ?? null
  }

  private bucket(from: EntityName, id: string, relation: string): ReadonlySet<string> {
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    this.options.read?.(link.collection, id)
    return link.buckets.get(id) ?? this.none
  }

  // ------------------------------------------------------------- maintenance

  /** A collection's members, untracked (ingest: another lane of a repo). */
  members(from: EntityName, id: string, relation: string): ReadonlySet<string> {
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) throw new Error(`[pool] ${from}.${relation} is not a collection`)
    return link.buckets.get(id) ?? this.none
  }

  /** Whether `id`'s row is collapsed away by its entity's rule. */
  isCollapsed(entity: EntityName, id: string): boolean {
    return this.collapses.get(entity)?.collapsed.has(id) ?? false
  }

  /** Start an event: forget the previous event's write record. */
  begin(): void {
    this.lastWrites.length = 0
  }

  /** One table write happened (`prev`/`next` undefined: absent): maintain every relation it touches. */
  changed(
    entity: EntityName,
    id: string,
    prev: object | undefined,
    next: object | undefined,
  ): void {
    const before = prev as Row | undefined
    const after = next as Row | undefined
    const flipped = this.recollapse(entity, id, before, after)
    const selfFlipped = flipped.delete(id)
    const links = this.outgoing.get(entity) ?? []
    for (const link of links) {
      if (after === undefined) this.relink(link, id, undefined)
      else if (before === undefined || selfFlipped || !sameInputs(link.inputs, before, after))
        this.relink(link, id, after)
    }
    for (const other of flipped) {
      const row = this.options.rows[entity].get(other) as Row | undefined
      for (const link of links) this.relink(link, other, row)
    }
    // POD-4671 ruling Sep27: a session flipping its issueId without moving
    // lanes (relink skipped: issueId is not a link input) still leaves or
    // joins the issueless set of its current root. No table read: before and
    // after are already in hand; the forward is peeked, not read.
    if (entity === 'session' && before !== undefined && after !== undefined) {
      const was = (before as Row)['issueId'] === undefined
      const now = (after as Row)['issueId'] === undefined
      if (was !== now) {
        for (const link of this.outgoing.get(entity) ?? []) {
          if (link.issueless === null || link.spec.kind !== 'prefix') continue
          const target = link.forward.get(id)
          if (target === undefined) continue
          if (now) this.addIssueless(link, target, id)
          else this.dropIssueless(link, target, id)
        }
      }
    }
    if ((before === undefined) !== (after === undefined)) {
      for (const link of this.prefixTargets.get(entity) ?? []) {
        if (after !== undefined) {
          if (link.extraCounts?.has(id) === true) continue
          this.rootAdded(link, id)
        } else {
          if (link.extraCounts?.has(id) === true) continue
          this.rootRemoved(link, id)
        }
      }
    }
    for (const link of this.extraSources.get(entity) ?? []) {
      this.extraChanged(link, entity, id, before, after)
    }
  }

  /**
   * POD-4671 — maintain one prefix link's extra roots from an extra-source
   * row's write. Only the sessions under the gained/lost path re-file.
   */
  private extraChanged(
    link: Link,
    entity: EntityName,
    id: string,
    before: Row | undefined,
    after: Row | undefined,
  ): void {
    const counts = link.extraCounts
    const byRow = link.extraByRow
    if (counts === null || byRow === null) return
    if (link.spec.kind !== 'prefix' || link.spec.alsoRoots === undefined) return
    const key = `${entity}:${id}`
    const oldRaw = byRow.get(key) ?? null
    let newRaw: string | null = null
    if (after !== undefined) {
      for (const source of link.spec.alsoRoots) {
        if (source.entity !== entity) continue
        const root = extraRootOf(source, after)
        if (root !== null) {
          newRaw = root
          break
        }
      }
      void before
    }
    if (oldRaw === newRaw) return
    if (oldRaw === null) {
      if (newRaw !== null) {
        byRow.set(key, newRaw)
        const count = (counts.get(newRaw) ?? 0) + 1
        counts.set(newRaw, count)
        if (count === 1 && !this.options.roots[link.spec.to].has(newRaw)) {
          this.rootAdded(link, newRaw)
        }
      }
      return
    }
    if (newRaw === null) {
      byRow.delete(key)
      const count = (counts.get(oldRaw) ?? 0) - 1
      if (count <= 0) {
        counts.delete(oldRaw)
        if (!this.options.roots[link.spec.to].has(oldRaw)) {
          this.rootRemoved(link, oldRaw)
        }
      } else {
        counts.set(oldRaw, count)
      }
      return
    }
    byRow.set(key, newRaw)
    const added = (counts.get(newRaw) ?? 0) + 1
    counts.set(newRaw, added)
    if (added === 1 && !this.options.roots[link.spec.to].has(newRaw)) {
      this.rootAdded(link, newRaw)
    }
    const left = (counts.get(oldRaw) ?? 0) - 1
    if (left <= 0) {
      counts.delete(oldRaw)
      if (!this.options.roots[link.spec.to].has(oldRaw)) {
        this.rootRemoved(link, oldRaw)
      }
    } else {
      counts.set(oldRaw, left)
    }
  }

  /**
   * What the engine holds (the bootstrap count, POD-4580): forward entries,
   * bucket `Set`s and their members, prefix-index entries, collapse entries.
   * Ids only, plain, and the same whatever the rows' residency.
   */
  footprint(): {
    forward: number
    buckets: number
    members: number
    under: number
    collapse: number
  } {
    const out = { forward: 0, buckets: 0, members: 0, under: 0, collapse: 0 }
    for (const link of this.links.values()) {
      out.forward += link.forward.size
      out.buckets += link.buckets.size
      for (const bucket of link.buckets.values()) out.members += bucket.size
      for (const set of link.under?.values() ?? []) out.under += set.size
    }
    for (const collapse of this.collapses.values()) {
      out.collapse += collapse.groupOf.size + collapse.collapsed.size
    }
    return out
  }

  /** Forget everything (the pool's dispose). */
  clear(): void {
    for (const link of this.links.values()) {
      link.forward.clear()
      link.buckets.clear()
      link.under?.clear()
      link.placed?.clear()
      link.extraCounts?.clear()
      link.extraByRow?.clear()
      link.issueless?.clear()
    }
    for (const collapse of this.collapses.values()) {
      collapse.groups.clear()
      collapse.groupOf.clear()
      collapse.collapsed.clear()
    }
    this.lastWrites.length = 0
  }

  /**
   * Re-decide the collapse groups `id` leaves and joins, when its collapse
   * inputs moved. Returns the ids whose collapsed state flipped (`id`
   * included when it flipped itself). Reads the rows of the groups it
   * decides, and only when a group has two rows or more.
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
    // A row that keeps its group whole before and after: the group was kept in
    // full and still is, so nothing in it can flip (a live row's heartbeat).
    if (
      oldKey === newKey &&
      before !== undefined &&
      after !== undefined &&
      rule.keepsGroup(before) &&
      rule.keepsGroup(after)
    ) {
      return flipped
    }
    if (oldKey !== newKey) {
      if (oldKey !== null) {
        const group = groups.get(oldKey)
        group?.delete(id)
        if (group?.size === 0) groups.delete(oldKey)
        groupOf.delete(id)
        this.touched(2)
      }
      if (newKey !== null) {
        let group = groups.get(newKey)
        if (group === undefined) {
          group = new Set()
          groups.set(newKey, group)
        }
        group.add(id)
        groupOf.set(id, newKey)
        this.touched(2)
      }
    }
    if (newKey === null && collapsed.delete(id)) {
      flipped.add(id)
      this.touched(1)
    }
    for (const key of oldKey === newKey ? [newKey] : [oldKey, newKey]) {
      if (key === null) continue
      const group = groups.get(key)
      if (group === undefined) continue
      let losers: ReadonlySet<string> = this.none
      if (group.size > 1) {
        const table = this.options.rows[entity]
        const members: { id: string; row: Row }[] = []
        for (const member of group) {
          const row = (member === id ? after : table.get(member)) as Row | undefined
          // A cold peer read back by id may already be gone from the kernel,
          // its removal later in this event: it re-decides the group then.
          if (row !== undefined) members.push({ id: member, row })
        }
        losers = new Set(collapseLosers(rule, members))
      }
      for (const member of group) {
        if (losers.has(member) === collapsed.has(member)) continue
        if (losers.has(member)) collapsed.add(member)
        else collapsed.delete(member)
        flipped.add(member)
        this.touched(1)
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
    if (link.spec.kind === 'prefix') {
      const path = member ? row[link.spec.sourceField] : undefined
      const normalized = typeof path === 'string' ? normalizeRootPath(path) : null
      this.place(link, id, normalized)
      if (normalized !== null) target = this.probeRoot(link, normalized)
    } else if (member) {
      target = relationRef(link.spec, row, this.schema)
    }
    const old = link.forward.get(id) ?? null
    this.point(link, id, target)
    // POD-4671 ruling Sep27: maintain the issueless set at the delta (no row
    // reads to filter later). `row` is already in hand; `old` is the forward
    // before `point()`.
    if (link.issueless !== null) {
      if (old !== null && old !== target) this.dropIssueless(link, old, id)
      if (row !== undefined && target !== null && (row as Row)['issueId'] === undefined) {
        this.addIssueless(link, target, id)
      }
    }
  }

  /** Whether `id` is currently in `link`'s issueless set for `target` (no row read). */
  private wasIssueless(link: Link, id: string, target: string): boolean {
    return link.issueless?.get(target)?.has(id) === true
  }

  private addIssueless(link: Link, target: string, id: string): void {
    const sets = link.issueless
    if (sets === null) return
    let set = sets.get(target)
    if (set === undefined) {
      set = new Set()
      sets.set(target, set)
    }
    if (!set.has(id)) {
      set.add(id)
      this.touched(1)
      this.wrote(link.collection, target)
    }
  }

  private dropIssueless(link: Link, target: string, id: string): void {
    const set = link.issueless?.get(target)
    if (set === undefined || !set.has(id)) return
    set.delete(id)
    this.touched(1)
    this.wrote(link.collection, target)
    if (set.size === 0) link.issueless?.delete(target)
  }

  /** Point source `id` at `target` (null: nothing): detach, then attach. */
  private point(link: Link, id: string, target: string | null): void {
    const old = link.forward.get(id)
    if ((old ?? null) === target) return
    if (old !== undefined) {
      const bucket = link.buckets.get(old)
      bucket?.delete(id)
      if (bucket?.size === 0) link.buckets.delete(old)
      link.forward.delete(id)
      this.touched(2)
      this.wrote(link.collection, old)
    }
    if (target !== null) {
      let bucket = link.buckets.get(target)
      if (bucket === undefined) {
        bucket = new Set()
        link.buckets.set(target, bucket)
      }
      bucket.add(id)
      link.forward.set(id, target)
      this.touched(2)
      this.wrote(link.collection, target)
    }
    this.wrote(link.relation, id)
  }

  /** Index `id` under every ancestor of its normalized source path (prefix links). */
  private place(link: Link, id: string, normalized: string | null): void {
    const under = link.under as Map<string, Set<string>>
    const placed = link.placed as Map<string, string>
    const old = placed.get(id) ?? null
    if (old === normalized) return
    if (old !== null) {
      for (const path of prefixAncestors(old)) {
        const set = under.get(path)
        set?.delete(id)
        if (set?.size === 0) under.delete(path)
        this.touched(1)
      }
      placed.delete(id)
    }
    if (normalized !== null) {
      for (const path of prefixAncestors(normalized)) {
        let set = under.get(path)
        if (set === undefined) {
          set = new Set()
          under.set(path, set)
        }
        set.add(id)
        this.touched(1)
      }
      placed.set(id, normalized)
    }
  }

  /** The longest present root containing `normalized`, by keyed probes (a miss reads no row). */
  private probeRoot(link: Link, normalized: string): string | null {
    const roots = this.options.roots[link.spec.to]
    for (const candidate of prefixCandidates(normalized)) {
      if (roots.has(candidate)) {
        this.options.touch?.(link.spec.to, candidate)
        return candidate
      }
      // POD-4671: the union — an issue path needs no lane and no touch.
      if (link.extraCounts?.has(candidate) === true) return candidate
    }
    return null
  }

  /** A new root takes the members under it that sit at a shorter root or at none. */
  private rootAdded(link: Link, root: string): void {
    const normalized = normalizeRootPath(root)
    const candidates = link.under?.get(normalized)
    if (candidates === undefined) return
    for (const id of [...candidates]) {
      const current = link.forward.get(id)
      if (current !== undefined && normalizeRootPath(current).length >= normalized.length) continue
      const was = current !== undefined ? this.wasIssueless(link, id, current) : false
      this.point(link, id, root)
      // POD-4671 ruling Sep27: keep the issueless set at the delta. Reads the
      // moving row once (O(sessions under the path), never the corpus; never
      // on a rename, which moves no root).
      if (link.issueless !== null) {
        if (was) this.dropIssueless(link, current as string, id)
        const row = this.options.rows[link.from].get(id) as Row | undefined
        if (row !== undefined && (row as Row)['issueId'] === undefined) {
          this.addIssueless(link, root, id)
        }
      }
    }
  }

  /**
   * A removed root's members move to the next-longest root. Every member's
   * path lies at or under the removed root, so their next root is the same:
   * the longest present root containing the removed one.
   */
  private rootRemoved(link: Link, root: string): void {
    const bucket = link.buckets.get(root)
    if (bucket === undefined) {
      // Even with no bucket members, the issueless set for a removed root is
      // dropped with the root (its sets are keyed by the raw root).
      link.issueless?.delete(root)
      return
    }
    const next = this.probeRoot(link, normalizeRootPath(root))
    for (const id of [...bucket]) {
      const was = this.wasIssueless(link, id, root)
      this.point(link, id, next)
      if (link.issueless !== null) {
        if (was) this.dropIssueless(link, root, id)
        if (next !== null) {
          const row = this.options.rows[link.from].get(id) as Row | undefined
          if (row !== undefined && (row as Row)['issueId'] === undefined) {
            this.addIssueless(link, next, id)
          }
        }
      }
    }
    if ((link.issueless?.get(root)?.size ?? 0) === 0) link.issueless?.delete(root)
  }

  private wrote(relation: string, id: string): void {
    this.lastWrites.push({ relation, id })
  }

  private touched(elements: number): void {
    this.options.onWrite?.(elements)
  }
}

function sameInputs(fields: readonly string[], a: Row, b: Row): boolean {
  for (const field of fields) if (a[field] !== b[field]) return false
  return true
}
