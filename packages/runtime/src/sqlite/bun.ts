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
  /** `sqlite3_serialize` — the database's whole page image as a fresh buffer. */
  serialize(): Uint8Array
}
type BunCtor = (new (
  path: string,
  options?: { readonly?: boolean; create?: boolean },
) => BunDb) & {
  /** `sqlite3_deserialize` — a NEW in-memory database holding a COPY of `image`. */
  deserialize(image: Uint8Array, readOnly?: boolean): BunDb
}

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

/**
 * Carry the raw-handle registration from a wrapper onto a wrapper OF that wrapper,
 * so decorating a database (POD-1630's query attribution) does not cost the drizzle
 * migrator the native handle it resolves by wrapper identity. A no-op when
 * `original` was not bun-backed, which keeps this safe to call unconditionally.
 */
export function aliasBunSqliteClient(original: SqlDatabase, alias: SqlDatabase): void {
  const raw = rawByWrapper.get(original)
  if (raw) rawByWrapper.set(alias, raw)
}

export function openBunDatabase(path: string, opts?: OpenOptions): SqlDatabase {
  // bun:sqlite: `readonly` (lowercase), and read-write must opt into file creation.
  const db = opts?.readOnly
    ? new (database())(path, { readonly: true })
    : new (database())(path, { create: true })
  return wrap(db)
}

/**
 * A NEW in-memory database built from a page image produced by `serializeBunDatabase`.
 *
 * `sqlite3_deserialize` COPIES the image, so the source buffer is neither aliased nor
 * mutated by later writes: one image can seed any number of independent databases.
 * That is what makes it usable as a test fixture — see apps/server's pre-migrated
 * store fixture, which clones a fully-migrated schema instead of replaying the chain.
 */
export function deserializeBunDatabase(image: Uint8Array): SqlDatabase {
  return wrap(database().deserialize(image))
}

/** This database's whole page image — the input `deserializeBunDatabase` takes. */
export function serializeBunDatabase(db: SqlDatabase): Uint8Array | undefined {
  return rawByWrapper.get(db)?.serialize()
}

function wrap(db: BunDb): SqlDatabase {
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
