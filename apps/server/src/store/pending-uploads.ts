// workspace-scoped (POD-6959)
/**
 * THE RECORDS OF COMPOSER UPLOADS (POD-2148; POD-6963 design 2.5, POD-7055).
 *
 * One row per file picked in a chat or new-task composer: who picked it, its
 * name, type and size, and, once a send or create claims it, the issue and
 * artifact it went to. The bytes are one object in the workspace's blob store
 * (`PendingUploadStore`); before this table the record was a `meta.json` beside
 * them, and "which uploads did this issue claim" was a directory listing.
 *
 * CLAIMS ARE CONDITIONAL UPDATES. {@link PendingUploadsRepository.claim} records
 * a claim only on a row nobody has claimed, and a discard deletes only an
 * unclaimed row, so two server processes claiming or discarding one upload are
 * ordered by the database: the loser reads again and decides on what is there
 * now. A conflict is zero changed rows, never a failed statement, which is safe
 * inside a Postgres transaction.
 *
 * Every statement names the workspace (`inWorkspace`, `WORKSPACE`), and every
 * key leads with it.
 */

import type { ArtifactId, IssueId, UserId } from '@podium/model'
import { asc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { WorkspaceDb, WorkspaceQueries } from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

/** One held upload. */
export interface PendingUploadRow {
  readonly id: string
  readonly ownerUserId: UserId
  /** The name the person's file had. */
  readonly filename: string
  /** The stored file's name: `filename` when that is a plain name. */
  readonly entry: string
  readonly mediaType: string
  readonly size: number
  /** Epoch ms. */
  readonly createdAt: number
  /** Set by the first claim, before the file is copied into the artifact. */
  readonly claimed?: { readonly issueId: IssueId; readonly artifactId: ArtifactId }
}

/** An upload the sweep may remove: enough to name its blob. */
export interface PendingUploadRef {
  readonly id: string
  readonly entry: string
}

// Every query this repository runs, prepared once per store [POD-6147].

const insertUpload = prepared((db, t) =>
  db
    .insert(t.pendingUploads)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      ownerUserId: sql.placeholder('ownerUserId'),
      filename: sql.placeholder('filename'),
      entry: sql.placeholder('entry'),
      mediaType: sql.placeholder('mediaType'),
      size: sql.placeholder('size'),
      createdAt: sql.placeholder('createdAt'),
      claimedIssueId: sql.placeholder('claimedIssueId'),
      claimedArtifactId: sql.placeholder('claimedArtifactId'),
    })
    .onConflictDoNothing({ target: [t.pendingUploads.workspaceId, t.pendingUploads.id] })
    .prepare(),
)

const uploadById = prepared((db, t) =>
  db
    .select({
      id: t.pendingUploads.id,
      ownerUserId: t.pendingUploads.ownerUserId,
      filename: t.pendingUploads.filename,
      entry: t.pendingUploads.entry,
      mediaType: t.pendingUploads.mediaType,
      size: t.pendingUploads.size,
      createdAt: t.pendingUploads.createdAt,
      claimedIssueId: t.pendingUploads.claimedIssueId,
      claimedArtifactId: t.pendingUploads.claimedArtifactId,
    })
    .from(t.pendingUploads)
    .where(inWorkspace(t.pendingUploads, eq(t.pendingUploads.id, param(t.pendingUploads.id, 'id'))))
    .prepare(),
)

const uploadsClaimedBy = prepared((db, t) =>
  db
    .select({
      id: t.pendingUploads.id,
      ownerUserId: t.pendingUploads.ownerUserId,
      filename: t.pendingUploads.filename,
      entry: t.pendingUploads.entry,
      mediaType: t.pendingUploads.mediaType,
      size: t.pendingUploads.size,
      createdAt: t.pendingUploads.createdAt,
      claimedIssueId: t.pendingUploads.claimedIssueId,
      claimedArtifactId: t.pendingUploads.claimedArtifactId,
    })
    .from(t.pendingUploads)
    .where(
      inWorkspace(
        t.pendingUploads,
        eq(t.pendingUploads.claimedIssueId, param(t.pendingUploads.claimedIssueId, 'issueId')),
      ),
    )
    .prepare(),
)

const claimUpload = prepared((db, t) =>
  db
    .update(t.pendingUploads)
    .set({
      claimedIssueId: sql.placeholder('issueId'),
      claimedArtifactId: sql.placeholder('artifactId'),
    })
    .where(
      inWorkspace(
        t.pendingUploads,
        eq(t.pendingUploads.id, param(t.pendingUploads.id, 'id')),
        isNull(t.pendingUploads.claimedIssueId),
      ),
    )
    .prepare(),
)

const unclaimUpload = prepared((db, t) =>
  db
    .update(t.pendingUploads)
    .set({ claimedIssueId: null, claimedArtifactId: null })
    .where(
      inWorkspace(
        t.pendingUploads,
        eq(t.pendingUploads.id, param(t.pendingUploads.id, 'id')),
        eq(t.pendingUploads.claimedIssueId, param(t.pendingUploads.claimedIssueId, 'issueId')),
      ),
    )
    .prepare(),
)

const deleteUnclaimedOfOwner = prepared((db, t) =>
  db
    .delete(t.pendingUploads)
    .where(
      inWorkspace(
        t.pendingUploads,
        eq(t.pendingUploads.id, param(t.pendingUploads.id, 'id')),
        eq(t.pendingUploads.ownerUserId, param(t.pendingUploads.ownerUserId, 'ownerUserId')),
        isNull(t.pendingUploads.claimedIssueId),
      ),
    )
    .prepare(),
)

const deleteUpload = prepared((db, t) =>
  db
    .delete(t.pendingUploads)
    .where(inWorkspace(t.pendingUploads, eq(t.pendingUploads.id, param(t.pendingUploads.id, 'id'))))
    .prepare(),
)

const uploadsCreatedBefore = prepared((db, t) =>
  db
    .select({ id: t.pendingUploads.id, entry: t.pendingUploads.entry })
    .from(t.pendingUploads)
    .where(
      inWorkspace(
        t.pendingUploads,
        lt(t.pendingUploads.createdAt, param(t.pendingUploads.createdAt, 'before')),
      ),
    )
    .orderBy(asc(t.pendingUploads.createdAt))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const uploadsAfter = prepared((db, t) =>
  db
    .select({
      id: t.pendingUploads.id,
      ownerUserId: t.pendingUploads.ownerUserId,
      filename: t.pendingUploads.filename,
      entry: t.pendingUploads.entry,
      mediaType: t.pendingUploads.mediaType,
      size: t.pendingUploads.size,
      createdAt: t.pendingUploads.createdAt,
      claimedIssueId: t.pendingUploads.claimedIssueId,
      claimedArtifactId: t.pendingUploads.claimedArtifactId,
    })
    .from(t.pendingUploads)
    .where(
      inWorkspace(t.pendingUploads, gt(t.pendingUploads.id, param(t.pendingUploads.id, 'after'))),
    )
    .orderBy(asc(t.pendingUploads.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

type StoredRow = {
  id: string
  ownerUserId: UserId
  filename: string
  entry: string
  mediaType: string
  size: number
  createdAt: number
  claimedIssueId: IssueId | null
  claimedArtifactId: ArtifactId | null
}

function fromStored(row: StoredRow): PendingUploadRow {
  const { claimedIssueId, claimedArtifactId, ...rest } = row
  return claimedIssueId !== null && claimedArtifactId !== null
    ? { ...rest, claimed: { issueId: claimedIssueId, artifactId: claimedArtifactId } }
    : rest
}

export class PendingUploadsRepository {
  private readonly db: WorkspaceDb

  constructor(queries: WorkspaceQueries) {
    this.db = queries.db
  }

  /** Record an upload. False when the id is already recorded (a re-run conversion). */
  async insert(row: PendingUploadRow): Promise<boolean> {
    const result = await insertUpload(this.db).run({
      id: row.id,
      ownerUserId: row.ownerUserId,
      filename: row.filename,
      entry: row.entry,
      mediaType: row.mediaType,
      size: row.size,
      createdAt: row.createdAt,
      claimedIssueId: row.claimed?.issueId ?? null,
      claimedArtifactId: row.claimed?.artifactId ?? null,
    })
    return Number(result.changes) === 1
  }

  async get(id: string): Promise<PendingUploadRow | undefined> {
    const row = await uploadById(this.db).get({ id })
    return row === undefined ? undefined : fromStored(row)
  }

  /** Every upload whose claim names this issue. */
  async claimedBy(issueId: IssueId): Promise<PendingUploadRow[]> {
    return (await uploadsClaimedBy(this.db).all({ issueId })).map(fromStored)
  }

  /**
   * Record a claim on an upload nobody has claimed. False when it is claimed
   * already or gone: the caller reads the row again.
   */
  async claim(id: string, issueId: IssueId, artifactId: ArtifactId): Promise<boolean> {
    const result = await claimUpload(this.db).run({ id, issueId, artifactId })
    return Number(result.changes) === 1
  }

  /** Forget this issue's claim (its file was copied back); another issue's claim stays. */
  async unclaim(id: string, issueId: IssueId): Promise<void> {
    await unclaimUpload(this.db).run({ id, issueId })
  }

  /** Delete the owner's upload if nobody has claimed it. False when it was not deleted. */
  async deleteUnclaimed(id: string, ownerUserId: UserId): Promise<boolean> {
    const result = await deleteUnclaimedOfOwner(this.db).run({ id, ownerUserId })
    return Number(result.changes) === 1
  }

  /** Forget one upload (swept); a missing row is fine. */
  async delete(id: string): Promise<void> {
    await deleteUpload(this.db).run({ id })
  }

  /**
   * One page of every upload in id order, after `after` ('' for the first): the
   * orphan audit's reference set. The table holds about a day of uploads.
   */
  async page(after: string, limit: number): Promise<PendingUploadRow[]> {
    return (await uploadsAfter(this.db).all({ after, limit })).map(fromStored)
  }

  /** Uploads made before `before` (epoch ms), oldest first, at most `limit`. */
  async createdBefore(before: number, limit: number): Promise<PendingUploadRef[]> {
    return await uploadsCreatedBefore(this.db).all({ before, limit })
  }
}
