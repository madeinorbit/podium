/**
 * POD-4565 (Ma1) — the shared relation accessor (`RelationReader`, L5a) over
 * the pool's tables, read from the declared schema.
 *
 * WHAT Ma1 RESOLVES. The single-valued relations whose target is named by the
 * source row itself — `belongsTo` (a foreign key) and outgoing `edge` (the
 * row's own edge list) — by a keyed table read. They need no maintained
 * state: the answer is the source row's field plus the target's presence,
 * and both are tracked reads of table slots. `issue.repo` (for `displayRef`)
 * and `issue.discoveredFrom` (for `originTick`) are two of them.
 *
 * WHAT IS STUBBED UNTIL Ma2 (POD-4566). Everything that needs an inverse
 * bucket or a root set: `hasMany`, incoming `edge`, and `prefix` answer
 * "none" (`one` → null, `many` → nothing, `size` → 0). The row views read
 * them through this accessor already, so Ma2 swaps the answers, not the
 * readers.
 *
 * Membership filters (`where`) are applied on the source row, as declared.
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import { type EntityName, type RelationSpec, SCHEMA } from '../../../shared/src/schema'

/** The read surface a relation needs; a fenced table, a MobX map and a `Map` all have it. */
export interface ReadableTable {
  get(id: string): unknown
  has(id: string): boolean
}

export type ReadableTables = { readonly [E in EntityName]: ReadableTable }

const NONE: readonly string[] = Object.freeze([])

function specOf(from: EntityName, relation: string): RelationSpec {
  const spec = SCHEMA[from].relations[relation]
  if (spec === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
  return spec
}

/**
 * The target key a single-valued relation names on `row` (`belongsTo`: the
 * foreign key; outgoing `edge`: the first edge of the declared type), after
 * the declared membership filter, WITHOUT checking the target is present.
 * Reading it costs the source row only; `one` adds the presence check.
 */
export function relationRef(from: EntityName, relation: string, row: Readonly<Record<string, unknown>>): string | null {
  const spec = specOf(from, relation)
  if (spec.where !== undefined && !spec.where.test(row)) return null
  let target: unknown
  if (spec.kind === 'belongsTo') {
    if (spec.targetKey !== SCHEMA[spec.to].key) {
      throw new Error(`[pool] ${from}.${relation} joins on a non-key field; not a keyed read`)
    }
    target = row[spec.foreignKey]
  } else if (spec.kind === 'edge' && spec.direction === 'out') {
    const edges = row[spec.edgeField]
    if (!Array.isArray(edges)) return null
    const hit = (edges as readonly Readonly<Record<string, unknown>>[]).find(
      (edge) => edge[spec.edgeTypeKey] === spec.edgeType,
    )
    target = hit?.[spec.edgeIdKey]
  } else {
    throw new Error(`[pool] ${from}.${relation} is not resolved from its own row (${spec.kind})`)
  }
  return typeof target === 'string' && target.length > 0 ? target : null
}

export class PoolRelations implements RelationReader {
  constructor(private readonly tables: ReadableTables) {}

  one(from: EntityName, id: string, relation: string): string | null {
    const spec = specOf(from, relation)
    if (spec.kind !== 'belongsTo' && !(spec.kind === 'edge' && spec.direction === 'out')) {
      if (spec.kind === 'hasMany' || spec.kind === 'edge') {
        throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
      }
      return null // prefix: Ma2
    }
    const row = this.tables[from].get(id) as Readonly<Record<string, unknown>> | undefined
    if (row === undefined) return null
    const target = relationRef(from, relation, row)
    return target !== null && this.tables[spec.to].has(target) ? target : null
  }

  many(from: EntityName, _id: string, relation: string): Iterable<string> {
    const spec = specOf(from, relation)
    if (spec.kind === 'belongsTo' || spec.kind === 'prefix' || (spec.kind === 'edge' && spec.direction === 'out')) {
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    return NONE // hasMany / incoming edge: Ma2
  }

  size(from: EntityName, id: string, relation: string): number {
    this.many(from, id, relation) // validates the kind
    return 0 // Ma2
  }
}
