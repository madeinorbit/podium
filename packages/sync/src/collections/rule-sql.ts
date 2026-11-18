/**
 * THE SQL EVALUATOR OF COLLECTION RULES (POD-7084, design POD-7059).
 *
 * A collection rule (`@podium/model`'s `records/rule.ts`) is data, so the
 * server answers it in SQL and the client in JavaScript (`matchesWhere`).
 * This compiles one rule into a WHERE fragment, with positional parameters,
 * over the columns a caller maps each field to, in the SQL of the store's
 * engine: SQLite or Postgres ({@link RuleSqlDialect}; one rule, one shape, two
 * spellings of its JSON reads, booleans and timestamp sentinel). It
 * answers exactly what `matchesWhere` answers: the shared corpus
 * (`RULE_CORPUS`) holds both to the same records (`rule-sql.test.ts`).
 *
 * The SQL is as plain as the rest of the store, and NULL-safe where
 * JavaScript compares `undefined`: a negated test
 * holds for a NULL value, as `!==` holds for `undefined`. `descendantsOf` is
 * one recursive query down the table's parent column from the root (the root
 * included), which ends on a cycle because UNION drops rows it has.
 *
 * Mapping fields to columns is the caller's: the server maps each saved field
 * a rule reads to the column, or the expression over its row, that holds it.
 * Nothing here runs a query.
 */

import {
  type Clause,
  clausesOf,
  type DescendantsOfTest,
  type EqTest,
  type FieldTest,
  type InTest,
  type NegatableTest,
  type NewerThanTest,
  type NotTest,
  newerThanCutoff,
  type RuleArgs,
  resolveDays,
  resolveList,
  resolveValue,
  type Scalar,
  testKind,
  type Where,
} from '@podium/model'

/**
 * How a field's value is held: `text` and `timestamp` decide what "is empty"
 * means (a timestamp's empty is the engine's "before every row" sentinel),
 * `boolean` how a value binds.
 */
export type SqlValueType = 'text' | 'timestamp' | 'number' | 'boolean' | 'json'

/** One field as SQL reads it: an expression over the row alias, and its type. */
export interface FieldSql {
  readonly sql: string
  readonly type: SqlValueType
}

/**
 * HOW THE ENGINE SPELLS WHAT A RULE NEEDS beyond plain SQL (POD-7118): JSON
 * reads, a boolean's binding, a text seed and the timestamp sentinel. SQLite
 * holds JSON as text and booleans as 0/1; Postgres holds `json`, `boolean` and
 * `timestamptz`, whose "before every row" is `-infinity` where SQLite's is `''`.
 */
export interface RuleSqlDialect {
  readonly name: 'sqlite' | 'pg'
  /** A JSON path into a JSON expression, as text. */
  jsonTextPath(expr: string, path: readonly string[]): string
  /** The JSON expression when it holds an object, else NULL. */
  jsonObject(expr: string): string
  /** An object member of a JSON expression, or NULL when it is not one. */
  jsonObjectMember(expr: string, key: string): string
  /** A boolean as the engine binds it. */
  bool(value: boolean): SqlValue
  /** A positional parameter read as text, the seed of a walk over text ids. */
  textParam(mark: string): string
  /** The timestamp sentinel that sorts before every row, as SQL. */
  readonly timestampFloor: string
}

const plainKey = (part: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
    throw new RuleSqlError(`not a plain JSON key: ${part}`)
  return part
}

export const SQLITE_RULE_SQL: RuleSqlDialect = Object.freeze({
  name: 'sqlite' as const,
  jsonTextPath: (expr: string, path: readonly string[]) =>
    `json_extract(${expr}, '$.${path.map(plainKey).join('.')}')`,
  // Nested CASE: the validity is tested before the member is read.
  jsonObject: (expr: string) =>
    `CASE WHEN ${jsonValidSql(expr)} THEN CASE WHEN json_type(${expr}) = 'object' THEN ${expr} END END`,
  jsonObjectMember: (expr: string, key: string) =>
    `CASE WHEN ${jsonValidSql(expr)} THEN CASE WHEN json_type(${expr}, '$.${plainKey(key)}') = 'object' THEN json_extract(${expr}, '$.${key}') END END`,
  // SQLite stores a boolean as 0 or 1.
  bool: (value: boolean) => (value ? 1 : 0),
  textParam: (mark: string) => `CAST(${mark} AS TEXT)`,
  timestampFloor: "''",
})

/**
 * Postgres: the JSON columns are `json`, always valid, so an object is one
 * `json_typeof`; a path read is `#>>`, text in byte order (`COLLATE "C"`, as
 * the store's text columns compare).
 */
export const PG_RULE_SQL: RuleSqlDialect = Object.freeze({
  name: 'pg' as const,
  jsonTextPath: (expr: string, path: readonly string[]) =>
    `((${expr}) #>> '{${path.map(plainKey).join(',')}}') COLLATE "C"`,
  jsonObject: (expr: string) => `CASE WHEN json_typeof(${expr}) = 'object' THEN ${expr} END`,
  jsonObjectMember: (expr: string, key: string) =>
    `CASE WHEN json_typeof((${expr}) -> '${plainKey(key)}') = 'object' THEN (${expr}) -> '${key}' END`,
  bool: (value: boolean) => value,
  textParam: (mark: string) => `CAST(${mark} AS TEXT) COLLATE "C"`,
  timestampFloor: "'-infinity'::timestamptz",
})

/** The table a rule reads, and how each field read maps onto it. */
export interface RuleSqlTarget {
  /** The engine the SQL is for; SQLite when omitted. */
  readonly dialect?: RuleSqlDialect
  /**
   * The term that holds a row of {@link table}, aliased `alias`, to the reader's
   * scope (the store's workspace, POD-7118): every table the rule's SQL reads
   * beyond the row, such as `descendantsOf`'s walk, carries it.
   */
  scope?(alias: string): RuleSql
  /** The table, for `descendantsOf`'s walk. */
  readonly table: string
  /** The table's id and parent columns, for `descendantsOf`'s walk. */
  readonly idColumn?: string
  readonly parentColumn?: string
  /** The record's own id as an expression over the row (`r.id`), for `descendantsOf`. */
  readonly rowId?: string
  /** The field (or dotted path) → its SQL; `undefined` refuses the rule. */
  field(path: string): FieldSql | undefined
}

/**
 * A parameter the executing handle fills, not the caller: `{ bound: 'workspaceId' }`
 * is the store's workspace (POD-7118). A rule never makes one; a target's
 * {@link RuleSqlTarget.scope} does.
 */
export interface BoundParam {
  readonly bound: string
}

export type SqlValue = string | number | boolean | null | BoundParam

export const isBoundParam = (value: unknown): value is BoundParam =>
  value !== null && typeof value === 'object' && 'bound' in value

export interface RuleSql {
  /** A WHERE fragment, parenthesised. */
  readonly sql: string
  readonly params: readonly SqlValue[]
}

export class RuleSqlError extends Error {}

/** A JSON path into a JSON text column, as text (SQLite). */
export function jsonTextPath(column: string, path: readonly string[]): string {
  return SQLITE_RULE_SQL.jsonTextPath(column, path)
}

/** Whether a text expression holds valid JSON (NULL reads as not valid). */
export function jsonValidSql(expr: string): string {
  return `coalesce(json_valid(${expr}), 0) = 1`
}

/**
 * The JSON text of an object member of a JSON text expression, or NULL when
 * the text is not valid JSON or the member is not an object: what a reader
 * that parses the text and takes `.key` sees.
 */
export function jsonObjectMemberSql(expr: string, key: string): string {
  return SQLITE_RULE_SQL.jsonObjectMember(expr, key)
}

/** A JSON text expression when it holds a JSON object, else NULL (SQLite). */
export function jsonObjectSql(expr: string): string {
  return SQLITE_RULE_SQL.jsonObject(expr)
}

class Params {
  readonly values: SqlValue[] = []
  constructor(readonly dialect: RuleSqlDialect) {}
  add(value: SqlValue, type: SqlValueType): string {
    if (typeof value === 'boolean' && type !== 'boolean') {
      throw new RuleSqlError(`a boolean compared with a ${type} field`)
    }
    this.values.push(typeof value === 'boolean' ? this.dialect.bool(value) : value)
    return '?'
  }
  /** A fragment's own parameters, in its text's order. */
  fragment(part: RuleSql): string {
    this.values.push(...part.params)
    return part.sql
  }
}

/** What "is empty" tests, by the field's type. */
function emptyValue(field: FieldSql, params: Params): string | undefined {
  if (field.type === 'text') return "''"
  if (field.type === 'timestamp') return params.dialect.timestampFloor
  return undefined
}

function eqSql(field: FieldSql, value: Scalar, params: Params): string {
  if (value === null) return `${field.sql} IS NULL`
  return `${field.sql} = ${params.add(value, field.type)}`
}

function inSql(field: FieldSql, list: readonly Scalar[], params: Params): string {
  const values = list.filter((item) => item !== null)
  const hasNull = values.length !== list.length
  const parts: string[] = []
  if (values.length > 0)
    parts.push(`${field.sql} IN (${values.map((v) => params.add(v, field.type)).join(', ')})`)
  if (hasNull) parts.push(`${field.sql} IS NULL`)
  return parts.length === 0 ? '1 = 0' : `(${parts.join(' OR ')})`
}

function emptySql(field: FieldSql, params: Params): string {
  const empty = emptyValue(field, params)
  return empty === undefined
    ? `${field.sql} IS NULL`
    : `(${field.sql} IS NULL OR ${field.sql} = ${empty})`
}

function negatableSql(
  test: NegatableTest,
  field: FieldSql,
  args: RuleArgs,
  params: Params,
): string {
  if (test === null || typeof test !== 'object') return eqSql(field, test, params)
  if ('eq' in test) return eqSql(field, resolveValue((test as EqTest).eq, args), params)
  if ('in' in test) return inSql(field, resolveList((test as InTest).in, args), params)
  return emptySql(field, params)
}

/** The negation, NULL-safe: it holds for NULL exactly when the test does not. */
function notSql(test: NegatableTest, field: FieldSql, args: RuleArgs, params: Params): string {
  if (test !== null && typeof test === 'object' && 'empty' in test) {
    const empty = emptyValue(field, params)
    return empty === undefined
      ? `${field.sql} IS NOT NULL`
      : `(${field.sql} IS NOT NULL AND ${field.sql} <> ${empty})`
  }
  const list =
    test === null || typeof test !== 'object'
      ? [test]
      : 'eq' in test
        ? [resolveValue((test as EqTest).eq, args)]
        : resolveList((test as InTest).in, args)
  const values = list.filter((item) => item !== null)
  const hasNull = values.length !== list.length
  if (values.length === 0) return hasNull ? `${field.sql} IS NOT NULL` : '1 = 1'
  const notIn =
    values.length === 1
      ? `${field.sql} <> ${params.add(values[0]!, field.type)}`
      : `${field.sql} NOT IN (${values.map((v) => params.add(v, field.type)).join(', ')})`
  return hasNull ? `(${field.sql} IS NOT NULL AND ${notIn})` : `(${field.sql} IS NULL OR ${notIn})`
}

function descendantsSql(root: Scalar, target: RuleSqlTarget, params: Params): string {
  if (root === null) return '1 = 0'
  if (
    target.idColumn === undefined ||
    target.parentColumn === undefined ||
    target.rowId === undefined
  ) {
    throw new RuleSqlError(`descendantsOf needs the id and parent columns of ${target.table}`)
  }
  // The root and every record under it, walked down the parent column; the
  // record matches when it is in that set (the root itself included). Each
  // step of the walk is held to the reader's scope.
  const rootParam = params.add(root, 'text')
  const head =
    `WITH RECURSIVE under(id) AS (SELECT ${params.dialect.textParam(rootParam)} ` +
    `UNION SELECT child.${target.idColumn} FROM ${target.table} AS child ` +
    `JOIN under ON child.${target.parentColumn} = under.id`
  const scope = target.scope === undefined ? '' : ` WHERE ${params.fragment(target.scope('child'))}`
  return `${target.rowId} IN (${head}${scope}) SELECT id FROM under)`
}

function testSql(
  path: string,
  test: FieldTest,
  target: RuleSqlTarget,
  args: RuleArgs,
  now: number,
  params: Params,
): string {
  const field = target.field(path)
  if (field === undefined) throw new RuleSqlError(`no column for ${path} in ${target.table}`)
  switch (testKind(test)) {
    case 'eq':
    case 'in':
    case 'empty':
      return negatableSql(test as NegatableTest, field, args, params)
    case 'not':
      return notSql((test as NotTest).not, field, args, params)
    case 'newerThan': {
      const days = resolveDays((test as NewerThanTest).newerThan.days, args)
      return `${field.sql} > ${params.add(newerThanCutoff(now, days), field.type === 'timestamp' ? 'timestamp' : 'text')}`
    }
    case 'descendantsOf':
      return descendantsSql(
        resolveValue((test as DescendantsOfTest).descendantsOf, args),
        target,
        params,
      )
  }
}

function clauseSql(
  clause: Clause,
  target: RuleSqlTarget,
  args: RuleArgs,
  now: number,
  params: Params,
): string {
  const tests = Object.entries(clause).map(([path, test]) =>
    testSql(path, test, target, args, now, params),
  )
  return tests.length === 0 ? '1 = 1' : tests.map((t) => `(${t})`).join(' AND ')
}

/**
 * The rule as a WHERE fragment over `target`. `now` (epoch ms) is the clock
 * `newerThan` compares against; `args` fill the rule's params.
 */
export function ruleSql(
  where: Where,
  target: RuleSqlTarget,
  args: RuleArgs = {},
  now = Date.now(),
): RuleSql {
  const params = new Params(target.dialect ?? SQLITE_RULE_SQL)
  const clauses = clausesOf(where).map((clause) => clauseSql(clause, target, args, now, params))
  const sql =
    clauses.length === 1 ? `(${clauses[0]})` : `(${clauses.map((c) => `(${c})`).join(' OR ')})`
  return { sql, params: params.values }
}
