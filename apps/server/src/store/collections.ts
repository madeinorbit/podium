/**
 * THE COLLECTION FETCH'S READS (POD-7085, docs/agents/server-data.md rules 1 and 6).
 *
 * The fetch (`sync/collection-fetch.ts`) asks by intent: "the records of this
 * declared rule, with these arguments", "below this position", "for these
 * holders", "the ancestors of these issues". Each is one statement, prepared
 * once per SHAPE (`sync/collection-shapes.ts`): the SQL text of a shape is a
 * function of the record declarations and the schema alone, and every value
 * an instance carries is bound. The query-plan audit plans every shape the
 * declarations can produce (`auditedCollectionShapes`).
 *
 * A statement selects the record's key columns, then a paged collection's
 * sort values; the caller maps keys to record ids.
 *
 * ONE WORKSPACE, EITHER ENGINE (POD-7118). The repository is built for one
 * workspace: every table a statement reads is held to it by the bound
 * `workspaceId` its handle fills (`WORKSPACE_PARAM` in `sync/collection-sql.ts`
 * marks the places), and each shape is built in the SQL of the engine the
 * store runs on.
 */
// workspace-scoped (POD-6959)

import { COLLECTIONS, paramsRead, RECORDS, type RuleArgs, type Scalar } from '@podium/model'
import {
  isBoundParam,
  PG_RULE_SQL,
  type RuleSqlDialect,
  SQLITE_RULE_SQL,
  type SqlValue,
} from '@podium/sync/collections'
import { type SQL, sql } from 'drizzle-orm'
import {
  ancestorsKey,
  inListSize,
  type ResolvedRule,
  resolveRule,
  ruleStatement,
  type ShapeMode,
  shapeKey,
  statementOfKey,
} from '../sync/collection-shapes'
import { ancestorsStatement, type CollectionStatement } from '../sync/collection-sql'
import { dialectOf } from './executor/dialect-prepared'
import {
  executeRaw,
  preparedFamily,
  type StoreDrizzle,
  WORKSPACE,
  type WorkspaceDb,
  type WorkspaceQueries,
} from './executor/sync-drizzle'

/** One selected row: its key columns, then its sort values. */
export type CollectionRow = readonly unknown[]

/**
 * The statement's text with each `?` a named placeholder `p0`, `p1`, … in
 * order, and each place {@link WORKSPACE_PARAM} marks the workspace the handle
 * binds.
 */
function placeheld(statement: CollectionStatement): SQL {
  const chunks: SQL[] = []
  for (const [at, part] of statement.sql.split('?').entries()) {
    if (at > 0) {
      chunks.push(
        isBoundParam(statement.params[at - 1])
          ? sql`${WORKSPACE}`
          : sql`${sql.placeholder(`p${at - 1}`)}`,
      )
    }
    // CONSTANT-IDENTIFIER STATEMENT POD-7085
    chunks.push(sql.raw(part))
  }
  return sql.join(chunks)
}

/** The rule compiler's spelling of the engine `db` is built on. */
const ruleDialectOf = (db: StoreDrizzle): RuleSqlDialect =>
  dialectOf(db) === 'pg' ? PG_RULE_SQL : SQLITE_RULE_SQL

/** One prepared statement per shape key (`sync/collection-shapes.ts`), in its engine's SQL. */
const collectionRows = preparedFamily((db, _t, key: string) =>
  db.all<Record<string, unknown>>(placeheld(statementOfKey(key, ruleDialectOf(db)))),
)

/** The caller's values by placeholder; the workspace is the handle's to fill. */
const valuesOf = (params: readonly SqlValue[]): Record<string, unknown> =>
  Object.fromEntries(
    params.flatMap((value, at) => (isBoundParam(value) ? [] : [[`p${at}`, value]])),
  )

export class CollectionsRepository {
  private readonly db: WorkspaceDb
  private readonly dialect: RuleSqlDialect
  /** Each key's text, checked once against the statement it was asked for. */
  private readonly checked = new Map<string, string>()

  constructor(queries: WorkspaceQueries) {
    this.db = queries.db
    this.dialect = ruleDialectOf(queries.db.drizzle)
  }

  private async run(key: string, statement: CollectionStatement): Promise<CollectionRow[]> {
    let text = this.checked.get(key)
    if (text === undefined) {
      text = statementOfKey(key, this.dialect).sql
      this.checked.set(key, text)
    }
    // The shape fixes the text: a statement asked for under a key whose text
    // differs would run the wrong SQL with these values.
    if (text !== statement.sql)
      throw new Error(`collection statement drifted from its shape ${key}`)
    const rows = await executeRaw(collectionRows(this.db, key), valuesOf(statement.params))
    const width = statement.select.length
    return rows.map((row) => Array.from({ length: width }, (_, at) => row[`c${at}`]))
  }

  /** Every record the rule selects: key columns only. */
  async select(rule: ResolvedRule, args: RuleArgs, now: number): Promise<CollectionRow[]> {
    return await this.run(
      shapeKey(rule, 'ids', args),
      ruleStatement(rule, 'ids', args, now, [], 0, this.dialect),
    )
  }

  /** A paged rule whole, in its sort order: key columns, then sort values. */
  async sorted(rule: ResolvedRule, args: RuleArgs, now: number): Promise<CollectionRow[]> {
    return await this.run(
      shapeKey(rule, 'sorted', args),
      ruleStatement(rule, 'sorted', args, now, [], 0, this.dialect),
    )
  }

  /** At most `limit` records of a paged rule strictly below `after`, in its sort order. */
  async after(
    rule: ResolvedRule,
    args: RuleArgs,
    now: number,
    after: readonly Scalar[],
    limit: number,
  ): Promise<CollectionRow[]> {
    return await this.run(
      shapeKey(rule, 'after', args),
      ruleStatement(rule, 'after', args, now, after, limit, this.dialect),
    )
  }

  /**
   * The records of a keyed collection for many holders at once: `args`
   * carries the collection's one argument as a list, padded to its shape.
   */
  async keyed(rule: ResolvedRule, args: RuleArgs, now: number): Promise<CollectionRow[]> {
    return await this.run(
      shapeKey(rule, 'keyed', args),
      ruleStatement(rule, 'keyed', args, now, [], 0, this.dialect),
    )
  }

  /** Every ancestor of these issues, by one walk up the parent column. */
  async ancestors(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const size = inListSize(ids.length)
    const padded = [...ids]
    while (padded.length < size) padded.push(ids[ids.length - 1]!)
    const rows = await this.run(ancestorsKey(size), ancestorsStatement(padded))
    return rows.map((row) => String(row[0]))
  }
}

/**
 * Every shape the declarations can ask, for the query-plan audit: each
 * collection with a rule and each comes-with's keyed form, with lists at the
 * audited sizes, and the ancestor walk.
 */
export function auditedCollectionShapes(sizes: readonly number[] = [1, 4]): string[] {
  const keys = new Set<string>()
  const argsOf = (rule: ResolvedRule): Record<string, Scalar | readonly Scalar[]> =>
    Object.fromEntries(
      (rule.where === undefined ? [] : paramsRead(rule.where)).map((name) => [
        name,
        name === 'recentDays' ? 7 : 'x',
      ]),
    )
  const add = (rule: ResolvedRule, mode: ShapeMode, args: RuleArgs) => {
    keys.add(shapeKey(rule, mode, args))
  }
  for (const collection of COLLECTIONS.values()) {
    if (collection.where === undefined && collection.page === undefined) continue
    const rule = resolveRule(collection.id)
    const args = argsOf(rule)
    // A paged collection is read in its order (`sorted`, `after`); it is read
    // by ids only at stub level, and that only when it has a rule.
    if (collection.where !== undefined) add(rule, 'ids', args)
    if (collection.page !== undefined) {
      add(rule, 'sorted', args)
      add(rule, 'after', args)
    }
  }
  const holders: { via: string; entries: readonly { collection: string }[] }[] = [
    ...[...COLLECTIONS.values()].map((c) => ({ via: c.id, entries: c.comesWith ?? [] })),
    ...RECORDS.map((record) => ({ via: record.kind, entries: record.comesWith })),
  ]
  for (const { via, entries } of holders) {
    for (const entry of entries) {
      const rule = resolveRule(entry.collection, via)
      const param = rule.params[0]!
      for (const size of sizes) {
        const args: RuleArgs = {
          ...argsOf(rule),
          [param]: Array.from({ length: size }, () => 'x'),
        }
        add(rule, 'keyed', args)
      }
    }
  }
  for (const size of sizes) keys.add(ancestorsKey(size))
  return [...keys].sort()
}
