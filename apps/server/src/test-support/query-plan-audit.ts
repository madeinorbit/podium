/**
 * THE QUERY-PLAN AUDIT'S MACHINERY [POD-6148, server data design §3 rule 3].
 *
 * The audit (`store/query-plan-audit.test.ts`) asks SQLite, for every query a
 * repository defines, how it would run that query, and fails on a plan that
 * reads a whole table or sorts rows in a temporary B-tree. This module holds
 * the parts that do not depend on the store: building a definition's SQL
 * without running it, mapping a definition to its source, and reading a plan.
 *
 * WHY THE PLANNER HAS NO STATISTICS HERE. The audit runs on a migrated schema
 * with no `sqlite_stat1`. Without statistics SQLite assumes every table is
 * large, so it uses an index whenever one can serve the query; a plan that
 * still scans means no index can. With statistics from a small test table the
 * planner may rightly prefer a scan, which would tell us nothing about the
 * live database.
 */

import { relative } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { is, Param, Placeholder } from 'drizzle-orm'
import type { QueryClient } from '../store/executor/driver'
import { type StoreDrizzle, storeQueriesOver } from '../store/executor/sync-drizzle'

/**
 * A drizzle instance whose client refuses to run anything. A definition's
 * `build` only prepares (or, for a raw `db.run(sql)`, makes a lazy promise), so
 * the audit can build every definition on it and read the SQL text with no
 * effect on any database.
 */
export function recordingDrizzle(): StoreDrizzle {
  const refuse = (): never => {
    throw new Error('the query-plan audit builds queries; it never runs them')
  }
  const client: QueryClient = {
    run: refuse,
    get: refuse,
    all: refuse,
    writeGet: refuse,
    writeAll: refuse,
    batch: refuse,
  }
  return storeQueriesOver(client, async (fn) => await fn()).rootDb
}

interface QueryLike {
  getQuery(): { sql: string; params: readonly unknown[] }
}

function isQueryLike(value: unknown): value is QueryLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { getQuery?: unknown }).getQuery === 'function'
  )
}

/** One statement a definition builds: its text and how many values it binds. */
export interface BuiltStatement {
  readonly sql: string
  readonly params: number
  /**
   * The placeholder name behind each bound value, in binding order; undefined
   * for a value the definition fixed (a literal). The workspace-scope audit
   * (POD-7014) reads which `?` is the `workspaceId` placeholder from it.
   */
  readonly placeholders: readonly (string | undefined)[]
}

/**
 * The name of one bound value of a built query: drizzle keeps a
 * `sql.placeholder(name)` as a `Placeholder`, and a `param(column, name)` (or a
 * `.values()` entry, which the builder wraps) as a column `Param` around one.
 */
function placeholderName(value: unknown): string | undefined {
  if (is(value, Placeholder)) return value.name
  if (is(value, Param) && is(value.value, Placeholder)) return value.value.name
  return undefined
}

/**
 * The statements in what a `build` returned: a prepared query, a raw query, or
 * an object or array holding them (a definition may return a small bundle).
 */
export function statementsOf(built: unknown, depth = 0): BuiltStatement[] {
  if (isQueryLike(built)) {
    const query = built.getQuery()
    return [
      {
        sql: query.sql,
        params: query.params.length,
        placeholders: query.params.map(placeholderName),
      },
    ]
  }
  if (depth < 2 && built !== null && typeof built === 'object') {
    return Object.values(built).flatMap((value) => statementsOf(value, depth + 1))
  }
  return []
}

/**
 * The position a definition's stack names: the first frame outside
 * `prepared.ts`, as `file`, `line` and `column` of the call. The registry formats
 * each stack when the definition is made [POD-7064], so under the test runner
 * every frame went through its source map and `line` is the SOURCE line: the
 * line a definition site's call is on (see {@link siteContaining}).
 */
export function definitionFrame(
  site: Error,
  repoRoot: string,
): { file: string; line: number; column: number } | undefined {
  for (const frame of (site.stack ?? '').split('\n').slice(1)) {
    const match = /(\/[^\s()]+\.ts):(\d+):(\d+)/.exec(frame)
    if (!match) continue
    const file = relative(repoRoot, match[1]!).split('\\').join('/')
    if (file.endsWith('adapters/sqlite/prepared.ts')) continue
    // A two-form definition registers through `prepared` from here [POD-6995].
    if (file.endsWith('store/executor/dialect-prepared.ts')) continue
    return { file, line: Number(match[2]), column: Number(match[3]) }
  }
  return undefined
}

/**
 * The definition site whose call spans `line` of its file, or undefined. A
 * definition is identified by WHERE its call is in the source, its line, and so
 * by the site's name; never by its rank among the positions an engine reported,
 * nor by a column (one call can report two, and the order of positions depends
 * on how each stack was formatted) [POD-7064]. Sites do not share lines; where
 * one call spans another (a definition inside a definition's callback) the
 * innermost wins.
 */
export function siteContaining<S extends { readonly startLine: number; readonly endLine: number }>(
  sites: readonly S[],
  line: number,
): S | undefined {
  let found: S | undefined
  for (const site of sites) {
    if (line < site.startLine || line > site.endLine) continue
    if (!found || site.endLine - site.startLine < found.endLine - found.startLine) found = site
  }
  return found
}

/** What the audit objects to in one plan. */
export interface PlanFinding {
  /** `scan`: every row of the table (or of its whole index) is read. `sort`: rows are sorted in a temporary B-tree. */
  readonly kind: 'scan' | 'sort'
  /** The table read, for a scan. */
  readonly table?: string
  readonly detail: string
}

/** The tables of `database` (ordinary and virtual), the only names a scan finding can be about. */
export function tablesOf(database: SqlDatabase): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string
  }[]
  return new Set(rows.map((row) => row.name))
}

/** `EXPLAIN QUERY PLAN` of one statement, every unbound value NULL. */
export function explain(
  database: SqlDatabase,
  statement: Pick<BuiltStatement, 'sql' | 'params'>,
): string[] {
  const nulls = Array.from({ length: statement.params }, () => null)
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...nulls) as {
    detail: string
  }[]
  return rows.map((row) => row.detail)
}

/**
 * The table a plan line names: SQLite prints an aliased table by its alias
 * (`SCAN n` for `"messages" "n"`), so an alias is resolved against the SQL.
 */
function tableNamed(
  name: string,
  sqlText: string,
  tables: ReadonlySet<string>,
): string | undefined {
  if (tables.has(name)) return name
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alias = new RegExp(
    `["\`]?(\\w+)["\`]?\\s+(?:as\\s+)?["\`]?${escaped}["\`]?(?=[\\s,)]|$)`,
    'gi',
  )
  for (const match of sqlText.matchAll(alias)) {
    if (tables.has(match[1]!)) return match[1]!
  }
  return undefined
}

/**
 * The findings in a plan.
 *
 * `SCAN t`, `SCAN t USING INDEX i` and `SCAN t USING COVERING INDEX i` all read
 * every row of `t` (the last two in index order), so all three are scans. A
 * scan of something that is not a table (a subquery, a CTE, `json_each`, a
 * constant row) is not. An FTS5 table reports `VIRTUAL TABLE INDEX n:<plan>`;
 * a plan string with an `M` (a MATCH) is served by the full-text index, and one
 * with an `=` (a rowid equality) reads one row by its key.
 *
 * A `SEARCH` is a scan in disguise when every column it constrains is one
 * whose value is shared by most rows (`lowSelectivity`, `table.column`): with
 * no statistics SQLite takes any equality on an indexed column as selective,
 * so `deleted_at IS NULL` reads as a search while it selects nearly every row.
 */
export function planFindings(
  plan: readonly string[],
  sqlText: string,
  tables: ReadonlySet<string>,
  lowSelectivity: ReadonlySet<string> = new Set(),
): PlanFinding[] {
  const findings: PlanFinding[] = []
  for (const detail of plan) {
    const scan = /^SCAN (\S+)(?: AS \S+)?(.*)$/.exec(detail)
    if (scan) {
      const table = tableNamed(scan[1]!, sqlText, tables)
      const rest = scan[2] ?? ''
      if (table === undefined) continue
      const virtual = /VIRTUAL TABLE INDEX \d+:(\S*)/.exec(rest)
      if (virtual && /[M=]/.test(virtual[1] ?? '')) continue
      findings.push({ kind: 'scan', table, detail })
      continue
    }
    const search = /^SEARCH (\S+)(?: AS \S+)? USING (?:COVERING )?INDEX \S+ \(([^)]*)\)/.exec(
      detail,
    )
    if (search) {
      const table = tableNamed(search[1]!, sqlText, tables)
      const columns = search[2]!.split(' AND ').map((term) => term.replace(/[=<>!].*$/, '').trim())
      if (
        table !== undefined &&
        columns.every((column) => lowSelectivity.has(`${table}.${column}`))
      ) {
        findings.push({ kind: 'scan', table, detail: `${detail} (low selectivity)` })
      }
      continue
    }
    if (/^USE TEMP B-TREE FOR /.test(detail)) findings.push({ kind: 'sort', detail })
  }
  return findings
}
