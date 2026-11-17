/**
 * The S3-compatible adapter [POD-6963 design 2.2 and 2.8].
 *
 * One bucket, one prefix per workspace: workspace `w` keeps key `k` at object
 * `w/k` (design 2.2, B1). A handle is built for one workspace and cannot name
 * another workspace's objects. The adapter accepts workspace `local` too, so a
 * self-hosted operator may point the server at a bucket.
 *
 * It runs on Bun's built-in S3 client and falls back to the AWS SDK v3 S3
 * client only for what Bun 1.4's client lacks:
 *
 * | Operation | Client | Why |
 * |---|---|---|
 * | `get` (ranged) | Bun: a presigned GET, fetched | one request returns the bytes, `ETag` and `Content-Range` together; a 416 is mapped to an empty body |
 * | `head` | Bun `stat` | |
 * | `delete` | Bun `delete` | idempotent on S3 and R2 |
 * | `list` | Bun `list` | ListObjectsV2 pages, in the provider's key order |
 * | streamed `put` | Bun `write` | multipart upload, aborted when the source stream fails |
 * | whole-body `put` | AWS SDK `PutObject` | Bun's `write` sends no `If-None-Match`/`If-Match` and returns a byte count, not the `ETag` |
 * | `copy` | AWS SDK `CopyObject` | Bun's client has no server-side copy |
 *
 * The SDK is loaded on first use, so a server on the local backend never loads it.
 *
 * Behaviour the interface leaves to the provider:
 *
 * - **ETags** are the provider's. A single-part PUT's ETag is the MD5 of the
 *   bytes on S3 and R2, so putting identical bytes twice returns the same etag;
 *   an `ifMatch` compares content, not write identity.
 * - **A streamed put's etag** is read back with a HEAD after the upload. A
 *   different writer replacing the key between the two would make it name that
 *   writer's version; streams are for whole-object writes at a key with one
 *   writer (a composed publish). A conditional put with a stream body is read
 *   into memory and sent as one `PutObject`.
 * - **Retries.** Both clients retry failed requests. A conditional put whose
 *   first attempt landed but whose answer was lost comes back refused by its own
 *   write; callers already treat a refusal as "re-read and start over".
 */

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
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(message)
  }
}

const DEFAULT_PART_SIZE = 8 * 1024 * 1024
const MIN_PART_SIZE = 5 * 1024 * 1024
const DEFAULT_LIST_PAGE_SIZE = 1000
/** Lifetime of the presigned URL a `get` fetches at once. */
const GET_URL_SECONDS = 300

// --- Bun's S3 client, typed off `globalThis` (no @types/bun in this package) ---

interface BunS3Options {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

interface BunS3Stats {
  size: number
  etag: string
}

interface BunS3ListResponse {
  contents?: Array<{ key: string; size?: number }>
  isTruncated?: boolean
  nextContinuationToken?: string
}

interface BunS3Client {
  write(
    path: string,
    data: Response,
    options?: { type?: string; partSize?: number },
  ): Promise<number>
  stat(path: string): Promise<BunS3Stats>
  delete(path: string): Promise<void>
  list(input: {
    prefix: string
    maxKeys: number
    continuationToken?: string
  }): Promise<BunS3ListResponse>
  presign(path: string, options: { method: 'GET'; expiresIn: number }): string
}

type BunS3ClientConstructor = new (options: BunS3Options) => BunS3Client

function bunS3Client(options: BunS3Options): BunS3Client {
  const ctor = (globalThis as { Bun?: { S3Client?: BunS3ClientConstructor } }).Bun?.S3Client
  if (ctor === undefined) {
    throw new Error('the S3 blob store needs the Bun runtime (Bun.S3Client)')
  }
  return new ctor(options)
}

// --- The AWS SDK, loaded on first use ---

type SdkModule = typeof import('@aws-sdk/client-s3')

interface SdkClient {
  module: SdkModule
  client: InstanceType<SdkModule['S3Client']>
}

/** The provider's status and error code, from a Bun S3Error or an SDK exception. */
function providerError(error: unknown): { status: number | undefined; code: string | undefined } {
  if (typeof error !== 'object' || error === null) return { status: undefined, code: undefined }
  const e = error as {
    name?: unknown
    code?: unknown
    Code?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  const status =
    typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : undefined
  const code =
    typeof e.code === 'string'
      ? e.code
      : typeof e.Code === 'string'
        ? e.Code
        : typeof e.name === 'string'
          ? e.name
          : undefined
  return { status, code }
}

function isNotFound(error: unknown): boolean {
  const { status, code } = providerError(error)
  return status === 404 || code === 'NoSuchKey' || code === 'NotFound'
}

/** `bytes a-b/size` or `bytes *\/size` → size. */
function totalFromContentRange(header: string | null): number | undefined {
  const match = header === null ? null : /\/(\d+)\s*$/.exec(header)
  return match === null ? undefined : Number(match[1])
}

function requireHeader(response: Response, name: string, key: BlobKey): string {
  const value = response.headers.get(name)
  if (value === null) {
    throw new S3RequestError(
      `GET ${key}: the provider sent no ${name} header`,
      response.status,
      undefined,
    )
  }
  return value
}

function emptyBody(): ReadableStream<Uint8Array> {
  return bytesStream(new Uint8Array())
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
    const url = this.storage.bun.presign(name, { method: 'GET', expiresIn: GET_URL_SECONDS })
    const headers: Record<string, string> =
      range === undefined
        ? {}
        : { range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
    const response = await fetch(url, { headers })
    if (response.status === 404) {
      // A missing key is `undefined`; a missing bucket is a misconfiguration.
      const code = /<Code>([^<]+)<\/Code>/.exec(await response.text())?.[1]
      if (code === 'NoSuchBucket') {
        throw new S3RequestError(`GET ${key}: the bucket does not exist`, 404, code)
      }
      return undefined
    }
    if (response.status === 416) {
      // A range that starts at or past the end, or any range of an empty object:
      // no bytes, and the object's real size [design 2.1, `get`]. A 416 carries
      // no ETag, so the head answers for it.
      await response.body?.cancel()
      const head = await this.head(key)
      return head === undefined ? undefined : { ...head, body: emptyBody() }
    }
    if (response.status === 206) {
      const size = totalFromContentRange(response.headers.get('content-range'))
      if (size === undefined) {
        throw new S3RequestError(`GET ${key}: a 206 without a total size`, 206, undefined)
      }
      return {
        body: response.body ?? emptyBody(),
        size,
        etag: requireHeader(response, 'etag', key),
      }
    }
    if (response.status === 200) {
      const etag = requireHeader(response, 'etag', key)
      if (range === undefined) {
        const size = Number(requireHeader(response, 'content-length', key))
        return { body: response.body ?? emptyBody(), size, etag }
      }
      // The provider ignored the range and sent the whole object: clip it here.
      const whole = new Uint8Array(await response.arrayBuffer())
      const start = Math.min(range.offset, whole.byteLength)
      const end = Math.min(whole.byteLength, start + range.length)
      return { body: bytesStream(whole.slice(start, end)), size: whole.byteLength, etag }
    }
    const text = await response.text()
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    throw new S3RequestError(
      `GET ${key}: ${response.status} ${code ?? text.slice(0, 200)}`,
      response.status,
      code,
    )
  }

  async head(key: BlobKey): Promise<BlobHead | undefined> {
    const name = this.name(key)
    try {
      const stats = await this.storage.bun.stat(name)
      return { size: stats.size, etag: stats.etag }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async delete(key: BlobKey): Promise<void> {
    await this.storage.bun.delete(this.name(key))
  }

  async *list(prefix: BlobKey): AsyncIterable<BlobListEntry> {
    const under = `${this.name(prefix)}/`
    let continuationToken: string | undefined
    let previous: string | undefined
    do {
      const page = await this.storage.bun.list({
        prefix: under,
        maxKeys: this.storage.listPageSize,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      })
      for (const entry of page.contents ?? []) {
        // Sweeps and the orphan audit rely on ascending byte order [design 2.1,
        // `list`]; a provider that breaks it fails loudly rather than silently.
        if (
          previous !== undefined &&
          Buffer.compare(Buffer.from(previous), Buffer.from(entry.key)) >= 0
        ) {
          throw new S3RequestError(
            `list ${prefix}: the provider listed ${entry.key} after ${previous}, not in ascending key order`,
            undefined,
            undefined,
          )
        }
        previous = entry.key
        if (!entry.key.startsWith(under)) continue
        yield { key: blobKey(entry.key.slice(this.prefix.length)), size: entry.size ?? 0 }
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
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
      if (isNotFound(error)) throw new BlobNotFound(from)
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
      if (out.ETag === undefined) {
        throw new S3RequestError(`put ${key}: the provider returned no ETag`, undefined, undefined)
      }
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

  private async putStream(
    key: BlobKey,
    name: string,
    body: ReadableStream<Uint8Array>,
    contentType: string | undefined,
  ): Promise<BlobHead> {
    // Bun buffers up to one part and sends a single PUT when the stream fits in
    // it; otherwise a multipart upload, aborted if the stream errors, so a
    // failed source never leaves a partial object.
    await this.storage.bun.write(name, new Response(body), {
      partSize: this.storage.partSize,
      ...(contentType === undefined ? {} : { type: contentType }),
    })
    const head = await this.head(key)
    if (head === undefined) {
      throw new S3RequestError(
        `put ${key}: the object is missing right after its upload`,
        undefined,
        undefined,
      )
    }
    return head
  }

  private name(key: BlobKey): string {
    return this.prefix + blobKey(key)
  }
}

/**
 * 412 is a refused condition. 409 `ConditionalRequestConflict` is S3 saying a
 * concurrent write to the key raced this one: the condition may no longer hold,
 * and the caller re-reads either way. `NoSuchKey` is S3's answer to `If-Match`
 * on a missing key (a missing bucket is `NoSuchBucket`, which stays an error).
 */
function isConditionRefusal(error: unknown, condition: 'ifAbsent' | 'ifMatch'): boolean {
  const { status, code } = providerError(error)
  if (status === 412 || code === 'PreconditionFailed') return true
  if (status === 409 || code === 'ConditionalRequestConflict') return true
  return condition === 'ifMatch' && code === 'NoSuchKey'
}

export class S3BlobStorage implements BlobStorage {
  readonly bucket: string
  readonly conditionalWrites: boolean
  readonly partSize: number
  readonly listPageSize: number
  /** @internal */
  readonly bun: BunS3Client
  private readonly options: S3BlobStorageOptions
  private sdkClient: Promise<SdkClient> | undefined

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
    this.bun = bunS3Client({
      endpoint: options.endpoint,
      bucket: options.bucket,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
    })
  }

  forWorkspace(workspaceId: WorkspaceId): BlobStore {
    // The id is the first segment of every object name, so it must be one valid segment.
    if (!isKeySegment(workspaceId) || workspaceId.startsWith('~')) {
      throw new TypeError(`invalid workspace id ${JSON.stringify(workspaceId)}`)
    }
    return new S3BlobStore(this, workspaceId)
  }

  /** @internal The SDK client, created on first use. */
  sdk(): Promise<SdkClient> {
    this.sdkClient ??= import('@aws-sdk/client-s3').then((module) => ({
      module,
      client: new module.S3Client({
        endpoint: this.options.endpoint,
        region: this.options.region,
        // Path style, as Bun's client uses: `<endpoint>/<bucket>/<key>`.
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
    return this.sdkClient
  }
}
