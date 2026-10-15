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

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { relative } from 'node:path'
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
}

/**
 * The statements in what a `build` returned: a prepared query, a raw query, or
 * an object or array holding them (a definition may return a small bundle).
 */
export function statementsOf(built: unknown, depth = 0): BuiltStatement[] {
  if (isQueryLike(built)) {
    const query = built.getQuery()
    return [{ sql: query.sql, params: query.params.length }]
  }
  if (depth < 2 && built !== null && typeof built === 'object') {
    return Object.values(built).flatMap((value) => statementsOf(value, depth + 1))
  }
  return []
}

/**
 * The position a definition's stack names: the first frame outside
 * `prepared.ts`, as `file`, `line` and `column` of the code that RAN. Under the
 * test runner that is the transformed module, so the line is not the source
 * line; the transform keeps statements in source order, so positions within
 * one file sort the way the source does (see {@link matchSites}).
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
    return { file, line: Number(match[2]), column: Number(match[3]) }
  }
  return undefined
}

/**
 * Pair the distinct definition positions seen in one file with that file's
 * definition sites. Both lists are in source order, so when every site was
 * reached the k-th position is the k-th site. When the counts differ even by
 * line the pairing is unknowable and nothing is returned; the caller reports
 * the file.
 */
export function matchSites<S>(
  positions: readonly { line: number; column: number }[],
  sites: readonly S[],
): Map<string, S> | undefined {
  const ordered = [...new Map(positions.map((p) => [`${p.line}:${p.column}`, p])).values()].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  )
  if (ordered.length === sites.length) {
    return new Map(
      ordered.map((position, index) => [`${position.line}:${position.column}`, sites[index]!]),
    )
  }
  // A site evaluated more than once can report a second column for the same
  // call (the engine's tiers do not always agree). Lines alone, when they
  // pair one to one, are still unambiguous.
  const lines = [...new Set(ordered.map((position) => position.line))].sort((a, b) => a - b)
  if (lines.length !== sites.length) return undefined
  const siteOfLine = new Map(lines.map((line, index) => [line, sites[index]!]))
  return new Map(
    ordered.map((position) => [
      `${position.line}:${position.column}`,
      siteOfLine.get(position.line)!,
    ]),
  )
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
export function explain(database: SqlDatabase, statement: BuiltStatement): string[] {
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
