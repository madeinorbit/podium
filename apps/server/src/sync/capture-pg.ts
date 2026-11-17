/**
 * CHANGE CAPTURE ON POSTGRES, INSIDE THE WRITE STATEMENT (POD-6982, POD-6958 design 2.5).
 *
 * On SQLite, generated triggers (`capture-triggers.ts`) add a row to `sync_capture` for
 * every change of a row a synced kind reads. Postgres gets no triggers (a trigger needs
 * PL/pgSQL, and the store uses no stored procedures), so each write to a source table is
 * ONE data-modifying statement that writes the row and its capture rows together:
 *
 * ```sql
 * -- update
 * with "__capture_old" as (select <every column as __capture_o_*> from t where <where> for update),
 *      "__capture_w"   as (update t set … from "__capture_old" where <primary key join>
 *                          returning t.<every column>, "__capture_old".<every __capture_o_*>),
 *      "__capture_c"   as (insert into sync_capture (kind, source, op, old_key, new_key)
 *                          select … from "__capture_w" where <row filter> and <changed>
 *                          union all …)
 * select <the caller's returning> from "__capture_w"
 * -- insert: "__capture_w" is the insert; an upsert joins each returned row back to the
 * --   table, which a sibling of a data-modifying CTE reads as it was before the statement,
 * --   so a returned row that existed is an update and one that did not an insert.
 * -- delete: "__capture_w" is the delete; each ON DELETE CASCADE / SET NULL that reaches a
 * --   source table reads the children from the same snapshot ("__capture_k<i>") and
 * --   captures their delete, or their update to NULL, as SQLite's triggers do.
 * ```
 *
 * WHAT IS GENERATED, AND FROM WHAT. Everything comes from `RECORD_SOURCES`, the same
 * declarations the SQLite triggers come from: per (kind, source, operation) one branch
 * with the source's key columns, old and new, as a JSON array, the source's row filter,
 * and its changed flags: `old.c IS DISTINCT FROM new.c` for each column it watches and
 * each derived value it declares. A row filter or derived value in SQLite SQL has a
 * Postgres form next to it (`RecordSource.pg`).
 *
 * THE SAME CAPTURED ROWS AS SQLITE (design 2.3 rule 11). A key is encoded with SQLite's
 * values, so the drain parses the same arrays on both engines: a boolean as 0 or 1, a
 * `timestamptz` as its `toISOString()` text (and `-infinity` / `infinity` as the two
 * sentinels `''` and `'￿'`), a `json` column as its text. A changed flag compares a
 * `json` column as `::text` (`json` has no equality; SQLite compares the text) and a
 * `timestamptz` column as an instant. The test oracle (`test-support/capture-oracle.ts`)
 * and the cross-engine corpus (`capture-pg.test.ts`) hold both engines to it.
 *
 * THE ONE WAY TO WRITE A SOURCE TABLE: {@link captureWrite}. A binding wraps every
 * insert, update and delete on a source table (or on a table whose deletion cascades to
 * one) in it, in the definition's single source:
 *
 * ```ts
 * const setTitle = prepared((db, t) =>
 *   captureWrite(db.update(t.issues).set({ title: param(…) }).where(…)).prepare(),
 * )
 * ```
 *
 * On SQLite it returns the builder as it is (the triggers capture), so the SQLite SQL
 * does not move; on Postgres it keeps the builder, its typing and its result mapping, and
 * replaces only the statement it renders. A write that provably captures nothing (an
 * update of columns no source reads, an insert where every source watches updates only)
 * stays the plain statement. The write census (`capture-pg.test.ts`) refuses any other
 * Postgres INSERT, UPDATE or DELETE on a source table.
 *
 * The fail-closed guard is unchanged: `sync_capture.undrained` references the always
 * empty `sync_capture_guard` through a DEFERRABLE INITIALLY DEFERRED foreign key in the
 * Postgres baseline (POD-6981), so a transaction that leaves capture rows undrained cannot
 * commit, and the drain (`SyncRepository.drainCapture`) is the same statement on both.
 *
 * This module imports no Postgres module: it reads a builder's dialect by its drizzle
 * entity kind and the column classes from the SQLite schema (`migrations/pg/schema-classes`),
 * so a SQLite store that loads a binding never loads drizzle's Postgres code.
 */

import type { MetadataEntityKind } from '@podium/protocol'
import {
  type Column,
  entityKind,
  getTableColumns,
  getTableName,
  is,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm'
import { getTableConfig, SQLiteBoolean, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { textColumnClass } from '../migrations/pg/schema-classes'
import * as schema from '../migrations/schema'
import {
  RECORD_SOURCES,
  type RecordSource,
  type RecordSources,
  sourceTableName,
  watchedColumns,
} from './record-sources'

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const OLD_CTE = '"__capture_old"'
const WRITE_CTE = '"__capture_w"'
const CAPTURE_CTE = '"__capture_c"'
const OLD_ROW = '"__capture_o"'
/** The prefix of a column's old value in the update form. */
const OLD_COLUMN = '__capture_o_'
const kidCte = (index: number) => `"__capture_k${index}"`

/** Postgres truncates identifiers past this many bytes. */
const MAX_IDENTIFIER = 63

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** How a column is stored on Postgres, as far as capture cares (design 2.3). */
export type CaptureColumnClass = 'boolean' | 'timestamp' | 'json' | 'plain'

/** A table, as the capture forms read it. */
export interface CaptureTable {
  readonly name: string
  /** Every column's SQL name, in declaration order. */
  readonly columns: readonly string[]
  readonly classes: ReadonlyMap<string, CaptureColumnClass>
  readonly primaryKey: readonly string[]
}

/** One ON DELETE action that reaches a source table. */
export interface CaptureCascade {
  readonly parent: string
  readonly child: string
  readonly action: 'cascade' | 'set null'
  /** The child's referencing columns. */
  readonly columns: readonly string[]
  /** The parent's referenced columns, in the same order. */
  readonly references: readonly string[]
}

const SQLITE_TABLES: ReadonlyMap<string, SQLiteTable> = new Map(
  (Object.values(schema) as unknown[]).flatMap((value) =>
    is(value, SQLiteTable) ? [[getTableName(value), value] as const] : [],
  ),
)

function classOf(table: string, column: Column): CaptureColumnClass {
  const text = textColumnClass(table, column.name)
  if (text === 'timestamp') return 'timestamp'
  if (text === 'json') return 'json'
  if (is(column, SQLiteBoolean)) return 'boolean'
  return 'plain'
}

const tableCache = new Map<string, CaptureTable>()

/** The capture view of the server table `name`, from its SQLite declaration (the twins match). */
export function captureTable(name: string): CaptureTable {
  const cached = tableCache.get(name)
  if (cached) return cached
  const table = SQLITE_TABLES.get(name)
  if (table === undefined) throw new Error(`capture: no server table named ${name}`)
  const config = getTableConfig(table)
  const columns = Object.values(getTableColumns(table) as Record<string, Column>)
  const primaryKey = [
    ...config.columns.filter((column) => column.primary).map((column) => column.name),
    ...(config.primaryKeys[0]?.columns.map((column) => column.name) ?? []),
  ]
  if (primaryKey.length === 0) throw new Error(`capture: ${name} has no primary key to join on`)
  for (const column of columns) {
    if (Buffer.byteLength(OLD_COLUMN + column.name) > MAX_IDENTIFIER) {
      throw new Error(`capture: ${name}.${column.name} is too long for its old-value alias`)
    }
  }
  const out: CaptureTable = {
    name,
    columns: columns.map((column) => column.name),
    classes: new Map(columns.map((column) => [column.name, classOf(name, column)])),
    primaryKey,
  }
  tableCache.set(name, out)
  return out
}

/** One declared source, with the kind and index its capture rows name. */
export interface CaptureSource {
  readonly kind: MetadataEntityKind
  readonly index: number
  readonly source: RecordSource
}

const sourceCache = new WeakMap<RecordSources, ReadonlyMap<string, readonly CaptureSource[]>>()

/** The declared sources of every source table, by table name. */
export function sourcesByTable(
  sources: RecordSources = RECORD_SOURCES,
): ReadonlyMap<string, readonly CaptureSource[]> {
  const cached = sourceCache.get(sources)
  if (cached) return cached
  const out = new Map<string, CaptureSource[]>()
  for (const [kind, list] of Object.entries(sources) as [
    MetadataEntityKind,
    readonly RecordSource[],
  ][]) {
    list.forEach((source, index) => {
      const name = sourceTableName(source)
      out.set(name, [...(out.get(name) ?? []), { kind, index, source }])
    })
  }
  sourceCache.set(sources, out)
  return out
}

const cascadeCache = new WeakMap<RecordSources, readonly CaptureCascade[]>()

/**
 * Every ON DELETE CASCADE and SET NULL whose child is a source table (design 2.5,
 * "Cascades"): a cascade is invisible to a write-path capture, so the parent's delete
 * form captures the children. Refuses what the delete form does not handle: an ON
 * UPDATE action or SET DEFAULT reaching a source table, and a cascaded child whose own
 * deletion cascades to a source table again.
 */
export function cascadesReachingSources(
  sources: RecordSources = RECORD_SOURCES,
): readonly CaptureCascade[] {
  const cached = cascadeCache.get(sources)
  if (cached) return cached
  const sourceTables = sourcesByTable(sources)
  const out: CaptureCascade[] = []
  for (const [child, table] of SQLITE_TABLES) {
    if (!sourceTables.has(child)) continue
    for (const key of getTableConfig(table).foreignKeys) {
      const reference = key.reference()
      const parent = getTableName(reference.foreignTable)
      const onUpdate = key.onUpdate ?? 'no action'
      if (onUpdate !== 'no action' && onUpdate !== 'restrict') {
        throw new Error(`capture: ${child} -> ${parent} has ON UPDATE ${onUpdate}, not captured`)
      }
      const onDelete = key.onDelete ?? 'no action'
      if (onDelete === 'no action' || onDelete === 'restrict') continue
      if (onDelete !== 'cascade' && onDelete !== 'set null') {
        throw new Error(`capture: ${child} -> ${parent} has ON DELETE ${onDelete}, not captured`)
      }
      out.push({
        parent,
        child,
        action: onDelete,
        columns: reference.columns.map((column) => column.name),
        references: reference.foreignColumns.map((column) => column.name),
      })
    }
  }
  for (const edge of out) {
    if (edge.action !== 'cascade') continue
    const deeper = out.find((next) => next.parent === edge.child && next.child !== edge.child)
    if (deeper) {
      throw new Error(
        `capture: ${edge.parent} cascades to ${edge.child}, which cascades to ${deeper.child}: ` +
          'the delete form captures one level',
      )
    }
  }
  cascadeCache.set(sources, out)
  return out
}

// ---------------------------------------------------------------------------
// SQL over a row
// ---------------------------------------------------------------------------

/** What `{row}.column` stands for in a capture form: an expression per column. */
export type RowRef = (column: string) => string

const ROW_COLUMN = /\{row\}\.(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))/g

/** `text` (SQL over `{row}`) with each `{row}.column` replaced by `ref(column)`. */
export function overRow(text: string, ref: RowRef): string {
  const out = text.replace(ROW_COLUMN, (_match, quoted: string | undefined, bare: string) =>
    ref(quoted === undefined ? bare : quoted.replaceAll('""', '"')),
  )
  if (out.includes('{row}')) throw new Error(`capture: a {row} without a column in: ${text}`)
  return out
}

/** The columns `text` reads of its row. */
export function rowColumnsIn(text: string): string[] {
  return [...text.matchAll(ROW_COLUMN)].map((match) =>
    match[1] === undefined ? (match[2] as string) : match[1].replaceAll('""', '"'),
  )
}

/** A source's row filter on Postgres. */
export const pgRowsOf = (source: RecordSource): string | undefined => source.pg?.rows ?? source.rows

/** A source's derived values on Postgres. */
export const pgDerivedOf = (source: RecordSource): readonly string[] =>
  source.pg?.derived ?? source.derived ?? []

/** `expression` as the value SQLite's `json_array` puts in a captured key. */
function keyValue(cls: CaptureColumnClass, expression: string): string {
  switch (cls) {
    case 'boolean':
      return `(${expression})::int`
    case 'timestamp':
      return `CASE WHEN ${expression} = '-infinity' THEN '' WHEN ${expression} = 'infinity' THEN chr(65535) ELSE to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`
    case 'json':
      return `CAST(${expression} AS TEXT)`
    case 'plain':
      return expression
  }
}

/** A source's key over `ref`, as the JSON array text SQLite's triggers write. */
export function pgKey(table: CaptureTable, source: RecordSource, ref: RowRef): string {
  const values = source.keys.map((column) =>
    keyValue(table.classes.get(column.name) ?? 'plain', ref(column.name)),
  )
  return `json_build_array(${values.join(', ')})::text`
}

/** Whether an update from `old` to `now` changed anything the source reads. */
export function pgChanged(
  table: CaptureTable,
  source: RecordSource,
  old: RowRef,
  now: RowRef,
): string {
  const flags = [
    ...watchedColumns(source).map((column) =>
      table.classes.get(column) === 'json'
        ? `CAST(${old(column)} AS TEXT) IS DISTINCT FROM CAST(${now(column)} AS TEXT)`
        : `${old(column)} IS DISTINCT FROM ${now(column)}`,
    ),
    ...pgDerivedOf(source).map(
      (value) => `(${overRow(value, old)}) IS DISTINCT FROM (${overRow(value, now)})`,
    ),
  ]
  return flags.length === 0 ? 'false' : `(${flags.join(' OR ')})`
}

/**
 * When a change of `op` is captured for the source, as SQLite's trigger WHEN says: an
 * insert or delete of a row the filter admits; an update of a row the filter admits
 * before or after that changed something the source reads.
 */
export function pgCaptureWhen(
  op: 'i' | 'u' | 'd',
  table: CaptureTable,
  source: RecordSource,
  old: RowRef,
  now: RowRef,
): string {
  const rows = pgRowsOf(source)
  const admits = (ref: RowRef) => (rows === undefined ? undefined : `(${overRow(rows, ref)})`)
  switch (op) {
    case 'i':
      return admits(now) ?? 'true'
    case 'd':
      return admits(old) ?? 'true'
    case 'u': {
      const was = admits(old)
      const changed = pgChanged(table, source, old, now)
      return was === undefined ? changed : `(${was} OR ${admits(now)}) AND ${changed}`
    }
  }
}

const opsOf = (source: RecordSource) => new Set(source.ops ?? ['i', 'u', 'd'])

/** The columns a change must touch for the source to capture an update. */
function columnsRead(source: RecordSource): Set<string> {
  return new Set([
    ...watchedColumns(source),
    ...[source.rows, source.pg?.rows, ...(source.derived ?? []), ...(source.pg?.derived ?? [])]
      .filter((text): text is string => text !== undefined)
      .flatMap(rowColumnsIn),
  ])
}

/**
 * Whether a write of `op` on `table` can capture anything, so it must be a capture form:
 * a source on the table watches the operation (for an update: and reads a column in
 * `setColumns`, when they are known), or, for a delete, the table's deletion cascades to
 * a source table.
 */
export function captureNeeded(
  table: string,
  op: 'i' | 'u' | 'd',
  setColumns?: readonly string[],
  sources: RecordSources = RECORD_SOURCES,
): boolean {
  const own = sourcesByTable(sources).get(table) ?? []
  if (op === 'd' && cascadesReachingSources(sources).some((edge) => edge.parent === table)) {
    return true
  }
  return own.some(({ source }) => {
    if (!opsOf(source).has(op)) return false
    if (op !== 'u' || setColumns === undefined) return true
    const read = columnsRead(source)
    return setColumns.some((column) => read.has(column))
  })
}

// ---------------------------------------------------------------------------
// The branches
// ---------------------------------------------------------------------------

interface Branch {
  readonly op: 'i' | 'u' | 'd'
  readonly from: string
  readonly old?: RowRef
  readonly now?: RowRef
  /** A condition every row of this branch must meet besides the source's own. */
  readonly also?: string
}

/** The SELECTs that produce one branch's capture rows, one per source watching its op. */
function branchSelects(
  table: CaptureTable,
  sources: readonly CaptureSource[],
  branch: Branch,
): string[] {
  const none: RowRef = () => {
    throw new Error('capture: a branch read a row it does not have')
  }
  const old = branch.old ?? none
  const now = branch.now ?? none
  return sources
    .filter(({ source }) => opsOf(source).has(branch.op))
    .map(({ kind, index, source }) => {
      const when = pgCaptureWhen(branch.op, table, source, old, now)
      const condition = branch.also === undefined ? when : `${branch.also} AND ${when}`
      return (
        `select ${literal(kind)}::text, ${index}::bigint, '${branch.op}'::text, ` +
        `${branch.old ? pgKey(table, source, old) : 'NULL::text'}, ` +
        `${branch.now ? pgKey(table, source, now) : 'NULL::text'} ` +
        `from ${branch.from} where ${condition}`
      )
    })
}

const refIn =
  (alias: string, prefix = ''): RowRef =>
  (column) =>
    `${alias}.${quote(prefix + column)}`

/** The children a delete's cascades reach, as CTEs and the branches capturing them. */
function cascadeParts(
  parent: CaptureTable,
  sources: RecordSources,
): { ctes: string[]; selects: string[] } {
  const ctes: string[] = []
  const selects: string[] = []
  const byTable = sourcesByTable(sources)
  cascadesReachingSources(sources)
    .filter((edge) => edge.parent === parent.name)
    .forEach((edge, i) => {
      const child = captureTable(edge.child)
      const alias = kidCte(i)
      const columns = child.columns.map(quote).join(', ')
      const fk = edge.columns.map(quote).join(', ')
      const referenced = edge.references.map(quote).join(', ')
      // A row the delete itself removes is the delete's own row, not a cascaded one:
      // Postgres applies the action after the statement, when that row is gone.
      const self =
        edge.child === edge.parent
          ? ` and (${child.primaryKey.map(quote).join(', ')}) not in (select ${child.primaryKey
              .map(quote)
              .join(', ')} from ${WRITE_CTE})`
          : ''
      ctes.push(
        `${alias} as (select ${columns} from ${quote(child.name)} where (${fk}) in (select ${referenced} from ${WRITE_CTE})${self})`,
      )
      const old = refIn(alias)
      const childSources = byTable.get(child.name) ?? []
      if (edge.action === 'cascade') {
        selects.push(...branchSelects(child, childSources, { op: 'd', from: alias, old }))
      } else {
        // The same row with its referencing columns NULL, typed as the columns are.
        const nulled = new Set(edge.columns)
        const now: RowRef = (column) =>
          nulled.has(column) ? `(CASE WHEN false THEN ${old(column)} END)` : old(column)
        selects.push(...branchSelects(child, childSources, { op: 'u', from: alias, old, now }))
      }
    })
  return { ctes, selects }
}

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

/** The part of a drizzle Postgres write builder the forms read. */
interface PgWriteBuilder {
  readonly config: {
    readonly table: Table
    readonly where?: SQL
    readonly set?: Record<string, unknown>
    readonly onConflict?: SQL
    readonly returning?: unknown
    readonly from?: unknown
    readonly joins?: readonly unknown[]
    readonly withList?: readonly unknown[]
    readonly ignoreSelectionCastCodecs?: boolean
    readonly [key: string]: unknown
  }
  readonly dialect: {
    buildUpdateSet(table: Table, set: Record<string, unknown>): SQL
    buildInsertQuery(config: unknown): SQL
    buildDeleteQuery(config: unknown): SQL
    buildSelection(
      fields: unknown,
      options: { isSingleTable: boolean; ignoreCastCodecs?: boolean },
    ): SQL
    sqlToQuery(query: SQL): { sql: string }
  }
  getSQL(): SQL
}

type WriteOp = 'i' | 'u' | 'd'

/** The dialect and operation of a drizzle write builder, by its entity kinds. */
function writeKindOf(builder: unknown): { dialect: 'pg' | 'sqlite'; op: WriteOp } | undefined {
  if (builder === null || typeof builder !== 'object') return undefined
  for (
    let kind: unknown = Object.getPrototypeOf(builder)?.constructor;
    typeof kind === 'function';
    kind = Object.getPrototypeOf(kind)
  ) {
    switch ((kind as { readonly [entityKind]?: string })[entityKind]) {
      case 'PgInsert':
        return { dialect: 'pg', op: 'i' }
      case 'PgUpdate':
        return { dialect: 'pg', op: 'u' }
      case 'PgDelete':
        return { dialect: 'pg', op: 'd' }
      case 'SQLiteInsert':
        return { dialect: 'sqlite', op: 'i' }
      case 'SQLiteUpdate':
        return { dialect: 'sqlite', op: 'u' }
      case 'SQLiteDelete':
        return { dialect: 'sqlite', op: 'd' }
    }
  }
  return undefined
}

function refuseShape(builder: PgWriteBuilder, name: string): void {
  const { config } = builder
  if (config.withList !== undefined && config.withList.length > 0) {
    throw new Error(`captureWrite: a write on ${name} with its own WITH is not supported`)
  }
  if (config.from !== undefined || (config.joins !== undefined && config.joins.length > 0)) {
    throw new Error(`captureWrite: an update of ${name} with FROM or joins is not supported`)
  }
  const table = config.table as unknown as Record<symbol, unknown>
  // drizzle's own keys for a table's name and the name it aliases (`drizzle-orm/table`).
  if (table[Symbol.for('drizzle:Name')] !== table[Symbol.for('drizzle:OriginalName')]) {
    throw new Error(`captureWrite: an aliased ${name} is not supported`)
  }
}

/** The SQL column names an update's SET assigns, including drizzle's `$onUpdate` columns. */
function setColumnsOf(builder: PgWriteBuilder): string[] {
  const columns = getTableColumns(builder.config.table) as Record<
    string,
    Column & { onUpdateFn?: unknown }
  >
  const set = builder.config.set ?? {}
  return Object.entries(columns)
    .filter(([key, column]) => set[key] !== undefined || column.onUpdateFn !== undefined)
    .map(([, column]) => column.name)
}

/** The caller's RETURNING, read from the write's rows; `1` for a write without one. */
function callerSelection(builder: PgWriteBuilder): SQL {
  const { config, dialect } = builder
  if (config.returning === undefined) return sql.raw('1')
  return dialect.buildSelection(config.returning, {
    isSingleTable: true,
    ignoreCastCodecs: config.ignoreSelectionCastCodecs,
  })
}

/** `with <ctes>, "__capture_c" as (insert … <selects>) select <caller> from "__capture_w"`. */
function assemble(
  builder: PgWriteBuilder,
  head: SQL,
  ctes: readonly string[],
  selects: readonly string[],
): SQL {
  const tail = [
    ...ctes,
    ...(selects.length === 0
      ? []
      : [
          `${CAPTURE_CTE} as (insert into "sync_capture" ("kind", "source", "op", "old_key", "new_key") ${selects.join(' union all ')})`,
        ]),
  ]
  return sql`${head}${sql.raw(tail.map((cte) => `, ${cte}`).join(''))} select ${callerSelection(builder)} from ${sql.raw(WRITE_CTE)}`
}

function updateForm(builder: PgWriteBuilder, sources: RecordSources): SQL {
  const table = captureTable(getTableName(builder.config.table))
  const own = sourcesByTable(sources).get(table.name) ?? []
  const name = quote(table.name)
  const oldColumns = table.columns
    .map((column) => `${name}.${quote(column)} as ${quote(OLD_COLUMN + column)}`)
    .join(', ')
  const join = table.primaryKey
    .map((column) => `${name}.${quote(column)} = ${OLD_CTE}.${quote(OLD_COLUMN + column)}`)
    .join(' and ')
  const returning = [
    ...table.columns.map((column) => `${name}.${quote(column)}`),
    ...table.columns.map((column) => `${OLD_CTE}.${quote(OLD_COLUMN + column)}`),
  ].join(', ')
  const { config, dialect } = builder
  const where = config.where === undefined ? sql.raw('') : sql` where ${config.where}`
  const set = dialect.buildUpdateSet(config.table, config.set ?? {})
  const head = sql`with ${sql.raw(OLD_CTE)} as (select ${sql.raw(oldColumns)} from ${sql.raw(name)}${where} for update), ${sql.raw(WRITE_CTE)} as (update ${sql.raw(name)} set ${set} from ${sql.raw(OLD_CTE)} where ${sql.raw(join)} returning ${sql.raw(returning)})`
  const selects = branchSelects(table, own, {
    op: 'u',
    from: WRITE_CTE,
    old: refIn(WRITE_CTE, OLD_COLUMN),
    now: refIn(WRITE_CTE),
  })
  return assemble(builder, head, [], selects)
}

/** Whether an insert is an upsert: ON CONFLICT … DO UPDATE, which may update the row it meets. */
function isUpsert(builder: PgWriteBuilder): boolean {
  const conflict = builder.config.onConflict
  return (
    conflict !== undefined && builder.dialect.sqlToQuery(conflict).sql.includes(' do update set ')
  )
}

/** The primary key columns an upsert's DO UPDATE assigns: refused, the join-back keys on them. */
function upsertAssignsKey(builder: PgWriteBuilder, table: CaptureTable): string[] {
  const conflict = builder.config.onConflict
  if (conflict === undefined) return []
  const text = builder.dialect.sqlToQuery(conflict).sql
  const at = text.indexOf(' do update set ')
  if (at < 0) return []
  const assigned = [...text.slice(at).matchAll(/"((?:[^"]|"")+)" = /g)].map((match) =>
    (match[1] as string).replaceAll('""', '"'),
  )
  return table.primaryKey.filter((column) => assigned.includes(column))
}

function insertForm(builder: PgWriteBuilder, sources: RecordSources): SQL {
  const table = captureTable(getTableName(builder.config.table))
  const own = sourcesByTable(sources).get(table.name) ?? []
  const name = quote(table.name)
  const { config, dialect } = builder
  const upsert = isUpsert(builder)
  const keyAssigned = upsertAssignsKey(builder, table)
  if (keyAssigned.length > 0) {
    throw new Error(
      `captureWrite: an upsert of ${table.name} that assigns its key (${keyAssigned.join(', ')}) is not supported`,
    )
  }
  const write = dialect.buildInsertQuery({ ...config, returning: undefined, withList: undefined })
  const returning = table.columns.map((column) => `${name}.${quote(column)}`).join(', ')
  const head = sql`with ${sql.raw(WRITE_CTE)} as (${write} returning ${sql.raw(returning)})`
  const now = refIn(WRITE_CTE)
  if (!upsert)
    return assemble(builder, head, [], branchSelects(table, own, { op: 'i', from: WRITE_CTE, now }))
  // A sibling of a data-modifying CTE reads the table as it was before the statement:
  // the returned row's old version, when it had one.
  const joined = `${WRITE_CTE} left join ${name} as ${OLD_ROW} on ${table.primaryKey
    .map((column) => `${OLD_ROW}.${quote(column)} = ${WRITE_CTE}.${quote(column)}`)
    .join(' and ')}`
  const missing = `${OLD_ROW}.${quote(table.primaryKey[0] as string)} is null`
  const present = `${OLD_ROW}.${quote(table.primaryKey[0] as string)} is not null`
  return assemble(
    builder,
    head,
    [],
    [
      ...branchSelects(table, own, { op: 'i', from: joined, now, also: missing }),
      ...branchSelects(table, own, {
        op: 'u',
        from: joined,
        old: refIn(OLD_ROW),
        now,
        also: present,
      }),
    ],
  )
}

function deleteForm(builder: PgWriteBuilder, sources: RecordSources): SQL {
  const table = captureTable(getTableName(builder.config.table))
  const own = sourcesByTable(sources).get(table.name) ?? []
  const name = quote(table.name)
  const { config, dialect } = builder
  const write = dialect.buildDeleteQuery({ ...config, returning: undefined, withList: undefined })
  const returning = table.columns.map((column) => `${name}.${quote(column)}`).join(', ')
  const head = sql`with ${sql.raw(WRITE_CTE)} as (${write} returning ${sql.raw(returning)})`
  const cascades = cascadeParts(table, sources)
  return assemble(builder, head, cascades.ctes, [
    ...branchSelects(table, own, { op: 'd', from: WRITE_CTE, old: refIn(WRITE_CTE) }),
    ...cascades.selects,
  ])
}

/** The capture form of `builder`'s write, or undefined when the write captures nothing. */
function captureForm(
  builder: PgWriteBuilder,
  op: WriteOp,
  sources: RecordSources,
): SQL | undefined {
  const name = getTableName(builder.config.table)
  const needed =
    captureNeeded(name, op, op === 'u' ? setColumnsOf(builder) : undefined, sources) ||
    // An upsert's DO UPDATE is an update: a source that watches only updates needs it.
    (op === 'i' && isUpsert(builder) && captureNeeded(name, 'u', undefined, sources))
  if (!needed) return undefined
  refuseShape(builder, name)
  switch (op) {
    case 'u':
      return updateForm(builder, sources)
    case 'i':
      return insertForm(builder, sources)
    case 'd':
      return deleteForm(builder, sources)
  }
}

/**
 * THE WRITE TO A SOURCE TABLE (see the module comment). Takes a drizzle insert, update
 * or delete builder and returns it: unchanged on SQLite, where the triggers capture; on
 * Postgres rendering its capture form, built when the statement is (so a `.returning()`
 * or `.where()` added after this call is part of it). The builder's run methods and
 * result shapes stay what they were: `run` counts the rows written, `all`/`get` return
 * the builder's own RETURNING.
 *
 * `sources` is for tests that capture a subset; production uses the declarations.
 */
export function captureWrite<B>(builder: B, sources: RecordSources = RECORD_SOURCES): B {
  const kind = writeKindOf(builder)
  if (kind === undefined) {
    throw new Error('captureWrite takes a drizzle insert, update or delete builder')
  }
  if (kind.dialect === 'sqlite') return builder
  const write = builder as unknown as PgWriteBuilder
  const plain = Object.getPrototypeOf(write).getSQL as (this: PgWriteBuilder) => SQL
  Object.defineProperty(write, 'getSQL', {
    configurable: true,
    value: () => captureForm(write, kind.op, sources) ?? plain.call(write),
  })
  return builder
}

// ---------------------------------------------------------------------------
// The census's reading of rendered SQL
// ---------------------------------------------------------------------------

/** Whether rendered Postgres SQL is a capture form. */
export const isCaptureForm = (text: string): boolean =>
  text.startsWith(`with ${OLD_CTE} as (`) || text.startsWith(`with ${WRITE_CTE} as (`)

/** One INSERT, UPDATE or DELETE a rendered statement makes, outside any capture form. */
export interface RenderedWrite {
  readonly op: WriteOp
  readonly table: string
  /** For an update: the columns its SET assigns. */
  readonly setColumns?: readonly string[]
  /** For an insert: whether it is an upsert (ON CONFLICT … DO UPDATE). */
  readonly upsert?: boolean
}

/** The columns `update "t" set "a" = …, "b" = …` assigns, read at the top nesting level. */
function renderedSetColumns(text: string, from: number): string[] {
  const out: string[] = []
  let depth = 0
  let inString = false
  let expectColumn = true
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === "'") inString = false
      continue
    }
    if (char === "'") inString = true
    else if (char === '(') depth++
    else if (char === ')') {
      if (depth === 0) break
      depth--
    } else if (depth === 0) {
      if (char === ',') expectColumn = true
      else if (expectColumn && char === '"') {
        const end = text.indexOf('"', i + 1)
        out.push(text.slice(i + 1, end))
        expectColumn = false
        i = end
      } else if (/^ (where|returning|from) /i.test(text.slice(i, i + 12))) break
    }
  }
  return out
}

/** Every write `text` makes on a server table, with its SET columns for an update. */
export function renderedWrites(text: string): RenderedWrite[] {
  const out: RenderedWrite[] = []
  for (const match of text.matchAll(/\b(insert\s+into|update|delete\s+from)\s+"([^"]+)"/gi)) {
    const verb = (match[1] as string).toLowerCase()
    const table = match[2] as string
    if (!SQLITE_TABLES.has(table)) continue
    if (verb === 'update') {
      const at = text.indexOf(' set ', match.index)
      out.push({
        op: 'u',
        table,
        setColumns: at < 0 ? undefined : renderedSetColumns(text, at + 5),
      })
    } else if (verb.startsWith('insert')) {
      const next = text
        .slice(match.index + match[0].length)
        .search(/\b(insert\s+into|update|delete\s+from)\s+"/i)
      const own =
        next < 0
          ? text.slice(match.index)
          : text.slice(match.index, match.index + match[0].length + next)
      out.push({ op: 'i', table, upsert: / on conflict .* do update set /i.test(own) })
    } else out.push({ op: 'd', table })
  }
  return out
}

/**
 * The writes in rendered Postgres SQL that should have been capture forms: every
 * INSERT, UPDATE or DELETE on a table where {@link captureNeeded} says the write can
 * capture, in a statement that is not a capture form. Empty for a capture form.
 */
export function uncapturedWrites(
  text: string,
  sources: RecordSources = RECORD_SOURCES,
): RenderedWrite[] {
  if (isCaptureForm(text)) return []
  return renderedWrites(text).filter(
    (write) =>
      captureNeeded(write.table, write.op, write.setColumns, sources) ||
      (write.upsert === true && captureNeeded(write.table, 'u', undefined, sources)),
  )
}
