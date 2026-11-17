/**
 * The in-memory adapter: object-store semantics for tests [POD-6963 design 2.1].
 *
 * One map plays one bucket. Every workspace is a `<workspaceId>/` prefix in it,
 * as on hosted (design 2.2, B1), so two workspaces with the same keys can share
 * one bucket in an isolation test and still never see each other's objects.
 * Puts replace whole objects, conditional writes are honoured, and `list`
 * returns keys in ascending byte order.
 */

import type { WorkspaceId } from '@podium/model'
import { bytesStream, collectBody } from './internal'
import { type BlobKey, blobKey } from './key'
import {
  type BlobBody,
  BlobConditionFailed,
  type BlobCopyOptions,
  type BlobGetResult,
  type BlobHead,
  type BlobListEntry,
  BlobNotFound,
  type BlobPutOptions,
  type BlobRange,
  type BlobStorage,
  type BlobStore,
  clipRange,
} from './types'

interface MemoryObject {
  bytes: Uint8Array
  etag: string
  contentType: string | undefined
}

/** One bucket's objects, keyed by `<workspaceId>/<key>`. */
export class MemoryBucket {
  readonly objects = new Map<string, MemoryObject>()
  private nextEtag = 1

  mintEtag(): string {
    const etag = `"m${this.nextEtag}"`
    this.nextEtag += 1
    return etag
  }

  /** Every full object name (`<workspaceId>/<key>`) in the bucket, sorted. */
  names(): string[] {
    return [...this.objects.keys()].sort(compareBytes)
  }
}

function compareBytes(a: string, b: string): number {
  // Valid keys and workspace prefixes are ASCII, so UTF-16 order is byte order.
  return a < b ? -1 : a > b ? 1 : 0
}

class MemoryBlobStore implements BlobStore {
  readonly conditionalWrites = true
  private readonly prefix: string

  constructor(
    private readonly bucket: MemoryBucket,
    workspaceId: WorkspaceId,
  ) {
    this.prefix = `${workspaceId}/`
  }

  async put(key: BlobKey, body: BlobBody, opts: BlobPutOptions = {}): Promise<BlobHead> {
    const name = this.name(key)
    const bytes = await collectBody(body)
    // No await between the check and the write: the pair is atomic.
    const current = this.bucket.objects.get(name)
    if (opts.ifAbsent && current !== undefined) throw new BlobConditionFailed(key, 'ifAbsent')
    if (opts.ifMatch !== undefined && current?.etag !== opts.ifMatch) {
      throw new BlobConditionFailed(key, 'ifMatch')
    }
    const etag = this.bucket.mintEtag()
    this.bucket.objects.set(name, { bytes, etag, contentType: opts.contentType })
    return { etag, size: bytes.byteLength }
  }

  async get(key: BlobKey, range?: BlobRange): Promise<BlobGetResult | undefined> {
    const object = this.bucket.objects.get(this.name(key))
    if (object === undefined) return undefined
    const { start, end } = clipRange(object.bytes.byteLength, range)
    return {
      body: bytesStream(object.bytes.slice(start, end)),
      size: object.bytes.byteLength,
      etag: object.etag,
    }
  }

  async head(key: BlobKey): Promise<BlobHead | undefined> {
    const object = this.bucket.objects.get(this.name(key))
    if (object === undefined) return undefined
    return { size: object.bytes.byteLength, etag: object.etag }
  }

  async delete(key: BlobKey): Promise<void> {
    this.bucket.objects.delete(this.name(key))
  }

  async *list(prefix: BlobKey): AsyncIterable<BlobListEntry> {
    const under = `${this.name(prefix)}/`
    for (const name of this.bucket.names()) {
      if (!name.startsWith(under)) continue
      const object = this.bucket.objects.get(name)
      if (object === undefined) continue
      yield { key: blobKey(name.slice(this.prefix.length)), size: object.bytes.byteLength }
    }
  }

  async copy(from: BlobKey, to: BlobKey, _opts?: BlobCopyOptions): Promise<void> {
    const source = this.bucket.objects.get(this.name(from))
    if (source === undefined) throw new BlobNotFound(from)
    this.bucket.objects.set(this.name(to), {
      bytes: source.bytes.slice(),
      etag: this.bucket.mintEtag(),
      contentType: source.contentType,
    })
  }

  private name(key: BlobKey): string {
    return this.prefix + blobKey(key)
  }
}

export class MemoryBlobStorage implements BlobStorage {
  constructor(readonly bucket: MemoryBucket = new MemoryBucket()) {}

  forWorkspace(workspaceId: WorkspaceId): BlobStore {
    if (workspaceId.length === 0 || workspaceId.includes('/')) {
      throw new TypeError(`invalid workspace id ${JSON.stringify(workspaceId)}`)
    }
    return new MemoryBlobStore(this.bucket, workspaceId)
  }
}
