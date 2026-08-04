/**
 * Per-statement attribution for the SQLite seam, paired with `startLoopMetrics`.
 *
 * WHY THIS EXISTS (POD-1630). The server's stall reporter could say a tick burned
 * 500ms of own-CPU but not WHAT ran, and the tRPC/phase counters could not fill the
 * gap: a 180s live window with 15 stalls (4787ms of own-CPU) recorded ZERO tRPC
 * calls and ~1ms of instrumented phase work. The stalls are background work, and
 * `/proc/<pid>/io` showed why — the process was reading 4KB pages out of the one
 * file it holds open (podium.db) in bursts of 20-56MB/s, one ~7.3MB / ~1900-page
 * scan at a time, several times per second. Flat JS heap against RSS swinging
 * 350MB -> 1.2GB is that scan's row materialization being allocated and dropped.
 *
 * So the missing number is per-SQL: which statement, how often, how long, how many
 * rows. That is what this records. It is a diagnostic, not a budget — nothing here
 * changes behavior, and with the flag unset `attributeQueries` hands the database
 * straight back, so a disabled build carries no per-query cost at all.
 */

import type { SqlDatabase, SqlParam } from './types'

const ENABLED = !!process.env.PODIUM_LOOP_PROFILE
export const queryAttributionEnabled = ENABLED

export interface QueryCost {
  /** Statement executions in the current window. */
  count: number
  /** Summed wall time of those executions, ms. */
  wallMs: number
  /** Rows handed back across those executions (`all` only; `get` counts 0/1). */
  rows: number
}

const costs = new Map<string, QueryCost>()

/**
 * Collapse a statement to a stable, log-safe key. Whitespace folds so the same
 * query written across several lines aggregates as one, and the key is truncated
 * because a stall line has to stay readable — the leading clause is what
 * identifies the offender.
 */
export function queryKey(sql: string, maxLength = 120): string {
  const folded = sql.replace(/\s+/g, ' ').trim()
  return folded.length <= maxLength ? folded : folded.slice(0, maxLength - 1) + '…'
}

/**
 * Record one statement execution. The enabled-gate lives at the wrapping decision
 * in {@link attributeQueries}, not here: a wrapper only exists when attribution is
 * on, so re-checking an ambient env var per execution would be a second source of
 * truth for the same question.
 */
export function recordQuery(sql: string, wallMs: number, rows: number): void {
  const key = queryKey(sql)
  const cost = costs.get(key) ?? { count: 0, wallMs: 0, rows: 0 }
  cost.count++
  cost.wallMs += wallMs
  cost.rows += rows
  costs.set(key, cost)
  const total = totals.get(key) ?? { count: 0, wallMs: 0, rows: 0 }
  total.count++
  total.wallMs += wallMs
  total.rows += rows
  totals.set(key, total)
  if (STACKS) recordCallerStack(key)
}

/**
 * Lifetime totals, deliberately NOT cleared by {@link resetQueryAttribution}.
 *
 * The window exists so a stall line reports the second that stalled; a bench run
 * asking "how many times did this statement run over a minute" needs the opposite,
 * and reading the window from outside its 1s reset cadence answers neither
 * question (POD-1638 first measured ~0 statements that way). Same recording path,
 * two retention policies.
 */
const totals = new Map<string, QueryCost>()

/** Lifetime per-statement totals since process start. Never reset. */
export function queryAttributionTotals(): ReadonlyMap<string, QueryCost> {
  return new Map(totals)
}

/**
 * Caller attribution, one level deeper than the SQL (POD-1638).
 *
 * A statement key names WHAT ran; when the defect is a call COUNT the question is
 * immediately WHO ran it, and the SQL cannot answer that — `SELECT * FROM issues
 * WHERE id = ?` is prepared in one place and reached from dozens. Capturing a stack
 * is far more expensive than the timing pair above, so it sits behind its own flag
 * (`PODIUM_LOOP_PROFILE_STACKS`) rather than riding along with attribution: this is
 * a bench/repro instrument, not something a live host should carry.
 */
const STACKS = ENABLED && !!process.env.PODIUM_LOOP_PROFILE_STACKS
const stacks = new Map<string, Map<string, number>>()

function recordCallerStack(key: string): void {
  const raw = new Error().stack ?? ''
  const frames = raw
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    // Drop this module's own frames so the top frame is the caller that issued it.
    .filter((line) => !line.includes('query-attribution'))
    .slice(0, 12)
    .join('\n')
  const perKey = stacks.get(key) ?? new Map<string, number>()
  perKey.set(frames, (perKey.get(frames) ?? 0) + 1)
  stacks.set(key, perKey)
}

/** Sampled caller stacks per statement key, hottest first. Empty unless stacks are on. */
export function queryCallerStacks(): Map<string, { count: number; stack: string }[]> {
  const out = new Map<string, { count: number; stack: string }[]>()
  for (const [key, perKey] of stacks) {
    out.set(
      key,
      [...perKey]
        .map(([stack, count]) => ({ stack, count }))
        .sort((a, b) => b.count - a.count),
    )
  }
  return out
}

/**
 * The current window's statements, most expensive first by summed wall time.
 * `limit` bounds the log line, not the measurement.
 */
export function formatTopQueries(limit = 3, source: ReadonlyMap<string, QueryCost> = costs): string {
  return [...source]
    .sort((a, b) => b[1].wallMs - a[1].wallMs || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([sql, c]) => `${c.count}x/${c.wallMs.toFixed(0)}ms/${c.rows}rows ${sql}`)
    .join(' | ')
}

/** Drop the window. The reset cadence is owned by the caller that reports stalls. */
export function resetQueryAttribution(): void {
  costs.clear()
}

/** Snapshot of the current window, for tests and for callers that format their own. */
export function queryAttributionSnapshot(): ReadonlyMap<string, QueryCost> {
  return new Map(costs)
}

/**
 * Wrap a database so every statement execution is attributed to its SQL.
 *
 * Returns `db` UNCHANGED when attribution is off — that is the whole cost model.
 * `enabled` defaults to the flag but is a parameter so a caller (and a test) can
 * state the answer instead of inheriting it from the ambient environment.
 * `prepare` is wrapped once per statement, not once per execution, so the hot path
 * adds one `performance.now()` pair and a map update. Statement identity comes from
 * the SQL handed to `prepare`, so a statement prepared once and executed in a loop
 * still aggregates under the query that produced the rows.
 */
export function attributeQueries(db: SqlDatabase, enabled: boolean = ENABLED): SqlDatabase {
  if (!enabled) return db
  return {
    prepare(sql) {
      const st = db.prepare(sql)
      const timed = <T>(fn: () => T, rowsOf: (result: T) => number): T => {
        const startedAt = performance.now()
        // `finally` would attribute a throwing statement too, but it cannot know the
        // row count; a failed statement contributes its wall time and zero rows.
        let rows = 0
        try {
          const result = fn()
          rows = rowsOf(result)
          return result
        } finally {
          recordQuery(sql, performance.now() - startedAt, rows)
        }
      }
      return {
        run: (...p: SqlParam[]) => timed(() => st.run(...p), () => 0),
        get: (...p: SqlParam[]) => timed(() => st.get(...p), (row) => (row === undefined ? 0 : 1)),
        all: (...p: SqlParam[]) =>
          timed(
            () => st.all(...p),
            (rows) => rows.length,
          ),
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}
