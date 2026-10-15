import { asMachineId, type MachineId } from '@podium/model'
import { and, eq, gt, sql } from 'drizzle-orm'
import { conversationSegments } from '../../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from '../executor/sync-drizzle'
import { executeRaw, param, prepared } from '../executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].
// `transcript_fts` is the virtual table this port owns; there is no schema
// model to build against, so its statements stay whole raw SQL.

/** One segment by its key, over the `machineId` / `nativeId` placeholders. */
const segmentKey = () =>
  and(
    eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
    eq(conversationSegments.nativeId, param(conversationSegments.nativeId, 'nativeId')),
  )

const createTranscriptFts = prepared((db: StoreDrizzle) =>
  db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        content, machine_id UNINDEXED, native_id UNINDEXED, item_uuid UNINDEXED, ts UNINDEXED)`),
)

const segmentsBehindMirror = prepared((db: StoreDrizzle) =>
  db
    .select({
      nativeId: conversationSegments.nativeId,
      mirroredBytes: conversationSegments.mirroredBytes,
      indexedBytes: conversationSegments.indexedBytes,
    })
    .from(conversationSegments)
    .where(
      and(
        eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
        gt(conversationSegments.mirroredBytes, conversationSegments.indexedBytes),
      ),
    )
    .prepare(),
)

const segmentIndexedCursor = prepared((db: StoreDrizzle) =>
  db
    .select({ indexedBytes: conversationSegments.indexedBytes })
    .from(conversationSegments)
    .where(segmentKey())
    .prepare(),
)

const insertTranscriptRow = prepared((db: StoreDrizzle) =>
  db.run(
    sql`INSERT INTO transcript_fts (content,machine_id,native_id,item_uuid,ts)
              VALUES(${sql.placeholder('content')},${sql.placeholder('machineId')},${sql.placeholder('nativeId')},${sql.placeholder('itemUuid')},${sql.placeholder('ts')})`,
  ),
)

const setSegmentIndexedBytes = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegments)
    .set({ indexedBytes: sql.placeholder('indexedBytes') })
    .where(segmentKey())
    .prepare(),
)

const resetSegmentIfAt = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegments)
    .set({ mirroredBytes: 0, mirroredAt: null, indexedBytes: 0 })
    .where(
      and(
        segmentKey(),
        eq(conversationSegments.mirroredBytes, param(conversationSegments.mirroredBytes, 'mirroredBytes')),
        eq(conversationSegments.indexedBytes, param(conversationSegments.indexedBytes, 'indexedBytes')),
      ),
    )
    .prepare(),
)

const deleteTranscriptRows = prepared((db: StoreDrizzle) =>
  db.run(
    sql`DELETE FROM transcript_fts WHERE machine_id=${sql.placeholder('machineId')} AND native_id=${sql.placeholder('nativeId')}`,
  ),
)

const transcriptRowsOf = prepared((db: StoreDrizzle) =>
  db.all<Record<string, unknown>>(
    sql`SELECT content,item_uuid,ts FROM transcript_fts
      WHERE machine_id=${sql.placeholder('machineId')} AND native_id=${sql.placeholder('nativeId')} ORDER BY rowid`,
  ),
)

const searchTranscripts = prepared((db: StoreDrizzle) =>
  db.all<Record<string, unknown>>(
    sql`SELECT f.machine_id,f.native_id,f.item_uuid,f.ts,
      snippet(transcript_fts,0,'**','**','…',12) AS snip, bm25(transcript_fts) AS rank,
      s.podium_id,c.title,c.name,c.updated_at
      FROM transcript_fts f
      LEFT JOIN conversation_segments s ON s.machine_id=f.machine_id AND s.native_id=f.native_id
      LEFT JOIN conversations c ON c.id=f.native_id
      WHERE transcript_fts MATCH ${sql.placeholder('fts')} ORDER BY rank`,
  ),
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
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]: the
   * store's one drizzle instance, whose executor routes each statement to the
   * current transaction.
   */
  private get db(): StoreDrizzle {
    return this.rootDb
  }

  /**
   * Create the transcript FTS5 table. Called at boot only when the
   * `command-palette` flag is on; a build without FTS5 falls into the catch and
   * every read and write below turns into a no-op through `isAvailable`.
   */
  async enableFts(): Promise<void> {
    try {
      await executeRaw(createTranscriptFts(this.db))
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
        await executeRaw(insertTranscriptRow(this.db), {
          content: row.content,
          machineId,
          nativeId,
          itemUuid: row.itemUuid ?? null,
          ts: row.ts ?? null,
        })
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
      if (reset && this.available) {
        await executeRaw(deleteTranscriptRows(this.db), { machineId, nativeId })
      }
    })
    return reset
  }

  async rows(
    machineId: MachineId,
    nativeId: string,
  ): Promise<{ content: string; itemUuid?: string; ts?: string }[]> {
    if (!this.available) return []
    const rows: Record<string, unknown>[] = await executeRaw(transcriptRowsOf(this.db), { machineId, nativeId })
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
    const fts = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"*`)
      .join(' ')
    const rows: Record<string, unknown>[] = await executeRaw(searchTranscripts(this.db), { fts })
    return rows.map((row) => ({
      // EXTERNAL ROW BRAND DECODE: FTS rows bypass the drizzle schema, so this
      // raw result is decoded at the search-port boundary.
      machineId: asMachineId(row.machine_id as string),
      nativeId: row.native_id as string,
      itemUuid: (row.item_uuid as string | null) ?? undefined,
      ts: (row.ts as string | null) ?? undefined,
      snippet: row.snip as string,
      rank: row.rank as number,
      podiumId: (row.podium_id as string | null) ?? undefined,
      title: (row.name as string | null) ?? (row.title as string | null) ?? undefined,
      updatedAt: (row.updated_at as string | null) ?? undefined,
    }))
  }

  async drop(machineId: MachineId, nativeId: string): Promise<void> {
    if (this.available) {
      await executeRaw(deleteTranscriptRows(this.db), { machineId, nativeId })
    }
    await setSegmentIndexedBytes(this.db).run({ machineId, nativeId, indexedBytes: 0 })
  }
}
