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
import { relationTargets } from '@podium/client-graph/shared/links'
import {
  type BelongsToSpec,
  type CollapseSpec,
  collapseLosers,
  type EdgeSpec,
  type EntityName,
  extraRootOf,
  type ModelSchema,
  normalizeRootPath,
  type PrefixSpec,
  prefixAncestors,
  prefixCandidates,
  type RelationSpec,
  SCHEMA,
} from '@podium/client-graph/shared/schema'
import type { ReadableTable, TableSet } from './tables'

type Row = Readonly<Record<string, unknown>>

/**
 * POD-4708 — lower bound by id in a sorted seat list (default `.sort()`
 * order, UTF-16 code units via `<`): first index with `list[i] >= id`.
 * Insert there to keep id order; remove there when it holds `id`.
 * Family-small: binary search + splice shifting is trivial.
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

/** POD-4708 — no seats (shared frozen, never written). */
const EMPTY_SEAT_LIST: readonly string[] = Object.freeze([])

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
    if (spec.many) throw new Error('[pool] a many edge is a collection, not a single reference')
    const edges = row[spec.edgeField]
    if (!Array.isArray(edges)) return null
    const hit = (edges as readonly Row[]).find((edge) => spec.allTypes || edge[spec.edgeTypeKey] === spec.edgeType)
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
  readonly forwardMany: Map<string, ReadonlySet<string>> | null
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
   * rows): resident rows only. A cold row's fields the engine needs again it
   * keeps itself, from the row ingest hands it (POD-4753), never read by id.
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
  /**
   * POD-4745 — `member` joined the issueless set of `collection` at
   * `target`, as it happens, by any cause (its own row, a collapse flip, a
   * root gained or lost). Residency settles what it can keep once the
   * publication's rows are in; never call back into the engine from here.
   */
  onIssuelessJoin?(collection: string, target: string, member: string): void
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
  /**
   * POD-4753 — per cold-capable entity whose rows the engine reads again
   * (a collapse's peers and flips): the fields it reads, and each
   * non-resident row's summary (those fields only), taken from the row ingest
   * hands it and dropped when the row turns resident or leaves.
   */
  private readonly summaryFields = new Map<EntityName, readonly string[]>()
  private readonly summaries = new Map<EntityName, Map<string, Row>>()
  /**
   * POD-4708 — each issue's explicit seats (`issue.sessions`), maintained
   * SORTED from the relation's own bucket deltas (one element per move:
   * binary search + splice at its id-order position, never the family).
   * The rule is declared once in the schema (`issue.sessions`); this mirror
   * follows the engine's delta in the same action that moved the bucket
   * (`point`). Immutable arrays (a new array per change, never mutated in
   * place) so a cell holding the old list never sees it move underneath.
   * Family-small (avg 1.7, max 8): splice shifting is trivial.
   */
  private readonly seatSorted = new Map<string, readonly string[]>()
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
          prefix && (schema[from].fields as Record<string, unknown>).issueId !== undefined
        const link: Link = {
          from,
          name,
          spec,
          relation: `${from}.${name}`,
          collection: `${spec.to}.${spec.inverse}`,
          inputs: linkInputs(spec),
          forward: new Map(),
          forwardMany: spec.kind === 'edge' && spec.many ? new Map() : null,
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
    // The rows the engine reads again (a collapse's peers and flips), when
    // they can be cold: exactly the fields it reads of such a row.
    for (const from of entities) {
      if (schema[from].cold.kind === 'never') continue
      const collapse = schema[from].collapse
      const own = this.outgoing.get(from) ?? []
      const rereads = collapse !== undefined
      if (!rereads) continue
      const fields = new Set(collapse?.fields ?? [])
      for (const link of own) {
        for (const field of link.inputs) fields.add(field)
      }
      // The issueless maintenance reads `issueId` off the row already in
      // hand; a flipped peer's relink needs it again, so it is in the inputs
      // above when the link names it. Nothing more is read.
      this.summaryFields.set(from, [...fields])
      this.summaries.set(from, new Map())
    }
  }

  // ------------------------------------------------------------------ reader

  one(from: EntityName, id: string, relation: string): string | null {
    const link = this.links.get(`${from}.${relation}`)
    if (link === undefined || link.forwardMany) {
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

  subset(from: EntityName, id: string, relation: string, subset: string): Iterable<string> {
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    // POD-4758: the schema declares the subset (`HasManySpec.subsets`); this
    // paused arm still maintains the one declared today by its own hard-coded
    // test (the MobX engine maintains any declared subset generically).
    const declared = this.schema[from].relations[relation]
    if (declared?.kind !== 'hasMany' || declared.subsets?.[subset] === undefined) {
      throw new Error(`[pool] ${from}.${relation} declares no subset "${subset}"`)
    }
    if (subset !== 'issueless') {
      throw new Error(`[pool] the hand engine maintains only the issueless subset, not "${subset}"`)
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
    if (link === undefined || link.forwardMany) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    }
    this.options.read?.(link.relation, id)
    return link.forward.get(id) ?? null
  }

  /** The raw forward slot of `from:id` (maintenance: untracked, no presence check; POD-4745). */
  forwardTarget(from: EntityName, id: string, relation: string): string | null {
    const link = this.links.get(`${from}.${relation}`)
    if (link === undefined || link.forwardMany) {
      specOf(this.schema, from, relation)
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    }
    return link.forward.get(id) ?? null
  }

  private bucket(from: EntityName, id: string, relation: string): ReadonlySet<string> {
    const outgoing = this.links.get(`${from}.${relation}`)
    if (outgoing?.forwardMany) {
      this.options.read?.(outgoing.relation, id)
      return outgoing.forwardMany.get(id) ?? this.none
    }
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
    const outgoing = this.links.get(`${from}.${relation}`)
    if (outgoing?.forwardMany) return outgoing.forwardMany.get(id) ?? this.none
    const link = this.collections.get(`${from}.${relation}`)
    if (link === undefined) throw new Error(`[pool] ${from}.${relation} is not a collection`)
    return link.buckets.get(id) ?? this.none
  }

  /**
   * POD-4708 — an issue's explicit seats (`issue.sessions`), maintained
   * SORTED from the relation's own bucket deltas (see `point`). Tracked on
   * the same slot derivations read (`issue.sessions:${id}`), so a membership
   * change dirties exactly the cells that read it — but counted NOWHERE via
   * the reads fence (the fence counts `many`/`subset` yields; this returns
   * the maintained array without yielding through it). A membership change
   * thus yields the new member only (its own row reads, already counted
   * there), never the family. Immutable: a new array per change, so a cell
   * holding the old list never sees it move.
   */
  seatList(issueId: string): readonly string[] {
    this.options.read?.('issue.sessions', issueId)
    return this.seatSorted.get(issueId) ?? EMPTY_SEAT_LIST
  }

  /** POD-4708 — seat lists held (tests: bootstrap census, burst budget). */
  seatFootprint(): { readonly lists: number; readonly members: number } {
    let members = 0
    for (const list of this.seatSorted.values()) members += list.length
    return { lists: this.seatSorted.size, members }
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
    // Keep the cold summary beside the row ingest hands over (POD-4753):
    // a resident row holds none, a cold one its declared fields, a gone one
    // nothing. The row itself is never read back by id.
    if (this.summaryFields.has(entity)) {
      const resident = this.options.rows[entity].get(id) !== undefined
      this.holdSummary(entity, id, resident ? undefined : after)
    }
    const flipped = this.recollapse(entity, id, before, after)
    const selfFlipped = flipped.delete(id)
    const links = this.outgoing.get(entity) ?? []
    for (const link of links) {
      if (after === undefined) this.relink(link, id, undefined)
      else if (before === undefined || selfFlipped || !sameInputs(link.inputs, before, after))
        this.relink(link, id, after)
    }
    for (const other of flipped) {
      const row = this.maintainedRow(entity, other)
      for (const link of links) this.relink(link, other, row)
    }
    // POD-4671 ruling Sep27: a session flipping its issueId without moving
    // lanes (relink skipped: issueId is not a link input) still leaves or
    // joins the issueless set of its current root. No table read: before and
    // after are already in hand; the forward is peeked, not read.
    if (entity === 'session' && before !== undefined && after !== undefined) {
      const was = (before as Row).issueId === undefined
      const now = (after as Row).issueId === undefined
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
    // POD-4671: the extra roots themselves — only when a root-bearing field
    // moved (old root != new root). The rows are already in hand, so the
    // check costs no plain-structure op; an unconditional dispatch on every
    // write is the F1 plant in the MobX suite. Never widen this.
    for (const link of this.extraSources.get(entity) ?? []) {
      if (!this.extraMoved(link, entity, before, after)) continue
      this.extraChanged(link, entity, id, before, after)
    }
  }

  /**
   * POD-4671 — whether `extraChanged` for `link` could move anything for this
   * write: any listed source field's normalized root differs old vs new
   * (insert/delete compare against null = no root). Reads only the two rows
   * already in hand — no table, relation or plain-structure read.
   */
  private extraMoved(
    link: Link,
    entity: EntityName,
    before: Row | undefined,
    after: Row | undefined,
  ): boolean {
    if (link.spec.kind !== 'prefix' || link.spec.alsoRoots === undefined) return false
    for (const source of link.spec.alsoRoots) {
      if (source.entity !== entity) continue
      const oldRoot = before === undefined ? null : extraRootOf(source, before)
      const newRoot = after === undefined ? null : extraRootOf(source, after)
      if (oldRoot !== newRoot) return true
    }
    return false
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
      out.forward += link.forwardMany?.size ?? 0
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
      link.forwardMany?.clear()
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
    for (const held of this.summaries.values()) held.clear()
    this.seatSorted.clear()
    this.lastWrites.length = 0
  }

  /**
   * Hold `row`'s summary for `entity:id` (not resident), or drop it
   * (resident, or gone). The pool calls this with the row ingest hands it:
   * a cold row's summary replaces on every write, a resident row holds none.
   * Never a read by id.
   */
  holdSummary(entity: EntityName, id: string, row: Row | undefined): void {
    const fields = this.summaryFields.get(entity)
    if (fields === undefined) return
    const held = this.summaries.get(entity)
    if (held === undefined) return
    if (row === undefined) {
      held.delete(id)
      return
    }
    const summary: Record<string, unknown> = {}
    for (const field of fields) {
      const value = (row as Readonly<Record<string, unknown>>)[field]
      if (value !== undefined) summary[field] = value
    }
    held.set(id, summary as Row)
  }

  /** A maintenance read of `entity:other`: the resident row, else its summary. */
  private maintainedRow(entity: EntityName, other: string): Row | undefined {
    const resident = this.options.rows[entity].get(other) as Row | undefined
    if (resident !== undefined) return resident
    return this.summaries.get(entity)?.get(other)
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
        const members: { id: string; row: Row }[] = []
        for (const member of group) {
          const row =
            member === id ? after : (this.maintainedRow(entity, member) as Row | undefined)
          // A cold peer already gone from the kernel, its removal later in
          // this event: it re-decides the group then.
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
      (link.spec.uncollapsed || !this.isCollapsed(link.from, id))
    if (link.forwardMany) {
      const previous = link.forwardMany.get(id) ?? this.none
      const targets = member ? relationTargets(link.from, link.name, row, this.schema) : this.none
      if (previous.size === targets.size && [...previous].every(target => targets.has(target))) return
      for (const target of previous) if (!targets.has(target)) {
        const bucket = link.buckets.get(target)
        bucket?.delete(id)
        if (bucket?.size === 0) link.buckets.delete(target)
        this.touched(1); this.wrote(link.collection, target)
      }
      for (const target of targets) if (!previous.has(target)) {
        let bucket = link.buckets.get(target)
        if (!bucket) { bucket = new Set(); link.buckets.set(target, bucket) }
        bucket.add(id); this.touched(1); this.wrote(link.collection, target)
      }
      if (targets.size) link.forwardMany.set(id, targets)
      else link.forwardMany.delete(id)
      this.touched(1); this.wrote(link.relation, id)
      return
    }
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
      if (row !== undefined && target !== null && (row as Row).issueId === undefined) {
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
      this.options.onIssuelessJoin?.(link.collection, target, id)
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
      if (link.collection === 'issue.sessions') this.dropSeat(old, id)
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
      if (link.collection === 'issue.sessions') this.addSeat(target, id)
    }
    this.wrote(link.relation, id)
  }

  /**
   * POD-4708 — file one seat into its issue's maintained SORTED list, in the
   * same action that moved the bucket (see `point`). Binary search by id
   * (default `.sort()` order) + splice at its position. Immutable: a new
   * array per change. Family-small: the copy + shift is trivial.
   *
   * Not counted in `indexUpdates` (the bucket move already counts its two
   * elements there): the list follows the bucket, it is not a second index.
   * The `Map.set` itself is one plain-structure op, like the bucket's own.
   */
  private addSeat(target: string, id: string): void {
    const held = this.seatSorted.get(target) ?? EMPTY_SEAT_LIST
    const at = sortedIndex(held, id)
    if (at < held.length && held[at] === id) return
    const next = [...held.slice(0, at), id, ...held.slice(at)]
    this.seatSorted.set(target, Object.freeze(next) as readonly string[])
  }

  /** POD-4708 — drop one seat from its issue's maintained SORTED list (see `addSeat`). */
  private dropSeat(target: string, id: string): void {
    const held = this.seatSorted.get(target)
    if (held === undefined) return
    const at = sortedIndex(held, id)
    if (at >= held.length || held[at] !== id) return
    if (held.length === 1) {
      this.seatSorted.delete(target)
    } else {
      const next = [...held.slice(0, at), ...held.slice(at + 1)]
      this.seatSorted.set(target, Object.freeze(next) as readonly string[])
    }
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
        const row = this.maintainedRow(link.from, id)
        if (row !== undefined && (row as Row).issueId === undefined) {
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
          const row = this.maintainedRow(link.from, id)
          if (row !== undefined && (row as Row).issueId === undefined) {
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
