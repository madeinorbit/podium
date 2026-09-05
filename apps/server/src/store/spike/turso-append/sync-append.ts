/**
 * The change-log append, ported to the async driver [POD-3250].
 *
 * The original is `packages/sync/src/adapters/sqlite/sync-repository.ts:57-80`
 * and this is deliberately a LITERAL port of it: same chunk size, same derivation
 * of the seq range from `lastInsertRowid`, same row-by-row application of the
 * installed world inside the same transaction. The point of the proof is whether
 * THAT path keeps its contract over a network, so changing it while porting
 * would prove something else.
 *
 * WHAT THE CONTRACT IS, in one line: the seqs a single `appendChanges` returns
 * are contiguous, they continue contiguously from every previous append, and a
 * failure anywhere in the append leaves neither a row nor a consumed seq behind.
 * A replica that has seen seq N and then sees N+2 concludes it has missed a
 * change and re-bootstraps; a replica handed a REUSED seq concludes nothing at
 * all and silently diverges. The second is why `AUTOINCREMENT` is on the column
 * and why the rollback arm of this proof checks `sqlite_sequence` rather than
 * just checking that the rows are gone.
 *
 * TWO SHAPES, MEASURED AGAINST EACH OTHER. {@link appendChangesLiteral} issues
 * every statement on its own, which is what the synchronous code does and what
 * costs one network round trip per statement remotely. {@link appendChangesBatched}
 * has identical semantics and collapses each chunk into two driver calls. Both
 * are here because the number the prefetch design needs is the DIFFERENCE.
 */

import { and, asc, eq, getTableName, gt, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { DriverSession, SqlParam, Statement } from '../../executor/driver'
import type { SpikeTables } from './schema'

/**
 * The drizzle instance is a QUERY BUILDER here and never an executor.
 *
 * It is built over the same libsql client (`drizzle-orm/libsql/web`), so the SQL
 * is exactly what the shipping code would send — but every statement is issued
 * through the driver session instead of through drizzle's own connection,
 * because drizzle's `db.transaction()` calls `client.transaction()` with no mode
 * and the spec forbids relying on that default (§6 rule 7). Building with
 * drizzle and issuing through the port is what [E.5] does; this file is where
 * that combination is first proven against a real Turso database.
 */
export type QueryDb = LibSQLDatabase<Record<string, never>>

/** A row on its way into the log — the write shape, before a seq exists. */
export interface ChangeWriteRow {
  readonly entity: string
  readonly entityId: string
  readonly op: 'upsert' | 'remove'
  readonly payload: string | null
}

/**
 * A row read back out of the log.
 *
 * MAPPED, NEVER CAST, and the reason is a defect this proof produced and then
 * caught. drizzle's query builder emits the PHYSICAL column names — the select
 * above is `select "seq", "entity", "entity_id", ...` — so a row that comes back
 * through the driver is keyed `entity_id`, not `entityId`. Casting the driver's
 * rows to this interface therefore compiles, runs, and yields `undefined` for
 * every renamed column; the first version of this file did exactly that and a
 * proof quietly reported `false` for a contract the engine was in fact keeping.
 *
 * Only drizzle's own execution path applies the field mapping, and this slice
 * deliberately does not use it (spec §6 rule 7 — the transaction must be opened
 * through `client.transaction("write")`, not through drizzle). So the mapping is
 * a thing the driver has to do, and [E.5] inherits it: any router-based client
 * that hands drizzle-built SQL to a raw connection must map results back, or
 * every column whose TypeScript name differs from its SQL name reads as absent.
 */
export interface ChangeReadRow {
  readonly seq: number
  readonly entity: string
  readonly entityId: string
  readonly op: string
  readonly payload: string | null
}

/** Map one raw driver row onto the read shape, by physical column name. */
function mapChangeRow(row: unknown): ChangeReadRow {
  const r = row as Record<string, unknown>
  return {
    seq: Number(r.seq),
    entity: String(r.entity),
    entityId: String(r.entity_id),
    op: String(r.op),
    payload: (r.payload as string | null) ?? null,
  }
}

/** Map one raw `change_latest` row onto the same read shape. */
function mapLatestRow(row: unknown): ChangeReadRow {
  const r = row as Record<string, unknown>
  return {
    seq: Number(r.seq),
    entity: String(r.entity),
    entityId: String(r.entity_id),
    op: 'upsert',
    payload: (r.payload as string | null) ?? null,
  }
}

/**
 * The chunk size, unchanged from the synchronous code.
 *
 * 100 rows × 5 bound parameters stays under SQLite's conservative 999-parameter
 * builds. It is kept identical here because the contract under test is
 * specifically that seqs stay contiguous ACROSS chunk boundaries — a proof that
 * quietly used one chunk would never exercise the thing that can break.
 */
export const CHUNK_SIZE = 100

/**
 * drizzle types its bound parameters as `unknown[]`, so they are NARROWED here
 * rather than asserted.
 *
 * A value the driver cannot bind is a defect in the query above, and the throw
 * says which one — an assertion would hand the client an object and let it fail
 * later with a message about the transport instead.
 */
function toSqlParams(params: readonly unknown[], sqlText: string): SqlParam[] {
  return params.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    throw new Error(`unbindable parameter of type ${typeof value} in: ${sqlText}`)
  })
}

/** Turn a built drizzle query into the port's {@link Statement}. */
function statement(
  query: { toSQL(): { sql: string; params: unknown[] } },
  method: Statement['method'],
  intent: Statement['intent'],
): Statement {
  const built = query.toSQL()
  return { sql: built.sql, params: toSqlParams(built.params, built.sql), method, intent }
}

/**
 * The multi-row insert for one chunk, and the reason the seq range can be
 * derived from a single number.
 *
 * SQLite assigns rowids to a multi-row insert consecutively and reports the LAST
 * one, so `first = last - count + 1` names the whole range — but only if nothing
 * interleaved between the first row and the last. Inside `BEGIN IMMEDIATE` on
 * one connection, nothing can. The remote question this proof answers is whether
 * `lastInsertRowid` that arrives over hrana is this connection's last insert or
 * the database's, because those differ the moment a second client writes.
 */
function insertChunk(
  db: QueryDb,
  tables: SpikeTables,
  chunk: readonly ChangeWriteRow[],
  eventTime: number,
): Statement {
  const values = chunk.map((row) => ({
    entity: row.entity,
    entityId: row.entityId,
    op: row.op,
    payload: row.payload,
    eventTime,
  }))
  return statement(db.insert(tables.changes).values(values), 'run', 'write')
}

/**
 * Advance the installed world for one chunk, ROW BY ROW AND IN ORDER.
 *
 * Not a missed batching opportunity, for the same reason the synchronous code
 * gives: one batch may legitimately carry `upsert` then `remove` for one entity,
 * and grouping the two ops into bulk statements would apply them in op order
 * rather than log order — leaving the removed entity installed. Order is
 * preserved here even when the statements travel as one batch, because a libsql
 * batch executes its statements in the order given.
 */
function latestStatements(
  db: QueryDb,
  tables: SpikeTables,
  chunk: readonly ChangeWriteRow[],
  firstSeq: number,
): Statement[] {
  const out: Statement[] = []
  for (let i = 0; i < chunk.length; i++) {
    const row = chunk[i] as ChangeWriteRow
    // A payload-less upsert describes "this entity is not installed", which is
    // what the delete arm writes. Storing it would put a NULL in a NOT NULL
    // column; keeping the previous state would be worse, since the folded log
    // never showed it once a corrupt row landed on top.
    if (row.op === 'upsert' && row.payload !== null) {
      const insert = db
        .insert(tables.changeLatest)
        .values({
          entity: row.entity,
          entityId: row.entityId,
          seq: firstSeq + i,
          payload: row.payload,
        })
        .onConflictDoUpdate({
          target: [tables.changeLatest.entity, tables.changeLatest.entityId],
          set: { seq: sql`excluded.seq`, payload: sql`excluded.payload` },
        })
      out.push(statement(insert, 'run', 'write'))
    } else {
      const remove = db
        .delete(tables.changeLatest)
        .where(
          and(
            eq(tables.changeLatest.entity, row.entity),
            eq(tables.changeLatest.entityId, row.entityId),
          ),
        )
      out.push(statement(remove, 'run', 'write'))
    }
  }
  return out
}

function seqRangeFrom(lastInsertRowid: bigint | number, count: number): number {
  const last = Number(lastInsertRowid)
  return last - count + 1
}

/**
 * A hook the failure arm uses to throw between two chunks.
 *
 * A test seam, not a feature: the rollback proof needs the append to fail AFTER
 * a chunk has inserted and BEFORE the transaction commits, which is the only
 * window in which a partially-applied append could become visible. Nothing but a
 * test passes it.
 */
export type ChunkHook = (chunkIndex: number) => void | Promise<void>

export interface AppendOptions {
  readonly afterChunk?: ChunkHook
}

/**
 * THE LITERAL PORT — one driver call per statement.
 *
 * This is what the synchronous code does, made async. Remotely it costs
 * 1 (BEGIN) + per chunk (1 insert + one call per row) + 1 (COMMIT) round trips,
 * which is the number the results document reports as the naive cost.
 */
export async function appendChangesLiteral(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
  rows: readonly ChangeWriteRow[],
  eventTime: number,
  options: AppendOptions = {},
): Promise<number[]> {
  if (rows.length === 0) return []
  const seqs: number[] = []
  await session.begin('write')
  try {
    let chunkIndex = 0
    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      const chunk = rows.slice(start, start + CHUNK_SIZE)
      const result = await session.execute(insertChunk(db, tables, chunk, eventTime))
      if (!result.run) throw new Error('driver returned no run result for the change insert')
      const first = seqRangeFrom(result.run.lastInsertRowid, chunk.length)
      for (let i = 0; i < chunk.length; i++) seqs.push(first + i)
      for (const s of latestStatements(db, tables, chunk, first)) await session.execute(s)
      await options.afterChunk?.(chunkIndex)
      chunkIndex += 1
    }
    await session.commit()
    return seqs
  } catch (error) {
    await session.rollback()
    throw error
  }
}

/**
 * THE BATCHED FORM — two driver calls per chunk, identical semantics.
 *
 * The insert has to travel on its own because the `change_latest` statements
 * need the seq range it returns, and that range does not exist until the server
 * has answered. So the floor for this shape is two round trips per chunk, not
 * one, and no amount of batching removes the dependency. That is a fact [B0.6]'s
 * prefetch design needs: an append is not free even when perfectly batched.
 */
export async function appendChangesBatched(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
  rows: readonly ChangeWriteRow[],
  eventTime: number,
  options: AppendOptions = {},
): Promise<number[]> {
  if (rows.length === 0) return []
  const seqs: number[] = []
  await session.begin('write')
  try {
    let chunkIndex = 0
    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      const chunk = rows.slice(start, start + CHUNK_SIZE)
      const [result] = await session.executeBatch([insertChunk(db, tables, chunk, eventTime)])
      if (!result?.run) throw new Error('driver returned no run result for the change insert')
      const first = seqRangeFrom(result.run.lastInsertRowid, chunk.length)
      for (let i = 0; i < chunk.length; i++) seqs.push(first + i)
      await session.executeBatch(latestStatements(db, tables, chunk, first))
      await options.afterChunk?.(chunkIndex)
      chunkIndex += 1
    }
    await session.commit()
    return seqs
  } catch (error) {
    await session.rollback()
    throw error
  }
}

/**
 * The append run INSIDE a transaction the caller already opened, on a savepoint.
 *
 * This is the nested-publish shape POD-3260 found, and it exists here so the
 * proof can DETECT the failure rather than assume it away. The plain
 * {@link appendChangesLiteral} opens and commits its own transaction, so a
 * rollback there can never revoke a seq anyone has seen — the append's own
 * failure is the only way out. That is a comfortable case and not the dangerous
 * one.
 *
 * The dangerous one is this: the append SUCCEEDS, hands its seqs back to a
 * caller that may publish them, and only then does an ENCLOSING span roll back.
 * `sqlite_sequence` is transactional, so the counter goes back with it — and the
 * next unrelated change is issued a seq a replica has already been told about.
 * A replica holding that cursor treats the genuine change as one it has already
 * seen, so the stale row SUPPRESSES the correct one. That is worse than a gap:
 * a gap heals, and this does not.
 *
 * Nothing here fixes that, and the fix is not in the append — it is the rule
 * that seqs may not escape a span that can still roll back. What this function
 * buys is that the proof can show the reuse happening on the remote engine
 * instead of reasoning that it must.
 */
export async function appendChangesNested(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
  rows: readonly ChangeWriteRow[],
  eventTime: number,
  savepoint: string,
  options: AppendOptions = {},
): Promise<number[]> {
  if (rows.length === 0) return []
  const seqs: number[] = []
  await session.enterSavepoint(savepoint)
  try {
    let chunkIndex = 0
    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      const chunk = rows.slice(start, start + CHUNK_SIZE)
      const result = await session.execute(insertChunk(db, tables, chunk, eventTime))
      if (!result.run) throw new Error('driver returned no run result for the change insert')
      const first = seqRangeFrom(result.run.lastInsertRowid, chunk.length)
      for (let i = 0; i < chunk.length; i++) seqs.push(first + i)
      for (const s of latestStatements(db, tables, chunk, first)) await session.execute(s)
      await options.afterChunk?.(chunkIndex)
      chunkIndex += 1
    }
    await session.releaseSavepoint(savepoint)
    return seqs
  } catch (error) {
    await session.rollbackToSavepoint(savepoint)
    await session.releaseSavepoint(savepoint)
    throw error
  }
}

/**
 * THE HIGHEST SEQ EVER ASSIGNED, read from `sqlite_sequence`.
 *
 * Not `MAX(seq) FROM changes`, and the difference is the whole reason this read
 * exists: the log is head-pruned, so `MAX` over the retained rows falls
 * BACKWARDS after a prune and a cursor compared against it would replay changes
 * every replica already has. `sqlite_sequence` holds the high-water mark
 * independently of what is retained. 0 means the table has never been inserted
 * into — SQLite does not create the row until the first insert.
 */
export async function maxChangeSeq(
  session: DriverSession,
  tables: SpikeTables,
): Promise<number> {
  // The name is read off the drizzle table rather than spelled again, so the
  // lookup key and the table it asks about cannot drift apart [POD-3358]. This
  // is the statement most easily forgotten when a namespace is introduced: it
  // matches on a string LITERAL, so a stale one reads another run's counter and
  // reports a plausible number rather than failing.
  const result = await session.execute({
    sql: 'SELECT seq FROM sqlite_sequence WHERE name = ?',
    params: [getTableName(tables.changes)],
    method: 'get',
    intent: 'read',
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  // Absent row, not zero: SQLite does not create the `sqlite_sequence` entry
  // until the table's first insert, so "no row" and "head is 0" are the same
  // state and both mean the log has never been written to.
  return row === undefined || row.seq === null ? 0 : Number(row.seq)
}

/** The lowest RETAINED seq, or null when the log is empty. */
export async function minChangeSeq(
  session: DriverSession,
  tables: SpikeTables,
): Promise<number | null> {
  const result = await session.execute({
    sql: `SELECT MIN(seq) AS seq FROM ${getTableName(tables.changes)}`,
    params: [],
    method: 'get',
    intent: 'read',
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row === undefined || row.seq === null ? null : Number(row.seq)
}

/** Change rows with seq > cursor, in seq order — a plain range read. */
export async function changesSince(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
  cursor: number,
  limit = 10_000,
): Promise<ChangeReadRow[]> {
  const query = db
    .select()
    .from(tables.changes)
    .where(gt(tables.changes.seq, cursor))
    .orderBy(asc(tables.changes.seq))
    .limit(limit)
  const result = await session.execute(statement(query, 'all', 'read'))
  return result.rows.map(mapChangeRow)
}

/**
 * THE BOOTSTRAP READ — the installed world in seq order.
 *
 * One statement, and that is the point: a replica attaching reads the world as a
 * single scan of `change_latest` rather than by folding the log. Its round-trip
 * cost is therefore one, whatever the size of the result, which is the number
 * this proof reports beside the append's.
 */
export async function latestChangeStates(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
): Promise<ChangeReadRow[]> {
  const query = db
    .select()
    .from(tables.changeLatest)
    .orderBy(asc(tables.changeLatest.seq))
  const result = await session.execute(statement(query, 'all', 'read'))
  return result.rows.map(mapLatestRow)
}
