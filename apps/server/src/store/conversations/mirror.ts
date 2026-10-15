import type { MachineId } from '@podium/model'
import { and, desc, eq, isNotNull, isNull, max, ne, or, type SQL, sql } from 'drizzle-orm'
import { conversationSegmentIncarnations, conversationSegments } from '../../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from '../executor/sync-drizzle'
import { param, prepared, preparedFamily } from '../executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].

/** One segment by its key, over the `machineId` / `nativeId` placeholders. */
const segmentKey = () =>
  and(
    eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
    eq(conversationSegments.nativeId, param(conversationSegments.nativeId, 'nativeId')),
  )

/** One segment's incarnations, over the same two placeholders. */
const incarnationKey = () =>
  and(
    eq(conversationSegmentIncarnations.machineId, param(conversationSegmentIncarnations.machineId, 'machineId')),
    eq(conversationSegmentIncarnations.nativeId, param(conversationSegmentIncarnations.nativeId, 'nativeId')),
  )

/**
 * The segments to mirror for the `machineId` placeholder: all of them, or only
 * those whose reported size differs from the mirrored cursor (`dirty`).
 *
 * `path IS NOT NULL` is carried HERE rather than by each caller, exactly as
 * the two statements this replaces did: a segment with no path has no lake
 * file to mirror, and the returned `path` is typed as present because of it.
 */
const segmentsToMirror = preparedFamily((db: StoreDrizzle, which: 'all' | 'dirty') => {
  const machine = eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId'))
  const where: SQL | undefined =
    which === 'all'
      ? machine
      : and(
          machine,
          or(
            isNull(conversationSegments.reportedBytes),
            ne(conversationSegments.reportedBytes, conversationSegments.mirroredBytes),
          ),
        )
  return db
    .select({
      nativeId: conversationSegments.nativeId,
      path: conversationSegments.path,
      mirroredBytes: conversationSegments.mirroredBytes,
    })
    .from(conversationSegments)
    .where(and(where, isNotNull(conversationSegments.path)))
    .prepare()
})

const setSegmentReportedBytes = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegments)
    .set({ reportedBytes: sql.placeholder('bytes') })
    .where(segmentKey())
    .prepare(),
)

const segmentReportedBytes = prepared((db: StoreDrizzle) =>
  db
    .select({ reportedBytes: conversationSegments.reportedBytes })
    .from(conversationSegments)
    .where(segmentKey())
    .prepare(),
)

const segmentMirrorCursor = prepared((db: StoreDrizzle) =>
  db
    .select({ mirroredBytes: conversationSegments.mirroredBytes })
    .from(conversationSegments)
    .where(segmentKey())
    .prepare(),
)

const setSegmentMirrorCursor = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegments)
    .set({ mirroredBytes: sql.placeholder('bytes'), mirroredAt: sql.placeholder('at') })
    .where(segmentKey())
    .prepare(),
)

const activeIncarnationOf = prepared((db: StoreDrizzle) =>
  db
    .select({
      sequence: conversationSegmentIncarnations.sequence,
      device: conversationSegmentIncarnations.device,
      inode: conversationSegmentIncarnations.inode,
    })
    .from(conversationSegmentIncarnations)
    .where(
      and(
        incarnationKey(),
        isNull(conversationSegmentIncarnations.retiredAt),
      ),
    )
    .orderBy(desc(conversationSegmentIncarnations.sequence))
    .limit(1)
    .prepare(),
)

const highestIncarnation = prepared((db: StoreDrizzle) =>
  db
    .select({ sequence: max(conversationSegmentIncarnations.sequence) })
    .from(conversationSegmentIncarnations)
    .where(incarnationKey())
    .prepare(),
)

/** A fresh incarnation: a clean cursor, not retired. */
const insertIncarnation = prepared((db: StoreDrizzle) =>
  db
    .insert(conversationSegmentIncarnations)
    .values({
      machineId: sql.placeholder('machineId'),
      nativeId: sql.placeholder('nativeId'),
      sequence: sql.placeholder('sequence'),
      device: sql.placeholder('device'),
      inode: sql.placeholder('inode'),
      mirroredBytes: 0,
      createdAt: sql.placeholder('at'),
      retiredAt: null,
    })
    .prepare(),
)

const retireIncarnation = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegmentIncarnations)
    .set({ mirroredBytes: sql.placeholder('archivedBytes'), retiredAt: sql.placeholder('at') })
    .where(
      and(
        incarnationKey(),
        eq(conversationSegmentIncarnations.sequence, param(conversationSegmentIncarnations.sequence, 'sequence')),
      ),
    )
    .prepare(),
)

const resetSegmentCursors = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegments)
    .set({ mirroredBytes: 0, mirroredAt: sql.placeholder('at'), indexedBytes: 0 })
    .where(segmentKey())
    .prepare(),
)

const incarnationsOf = prepared((db: StoreDrizzle) =>
  db
    .select({
      sequence: conversationSegmentIncarnations.sequence,
      device: conversationSegmentIncarnations.device,
      inode: conversationSegmentIncarnations.inode,
      mirroredBytes: conversationSegmentIncarnations.mirroredBytes,
      retiredAt: conversationSegmentIncarnations.retiredAt,
    })
    .from(conversationSegmentIncarnations)
    .where(incarnationKey())
    .orderBy(conversationSegmentIncarnations.sequence)
    .prepare(),
)

export interface MirrorIncarnation {
  sequence: number
  device: string
  inode: string
  mirroredBytes: number
  active: boolean
}

/** Durable transcript-lake evidence and copy cursors. */
export class TranscriptMirrorRepository {
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

  async segmentsToMirror(
    machineId: MachineId,
  ): Promise<{ nativeId: string; path: string; mirroredBytes: number }[]> {
    return await this.rows('all', machineId)
  }

  async segmentsToMirrorDirty(
    machineId: MachineId,
  ): Promise<{ nativeId: string; path: string; mirroredBytes: number }[]> {
    return await this.rows('dirty', machineId)
  }

  /** {@link segmentsToMirror}'s rows, with `path` typed as present. */
  private async rows(which: 'all' | 'dirty', machineId: MachineId): Promise<{
    nativeId: string
    path: string
    mirroredBytes: number
  }[]> {
    const rows = await segmentsToMirror(this.db, which).all({ machineId })
    return rows.map((row) => ({
      nativeId: row.nativeId,
      // Narrowing only: `isNotNull` above is what makes it present, and the
      // column's type cannot say so.
      path: row.path as string,
      mirroredBytes: row.mirroredBytes,
    }))
  }

  async setReportedBytes(machineId: MachineId, nativeId: string, bytes: number): Promise<void> {
    await setSegmentReportedBytes(this.db).run({ machineId, nativeId, bytes })
  }

  async reportedBytes(machineId: MachineId, nativeId: string): Promise<number | undefined> {
    const row = await segmentReportedBytes(this.db).get({ machineId, nativeId })
    return row?.reportedBytes ?? undefined
  }

  async mirrorCursor(machineId: MachineId, nativeId: string): Promise<number> {
    const row = await segmentMirrorCursor(this.db).get({ machineId, nativeId })
    return row?.mirroredBytes ?? 0
  }

  async setMirrorCursor(machineId: MachineId, nativeId: string, bytes: number, at: string): Promise<void> {
    await setSegmentMirrorCursor(this.db).run({ machineId, nativeId, bytes, at })
  }

  async activeIncarnation(
    machineId: MachineId,
    nativeId: string,
  ): Promise<Omit<MirrorIncarnation, 'mirroredBytes' | 'active'> | undefined> {
    return await activeIncarnationOf(this.db).get({ machineId, nativeId })
  }

  /** Record identity for a legacy/current lake file without disturbing its cursor. */
  async startIncarnation(
    machineId: MachineId,
    nativeId: string,
    identity: { device: string; inode: string },
    at: string,
  ): Promise<void> {
    if (await this.activeIncarnation(machineId, nativeId)) return
    const row = await highestIncarnation(this.db).get({ machineId, nativeId })
    await insertIncarnation(this.db).run({
      machineId,
      nativeId,
      sequence: (row?.sequence ?? 0) + 1,
      device: identity.device,
      inode: identity.inode,
      at,
    })
  }

  /** Retire the current file identity after its lake bytes have been archived,
   *  then start a clean cursor for the replacement file. */
  async rotateIncarnation(
    machineId: MachineId,
    nativeId: string,
    identity: { device: string; inode: string },
    archivedBytes: number,
    at: string,
  ): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const active = await this.activeIncarnation(machineId, nativeId)
      if (!active) {
        await this.startIncarnation(machineId, nativeId, identity, at)
        return
      }
      await retireIncarnation(this.db).run({ machineId, nativeId, sequence: active.sequence, archivedBytes, at })
      await insertIncarnation(this.db).run({
        machineId,
        nativeId,
        sequence: active.sequence + 1,
        device: identity.device,
        inode: identity.inode,
        at,
      })
      await resetSegmentCursors(this.db).run({ machineId, nativeId, at })
    })
  }

  async incarnations(machineId: MachineId, nativeId: string): Promise<MirrorIncarnation[]> {
    const currentBytes = await this.mirrorCursor(machineId, nativeId)
    const rows = await incarnationsOf(this.db).all({ machineId, nativeId })
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
}
