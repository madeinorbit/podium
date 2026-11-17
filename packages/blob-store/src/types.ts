/**
 * The blob store interface [POD-6963 design 2.1].
 *
 * Shaped by what an S3-compatible object store can do: whole-object writes,
 * ranged reads, conditional writes, no append, no rename, no write at an
 * offset. Local disk is the special case behind the same interface.
 *
 * A `BlobStore` is built for one workspace by `BlobStorage.forWorkspace`.
 * Callers pass keys relative to that workspace and cannot name another
 * workspace's prefix; a handle cannot be re-pointed.
 */

import type { WorkspaceId } from '@podium/model'
import type { BlobKey } from './key'

/** The one workspace of a self-hosted install; the local adapter accepts no other. */
export const LOCAL_WORKSPACE_ID = 'local' as WorkspaceId

export type BlobBody = Uint8Array | ReadableStream<Uint8Array>

export interface BlobPutOptions {
  contentType?: string
  /** Refuse when the key exists (S3 `If-None-Match: *`). */
  ifAbsent?: true
  /** Refuse unless the stored etag equals this (S3 `If-Match`). A missing key refuses. */
  ifMatch?: string
  /**
   * Local disk only: fsync the file before the rename and its directory after it
   * (default true). Object stores ignore it: an acknowledged PUT is durable.
   */
  durable?: boolean
}

export interface BlobCopyOptions {
  /** As {@link BlobPutOptions.durable}. */
  durable?: boolean
}

export interface BlobDeleteOptions {
  /** Local disk only: fsync the directory after the unlink (default true). */
  durable?: boolean
}

export interface BlobRange {
  offset: number
  length: number
}

export interface BlobHead {
  /** The whole object's size in bytes. */
  size: number
  etag: string
}

export interface BlobGetResult extends BlobHead {
  /**
   * The requested bytes. With a range, the range clipped to the object: an
   * `offset` at or past the end is an empty body, a range that runs past the
   * end returns the bytes up to it. `size` is always the whole object's size.
   */
  body: ReadableStream<Uint8Array>
}

export interface BlobListEntry {
  key: BlobKey
  size: number
  /**
   * When the object was last written, epoch ms: the file's mtime on local disk,
   * `LastModified` on S3 (second precision). The orphan audit's age rule reads
   * it; an adapter that cannot tell answers the time of the listing, so an
   * object of unknown age is never taken for an old one.
   */
  modifiedAt: number
}

export interface BlobStore {
  /**
   * Replace the object at `key` with `body`, atomically from a reader's point
   * of view: a reader sees the old bytes or the new ones, never a mix. A refused
   * `ifAbsent` or `ifMatch` throws {@link BlobConditionFailed}.
   */
  put(key: BlobKey, body: BlobBody, opts?: BlobPutOptions): Promise<BlobHead>
  /** A missing key returns `undefined`. See {@link BlobGetResult} for ranges. */
  get(key: BlobKey, range?: BlobRange): Promise<BlobGetResult | undefined>
  head(key: BlobKey): Promise<BlobHead | undefined>
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: BlobKey, opts?: BlobDeleteOptions): Promise<void>
  /**
   * Every key strictly under `prefix/`, in ascending order of key bytes (what
   * S3's ListObjectsV2 returns). For sweeps, audits and conversion checks only;
   * no request path lists.
   */
  list(prefix: BlobKey): AsyncIterable<BlobListEntry>
  /**
   * Replace `to` with the bytes of `from` (server-side on S3, a file copy on
   * disk). A missing `from` throws {@link BlobNotFound}.
   */
  copy(from: BlobKey, to: BlobKey, opts?: BlobCopyOptions): Promise<void>
  /** The adapter honours `ifAbsent` and `ifMatch`. */
  readonly conditionalWrites: boolean
}

export interface BlobStorage {
  forWorkspace(workspaceId: WorkspaceId): BlobStore
}

/** A conditional `put` (`ifAbsent` or `ifMatch`) was refused. */
export class BlobConditionFailed extends Error {
  override readonly name = 'BlobConditionFailed'
  constructor(
    readonly key: BlobKey,
    readonly condition: 'ifAbsent' | 'ifMatch',
  ) {
    super(`blob ${condition} condition failed for ${key}`)
  }
}

/** `copy` named a source key that does not exist. */
export class BlobNotFound extends Error {
  override readonly name = 'BlobNotFound'
  constructor(readonly key: BlobKey) {
    super(`blob not found: ${key}`)
  }
}

/**
 * The transfer fence every local write runs inside: the server's
 * `PortableStateFence` satisfies it structurally, so this package needs no
 * apps import. A held fence makes `runWriter` throw before the writer starts.
 */
export interface PortableStateWriteFence {
  runWriter<T>(writer: () => Promise<T>): Promise<T>
}

export function assertRange(range: BlobRange): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new RangeError(`blob range offset must be a non-negative integer, got ${range.offset}`)
  }
  if (!Number.isSafeInteger(range.length) || range.length < 0) {
    throw new RangeError(`blob range length must be a non-negative integer, got ${range.length}`)
  }
}

/** The `[start, end)` byte window a range selects from an object of `size` bytes. */
export function clipRange(
  size: number,
  range: BlobRange | undefined,
): { start: number; end: number } {
  if (range === undefined) return { start: 0, end: size }
  assertRange(range)
  const start = Math.min(range.offset, size)
  return { start, end: Math.min(size, start + range.length) }
}
