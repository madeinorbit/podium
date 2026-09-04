/**
 * THE TEMPORARY HALF OF THE PROBE SEAM [POD-3281]. Deleted by POD-3326.
 *
 * The permanent seam is the driver session (`statement-probe.ts`). This file is
 * the OTHER feed into the same {@link StatementProbeHub}: the raw `SqlDatabase`
 * an UNCONVERTED repository still holds. It exists because the three query-count
 * probes and the hot-path measurement script have to keep working through the
 * whole of Stage A, while some repositories run on the query layer and some
 * still run `this.db.prepare(sql).get(...)` — one probe, both feeds, so a
 * measurement never has to ask which kind of repository produced a statement.
 *
 * IT GOES WITH THE EXECUTOR'S `legacy` FIELD. When Stage A's exit gate deletes
 * that field there is no raw handle left in the store, this file has nothing to
 * observe, and it is deleted with it (POD-3326) — which is why it sits in the
 * boundary lint's `STAGE_A_UNCONVERTED` ledger rather than in the permanent
 * driver-seam allowlist.
 *
 * IT COUNTS EXECUTIONS, NOT PREPARATIONS, which is the correction the driver's
 * statement cache forces: `prepare` is where the text is visible, but the round
 * trip is `run`/`get`/`all`, and once a statement is cached the two counts stop
 * coinciding. Both feeds therefore report the same quantity.
 *
 * IT PATCHES IN PLACE rather than wrapping at construction, because every
 * repository captured `this.db` when the store was built and they all captured
 * the SAME object. A wrapper handed out afterwards would be observed by nobody.
 */

import { queryKey } from '@podium/runtime/query-attribution'
import type { SqlDatabase, SqlParam, SqlStatement } from '@podium/runtime/sqlite'
import type { StatementMethod } from './driver'
import { type StatementProbe, StatementProbeHub } from './statement-probe'

/** Anything holding the raw handle — `SessionStore`, or a bare test fixture. */
export interface LegacyHandleHolder {
  readonly db: SqlDatabase
}

/**
 * Feed every statement executed on `holder.db` into `hub`, until the returned
 * detach runs.
 *
 * Detaching restores the original `prepare`, so a second measurement window in
 * the same process is not counted twice. Statements PREPARED BEFORE the patch
 * are not observed — which is fine here and is not fine at the driver, because
 * an unconverted repository prepares per call and the driver caches (spec §2.2;
 * that asymmetry is the whole reason the permanent seam is the driver).
 */
export function observeLegacyHandle(
  holder: LegacyHandleHolder,
  hub: StatementProbeHub,
): () => void {
  const handle = holder.db as SqlDatabase & { prepare: SqlDatabase['prepare'] }
  // The function ITSELF, not a bound copy, so `restore` puts back exactly what
  // it found — otherwise a second probe layered over this one would restore a
  // wrapper instead of the handle's own method and leak an instrument.
  const original = handle.prepare
  const patched = (sql: string): SqlStatement => {
    const statement = original.call(handle, sql)
    const key = queryKey(sql)
    const timed = <T>(method: StatementMethod, run: () => T, rowsOf: (result: T) => number): T => {
      if (!hub.active) return run()
      const startedAt = performance.now()
      let rows = 0
      let failed = true
      try {
        const result = run()
        rows = rowsOf(result)
        failed = false
        return result
      } finally {
        hub.emit({
          sql,
          key,
          method,
          // NOT INFERRED FROM THE TEXT (spec §6 rule 16 bans exactly that). A
          // repository on the raw handle declares nothing, so the seam says so.
          intent: 'undeclared',
          rows,
          durationMs: performance.now() - startedAt,
          failed,
          batchSize: 1,
          batchIndex: 0,
          seam: 'legacy-handle',
        })
      }
    }
    return {
      run: (...p: SqlParam[]) =>
        timed(
          'run',
          () => statement.run(...p),
          () => 0,
        ),
      get: (...p: SqlParam[]) =>
        timed(
          'get',
          () => statement.get(...p),
          (row) => (row === undefined ? 0 : 1),
        ),
      all: (...p: SqlParam[]) =>
        timed(
          'all',
          () => statement.all(...p),
          (rows) => rows.length,
        ),
      // Counted as an `all`: drizzle's session reaches for `values` on the same
      // statements it would otherwise read as rows, and a seam that omitted it
      // would leave every converted repository invisible to this feed (POD-3395).
      values: (...p: SqlParam[]) =>
        timed(
          'all',
          () => statement.values(...p),
          (rows) => rows.length,
        ),
    }
  }
  handle.prepare = patched
  let detached = false
  return () => {
    if (detached) return
    detached = true
    handle.prepare = original
  }
}

/**
 * The whole seam in one call, for a probe that only needs the legacy feed —
 * which is every consumer today, because no repository is converted yet.
 *
 * A consumer that wants BOTH feeds builds the hub itself and passes it to
 * `instrumentDriver` as well; that is what the store will do once it holds an
 * executor.
 */
export function probeLegacyStatements(
  holder: LegacyHandleHolder,
  probe: StatementProbe,
): () => void {
  const hub = new StatementProbeHub()
  const detach = hub.attach(probe)
  const restore = observeLegacyHandle(holder, hub)
  return () => {
    restore()
    detach()
  }
}
