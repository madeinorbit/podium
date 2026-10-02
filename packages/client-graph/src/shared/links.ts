/**
 * POD-4758 (A5) — typed relation navigation, derived from the declared
 * schema (`schema.ts`, `DeclaredSchema`).
 *
 * The relation reader (`RelationReader`, `instrument/reads.ts`) takes a
 * relation by its string name: that is the engine's own surface, which walks
 * the schema generically. Code that means ONE relation navigates it by a
 * typed name instead, so a misspelled relation, a single read of a
 * collection, or a subset the collection does not declare does not compile.
 *
 * Two shapes read the same names:
 * - `RelationLinks` (here): by id, over any `RelationReader`. Derivations
 *   read it, because they run over three readers (the live pool's fenced
 *   engine, its plain maintenance pass and the rebuild's from-scratch scan)
 *   and must not build a model to follow a relation.
 *   `links.issue.repo(id)` is the target id or null; `links.issue.children`
 *   answers `ids(id)` and `size(id)`, plus one reader per declared subset
 *   (`links.worktree.sessions.issueless(id)`).
 * - the pool's model getters (`arms/mobx/pool/models.ts`), built from the
 *   same types: `issue.parent` is the parent model or `LOADING`,
 *   `issue.children` a lazy collection.
 */

import type { RelationReader } from './relation-reader'
import { type DeclaredSchema, type EntityName, type ModelSchema, SCHEMA } from './schema'

type Row = Readonly<Record<string, unknown>>

type Relations<E extends EntityName> = DeclaredSchema[E]['relations']

/** Every relation declared on `E`. */
export type RelationName<E extends EntityName> = keyof Relations<E> & string

type SpecOf<E extends EntityName, R extends RelationName<E>> = Relations<E>[R]

type IsCollection<S> = S extends { readonly kind: 'hasMany' }
  ? true
  : S extends { readonly kind: 'edge'; readonly direction: 'in' }
    ? true
    : S extends { readonly kind: 'edge'; readonly many: true } ? true : false

/** The collections of `E`: `hasMany` and incoming `edge`. */
export type CollectionName<E extends EntityName> = {
  [R in RelationName<E>]: IsCollection<SpecOf<E, R>> extends true ? R : never
}[RelationName<E>]

/** The single-valued relations of `E`: `belongsTo`, `prefix`, outgoing `edge`. */
export type SingleName<E extends EntityName> = Exclude<RelationName<E>, CollectionName<E>>

/** The entity relation `R` of `E` points at. */
export type TargetOf<E extends EntityName, R extends RelationName<E>> =
  SpecOf<E, R> extends {
    readonly to: infer T extends EntityName
  }
    ? T
    : never

/** Whether `E.R` is lazy (Rule L: its target can be non-resident). */
export type IsLazy<E extends EntityName, R extends RelationName<E>> =
  SpecOf<E, R> extends {
    readonly lazy: false
  }
    ? false
    : true

/** The subsets declared on the collection `E.R`. */
export type SubsetName<E extends EntityName, R extends RelationName<E>> =
  SpecOf<E, R> extends {
    readonly subsets: infer S
  }
    ? keyof S & string
    : never

/** A collection read by id: its members, its size, and each declared subset's members. */
export type CollectionLink<Subsets extends string> = {
  /** The member ids, unordered (a reader that needs an order sorts). */
  ids(id: string): Iterable<string>
  /** The member count. Uncounted, like `Map.size`. */
  size(id: string): number
} & { readonly [S in Subsets]: (id: string) => Iterable<string> }

/** One entity's relations, by id. */
export type EntityLinks<E extends EntityName> = {
  readonly [R in SingleName<E>]: (id: string) => string | null
} & {
  readonly [R in CollectionName<E>]: CollectionLink<SubsetName<E, R>>
}

/** Every relation of every entity, by id: `links.issue.repo(id)`. */
export type RelationLinks = { readonly [E in EntityName]: EntityLinks<E> }

/**
 * The typed links over `reader`, built once from `schema` (the declared one
 * unless a test passes a fixture). Every call is the reader's own call, so a
 * fence wrapping `reader` counts exactly what it counted before.
 */
export function relationLinks(reader: RelationReader, schema: ModelSchema = SCHEMA): RelationLinks {
  const out: Record<string, Record<string, unknown>> = {}
  for (const from of Object.keys(schema) as EntityName[]) {
    const entity: Record<string, unknown> = {}
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      const collection =
        spec.kind === 'hasMany' || (spec.kind === 'edge' && (spec.direction === 'in' || spec.many))
      if (!collection) {
        entity[name] = (id: string) => reader.one(from, id, name)
        continue
      }
      const link: Record<string, unknown> = {
        ids: (id: string) => reader.many(from, id, name),
        size: (id: string) => reader.size(from, id, name),
      }
      if (spec.kind === 'hasMany') {
        for (const subset of Object.keys(spec.subsets ?? {})) {
          link[subset] = (id: string) => reader.subset(from, id, name, subset)
        }
      }
      entity[name] = Object.freeze(link)
    }
    out[from] = Object.freeze(entity)
  }
  return Object.freeze(out) as unknown as RelationLinks
}

/** The relations of `E` resolved from the row alone: `belongsTo` and outgoing `edge`. */
export type RefName<E extends EntityName> = {
  [R in SingleName<E>]: SpecOf<E, R> extends { readonly kind: 'prefix' } ? never : R
}[SingleName<E>]

/**
 * Every row-resolved relation, typed: `refs.issue.parent(row)` is the key
 * the row names ({@link relationRef}), without reading any other row.
 */
export type RelationRefs = {
  readonly [E in EntityName]: { readonly [R in RefName<E>]: (row: object) => string | null }
}

function relationRefs(schema: ModelSchema): RelationRefs {
  const out: Record<string, Record<string, unknown>> = {}
  for (const from of Object.keys(schema) as EntityName[]) {
    const entity: Record<string, unknown> = {}
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (spec.kind === 'belongsTo' || (spec.kind === 'edge' && spec.direction === 'out' && !spec.many)) {
        entity[name] = (row: object) => relationRef(from, name, row, schema)
      }
    }
    out[from] = Object.freeze(entity)
  }
  return Object.freeze(out) as unknown as RelationRefs
}

/** The declared schema's row-resolved relations, typed. */
export const refs: RelationRefs = relationRefs(SCHEMA)

/**
 * The target key a `belongsTo` or outgoing `edge` names on `source` (the
 * foreign key; the first edge of the declared type), after the declared
 * membership filter, WITHOUT checking the target is present. Reading it costs
 * the source row only. The engine computes a link's forward key with it, and
 * the from-scratch scan (`enumerate.ts`) its oracle's; derivations read the
 * target through the reader instead, with one exception: the worklist files
 * each issue under its `issue.parent` key (POD-4571, `visible.ts`
 * `Standing.formalParent`, through `refs.issue.parent`), a maintenance
 * key that must not depend on the parent's residency. Moved here from the
 * MobX engine (POD-4758) so the typed `refs` can answer it.
 */
export function relationRef(
  from: EntityName,
  relation: string,
  source: object,
  schema: ModelSchema = SCHEMA,
): string | null {
  const spec = schema[from].relations[relation]
  if (spec === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
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
    if (spec.many) throw new Error(`[pool] ${from}.${relation} is a collection; read its targets`)
    const hit = (edges as readonly Row[]).find((edge) => spec.allTypes || edge[spec.edgeTypeKey] === spec.edgeType)
    target = hit?.[spec.edgeIdKey]
  } else {
    throw new Error(`[pool] ${from}.${relation} is not resolved from its own row (${spec.kind})`)
  }
  return typeof target === 'string' && target.length > 0 ? target : null
}

/** The source row's declared edge collection. Keys only, no target payloads;
 * duplicate edges/types between the same endpoints contribute one membership. */
export function relationTargets(from: EntityName, relation: string, source: object,
  schema: ModelSchema = SCHEMA): ReadonlySet<string> {
  const spec = schema[from].relations[relation]
  if (spec?.kind !== 'edge' || spec.direction !== 'out' || !spec.many)
    throw new Error(`[pool] ${from}.${relation} is not an outgoing edge collection`)
  const row = source as Row
  if (spec.where && !spec.where.test(row)) return new Set()
  const edges = row[spec.edgeField]
  return new Set(Array.isArray(edges) ? (edges as readonly Row[]).flatMap(edge => {
    const id = edge[spec.edgeIdKey]
    return (spec.allTypes || edge[spec.edgeTypeKey] === spec.edgeType) && typeof id === 'string' && id
      ? [id] : []
  }) : [])
}
