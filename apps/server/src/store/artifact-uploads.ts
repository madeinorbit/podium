// workspace-scoped (POD-6959)
/**
 * THE STATE OF CLI BUNDLE UPLOADS IN PROGRESS (POD-6963 design 2.4, POD-7054).
 *
 * One row per upload: the `begin` packet and the bytes received per member. The
 * bytes themselves are chunk objects in the workspace's blob store
 * (`IssueArtifactStore`); before this table the state was a `meta.json` beside
 * them, and an in-process lock map ordered the packets of one upload.
 *
 * ACCEPTANCE IS A CONDITIONAL UPDATE. {@link ArtifactUploadsRepository.advance}
 * writes the new received counts only where the row still holds the counts the
 * caller read, and answers whether it did. Two server processes receiving
 * packets of the same upload are ordered by the database: the loser reads again
 * and decides on what is there now. Nothing here relies on a failed statement:
 * a conflict is zero changed rows, which is safe inside a Postgres transaction.
 *
 * Every statement names the workspace (`inWorkspace`, `WORKSPACE`), and every
 * key leads with it.
 */

import type { IssueId } from '@podium/model'
import { and, asc, eq, gt, lt, or, sql } from 'drizzle-orm'
import type { TransactionRunner, WorkspaceDb, WorkspaceQueries } from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

/** One upload's stored state. */
export interface ArtifactUploadRow {
  readonly issueId: IssueId
  readonly uploadId: string
  /** The `begin` packet, as the client sent it (JSON). */
  readonly beginJson: string
  /** Bytes received per member, in the begin packet's member order. */
  readonly received: readonly number[]
  /** Epoch ms. */
  readonly createdAt: number
}

/** An upload the sweep may remove. */
export interface ArtifactUploadRef {
  readonly issueId: IssueId
  readonly uploadId: string
}

/** The received counts as stored: compact JSON, so one list has exactly one text. */
export function encodeReceived(received: readonly number[]): string {
  return JSON.stringify(received)
}

function decodeReceived(text: string): number[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || !value.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('artifact upload row holds unreadable received counts')
  }
  return value as number[]
}

// Every query this repository runs, prepared once per store [POD-6147].

const insertUpload = prepared((db, t) =>
  db
    .insert(t.artifactUploads)
    .values({
      workspaceId: WORKSPACE,
      issueId: sql.placeholder('issueId'),
      uploadId: sql.placeholder('uploadId'),
      beginJson: sql.placeholder('beginJson'),
      receivedJson: sql.placeholder('receivedJson'),
      createdAt: sql.placeholder('createdAt'),
    })
    .onConflictDoNothing({
      target: [
        t.artifactUploads.workspaceId,
        t.artifactUploads.issueId,
        t.artifactUploads.uploadId,
      ],
    })
    .prepare(),
)

const uploadById = prepared((db, t) =>
  db
    .select({
      issueId: t.artifactUploads.issueId,
      uploadId: t.artifactUploads.uploadId,
      beginJson: t.artifactUploads.beginJson,
      receivedJson: t.artifactUploads.receivedJson,
      createdAt: t.artifactUploads.createdAt,
    })
    .from(t.artifactUploads)
    .where(
      inWorkspace(
        t.artifactUploads,
        eq(t.artifactUploads.issueId, param(t.artifactUploads.issueId, 'issueId')),
        eq(t.artifactUploads.uploadId, param(t.artifactUploads.uploadId, 'uploadId')),
      ),
    )
    .prepare(),
)

const advanceReceived = prepared((db, t) =>
  db
    .update(t.artifactUploads)
    .set({ receivedJson: sql.placeholder('next') })
    .where(
      inWorkspace(
        t.artifactUploads,
        eq(t.artifactUploads.issueId, param(t.artifactUploads.issueId, 'issueId')),
        eq(t.artifactUploads.uploadId, param(t.artifactUploads.uploadId, 'uploadId')),
        // As text on both engines: Postgres's `json` has no equality (POD-6958 design
        // 2.3, rule 7), and SQLite compares the text.
        sql`CAST(${t.artifactUploads.receivedJson} AS TEXT) = ${param(t.artifactUploads.receivedJson, 'previous')}`,
      ),
    )
    .prepare(),
)

const deleteUpload = prepared((db, t) =>
  db
    .delete(t.artifactUploads)
    .where(
      inWorkspace(
        t.artifactUploads,
        eq(t.artifactUploads.issueId, param(t.artifactUploads.issueId, 'issueId')),
        eq(t.artifactUploads.uploadId, param(t.artifactUploads.uploadId, 'uploadId')),
      ),
    )
    .prepare(),
)

const deleteIssueUploads = prepared((db, t) =>
  db
    .delete(t.artifactUploads)
    .where(
      inWorkspace(
        t.artifactUploads,
        eq(t.artifactUploads.issueId, param(t.artifactUploads.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const uploadsCreatedBefore = prepared((db, t) =>
  db
    .select({ issueId: t.artifactUploads.issueId, uploadId: t.artifactUploads.uploadId })
    .from(t.artifactUploads)
    .where(
      inWorkspace(
        t.artifactUploads,
        lt(t.artifactUploads.createdAt, param(t.artifactUploads.createdAt, 'before')),
      ),
    )
    .orderBy(asc(t.artifactUploads.createdAt))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const uploadsAfter = prepared((db, t) => {
  const u = t.artifactUploads
  return db
    .select({ issueId: u.issueId, uploadId: u.uploadId })
    .from(u)
    .where(
      inWorkspace(
        u,
        or(
          gt(u.issueId, param(u.issueId, 'afterIssue')),
          and(
            eq(u.issueId, param(u.issueId, 'sameIssue')),
            gt(u.uploadId, param(u.uploadId, 'afterUpload')),
          ),
        ),
      ),
    )
    .orderBy(asc(u.issueId), asc(u.uploadId))
    .limit(sql.placeholder('limit'))
    .prepare()
})

export class ArtifactUploadsRepository {
  private readonly db: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.db = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Record a new upload. False when the upload already exists: a retried or
   * competing `begin` never resets an upload whose chunks have arrived.
   */
  async begin(row: ArtifactUploadRow): Promise<boolean> {
    const result = await insertUpload(this.db).run({
      issueId: row.issueId,
      uploadId: row.uploadId,
      beginJson: row.beginJson,
      receivedJson: encodeReceived(row.received),
      createdAt: row.createdAt,
    })
    return Number(result.changes) === 1
  }

  async get(issueId: IssueId, uploadId: string): Promise<ArtifactUploadRow | undefined> {
    const row = await uploadById(this.db).get({ issueId, uploadId })
    if (row === undefined) return undefined
    return {
      issueId: row.issueId,
      uploadId: row.uploadId,
      beginJson: row.beginJson,
      received: decodeReceived(row.receivedJson),
      createdAt: row.createdAt,
    }
  }

  /**
   * Replace the received counts with `next` where the row still holds
   * `previous`. False when it does not (another packet was accepted since the
   * caller read, or the upload is gone): the caller reads again.
   */
  async advance(
    issueId: IssueId,
    uploadId: string,
    previous: readonly number[],
    next: readonly number[],
  ): Promise<boolean> {
    const result = await advanceReceived(this.db).run({
      issueId,
      uploadId,
      previous: encodeReceived(previous),
      next: encodeReceived(next),
    })
    return Number(result.changes) === 1
  }

  /** Forget one upload (published, aborted or swept); a missing row is fine. */
  async delete(issueId: IssueId, uploadId: string): Promise<void> {
    await deleteUpload(this.db).run({ issueId, uploadId })
  }

  /** Forget every upload of an issue (hard issue deletion). */
  async deleteIssue(issueId: IssueId): Promise<void> {
    await deleteIssueUploads(this.db).run({ issueId })
  }

  /**
   * One page of every upload in key order, after `after` (none for the first):
   * the orphan audit's reference set. The table holds about a day of uploads.
   */
  async page(after: ArtifactUploadRef | undefined, limit: number): Promise<ArtifactUploadRef[]> {
    return await uploadsAfter(this.db).all({
      afterIssue: after?.issueId ?? '',
      sameIssue: after?.issueId ?? '',
      afterUpload: after?.uploadId ?? '',
      limit,
    })
  }

  /** Uploads begun before `before` (epoch ms), oldest first, at most `limit`. */
  async createdBefore(before: number, limit: number): Promise<ArtifactUploadRef[]> {
    return await uploadsCreatedBefore(this.db).all({ before, limit })
  }
}
