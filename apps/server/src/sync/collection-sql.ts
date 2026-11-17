/**
 * COLLECTION RULES OVER THE SERVER'S TABLES (POD-7084, design POD-7059).
 *
 * A collection rule reads a record's saved fields. Here each such field of
 * the record types with rules over many records (sessions, issues) is mapped
 * to the SQL that reads the value the record CARRIES, as its builder
 * (`record-builders.ts`) computes it, not merely the column of the same name:
 *
 *  - a session's `offer` is its `offers` row, dropped when the session's saved
 *    last input is newer than the offer (the boot install's staleness rule,
 *    `SessionRecords.fromRows`);
 *  - a session's `agentState` is its runtime turn state when one is recorded,
 *    else its observation checkpoint's turn state, else the row's
 *    `agent_state_json` (the order `SessionRecords.fromRows` applies them);
 *  - a session's `lastActiveAt` is the published activity time, which the
 *    synced record carries;
 *  - a deleted session has no record.
 *
 * The SQL is the same on SQLite and Postgres (`@podium/sync/collections`).
 * `collection-sql.test.ts` holds it to the builder: on rows written through
 * the store, every declared rule answers in SQL exactly what it answers in
 * JavaScript over the built records, on both engines.
 *
 * Not yet a repository query: the fetch route (POD-7085) runs these through
 * the store's prepared families. Where the builder drops a JSON value that is
 * an object but fails its schema, this reads it as present.
 */

import type { RuleArgs, Where } from '@podium/model'
import {
  type FieldSql,
  jsonObjectMemberSql,
  jsonObjectSql,
  jsonTextPath,
  type RuleSql,
  type RuleSqlTarget,
  ruleSql,
  type SqlDialect,
} from '@podium/sync/collections'
import { getTableName } from 'drizzle-orm'
import {
  issues,
  offers,
  runtimeEventCheckpoints,
  sessionObservationCheckpoints,
  sessions,
} from '../migrations/schema'

/** The record types whose collections the server answers in SQL. */
export type CollectionKind = 'session' | 'issueProjection'

const ROW = 'r'
const col = (column: { name: string }) => `${ROW}.${column.name}`

/** A session's agent state as its record carries it: JSON text, or NULL. */
function sessionAgentState(dialect: SqlDialect): string {
  const runtime = `(SELECT ${jsonObjectSql(dialect, `rt.${runtimeEventCheckpoints.turnStateJson.name}`)} FROM ${getTableName(runtimeEventCheckpoints)} AS rt WHERE rt.${runtimeEventCheckpoints.sessionId.name} = ${col(sessions.id)})`
  const checkpoint = `(SELECT ${jsonObjectMemberSql(dialect, `oc.${sessionObservationCheckpoints.checkpointJson.name}`, 'turnState')} FROM ${getTableName(sessionObservationCheckpoints)} AS oc WHERE oc.${sessionObservationCheckpoints.sessionId.name} = ${col(sessions.id)})`
  return `coalesce(${runtime}, ${checkpoint}, ${jsonObjectSql(dialect, col(sessions.agentStateJson))})`
}

/** A session's offer as its record carries it: the offer's time, or NULL. */
const sessionOffer = (): string =>
  `(SELECT o.${offers.createdAt.name} FROM ${getTableName(offers)} AS o WHERE o.${offers.sessionId.name} = ${col(sessions.id)} AND (${col(sessions.lastInputAt)} IS NULL OR NOT (${col(sessions.lastInputAt)} > o.${offers.createdAt.name})))`

type Fields = Readonly<Record<string, (dialect: SqlDialect) => FieldSql>>

const plain =
  (column: { name: string }, type: FieldSql['type'] = 'text') =>
  (): FieldSql => ({ sql: col(column), type })

const SESSION_FIELDS: Fields = {
  sessionId: plain(sessions.id),
  status: plain(sessions.status),
  archived: plain(sessions.archived, 'boolean'),
  issueId: plain(sessions.issueId),
  agentKind: plain(sessions.agentKind),
  headless: plain(sessions.headless, 'boolean'),
  lastActiveAt: plain(sessions.publishedLastActiveAt),
  offer: () => ({ sql: sessionOffer(), type: 'text' }),
  agentState: (dialect) => ({ sql: sessionAgentState(dialect), type: 'json' }),
}

const ISSUE_FIELDS: Fields = {
  id: plain(issues.id),
  repoId: plain(issues.repoId),
  seq: plain(issues.seq, 'number'),
  parentId: plain(issues.parentId),
  stage: plain(issues.stage),
  closedReason: plain(issues.closedReason),
  archived: plain(issues.archived, 'boolean'),
  deletedAt: plain(issues.deletedAt),
  isDraftVessel: plain(issues.draft, 'boolean'),
  audience: plain(issues.audience),
  updatedAt: plain(issues.updatedAt),
}

interface CollectionTable {
  readonly table: string
  readonly key: { name: string }
  readonly fields: Fields
  readonly parent?: { name: string }
  /** What every record of the type satisfies, whatever the rule. */
  readonly base?: string
}

const TABLES: Readonly<Record<CollectionKind, CollectionTable>> = {
  session: {
    table: getTableName(sessions),
    key: sessions.id,
    fields: SESSION_FIELDS,
    base: `${col(sessions.deletedAt)} IS NULL`,
  },
  issueProjection: {
    table: getTableName(issues),
    key: issues.id,
    fields: ISSUE_FIELDS,
    parent: issues.parentId,
  },
}

/** The fields of `kind` a rule may read in SQL. */
export const collectionFields = (kind: CollectionKind): readonly string[] =>
  Object.keys(TABLES[kind].fields)

/** How a rule over `kind` reads the server's tables. */
export function collectionTarget(kind: CollectionKind, dialect: SqlDialect): RuleSqlTarget {
  const { table, key, fields, parent } = TABLES[kind]
  return {
    dialect,
    table,
    idColumn: key.name,
    rowId: col(key),
    ...(parent === undefined ? {} : { parentColumn: parent.name }),
    field(path) {
      const name = Object.keys(fields).find(
        (field) => path === field || path.startsWith(`${field}.`),
      )
      if (name === undefined) return undefined
      const field = fields[name]!(dialect)
      if (name === path) return field
      return {
        sql: jsonTextPath(dialect, field.sql, path.slice(name.length + 1).split('.')),
        type: 'text',
      }
    },
  }
}

/** The ids of the records of `kind` the rule selects, as one statement. */
export function collectionQuery(
  kind: CollectionKind,
  where: Where,
  args: RuleArgs,
  now: number,
  dialect: SqlDialect,
): RuleSql {
  const { table, key, base } = TABLES[kind]
  const rule = ruleSql(where, collectionTarget(kind, dialect), args, now)
  return {
    sql: `SELECT ${col(key)} AS id FROM ${table} AS ${ROW} WHERE ${base === undefined ? '' : `${base} AND `}${rule.sql}`,
    params: rule.params,
  }
}
