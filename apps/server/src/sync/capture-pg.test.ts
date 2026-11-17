/**
 * CHANGE CAPTURE ON POSTGRES (POD-6982, POD-6958 design 2.5).
 *
 * Database-free, on every leg:
 *  - the capture plan covers every source table and every ON DELETE action that reaches
 *    one, and reads each column as its Postgres twin stores it;
 *  - every row filter and derived value written in SQLite-only SQL has a Postgres form;
 *  - `captureWrite` leaves a SQLite write as it is and renders the forms on Postgres.
 *    The write census over every definition is `capture-census.test.ts`.
 *
 * On the Postgres leg (`server-store-pg`), THE CROSS-ENGINE CORPUS: a store is built on
 * SQLite through the server's own paths, its rows are copied into a fresh Postgres
 * database, the oracle's triggers (`test-support/capture-oracle.ts`) are installed there,
 * and the same writes run on both: every column of the first rows of every source
 * table changed, set to NULL and set to another row's value; an update that changes
 * nothing; a delete (with its cascades); a delete and the same row inserted again; an
 * upsert onto the existing row; a JSON document whose keys only move. Each runs in a
 * transaction that is rolled back. For each write the Postgres capture must equal
 * SQLite's triggers' capture and the oracle's, row for row. Also there: the two-workspace
 * guarantee (a row of another workspace is refused by the drain), a commit that leaves
 * capture rows undrained fails, and the forms' result shapes.
 */

import {
  asWorkspaceId,
  FEED_EVENT_KINDS,
  firstAdminMemberId,
  type IssueId,
  primeFirstAdminMember,
  type SessionId,
} from '@podium/model'
import type { CapturedRow } from '@podium/sync'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import { and, type Column, eq, getTableColumns, getTableName, is, sql, Table } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { getTableConfig, SQLiteDialect, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { drizzle as sqliteProxy } from 'drizzle-orm/sqlite-proxy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as pgSchema from '../migrations/pg/schema'
import * as schema from '../migrations/schema'
import { SYSTEM_EFFECT_KINDS_OFF_FEED } from '../modules/effects/published-input'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { SessionStore } from '../store'
import { GUARD_TEXTS } from '../store/append-only'
import { RUNTIME_EVENT_LOG_KIND } from '../store/events'
import { bindingFor } from '../store/executor/binding'
import type { DriverSession, QueryClient } from '../store/executor/driver'
import { type RootStoreExecutor, workspaceContext } from '../store/executor/executor'
import { createPgStoreExecutor } from '../store/executor/pg-driver'
import { buildPgStoreDrizzle } from '../store/executor/pg-drizzle'
import type { StoreDrizzle } from '../store/executor/sync-drizzle'
import {
  CaptureOracleDifference,
  captureDifference,
  capturedRows,
  checkAgainstOracle,
  oracleStatements,
  READ_CAPTURE_ROWS,
  type StoredCaptureRow,
  TAKE_ORACLE_ROWS,
} from '../test-support/capture-oracle'
import {
  clonePgTestDatabase,
  connectPgTest,
  testStoreEngine,
} from '../test-support/pg-test-database'
import { useRealMigrationChain } from '../test-support/pre-migrated-store'
import {
  captureNeeded,
  captureTable,
  captureWrite,
  cascadesReachingSources,
  isCaptureForm,
  pgDerivedOf,
  pgRowsOf,
  sourcesByTable,
  uncapturedWrites,
} from './capture-pg'
import { installChangeCapture } from './capture-triggers'
import { assertCapturedInWorkspace, ForeignCaptureError } from './record-source'

const ENGINE = testStoreEngine()

/** The store's Postgres table set: the server schema's twins and the sync tables' twins. */
const PG_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })
const SQLITE_TABLES = bindingFor('sqlite')

/** Each server table's export name, by its SQL name. */
const EXPORT_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(SQLITE_TABLES).flatMap(([key, value]) =>
    is(value, Table) ? [[getTableName(value as Table), key] as const] : [],
  ),
)

const pgTableNamed = (name: string): PgTable => {
  const table = (PG_TABLES as Record<string, unknown>)[EXPORT_OF.get(name) ?? '']
  if (!is(table, PgTable)) throw new Error(`no Postgres twin of ${name}`)
  return table
}

/** A Postgres drizzle instance over the twins whose client refuses to run anything. */
function pgRecordingDrizzle(): StoreDrizzle {
  const refuse = (): never => {
    throw new Error('this drizzle instance builds queries; it never runs them')
  }
  const client: QueryClient = {
    run: refuse,
    get: refuse,
    all: refuse,
    writeGet: refuse,
    writeAll: refuse,
    batch: refuse,
  }
  return buildPgStoreDrizzle(client, PG_TABLES)
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('the capture plan', () => {
  it('covers every source table and every ON DELETE action that reaches one', () => {
    const tables = [...sourcesByTable().keys()]
    expect(tables.length).toBeGreaterThan(40)
    for (const table of tables)
      expect(captureTable(table).primaryKey.length, table).toBeGreaterThan(0)
    // The list design 2.5 asks for. A new cascade onto a source table changes it here,
    // and the delete form of its parent captures it with no further code.
    expect(
      cascadesReachingSources()
        .map((edge) => `${edge.parent} -> ${edge.child}(${edge.columns.join(', ')}) ${edge.action}`)
        .sort(),
    ).toEqual([
      'automations -> automation_runs(workspace_id, automation_id) cascade',
      'issues -> issue_deps(workspace_id, from_id) cascade',
      'issues -> issue_deps(workspace_id, to_id) cascade',
      'issues -> issue_git_states(workspace_id, issue_id) cascade',
      'issues -> issue_labels(workspace_id, issue_id) cascade',
      'issues -> issue_panel_artifacts(workspace_id, issue_id) cascade',
      'issues -> issue_panel_deferred(workspace_id, issue_id) cascade',
      'issues -> issue_panel_states(workspace_id, id) cascade',
      'issues -> issue_panel_todos(workspace_id, issue_id) cascade',
      // Composite keys that clear their reference alone (POD-7024, CLEARED_ON_DELETE).
      'issues -> issues(workspace_id, duplicate_of) set null',
      'issues -> issues(workspace_id, parent_id) set null',
      'issues -> issues(workspace_id, superseded_by) set null',
      'labels -> issue_labels(workspace_id, label_id) cascade',
      'workflow_runs -> workflow_run_steps(workspace_id, run_id) cascade',
      'workflow_runs -> workflow_runs(workspace_id, supersedes_run_id) set null',
      'workflows -> workflow_revisions(workspace_id, workflow_id) cascade',
    ])
  })

  it('reads each column as its Postgres twin stores it', () => {
    const wrong: string[] = []
    const tables = new Set([
      ...sourcesByTable().keys(),
      ...cascadesReachingSources().map((edge) => edge.child),
    ])
    for (const name of tables) {
      const twin = Object.values(getTableColumns(pgTableNamed(name)) as Record<string, Column>)
      const classes = captureTable(name).classes
      for (const column of twin) {
        const type = column.getSQLType()
        const expected = type.startsWith('timestamp')
          ? 'timestamp'
          : type === 'json' || type === 'jsonb'
            ? 'json'
            : type === 'boolean'
              ? 'boolean'
              : 'plain'
        if (classes.get(column.name) !== expected) {
          wrong.push(`${name}.${column.name}: ${type}, read as ${classes.get(column.name)}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('has a Postgres form of every row filter and derived value written in SQLite-only SQL', () => {
    // What Postgres does not take, or takes with another meaning: SQLite's JSON
    // functions, its group_concat, `IS` against a value, and a boolean column compared
    // with an integer.
    const sqliteOnly =
      /json_(valid|extract|each|remove|group_array|array|set)\b|group_concat|\bIS '|\bIS NOT '|= [01]\b/
    const missing: string[] = []
    for (const [table, list] of sourcesByTable()) {
      for (const { kind, index, source } of list) {
        const rows = pgRowsOf(source)
        if (rows !== undefined && sqliteOnly.test(rows))
          missing.push(`${kind}[${index}] on ${table}: rows`)
        for (const value of pgDerivedOf(source)) {
          if (sqliteOnly.test(value))
            missing.push(`${kind}[${index}] on ${table}: derived ${value}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The forms, rendered
// ---------------------------------------------------------------------------

/** A column of `table` that no source on it reads, so an update of it captures nothing. */
function unreadColumn(table: string): Column {
  const columns = Object.values(getTableColumns(pgTableNamed(table)) as Record<string, Column>)
  const found = columns.find((column) => !captureNeeded(table, 'u', [column.name]))
  if (found === undefined) throw new Error(`every column of ${table} is read`)
  return found
}

describe('captureWrite', () => {
  it('leaves a SQLite write as it is: the triggers capture there', () => {
    const db = sqliteProxy(async () => ({ rows: [] }))
    const plain = db
      .update(schema.issues)
      .set({ title: 'x' })
      .where(eq(schema.issues.id, 'iss_1' as IssueId))
      .toSQL()
    const wrapped = captureWrite(
      db
        .update(schema.issues)
        .set({ title: 'x' })
        .where(eq(schema.issues.id, 'iss_1' as IssueId)),
    ).toSQL()
    expect(wrapped).toEqual(plain)
  })

  it('renders an update, an insert, an upsert and a delete as capture forms on Postgres', () => {
    const db = pgRecordingDrizzle()
    const t = PG_TABLES as unknown as typeof SQLITE_TABLES
    const update = captureWrite(
      db
        .update(t.issues)
        .set({ title: 'x' })
        .where(eq(t.issues.id, 'iss_1' as IssueId)),
    ).toSQL().sql
    expect(update).toMatch(
      /^with "__capture_old" as \(select .* from "issues" where .* for update\), "__capture_w" as \(update "issues" set "title" = \$2 from "__capture_old" where "issues"."workspace_id" = "__capture_old"."__capture_o_workspace_id" and "issues"."id" = "__capture_old"."__capture_o_id" returning /,
    )
    expect(update).toContain(
      ', "__capture_c" as (insert into "sync_capture" ("kind", "source", "op", "old_key", "new_key") select ',
    )
    expect(update).toContain(
      '"__capture_w"."__capture_o_title" IS DISTINCT FROM "__capture_w"."title"',
    )
    // A json column compares as its text (design 2.3 rule 11).
    expect(update).toContain(
      'CAST("__capture_w"."__capture_o_blocked_by" AS TEXT) IS DISTINCT FROM CAST("__capture_w"."blocked_by" AS TEXT)',
    )
    expect(update.endsWith(' select 1 from "__capture_w"')).toBe(true)

    const insert = captureWrite(
      db
        .insert(t.userLayout)
        .values({ workspaceId: 'w', userId: 'u', key: 'k', value: '{}' } as never)
        .returning({ key: t.userLayout.key }),
    ).toSQL().sql
    expect(insert).toMatch(
      /^with "__capture_w" as \(insert into "user_layout" .* returning "user_layout"\."user_id", /,
    )
    expect(insert).toContain(
      `select 'userLayout'::text, 0::bigint, 'i'::text, NULL::text, json_build_array("__capture_w"."workspace_id", "__capture_w"."user_id", "__capture_w"."key")::text from "__capture_w" where true`,
    )
    expect(insert.endsWith(' select "key" from "__capture_w"')).toBe(true)

    const upsert = captureWrite(
      db
        .insert(t.userLayout)
        .values({ workspaceId: 'w', userId: 'u', key: 'k', value: '{}' } as never)
        .onConflictDoUpdate({
          target: [t.userLayout.workspaceId, t.userLayout.userId, t.userLayout.key],
          set: { value: '{"a":1}' },
        }),
    ).toSQL().sql
    expect(upsert).toContain('left join "user_layout" as "__capture_o" on ')
    expect(upsert).toContain(`'u'::text, json_build_array("__capture_o"."workspace_id"`)

    const remove = captureWrite(
      db.delete(t.issues).where(eq(t.issues.id, 'iss_1' as IssueId)),
    ).toSQL().sql
    expect(remove).toMatch(/^with "__capture_w" as \(delete from "issues" where .* returning /)
    // Its cascades: the children read from the statement's snapshot, captured.
    expect(remove).toContain('"__capture_k0" as (select ')
    expect(remove).toContain(
      `select 'issueProjection'::text, 1::bigint, 'd'::text, json_build_array("__capture_k`,
    )
    // The self-reference excludes the deleted row by its whole key (POD-7024).
    expect(remove).toContain(`not in (select "workspace_id", "id" from "__capture_w")`)
    expect(isCaptureForm(remove)).toBe(true)
  })

  it('keeps a write that captures nothing the plain statement', () => {
    const db = pgRecordingDrizzle()
    const t = PG_TABLES as unknown as typeof SQLITE_TABLES
    const column = unreadColumn('sessions')
    const key = Object.entries(getTableColumns(t.sessions)).find(
      ([, c]) => c.name === column.name,
    )?.[0]
    const plain = db
      .update(t.sessions)
      .set({ [key as string]: null } as never)
      .where(eq(t.sessions.id, 's' as SessionId))
    const expected = plain.toSQL().sql
    expect(captureWrite(plain).toSQL().sql).toBe(expected)
    expect(uncapturedWrites(expected)).toEqual([])
  })

  it('refuses a builder it cannot capture', () => {
    expect(() => captureWrite({} as never)).toThrow(/insert, update or delete builder/)
  })
})

// ---------------------------------------------------------------------------
// The cross-engine corpus (Postgres leg)
// ---------------------------------------------------------------------------

const AT = '2026-11-13T12:00:00.000Z'
const OTHER_WORKSPACE = 'ws_capture_b'
/** Rows each source table holds in the corpus: one per workspace. */
const ROWS_PER_TABLE = 2

/**
 * Rows a table gets: {@link ROWS_PER_TABLE}, one per workspace, except `ship_orders`, which
 * gets two per workspace so a stack edge can join two orders of one workspace.
 */
const rowsOfTable = (name: string): number =>
  name === 'ship_orders' ? 2 * ROWS_PER_TABLE : ROWS_PER_TABLE

/** Values a CHECK constraint lists for a column (`col IN ('a', 'b')`), by table and column. */
function checkedValues(table: SQLiteTable): Map<string, readonly unknown[]> {
  const out = new Map<string, readonly unknown[]>()
  for (const check of getTableConfig(table).checks) {
    const text = new SQLiteDialect().sqlToQuery(check.value).sql
    const list =
      text.match(/^"?([a-z_]+)"? IN \(([^)]*)\)$/i) ??
      text.match(/"?([a-z_]+)"? IS NULL OR "?[a-z_]+"? IN \(([^)]*)\)$/i)
    if (list) {
      out.set(
        list[1] as string,
        [...(list[2] as string).matchAll(/'([^']*)'/g)].map((m) => m[1]),
      )
      continue
    }
    const equal = text.match(/^"?([a-z_]+)"? = '([^']*)'$/)
    if (equal) out.set(equal[1] as string, [equal[2]])
    const floor = text.match(/^"?([a-z_]+)"? (>|>=) (\d+)$/)
    if (floor) out.set(floor[1] as string, [Number(floor[3]) + (floor[2] === '>' ? 1 : 0)])
    const between = text.match(/^"?([a-z_]+)"? BETWEEN (\d+) AND (\d+)$/)
    if (between) out.set(between[1] as string, [Number(between[2])])
  }
  return out
}

/**
 * Per table, what row `i` of the corpus must hold beyond the generated values: rows on
 * both sides of each row filter and derived value the declarations name, and the
 * constraints a generic value cannot meet. Keyed by SQL column name.
 */
function overrides(
  table: string,
  i: number,
  rowOf: (table: string, column: string, at?: number) => unknown,
): Record<string, unknown> {
  const two = <T>(a: T, b: T): T => (i === 0 ? a : b)
  switch (table) {
    case 'machines':
      return {
        credential_kind: 'bearer-hash',
        token_hash: `hash-${i}`,
        public_key: null,
        service_report_json: JSON.stringify({
          server: { observedAt: AT, ok: true },
          agentExecution: { observedAt: AT, state: two('ready', 'busy') },
        }),
        harness_versions_json: JSON.stringify({
          codex: { version: '1.0', lastSeen: AT },
          claude: { version: `2.${i}`, lastSeen: AT },
        }),
        inventory_json: JSON.stringify({
          agents: [
            { kind: 'codex', installed: true, login: { state: two('out', 'in') } },
            { kind: 'claude-code', installed: 1, login: { state: 'out' } },
          ],
        }),
      }
    case 'grants':
      return {
        resource_kind: two('machine', 'repo'),
        verb: two('manage', 'use'),
        custody: i === 0,
        resource_id: rowOf('machines', 'id'),
      }
    case 'meta':
      return two(
        {
          key: 'updates.execution.v1',
          value: JSON.stringify({
            targets: [
              ['stable', { version: '1.2.3' }],
              ['dev', {}],
            ],
          }),
        },
        { key: 'machines.fleet-channel.v1', value: 'stable' },
      )
    case 'user_layout':
      return { key: 'dockTab', updated_at: AT }
    case 'workspace_meta':
      return { key: two('settings', 'other') }
    case 'podium_events':
      return two(
        { kind: FEED_EVENT_KINDS[0], subject: rowOf('issues', 'id'), payload: '{"t":"x"}' },
        {
          kind: RUNTIME_EVENT_LOG_KIND,
          subject: rowOf('sessions', 'id'),
          payload: '{"t":"item"}',
        },
      )
    case 'effects':
      return {
        created_by: two(rowOf('users', 'id'), null),
        kind: two('issue.start', SYSTEM_EFFECT_KINDS_OFF_FEED[0]),
        deleted_at: null,
      }
    case 'sessions':
      return {
        conversation_binding: two('never', 'bound'),
        status: two('running', 'exited'),
        archived: false,
        deleted_at: null,
        created_by_actor_kind: 'user',
        stop_reason: null,
      }
    case 'issues':
      return {
        brief: two('A brief', ''),
        description: two('A description', ''),
        deleted_at: null,
        parent_id: null,
        superseded_by: null,
        duplicate_of: null,
      }
    case 'messages':
      return {
        from_kind: 'operator',
        to_kind: two('session', 'issue'),
        to_id: rowOf('sessions', 'id'),
        actor_kind: 'user',
        actor_id: rowOf('users', 'id'),
        delivery_status: two('confirmed', 'stored'),
      }
    case 'pending_interactions':
      return { status: two('asked', 'answered'), fingerprint: `fp-${i}` }
    case 'session_observation_checkpoints':
    case 'runtime_event_checkpoints':
    case 'offers':
    case 'session_drafts':
    case 'queued_messages':
      return { session_id: rowOf('sessions', 'id') }
    case 'ship_orders':
      // Two orders per workspace (see rowsOfTable): the second of each is cancelled, so the
      // one-active-order-per-issue index holds.
      return {
        state: i < ROWS_PER_TABLE ? 'queued' : 'cancelled',
        hold_code: null,
        requested_by_actor_kind: 'user',
      }
    case 'ship_order_stack_edges':
      // An edge joins two orders of its own workspace: the key is (workspace_id, order) on
      // both sides since the keys migration (POD-7024), so order i stacks on order i + 2.
      return {
        upper_order_id: rowOf('ship_orders', 'id', i),
        lower_order_id: rowOf('ship_orders', 'id', i + ROWS_PER_TABLE),
      }
    case 'ship_holds':
      return { resolved_at: null, resolution: null }
    case 'workflow_runs':
      return { supersedes_run_id: null, status: two('active', 'complete') }
    case 'automation_runs':
    case 'automations':
      return { deleted_at: null }
    default:
      return {}
  }
}

/** A generated value for `column` of row `i`, by its Postgres class. */
function generated(table: string, column: Column, i: number): unknown {
  const cls = captureTable(table).classes.get(column.name)
  if (cls === 'timestamp') return new Date(Date.parse(AT) + i * 1_000).toISOString()
  if (cls === 'json') return JSON.stringify({ n: i, note: `${table} ${i}` })
  if (cls === 'boolean') return i % 2 === 1
  if (
    column.dataType === 'number' ||
    column.columnType.includes('Integer') ||
    column.columnType.includes('Real')
  ) {
    return i + 1
  }
  return `${table}:${column.name}:${i}`
}

/** The source tables and the tables they reference, parents first. */
function corpusTables(): SQLiteTable[] {
  const order: SQLiteTable[] = []
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    const table = SQLITE_TABLES[
      EXPORT_OF.get(name) as keyof typeof SQLITE_TABLES
    ] as unknown as SQLiteTable
    for (const key of getTableConfig(table).foreignKeys) {
      const parent = getTableName(key.reference().foreignTable)
      if (parent !== name) visit(parent)
    }
    order.push(table)
  }
  // The tables an override reads a first row of, before the rest.
  for (const name of ['users', 'machines', 'sessions', 'issues']) visit(name)
  for (const name of [...sourcesByTable().keys()].sort()) visit(name)
  return order
}

/**
 * A SQLite store holding {@link ROWS_PER_TABLE} rows of every source table: what boot
 * wrote, then generated rows (parents first, each foreign key pointing at a parent row,
 * each CHECK met, the second row in another workspace) with {@link overrides} for the
 * row filters. Written before the capture triggers are installed. On the Postgres leg `openTestStore`
 * opens Postgres, so this opens SQLite itself, as `openTestStore` does.
 */
async function sqliteCorpus(): Promise<{ store: SessionStore; unseeded: string[] }> {
  const store = await SessionStore.open(
    ':memory:',
    undefined as never,
    {
      changeCapture: 'whenLogAttaches',
      workspace: SELF_HOSTED_WORKSPACE_ID,
    } as never,
  )
  primeFirstAdminMember(await firstAdminMemberId(store))
  await store.database.provisionWorkspace(asWorkspaceId(OTHER_WORKSPACE))
  const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  const rowsOf = new Map<string, Record<string, unknown>[]>()
  const unseeded: string[] = []
  let current = 0
  const rowOf = (table: string, column: string, at = current): unknown => {
    const key = keysByName(
      SQLITE_TABLES[EXPORT_OF.get(table) as keyof typeof SQLITE_TABLES] as unknown as Table,
    ).get(column) as string
    const rows = rowsOf.get(table) ?? []
    return rows[at % Math.max(rows.length, 1)]?.[key] ?? null
  }
  for (const table of corpusTables()) {
    const name = getTableName(table)
    const columns = getTableColumns(table) as Record<string, Column & { hasDefault?: boolean }>
    const references = new Map<string, { parent: string; column: string }>()
    for (const key of getTableConfig(table).foreignKeys) {
      const reference = key.reference()
      reference.columns.forEach((column, at) => {
        references.set(column.name, {
          parent: getTableName(reference.foreignTable),
          column: (reference.foreignColumns[at] as Column).name,
        })
      })
    }
    const checked = checkedValues(table)
    const existing = (await db.select().from(table as never)) as Record<string, unknown>[]
    for (let i = existing.length; i < rowsOfTable(name); i++) {
      current = i
      const extra = overrides(name, i, rowOf)
      const row: Record<string, unknown> = {}
      for (const [key, column] of Object.entries(columns)) {
        const reference = references.get(column.name)
        let value: unknown
        if (column.name in extra) value = extra[column.name]
        else if (column.name === 'workspace_id')
          value = i % 2 === 0 ? SELF_HOSTED_WORKSPACE_ID : OTHER_WORKSPACE
        else if (reference && reference.parent === name) value = null
        else if (reference) {
          const parentKey = keysByName(
            SQLITE_TABLES[
              EXPORT_OF.get(reference.parent) as keyof typeof SQLITE_TABLES
            ] as unknown as Table,
          ).get(reference.column) as string
          const parents = rowsOf.get(reference.parent) ?? []
          value = parents[i % Math.max(parents.length, 1)]?.[parentKey] ?? null
        } else if (checked.has(column.name)) {
          const values = checked.get(column.name) as unknown[]
          value = values[i % values.length]
        } else value = generated(name, column, i)
        row[key] = value
      }
      try {
        await store.transact(async () => {
          await db.insert(table as never).values(row as never)
        })
      } catch (error) {
        const cause = (error as Error & { cause?: Error }).cause ?? (error as Error)
        unseeded.push(`${name}[${i}]: ${String(cause.message).split('\n')[0]}`)
      }
    }
    rowsOf.set(name, (await db.select().from(table as never)) as Record<string, unknown>[])
  }
  // SQLite's own capture from here on: the triggers production runs.
  const executor = (
    store.database as unknown as {
      executor: { exclusive<R>(fn: (session: DriverSession) => Promise<R>): Promise<R> }
    }
  ).executor
  await executor.exclusive(async (session) => await installChangeCapture(session))
  return { store, unseeded }
}

/** One write of the corpus: built on each engine's drizzle and tables. */
interface CorpusWrite {
  readonly label: string
  readonly table: string
  /** The workspace whose transaction runs it; undefined for an install table (global). */
  readonly workspace: string | undefined
  readonly run: (
    db: StoreDrizzle,
    t: Record<string, Table>,
    capture: <B>(b: B) => B,
  ) => Promise<unknown>
}

type Outcome = { readonly refused: string } | { readonly rows: readonly CapturedRow[] }

class Rollback extends Error {}

/** Each table's columns by SQL name, with their TypeScript keys. */
function keysByName(table: Table): Map<string, string> {
  return new Map(
    Object.entries(getTableColumns(table) as Record<string, Column>).map(([key, column]) => [
      column.name,
      key,
    ]),
  )
}

/** A different value for a column holding `value`, as each engine takes it. */
function changed(value: unknown, cls: string): unknown {
  if (value === null || value === undefined) {
    if (cls === 'json') return '{"probe":1}'
    if (cls === 'timestamp') return AT
    if (cls === 'boolean') return true
    return undefined
  }
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value + 1
  if (typeof value !== 'string') return undefined
  if (cls === 'timestamp')
    return value === '' ? AT : new Date(Date.parse(value) + 1_000).toISOString()
  if (cls === 'json') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({ ...(parsed as object), probe: 1 })
      }
    } catch {
      // stored text that is not JSON: not on Postgres
    }
    return '{"probe":1}'
  }
  return `${value}~`
}

/** The same JSON object with its keys in reverse order, or undefined when that is no change. */
function reordered(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const keys = Object.keys(parsed)
    if (keys.length < 2) return undefined
    return JSON.stringify(
      Object.fromEntries(
        keys.reverse().map((key) => [key, (parsed as Record<string, unknown>)[key]]),
      ),
    )
  } catch {
    return undefined
  }
}

/** The corpus writes on the first `perTable` rows of every source table. */
async function corpusWrites(store: SessionStore, perTable: number): Promise<CorpusWrite[]> {
  const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  const out: CorpusWrite[] = []
  for (const name of [...sourcesByTable().keys()].sort()) {
    const sqliteTable = SQLITE_TABLES[
      EXPORT_OF.get(name) as keyof typeof SQLITE_TABLES
    ] as unknown as Table
    const exportName = EXPORT_OF.get(name) as string
    const info = captureTable(name)
    const keyOf = keysByName(sqliteTable)
    const all = (await db.select().from(sqliteTable as never)) as Record<string, unknown>[]
    const rows = all.slice(0, perTable)
    const workspaceOf = (row: Record<string, unknown>) =>
      keyOf.has('workspace_id') ? String(row.workspaceId) : undefined
    const where = (t: Record<string, Table>, row: Record<string, unknown>) => {
      const table = t[exportName] as unknown as Record<string, Column>
      return and(
        ...info.primaryKey.map((column) =>
          eq(table[keyOf.get(column) as string] as Column, row[keyOf.get(column) as string]),
        ),
      )
    }
    const at = (row: Record<string, unknown>) =>
      info.primaryKey.map((c) => String(row[keyOf.get(c) as string])).join('/')
    for (const row of rows) {
      const tag = `${name}[${at(row)}]`
      const workspace = workspaceOf(row)
      const update = (label: string, set: Record<string, unknown>) =>
        out.push({
          label: `${tag} ${label}`,
          table: name,
          workspace,
          run: async (d, t, capture) =>
            await capture(
              d
                .update(t[exportName] as never)
                .set(set as never)
                .where(where(t, row)),
            ),
        })
      for (const column of info.columns) {
        const key = keyOf.get(column) as string
        const cls = info.classes.get(column) as string
        const value = row[key]
        const next = changed(value, cls)
        if (next !== undefined) update(`${column} changed`, { [key]: next })
        const nullable = !(getTableColumns(sqliteTable) as Record<string, Column>)[key]?.notNull
        if (nullable && value !== null) update(`${column} to NULL`, { [key]: null })
        const other = all.find((candidate) => candidate[key] !== value && candidate[key] !== null)
        if (other !== undefined && cls === 'plain' && !info.primaryKey.includes(column)) {
          update(`${column} as another row's`, { [key]: other[key] })
        }
        const moved = cls === 'json' ? reordered(value) : undefined
        if (moved !== undefined) update(`${column} keys reordered`, { [key]: moved })
      }
      const same = info.columns.find((column) => !info.primaryKey.includes(column)) as string
      update('unchanged', { [keyOf.get(same) as string]: row[keyOf.get(same) as string] })
      out.push({
        label: `${tag} delete`,
        table: name,
        workspace,
        run: async (d, t, capture) =>
          await capture(d.delete(t[exportName] as never).where(where(t, row))),
      })
      out.push({
        label: `${tag} delete and insert again`,
        table: name,
        workspace,
        run: async (d, t, capture) => {
          await capture(d.delete(t[exportName] as never).where(where(t, row)))
          await capture(d.insert(t[exportName] as never).values(row as never))
        },
      })
      const watched = info.columns.find(
        (column) =>
          !info.primaryKey.includes(column) &&
          changed(row[keyOf.get(column) as string], info.classes.get(column) as string) !==
            undefined,
      )
      if (watched !== undefined) {
        const key = keyOf.get(watched) as string
        out.push({
          label: `${tag} upsert onto itself, ${watched} changed`,
          table: name,
          workspace,
          run: async (d, t, capture) => {
            const table = t[exportName] as unknown as Record<string, Column>
            await capture(
              d
                .insert(t[exportName] as never)
                .values({
                  ...row,
                  [key]: changed(row[key], info.classes.get(watched) as string),
                } as never)
                .onConflictDoUpdate({
                  target: info.primaryKey.map(
                    (column) => table[keyOf.get(column) as string] as Column,
                  ) as never,
                  set: { [key]: changed(row[key], info.classes.get(watched) as string) } as never,
                }),
            )
          },
        })
      }
    }
  }
  return out
}

/** A write's outcome on SQLite: the triggers' capture rows, read before the rollback. */
async function onSqlite(store: SessionStore, write: CorpusWrite): Promise<Outcome> {
  const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  let outcome: Outcome | undefined
  try {
    await store.transact(async () => {
      try {
        await write.run(db, SQLITE_TABLES as unknown as Record<string, Table>, (b) => b)
      } catch (error) {
        outcome = { refused: refusal(error) }
        throw new Rollback()
      }
      outcome = {
        rows: capturedRows((await db.all(sql.raw(READ_CAPTURE_ROWS))) as StoredCaptureRow[]),
      }
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return outcome as Outcome
}

/** A write's outcome on Postgres: its capture forms' rows, held against the oracle's. */
async function onPostgres(
  executor: RootStoreExecutor<QueryClient>,
  write: CorpusWrite,
  differences: string[],
): Promise<Outcome> {
  const db = executor.queries.rootDb
  let outcome: Outcome | undefined
  const context =
    write.workspace === undefined ? undefined : workspaceContext(asWorkspaceId(write.workspace))
  try {
    await executor.transact(async () => {
      try {
        await write.run(db, PG_TABLES as unknown as Record<string, Table>, (b) => captureWrite(b))
      } catch (error) {
        outcome = { refused: refusal(error) }
        throw new Rollback()
      }
      const rows = capturedRows((await db.all(sql.raw(READ_CAPTURE_ROWS))) as StoredCaptureRow[])
      try {
        await checkAgainstOracle(
          async (text) => (await db.all(sql.raw(text))) as StoredCaptureRow[],
          rows,
        )
      } catch (error) {
        if (!(error instanceof CaptureOracleDifference)) throw error
        differences.push(`${write.label}: oracle\n    ${error.lines.join('\n    ')}`)
      }
      outcome = { rows }
      throw new Rollback()
    }, context)
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return outcome as Outcome
}

/** Why a write was refused: the database's own message, under drizzle's wrapper. */
function refusal(error: unknown): string {
  const cause = (error as Error & { cause?: Error }).cause ?? (error as Error)
  return String(cause.message).split('\n')[0] as string
}

/**
 * The differences the design accepts (2.3 rule 11): a derived value that drops volatile
 * fields compares semantically on Postgres, so a machine document whose keys only move
 * is captured on SQLite and not on Postgres.
 */
const ACCEPTED = /^machines\[[^\]]+\] (service_report_json|harness_versions_json) keys reordered: /

/** Copy every row of the SQLite store into the Postgres database, below any capture. */
async function copyInto(
  store: SessionStore,
  executor: RootStoreExecutor<QueryClient>,
  relations: ReadonlySet<string>,
): Promise<void> {
  const from = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  const to = executor.queries.rootDb
  // Read SQLite first: a statement of the SQLite store issued inside the Postgres
  // transaction would follow that transaction (the ambient one), not its own store.
  const copies: { table: PgTable; rows: Record<string, unknown>[] }[] = []
  for (const [key, sqliteTable] of Object.entries(SQLITE_TABLES)) {
    if (!is(sqliteTable, Table)) continue
    const name = getTableName(sqliteTable as Table)
    if (name === 'sync_capture' || name === 'sync_capture_guard' || !relations.has(name)) continue
    const pgTable = (PG_TABLES as Record<string, unknown>)[key]
    if (!is(pgTable, PgTable)) continue
    const rows = (await from.select().from(sqliteTable as never)) as Record<string, unknown>[]
    if (rows.length > 0) copies.push({ table: pgTable, rows })
  }
  await executor.transact(async () => {
    // Foreign keys are checked by triggers, which replica mode skips: the rows arrive in
    // any order and are consistent once all are in.
    await to.run(sql.raw('SET LOCAL session_replication_role = replica'))
    for (const { table, rows } of copies) {
      const width = Math.max(1, Object.keys(getTableColumns(table)).length)
      const chunk = Math.max(1, Math.floor(20_000 / width))
      for (let i = 0; i < rows.length; i += chunk) {
        await to.insert(table as never).values(rows.slice(i, i + chunk) as never)
      }
    }
  })
}

describe.runIf(ENGINE === 'pg')('the cross-engine corpus (Postgres leg)', () => {
  let store: SessionStore
  let executor: RootStoreExecutor<QueryClient>
  let url: string
  let unseeded: string[] = []
  beforeAll(async () => {
    // SQLite is this file's reference engine on the Postgres leg, so it opens a real
    // SQLite store, which the leg's opener refuses by default.
    useRealMigrationChain()
    const corpus = await sqliteCorpus()
    store = corpus.store
    unseeded = corpus.unseeded
    url = (await clonePgTestDatabase('file')).url
    executor = createPgStoreExecutor({ url, poolSize: 2, pgTables: PG_TABLES, startOpen: true })
    const admin = connectPgTest(url)
    try {
      const relations = new Set(
        (
          await admin.unsafe<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
          )
        ).map((row) => row.table_name),
      )
      await copyInto(store, executor, relations)
      for (const { table_name, column_name } of await admin.unsafe<{
        table_name: string
        column_name: string
      }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND is_identity = 'YES'`,
      )) {
        await admin.unsafe(
          `SELECT setval(pg_get_serial_sequence('"${table_name}"', '${column_name}'), coalesce((SELECT max("${column_name}") FROM "${table_name}"), 0) + 1, false)`,
        )
      }
      for (const statement of oracleStatements()) await admin.unsafe(statement)
    } finally {
      await admin.close()
    }
  }, 180_000)
  afterAll(async () => {
    await executor?.close()
    await store?.close()
  })

  it('holds rows of every source table, in both workspaces', async () => {
    const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
    const short: string[] = []
    for (const name of sourcesByTable().keys()) {
      const table = SQLITE_TABLES[
        EXPORT_OF.get(name) as keyof typeof SQLITE_TABLES
      ] as unknown as Table
      const rows = (await db.select().from(table as never)) as unknown[]
      if (rows.length < ROWS_PER_TABLE) short.push(`${name}: ${rows.length}`)
    }
    expect(unseeded).toEqual([])
    expect(short).toEqual([])
  })

  it('captures on Postgres exactly what SQLite captures, and what the oracle sees', async () => {
    const writes = await corpusWrites(store, ROWS_PER_TABLE)
    const differences: string[] = []
    const accepted: string[] = []
    let guarded = 0
    let compared = 0
    for (const write of writes) {
      const sqlite = await onSqlite(store, write)
      const pg = await onPostgres(executor, write, differences)
      if ('refused' in sqlite && 'refused' in pg) {
        // A shipping guard's refusal is the same rule on both, so the same message; a
        // constraint's wording is each engine's own.
        if (GUARD_TEXTS.has(sqlite.refused) || GUARD_TEXTS.has(pg.refused)) {
          if (sqlite.refused !== pg.refused) {
            differences.push(
              `${write.label}: refused differently: SQLite (${sqlite.refused}), Postgres (${pg.refused})`,
            )
          } else guarded++
        }
        continue
      }
      compared++
      let lines: string[]
      if ('refused' in sqlite || 'refused' in pg) {
        lines = [
          `refused on ${'refused' in sqlite ? `SQLite (${sqlite.refused})` : `Postgres (${(pg as { refused: string }).refused})`} only`,
        ]
      } else {
        lines = captureDifference(sqlite.rows, pg.rows, { expected: 'SQLite', actual: 'Postgres' })
      }
      if (lines.length === 0) continue
      const line = `${write.label}: ${lines.join('; ')}`
      if (ACCEPTED.test(line)) accepted.push(line)
      else differences.push(line)
    }
    console.log(
      `corpus: ${writes.length} writes, ${compared} compared, ${accepted.length} accepted differences, ${guarded} refused by the shipping guards on both engines`,
    )
    expect(differences).toEqual([])
    expect(compared).toBeGreaterThan(500)
    expect(guarded).toBeGreaterThan(0)
  }, 600_000)

  it('the oracle reports a write that bypassed its capture form', async () => {
    const db = executor.queries.rootDb
    const t = PG_TABLES as unknown as typeof SQLITE_TABLES
    let reported: unknown
    try {
      await executor.transact(
        async () => {
          await db
            .update(t.userLayout)
            .set({ value: '"plain"' })
            .where(
              and(
                eq(t.userLayout.workspaceId, OTHER_WORKSPACE as never),
                eq(t.userLayout.key, 'dockTab'),
              ),
            )
          const rows = capturedRows(
            (await db.all(sql.raw(READ_CAPTURE_ROWS))) as StoredCaptureRow[],
          )
          expect(rows).toEqual([])
          await checkAgainstOracle(
            async (text) => (await db.all(sql.raw(text))) as StoredCaptureRow[],
            rows,
          ).catch((error: unknown) => {
            reported = error
          })
          throw new Rollback()
        },
        workspaceContext(asWorkspaceId(OTHER_WORKSPACE)),
      )
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
    }
    expect(reported).toBeInstanceOf(CaptureOracleDifference)
    expect((reported as CaptureOracleDifference).lines).toEqual([
      expect.stringMatching(/^only the oracle \(1x\): userLayout\[0\] u \["ws_capture_b",/),
    ])
  })

  it("refuses a row of another workspace in a workspace's drain", async () => {
    const db = executor.queries.rootDb
    const t = PG_TABLES as unknown as typeof SQLITE_TABLES
    let rows: CapturedRow[] = []
    await expect(
      executor.transact(async () => {
        await captureWrite(
          db
            .update(t.userLayout)
            .set({ value: '"other"' })
            .where(
              and(
                eq(t.userLayout.workspaceId, OTHER_WORKSPACE as never),
                eq(t.userLayout.key, 'dockTab'),
              ),
            ),
        )
        rows = capturedRows((await db.all(sql.raw(READ_CAPTURE_ROWS))) as StoredCaptureRow[])
        await db.all(sql.raw(TAKE_ORACLE_ROWS))
        assertCapturedInWorkspace(rows, SELF_HOSTED_WORKSPACE_ID)
      }, workspaceContext(SELF_HOSTED_WORKSPACE_ID)),
    ).rejects.toBeInstanceOf(ForeignCaptureError)
    expect(rows.map((row) => [row.kind, row.newKey?.[0]])).toEqual([
      ['userLayout', OTHER_WORKSPACE],
    ])
  })

  it('refuses to commit capture rows nobody drained, and commits once they are', async () => {
    const db = executor.queries.rootDb
    const t = PG_TABLES as unknown as typeof SQLITE_TABLES
    const write = (value: string) =>
      captureWrite(
        db
          .update(t.userLayout)
          .set({ value })
          .where(
            and(
              eq(t.userLayout.workspaceId, OTHER_WORKSPACE as never),
              eq(t.userLayout.key, 'dockTab'),
            ),
          ),
      )
    const context = workspaceContext(asWorkspaceId(OTHER_WORKSPACE))
    await expect(
      executor.transact(async () => {
        await write('"first"')
        await db.all(sql.raw(TAKE_ORACLE_ROWS))
      }, context),
    ).rejects.toThrow(/sync_capture/)
    await executor.transact(async () => {
      await write('"second"')
      await db.all(sql.raw(TAKE_ORACLE_ROWS))
      await db.run(sql.raw('DELETE FROM sync_capture'))
    }, context)
    // The oracle's own guard: a shadow row nobody compared refuses the commit too.
    await expect(
      executor.transact(async () => {
        await write('"third"')
        await db.run(sql.raw('DELETE FROM sync_capture'))
      }, context),
    ).rejects.toThrow(/sync_capture_oracle/)
  })

  it("keeps the builder's result shapes: run counts rows, all returns its RETURNING", async () => {
    const db = executor.queries.rootDb
    const t = PG_TABLES as unknown as typeof SQLITE_TABLES
    const context = workspaceContext(asWorkspaceId(OTHER_WORKSPACE))
    const match = and(
      eq(t.userLayout.workspaceId, OTHER_WORKSPACE as never),
      eq(t.userLayout.key, 'dockTab'),
    )
    try {
      await executor.transact(async () => {
        const ran = await captureWrite(db.update(t.userLayout).set({ value: '"one"' }).where(match))
          .prepare()
          .run()
        expect(ran.changes).toBe(1)
        const returned = await captureWrite(
          db
            .update(t.userLayout)
            .set({ value: '"two"' })
            .where(match)
            .returning({ key: t.userLayout.key, at: t.userLayout.updatedAt }),
        )
          .prepare()
          .all()
        expect(returned).toEqual([{ key: 'dockTab', at: AT }])
        const none = await captureWrite(
          db.delete(t.userLayout).where(eq(t.userLayout.key, 'no-such-key')),
        )
          .prepare()
          .run()
        expect(none.changes).toBe(0)
        throw new Rollback()
      }, context)
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
    }
  })
})
