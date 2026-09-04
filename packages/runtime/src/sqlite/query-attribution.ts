/**
 * The `SqlDatabase` half of per-statement attribution [POD-1630].
 *
 * The recording core moved to `../query-attribution` (POD-3281) because it never
 * knew what a connection was; what stayed here is the part that does — the
 * wrapper around a synchronous SQLite handle. It is re-exported below so every
 * existing `@podium/runtime/sqlite` import is unchanged.
 *
 * THIS IS NO LONGER THE ONLY INSTRUMENT. A repository converted to the query
 * layer runs through the executor's driver, and on the remote driver there is no
 * handle to wrap at all, so the second instrument sits at the driver seam
 * (`apps/server/src/store/executor/statement-probe.ts`). Both record into the
 * same window and lifetime maps.
 */

import { recordQuery } from '../query-attribution'
import type { SqlDatabase, SqlParam } from './types'

export {
  formatTopQueries,
  type QueryCost,
  queryAttributionEnabled,
  queryAttributionSnapshot,
  queryAttributionTotals,
  queryCallerStacks,
  queryKey,
  recordQuery,
  resetQueryAttribution,
} from '../query-attribution'

import { queryAttributionEnabled as ENABLED } from '../query-attribution'

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
        run: (...p: SqlParam[]) =>
          timed(
            () => st.run(...p),
            () => 0,
          ),
        get: (...p: SqlParam[]) =>
          timed(
            () => st.get(...p),
            (row) => (row === undefined ? 0 : 1),
          ),
        all: (...p: SqlParam[]) =>
          timed(
            () => st.all(...p),
            (rows) => rows.length,
          ),
        values: (...p: SqlParam[]) =>
          timed(
            () => st.values(...p),
            (rows) => rows.length,
          ),
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}
