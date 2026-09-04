import { asMachineId, type MachineId } from '@podium/model'
import { and, eq, gt, sql } from 'drizzle-orm'
import { conversationSegments } from '../../migrations/schema'
import type { SyncQueries } from '../executor/sync-drizzle'

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
  constructor(private readonly queries: SyncQueries) {}

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b], and
   * read through a getter rather than frozen into a field [rule 34a]. Ambient
   * transaction routing (rule 35) has to resolve the ENCLOSING transaction on
   * every access, which a field assigned once in a constructor can never do — so
   * B1 changes the one line inside this getter and no call site below it.
   */
  private get db(): SyncQueries['db'] {
    return this.queries.db
  }

  /**
   * AN ARROW FIELD, not `this.transact = queries.transact` [rule 34a, POD-3396].
   * The straight assignment works today only because `syncQueriesOver` returns a
   * closure over the handle; it breaks the moment the implementation uses `this`
   * — which is exactly what rule 35's adapter does — and it breaks SILENTLY, as a
   * detached method. One closure per instance is the price.
   */
  private transact = <T>(fn: () => T): T => this.queries.transact(fn)

  /**
   * Create the transcript FTS5 table. Called at boot only when the
   * `command-palette` flag is on; a build without FTS5 falls into the catch and
   * every read and write below turns into a no-op through `isAvailable`.
   */
  enableFts(): void {
    try {
      this.db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        content, machine_id UNINDEXED, native_id UNINDEXED, item_uuid UNINDEXED, ts UNINDEXED)`)
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

  segmentsToIndex(
    machineId: MachineId,
  ): { nativeId: string; mirroredBytes: number; indexedBytes: number }[] {
    return this.db
      .select({
        nativeId: conversationSegments.nativeId,
        mirroredBytes: conversationSegments.mirroredBytes,
        indexedBytes: conversationSegments.indexedBytes,
      })
      .from(conversationSegments)
      .where(
        and(
          eq(conversationSegments.machineId, machineId),
          gt(conversationSegments.mirroredBytes, conversationSegments.indexedBytes),
        ),
      )
      .all()
  }

  indexedCursor(machineId: MachineId, nativeId: string): number {
    const row = this.db
      .select({ indexedBytes: conversationSegments.indexedBytes })
      .from(conversationSegments)
      .where(this.segment(machineId, nativeId))
      .get()
    return row?.indexedBytes ?? 0
  }

  append(
    machineId: MachineId,
    nativeId: string,
    rows: { content: string; itemUuid?: string; ts?: string }[],
    indexedBytes: number,
  ): void {
    if (!this.available) return
    this.transact(() => {
      for (const row of rows) {
        // `transcript_fts` is the virtual table this port owns; there is no
        // schema model to build against, so the statement stays whole.
        this.db.run(
          sql`INSERT INTO transcript_fts (content,machine_id,native_id,item_uuid,ts)
              VALUES(${row.content},${machineId},${nativeId},${row.itemUuid ?? null},${row.ts ?? null})`,
        )
      }
      this.db
        .update(conversationSegments)
        .set({ indexedBytes })
        .where(this.segment(machineId, nativeId))
        .run()
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
  resetMissingLake(
    machineId: MachineId,
    nativeId: string,
    expected: { mirroredBytes: number; indexedBytes: number },
  ): boolean {
    let reset = false
    this.transact(() => {
      const result = this.db
        .update(conversationSegments)
        .set({ mirroredBytes: 0, mirroredAt: null, indexedBytes: 0 })
        .where(
          and(
            this.segment(machineId, nativeId),
            eq(conversationSegments.mirroredBytes, expected.mirroredBytes),
            eq(conversationSegments.indexedBytes, expected.indexedBytes),
          ),
        )
        .run()
      reset = Number(result.changes) === 1
      if (reset && this.available) {
        this.db.run(
          sql`DELETE FROM transcript_fts WHERE machine_id=${machineId} AND native_id=${nativeId}`,
        )
      }
    })
    return reset
  }

  rows(
    machineId: MachineId,
    nativeId: string,
  ): { content: string; itemUuid?: string; ts?: string }[] {
    if (!this.available) return []
    const rows: Record<string, unknown>[] = this.db.all(
      sql`SELECT content,item_uuid,ts FROM transcript_fts
      WHERE machine_id=${machineId} AND native_id=${nativeId} ORDER BY rowid`,
    )
    return rows.map((row) => ({
      content: row.content as string,
      itemUuid: (row.item_uuid as string | null) ?? undefined,
      ts: (row.ts as string | null) ?? undefined,
    }))
  }

  /** Complete candidates: memory filters before snippets participate in ranking or limits. */
  searchCandidates(query: string): TranscriptSearchCandidate[] {
    const trimmed = query.trim()
    if (!trimmed || !this.available) return []
    const fts = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"*`)
      .join(' ')
    const rows: Record<string, unknown>[] = this.db.all(
      sql`SELECT f.machine_id,f.native_id,f.item_uuid,f.ts,
      snippet(transcript_fts,0,'**','**','…',12) AS snip, bm25(transcript_fts) AS rank,
      s.podium_id,c.title,c.name,c.updated_at
      FROM transcript_fts f
      LEFT JOIN conversation_segments s ON s.machine_id=f.machine_id AND s.native_id=f.native_id
      LEFT JOIN conversations c ON c.id=f.native_id
      WHERE transcript_fts MATCH ${fts} ORDER BY rank`,
    )
    return rows.map((row) => ({
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

  drop(machineId: MachineId, nativeId: string): void {
    if (this.available) {
      this.db.run(
        sql`DELETE FROM transcript_fts WHERE machine_id=${machineId} AND native_id=${nativeId}`,
      )
    }
    this.db
      .update(conversationSegments)
      .set({ indexedBytes: 0 })
      .where(this.segment(machineId, nativeId))
      .run()
  }

  private segment(machineId: MachineId, nativeId: string) {
    return and(
      eq(conversationSegments.machineId, machineId),
      eq(conversationSegments.nativeId, nativeId),
    )
  }
}
