// workspace-scoped (POD-6959)
import { asMachineId, type MachineId } from '@podium/model'
import { and, eq, gt, type SQL, sql } from 'drizzle-orm'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { dialectOf } from '../executor/dialect-prepared'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from '../executor/sync-drizzle'
import {
  executeRaw,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  WORKSPACE,
} from '../executor/sync-drizzle'
import { withoutNul } from '../messages'
import { onSqliteOnly, transcriptHeadline, tsqueryOf } from './search-pg'

// Every query this repository runs, prepared once per store [POD-6147].
// `transcript_fts` is the virtual table this port owns; there is no schema
// model to build against, so its statements stay whole raw SQL.
//
// ON POSTGRES the rows are in the plain table `transcript_text`, which the
// baseline made with a generated `tsvector` and its own `workspace_id`
// (`migrations/pg/pg-only-tables.ts`, `search-pg.ts`): a row, a read, a delete
// and a search are held to the workspace by that column, so there is no key
// table, no catch-up and no FTS5 table to make. The statements that exist only
// for those are SQLite only ({@link sqliteOnly}).

const TRANSCRIPT_TABLE = 'transcript_text'
const sqliteOnly = (db: StoreDrizzle, statement: SQL): SQL =>
  onSqliteOnly(db, TRANSCRIPT_TABLE, statement)

/** One segment by its key, over the `machineId` / `nativeId` placeholders, in the workspace. */
const segmentKey = (t: StoreTables) =>
  inWorkspace(
    t.conversationSegments,
    eq(t.conversationSegments.machineId, param(t.conversationSegments.machineId, 'machineId')),
    eq(t.conversationSegments.nativeId, param(t.conversationSegments.nativeId, 'nativeId')),
  )

const createTranscriptFts = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        content, machine_id UNINDEXED, native_id UNINDEXED, item_uuid UNINDEXED, ts UNINDEXED)`,
    ),
  ),
)

/*
 * WHICH SEGMENT, OF WHICH WORKSPACE, EACH FTS ROW BELONGS TO, KEYED [POD-6173,
 * POD-6959 design 2.6]. FTS5 indexes only what MATCH searches, so
 * `WHERE machine_id = ? AND native_id = ?` on
 * `transcript_fts` read every transcript row of every segment; dropping one
 * segment's rows on each re-mirror did that. `transcript_fts_keys` names the
 * segment of every FTS row by its rowid, and its segment index is what those
 * reads and deletes seek.
 *
 * Every write below changes both tables in one transaction. FTS5 tables take
 * no triggers, so nothing else could keep them in step. The keys are made with
 * the FTS table, at runtime when search is on, and {@link catchUpKeys} adds the
 * key of every FTS row past the last keyed one when the index opens: all of
 * them the first time, after that the rows a build from before this table
 * appended, normally none.
 *
 * `transcript_fts` is one table for every workspace; `workspace_id` here is
 * what holds a search, a read and a delete to one workspace's rows. A key table
 * made before the column existed is REPLACED when the index opens (`drop`, then
 * `table`), not altered: its rows say nothing of their workspace, so each would
 * be keyed again anyway, and {@link catchUpKeys} derives every key from
 * `transcript_fts` (all of them, for the workspace that owns each row). An
 * `ADD COLUMN` would also need a default the final table must not have, and the
 * query-plan audit cannot compile it against a table that has the column.
 */
const createTranscriptKeys = preparedFamily((db, _t, step: 'table' | 'drop') =>
  db.run(
    sqliteOnly(
      db,
      step === 'table'
        ? sql`CREATE TABLE IF NOT EXISTS transcript_fts_keys (
        fts_rowid INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL,
        native_id TEXT NOT NULL)`
        : sql`DROP TABLE transcript_fts_keys`,
    ),
  ),
)

/** Whether the key table has its `workspace_id` column: 1 or 0. */
const keysWorkspaceColumn = prepared((db) =>
  db.all<{ present: number }>(
    sqliteOnly(
      db,
      sql`SELECT count(*) AS present FROM pragma_table_info('transcript_fts_keys')
      WHERE name = 'workspace_id'`,
    ),
  ),
)

/**
 * Every read and delete of the keys names its workspace first, so the segment index leads with
 * it (design 2.3). The keys migration (POD-7024) dropped the index of the same name that began
 * with `machine_id`, so on an upgraded database this creates the new one.
 */
const createTranscriptKeysIndex = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`CREATE INDEX IF NOT EXISTS idx_transcript_fts_keys_segment
        ON transcript_fts_keys (workspace_id, machine_id, native_id)`,
    ),
  ),
)

/**
 * Key FTS rows to this workspace: every row (`all|…`, right after the key table
 * was made again with its workspace column) or the rows past this workspace's
 * last key (`after-last|…`, a rowid range of `transcript_fts`).
 *
 * WHICH ROWS ARE THIS WORKSPACE'S. `transcript_fts` holds every workspace's
 * rows and says nothing of whose they are.
 *   - `…|owned`: a row whose segment (`machine_id`, `native_id`) this workspace
 *     holds. Every workspace but the self-hosted one keys these only, so a row is
 *     never keyed to a workspace that does not hold its segment.
 *   - `…|every`: every row, the self-hosted workspace's (POD-7022 review). FTS5
 *     exists only on the SQLite engine, and a SQLite install is self-hosted: one
 *     workspace, which owns every row, including those whose segment row is gone
 *     (they matched a search before the workspace column, and still do).
 *
 * NEVER ANOTHER WORKSPACE'S ROW (POD-7022's second note, closed by POD-7024). The key is the
 * FTS rowid alone, which is unique across workspaces because the FTS table is shared, so a
 * row keyed already belongs to the workspace that keyed it: `OR IGNORE` leaves it there. With
 * `OR REPLACE`, the self-hosted workspace's `every` catch-up would have taken the rows of any
 * other workspace on the same database past its own last key.
 */
type CatchUpShape = `${'all' | 'after-last'}|${'owned' | 'every'}`
const catchUpKeys = preparedFamily((db, _t, shape: CatchUpShape) =>
  db.run(sqliteOnly(db, catchUpKeysSql(shape))),
)
function catchUpKeysSql(shape: CatchUpShape): SQL {
  const [range, rows] = shape.split('|')
  const terms: SQL[] = []
  if (range === 'after-last') {
    terms.push(sql`f.rowid > (SELECT coalesce(max(k.fts_rowid), 0) FROM transcript_fts_keys k
          WHERE k.workspace_id = ${WORKSPACE})`)
  }
  if (rows === 'owned') {
    terms.push(sql`EXISTS (SELECT 1 FROM conversation_segments s
          WHERE s.workspace_id = ${WORKSPACE} AND s.machine_id = f.machine_id AND s.native_id = f.native_id)`)
  }
  const where = terms.length === 0 ? sql`` : sql` WHERE ${sql.join(terms, sql` AND `)}`
  return sql`INSERT OR IGNORE INTO transcript_fts_keys (fts_rowid, workspace_id, machine_id, native_id)
        SELECT f.rowid, ${WORKSPACE}, f.machine_id, f.native_id FROM transcript_fts f${where}`
}

const segmentsBehindMirror = prepared((db, t) =>
  db
    .select({
      nativeId: t.conversationSegments.nativeId,
      mirroredBytes: t.conversationSegments.mirroredBytes,
      indexedBytes: t.conversationSegments.indexedBytes,
    })
    .from(t.conversationSegments)
    .where(
      inWorkspace(
        t.conversationSegments,
        eq(t.conversationSegments.machineId, param(t.conversationSegments.machineId, 'machineId')),
        gt(t.conversationSegments.mirroredBytes, t.conversationSegments.indexedBytes),
      ),
    )
    .prepare(),
)

const segmentIndexedCursor = prepared((db, t) =>
  db
    .select({ indexedBytes: t.conversationSegments.indexedBytes })
    .from(t.conversationSegments)
    .where(segmentKey(t))
    .prepare(),
)

/** One transcript row: into `transcript_fts` on SQLite (its key follows), `transcript_text` on Postgres. */
const insertTranscriptRow = prepared((db) =>
  dialectOf(db) === 'pg'
    ? db.run(
        sql`INSERT INTO transcript_text (workspace_id,machine_id,native_id,item_uuid,ts,content)
              VALUES(${WORKSPACE},${sql.placeholder('machineId')},${sql.placeholder('nativeId')},${sql.placeholder('itemUuid')},${sql.placeholder('ts')},${sql.placeholder('content')})`,
      )
    : db.run(
        sql`INSERT INTO transcript_fts (content,machine_id,native_id,item_uuid,ts)
              VALUES(${sql.placeholder('content')},${sql.placeholder('machineId')},${sql.placeholder('nativeId')},${sql.placeholder('itemUuid')},${sql.placeholder('ts')})`,
      ),
)

/**
 * The key of the FTS row the previous statement inserted. Run right after
 * {@link insertTranscriptRow} in the same write transaction, so nothing can
 * insert between the two. REPLACE: a key left behind by a build from before
 * this table, whose FTS row was deleted and its rowid reused, is stale.
 */
const insertTranscriptKey = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`INSERT OR REPLACE INTO transcript_fts_keys (fts_rowid, workspace_id, machine_id, native_id)
              VALUES(last_insert_rowid(),${WORKSPACE},${sql.placeholder('machineId')},${sql.placeholder('nativeId')})`,
    ),
  ),
)

const setSegmentIndexedBytes = prepared((db, t) =>
  db
    .update(t.conversationSegments)
    .set({ indexedBytes: sql.placeholder('indexedBytes') })
    .where(segmentKey(t))
    .prepare(),
)

const resetSegmentIfAt = prepared((db, t) =>
  db
    .update(t.conversationSegments)
    .set({ mirroredBytes: 0, mirroredAt: null, indexedBytes: 0 })
    .where(
      and(
        segmentKey(t),
        eq(
          t.conversationSegments.mirroredBytes,
          param(t.conversationSegments.mirroredBytes, 'mirroredBytes'),
        ),
        eq(
          t.conversationSegments.indexedBytes,
          param(t.conversationSegments.indexedBytes, 'indexedBytes'),
        ),
      ),
    )
    .prepare(),
)

/** One segment's keys, over the `machineId` / `nativeId` placeholders, in the workspace. */
const segmentKeys = () =>
  sql`SELECT fts_rowid FROM transcript_fts_keys
      WHERE workspace_id=${WORKSPACE} AND machine_id=${sql.placeholder('machineId')} AND native_id=${sql.placeholder('nativeId')}`

/** One segment of the workspace in `transcript_text` (Postgres), over the same placeholders. */
const textSegment = () =>
  sql`f.workspace_id=${WORKSPACE} AND f.machine_id=${sql.placeholder('machineId')} AND f.native_id=${sql.placeholder('nativeId')}`

/**
 * One segment's FTS rows, each found by rowid; then {@link deleteTranscriptKeys}.
 * On Postgres the segment's rows, through `idx_transcript_text_segment`.
 */
const deleteTranscriptRows = prepared((db) =>
  dialectOf(db) === 'pg'
    ? db.run(sql`DELETE FROM transcript_text f WHERE ${textSegment()}`)
    : db.run(sql`DELETE FROM transcript_fts WHERE rowid IN (${segmentKeys()})`),
)

const deleteTranscriptKeys = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`DELETE FROM transcript_fts_keys
      WHERE workspace_id=${WORKSPACE} AND machine_id=${sql.placeholder('machineId')} AND native_id=${sql.placeholder('nativeId')}`,
    ),
  ),
)

/**
 * One segment's rows in insertion order, each found by rowid from its key. On
 * Postgres in `id` order, the insertion order the identity gives.
 */
const transcriptRowsOf = prepared((db) =>
  dialectOf(db) === 'pg'
    ? db.all<Record<string, unknown>>(
        sql`SELECT f.content,f.item_uuid,f.ts FROM transcript_text f WHERE ${textSegment()} ORDER BY f.id`,
      )
    : db.all<Record<string, unknown>>(
        sql`SELECT f.content,f.item_uuid,f.ts FROM transcript_fts_keys k
      CROSS JOIN transcript_fts f ON f.rowid=k.fts_rowid
      WHERE k.workspace_id=${WORKSPACE} AND k.machine_id=${sql.placeholder('machineId')} AND k.native_id=${sql.placeholder('nativeId')}
      ORDER BY k.fts_rowid`,
      ),
)

/**
 * The matches of the `fts` placeholder in this workspace's rows. The FTS table
 * is every workspace's, so each match is held to the workspace through its key
 * (an FTS row with no key of this workspace never matches); CROSS JOIN keeps the
 * MATCH the outer loop, each key found by its rowid.
 */
const searchTranscripts = prepared((db) =>
  dialectOf(db) === 'pg'
    ? searchTranscriptText(db)
    : db.all<Record<string, unknown>>(
        sql`SELECT f.machine_id,f.native_id,f.item_uuid,f.ts,
      snippet(transcript_fts,0,'**','**','…',12) AS snip, bm25(transcript_fts) AS rank,
      s.podium_id,c.title,c.name,c.updated_at
      FROM transcript_fts f
      CROSS JOIN transcript_fts_keys k ON k.fts_rowid=f.rowid
      LEFT JOIN conversation_segments s ON s.workspace_id=k.workspace_id
        AND s.machine_id=f.machine_id AND s.native_id=f.native_id
      LEFT JOIN conversations c ON c.workspace_id=k.workspace_id AND c.id=f.native_id
      WHERE k.workspace_id=${WORKSPACE} AND transcript_fts MATCH ${sql.placeholder('fts')} ORDER BY rank`,
      ),
)

/**
 * {@link searchTranscripts} on Postgres: the `tsquery` `fts` (`search-pg.ts`)
 * against the generated vector, through its GIN index, held to the workspace by
 * the row's own `workspace_id`. The rank is `ts_rank_cd` negated, so the best
 * match sorts first as `bm25`'s does on SQLite (lower is better), ties in
 * insertion order; the snippet is `ts_headline`'s.
 */
const searchTranscriptText = (db: StoreDrizzle) =>
  db.all<Record<string, unknown>>(
    sql`SELECT f.machine_id,f.native_id,f.item_uuid,f.ts,
      ${transcriptHeadline()} AS snip, -ts_rank_cd(f.search, q) AS rank,
      s.podium_id,c.title,c.name,c.updated_at
      FROM transcript_text f
      CROSS JOIN to_tsquery('simple', ${sql.placeholder('fts')}) AS q
      LEFT JOIN conversation_segments s ON s.workspace_id=f.workspace_id
        AND s.machine_id=f.machine_id AND s.native_id=f.native_id
      LEFT JOIN conversations c ON c.workspace_id=f.workspace_id AND c.id=f.native_id
      WHERE f.workspace_id=${WORKSPACE} AND f.search @@ q ORDER BY rank, f.id`,
  )

export interface TranscriptSearchCandidate {
  machineId: MachineId
  nativeId: string
  itemUuid?: string
  ts?: string
  snippet: string
  rank: number
  podiumId?: string
  title?: string
  updatedAt?: string
}

/** Mirror-fed transcript FTS rows and their durable byte cursors. */
export class TranscriptIndexRepository {
  private available = false
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  /** Whether this is the self-hosted workspace, which keys every FTS row (see {@link catchUpKeys}). */
  private readonly ownsEveryRow: boolean

  /** Whether this store is on Postgres, whose rows carry their workspace (`transcript_text`). */
  private readonly pg: boolean

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.ownsEveryRow = queries.db.context.workspaceId === SELF_HOSTED_WORKSPACE_ID
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    this.pg = dialectOf(queries.db.drizzle) === 'pg'
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]: the
   * workspace's handle, which fills `workspaceId` in every statement and routes
   * each to the current transaction.
   */
  private get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * Create the transcript FTS5 table. Called at boot only when the
   * `command-palette` flag is on; a build without FTS5 falls into the catch and
   * every read and write below turns into a no-op through `isAvailable`.
   *
   * On Postgres `transcript_text` is the baseline's: this checks it is there.
   */
  async enableFts(): Promise<void> {
    try {
      if (this.pg) {
        await executeRaw(createTranscriptFts(this.db))
        this.available = true
        return
      }
      await this.createOrJoinTransaction(async () => {
        await executeRaw(createTranscriptFts(this.db))
        await executeRaw(createTranscriptKeys(this.db, 'table'))
        // A key table from before the workspace column is made again with it,
        // and every FTS row is keyed again to the workspace that owns it.
        const [column] = await executeRaw(keysWorkspaceColumn(this.db))
        const replaced = Number(column?.present ?? 0) === 0
        if (replaced) {
          await executeRaw(createTranscriptKeys(this.db, 'drop'))
          await executeRaw(createTranscriptKeys(this.db, 'table'))
        }
        await executeRaw(createTranscriptKeysIndex(this.db))
        const rows = this.ownsEveryRow ? 'every' : 'owned'
        await executeRaw(catchUpKeys(this.db, `${replaced ? 'all' : 'after-last'}|${rows}`))
      })
      this.available = true
    } catch {
      this.available = false
    }
  }

  /**
   * Close the index for this boot without touching the table.
   *
   * There is nothing to drop: this table has no triggers, so an unused one costs
   * only its bytes. Keeping it is what makes turning search back on cheap — these
   * rows are NOT derivable from the database alone; the only other source is
   * re-reading the transcript lake from `indexed_bytes = 0`.
   */
  disableFts(): void {
    this.available = false
  }

  get isAvailable(): boolean {
    return this.available
  }

  async segmentsToIndex(
    machineId: MachineId,
  ): Promise<{ nativeId: string; mirroredBytes: number; indexedBytes: number }[]> {
    return await segmentsBehindMirror(this.db).all({ machineId })
  }

  async indexedCursor(machineId: MachineId, nativeId: string): Promise<number> {
    const row = await segmentIndexedCursor(this.db).get({ machineId, nativeId })
    return row?.indexedBytes ?? 0
  }

  async append(
    machineId: MachineId,
    nativeId: string,
    rows: { content: string; itemUuid?: string; ts?: string }[],
    indexedBytes: number,
  ): Promise<void> {
    if (!this.available) return
    await this.createOrJoinTransaction(async () => {
      for (const row of rows) {
        // A transcript's text, without U+0000 (POD-6958 design 2.3 rule 9).
        await executeRaw(insertTranscriptRow(this.db), {
          content: withoutNul(row.content),
          machineId,
          nativeId,
          itemUuid: row.itemUuid === undefined ? null : withoutNul(row.itemUuid),
          ts: row.ts === undefined ? null : withoutNul(row.ts),
        })
        if (!this.pg) await executeRaw(insertTranscriptKey(this.db), { machineId, nativeId })
      }
      await setSegmentIndexedBytes(this.db).run({ machineId, nativeId, indexedBytes })
    })
  }

  /**
   * Reconcile a durable cursor whose canonical lake file has disappeared.
   *
   * The expected cursors make this an optimistic update: if the mirror repaired
   * or advanced the segment while the indexer's file open was failing, that
   * newer state wins. `reported_bytes` deliberately survives the reset so the
   * mirror's dirty query schedules a re-pull from byte zero.
   */
  async resetMissingLake(
    machineId: MachineId,
    nativeId: string,
    expected: { mirroredBytes: number; indexedBytes: number },
  ): Promise<boolean> {
    let reset = false
    await this.createOrJoinTransaction(async () => {
      const result = await resetSegmentIfAt(this.db).run({
        machineId,
        nativeId,
        mirroredBytes: expected.mirroredBytes,
        indexedBytes: expected.indexedBytes,
      })
      reset = Number(result.changes) === 1
      if (reset && this.available) await this.deleteSegmentRows(machineId, nativeId)
    })
    return reset
  }

  async rows(
    machineId: MachineId,
    nativeId: string,
  ): Promise<{ content: string; itemUuid?: string; ts?: string }[]> {
    if (!this.available) return []
    const rows: Record<string, unknown>[] = await executeRaw(transcriptRowsOf(this.db), {
      machineId,
      nativeId,
    })
    return rows.map((row) => ({
      content: row.content as string,
      itemUuid: (row.item_uuid as string | null) ?? undefined,
      ts: (row.ts as string | null) ?? undefined,
    }))
  }

  /** Complete candidates: memory filters before snippets participate in ranking or limits. */
  async searchCandidates(query: string): Promise<TranscriptSearchCandidate[]> {
    const trimmed = query.trim()
    if (!trimmed || !this.available) return []
    const fts = this.pg
      ? tsqueryOf(trimmed)
      : trimmed
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => `"${token.replace(/"/g, '""')}"*`)
          .join(' ')
    // A term with no word in it matches nothing, as FTS5 reads it (`search-pg.ts`).
    if (fts === undefined) return []
    const rows: Record<string, unknown>[] = await executeRaw(searchTranscripts(this.db), { fts })
    return rows.map((row) => ({
      // EXTERNAL ROW BRAND DECODE: FTS rows bypass the drizzle schema, so this
      // raw result is decoded at the search-port boundary.
      machineId: asMachineId(row.machine_id as string),
      nativeId: row.native_id as string,
      itemUuid: (row.item_uuid as string | null) ?? undefined,
      ts: (row.ts as string | null) ?? undefined,
      snippet: row.snip as string,
      rank: Number(row.rank),
      podiumId: (row.podium_id as string | null) ?? undefined,
      title: (row.name as string | null) ?? (row.title as string | null) ?? undefined,
      updatedAt: (row.updated_at as string | null) ?? undefined,
    }))
  }

  async drop(machineId: MachineId, nativeId: string): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      if (this.available) await this.deleteSegmentRows(machineId, nativeId)
      await setSegmentIndexedBytes(this.db).run({ machineId, nativeId, indexedBytes: 0 })
    })
  }

  /** One segment's FTS rows and their keys; the caller holds the transaction. */
  private async deleteSegmentRows(machineId: MachineId, nativeId: string): Promise<void> {
    await executeRaw(deleteTranscriptRows(this.db), { machineId, nativeId })
    if (!this.pg) await executeRaw(deleteTranscriptKeys(this.db), { machineId, nativeId })
  }
}
