/**
 * asks_user in the Postgres write statement (POD-7123).
 *
 * Session writes assign it from their proposed values, before RETURNING/capture.
 * Satellite writes update the affected sessions in a sibling CTE. Sibling CTEs see
 * the old snapshot, so their reads overlay RETURNING on it, removing old keys first.
 * There is no second UPDATE of a session already written by the statement (Postgres
 * does not support that), no extra statement, and no read/repair after the write.
 */
import { PG_RULE_SQL } from '@podium/sync/collections'
import {
  type Column,
  getTableColumns,
  getTableName,
  is,
  Name,
  Param,
  SQL,
  StringChunk,
  sql,
} from 'drizzle-orm'
import {
  ASKING_INPUTS,
  askingNeeded,
  askingRef,
  askingSelect,
} from '../migrations/session-asks-user'
import type { PgWriteBuilder, RenderedWrite } from './capture-pg'

const q = (name: string) => `"${name}"`
const WRITE = '"__capture_w"'
const OLD = '"__capture_old"'
const VALUES = '"__asks_values"'
export const ASKING_UPDATE_CTE = '"__asks_update"'

/** The session values the derivation reads, with types for parameter-only projections. */
const SESSION_VALUES = {
  workspace_id: 'text COLLATE "C"',
  id: 'text COLLATE "C"',
  deleted_at: 'timestamptz',
  archived: 'boolean',
  last_input_at: 'timestamptz',
  agent_state_json: 'json',
} as const

/** Scalar boolean over the proposed values, preserving their original bound encoders. */
function sessionValue(
  builder: PgWriteBuilder,
  values: Record<string, unknown>,
  insert: boolean,
): SQL {
  const columns = Object.entries(getTableColumns(builder.config.table) as Record<string, Column>)
  const projection = Object.entries(SESSION_VALUES).map(([name, type]) => {
    const found = columns.find(([, column]) => column.name === name)
    if (found === undefined) throw new Error(`asks_user: sessions has no ${name}`)
    const [key, column] = found
    let value = values[key]
    if (value === undefined || (is(value, Param) && value.value === undefined)) {
      value = insert ? (column.default ?? sql.raw('NULL')) : column
    }
    return sql`${value}::${sql.raw(type)} as ${sql.identifier(name)}`
  })
  const from = sql`(select ${sql.join(projection, sql`, `)}) AS r`
  return sql`(select asks from (${askingSelect(PG_RULE_SQL, from)}) AS __asks_value)`
}

/**
 * Drizzle builds an upsert's SET as a SQL tree before captureWrite is called. Read
 * those assignments without rendering/reparsing SQL or losing parameter encoders.
 * Refuse an unknown AST shape, so a Drizzle upgrade cannot silently skip maintenance.
 */
interface ConflictSet {
  readonly set: Record<string, unknown>
  readonly replace: (set: Record<string, unknown>) => SQL
}

function conflictSet(builder: PgWriteBuilder): ConflictSet | undefined {
  const conflict = builder.config.onConflict
  if (conflict === undefined) return undefined
  const chunks = conflict.queryChunks
  const at = chunks.findIndex(
    (chunk) => is(chunk, StringChunk) && chunk.value.join('') === ' do update set ',
  )
  if (at < 0) {
    if (builder.dialect.sqlToQuery(conflict).sql.includes(' do update set ')) {
      throw new Error('asks_user: unsupported upsert conflict tree')
    }
    return undefined
  }
  const assignments = chunks[at + 1]
  if (!is(assignments, SQL)) throw new Error('asks_user: unsupported upsert SET tree')
  const columns = Object.entries(getTableColumns(builder.config.table) as Record<string, Column>)
  const set: Record<string, unknown> = {}
  for (const assignment of assignments.queryChunks) {
    if (!is(assignment, SQL)) throw new Error('asks_user: unsupported upsert assignment')
    if (builder.dialect.sqlToQuery(assignment).sql === ', ') continue
    const parts = assignment.queryChunks
    const name = parts[1]
    const equal = parts[2]
    if (!is(name, Name) || !is(equal, StringChunk) || equal.value.join('') !== ' = ') {
      throw new Error('asks_user: unsupported upsert assignment tree')
    }
    const key = columns.find(([, column]) => column.name === name.value)?.[0]
    if (key === undefined) throw new Error(`asks_user: unknown session column ${name.value}`)
    set[key] = parts[3]
  }
  return {
    set,
    replace: (next) =>
      new SQL(
        chunks.map((chunk) =>
          chunk === assignments
            ? builder.dialect.buildUpdateSet(builder.config.table, next)
            : chunk,
        ),
      ),
  }
}

/** A view of a session builder with its derived value folded into VALUES and SET. */
export function askingSessionView(builder: PgWriteBuilder, op: 'i' | 'u' | 'd'): PgWriteBuilder {
  if (getTableName(builder.config.table) !== 'sessions' || op === 'd') return builder
  const config = { ...builder.config }
  if (op === 'u') {
    const set = config.set ?? {}
    const columns = getTableColumns(config.table) as Record<string, Column>
    if (
      !askingNeeded(
        'sessions',
        'u',
        Object.keys(set).map((key) => columns[key]!.name),
      )
    )
      return builder
    config.set = { ...set, asksUser: sessionValue(builder, set, false) }
  } else {
    if (config.select || !Array.isArray(config.values)) {
      throw new Error('asks_user: session INSERT SELECT needs a proposed-value relation')
    }
    config.values = (config.values as Record<string, unknown>[]).map((values) => ({
      ...values,
      asksUser: sessionValue(builder, values, true),
    }))
    const conflict = conflictSet(builder)
    if (conflict !== undefined) {
      const columns = getTableColumns(config.table) as Record<string, Column>
      if (
        askingNeeded(
          'sessions',
          'u',
          Object.keys(conflict.set).map((key) => columns[key]!.name),
        )
      ) {
        config.onConflict = conflict.replace({
          ...conflict.set,
          asksUser: sessionValue(builder, conflict.set, false),
        })
      }
    }
  }
  return Object.assign(Object.create(builder) as PgWriteBuilder, { config })
}

/**
 * The satellite's post-write relation, scoped by each lookup in askingSelect. An
 * UPDATE can move its key, so remove the OLD key and add the NEW one. An ignored
 * insert returns no rows and consequently changes neither the image nor any flag.
 */
function satelliteImage(table: string, op: 'i' | 'u' | 'd'): string {
  const input = ASKING_INPUTS.find((input) => input.table === table)
  if (input === undefined || table === 'sessions')
    throw new Error(`asks_user: not a satellite: ${table}`)
  const columns = ['workspace_id', ...input.columns]
  const removed = op === 'u' ? OLD : WRITE
  const prefix = op === 'u' ? '__capture_o_' : ''
  const before = `select ${columns.map((column) => `b.${q(column)}`).join(', ')} from ${q(table)} AS b
    where NOT EXISTS (select 1 from ${removed} AS x
      where x.${q(`${prefix}workspace_id`)} = b.workspace_id
        AND x.${q(`${prefix}session_id`)} = b.session_id)`
  return `(${before}${op === 'd' ? '' : ` UNION ALL select ${columns.map(q).join(', ')} from ${WRITE}`})`
}

/** The extra CTEs of a satellite write, still in the original statement. */
export function askingSatelliteCtes(
  table: string,
  op: 'i' | 'u' | 'd',
  setColumns?: readonly string[],
): SQL {
  if (table === 'sessions' || !askingNeeded(table, op, setColumns)) return sql``
  const old =
    op === 'u'
      ? ` UNION ALL select "__capture_o_workspace_id", "__capture_o_session_id" from ${OLD}`
      : ''
  const targets = `select workspace_id, session_id from ${WRITE}${old}`
  const relation = (name: string) => (name === table ? satelliteImage(table, op) : q(name))
  // The written rows carry the workspace, including when a raw corpus builder has
  // no workspace placeholder to bind. Join on BOTH key columns, never session id alone.
  // OLD and NEW can name the same session: both compute the identical post-write
  // value, so UPDATE FROM may pick either, without a sort to de-duplicate keys.
  const from = sql.raw(`"sessions" AS r inner join (${targets}) AS affected
    on r.workspace_id = affected.workspace_id and r.id = affected.session_id`)
  const values = askingSelect(PG_RULE_SQL, from, askingRef('r'), relation)
  // MATERIALIZED, so the value is computed for the affected sessions only (POD-7587).
  // Inlined, the planner may turn the UPDATE's `IS DISTINCT FROM` into a join filter on
  // `sessions` joined to itself, evaluating the value (a lookup in every input) for every
  // session before the join to the written rows narrows it: it does so whenever its row
  // estimates are low, as they are in a transaction that grew the tables, and the
  // statement then costs the table size times the lookups.
  return sql`, ${sql.raw(VALUES)} as materialized (${values}), ${sql.raw(ASKING_UPDATE_CTE)} as (
    update "sessions" set "asks_user" = ${sql.raw(VALUES)}.asks from ${sql.raw(VALUES)}
      where "sessions".workspace_id = ${sql.raw(VALUES)}.workspace_id
        and "sessions".id = ${sql.raw(VALUES)}.session_id
        and "sessions".asks_user IS DISTINCT FROM ${sql.raw(VALUES)}.asks)`
}

/** Writes a census must refuse: a trigger input without its in-statement maintenance. */
export function unmaintainedAskingWrites(
  text: string,
  writes: readonly RenderedWrite[],
): RenderedWrite[] {
  return writes.filter((write) => {
    if (!askingNeeded(write.table, write.op, write.setColumns)) return false
    if (write.table === 'sessions') {
      return !text.includes('__asks_value') || !text.includes('"asks_user"')
    }
    return !text.includes(`${ASKING_UPDATE_CTE} as (`)
  })
}
