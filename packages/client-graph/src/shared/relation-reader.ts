import type { EntityName } from './schema'

/**
 * The shared relation accessor. The pools implement it from the declared
 * schema (`shared/src/schema.ts`); derivations read relation buckets only
 * through it, so the fence can count them. Ids, not instances: a derivation
 * that needs the row reads it from its table, which is counted there too
 * (distinct counting makes that free).
 */
export interface RelationReader {
  /** A single-valued relation (`belongsTo`, `prefix`, `edge` out): the target id, or null. */
  one(from: EntityName, id: string, relation: string): string | null
  /** A collection (`hasMany`, `edge` in): the target ids. */
  many(from: EntityName, id: string, relation: string): Iterable<string>
  /** The collection's size. Uncounted, like `Map.size`. */
  size(from: EntityName, id: string, relation: string): number
  /**
   * The members of a collection's declared subset (POD-4758,
   * `HasManySpec.subsets`; POD-4671 for the one there is, the issueless
   * sessions under a worktree root), unordered like `many()`. Maintained at
   * the delta, so a reader never reads member rows to filter — the same
   * pattern as POD-4678's seat list.
   */
  subset(from: EntityName, id: string, relation: string, subset: string): Iterable<string>
}
