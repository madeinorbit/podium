import { randomUUID } from 'node:crypto'
import { type BlobKey, type BlobStore, joinKey, keySegment } from '@podium/blob-store'
import type { IssueId, UserId } from '@podium/model'
import type { PendingUploadRow, PendingUploadsRepository } from '../../store/pending-uploads'
import { artifactContentType } from './artifact-store'

/**
 * FILES PICKED IN A CHAT OR NEW-TASK COMPOSER, HELD ON THE SERVER UNTIL THE
 * MESSAGE THAT CARRIES THEM IS SENT (POD-2148), on the workspace's blob store
 * (POD-6963 design 2.5, POD-7055).
 *
 * Picking a file stores it here, owned by the person who picked it, and answers
 * a small ref (`id`, name, type). Nothing touches the agent's machine yet, so a
 * file can be attached for a hibernated agent, or before the new task's session
 * and issue exist. Sending the message (or creating the task) CLAIMS the upload:
 * its bytes are copied into the issue's artifact store and the source deleted,
 * and the server stages them on the agent's machine when the message is
 * delivered.
 *
 * The bytes are one object at `pending-uploads/<id>/file/<entry>`; the record is
 * a row of `pending_uploads`. A claim records the issue and artifact in the row
 * before the copy, by a conditional update, so a claim retried after a crash
 * copies to the same artifact key, two processes claiming one upload agree on
 * one artifact, and a different issue is refused. An upload nobody claimed, and
 * a claimed one's row and leftover source, go after a day.
 *
 * Blob writes are fenced by the local adapter during a server transfer (design
 * 2.8); this store does not call the fence.
 */

export const PENDING_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const PENDING_UPLOAD_SWEEP_MS = 60 * 60 * 1000
/** Rows the sweep reads per query. */
const SWEEP_BATCH = 200

const PENDING_UPLOADS = 'pending-uploads'

/** Upload ids name blob keys here and staged files on the agent's machine,
 *  which accepts only UUIDs, so nothing else is ever looked up. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isPendingUploadId(id: string): boolean {
  return UPLOAD_ID.test(id)
}

/** One held upload, as its row records it. */
export type PendingUploadMeta = PendingUploadRow

/** The records this store needs (`PendingUploadsRepository`, structurally). */
export type PendingUploadRecords = Pick<
  PendingUploadsRepository,
  | 'insert'
  | 'get'
  | 'claimedBy'
  | 'claim'
  | 'unclaim'
  | 'deleteUnclaimed'
  | 'delete'
  | 'createdBefore'
>

export interface PendingUploadStoreOptions {
  /** This workspace's user files. */
  files: BlobStore
  /** This workspace's `pending_uploads` rows. */
  records: PendingUploadRecords
  now?: () => number
}

export function plainFilename(name: string): string {
  return name &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
    ? name
    : 'attachment'
}

/** The key of an upload's file. Throws for an entry too long to store as a key segment. */
export function pendingUploadKey(upload: { id: string; entry: string }): BlobKey {
  if (!isPendingUploadId(upload.id)) throw new Error('bad upload id')
  return joinKey(PENDING_UPLOADS, upload.id, 'file', keySegment(upload.entry))
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer())
}

export class PendingUploadStore {
  private readonly files: BlobStore
  private readonly records: PendingUploadRecords
  private readonly now: () => number

  constructor(options: PendingUploadStoreOptions) {
    this.files = options.files
    this.records = options.records
    this.now = options.now ?? Date.now
  }

  /** Where the upload's bytes are; what a claim copies from and a relinquish back to. */
  fileKey(upload: { id: string; entry: string }): BlobKey {
    return pendingUploadKey(upload)
  }

  /**
   * Hold a file: the bytes first, then the row, so a row always names stored
   * bytes. A name too long to store as a key is refused.
   */
  async put(input: {
    ownerUserId: UserId
    filename: string
    mediaType: string
    bytes: Uint8Array
  }): Promise<PendingUploadMeta> {
    const meta: PendingUploadMeta = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      entry: plainFilename(input.filename.split(/[/\\]/).filter(Boolean).pop() ?? ''),
      mediaType: input.mediaType,
      size: input.bytes.length,
      createdAt: this.now(),
    }
    let key: BlobKey
    try {
      key = this.fileKey(meta)
    } catch {
      throw new Error(`the file name ${meta.entry} is too long to store`)
    }
    await this.files.put(key, input.bytes, { contentType: artifactContentType(meta.entry) })
    try {
      await this.records.insert(meta)
    } catch (error) {
      await this.files.delete(key).catch(() => {})
      throw error
    }
    return meta
  }

  async meta(id: string): Promise<PendingUploadMeta | undefined> {
    if (!isPendingUploadId(id)) return undefined
    return await this.records.get(id)
  }

  /** The held bytes; undefined when they are gone (claimed, or swept). */
  async bytes(upload: { id: string; entry: string }): Promise<Uint8Array | undefined> {
    const stored = await this.files.get(this.fileKey(upload))
    return stored === undefined ? undefined : await bytesOf(stored.body)
  }

  /**
   * Record a claim before the file is copied (see the class note), and answer
   * the claim the row holds afterwards: this one, or the one a concurrent claim
   * recorded first, which may name another issue. Undefined when the upload is
   * gone.
   */
  async markClaimed(
    id: string,
    claimed: NonNullable<PendingUploadMeta['claimed']>,
  ): Promise<PendingUploadMeta['claimed']> {
    if (!isPendingUploadId(id)) return undefined
    if (await this.records.claim(id, claimed.issueId, claimed.artifactId)) return claimed
    return (await this.records.get(id))?.claimed
  }

  /** Every upload whose row records a claim into this issue. */
  async claimedBy(issueId: IssueId): Promise<PendingUploadMeta[]> {
    return await this.records.claimedBy(issueId)
  }

  /** Forget this issue's claim on a file that was copied back (a task that
   *  failed to launch). */
  async markUnclaimed(id: string, issueId: IssueId): Promise<void> {
    if (!isPendingUploadId(id)) return
    await this.records.unclaim(id, issueId)
  }

  /** Drop an upload the composer no longer carries. A claimed one stays: its
   *  row is what refuses a second issue. The row goes first, so a claim that
   *  won the race keeps its source. */
  async discard(id: string, ownerUserId: UserId): Promise<boolean> {
    const meta = await this.meta(id)
    if (!meta || meta.ownerUserId !== ownerUserId || meta.claimed) return false
    if (!(await this.records.deleteUnclaimed(id, ownerUserId))) return false
    await this.files.delete(this.fileKey(meta))
    return true
  }

  /**
   * Delete everything older than `maxAgeMs`: the bytes (a claimed upload's
   * leftover source included), then the row. A failed delete, such as a
   * server-transfer fence on the local disk, ends the pass rather than failing
   * it: the next one picks up the rest.
   */
  async sweep(maxAgeMs = PENDING_UPLOAD_MAX_AGE_MS): Promise<number> {
    const cutoff = this.now() - maxAgeMs
    let removed = 0
    for (;;) {
      const batch = await this.records.createdBefore(cutoff, SWEEP_BATCH)
      for (const upload of batch) {
        // A row naming no storable key (it was never written) has only itself to go.
        let key: BlobKey | undefined
        try {
          key = this.fileKey(upload)
        } catch {
          key = undefined
        }
        try {
          if (key !== undefined) await this.files.delete(key)
          await this.records.delete(upload.id)
          removed += 1
        } catch {
          return removed
        }
      }
      if (batch.length < SWEEP_BATCH) return removed
    }
  }
}
