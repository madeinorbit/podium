import type { MachineId } from '@podium/model'
import { and, desc, eq, isNotNull, isNull, max, ne, or, type SQL } from 'drizzle-orm'
import { conversationSegmentIncarnations, conversationSegments } from '../../migrations/schema'
import type { SyncDrizzle, SyncQueries } from '../executor/sync-drizzle'

export interface MirrorIncarnation {
  sequence: number
  device: string
  inode: string
  mirroredBytes: number
  active: boolean
}

/** Durable transcript-lake evidence and copy cursors. */
export class TranscriptMirrorRepository {
  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]. B1
   * fills this same slot with the asynchronous pair, so the flip is `async`,
   * `await` and the return type and no query body moves.
   */
  private readonly db: SyncDrizzle
  private readonly transact: SyncQueries['transact']

  constructor(queries: SyncQueries) {
    this.db = queries.db
    this.transact = queries.transact
  }

  segmentsToMirror(
    machineId: MachineId,
  ): { nativeId: string; path: string; mirroredBytes: number }[] {
    return this.rows(eq(conversationSegments.machineId, machineId))
  }

  segmentsToMirrorDirty(
    machineId: MachineId,
  ): { nativeId: string; path: string; mirroredBytes: number }[] {
    return this.rows(
      and(
        eq(conversationSegments.machineId, machineId),
        or(
          isNull(conversationSegments.reportedBytes),
          ne(conversationSegments.reportedBytes, conversationSegments.mirroredBytes),
        ),
      ),
    )
  }

  /**
   * `path IS NOT NULL` is carried HERE rather than by each caller, exactly as
   * the two statements this replaces did: a segment with no path has no lake
   * file to mirror, and the returned `path` is typed as present because of it.
   */
  private rows(where: SQL | undefined): {
    nativeId: string
    path: string
    mirroredBytes: number
  }[] {
    const rows = this.db
      .select({
        nativeId: conversationSegments.nativeId,
        path: conversationSegments.path,
        mirroredBytes: conversationSegments.mirroredBytes,
      })
      .from(conversationSegments)
      .where(and(where, isNotNull(conversationSegments.path)))
      .all()
    return rows.map((row) => ({
      nativeId: row.nativeId,
      // Narrowing only: `isNotNull` above is what makes it present, and the
      // column's type cannot say so.
      path: row.path as string,
      mirroredBytes: row.mirroredBytes,
    }))
  }

  setReportedBytes(machineId: MachineId, nativeId: string, bytes: number): void {
    this.db
      .update(conversationSegments)
      .set({ reportedBytes: bytes })
      .where(this.segment(machineId, nativeId))
      .run()
  }

  reportedBytes(machineId: MachineId, nativeId: string): number | undefined {
    const row = this.db
      .select({ reportedBytes: conversationSegments.reportedBytes })
      .from(conversationSegments)
      .where(this.segment(machineId, nativeId))
      .get()
    return row?.reportedBytes ?? undefined
  }

  mirrorCursor(machineId: MachineId, nativeId: string): number {
    const row = this.db
      .select({ mirroredBytes: conversationSegments.mirroredBytes })
      .from(conversationSegments)
      .where(this.segment(machineId, nativeId))
      .get()
    return row?.mirroredBytes ?? 0
  }

  setMirrorCursor(machineId: MachineId, nativeId: string, bytes: number, at: string): void {
    this.db
      .update(conversationSegments)
      .set({ mirroredBytes: bytes, mirroredAt: at })
      .where(this.segment(machineId, nativeId))
      .run()
  }

  activeIncarnation(
    machineId: MachineId,
    nativeId: string,
  ): Omit<MirrorIncarnation, 'mirroredBytes' | 'active'> | undefined {
    return this.db
      .select({
        sequence: conversationSegmentIncarnations.sequence,
        device: conversationSegmentIncarnations.device,
        inode: conversationSegmentIncarnations.inode,
      })
      .from(conversationSegmentIncarnations)
      .where(
        and(
          this.incarnation(machineId, nativeId),
          isNull(conversationSegmentIncarnations.retiredAt),
        ),
      )
      .orderBy(desc(conversationSegmentIncarnations.sequence))
      .limit(1)
      .get()
  }

  /** Record identity for a legacy/current lake file without disturbing its cursor. */
  startIncarnation(
    machineId: MachineId,
    nativeId: string,
    identity: { device: string; inode: string },
    at: string,
  ): void {
    if (this.activeIncarnation(machineId, nativeId)) return
    const row = this.db
      .select({ sequence: max(conversationSegmentIncarnations.sequence) })
      .from(conversationSegmentIncarnations)
      .where(this.incarnation(machineId, nativeId))
      .get()
    this.db
      .insert(conversationSegmentIncarnations)
      .values({
        machineId,
        nativeId,
        sequence: (row?.sequence ?? 0) + 1,
        device: identity.device,
        inode: identity.inode,
        mirroredBytes: 0,
        createdAt: at,
        retiredAt: null,
      })
      .run()
  }

  /** Retire the current file identity after its lake bytes have been archived,
   *  then start a clean cursor for the replacement file. */
  rotateIncarnation(
    machineId: MachineId,
    nativeId: string,
    identity: { device: string; inode: string },
    archivedBytes: number,
    at: string,
  ): void {
    this.transact(() => {
      const active = this.activeIncarnation(machineId, nativeId)
      if (!active) {
        this.startIncarnation(machineId, nativeId, identity, at)
        return
      }
      this.db
        .update(conversationSegmentIncarnations)
        .set({ mirroredBytes: archivedBytes, retiredAt: at })
        .where(
          and(
            this.incarnation(machineId, nativeId),
            eq(conversationSegmentIncarnations.sequence, active.sequence),
          ),
        )
        .run()
      this.db
        .insert(conversationSegmentIncarnations)
        .values({
          machineId,
          nativeId,
          sequence: active.sequence + 1,
          device: identity.device,
          inode: identity.inode,
          mirroredBytes: 0,
          createdAt: at,
          retiredAt: null,
        })
        .run()
      this.db
        .update(conversationSegments)
        .set({ mirroredBytes: 0, mirroredAt: at, indexedBytes: 0 })
        .where(this.segment(machineId, nativeId))
        .run()
    })
  }

  incarnations(machineId: MachineId, nativeId: string): MirrorIncarnation[] {
    const currentBytes = this.mirrorCursor(machineId, nativeId)
    const rows = this.db
      .select({
        sequence: conversationSegmentIncarnations.sequence,
        device: conversationSegmentIncarnations.device,
        inode: conversationSegmentIncarnations.inode,
        mirroredBytes: conversationSegmentIncarnations.mirroredBytes,
        retiredAt: conversationSegmentIncarnations.retiredAt,
      })
      .from(conversationSegmentIncarnations)
      .where(this.incarnation(machineId, nativeId))
      .orderBy(conversationSegmentIncarnations.sequence)
      .all()
    return rows.map((row) => ({
      sequence: row.sequence,
      device: row.device,
      inode: row.inode,
      // The ACTIVE row's byte count is the segment's live cursor, not its own
      // column, which is only written when the incarnation retires.
      mirroredBytes: row.retiredAt === null ? currentBytes : row.mirroredBytes,
      active: row.retiredAt === null,
    }))
  }

  private segment(machineId: MachineId, nativeId: string) {
    return and(
      eq(conversationSegments.machineId, machineId),
      eq(conversationSegments.nativeId, nativeId),
    )
  }

  private incarnation(machineId: MachineId, nativeId: string) {
    return and(
      eq(conversationSegmentIncarnations.machineId, machineId),
      eq(conversationSegmentIncarnations.nativeId, nativeId),
    )
  }
}
