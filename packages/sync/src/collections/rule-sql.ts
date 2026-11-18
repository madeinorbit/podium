/**
 * THE SQL EVALUATOR OF COLLECTION RULES (POD-7084, design POD-7059).
 *
 * A collection rule (`@podium/model`'s `records/rule.ts`) is data, so the
 * server answers it in SQL and the client in JavaScript (`matchesWhere`).
 * This compiles one rule into a WHERE fragment for the store's SQLite, with
 * positional parameters, over the columns a caller maps each field to. It
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

/** How a field's value is held: `text` decides what "is empty" means, `boolean` how a value binds. */
export type SqlValueType = 'text' | 'number' | 'boolean' | 'json'

/** One field as SQL reads it: an expression over the row alias, and its type. */
export interface FieldSql {
  readonly sql: string
  readonly type: SqlValueType
}

/** The table a rule reads, and how each field read maps onto it. */
export interface RuleSqlTarget {
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

export type SqlValue = string | number | boolean | null

export interface RuleSql {
  /** A WHERE fragment, parenthesised. */
  readonly sql: string
  readonly params: readonly SqlValue[]
}

export class RuleSqlError extends Error {}

/** A JSON path into a JSON text column, as text. */
export function jsonTextPath(column: string, path: readonly string[]): string {
  for (const part of path) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
      throw new RuleSqlError(`not a plain JSON key: ${part}`)
  }
  return `json_extract(${column}, '$.${path.join('.')}')`
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new RuleSqlError(`not a plain JSON key: ${key}`)
  // Nested CASE: the validity is tested before the member is read.
  return `CASE WHEN ${jsonValidSql(expr)} THEN CASE WHEN json_type(${expr}, '$.${key}') = 'object' THEN json_extract(${expr}, '$.${key}') END END`
}

/** A JSON text expression when it holds a JSON object, else NULL. */
export function jsonObjectSql(expr: string): string {
  return `CASE WHEN ${jsonValidSql(expr)} THEN CASE WHEN json_type(${expr}) = 'object' THEN ${expr} END END`
}

class Params {
  readonly values: SqlValue[] = []
  add(value: SqlValue, type: SqlValueType): string {
    if (typeof value === 'boolean' && type !== 'boolean') {
      throw new RuleSqlError(`a boolean compared with a ${type} field`)
    }
    // SQLite stores a boolean as 0 or 1.
    this.values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    return '?'
  }
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

function emptySql(field: FieldSql): string {
  return field.type === 'text'
    ? `(${field.sql} IS NULL OR ${field.sql} = '')`
    : `${field.sql} IS NULL`
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
  return emptySql(field)
}

/** The negation, NULL-safe: it holds for NULL exactly when the test does not. */
function notSql(test: NegatableTest, field: FieldSql, args: RuleArgs, params: Params): string {
  if (test !== null && typeof test === 'object' && 'empty' in test) {
    return field.type === 'text'
      ? `(${field.sql} IS NOT NULL AND ${field.sql} <> '')`
      : `${field.sql} IS NOT NULL`
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
  // record matches when it is in that set (the root itself included).
  const rootParam = params.add(root, 'text')
  const walk =
    `WITH RECURSIVE under(id) AS (SELECT CAST(${rootParam} AS TEXT) ` +
    `UNION SELECT child.${target.idColumn} FROM ${target.table} AS child ` +
    `JOIN under ON child.${target.parentColumn} = under.id) SELECT id FROM under`
  return `${target.rowId} IN (${walk})`
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
      return `${field.sql} > ${params.add(newerThanCutoff(now, days), 'text')}`
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
  const params = new Params()
  const clauses = clausesOf(where).map((clause) => clauseSql(clause, target, args, now, params))
  const sql =
    clauses.length === 1 ? `(${clauses[0]})` : `(${clauses.map((c) => `(${c})`).join(' OR ')})`
  return { sql, params: params.values }
}
