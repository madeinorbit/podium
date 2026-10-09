import { machinePathKey } from '@podium/model/browser'
/**
 * POD-4566 (Ma2) — the pool's relation reader (`RelationReader`, L5a),
 * answered from the declared schema (`shared/src/schema.ts`).
 *
 * POD-5407 — A VIEW, NOT A COPY. Every declared relation over every row the
 * feed carries is maintained ONCE, outside the pool, by the relation index
 * the row source's cold index holds (`shared/relation-index.ts`): links,
 * buckets, subsets, collapse, `prefix` roots and their `alsoRoots` union, with
 * the same declared maintenance this engine used to run. The pool used to run
 * it again for every row it attached, hot and cold (POD-5391: 99% of the
 * phone's 11k rows were cold, each linked at attach), and kept plain twins
 * and summaries for the cold ones (POD-5417 finding 14). Now this reader
 * stores nothing per row: a read answers from the index, and observes one
 * atom and a lazy ID-list field for the slot it read, made on first demand and
 * dropped when no derivation observes them ("observable on first access",
 * applied to the relations themselves). A bucket therefore holds its hot and
 * cold members alike with no seeding step and no copy; a slot nobody reads
 * costs nothing.
 *
 * NOTIFICATIONS. The index leaves a delta per publication (the forward slots,
 * buckets and subsets it moved, the collapse verdicts and order keys that
 * changed, the extra roots that came or went). The pool hands it to
 * `publish` inside the publication's one action, which reports exactly the
 * atoms it names: a bucket the publication did not touch is not notified, a
 * touched one once, a cancelled move (netted by the index) not at all. The
 * bucket deltas also feed the pool's seat lists and the sidebar roster
 * (`onBucket`), one member each.
 *
 * THE READER. `one` = the forward slot + the target's presence (the caller's
 * tracked presence, or the `alsoRoots` union); `many` = the bucket's members,
 * unordered (M3 F1), as a shallow-equal lazy list; `size` = the bucket's size;
 * `subset` = a declared subset's members. Derivations resolve every relation
 * through this reader and never themselves.
 */

import { createDemandAtoms, lazy } from '@podium/mobx-helpers'
import { compareShallow, observable } from 'mobx'
import { debugName } from './debug-name'
import { relationRef } from './shared/links'
import type { RelationDelta, RelationQueries } from './shared/relation-index'
import type { RelationReader } from './shared/relation-reader'
import { type EntityName, type ModelSchema, SCHEMA } from './shared/schema'

export { ancestorPaths, isLinkSpec, type LinkSpec, linkInputs, prefixCandidates } from './shared/relation-index'
// The declared link helpers live with the index; kept importable from here.
export { relationRef }

/** The read surface a relation needs; a table, a MobX map and a `Map` all have it. */
export interface ReadableTable {
  get(id: string): unknown
  has(id: string): boolean
}

export type ReadableTables = { readonly [E in EntityName]: ReadableTable }

/** What ingest needs of the relations: a collection's members (maintenance, sorted). */
export interface RelationMaintenance {
  members(from: EntityName, id: string, relation: string): readonly string[]
}

export interface PoolRelationsOptions {
  /** The relation index (the cold index's), read at every call: it may be replaced. */
  readonly index: () => RelationQueries
  /** TRACKED: whether `entity:id` is present for `one()` (in memory, or known cold). */
  readonly present: (entity: EntityName, id: string) => boolean
  readonly schema?: ModelSchema
  /**
   * POD-4678 — a bucket's net member move (inside the publication's action):
   * the collection (`issue.sessions`), the target, the member and whether it
   * was added. Generic: no relation named here.
   */
  readonly onBucket?: (collection: string, target: string, member: string, added: boolean) => void
}

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>())

/** One demand-scoped list field for an indexed relation slot. Models and
 * unloaded records both use IDs here; payload changes cannot change the list. */
class RelationList {
  constructor(
    private readonly read: () => ReadonlySet<string>,
    private readonly observe: () => void,
  ) {}

  @lazy({ equals: compareShallow })
  get ids(): readonly string[] {
    this.observe()
    return [...this.read()]
  }
}

export class PoolRelations implements RelationReader, RelationMaintenance {
  readonly schema: ModelSchema
  private readonly index: () => RelationQueries
  private readonly present: (entity: EntityName, id: string) => boolean
  private readonly onBucket: (collection: string, target: string, member: string, added: boolean) => void
  /** List holders and atoms belong to the same demand-scoped slot index. */
  private readonly lists = new Map<string, RelationList>()
  private readonly atoms = createDemandAtoms<string>(
    (key) => debugName(() => `pool.relation.${key}`) ?? 'Atom',
    { onUnobserved: (key) => this.lists.delete(key) },
  )
  /** Collections by name, and which outgoing links are many-valued (`from.relation`). */
  private readonly collections = new Set<string>()
  private readonly singles = new Set<string>()
  private readonly multiples = new Set<string>()

  constructor(options: PoolRelationsOptions) {
    this.schema = options.schema ?? SCHEMA
    this.index = options.index
    this.present = options.present
    this.onBucket = options.onBucket ?? (() => {})
    for (const from of Object.keys(this.schema) as EntityName[]) {
      for (const [name, spec] of Object.entries(this.schema[from].relations)) {
        const key = `${from}.${name}`
        if (spec.kind === 'hasMany' || (spec.kind === 'edge' && spec.direction === 'in')) this.collections.add(key)
        else if (spec.kind === 'edge' && spec.many === true) this.multiples.add(key)
        else this.singles.add(key)
      }
    }
  }

  // ------------------------------------------------------------------ reader

  one(from: EntityName, id: string, relation: string): string | null {
    const key = `${from}.${relation}`
    if (!this.singles.has(key)) {
      this.spec(from, relation)
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    }
    this.observe(`f:${key}:${id}`)
    const target = this.index().forward(from, id, relation)
    if (target === null) return null
    const to = this.schema[from].relations[relation]!.to
    // POD-4671: a prefix with `alsoRoots` (and a belongsTo onto the same
    // target, `issue.worktree`) resolves in the union, not only the table.
    this.observe(`r:${to}:${target}`)
    if (this.index().extraRoot(to, target)) return target
    return this.present(to, target) ? target : null
  }

  many(from: EntityName, id: string, relation: string): readonly string[] {
    const slot = this.slot(from, id, relation)
    return this.list(slot.key, slot.read)
  }

  size(from: EntityName, id: string, relation: string): number {
    const slot = this.slot(from, id, relation)
    this.observe(slot.key)
    return slot.read().size
  }

  subset(from: EntityName, id: string, relation: string, subset: string): readonly string[] {
    id = machinePathKey(id)
    const key = `${from}.${relation}`
    if (!this.collections.has(key)) {
      this.spec(from, relation)
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    const slot = `s:${key}.${subset}:${id}`
    return this.list(slot, () => this.index().subset(from, id, relation, subset))
  }

  /** A declared subset count borrows its maintained bucket, without a walk. */
  subsetSize(from: EntityName, id: string, relation: string, subset: string): number {
    id = machinePathKey(id)
    this.observe(`s:${from}.${relation}.${subset}:${id}`)
    return this.index().subset(from, id, relation, subset).size
  }

  /**
   * POD-4705 — the forward target `from:id` contributes on `relation`
   * (untracked: no presence check, no observation). Residency's lane rule and
   * the sidebar roster resolve a lane through it, inside an action; the
   * pool's tracked formal-parent reader observes the source's residency
   * address before calling it.
   */
  forwardTarget(from: EntityName, id: string, relation: string): string | null {
    if (!this.singles.has(`${from}.${relation}`)) {
      this.spec(from, relation)
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    }
    return this.index().forward(from, id, relation)
  }

  /** TRACKED: whether the entity's declared collapse folds `id` away. */
  isCollapsed(entity: EntityName, id: string): boolean {
    if (this.schema[entity].collapse === undefined) return false
    this.observe(`c:${entity}:${id}`)
    return this.index().collapsed(entity, id)
  }

  /** TRACKED: the declared collapse ordering, over the same groups. */
  orderKey(entity: EntityName, id: string): string {
    if (this.schema[entity].collapse === undefined) return id
    this.observe(`o:${entity}:${id}`)
    return this.index().orderKey(entity, id)
  }

  /** Maintenance only: a copy, in id order. */
  members(from: EntityName, id: string, relation: string): readonly string[] {
    return [...this.slot(from, id, relation).read()].sort()
  }

  // ------------------------------------------------------------ notification

  /**
   * One publication's delta, inside its action: report the slots it moved,
   * and hand each bucket move to `onBucket` (one member each).
   */
  publish(delta: RelationDelta): void {
    for (const [key, source] of delta.forwards) this.changed(`f:${key}:${source}`)
    const touched = new Set<string>()
    for (const [collection, target, member, added] of delta.buckets) {
      const key = `b:${collection}:${target}`
      if (!touched.has(key)) {
        touched.add(key)
        this.changed(key)
      }
      this.onBucket(collection, target, member, added)
    }
    for (const [key, target] of delta.subsets) this.changed(`s:${key}:${target}`)
    for (const [entity, id] of delta.flips) this.changed(`c:${entity}:${id}`)
    for (const [entity, id] of delta.orders) this.changed(`o:${entity}:${id}`)
    for (const [to, key] of delta.roots) this.changed(`r:${to}:${key}`)
  }

  /** Everything may have moved (the index was replaced or rebuilt): report every observed slot. */
  reset(): void {
    for (const atom of [...this.atoms.values()]) atom.reportChanged()
  }

  /** Forget everything (the pool's dispose). Call inside an action. */
  clear(): void {
    this.reset()
    this.atoms.clear()
    this.lists.clear()
  }

  // ------------------------------------------------------------------ slots

  private slot(from: EntityName, id: string, relation: string): { key: string; read: () => ReadonlySet<string> } {
    id = machinePathKey(id)
    const key = `${from}.${relation}`
    if (this.multiples.has(key)) return { key: `f:${key}:${id}`, read: () => this.index().targets(from, id, relation) }
    if (!this.collections.has(key)) {
      this.spec(from, relation)
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    return { key: `b:${key}:${id}`, read: () => this.index().members(from, id, relation) ?? NONE }
  }

  /** Slot holders are part of the data-layer index, retained only while
   * their lazy field observes the slot (including a synchronous action read). */
  private list(key: string, read: () => ReadonlySet<string>): readonly string[] {
    let list = this.lists.get(key)
    if (!list) {
      list = new RelationList(read, () => this.observe(key))
      this.lists.set(key, list)
    }
    try {
      return list.ids
    } catch (error) {
      this.lists.delete(key)
      throw error
    }
  }

  private spec(from: EntityName, relation: string): void {
    if (this.schema[from].relations[relation] === undefined) {
      throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
    }
  }

  private changed(key: string): void {
    this.atoms.get(key)?.reportChanged()
  }

  /** Make a slot read tracked: an atom for this slot, on the first read inside a derivation. */
  private observe(key: string): void {
    this.atoms.observe(key)
  }
}

const EMPTY_RELATION_IDS: readonly string[] = Object.freeze([])

/** Shared forward links and inverse membership for core and screen sources. Updates
 * touch only the buckets a member entered or left; unchanged buckets keep
 * their array identity. Call mutations inside the source publication action. */
export class RelationBuckets {
  private readonly forwards: Map<string, readonly string[]>
  private readonly buckets = observable.map<string, readonly string[]>(undefined, { deep: false })

  constructor(private readonly options: { trackedForward?: boolean; sorted?: boolean } = {}) {
    this.forwards = options.trackedForward
      ? observable.map<string, readonly string[]>(undefined, { deep: false })
      : new Map()
  }

  move(address: string, member: string, targets: readonly string[], bucket: (target: string) => string): void {
    const previous = this.forwards.get(address) ?? EMPTY_RELATION_IDS
    if (previous.length === targets.length && previous.every((target, index) => target === targets[index])) return
    for (const target of previous) {
      if (targets.includes(target)) continue
      const key = bucket(target), rest = this.many(key).filter(id => id !== member)
      if (rest.length) this.buckets.set(key, rest)
      else this.buckets.delete(key)
    }
    for (const target of targets) {
      if (previous.includes(target)) continue
      const key = bucket(target), next = [...this.many(key), member]
      if (this.options.sorted) next.sort()
      this.buckets.set(key, next)
    }
    if (targets.length) this.forwards.set(address, [...targets])
    else this.forwards.delete(address)
  }

  one(address: string): string | undefined { return this.forwards.get(address)?.[0] }
  many(key: string): readonly string[] { return this.buckets.get(key) ?? EMPTY_RELATION_IDS }
  clear(): void { this.forwards.clear(); this.buckets.clear() }
}
