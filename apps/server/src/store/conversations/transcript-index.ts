import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'

export interface TranscriptSearchCandidate {
  machineId: string
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
  constructor(private readonly db: SqlDatabase) {}

  ensureFts(): void {
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        content, machine_id UNINDEXED, native_id UNINDEXED, item_uuid UNINDEXED, ts UNINDEXED)`)
      this.available = true
    } catch {
      this.available = false
    }
  }

  get isAvailable(): boolean {
    return this.available
  }

  segmentsToIndex(
    machineId: string,
  ): { nativeId: string; mirroredBytes: number; indexedBytes: number }[] {
    const rows = this.db
      .prepare(`SELECT native_id,mirrored_bytes,indexed_bytes
      FROM conversation_segments WHERE machine_id=? AND mirrored_bytes>indexed_bytes`)
      .all(machineId) as Record<string, unknown>[]
    return rows.map((row) => ({
      nativeId: row.native_id as string,
      mirroredBytes: row.mirrored_bytes as number,
      indexedBytes: row.indexed_bytes as number,
    }))
  }

  indexedCursor(machineId: string, nativeId: string): number {
    const row = this.db
      .prepare('SELECT indexed_bytes FROM conversation_segments WHERE machine_id=? AND native_id=?')
      .get(machineId, nativeId) as { indexed_bytes: number } | undefined
    return row?.indexed_bytes ?? 0
  }

  append(
    machineId: string,
    nativeId: string,
    rows: { content: string; itemUuid?: string; ts?: string }[],
    indexedBytes: number,
  ): void {
    if (!this.available) return
    const insert = this.db.prepare(
      'INSERT INTO transcript_fts (content,machine_id,native_id,item_uuid,ts) VALUES(?,?,?,?,?)',
    )
    transaction(this.db, () => {
      for (const row of rows)
        insert.run(row.content, machineId, nativeId, row.itemUuid ?? null, row.ts ?? null)
      this.db
        .prepare(
          'UPDATE conversation_segments SET indexed_bytes=? WHERE machine_id=? AND native_id=?',
        )
        .run(indexedBytes, machineId, nativeId)
    })
  }

  rows(machineId: string, nativeId: string): { content: string; itemUuid?: string; ts?: string }[] {
    if (!this.available) return []
    const rows = this.db
      .prepare(`SELECT content,item_uuid,ts FROM transcript_fts
      WHERE machine_id=? AND native_id=? ORDER BY rowid`)
      .all(machineId, nativeId) as Record<string, unknown>[]
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
    const rows = this.db
      .prepare(`SELECT f.machine_id,f.native_id,f.item_uuid,f.ts,
      snippet(transcript_fts,0,'**','**','…',12) AS snip, bm25(transcript_fts) AS rank,
      s.podium_id,c.title,c.name,c.updated_at
      FROM transcript_fts f
      LEFT JOIN conversation_segments s ON s.machine_id=f.machine_id AND s.native_id=f.native_id
      LEFT JOIN conversations c ON c.id=f.native_id
      WHERE transcript_fts MATCH ? ORDER BY rank`)
      .all(fts) as Record<string, unknown>[]
    return rows.map((row) => ({
      machineId: row.machine_id as string,
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

  drop(machineId: string, nativeId: string): void {
    if (this.available) {
      this.db
        .prepare('DELETE FROM transcript_fts WHERE machine_id=? AND native_id=?')
        .run(machineId, nativeId)
    }
    this.db
      .prepare(
        'UPDATE conversation_segments SET indexed_bytes=0 WHERE machine_id=? AND native_id=?',
      )
      .run(machineId, nativeId)
  }
}
