import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'

export interface MirrorIncarnation {
  sequence: number
  device: string
  inode: string
  mirroredBytes: number
  active: boolean
}

/** Durable transcript-lake evidence and copy cursors. */
export class TranscriptMirrorRepository {
  constructor(private readonly db: SqlDatabase) {}

  segmentsToMirror(machineId: string): { nativeId: string; path: string; mirroredBytes: number }[] {
    return this.rows(
      'SELECT native_id,path,mirrored_bytes FROM conversation_segments WHERE machine_id=? AND path IS NOT NULL',
      machineId,
    )
  }

  segmentsToMirrorDirty(
    machineId: string,
  ): { nativeId: string; path: string; mirroredBytes: number }[] {
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
    this.db
      .prepare(
        'UPDATE conversation_segments SET reported_bytes=? WHERE machine_id=? AND native_id=?',
      )
      .run(bytes, machineId, nativeId)
  }

  reportedBytes(machineId: string, nativeId: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT reported_bytes FROM conversation_segments WHERE machine_id=? AND native_id=?',
      )
      .get(machineId, nativeId) as { reported_bytes: number | null } | undefined
    return row?.reported_bytes ?? undefined
  }

  mirrorCursor(machineId: string, nativeId: string): number {
    const row = this.db
      .prepare(
        'SELECT mirrored_bytes FROM conversation_segments WHERE machine_id=? AND native_id=?',
      )
      .get(machineId, nativeId) as { mirrored_bytes: number } | undefined
    return row?.mirrored_bytes ?? 0
  }

  setMirrorCursor(machineId: string, nativeId: string, bytes: number, at: string): void {
    this.db
      .prepare(
        'UPDATE conversation_segments SET mirrored_bytes=?,mirrored_at=? WHERE machine_id=? AND native_id=?',
      )
      .run(bytes, at, machineId, nativeId)
  }

  activeIncarnation(
    machineId: string,
    nativeId: string,
  ): Omit<MirrorIncarnation, 'mirroredBytes' | 'active'> | undefined {
    return this.db
      .prepare(
        `SELECT sequence,device,inode FROM conversation_segment_incarnations
         WHERE machine_id=? AND native_id=? AND retired_at IS NULL
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(machineId, nativeId) as { sequence: number; device: string; inode: string } | undefined
  }

  /** Record identity for a legacy/current lake file without disturbing its cursor. */
  startIncarnation(
    machineId: string,
    nativeId: string,
    identity: { device: string; inode: string },
    at: string,
  ): void {
    if (this.activeIncarnation(machineId, nativeId)) return
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence),0) AS sequence
         FROM conversation_segment_incarnations WHERE machine_id=? AND native_id=?`,
      )
      .get(machineId, nativeId) as { sequence: number }
    this.db
      .prepare(
        `INSERT INTO conversation_segment_incarnations
         (machine_id,native_id,sequence,device,inode,mirrored_bytes,created_at,retired_at)
         VALUES(?,?,?,?,?,0,?,NULL)`,
      )
      .run(machineId, nativeId, row.sequence + 1, identity.device, identity.inode, at)
  }

  /** Retire the current file identity after its lake bytes have been archived,
   *  then start a clean cursor for the replacement file. */
  rotateIncarnation(
    machineId: string,
    nativeId: string,
    identity: { device: string; inode: string },
    archivedBytes: number,
    at: string,
  ): void {
    transaction(this.db, () => {
      const active = this.activeIncarnation(machineId, nativeId)
      if (!active) {
        this.startIncarnation(machineId, nativeId, identity, at)
        return
      }
      this.db
        .prepare(
          `UPDATE conversation_segment_incarnations
           SET mirrored_bytes=?,retired_at=?
           WHERE machine_id=? AND native_id=? AND sequence=?`,
        )
        .run(archivedBytes, at, machineId, nativeId, active.sequence)
      this.db
        .prepare(
          `INSERT INTO conversation_segment_incarnations
           (machine_id,native_id,sequence,device,inode,mirrored_bytes,created_at,retired_at)
           VALUES(?,?,?,?,?,0,?,NULL)`,
        )
        .run(machineId, nativeId, active.sequence + 1, identity.device, identity.inode, at)
      this.db
        .prepare(
          `UPDATE conversation_segments
           SET mirrored_bytes=0,mirrored_at=?,indexed_bytes=0
           WHERE machine_id=? AND native_id=?`,
        )
        .run(at, machineId, nativeId)
    })
  }

  incarnations(machineId: string, nativeId: string): MirrorIncarnation[] {
    const currentBytes = this.mirrorCursor(machineId, nativeId)
    const rows = this.db
      .prepare(
        `SELECT sequence,device,inode,mirrored_bytes,retired_at
         FROM conversation_segment_incarnations
         WHERE machine_id=? AND native_id=? ORDER BY sequence`,
      )
      .all(machineId, nativeId) as {
      sequence: number
      device: string
      inode: string
      mirrored_bytes: number
      retired_at: string | null
    }[]
    return rows.map((row) => ({
      sequence: row.sequence,
      device: row.device,
      inode: row.inode,
      mirroredBytes: row.retired_at === null ? currentBytes : row.mirrored_bytes,
      active: row.retired_at === null,
    }))
  }
}
