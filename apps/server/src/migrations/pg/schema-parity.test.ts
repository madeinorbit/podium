/**
 * THE POSTGRES TWIN HAS THE SQLITE SCHEMA'S SHAPE [POD-6978, POD-6958 design 2.2, 2.3].
 *
 * The store binds the Postgres tables (`./schema.ts`, and the sync package's
 * `adapters/pg/schema.ts`) where a definition expects the SQLite ones, cast to the
 * SQLite types in one place (`store/executor/binding.ts`). This test is the structural
 * half of what makes that cast safe; `schema-parity.type-test.ts` is the row-type half.
 * For every table it compares, without a database:
 *
 *  - the table and its export name: every SQLite table has a twin and every twin a
 *    SQLite table, so a table added on one side alone fails here;
 *  - column names and order, nullability, primary keys, defaults (in their Postgres
 *    form: a 0/1 boolean default is `false`/`true`), unique constraints, indexes (columns,
 *    expressions, uniqueness, partial condition), foreign keys and their actions, and check
 *    constraints by name and text;
 *  - each column's Postgres type against its class (design 2.3): `timestamptz(3)` in
 *    string mode for the timestamp list, `json` for the JSON list (parsed only for a
 *    `mode: 'json'` column), `text COLLATE "C"` for every other text column, `bigint` for
 *    integers (an identity for a one-column integer key), `boolean`, `double precision`.
 *
 * A difference is allowed only where `schema-overrides.ts` lists it, and the twin must
 * then hold the override's form; an override with nothing left to override fails too.
 * The class lists (`schema-classes.ts`) must name every text column and nothing else.
 * Every name must fit Postgres's 63-byte identifier limit, which would otherwise
 * truncate it silently. And drizzle-kit must render the whole twin as DDL, which is what
 * the Postgres baseline migration (POD-6981) is generated from.
 *
 * The checker is a function of two table sets, so the last block plants drift (a renamed
 * column, a missing index, a column without `COLLATE "C"`) and proves each is found.
 */

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres'
import { type Column, getTableColumns, is, SQL, sql } from 'drizzle-orm'
import {
  check,
  getTableConfig as getPgTableConfig,
  index,
  type PgColumn,
  PgDialect,
  PgTable,
  pgTable,
  text as pgText,
} from 'drizzle-orm/pg-core'
import {
  getTableConfig,
  integer,
  SQLiteDialect,
  SQLiteTable,
  check as sqliteCheck,
  index as sqliteIndex,
  sqliteTable,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as pgSync from '../../../../../packages/sync/src/adapters/pg/schema'
import * as sqliteSync from '../../../../../packages/sync/src/adapters/sqlite/schema'
import * as sqliteServer from '../schema'
import * as pgServer from './schema'
import { classifiedTextColumns, type TextColumnClass, textColumnClass } from './schema-classes'
import {
  PG_CHECK_OVERRIDES,
  PG_DDL_NOTES,
  PG_DEFAULT_OVERRIDES,
  PG_FOREIGN_KEY_RENAMES,
  PG_INDEX_EXPRESSION_OVERRIDES,
  PG_INDEX_NULLS_FIRST,
  PG_INDEX_WHERE_OVERRIDES,
  PG_ONLY_INDEXES,
  PG_ONLY_TABLES,
  PG_TIMESTAMP_COLUMNS_KEPT_AS_TEXT,
  type PgOnlyIndex,
  type PgOverride,
} from './schema-overrides'

type Module = Readonly<Record<string, unknown>>

const sqliteDialect = new SQLiteDialect()
const pgDialect = new PgDialect()

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim()
const sqliteSql = (fragment: SQL): string => fold(sqliteDialect.sqlToQuery(fragment, 'indexes').sql)
const pgSql = (fragment: SQL): string => fold(pgDialect.sqlToQuery(fragment, 'indexes').sql)
const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

const isIdentity = (sqlName: string): boolean => sqlName.startsWith('identity_')

function sqliteTablesOf(module: Module): Map<string, SQLiteTable> {
  const tables = new Map<string, SQLiteTable>()
  for (const [key, value] of Object.entries(module)) {
    if (is(value, SQLiteTable) && !isIdentity(getTableConfig(value).name)) tables.set(key, value)
  }
  return tables
}

function pgTablesOf(module: Module, identityKeys: ReadonlySet<string>): Map<string, PgTable> {
  const tables = new Map<string, PgTable>()
  for (const [key, value] of Object.entries(module)) {
    if (is(value, PgTable) && !identityKeys.has(key)) tables.set(key, value)
  }
  return tables
}

/** The overrides, tracked so an unused entry can be reported. */
interface Overrides {
  readonly checks: Readonly<Record<string, PgOverride>>
  readonly indexWheres: Readonly<Record<string, PgOverride>>
  /** Index key expressions written another way on Postgres, keyed `table.index`. */
  readonly indexExpressions: Readonly<
    Record<string, { readonly sqlite: string; readonly sql: string }>
  >
  /** Index keys stored NULLS FIRST on Postgres, keyed `table.index`. */
  readonly nullsFirst: Readonly<Record<string, { readonly columns: readonly string[] }>>
  readonly defaults: Readonly<Record<string, PgOverride>>
  readonly keptAsText: Readonly<Record<string, string>>
  readonly foreignKeyNames: Readonly<Record<string, { readonly name: string }>>
  /** Indexes only the Postgres twin has (search's GIN index), keyed `table.index`. */
  readonly pgOnlyIndexes: Readonly<Record<string, PgOnlyIndex>>
  readonly classOf: (table: string, column: string) => TextColumnClass | undefined
}

const REAL_OVERRIDES: Overrides = {
  checks: PG_CHECK_OVERRIDES,
  indexWheres: PG_INDEX_WHERE_OVERRIDES,
  indexExpressions: PG_INDEX_EXPRESSION_OVERRIDES,
  nullsFirst: PG_INDEX_NULLS_FIRST,
  defaults: PG_DEFAULT_OVERRIDES,
  keptAsText: PG_TIMESTAMP_COLUMNS_KEPT_AS_TEXT,
  foreignKeyNames: PG_FOREIGN_KEY_RENAMES,
  pgOnlyIndexes: PG_ONLY_INDEXES,
  classOf: textColumnClass,
}

/** The SQLite column's kind, which decides its expected Postgres type. */
function kindOf(table: string, column: Column, overrides: Overrides): string {
  switch (column.columnType) {
    case 'SQLiteText':
    case 'SQLiteTextJson': {
      const declared = overrides.classOf(table, column.name)
      if (declared === 'timestamp' && `${table}.${column.name}` in overrides.keptAsText)
        return 'text'
      return declared === 'json' && column.columnType === 'SQLiteTextJson'
        ? 'json-value'
        : (declared ?? 'unclassified')
    }
    case 'SQLiteInteger':
      return 'integer'
    case 'SQLiteBoolean':
      return 'boolean'
    case 'SQLiteReal':
      return 'real'
    case 'SQLiteBlob':
    case 'SQLiteBlobBuffer':
      return 'blob'
    default:
      return `unmapped ${column.columnType}`
  }
}

/** Does the Postgres column have the type its SQLite twin's kind maps to? A reason when not. */
function typeFinding(kind: string, sqliteColumn: Column, pg: PgColumn): string | undefined {
  const type = pg.getSQLType()
  const want = (sqlType: string, extra = true): string | undefined =>
    type === sqlType && extra
      ? undefined
      : `is ${type} (${pg.columnType}), its class wants ${sqlType}`
  switch (kind) {
    case 'timestamp':
      return want('timestamp(3) with time zone', pg.columnType === 'PgTimestampString')
    case 'json':
      // jsonText: the driver's text passes through unparsed.
      return want('json', pg.mapFromDriverValue('[1]') === '[1]')
    case 'json-value':
      // jsonValue: parsed on read, as SQLite's mode: 'json' does.
      return want('json', Array.isArray(pg.mapFromDriverValue('[1]')))
    case 'text':
      return want('text COLLATE "C"')
    case 'integer': {
      const identity = sqliteColumn.primary
      const generated = pg.generatedIdentity?.type
      if (identity && generated !== 'byDefault') {
        return 'is a one-column integer key, so must be an identity generated by default'
      }
      if (!identity && generated !== undefined) return 'is an identity without being the key'
      return want('bigint', pg.columnType === 'PgBigInt53')
    }
    case 'boolean':
      return want('boolean')
    case 'real':
      return want('double precision')
    case 'blob':
      return want('bytea')
    case 'unclassified':
      return 'is a text column that schema-classes.ts does not classify'
    default:
      return kind
  }
}

/** The default the Postgres column must have, as comparable text. */
function expectedDefault(table: string, column: Column, kind: string, overrides: Overrides) {
  const override = overrides.defaults[`${table}.${column.name}`]
  if (override !== undefined) return { text: fold(override.sql), override: true }
  if (!column.hasDefault || column.default === undefined)
    return { text: undefined, override: false }
  const value = column.default
  if (kind === 'boolean') {
    const raw = is(value, SQL) ? sqliteSql(value).toLowerCase() : String(value)
    return { text: raw === '1' || raw === 'true' ? 'true' : 'false', override: false }
  }
  if (is(value, SQL)) return { text: `sql: ${sqliteSql(value)}`, override: false }
  if (kind === 'integer' || kind === 'real') return { text: String(value), override: false }
  const literal = typeof value === 'string' ? value : JSON.stringify(value)
  return { text: sqlLiteral(literal), override: false }
}

function actualDefault(column: PgColumn): string | undefined {
  if (!column.hasDefault || column.default === undefined) return undefined
  return is(column.default, SQL) ? pgSql(column.default) : String(column.default)
}

/** What a table set's parity check found, and which overrides it used. */
interface Parity {
  readonly findings: string[]
  readonly used: Set<string>
}

/** Compare one SQLite table with its Postgres twin. */
function compareTable(
  sqliteTable: SQLiteTable,
  pgTable: PgTable,
  overrides: Overrides,
  parity: Parity,
): void {
  const s = getTableConfig(sqliteTable)
  const p = getPgTableConfig(pgTable)
  const table = s.name
  const find = (what: string) => parity.findings.push(`${table}: ${what}`)
  if (p.name !== table) find(`its twin is named ${p.name}`)

  // Columns: names and order, property keys, nullability, keys, defaults, uniques, types.
  const sKeys = Object.entries(getTableColumns(sqliteTable))
  const pKeys = Object.entries(getTableColumns(pgTable))
  const sNames = sKeys.map(([key, column]) => `${key}:${(column as Column).name}`)
  const pNames = pKeys.map(([key, column]) => `${key}:${(column as Column).name}`)
  if (sNames.join(',') !== pNames.join(',')) {
    find(`columns differ: SQLite (${sNames.join(', ')}) and Postgres (${pNames.join(', ')})`)
  }
  const pByName = new Map(p.columns.map((column) => [column.name, column]))
  for (const column of s.columns) {
    const twin = pByName.get(column.name)
    if (twin === undefined) continue
    const at = `column ${column.name}`
    if (column.notNull !== twin.notNull) find(`${at}: not null ${column.notNull} / ${twin.notNull}`)
    if (column.primary !== twin.primary)
      find(`${at}: primary key ${column.primary} / ${twin.primary}`)
    if (
      column.isUnique !== twin.isUnique ||
      (column.isUnique && column.uniqueName !== twin.uniqueName)
    ) {
      find(`${at}: unique ${column.uniqueName ?? 'no'} / ${twin.uniqueName ?? 'no'}`)
    }
    const kind = kindOf(table, column, overrides)
    const wrongType = typeFinding(kind, column, twin as PgColumn)
    if (wrongType !== undefined) find(`${at} ${wrongType}`)
    const expected = expectedDefault(table, column, kind, overrides)
    if (expected.override) parity.used.add(`default ${table}.${column.name}`)
    const actual = actualDefault(twin as PgColumn)
    if (expected.text !== actual) find(`${at}: default ${expected.text} / ${actual}`)
  }

  // Composite primary keys.
  const pk = (columns: { name: string }[], name: string) =>
    `${name}(${columns.map((column) => column.name).join(',')})`
  const sPks = s.primaryKeys.map((key) => pk(key.columns, key.getName()))
  const pPks = p.primaryKeys.map((key) => pk(key.columns, key.getName()))
  if (sPks.join() !== pPks.join())
    find(`primary key ${sPks.join() || 'none'} / ${pPks.join() || 'none'}`)

  // Table-level unique constraints.
  const uniques = (list: { getName(): string; columns: { name: string }[] }[]) =>
    list.map((u) => pk(u.columns, u.getName())).sort()
  const sU = uniques(s.uniqueConstraints as never)
  const pU = uniques(p.uniqueConstraints as never)
  if (sU.join() !== pU.join()) find(`unique constraints ${sU.join()} / ${pU.join()}`)

  // Indexes, by name.
  const part = (column: unknown, render: (fragment: SQL) => string) =>
    is(column, SQL) ? `(${render(column)})` : (column as { name: string }).name
  const pIndexes = new Map(p.indexes.map((i) => [i.config.name, i.config]))
  const sIndexNames = new Set<string>()
  for (const { config } of s.indexes) {
    sIndexNames.add(config.name)
    const twin = pIndexes.get(config.name)
    if (twin === undefined) {
      find(`index ${config.name} is missing`)
      continue
    }
    // A key expression the override names is compared in its Postgres form.
    const expression = overrides.indexExpressions[`${table}.${config.name}`]
    const sCols = config.columns
      .map((column) => {
        const rendered = part(column, sqliteSql)
        if (expression === undefined || rendered !== `(${fold(expression.sqlite)})`) return rendered
        parity.used.add(`expression ${table}.${config.name}`)
        return `(${fold(expression.sql)})`
      })
      .join(',')
    const pCols = twin.columns.map((column) => part(column, pgSql)).join(',')
    if (sCols !== pCols) find(`index ${config.name} on (${sCols}) / (${pCols})`)
    if (Boolean(config.unique) !== Boolean(twin.unique))
      find(`index ${config.name}: unique differs`)
    // The NULL order of each key column: Postgres's default unless the override names it.
    const declared = overrides.nullsFirst[`${table}.${config.name}`]
    const stored = twin.columns.flatMap((column) => {
      const nulls = (column as { indexConfig?: { nulls?: string; order?: string } }).indexConfig
      return nulls?.nulls === 'first' && nulls.order !== 'desc'
        ? [(column as { name: string }).name]
        : []
    })
    if (declared !== undefined) parity.used.add(`nulls first ${table}.${config.name}`)
    if (stored.join(',') !== (declared?.columns ?? []).join(','))
      find(
        `index ${config.name}: NULLS FIRST on (${stored.join(',')}), the override says (${(declared?.columns ?? []).join(',')})`,
      )
    const override = overrides.indexWheres[`${table}.${config.name}`]
    const sWhere = config.where === undefined ? undefined : sqliteSql(config.where)
    const pWhere = twin.where === undefined ? undefined : pgSql(twin.where)
    if (override !== undefined) {
      parity.used.add(`where ${table}.${config.name}`)
      if (sWhere === fold(override.sql)) find(`index ${config.name}: its override changes nothing`)
      if (pWhere !== fold(override.sql))
        find(`index ${config.name}: where ${pWhere}, override says ${override.sql}`)
    } else if (sWhere !== pWhere) {
      find(`index ${config.name}: where ${sWhere} / ${pWhere}`)
    }
  }
  for (const [name, config] of pIndexes) {
    if (sIndexNames.has(name ?? '')) continue
    const only = overrides.pgOnlyIndexes[`${table}.${name}`]
    if (only === undefined) {
      find(`index ${name} exists only on Postgres`)
      continue
    }
    parity.used.add(`pg-only index ${table}.${name}`)
    const columns = config.columns.map((column) => part(column, pgSql)).join(',')
    const declared = 'columns' in only ? only.columns.join(',') : `(${fold(only.sql)})`
    if (config.method !== only.using || columns !== declared)
      find(
        `index ${name}: using ${config.method} on ${columns}, the override says ${only.using} on ${declared}`,
      )
    const where = config.where === undefined ? undefined : pgSql(config.where)
    if (where !== (only.where === undefined ? undefined : fold(only.where)))
      find(`index ${name}: where ${where}, the override says ${only.where}`)
  }

  // Foreign keys, by name, with their actions.
  const fks = (
    list: {
      getName(): string
      reference(): {
        columns: { name: string }[]
        foreignColumns: { name: string }[]
        foreignTable: object
      }
      onDelete?: string
      onUpdate?: string
    }[],
    nameOf: (t: object) => string,
    rename: (name: string) => string,
  ) =>
    list
      .map((fk) => {
        const ref = fk.reference()
        return `${rename(fk.getName())}(${ref.columns.map((c) => c.name).join(',')})->${nameOf(ref.foreignTable)}(${ref.foreignColumns.map((c) => c.name).join(',')}) delete ${fk.onDelete ?? 'no action'} update ${fk.onUpdate ?? 'no action'}`
      })
      .sort()
  const renamed = (name: string): string => {
    const rename = overrides.foreignKeyNames[`${table}.${name}`]
    if (rename === undefined) return name
    parity.used.add(`foreign key ${table}.${name}`)
    return rename.name
  }
  const sF = fks(s.foreignKeys as never, (t) => getTableConfig(t as SQLiteTable).name, renamed)
  const pF = fks(
    p.foreignKeys as never,
    (t) => getPgTableConfig(t as PgTable).name,
    (name) => name,
  )
  if (sF.join('\n') !== pF.join('\n'))
    find(`foreign keys\n  SQLite:   ${sF.join('; ')}\n  Postgres: ${pF.join('; ')}`)

  // Checks, by name and text.
  const pChecks = new Map(p.checks.map((c) => [c.name, pgSql(c.value)]))
  const sCheckNames = new Set<string>()
  for (const constraint of s.checks) {
    sCheckNames.add(constraint.name)
    const twin = pChecks.get(constraint.name)
    if (twin === undefined) {
      find(`check ${constraint.name} is missing`)
      continue
    }
    const override = overrides.checks[`${table}.${constraint.name}`]
    const sText = sqliteSql(constraint.value)
    if (override !== undefined) {
      parity.used.add(`check ${table}.${constraint.name}`)
      if (twin !== fold(override.sql))
        find(`check ${constraint.name}: ${twin}, override says ${override.sql}`)
    } else if (twin !== sText) {
      find(`check ${constraint.name}: ${sText} / ${twin}`)
    }
  }
  for (const name of pChecks.keys()) {
    if (!sCheckNames.has(name)) find(`check ${name} exists only on Postgres`)
  }
}

/** The parity of a SQLite table set with its Postgres twins, keyed by export name. */
function parityOf(
  sqlite: ReadonlyMap<string, SQLiteTable>,
  pg: ReadonlyMap<string, PgTable>,
  overrides: Overrides = REAL_OVERRIDES,
): Parity {
  const parity: Parity = { findings: [], used: new Set() }
  for (const [key, table] of sqlite) {
    const twin = pg.get(key)
    if (twin === undefined) {
      parity.findings.push(`${getTableConfig(table).name} (${key}) has no Postgres twin`)
      continue
    }
    compareTable(table, twin, overrides, parity)
  }
  for (const [key, table] of pg) {
    if (!sqlite.has(key)) {
      parity.findings.push(`${getPgTableConfig(table).name} (${key}) exists only on Postgres`)
    }
  }
  return parity
}

const IDENTITY_KEYS = new Set(
  Object.entries(sqliteServer)
    .filter(([, value]) => is(value, SQLiteTable) && isIdentity(getTableConfig(value).name))
    .map(([key]) => key),
)
// The identity package's Postgres-only table, re-exported with the rest of its schema.
const PG_ONLY_IDENTITY_KEYS = new Set(['identityRateLimit'])

// The server's Postgres-only tables (search's `transcript_text`), listed with their reasons.
const PG_ONLY_TABLE_KEYS = new Set(Object.keys(PG_ONLY_TABLES))

const SERVER_SQLITE = sqliteTablesOf(sqliteServer)
const SERVER_PG = pgTablesOf(
  pgServer,
  new Set([...IDENTITY_KEYS, ...PG_ONLY_IDENTITY_KEYS, ...PG_ONLY_TABLE_KEYS]),
)
const PG_ONLY_SERVER_TABLES = [...PG_ONLY_TABLE_KEYS].map((key) => (pgServer as Module)[key])
const SYNC_SQLITE = sqliteTablesOf(sqliteSync)
const SYNC_PG = pgTablesOf(pgSync, new Set())

const PARITY = {
  server: parityOf(SERVER_SQLITE, SERVER_PG),
  sync: parityOf(SYNC_SQLITE, SYNC_PG),
}

const allSqliteTables = (): SQLiteTable[] => [...SERVER_SQLITE.values(), ...SYNC_SQLITE.values()]
const allPgTables = (): PgTable[] => [
  ...SERVER_PG.values(),
  ...SYNC_PG.values(),
  ...(PG_ONLY_SERVER_TABLES as PgTable[]),
]

describe('the Postgres twin of the server schema', () => {
  it('has every SQLite table, column, key, index, foreign key and check, in the Postgres types of its class', () => {
    expect(SERVER_SQLITE.size).toBeGreaterThan(100)
    expect(PARITY.server.findings).toEqual([])
  })

  it('has exactly the Postgres-only tables PG_ONLY_TABLES lists, none named as a SQLite table', () => {
    expect(PG_ONLY_SERVER_TABLES.every((table) => is(table, PgTable))).toBe(true)
    const sqliteNames = new Set([...SERVER_SQLITE.values()].map((t) => getTableConfig(t).name))
    const clashes = (PG_ONLY_SERVER_TABLES as PgTable[])
      .map((table) => getPgTableConfig(table).name)
      .filter((name) => sqliteNames.has(name))
    expect(clashes).toEqual([])
  })

  it("re-exports the identity package's Postgres schema under the server schema's names", () => {
    const missing = [...IDENTITY_KEYS].filter((key) => !is((pgServer as Module)[key], PgTable))
    expect(missing).toEqual([])
  })
})

describe('the Postgres twin of the sync tables', () => {
  it('has every SQLite table, column, key, index, foreign key and check, in the Postgres types of its class', () => {
    expect(SYNC_SQLITE.size).toBeGreaterThan(0)
    expect(PARITY.sync.findings).toEqual([])
  })

  it('binds the same table set as the SQLite adapter', () => {
    expect(Object.keys(pgSync.pgSyncTables).sort()).toEqual([...SYNC_SQLITE.keys()].sort())
  })
})

describe('the class lists and the overrides', () => {
  it('classify every text column of both schemas, and nothing else', () => {
    const textColumns = new Set<string>()
    for (const table of allSqliteTables()) {
      const config = getTableConfig(table)
      for (const column of config.columns) {
        if (column.getSQLType() === 'text') textColumns.add(`${config.name}.${column.name}`)
      }
    }
    const classified = classifiedTextColumns()
    expect([...textColumns].filter((column) => !classified.has(column)).sort()).toEqual([])
    expect([...classified.keys()].filter((column) => !textColumns.has(column)).sort()).toEqual([])
  })

  it('are each used, by a difference that is still there', () => {
    const used = new Set([...PARITY.server.used, ...PARITY.sync.used])
    const listed = [
      ...Object.keys(PG_CHECK_OVERRIDES).map((key) => `check ${key}`),
      ...Object.keys(PG_INDEX_WHERE_OVERRIDES).map((key) => `where ${key}`),
      ...Object.keys(PG_INDEX_EXPRESSION_OVERRIDES).map((key) => `expression ${key}`),
      ...Object.keys(PG_INDEX_NULLS_FIRST).map((key) => `nulls first ${key}`),
      ...Object.keys(PG_DEFAULT_OVERRIDES).map((key) => `default ${key}`),
      ...Object.keys(PG_FOREIGN_KEY_RENAMES).map((key) => `foreign key ${key}`),
      ...Object.keys(PG_ONLY_INDEXES).map((key) => `pg-only index ${key}`),
    ]
    expect(listed.filter((key) => !used.has(key))).toEqual([])
    const classified = classifiedTextColumns()
    expect(
      Object.keys(PG_TIMESTAMP_COLUMNS_KEPT_AS_TEXT).filter(
        (key) => classified.get(key) !== 'timestamp',
      ),
    ).toEqual([])
  })

  it('name constraints the DDL notes still apply to', () => {
    const named = new Set<string>()
    for (const table of allPgTables()) {
      const config = getPgTableConfig(table)
      for (const fk of config.foreignKeys) named.add(`${config.name}.${fk.getName()}`)
      for (const c of config.checks) named.add(`${config.name}.${c.name}`)
    }
    expect(Object.keys(PG_DDL_NOTES).filter((key) => !named.has(key))).toEqual([])
  })
})

describe('the Postgres DDL', () => {
  it('names nothing longer than the 63 bytes Postgres keeps of an identifier', () => {
    const names: string[] = []
    for (const table of allPgTables()) {
      const config = getPgTableConfig(table)
      names.push(config.name, ...config.columns.map((column) => column.name))
      names.push(...config.indexes.map((i) => i.config.name ?? ''))
      names.push(...config.primaryKeys.map((key) => key.getName()))
      names.push(...config.uniqueConstraints.map((u) => u.getName() ?? ''))
      names.push(...config.foreignKeys.map((fk) => fk.getName()))
      names.push(...config.checks.map((c) => c.name))
    }
    expect(names.filter((name) => Buffer.byteLength(name) > 63)).toEqual([])
  })

  it('renders through drizzle-kit, every text column in byte order', async () => {
    const empty = await generateDrizzleJson({})
    const snapshot = await generateDrizzleJson({ ...pgServer, ...pgSync })
    const statements = await generateMigration(empty, snapshot)
    const creates = statements.filter((statement) => statement.startsWith('CREATE TABLE'))
    // The twins, the identity package's ten Postgres tables, the server's Postgres-only ones.
    expect(creates).toHaveLength(
      SERVER_PG.size +
        SYNC_PG.size +
        IDENTITY_KEYS.size +
        PG_ONLY_IDENTITY_KEYS.size +
        PG_ONLY_TABLE_KEYS.size,
    )
    const generatedNames = new Set(allPgTables().map((table) => getPgTableConfig(table).name))
    const plainText: string[] = []
    for (const create of creates) {
      const name = /^CREATE TABLE "([^"]+)"/.exec(create)?.[1] ?? ''
      if (!generatedNames.has(name)) continue
      for (const line of create.split('\n')) {
        if (/^\s*"[^"]+" text\b/.test(line) && !line.includes('COLLATE "C"'))
          plainText.push(`${name}: ${line.trim()}`)
      }
    }
    expect(plainText).toEqual([])
  })
})

describe('the checker finds planted drift', () => {
  // A small SQLite table with every kind of part, and its twins: the real one and drifted ones.
  const planted = sqliteTable(
    'planted',
    {
      id: sqliteText('id').primaryKey(),
      name: sqliteText('name').notNull(),
      at: sqliteText('at').notNull(),
      n: integer('n').notNull().default(0),
    },
    (table) => [
      sqliteIndex('planted_name').on(table.name),
      sqliteIndex('planted_n').on(table.n).where(sql`"n" > 0`),
      sqliteCheck('planted_n_check', sql`n >= 0`),
    ],
  )
  const classes: Overrides = {
    ...REAL_OVERRIDES,
    classOf: (table, column) =>
      table !== 'planted' ? undefined : column === 'at' ? 'timestamp' : 'text',
  }
  type Drift = {
    renamed?: boolean
    plainText?: boolean
    index?: boolean
    check?: boolean
    /** A GIN index only the twin has, over this expression. */
    searchIndex?: string
    /** planted_name stores NULLs first (POD-6992). */
    nullsFirst?: boolean
  }
  const twin = (drift: Drift = {}) =>
    pgTable(
      'planted',
      {
        id: pgSync.textC('id').primaryKey(),
        name: (drift.plainText
          ? pgText('name')
          : pgSync.textC(drift.renamed ? 'title' : 'name')
        ).notNull(),
        at: pgSync.isoTimestamp('at').notNull(),
        n: pgSync.int8('n').notNull().default(0),
      },
      (table) => [
        ...(drift.index
          ? []
          : [
              index('planted_name').on(
                drift.nullsFirst ? table.name.asc().nullsFirst() : table.name,
              ),
            ]),
        index('planted_n').on(table.n).where(sql`"n" > 0`),
        ...(drift.check ? [] : [check('planted_n_check', sql`n >= 0`)]),
        ...(drift.searchIndex === undefined
          ? []
          : [index('planted_search').using('gin', sql.raw(drift.searchIndex))]),
      ],
    )
  const findingsOf = (pg: PgTable, overrides: Overrides = classes) =>
    parityOf(new Map([['planted', planted]]), new Map([['planted', pg]]), overrides).findings.join(
      '\n',
    )

  it('accepts a faithful twin', () => {
    expect(findingsOf(twin())).toBe('')
  })

  it('finds a renamed column', () => {
    expect(findingsOf(twin({ renamed: true }))).toMatch(/columns differ/)
  })

  it('finds a text column without COLLATE "C"', () => {
    expect(findingsOf(twin({ plainText: true }))).toMatch(
      /column name is text \(PgText\), its class wants text COLLATE "C"/,
    )
  })

  it('finds a NULL order the overrides do not name, and one they name that is not there', () => {
    expect(findingsOf(twin({ nullsFirst: true }))).toMatch(
      /index planted_name: NULLS FIRST on \(name\), the override says \(\)/,
    )
    const named: Overrides = {
      ...classes,
      nullsFirst: { 'planted.planted_name': { columns: ['name'] } },
    }
    expect(findingsOf(twin({ nullsFirst: true }), named)).toBe('')
    expect(findingsOf(twin(), named)).toMatch(
      /index planted_name: NULLS FIRST on \(\), the override says \(name\)/,
    )
  })

  it('finds a missing index and a missing check', () => {
    expect(findingsOf(twin({ index: true }))).toMatch(/index planted_name is missing/)
    expect(findingsOf(twin({ check: true }))).toMatch(/check planted_n_check is missing/)
  })

  it('finds an index only the twin has, unless the list names it with its expression', () => {
    const vector = `to_tsvector('simple', "name")`
    expect(findingsOf(twin({ searchIndex: vector }))).toMatch(
      /index planted_search exists only on Postgres/,
    )
    const listed = (sql: string): Overrides => ({
      ...classes,
      pgOnlyIndexes: { 'planted.planted_search': { using: 'gin', sql, reason: 'planted' } },
    })
    expect(findingsOf(twin({ searchIndex: vector }), listed(vector))).toBe('')
    expect(
      findingsOf(twin({ searchIndex: vector }), listed(`to_tsvector('english', "name")`)),
    ).toMatch(/index planted_search: using gin on/)
  })

  it('finds a timestamp column that is not timestamptz', () => {
    const pg = pgTable(
      'planted',
      {
        id: pgSync.textC('id').primaryKey(),
        name: pgSync.textC('name').notNull(),
        at: pgSync.textC('at').notNull(),
        n: pgSync.int8('n').notNull().default(0),
      },
      (table) => [
        index('planted_name').on(table.name),
        index('planted_n').on(table.n).where(sql`"n" > 0`),
        check('planted_n_check', sql`n >= 0`),
      ],
    )
    expect(findingsOf(pg)).toMatch(
      /column at is text COLLATE "C" .*wants timestamp\(3\) with time zone/,
    )
  })

  it('finds a SQLite table with no twin, and a text column the class lists do not name', () => {
    expect(parityOf(new Map([['planted', planted]]), new Map(), classes).findings).toEqual([
      'planted (planted) has no Postgres twin',
    ])
    const unclassified: Overrides = { ...REAL_OVERRIDES, classOf: () => undefined }
    expect(
      parityOf(
        new Map([['planted', planted]]),
        new Map([['planted', twin()]]),
        unclassified,
      ).findings.join('\n'),
    ).toMatch(/column name is a text column that schema-classes.ts does not classify/)
  })
})
