/**
 * A REPOSITORY UNDER TEST, WITH ITS CHANGE CAPTURE DROPPED ON POSTGRES [POD-6983,
 * POD-6958 design 2.5].
 *
 * On SQLite a repository test's database has no capture triggers until a change log
 * attaches, so a write reaches the tables and nothing else. On Postgres the capture is
 * part of every write statement on a source table (`sync/capture-pg.ts`), and the
 * baseline's fail-closed guard refuses to commit a transaction that leaves capture rows
 * undrained. In production the commit layer drains them; a repository test has no commit
 * layer, so on Postgres {@link drainedRepository} runs each method call in one
 * transaction that drops what the call captured before it commits, as `seedRows` does
 * for a fixture on SQLite. The rows the call wrote are the test's subject; the captured
 * changes are the record layer's (`sync/capture-pg.test.ts` tests those).
 *
 * On SQLite it returns the repository itself, so the SQLite leg runs exactly what it
 * ran before. An async generator method (a page reader) only reads and is called as it
 * is.
 */

import { gt, sql } from 'drizzle-orm'
import { type StoreDrizzle, type StoreTables, storeTables } from '../store/executor/sync-drizzle'
import type { SliceStore } from './pg-slice-tables'

/** Drop every capture row past `after`, inside the open transaction. */
async function dropCapture(slice: SliceStore, after: number): Promise<void> {
  const db = slice.queries.rootDb
  const t = storeTables(db)
  await db.delete(t.syncCapture).where(gt(t.syncCapture.id, after)).prepare().run()
}

/** The newest capture row's id, or 0. */
async function captureHead(slice: SliceStore): Promise<number> {
  const db = slice.queries.rootDb
  const t = storeTables(db)
  const row = await db
    .select({ head: sql<number>`coalesce(max(${t.syncCapture.id}), 0)`.mapWith(Number) })
    .from(t.syncCapture)
    .prepare()
    .get()
  return row?.head ?? 0
}

/** Run `write` in one transaction of the slice's workspace whose capture is dropped. */
export async function drainedWrite<T>(slice: SliceStore, write: () => Promise<T>): Promise<T> {
  if (slice.engine !== 'pg') return await write()
  return await slice.queries.createOrJoinTransaction(async () => {
    const mark = await captureHead(slice)
    const result = await write()
    await dropCapture(slice, mark)
    return result
  })
}

/** `repository` with each method call in a {@link drainedWrite} on Postgres; itself on SQLite. */
export function drainedRepository<R extends object>(slice: SliceStore, repository: R): R {
  if (slice.engine !== 'pg') return repository
  return new Proxy(repository, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      if (method.constructor.name === 'AsyncGeneratorFunction') return method.bind(target)
      return (...args: unknown[]) =>
        drainedWrite(slice, async () => await method.apply(target, args))
    },
  })
}

/**
 * Write a fixture row the repository cannot produce (a corrupt value, a hand edit),
 * through the store's own tables on the run's engine, in one {@link drainedWrite}.
 * `build` returns a prepared statement; it runs with no values.
 */
export async function seedSliceRow(
  slice: SliceStore,
  build: (db: StoreDrizzle, t: StoreTables) => { run(): Promise<unknown> },
): Promise<void> {
  await drainedWrite(slice, async () => {
    const db = slice.queries.rootDb
    await build(db, storeTables(db)).run()
  })
}
