import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Durable transcript-lake evidence and copy cursors. */
export class TranscriptMirrorRepository {
  constructor(private readonly db: SqlDatabase) {}

  segmentsToMirror(machineId: string): { nativeId: string; path: string; mirroredBytes: number }[] {
    return this.rows(
      'SELECT native_id,path,mirrored_bytes FROM conversation_segments WHERE machine_id=? AND path IS NOT NULL',
      machineId,
    )
  }

  segmentsToMirrorDirty(machineId: string): { nativeId: string; path: string; mirroredBytes: number }[] {
    return this.rows(
      `SELECT native_id,path,mirrored_bytes FROM conversation_segments
       WHERE machine_id=? AND path IS NOT NULL
         AND (reported_bytes IS NULL OR reported_bytes != mirrored_bytes)`,
      machineId,
    )
  }

  private rows(sql: string, machineId: string) {
    const rows = this.db.prepare(sql).all(machineId) as Record<string, unknown>[]
    return rows.map((row) => ({
      nativeId: row.native_id as string,
      path: row.path as string,
      mirroredBytes: row.mirrored_bytes as number,
    }))
  }

  setReportedBytes(machineId: string, nativeId: string, bytes: number): void {
    this.db.prepare(
      'UPDATE conversation_segments SET reported_bytes=? WHERE machine_id=? AND native_id=?',
    ).run(bytes, machineId, nativeId)
  }

  reportedBytes(machineId: string, nativeId: string): number | undefined {
    const row = this.db.prepare(
      'SELECT reported_bytes FROM conversation_segments WHERE machine_id=? AND native_id=?',
    ).get(machineId, nativeId) as { reported_bytes: number | null } | undefined
    return row?.reported_bytes ?? undefined
  }

  mirrorCursor(machineId: string, nativeId: string): number {
    const row = this.db.prepare(
      'SELECT mirrored_bytes FROM conversation_segments WHERE machine_id=? AND native_id=?',
    ).get(machineId, nativeId) as { mirrored_bytes: number } | undefined
    return row?.mirrored_bytes ?? 0
  }

  setMirrorCursor(machineId: string, nativeId: string, bytes: number, at: string): void {
    this.db.prepare(
      'UPDATE conversation_segments SET mirrored_bytes=?,mirrored_at=? WHERE machine_id=? AND native_id=?',
    ).run(bytes, at, machineId, nativeId)
  }
}
