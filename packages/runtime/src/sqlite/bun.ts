import { createRequire } from 'node:module'
import type { OpenOptions, SqlDatabase } from './types'

// Lazy require of `bun:sqlite` (sync, so openDatabase stays sync). Only resolved when
// the Bun adapter is selected — so this module is import-safe under Node, where
// `bun:sqlite` does not exist.
const requireBuiltin = createRequire(import.meta.url)

interface BunStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface BunDb {
  prepare(sql: string): BunStatement
  exec(sql: string): void
  close(): void
}
type BunCtor = new (path: string, options?: { readonly?: boolean; create?: boolean }) => BunDb

let Ctor: BunCtor | undefined
function database(): BunCtor {
  if (!Ctor) {
    Ctor = (requireBuiltin('bun:sqlite') as { Database: BunCtor }).Database
  }
  return Ctor
}

/**
 * The raw `bun:sqlite` Database behind each `SqlDatabase` we hand out, so a
 * consumer that needs the native handle (the drizzle migrator, which wants
 * `drizzle({ client })` on the SAME connection) can retrieve it without widening
 * the runtime-neutral interface. A WeakMap keeps this off the public shape and
 * lets the entry drop when the wrapper is GC'd.
 */
const rawByWrapper = new WeakMap<SqlDatabase, BunDb>()

/** The native `bun:sqlite` Database backing `db`, or undefined if it isn't bun-backed. */
export function bunSqliteClient(db: SqlDatabase): BunDb | undefined {
  return rawByWrapper.get(db)
}

export function openBunDatabase(path: string, opts?: OpenOptions): SqlDatabase {
  // bun:sqlite: `readonly` (lowercase), and read-write must opt into file creation.
  const db = opts?.readOnly
    ? new (database())(path, { readonly: true })
    : new (database())(path, { create: true })
  const wrapper: SqlDatabase = {
    prepare(sql) {
      const st = db.prepare(sql)
      return {
        run: (...p) => st.run(...p),
        // Normalize bun's no-row sentinel to undefined (node:sqlite returns undefined).
        get: (...p) => {
          const row = st.get(...p)
          return row === null ? undefined : row
        },
        all: (...p) => st.all(...p),
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
  rawByWrapper.set(wrapper, db)
  return wrapper
}
