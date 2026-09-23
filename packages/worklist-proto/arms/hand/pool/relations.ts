/**
 * POD-4578 (Ha1) — the shared relation accessor (`RelationReader`, L5a) over
 * the pool's tables, driven by the declared schema: no relation is named in
 * this file.
 *
 * WHAT a1 RESOLVES. The single-valued relations whose target the source row
 * names itself — `belongsTo` (a foreign key onto the target's key) and
 * outgoing `edge` (the first edge of the declared type in the row's own edge
 * list) — as the reference plus the target's presence. Both are keyed table
 * reads through the tables this accessor is given; in the live pool those are
 * the tracked tables, so a cell that resolves a relation is recorded under
 * the source row AND the target's slot, and a target that arrives, leaves or
 * changes dirties it. No bucket is maintained for them.
 *
 * WHAT ANSWERS "NONE" UNTIL Ha2 (POD-4579). Everything that needs an inverse
 * collection or a root set: `hasMany`, incoming `edge`, and `prefix`
 * (`one` → null, `many` → nothing, `size` → 0). The rules read them through
 * this accessor already, so Ha2 changes the answers, not the readers.
 *
 * Membership filters (`where`) are applied to the source row, as declared.
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import { type EntityName, type RelationSpec, SCHEMA } from '../../../shared/src/schema'
import type { ReadableTable, TableSet } from './tables'

const NONE: readonly string[] = Object.freeze([])

function specOf(from: EntityName, relation: string): RelationSpec {
  const spec = SCHEMA[from].relations[relation]
  if (spec === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
  return spec
}

function singleValued(spec: RelationSpec): boolean {
  return (
    spec.kind === 'belongsTo' ||
    spec.kind === 'prefix' ||
    (spec.kind === 'edge' && spec.direction === 'out')
  )
}

/**
 * The target key a single-valued relation names on `source` (`belongsTo`: the
 * foreign key; outgoing `edge`: the first edge of the declared type), after
 * the declared membership filter, WITHOUT checking the target is present.
 * Costs the source row only; `one` adds the presence check.
 */
export function relationRef(from: EntityName, relation: string, source: object): string | null {
  const spec = specOf(from, relation)
  const row = source as Readonly<Record<string, unknown>>
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
  constructor(private readonly tables: TableSet<ReadableTable>) {}

  one(from: EntityName, id: string, relation: string): string | null {
    const spec = specOf(from, relation)
    if (!singleValued(spec))
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with many()`)
    if (spec.kind === 'prefix') return null // Ha2
    const row = this.tables[from].get(id) as object | undefined
    if (row === undefined) return null
    const target = relationRef(from, relation, row)
    return target !== null && this.tables[spec.to].has(target) ? target : null
  }

  many(from: EntityName, _id: string, relation: string): Iterable<string> {
    if (singleValued(specOf(from, relation))) {
      throw new Error(`[pool] ${from}.${relation} is single-valued; read it with one()`)
    }
    return NONE // hasMany / incoming edge: Ha2
  }

  size(from: EntityName, id: string, relation: string): number {
    this.many(from, id, relation) // validates the kind
    return 0 // Ha2
  }
}
