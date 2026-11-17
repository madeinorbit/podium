import type { MachineId } from '@podium/model'
import { and, desc, eq, isNotNull, isNull, max, ne, or, type SQL, sql } from 'drizzle-orm'
import type {
  StoreDrizzle,
  StoreQueries,
  StoreTables,
  TransactionRunner,
} from '../executor/sync-drizzle'
import { param, prepared, preparedFamily } from '../executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].

/** One segment by its key, over the `machineId` / `nativeId` placeholders. */
const segmentKey = (t: StoreTables) =>
  and(
    eq(t.conversationSegments.machineId, param(t.conversationSegments.machineId, 'machineId')),
    eq(t.conversationSegments.nativeId, param(t.conversationSegments.nativeId, 'nativeId')),
  )

/** One segment's incarnations, over the same two placeholders. */
const incarnationKey = (t: StoreTables) =>
  and(
    eq(
      t.conversationSegmentIncarnations.machineId,
      param(t.conversationSegmentIncarnations.machineId, 'machineId'),
    ),
    eq(
      t.conversationSegmentIncarnations.nativeId,
      param(t.conversationSegmentIncarnations.nativeId, 'nativeId'),
    ),
  )

/**
 * The segments to mirror for the `machineId` placeholder: all of them, or only
 * those whose reported size differs from the mirrored cursor (`dirty`).
 *
 * `path IS NOT NULL` is carried HERE rather than by each caller, exactly as
 * the two statements this replaces did: a segment with no path has no lake
 * file to mirror, and the returned `path` is typed as present because of it.
 */
const segmentsToMirror = preparedFamily((db, t, which: 'all' | 'dirty') => {
  const machine = eq(
    t.conversationSegments.machineId,
    param(t.conversationSegments.machineId, 'machineId'),
  )
  const where: SQL | undefined =
    which === 'all'
      ? machine
      : and(
          machine,
          or(
            isNull(t.conversationSegments.reportedBytes),
            ne(t.conversationSegments.reportedBytes, t.conversationSegments.mirroredBytes),
          ),
        )
  return db
    .select({
      nativeId: t.conversationSegments.nativeId,
      path: t.conversationSegments.path,
      mirroredBytes: t.conversationSegments.mirroredBytes,
    })
    .from(t.conversationSegments)
    .where(and(where, isNotNull(t.conversationSegments.path)))
    .prepare()
})

const setSegmentReportedBytes = prepared((db, t) =>
  db
    .update(t.conversationSegments)
    .set({ reportedBytes: sql.placeholder('bytes') })
    .where(segmentKey(t))
    .prepare(),
)

const segmentReportedBytes = prepared((db, t) =>
  db
    .select({ reportedBytes: t.conversationSegments.reportedBytes })
    .from(t.conversationSegments)
    .where(segmentKey(t))
    .prepare(),
)

const segmentMirrorCursor = prepared((db, t) =>
  db
    .select({ mirroredBytes: t.conversationSegments.mirroredBytes })
    .from(t.conversationSegments)
    .where(segmentKey(t))
    .prepare(),
)

/**
 * The cursor compare-and-set of the fleet fence [POD-6963 design 2.3]: the
 * advance applies only while the cursor still holds the value the writer read.
 * `RETURNING` says whether it did, on SQLite and Postgres alike.
 */
const setSegmentMirrorCursor = prepared((db, t) =>
  db
    .update(t.conversationSegments)
    .set({ mirroredBytes: sql.placeholder('bytes'), mirroredAt: sql.placeholder('at') })
    .where(
      and(
        segmentKey(t),
        eq(
          t.conversationSegments.mirroredBytes,
          param(t.conversationSegments.mirroredBytes, 'expected'),
        ),
      ),
    )
    .returning({ mirroredBytes: t.conversationSegments.mirroredBytes })
    .prepare(),
)

const activeIncarnationOf = prepared((db, t) =>
  db
    .select({
      sequence: t.conversationSegmentIncarnations.sequence,
      device: t.conversationSegmentIncarnations.device,
      inode: t.conversationSegmentIncarnations.inode,
    })
    .from(t.conversationSegmentIncarnations)
    .where(and(incarnationKey(t), isNull(t.conversationSegmentIncarnations.retiredAt)))
    .orderBy(desc(t.conversationSegmentIncarnations.sequence))
    .limit(1)
    .prepare(),
)

const highestIncarnation = prepared((db, t) =>
  db
    .select({ sequence: max(t.conversationSegmentIncarnations.sequence) })
    .from(t.conversationSegmentIncarnations)
    .where(incarnationKey(t))
    .prepare(),
)

/** A fresh incarnation: a clean cursor, not retired. */
const insertIncarnation = prepared((db, t) =>
  db
    .insert(t.conversationSegmentIncarnations)
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

/**
 * Retire the active incarnation, but only while it is still the one the caller
 * observed: same sequence, same file identity, not yet retired. This is the
 * rotation's part of the fleet fence [POD-6963 design 2.3]: of two writers that
 * see the same new identity, the second's update matches no row (on Postgres it
 * waits for the first's row lock, then re-reads `retired_at`), and `RETURNING`
 * tells it so.
 */
const retireIncarnation = prepared((db, t) =>
  db
    .update(t.conversationSegmentIncarnations)
    .set({ mirroredBytes: sql.placeholder('archivedBytes'), retiredAt: sql.placeholder('at') })
    .where(
      and(
        incarnationKey(t),
        eq(
          t.conversationSegmentIncarnations.sequence,
          param(t.conversationSegmentIncarnations.sequence, 'sequence'),
        ),
        eq(
          t.conversationSegmentIncarnations.device,
          param(t.conversationSegmentIncarnations.device, 'device'),
        ),
        eq(
          t.conversationSegmentIncarnations.inode,
          param(t.conversationSegmentIncarnations.inode, 'inode'),
        ),
        isNull(t.conversationSegmentIncarnations.retiredAt),
      ),
    )
    .returning({ sequence: t.conversationSegmentIncarnations.sequence })
    .prepare(),
)

const resetSegmentCursors = prepared((db, t) =>
  db
    .update(t.conversationSegments)
    .set({ mirroredBytes: 0, mirroredAt: sql.placeholder('at'), indexedBytes: 0 })
    .where(segmentKey(t))
    .prepare(),
)

const incarnationsOf = prepared((db, t) =>
  db
    .select({
      sequence: t.conversationSegmentIncarnations.sequence,
      device: t.conversationSegmentIncarnations.device,
      inode: t.conversationSegmentIncarnations.inode,
      mirroredBytes: t.conversationSegmentIncarnations.mirroredBytes,
      retiredAt: t.conversationSegmentIncarnations.retiredAt,
    })
    .from(t.conversationSegmentIncarnations)
    .where(incarnationKey(t))
    .orderBy(t.conversationSegmentIncarnations.sequence)
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
  private async rows(
    which: 'all' | 'dirty',
    machineId: MachineId,
  ): Promise<
    {
      nativeId: string
      path: string
      mirroredBytes: number
    }[]
  > {
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

  /**
   * Move the mirrored cursor from `expected` to `bytes`. False, with nothing
   * written, when the cursor no longer equals `expected` (another writer moved
   * it) or the segment does not exist.
   */
  async setMirrorCursor(
    machineId: MachineId,
    nativeId: string,
    expected: number,
    bytes: number,
    at: string,
  ): Promise<boolean> {
    const moved = await setSegmentMirrorCursor(this.db).all({
      machineId,
      nativeId,
      expected,
      bytes,
      at,
    })
    return moved.length > 0
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

  /**
   * Retire the incarnation the caller observed (`from`) with its readable byte
   * count, then start a clean cursor for the replacement file. False, with
   * nothing written, when `from` is no longer the active incarnation: another
   * writer rotated first, and the caller re-reads and continues on the new one.
   */
  async rotateIncarnation(
    machineId: MachineId,
    nativeId: string,
    from: { sequence: number; device: string; inode: string },
    identity: { device: string; inode: string },
    archivedBytes: number,
    at: string,
  ): Promise<boolean> {
    return await this.createOrJoinTransaction(async () => {
      const retired = await retireIncarnation(this.db).all({
        machineId,
        nativeId,
        sequence: from.sequence,
        device: from.device,
        inode: from.inode,
        archivedBytes,
        at,
      })
      if (retired.length === 0) return false
      await insertIncarnation(this.db).run({
        machineId,
        nativeId,
        sequence: from.sequence + 1,
        device: identity.device,
        inode: identity.inode,
        at,
      })
      await resetSegmentCursors(this.db).run({ machineId, nativeId, at })
      return true
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
