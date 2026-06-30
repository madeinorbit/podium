/**
 * EXPERIMENTAL synchronous Postgres adapter implementing the same `SqlDatabase`
 * surface as the SQLite adapters — so `SessionStore` (which is written against a
 * *synchronous* SQLite API) can run on Postgres with ZERO changes to its 1300
 * lines of query code.
 *
 * Postgres clients are normally async (network I/O). To stay synchronous we call
 * libpq's BLOCKING `PQexec` directly through `bun:ffi`. Parameters are inlined
 * as escaped string literals (via `PQescapeLiteral`), which Postgres treats as
 * untyped literals and coerces to each column's type — mirroring SQLite's
 * permissive typing — so we avoid the async wire protocol and parameter-array
 * marshalling entirely.
 *
 * A small SQL rewriter bridges the dialects (placeholders, PRAGMA, sqlite_master,
 * AUTOINCREMENT, INSERT OR IGNORE/REPLACE, rowid). This is enough for "boot +
 * basic ops" — it is NOT a production-grade SQLite-on-Postgres shim.
 */
import { CString, dlopen, FFIType, ptr } from 'bun:ffi'
import type { OpenOptions, SqlDatabase, SqlParam, SqlRunResult, SqlStatement } from '../sqlite/types.js'

// PGresult status codes we care about.
const PGRES_COMMAND_OK = 1
const PGRES_TUPLES_OK = 2

// Type OIDs that should come back to JS as numbers (everything else stays text,
// matching how SessionStore consumes TEXT columns as strings + INTEGER as numbers).
const INT_OIDS = new Set([20, 21, 23, 26]) // int8, int2, int4, oid
const FLOAT_OIDS = new Set([700, 701]) // float4, float8
const BOOL_OID = 16

function loadLibpq(libpqPath: string) {
  return dlopen(libpqPath, {
    PQconnectdb: { args: [FFIType.ptr], returns: FFIType.ptr },
    PQstatus: { args: [FFIType.ptr], returns: FFIType.i32 },
    PQerrorMessage: { args: [FFIType.ptr], returns: FFIType.ptr },
    PQfinish: { args: [FFIType.ptr], returns: FFIType.void },
    PQexec: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    PQresultStatus: { args: [FFIType.ptr], returns: FFIType.i32 },
    PQresultErrorMessage: { args: [FFIType.ptr], returns: FFIType.ptr },
    PQntuples: { args: [FFIType.ptr], returns: FFIType.i32 },
    PQnfields: { args: [FFIType.ptr], returns: FFIType.i32 },
    PQfname: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    PQftype: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    PQgetvalue: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
    PQgetisnull: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    PQcmdTuples: { args: [FFIType.ptr], returns: FFIType.ptr },
    PQclear: { args: [FFIType.ptr], returns: FFIType.void },
    PQescapeLiteral: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    PQfreemem: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols
}

type Libpq = ReturnType<typeof loadLibpq>

const cbuf = (s: string): Uint8Array => new TextEncoder().encode(`${s}\0`)
/** Read a libpq `char*` return (a pointer) into a JS string; null pointer -> ''. */
const readStr = (p: number | bigint): string => (p ? new CString(Number(p)).toString() : '')

/** Inline a single param as a Postgres literal (escaped). null -> NULL. */
function literal(pq: Libpq, conn: number, p: SqlParam): string {
  if (p === null || p === undefined) return 'NULL'
  if (typeof p === 'boolean') return p ? "'1'" : "'0'"
  if (p instanceof Uint8Array) throw new Error('postgres adapter: bytea params not supported in experiment')
  // Numbers/bigints AND strings are all quoted: a quoted literal is "unknown"
  // typed in Postgres and coerces to the target column type (int/text/...),
  // which mirrors SQLite's loose typing.
  const s = typeof p === 'string' ? p : String(p)
  const buf = cbuf(s)
  const out = pq.PQescapeLiteral(conn, ptr(buf), BigInt(buf.length - 1))
  if (!out) throw new Error(`postgres adapter: PQescapeLiteral failed: ${readStr(pq.PQerrorMessage(conn))}`)
  const lit = readStr(out)
  pq.PQfreemem(out)
  return lit
}

/** Replace each `?` placeholder (outside string literals) with the next param literal. */
function inlineParams(pq: Libpq, conn: number, sql: string, params: SqlParam[]): string {
  let out = ''
  let i = 0
  let inStr = false
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c]
    if (inStr) {
      out += ch
      if (ch === "'") inStr = sql[c + 1] === "'" ? (out += sql[++c], true) : false
      continue
    }
    if (ch === "'") {
      inStr = true
      out += ch
      continue
    }
    if (ch === '?') {
      out += literal(pq, conn, params[i++])
      continue
    }
    out += ch
  }
  return out
}

/**
 * Rewrite the SQLite SQL SessionStore emits into Postgres-compatible SQL.
 * Deliberately small + targeted at the exact constructs store.ts uses.
 */
export function translateSql(sql: string): string {
  let s = sql
  // PRAGMA table_info(X) -> column list from information_schema (returns `name`).
  const ti = s.match(/^\s*PRAGMA\s+table_info\(\s*([a-zA-Z_][\w]*)\s*\)\s*$/i)
  if (ti) {
    return `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='${ti[1]}'`
  }
  // Other PRAGMAs (journal_mode, busy_timeout, ...) are no-ops on Postgres.
  if (/^\s*PRAGMA\b/i.test(s)) return 'SELECT 1 WHERE false'
  // BEGIN IMMEDIATE (SQLite) -> BEGIN.
  s = s.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN')
  // INTEGER PRIMARY KEY AUTOINCREMENT -> identity column.
  s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
  // INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING (target-less catch-all).
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(s)) {
    s = s.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT')
    s = `${s.trimEnd().replace(/;?\s*$/, '')} ON CONFLICT DO NOTHING`
  }
  // INSERT OR REPLACE INTO t (c1, c2, ...) -> ON CONFLICT (c1) DO UPDATE SET c2=excluded.c2,...
  const repl = s.match(/\bINSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z_][\w]*)\s*\(([^)]*)\)/i)
  if (repl) {
    s = s.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'INSERT')
    const cols = repl[2].split(',').map((c) => c.trim())
    const key = cols[0]
    const sets = cols.slice(1).map((c) => `${c}=excluded.${c}`).join(', ')
    const conflict = sets ? `ON CONFLICT (${key}) DO UPDATE SET ${sets}` : 'ON CONFLICT DO NOTHING'
    s = `${s.trimEnd().replace(/;?\s*$/, '')} ${conflict}`
  }
  // sqlite_master (table catalog) -> a pg_tables-backed subquery exposing `name`/`type`.
  s = s.replace(
    /\bsqlite_master\b/gi,
    "(SELECT tablename AS name, 'table' AS type FROM pg_tables WHERE schemaname='public') AS sqlite_master",
  )
  // rowid (no Postgres equivalent) -> ctid (physical order ≈ insertion order).
  s = s.replace(/\browid\b/gi, 'ctid')
  return s
}

function coerce(pq: Libpq, res: number, row: number, col: number, oid: number): unknown {
  if (pq.PQgetisnull(res, row, col)) return null
  const raw = readStr(pq.PQgetvalue(res, row, col))
  if (oid === BOOL_OID) return raw === 't'
  if (INT_OIDS.has(oid)) {
    const n = Number(raw)
    return Number.isSafeInteger(n) ? n : BigInt(raw)
  }
  if (FLOAT_OIDS.has(oid)) return Number(raw)
  return raw
}

class PgError extends Error {}

export function openPostgresDatabase(connString: string, opts?: OpenOptions & { libpq?: string }): SqlDatabase {
  const libpqPath = opts?.libpq ?? process.env.PODIUM_PG_LIBPQ
  if (!libpqPath) throw new Error('openPostgresDatabase: pass opts.libpq or set PODIUM_PG_LIBPQ to libpq.so')
  const pq = loadLibpq(libpqPath)

  const connBuf = cbuf(connString)
  const conn = pq.PQconnectdb(ptr(connBuf))
  if (!conn) throw new PgError('PQconnectdb returned null')
  if (pq.PQstatus(conn) !== 0) {
    const msg = readStr(pq.PQerrorMessage(conn))
    pq.PQfinish(conn)
    throw new PgError(`postgres connection failed: ${msg}`)
  }

  /** Run a final (already-translated, already-inlined) SQL string. */
  function execRaw(sql: string): number {
    const buf = cbuf(sql)
    const res = pq.PQexec(conn, ptr(buf))
    if (!res) throw new PgError(`PQexec null for: ${sql.slice(0, 120)}`)
    const st = pq.PQresultStatus(res)
    if (st !== PGRES_COMMAND_OK && st !== PGRES_TUPLES_OK) {
      const msg = readStr(pq.PQresultErrorMessage(res))
      pq.PQclear(res)
      throw new PgError(`${msg.trim()} :: ${sql.slice(0, 200)}`)
    }
    return res
  }

  function rowsFrom(res: number): Record<string, unknown>[] {
    const nrows = pq.PQntuples(res)
    const ncols = pq.PQnfields(res)
    const names: string[] = []
    const oids: number[] = []
    for (let c = 0; c < ncols; c++) {
      names.push(readStr(pq.PQfname(res, c)))
      oids.push(pq.PQftype(res, c))
    }
    const out: Record<string, unknown>[] = []
    for (let r = 0; r < nrows; r++) {
      const obj: Record<string, unknown> = {}
      for (let c = 0; c < ncols; c++) obj[names[c]] = coerce(pq, res, r, c, oids[c])
      out.push(obj)
    }
    return out
  }

  function prepare(sql: string): SqlStatement {
    const translated = translateSql(sql)
    const isInsert = /^\s*INSERT\b/i.test(translated)
    const run = (...params: SqlParam[]): SqlRunResult => {
      const final = inlineParams(pq, conn, translated, params)
      const res = execRaw(final)
      const changes = Number(readStr(pq.PQcmdTuples(res)) || "0")
      pq.PQclear(res)
      let lastInsertRowid: number | bigint = 0
      if (isInsert) {
        try {
          const r2 = execRaw('SELECT lastval()')
          const rows = rowsFrom(r2)
          pq.PQclear(r2)
          lastInsertRowid = (rows[0]?.lastval as number | bigint) ?? 0
        } catch {
          // no sequence touched in this session yet — leave 0
        }
      }
      return { changes: Number.isNaN(changes) ? 0 : changes, lastInsertRowid }
    }
    return {
      run,
      get: (...params: SqlParam[]) => {
        const res = execRaw(inlineParams(pq, conn, translated, params))
        const rows = rowsFrom(res)
        pq.PQclear(res)
        return rows[0]
      },
      all: (...params: SqlParam[]) => {
        const res = execRaw(inlineParams(pq, conn, translated, params))
        const rows = rowsFrom(res)
        pq.PQclear(res)
        return rows
      },
    }
  }

  return {
    prepare,
    exec: (sql: string) => {
      const res = execRaw(translateSql(sql))
      pq.PQclear(res)
    },
    close: () => pq.PQfinish(conn),
  }
}
