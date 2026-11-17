/**
 * THE SQL AND JAVASCRIPT EVALUATORS AGREE (POD-7084).
 *
 * Every declared collection rule is answered over the shared corpus
 * (`@podium/model`'s `CORPUS_RECORDS`/`CORPUS_CASES`) two ways: by
 * `matchesWhere`, and by `ruleSql` on SQLite (bun:sqlite). Both must equal the
 * corpus answer. Each corpus record type is one table, a column per field the
 * rules read, values stored as the server stores them (booleans as 0/1,
 * objects as JSON text).
 */

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
import { type FieldSql, jsonTextPath, ruleSql, type SqlValueType } from './rule-sql'

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

const sqlType = (type: SqlValueType) =>
  type === 'number' ? 'DOUBLE PRECISION' : type === 'boolean' ? 'INTEGER' : 'TEXT'

function stored(type: SqlValueType, value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (type === 'json') return JSON.stringify(value)
  if (type === 'boolean') return value ? 1 : 0
  return value as string | number
}

/** The table DDL and the rows to insert. */
function fixture() {
  const tables: { ddl: string; insert: string; rows: (string | number | null)[][] }[] = []
  for (const [kind, columns] of COLUMNS) {
    const declaration = recordOf(kind)!
    const names = [...columns.keys()]
    const ddl = `CREATE TABLE ${tableOf(kind)} (row_key TEXT PRIMARY KEY${names
      .map((field) => `, ${columnOf(field)} ${sqlType(columns.get(field)!)}`)
      .join('')})`
    const insert = `INSERT INTO ${tableOf(kind)} (row_key${names.map((f) => `, ${columnOf(f)}`).join('')}) VALUES (?${names.map(() => ', ?').join('')})`
    const rows = (CORPUS_RECORDS[kind] ?? []).map((row) => [
      declaration.rowKey(row as never),
      ...names.map((field) => stored(columns.get(field)!, row[field])),
    ])
    tables.push({ ddl, insert, rows })
  }
  return tables
}

function target(declaration: RecordDeclaration) {
  const columns = COLUMNS.get(declaration.kind)!
  return {
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
        sql: jsonTextPath(column, path.slice(field.length + 1).split('.')),
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

const query = (rule: DeclaredRule, args: RuleArgs) => {
  const compiled = ruleSql(rule.where, target(recordOf(rule.of)!), args, CORPUS_NOW)
  return {
    sql: `SELECT r.row_key AS row_key FROM ${tableOf(rule.of)} AS r WHERE ${compiled.sql} ORDER BY r.row_key`,
    params: compiled.params,
  }
}

describe('collection rules on the shared corpus', () => {
  const sqlite = openDatabase(':memory:')

  beforeAll(() => {
    for (const table of fixture()) {
      sqlite.exec(table.ddl)
      const insert = sqlite.prepare(table.insert)
      for (const row of table.rows) insert.run(...row)
    }
  })

  afterAll(() => {
    sqlite.close()
  })

  it('covers every declared rule', () => {
    const covered = new Set(CORPUS_CASES.map((c) => c.rule))
    expect([...rules.keys()].filter((id) => !covered.has(id))).toEqual([])
  })

  for (const c of CORPUS_CASES) {
    it(`${c.rule} ${JSON.stringify(c.args ?? {})}`, () => {
      const rule = rules.get(c.rule)!
      const args = c.args ?? {}
      const expected = [...c.expect].sort()
      expect(jsAnswer(rule, args), 'JavaScript').toEqual(expected)

      const onSqlite = query(rule, args)
      const sqliteRows = sqlite.prepare(onSqlite.sql).all(...(onSqlite.params as never[])) as {
        row_key: string
      }[]
      expect(
        sqliteRows.map((row) => row.row_key),
        `SQLite: ${onSqlite.sql}`,
      ).toEqual(expected)
    })
  }

  it('tells a wrong rule from the right one', () => {
    // Children are not the tree: the root and the grandchild are missing.
    const rule = rules.get('issueProjection.tree')!
    const wrong: DeclaredRule = {
      ...rule,
      where: { parentId: { eq: { param: 'root' } } },
    }
    const right = ['i1', 'i2', 'i3', 'i8']
    const onSqlite = query(wrong, { root: 'i1' })
    const got = (
      sqlite.prepare(onSqlite.sql).all(...(onSqlite.params as never[])) as { row_key: string }[]
    ).map((row) => row.row_key)
    expect(got).toEqual(['i2', 'i8'])
    expect(got).not.toEqual(right)
  })
})
