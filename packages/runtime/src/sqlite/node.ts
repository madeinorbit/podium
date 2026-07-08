import { createRequire } from 'node:module'
import type { OpenOptions, SqlDatabase } from './types.js'

// Load `node:sqlite` via createRequire(runtime string), never a static import:
//   1. bundlers (tsup/esbuild) rewrite a static `node:sqlite` import to bare `sqlite`,
//      which doesn't exist — making the emitted dist unloadable.
//   2. a top-level `import 'node:sqlite'` would execute (and throw) under Bun, which
//      has no node:sqlite. Lazy-loading here keeps this module import-safe everywhere;
//      it is only resolved when the Node adapter is actually selected.
const requireBuiltin = createRequire(import.meta.url)

interface NodeStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface NodeDb {
  prepare(sql: string): NodeStatement
  exec(sql: string): void
  close(): void
}
type NodeCtor = new (path: string, options?: { readOnly?: boolean }) => NodeDb

let Ctor: NodeCtor | undefined
function databaseSync(): NodeCtor {
  if (!Ctor) {
    Ctor = (requireBuiltin('node:sqlite') as { DatabaseSync: NodeCtor }).DatabaseSync
  }
  return Ctor
}

export function openNodeDatabase(path: string, opts?: OpenOptions): SqlDatabase {
  // node:sqlite rejects `undefined` as the options arg — omit it entirely when default.
  const Ctor = databaseSync()
  const db = opts?.readOnly ? new Ctor(path, { readOnly: true }) : new Ctor(path)
  return {
    prepare(sql) {
      const st = db.prepare(sql)
      return {
        run: (...p) => st.run(...p),
        get: (...p) => st.get(...p),
        all: (...p) => st.all(...p),
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}
