/**
 * THE TWO-ENGINE SLICE'S COMPILE-TIME PROOF [POD-6995, POD-6958 design 2.1 step 2 and 4].
 *
 * Two claims the binding's one cast rests on, checked by `bun run typecheck`, the
 * ordinary gate:
 *
 * 1. *The twins type as their SQLite tables.* The slice's hand-written Postgres tables
 *    (`test-support/pg-slice-tables.ts`) have exactly the `$inferSelect` and
 *    `$inferInsert` of `migrations/schema.ts`'s, so a definition written against the
 *    SQLite types and handed the Postgres objects through `bindingFor` reads and writes
 *    the same JavaScript values. POD-6978's schema parity test makes the same check
 *    for every table once the generated schema exists.
 * 2. *A two-form definition cannot drift.* Each `@ts-expect-error` below plants a
 *    `dialectPrepared` form whose row is not the declared one (reported on that form's
 *    body), or a caller passing the wrong values. The directive passes only while tsc rejects the line under it; if
 *    the `Exact<>` check ever weakens to plain assignability, a directive goes unused
 *    and TS2578 fails the typecheck. The positive cases are the other half: a check
 *    that refused everything would satisfy every directive on its own.
 *
 * Nothing here runs: the drizzle instance is declared, never made, and no test imports
 * this file.
 */

import { and, eq, sql } from 'drizzle-orm'
import type * as sqliteSchema from '../migrations/schema'
import { PG_SLICE_TABLES } from '../test-support/pg-slice-tables'
import { bindingFor, type StoreTables } from './executor/binding'
import { dialectPrepared, type Exact, type RowOf } from './executor/dialect-prepared'
import { param, prepared, type StoreDrizzle } from './executor/sync-drizzle'

declare const db: StoreDrizzle

/** Compiles only when `T` is `true`. */
function assertTrue<T extends true>(): T | undefined {
  return undefined
}

// ---------------------------------------------------------------------------
// 1. The twins type as their SQLite tables
// ---------------------------------------------------------------------------

type PgSlice = typeof PG_SLICE_TABLES

assertTrue<
  Exact<
    PgSlice['recapWatermarks']['$inferSelect'],
    (typeof sqliteSchema.recapWatermarks)['$inferSelect']
  >
>()
assertTrue<
  Exact<
    PgSlice['recapWatermarks']['$inferInsert'],
    (typeof sqliteSchema.recapWatermarks)['$inferInsert']
  >
>()
assertTrue<
  Exact<PgSlice['quotaWindows']['$inferSelect'], (typeof sqliteSchema.quotaWindows)['$inferSelect']>
>()
assertTrue<
  Exact<PgSlice['quotaWindows']['$inferInsert'], (typeof sqliteSchema.quotaWindows)['$inferInsert']>
>()

// The check itself is not vacuous: a different row is not exact.
assertTrue<
  // @ts-expect-error a watermark row is not a quota window row
  Exact<
    PgSlice['recapWatermarks']['$inferSelect'],
    (typeof sqliteSchema.quotaWindows)['$inferSelect']
  >
>()
// @ts-expect-error a row with one column more is assignable, but not exact
assertTrue<Exact<{ a: string; b: number }, { a: string }>>()

// The Postgres objects, passed through the binding, are typed as the SQLite schema:
// one definition source builds on them with SQLite's row types.
const pgTables: StoreTables = bindingFor('pg', PG_SLICE_TABLES)
const watermarkOf = (t: StoreTables) =>
  db
    .select({ watermark: t.recapWatermarks.watermark, at: t.recapWatermarks.updatedAt })
    .from(t.recapWatermarks)
    .where(
      and(
        eq(t.recapWatermarks.reader, param(t.recapWatermarks.reader, 'reader')),
        eq(t.recapWatermarks.sessionId, param(t.recapWatermarks.sessionId, 'sessionId')),
      ),
    )
    .prepare()
assertTrue<Exact<RowOf<ReturnType<typeof watermarkOf>>, { watermark: string; at: string }>>()
void watermarkOf(pgTables)

// ---------------------------------------------------------------------------
// 2. A two-form definition cannot drift
// ---------------------------------------------------------------------------

interface ByKey {
  readonly accountKey: string
  readonly windowKey: string
}

type PeakRow = { peak: number; seen: number }

const peakSelect = (t: StoreTables, peak: ReturnType<typeof sql<number>>) =>
  db
    .select({ peak, seen: t.quotaWindows.lastSeenMs })
    .from(t.quotaWindows)
    .where(
      and(
        eq(t.quotaWindows.accountKey, param(t.quotaWindows.accountKey, 'accountKey')),
        eq(t.quotaWindows.windowKey, param(t.quotaWindows.windowKey, 'windowKey')),
      ),
    )
    .prepare()

// ACCEPTED: both forms build the declared row.
const peakOf = dialectPrepared<ByKey, PeakRow>()({
  sqlite: (_db, t) =>
    peakSelect(t, sql<number>`MAX(${t.quotaWindows.peakPercent}, ${t.quotaWindows.lastPercent})`),
  pg: (_db, t) =>
    peakSelect(
      t,
      sql<number>`GREATEST(${t.quotaWindows.peakPercent}, ${t.quotaWindows.lastPercent})`,
    ),
})

// ACCEPTED: a statement without RETURNING declares `void`.
const touch = dialectPrepared<ByKey & { readonly at: number }, void>()({
  sqlite: (_db, t) =>
    _db
      .update(t.quotaWindows)
      .set({ lastSeenMs: sql`MAX(${t.quotaWindows.lastSeenMs}, ${sql.placeholder('at')})` })
      .prepare(),
  pg: (_db, t) =>
    _db
      .update(t.quotaWindows)
      .set({ lastSeenMs: sql`GREATEST(${t.quotaWindows.lastSeenMs}, ${sql.placeholder('at')})` })
      .prepare(),
})

// The repository sees one signature, with the declared values and row.
async function callers(): Promise<void> {
  const row = await peakOf(db).get({ accountKey: 'a', windowKey: 'w' })
  assertTrue<Exact<typeof row, PeakRow | undefined>>()
  await touch(db).run({ accountKey: 'a', windowKey: 'w', at: 1 })
  // @ts-expect-error the declared values are required
  await peakOf(db).get({ accountKey: 'a' })
  // @ts-expect-error a value of the wrong type
  await touch(db).run({ accountKey: 'a', windowKey: 'w', at: 'soon' })
}
void callers

// Each rejection is reported on the body of the form that builds another row, naming
// the declared row and the built one; the directive sits on the line before it.

// REJECTED: the Postgres form selects one column more than declared.
dialectPrepared<ByKey, PeakRow>()({
  sqlite: (_db, t) => peakSelect(t, sql<number>`MAX(${t.quotaWindows.peakPercent}, 0)`),
  pg: (_db, t) =>
    // @ts-expect-error the pg form's row has an extra column
    _db
      .select({
        peak: sql<number>`GREATEST(${t.quotaWindows.peakPercent}, 0)`,
        seen: t.quotaWindows.lastSeenMs,
        label: t.quotaWindows.label,
      })
      .from(t.quotaWindows)
      .prepare(),
})

// REJECTED: the Postgres form's column has the wrong type.
dialectPrepared<ByKey, PeakRow>()({
  sqlite: (_db, t) => peakSelect(t, sql<number>`MAX(${t.quotaWindows.peakPercent}, 0)`),
  pg: (_db, t) =>
    // @ts-expect-error the pg form reads `peak` as a string
    _db
      .select({
        peak: sql<string>`GREATEST(${t.quotaWindows.peakPercent}, 0)::text`,
        seen: t.quotaWindows.lastSeenMs,
      })
      .from(t.quotaWindows)
      .prepare(),
})

// REJECTED: the SQLite form misses a declared column.
dialectPrepared<ByKey, PeakRow>()({
  sqlite: (_db, t) =>
    // @ts-expect-error the sqlite form's row has no `seen`
    _db
      .select({ peak: sql<number>`MAX(${t.quotaWindows.peakPercent}, 0)` })
      .from(t.quotaWindows)
      .prepare(),
  pg: (_db, t) => peakSelect(t, sql<number>`GREATEST(${t.quotaWindows.peakPercent}, 0)`),
})

// REJECTED: a form that returns rows where the declaration says none.
dialectPrepared<ByKey, void>()({
  sqlite: (_db, t) => _db.update(t.quotaWindows).set({ label: 'x' }).prepare(),
  pg: (_db, t) =>
    // @ts-expect-error the pg form returns rows; the declaration says it yields none
    _db.update(t.quotaWindows).set({ label: 'x' }).returning().prepare(),
})

// A definition made with `prepared` for comparison: the single-source form.
void prepared((_db, t) => _db.select().from(t.quotaWindows).prepare())
