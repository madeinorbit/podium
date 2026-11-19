/**
 * WHAT A COLLECTION STATEMENT'S SQL DEPENDS ON (POD-7085).
 *
 * The fetch (`collection-fetch.ts`) asks one statement per declared rule and
 * mode; the repository (`store/collections.ts`) prepares each SHAPE once
 * (docs/agents/server-data.md rule 1). A shape names everything the SQL text
 * depends on and no value: the rule (a collection, or the collection as a
 * holder's "comes with" narrows it), the mode, and per argument whether it is
 * a text, a number, a boolean, NULL or a list of a padded length. The
 * repository rebuilds the SQL from the shape alone, so the query-plan audit
 * can plan every shape without running the fetch.
 */

import {
  andWhere,
  COLLECTIONS,
  type Collection,
  type ComesWith,
  instanceParams,
  type RuleArgs,
  recordOf,
  type Scalar,
  type Where,
} from '@podium/model'
import { inListSize } from '@podium/sync/adapters/sqlite/prepared'
import { type RuleSqlDialect, SQLITE_RULE_SQL } from '@podium/sync/collections'
import {
  ancestorsStatement,
  type CollectionKind,
  type CollectionStatement,
  collectionStatement,
  isCollectionKind,
  keyedWhere,
  keyPageStatement,
} from './collection-sql'

/** A request names a collection, an argument or a holder no declaration has. */
export class CollectionRequestError extends Error {}

/** One declared rule an instance reads: a collection, or a holder's comes-with of it. */
export interface ResolvedRule {
  readonly collection: Collection
  readonly kind: string
  /** The collection id, or `<holder> > <collection>` for a comes-with. */
  readonly id: string
  readonly via?: string
  readonly comesWith?: ComesWith
  readonly where: Where | undefined
  /** The instance's own arguments (the policy fills the rest). */
  readonly params: readonly string[]
}

/** The holders a collection may come with: a collection id or a record kind. */
function comesWithOf(via: string): readonly ComesWith[] {
  const holder = COLLECTIONS.get(via)
  if (holder !== undefined) return holder.comesWith ?? []
  const record = recordOf(via)
  if (record !== undefined) return record.comesWith
  throw new CollectionRequestError(`${via} is neither a collection nor a record type`)
}

/** The rule of an instance of `collectionId`, narrowed by `via`'s comes-with when given. */
export function resolveRule(collectionId: string, via?: string): ResolvedRule {
  const collection = COLLECTIONS.get(collectionId)
  if (collection === undefined)
    throw new CollectionRequestError(`no collection ${collectionId} is declared`)
  const params = instanceParams(collection)
  if (via === undefined)
    return { collection, kind: collection.of, id: collection.id, where: collection.where, params }
  const entries = comesWithOf(via).filter((entry) => entry.collection === collectionId)
  if (entries.length !== 1) {
    throw new CollectionRequestError(
      entries.length === 0
        ? `${via} does not come with ${collectionId}`
        : `${via} comes with ${collectionId} twice`,
    )
  }
  const entry = entries[0]!
  return {
    collection,
    kind: collection.of,
    id: `${via} > ${collectionId}`,
    via,
    comesWith: entry,
    where: entry.where === undefined ? collection.where : andWhere(collection.where, entry.where),
    params,
  }
}

/** How a statement reads its rule. */
export type ShapeMode =
  /** Every selected record. */
  | 'ids'
  /** A paged collection, whole, in its sort order (the first page and its total). */
  | 'sorted'
  /** A paged collection below a position, a bounded number of rows. */
  | 'after'
  /** A keyed collection for many holders at once: its one argument is a list. */
  | 'keyed'

/** The most keys one keyed statement takes; more holders take more statements. */
export const KEYED_CHUNK = 2048

const typeMark = (value: Scalar): string =>
  value === null ? 'z' : typeof value === 'number' ? 'd' : typeof value === 'boolean' ? 'b' : 's'

/** The shape of the arguments: a type mark per scalar, a padded length per list. */
export function argShape(args: RuleArgs): string {
  return Object.keys(args)
    .sort()
    .map((name) => {
      const value = args[name]!
      return Array.isArray(value)
        ? `${name}:l${inListSize(value.length)}`
        : `${name}:${typeMark(value as Scalar)}`
    })
    .join(',')
}

/** A list argument padded to its shape's length, with its last value. */
export function paddedArgs(args: RuleArgs): RuleArgs {
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      if (!Array.isArray(value) || value.length === 0) return [name, value]
      const size = inListSize(value.length)
      const out = [...value]
      while (out.length < size) out.push(value[value.length - 1]!)
      return [name, out]
    }),
  )
}

/** Values of each shape's types, for building a statement from its shape alone. */
function argsOfShape(shape: string): RuleArgs {
  if (shape === '') return {}
  return Object.fromEntries(
    shape.split(',').map((part) => {
      const [name, mark] = part.split(':') as [string, string]
      if (mark.startsWith('l'))
        return [name, Array.from({ length: Number(mark.slice(1)) }, () => 'x')]
      return [name, mark === 'z' ? null : mark === 'd' ? 1 : mark === 'b' ? true : 'x']
    }),
  )
}

/**
 * The prepared statement's key: `<rule id>#<mode>#<arguments>`, `ancestors#<size>`,
 * or `keys#<record type>` for a page of a type's record keys.
 */
export const shapeKey = (rule: ResolvedRule, mode: ShapeMode, args: RuleArgs): string =>
  `${rule.via ?? ''}|${rule.collection.id}#${mode}#${argShape(args)}`

export const ancestorsKey = (size: number): string => `ancestors#${inListSize(size)}`

export const keyPageKey = (kind: CollectionKind): string => `keys#${kind}`

/** Rebuild a rule from the head of its key. */
function ruleOfKey(head: string): ResolvedRule {
  const [via, collectionId] = head.split('|') as [string, string]
  return resolveRule(collectionId, via === '' ? undefined : via)
}

/** One statement: the rule over its record type's table. */
export function ruleStatement(
  rule: ResolvedRule,
  mode: ShapeMode,
  args: RuleArgs,
  now: number,
  after: readonly Scalar[] = [],
  limit = 0,
  dialect: RuleSqlDialect = SQLITE_RULE_SQL,
): CollectionStatement {
  if (!isCollectionKind(rule.kind))
    throw new CollectionRequestError(`${rule.kind} has no table a rule can read`)
  const page = rule.collection.page
  if ((mode === 'sorted' || mode === 'after') && page === undefined)
    throw new CollectionRequestError(`${rule.collection.id} is not paged`)
  return collectionStatement(
    rule.kind as CollectionKind,
    mode === 'keyed' ? keyedRule(rule).where : rule.where,
    args,
    now,
    mode === 'ids' || mode === 'keyed'
      ? { kind: 'ids' }
      : { kind: 'page', sort: page!.sort, after: mode === 'after', limit: mode === 'after' },
    after,
    limit,
    dialect,
  )
}

/** The statement a key names, built from the key alone, for one engine. */
export function statementOfKey(
  key: string,
  dialect: RuleSqlDialect = SQLITE_RULE_SQL,
): CollectionStatement {
  const [head, mode, shape = ''] = key.split('#') as [string, string, string?]
  if (head === 'ancestors')
    return ancestorsStatement(Array.from({ length: Number(mode) }, () => 'x'))
  if (head === 'keys') return keyPageStatement(mode as CollectionKind, '', 1, dialect)
  const rule = ruleOfKey(head)
  const sort = rule.collection.page?.sort ?? []
  return ruleStatement(
    rule,
    mode as ShapeMode,
    argsOfShape(shape),
    0,
    sort.map(() => 'x'),
    1,
    dialect,
  )
}

/** The keyed form of a comes-with's collection: its one argument a list. */
export function keyedRule(rule: ResolvedRule): ResolvedRule {
  const param = rule.params[0]
  if (rule.params.length !== 1 || param === undefined || rule.where === undefined)
    throw new CollectionRequestError(`${rule.id} is not a keyed collection`)
  return { ...rule, where: keyedWhere(rule.where, param) }
}

export { inListSize }
