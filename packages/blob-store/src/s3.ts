/**
 * The S3-compatible adapter [POD-6963 design 2.2 and 2.8].
 *
 * One bucket, one prefix per workspace: workspace `w` keeps key `k` at object
 * `w/k` (design 2.2, B1). A handle is built for one workspace and cannot name
 * another workspace's objects. The adapter accepts workspace `local` too, so a
 * self-hosted operator may point the server at a bucket.
 *
 * Every call goes through one AWS SDK v3 S3 client, path style, loaded on first
 * use so a server on the local backend never loads it:
 *
 * | Operation | S3 call |
 * |---|---|
 * | `get` | GetObject with `Range`; a 416 maps to an empty body with the object's size |
 * | `head` | HeadObject |
 * | `delete` | DeleteObject (idempotent on S3 and R2) |
 * | `list` | ListObjectsV2 pages, checked to be in ascending key order |
 * | `put` | PutObject, with `If-None-Match: *` / `If-Match` for the conditions |
 * | streamed `put` | PutObject when the stream fits in one part, else CreateMultipartUpload, UploadPart, CompleteMultipartUpload; AbortMultipartUpload when the source or an upload fails |
 * | `copy` | CopyObject |
 *
 * Multipart is written here rather than through `@aws-sdk/lib-storage`: the
 * adapter needs one fixed part size, an abort on a failed source and the
 * completed object's ETag, which is a short loop; lib-storage would add a
 * dependency and its own concurrency and retry layer for none of it.
 *
 * Behaviour the interface leaves to the provider:
 *
 * - **ETags** are the provider's. A single-part PUT's ETag is the MD5 of the
 *   bytes on S3 and R2, so putting identical bytes twice returns the same etag;
 *   an `ifMatch` compares content, not write identity.
 * - **A conditional put with a stream body** is read into memory and sent as
 *   one PutObject, so the condition covers the whole object.
 * - **Retries.** The SDK retries failed requests. A conditional put whose first
 *   attempt landed but whose answer was lost comes back refused by its own
 *   write; callers already treat a refusal as "re-read and start over".
 */

import type { GetObjectCommandOutput } from '@aws-sdk/client-s3'
import type { WorkspaceId } from '@podium/model'
import { bytesStream, collectBody } from './internal'
import { type BlobKey, blobKey, isKeySegment } from './key'
import {
  assertRange,
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
} from './types'

/** Where the bucket is and how to reach it. The key pair comes from the environment only. */
export interface S3BlobStorageOptions {
  /** The provider's S3 endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string
  bucket: string
  /** `auto` on R2. */
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /**
   * Whether the provider honours `If-None-Match: *` and `If-Match` on PUT.
   * Default true: AWS S3 and Cloudflare R2 both do. A provider that ignores the
   * headers must be configured false, or a refused condition would overwrite.
   */
  conditionalWrites?: boolean
  /** Part size of a streamed multipart put, in bytes (default 8 MiB; S3's minimum is 5 MiB). */
  partSize?: number
  /** Keys asked for per ListObjectsV2 page (default 1000, S3's maximum). */
  listPageSize?: number
}

/** A request the provider answered with something the adapter cannot map. */
export class S3RequestError extends Error {
  override readonly name = 'S3RequestError'
}

const DEFAULT_PART_SIZE = 8 * 1024 * 1024
const MIN_PART_SIZE = 5 * 1024 * 1024
const DEFAULT_LIST_PAGE_SIZE = 1000

type SdkModule = typeof import('@aws-sdk/client-s3')

/** @internal The loaded SDK and the one client every call uses. */
export interface S3Sdk {
  module: SdkModule
  client: InstanceType<SdkModule['S3Client']>
}

/** The provider's status and error code from an SDK exception. */
function providerError(error: unknown): { status: number | undefined; code: string | undefined } {
  if (typeof error !== 'object' || error === null) return { status: undefined, code: undefined }
  const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } }
  const status =
    typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : undefined
  const code = typeof e.Code === 'string' ? e.Code : typeof e.name === 'string' ? e.name : undefined
  return { status, code }
}

/**
 * A missing key: `NoSuchKey` from a request with a body, `NotFound` from a
 * HEAD, which has none. A missing bucket answers `NoSuchBucket` and stays an
 * error (only a HEAD cannot tell the two apart).
 */
function isMissingKey(error: unknown): boolean {
  const { code } = providerError(error)
  return code === 'NoSuchKey' || code === 'NotFound'
}

/**
 * 412 is a refused condition. 409 `ConditionalRequestConflict` is S3 saying a
 * concurrent write to the key raced this one: the condition may no longer hold,
 * and the caller re-reads either way. `NoSuchKey` is S3's answer to `If-Match`
 * on a missing key.
 */
function isConditionRefusal(error: unknown, condition: 'ifAbsent' | 'ifMatch'): boolean {
  const { status, code } = providerError(error)
  if (status === 412 || code === 'PreconditionFailed') return true
  if (status === 409 || code === 'ConditionalRequestConflict') return true
  return condition === 'ifMatch' && code === 'NoSuchKey'
}

/** `bytes a-b/size` → size. */
function totalFromContentRange(header: string | undefined): number | undefined {
  const match = header === undefined ? null : /\/(\d+)\s*$/.exec(header)
  return match === null ? undefined : Number(match[1])
}

function emptyBody(): ReadableStream<Uint8Array> {
  return bytesStream(new Uint8Array())
}

/** Bytes read from a stream and not yet sent, cut into parts of a fixed size. */
class PartBuffer {
  private chunks: Uint8Array[] = []
  size = 0
  ended = false

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Read until at least `target` bytes are buffered or the stream ends. */
  async fill(target: number): Promise<void> {
    while (!this.ended && this.size < target) {
      const { done, value } = await this.reader.read()
      if (done) this.ended = true
      else if (value.byteLength > 0) {
        this.chunks.push(value)
        this.size += value.byteLength
      }
    }
  }

  /** Remove and return the first `length` buffered bytes (all of them when fewer). */
  take(length: number): Uint8Array {
    const n = Math.min(length, this.size)
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const chunk = this.chunks[0] as Uint8Array
      const used = Math.min(chunk.byteLength, n - at)
      out.set(chunk.subarray(0, used), at)
      at += used
      if (used === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(used)
    }
    this.size -= n
    return out
  }
}

class S3BlobStore implements BlobStore {
  readonly conditionalWrites: boolean
  private readonly prefix: string

  constructor(
    private readonly storage: S3BlobStorage,
    workspaceId: WorkspaceId,
  ) {
    this.conditionalWrites = storage.conditionalWrites
    this.prefix = `${workspaceId}/`
  }

  async put(key: BlobKey, body: BlobBody, opts: BlobPutOptions = {}): Promise<BlobHead> {
    const name = this.name(key)
    const conditional = opts.ifAbsent === true || opts.ifMatch !== undefined
    if (conditional && !this.conditionalWrites) {
      throw new Error(
        `put ${key}: this bucket is configured without conditional writes; check conditionalWrites before passing ifAbsent or ifMatch`,
      )
    }
    if (body instanceof Uint8Array || conditional) {
      return this.putWhole(key, name, await collectBody(body), opts)
    }
    return this.putStream(key, name, body, opts.contentType)
  }

  async get(key: BlobKey, range?: BlobRange): Promise<BlobGetResult | undefined> {
    const name = this.name(key)
    if (range !== undefined) assertRange(range)
    // HTTP cannot ask for zero bytes; the answer is the object's head and no body.
    if (range?.length === 0) {
      const head = await this.head(key)
      return head === undefined ? undefined : { ...head, body: emptyBody() }
    }
    const sdk = await this.storage.sdk()
    let out: GetObjectCommandOutput
    try {
      out = await sdk.client.send(
        new sdk.module.GetObjectCommand({
          Bucket: this.storage.bucket,
          Key: name,
          ...(range === undefined
            ? {}
            : { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }),
        }),
      )
    } catch (error) {
      if (isMissingKey(error)) return undefined
      const { status, code } = providerError(error)
      if (status === 416 || code === 'InvalidRange') {
        // A range that starts at or past the end, or any range of an empty
        // object: no bytes, and the object's real size [design 2.1, `get`]. A
        // 416 carries no ETag, so the head answers for it.
        const head = await this.head(key)
        return head === undefined ? undefined : { ...head, body: emptyBody() }
      }
      throw error
    }
    const body = out.Body?.transformToWebStream() ?? emptyBody()
    if (out.ETag === undefined) {
      await body.cancel()
      throw new S3RequestError(`get ${key}: the provider returned no ETag`)
    }
    const total = totalFromContentRange(out.ContentRange)
    if (total !== undefined) return { body, size: total, etag: out.ETag }
    if (range === undefined) {
      if (out.ContentLength === undefined) {
        await body.cancel()
        throw new S3RequestError(`get ${key}: the provider returned no size`)
      }
      return { body, size: out.ContentLength, etag: out.ETag }
    }
    // The provider ignored the range and sent the whole object: clip it here.
    const bytes = new Uint8Array(await new Response(body).arrayBuffer())
    const start = Math.min(range.offset, bytes.byteLength)
    const end = Math.min(bytes.byteLength, start + range.length)
    return { body: bytesStream(bytes.slice(start, end)), size: bytes.byteLength, etag: out.ETag }
  }

  async head(key: BlobKey): Promise<BlobHead | undefined> {
    const name = this.name(key)
    const sdk = await this.storage.sdk()
    let out: { ETag?: string; ContentLength?: number }
    try {
      out = await sdk.client.send(
        new sdk.module.HeadObjectCommand({ Bucket: this.storage.bucket, Key: name }),
      )
    } catch (error) {
      if (isMissingKey(error)) return undefined
      throw error
    }
    if (out.ETag === undefined || out.ContentLength === undefined) {
      throw new S3RequestError(`head ${key}: the provider returned no ETag or size`)
    }
    return { size: out.ContentLength, etag: out.ETag }
  }

  async delete(key: BlobKey): Promise<void> {
    const name = this.name(key)
    const sdk = await this.storage.sdk()
    await sdk.client.send(
      new sdk.module.DeleteObjectCommand({ Bucket: this.storage.bucket, Key: name }),
    )
  }

  async *list(prefix: BlobKey): AsyncIterable<BlobListEntry> {
    const under = `${this.name(prefix)}/`
    const sdk = await this.storage.sdk()
    let continuationToken: string | undefined
    let previous: string | undefined
    do {
      const page = await sdk.client.send(
        new sdk.module.ListObjectsV2Command({
          Bucket: this.storage.bucket,
          Prefix: under,
          MaxKeys: this.storage.listPageSize,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      )
      for (const entry of page.Contents ?? []) {
        const name = entry.Key
        if (name === undefined) continue
        // Sweeps and the orphan audit rely on ascending byte order [design 2.1,
        // `list`]; a provider that breaks it fails loudly rather than silently.
        if (
          previous !== undefined &&
          Buffer.compare(Buffer.from(previous), Buffer.from(name)) >= 0
        ) {
          throw new S3RequestError(
            `list ${prefix}: the provider listed ${name} after ${previous}, not in ascending key order`,
          )
        }
        previous = name
        if (!name.startsWith(under)) continue
        yield {
          key: blobKey(name.slice(this.prefix.length)),
          size: entry.Size ?? 0,
          modifiedAt: entry.LastModified?.getTime() ?? Date.now(),
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
  }

  async copy(from: BlobKey, to: BlobKey, _opts?: BlobCopyOptions): Promise<void> {
    const fromName = this.name(from)
    const toName = this.name(to)
    const sdk = await this.storage.sdk()
    try {
      await sdk.client.send(
        new sdk.module.CopyObjectCommand({
          Bucket: this.storage.bucket,
          Key: toName,
          // Valid keys and workspace ids are URL-safe, so the source needs no encoding.
          CopySource: `${this.storage.bucket}/${fromName}`,
        }),
      )
    } catch (error) {
      if (providerError(error).code === 'NoSuchKey') throw new BlobNotFound(from)
      throw error
    }
  }

  private async putWhole(
    key: BlobKey,
    name: string,
    bytes: Uint8Array,
    opts: BlobPutOptions,
  ): Promise<BlobHead> {
    const sdk = await this.storage.sdk()
    try {
      const out = await sdk.client.send(
        new sdk.module.PutObjectCommand({
          Bucket: this.storage.bucket,
          Key: name,
          Body: bytes,
          ...(opts.contentType === undefined ? {} : { ContentType: opts.contentType }),
          ...(opts.ifAbsent ? { IfNoneMatch: '*' } : {}),
          ...(opts.ifMatch === undefined ? {} : { IfMatch: opts.ifMatch }),
        }),
      )
      if (out.ETag === undefined)
        throw new S3RequestError(`put ${key}: the provider returned no ETag`)
      return { etag: out.ETag, size: bytes.byteLength }
    } catch (error) {
      const condition = opts.ifAbsent
        ? 'ifAbsent'
        : opts.ifMatch !== undefined
          ? 'ifMatch'
          : undefined
      if (condition !== undefined && isConditionRefusal(error, condition)) {
        throw new BlobConditionFailed(key, condition)
      }
      throw error
    }
  }

  /**
   * One PutObject when the stream fits in a part; otherwise a multipart upload
   * whose parts are all exactly `partSize` but the last (S3 requires at least
   * 5 MiB). Completing the upload is the one moment the object appears, whole;
   * a failed source or upload aborts it, so no partial object is ever visible.
   */
  private async putStream(
    key: BlobKey,
    name: string,
    body: ReadableStream<Uint8Array>,
    contentType: string | undefined,
  ): Promise<BlobHead> {
    const partSize = this.storage.partSize
    const reader = body.getReader()
    const buffer = new PartBuffer(reader)
    // One byte past a part tells a last part from a full one.
    const isLastPart = () => buffer.ended && buffer.size <= partSize
    try {
      await buffer.fill(partSize + 1)
      const typed = contentType === undefined ? {} : { contentType }
      if (isLastPart()) return await this.putWhole(key, name, buffer.take(partSize), typed)
      const sdk = await this.storage.sdk()
      const target = { Bucket: this.storage.bucket, Key: name }
      const created = await sdk.client.send(
        new sdk.module.CreateMultipartUploadCommand({
          ...target,
          ...(contentType === undefined ? {} : { ContentType: contentType }),
        }),
      )
      const uploadId = created.UploadId
      if (uploadId === undefined) throw new S3RequestError(`put ${key}: no upload id returned`)
      try {
        const parts: Array<{ ETag: string; PartNumber: number }> = []
        let size = 0
        let last = false
        while (!last) {
          await buffer.fill(partSize + 1)
          last = isLastPart()
          const bytes = buffer.take(partSize)
          // A stream that ends exactly on a part boundary leaves nothing for a last part.
          if (bytes.byteLength === 0) break
          const partNumber = parts.length + 1
          const out = await sdk.client.send(
            new sdk.module.UploadPartCommand({
              ...target,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: bytes,
            }),
          )
          if (out.ETag === undefined) {
            throw new S3RequestError(`put ${key}: part ${partNumber} returned no ETag`)
          }
          parts.push({ ETag: out.ETag, PartNumber: partNumber })
          size += bytes.byteLength
        }
        const completed = await sdk.client.send(
          new sdk.module.CompleteMultipartUploadCommand({
            ...target,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        )
        if (completed.ETag === undefined) {
          throw new S3RequestError(`put ${key}: the completed upload returned no ETag`)
        }
        return { etag: completed.ETag, size }
      } catch (error) {
        await sdk.client
          .send(new sdk.module.AbortMultipartUploadCommand({ ...target, UploadId: uploadId }))
          .catch(() => undefined)
        throw error
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  private name(key: BlobKey): string {
    return this.prefix + blobKey(key)
  }
}

export class S3BlobStorage implements BlobStorage {
  readonly bucket: string
  readonly conditionalWrites: boolean
  readonly partSize: number
  readonly listPageSize: number
  private readonly options: S3BlobStorageOptions
  private loaded: Promise<S3Sdk> | undefined

  constructor(options: S3BlobStorageOptions) {
    for (const field of [
      'endpoint',
      'bucket',
      'region',
      'accessKeyId',
      'secretAccessKey',
    ] as const) {
      if (options[field].length === 0) throw new TypeError(`S3 blob storage: ${field} is empty`)
    }
    const partSize = options.partSize ?? DEFAULT_PART_SIZE
    if (!Number.isSafeInteger(partSize) || partSize < MIN_PART_SIZE) {
      throw new RangeError(`S3 blob storage: partSize must be at least ${MIN_PART_SIZE} bytes`)
    }
    const listPageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE
    if (!Number.isSafeInteger(listPageSize) || listPageSize < 1 || listPageSize > 1000) {
      throw new RangeError('S3 blob storage: listPageSize must be between 1 and 1000')
    }
    this.options = options
    this.bucket = options.bucket
    this.conditionalWrites = options.conditionalWrites ?? true
    this.partSize = partSize
    this.listPageSize = listPageSize
  }

  forWorkspace(workspaceId: WorkspaceId): BlobStore {
    // The id is the first segment of every object name, so it must be one plain segment.
    if (!isKeySegment(workspaceId) || workspaceId.startsWith('~')) {
      throw new TypeError(`invalid workspace id ${JSON.stringify(workspaceId)}`)
    }
    return new S3BlobStore(this, workspaceId)
  }

  /** @internal The SDK and its one client, loaded on first use. */
  sdk(): Promise<S3Sdk> {
    this.loaded ??= import('@aws-sdk/client-s3').then((module) => ({
      module,
      client: new module.S3Client({
        endpoint: this.options.endpoint,
        region: this.options.region,
        // Path style, `<endpoint>/<bucket>/<key>`, which every S3-compatible provider serves.
        forcePathStyle: true,
        credentials: {
          accessKeyId: this.options.accessKeyId,
          secretAccessKey: this.options.secretAccessKey,
          ...(this.options.sessionToken === undefined
            ? {}
            : { sessionToken: this.options.sessionToken }),
        },
        // The SDK's default CRC checksums on every request are not accepted by
        // every S3-compatible provider; send them only where S3 requires one.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
    }))
    return this.loaded
  }
}
