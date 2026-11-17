/**
 * THE SQL AND JAVASCRIPT EVALUATORS AGREE (POD-7084), on SQLite and Postgres.
 *
 * Every declared collection rule is answered over the shared corpus
 * (`@podium/model`'s `CORPUS_RECORDS`/`CORPUS_CASES`) three ways: by
 * `matchesWhere`, and by `ruleSql` on SQLite (bun:sqlite) and on Postgres
 * (PGlite). All three must equal the corpus answer. Each corpus record type is
 * one table, a column per field the rules read, values stored as the server
 * stores them (booleans as 0/1 on SQLite, objects as JSON text).
 */

import { PGlite } from '@electric-sql/pglite'
import {
  CORPUS_CASES,
  CORPUS_NOW,
  CORPUS_RECORDS,
  type DeclaredRule,
  declaredRules,
  fieldForPath,
  matchesWhere,
  pathsRead,
  type RecordDeclaration,
  type RuleArgs,
  recordOf,
} from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type FieldSql,
  jsonTextPath,
  ruleSql,
  type SqlDialect,
  type SqlValueType,
} from './rule-sql'

type Row = Readonly<Record<string, unknown>>

const rules = new Map(declaredRules().map((rule) => [rule.id, rule]))
const tableOf = (kind: string) => `rec_${kind}`
const columnOf = (field: string) => `c_${field.replaceAll('.', '_')}`

/** The fields each corpus kind's rules read, with the type its corpus values have. */
function columnsByKind(): Map<string, Map<string, SqlValueType>> {
  const out = new Map<string, Map<string, SqlValueType>>()
  for (const rule of rules.values()) {
    const declaration = recordOf(rule.of)!
    const columns = out.get(rule.of) ?? new Map<string, SqlValueType>()
    out.set(rule.of, columns)
    const fields = pathsRead(rule.where).map((path) => fieldForPath(declaration, path)!)
    if (declaration.parentLink !== undefined) fields.push(declaration.parentLink)
    for (const field of fields) {
      const values = (CORPUS_RECORDS[rule.of] ?? [])
        .map((row) => row[field])
        .filter((v) => v != null)
      const type: SqlValueType = values.some((v) => typeof v === 'boolean')
        ? 'boolean'
        : values.some((v) => typeof v === 'number')
          ? 'number'
          : values.some((v) => typeof v === 'object')
            ? 'json'
            : 'text'
      columns.set(field, type)
    }
  }
  return out
}

const COLUMNS = columnsByKind()

const sqlType = (dialect: SqlDialect, type: SqlValueType) =>
  type === 'number'
    ? 'DOUBLE PRECISION'
    : type === 'boolean'
      ? dialect === 'sqlite'
        ? 'INTEGER'
        : 'BOOLEAN'
      : 'TEXT'

function stored(
  dialect: SqlDialect,
  type: SqlValueType,
  value: unknown,
): string | number | boolean | null {
  if (value === undefined || value === null) return null
  if (type === 'json') return JSON.stringify(value)
  if (type === 'boolean' && dialect === 'sqlite') return value ? 1 : 0
  return value as string | number | boolean
}

/** The table DDL and the rows to insert, for one engine. */
function fixture(dialect: SqlDialect) {
  const tables: { ddl: string; insert: string; rows: (string | number | boolean | null)[][] }[] = []
  for (const [kind, columns] of COLUMNS) {
    const declaration = recordOf(kind)!
    const names = [...columns.keys()]
    const ddl = `CREATE TABLE ${tableOf(kind)} (row_key TEXT PRIMARY KEY${names
      .map((field) => `, ${columnOf(field)} ${sqlType(dialect, columns.get(field)!)}`)
      .join('')})`
    const marks = names.map((_, at) => (dialect === 'sqlite' ? '?' : `$${at + 2}`))
    const insert = `INSERT INTO ${tableOf(kind)} (row_key${names.map((f) => `, ${columnOf(f)}`).join('')}) VALUES (${
      dialect === 'sqlite' ? '?' : '$1'
    }${marks.map((m) => `, ${m}`).join('')})`
    const rows = (CORPUS_RECORDS[kind] ?? []).map((row) => [
      declaration.rowKey(row as never),
      ...names.map((field) => stored(dialect, columns.get(field)!, row[field])),
    ])
    tables.push({ ddl, insert, rows })
  }
  return tables
}

function target(dialect: SqlDialect, declaration: RecordDeclaration) {
  const columns = COLUMNS.get(declaration.kind)!
  return {
    dialect,
    table: tableOf(declaration.kind),
    idColumn: 'row_key',
    rowId: 'r.row_key',
    ...(declaration.parentLink === undefined
      ? {}
      : { parentColumn: columnOf(declaration.parentLink) }),
    field(path: string): FieldSql | undefined {
      const field = fieldForPath(declaration, path)
      if (field === undefined || !columns.has(field)) return undefined
      const column = `r.${columnOf(field)}`
      if (field === path) return { sql: column, type: columns.get(field)! }
      return {
        sql: jsonTextPath(dialect, column, path.slice(field.length + 1).split('.')),
        type: 'text',
      }
    },
  }
}

function jsAnswer(rule: DeclaredRule, args: RuleArgs): string[] {
  const declaration = recordOf(rule.of)!
  const rows: readonly Row[] = CORPUS_RECORDS[rule.of] ?? []
  const parents = new Map(
    rows.map((row) => [
      declaration.rowKey(row as never),
      row[declaration.parentLink ?? ''] as string,
    ]),
  )
  return rows
    .filter((row) =>
      matchesWhere(rule.where, row, { now: CORPUS_NOW, args, parentOf: (id) => parents.get(id) }),
    )
    .map((row) => declaration.rowKey(row as never))
    .sort()
}

const query = (rule: DeclaredRule, dialect: SqlDialect, args: RuleArgs) => {
  const compiled = ruleSql(rule.where, target(dialect, recordOf(rule.of)!), args, CORPUS_NOW)
  return {
    sql: `SELECT r.row_key AS row_key FROM ${tableOf(rule.of)} AS r WHERE ${compiled.sql} ORDER BY r.row_key`,
    params: compiled.params,
  }
}

describe('collection rules on the shared corpus', () => {
  const sqlite = openDatabase(':memory:')
  let postgres: PGlite

  beforeAll(async () => {
    for (const table of fixture('sqlite')) {
      sqlite.exec(table.ddl)
      const insert = sqlite.prepare(table.insert)
      for (const row of table.rows) insert.run(...row)
    }
    postgres = await PGlite.create()
    for (const table of fixture('postgres')) {
      await postgres.exec(table.ddl)
      for (const row of table.rows) await postgres.query(table.insert, row)
    }
  })

  afterAll(async () => {
    sqlite.close()
    await postgres?.close()
  })

  it('covers every declared rule', () => {
    const covered = new Set(CORPUS_CASES.map((c) => c.rule))
    expect([...rules.keys()].filter((id) => !covered.has(id))).toEqual([])
  })

  for (const c of CORPUS_CASES) {
    it(`${c.rule} ${JSON.stringify(c.args ?? {})}`, async () => {
      const rule = rules.get(c.rule)!
      const args = c.args ?? {}
      const expected = [...c.expect].sort()
      expect(jsAnswer(rule, args), 'JavaScript').toEqual(expected)

      const onSqlite = query(rule, 'sqlite', args)
      const sqliteRows = sqlite.prepare(onSqlite.sql).all(...(onSqlite.params as never[])) as {
        row_key: string
      }[]
      expect(
        sqliteRows.map((row) => row.row_key),
        `SQLite: ${onSqlite.sql}`,
      ).toEqual(expected)

      const onPostgres = query(rule, 'postgres', args)
      const pgRows = await postgres.query<{ row_key: string }>(onPostgres.sql, [
        ...onPostgres.params,
      ])
      expect(pgRows.rows.map((row) => row.row_key).sort(), `Postgres: ${onPostgres.sql}`).toEqual(
        expected,
      )
    })
  }

  it('tells a wrong rule from the right one on both engines', async () => {
    // Children are not the tree: the root and the grandchild are missing.
    const rule = rules.get('issueProjection.tree')!
    const wrong: DeclaredRule = {
      ...rule,
      where: { parentId: { eq: { param: 'root' } } },
    }
    const right = ['i1', 'i2', 'i3', 'i8']
    const onSqlite = query(wrong, 'sqlite', { root: 'i1' })
    const got = (
      sqlite.prepare(onSqlite.sql).all(...(onSqlite.params as never[])) as { row_key: string }[]
    ).map((row) => row.row_key)
    expect(got).toEqual(['i2', 'i8'])
    expect(got).not.toEqual(right)
    const onPostgres = query(wrong, 'postgres', { root: 'i1' })
    const pg = await postgres.query<{ row_key: string }>(onPostgres.sql, [...onPostgres.params])
    expect(pg.rows.map((row) => row.row_key).sort()).toEqual(['i2', 'i8'])
  })
})
