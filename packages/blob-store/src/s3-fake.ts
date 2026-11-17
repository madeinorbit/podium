/**
 * An in-process S3-compatible server for the S3 adapter's tests [POD-6963 design 2.8].
 *
 * It speaks the slice of the S3 REST API the adapter uses, path style
 * (`/<bucket>/<key>`), over one in-memory bucket, with the provider behaviour
 * the adapter has to map:
 *
 * - `PUT` with `If-None-Match: *` and `If-Match`: 412 `PreconditionFailed` on a
 *   refused condition, 404 `NoSuchKey` for `If-Match` on a missing key (as S3
 *   answers), and an optional forced 409 `ConditionalRequestConflict`.
 * - Single-part ETags are the quoted MD5 of the bytes, multipart ETags
 *   `"<md5 of the part md5s>-<parts>"`, as on S3 and R2, so identical bytes
 *   give identical ETags.
 * - `GET` with `Range`: 206 with `Content-Range`, 416 `InvalidRange` with
 *   `Content-Range: bytes *\/<size>` for a start at or past the end and for any
 *   range on an empty object.
 * - `ListObjectsV2` in ascending byte order, paged by `max-keys` (capped by
 *   {@link S3FakeOptions.maxPageSize}) and continuation tokens.
 * - `CopyObject` through `x-amz-copy-source`, multipart create, upload part,
 *   complete and abort, `HEAD` and idempotent `DELETE`.
 *
 * It checks no signatures. Every request is logged in {@link S3Fake.requests}
 * so a test can assert which calls the adapter made.
 */

import { createHash, randomUUID } from 'node:crypto'

export interface S3FakeOptions {
  bucket?: string
  /** Most keys one list page returns, whatever `max-keys` asks for (default 1000). */
  maxPageSize?: number
  /** When false the fake ignores `If-None-Match` and `If-Match`, like a provider without conditional writes. */
  honourConditions?: boolean
  /** When true the fake lists keys in descending order, to prove the adapter refuses that. */
  listDescending?: boolean
}

export interface S3FakeObject {
  bytes: Uint8Array
  etag: string
  contentType: string | undefined
}

export interface S3FakeRequest {
  method: string
  /** The object name without the bucket (`<workspaceId>/<key>`), or '' for a bucket request. */
  name: string
  query: Record<string, string>
  headers: Record<string, string>
  status: number
}

interface PendingUpload {
  name: string
  contentType: string | undefined
  parts: Map<number, { bytes: Uint8Array; md5: Buffer }>
}

interface BunServer {
  port: number
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

interface BunServeRuntime {
  serve(options: {
    port: number
    hostname: string
    fetch(request: Request): Response | Promise<Response>
  }): BunServer
}

function bunRuntime(): BunServeRuntime {
  const bun = (globalThis as { Bun?: BunServeRuntime }).Bun
  if (bun === undefined) throw new Error('the S3 fake needs the Bun runtime (Bun.serve)')
  return bun
}

function md5(bytes: Uint8Array): Buffer {
  return createHash('md5').update(bytes).digest()
}

function compareNames(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function xml(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { 'content-type': 'application/xml', ...headers },
  })
}

function s3Error(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return xml(
    status,
    `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`,
    headers,
  )
}

export class S3Fake {
  readonly bucket: string
  readonly objects = new Map<string, S3FakeObject>()
  readonly uploads = new Map<string, PendingUpload>()
  readonly requests: S3FakeRequest[] = []
  /** Answer the next N conditional puts with 409 `ConditionalRequestConflict`. */
  conflictNextConditionalPuts = 0
  private readonly maxPageSize: number
  private readonly honourConditions: boolean
  private readonly listDescending: boolean
  private server: BunServer | undefined

  constructor(options: S3FakeOptions = {}) {
    this.bucket = options.bucket ?? 'test-bucket'
    this.maxPageSize = options.maxPageSize ?? 1000
    this.honourConditions = options.honourConditions ?? true
    this.listDescending = options.listDescending ?? false
  }

  /** Listen on a free loopback port; returns the endpoint URL. */
  start(): string {
    this.server = bunRuntime().serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => this.handle(request),
    })
    return this.endpoint
  }

  get endpoint(): string {
    if (this.server === undefined) throw new Error('the S3 fake is not started')
    return `http://127.0.0.1:${this.server.port}`
  }

  async stop(): Promise<void> {
    await this.server?.stop(true)
    this.server = undefined
  }

  /** Every object name in the bucket, in byte order. */
  names(): string[] {
    return [...this.objects.keys()].sort(compareNames)
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const query = Object.fromEntries(url.searchParams)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const path = decodeURIComponent(url.pathname)
    const bucketPrefix = `/${this.bucket}`
    let response: Response
    let name = ''
    if (path !== bucketPrefix && !path.startsWith(`${bucketPrefix}/`)) {
      response = s3Error(404, 'NoSuchBucket', `no bucket at ${path}`)
    } else {
      name = path.slice(bucketPrefix.length + 1)
      response = await this.route(request, name, query, headers)
    }
    this.requests.push({ method: request.method, name, query, headers, status: response.status })
    return response
  }

  private async route(
    request: Request,
    name: string,
    query: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<Response> {
    const method = request.method
    if (name === '') {
      if (method === 'GET' && query['list-type'] === '2') return this.list(query)
      return s3Error(501, 'NotImplemented', `${method} on the bucket`)
    }
    if (method === 'POST' && 'uploads' in query) return this.createUpload(name, headers)
    if (method === 'PUT' && query.uploadId !== undefined && query.partNumber !== undefined) {
      return this.uploadPart(request, name, query.uploadId, Number(query.partNumber))
    }
    if (method === 'POST' && query.uploadId !== undefined) {
      return this.completeUpload(request, name, query.uploadId)
    }
    if (method === 'DELETE' && query.uploadId !== undefined) {
      this.uploads.delete(query.uploadId)
      return new Response(null, { status: 204 })
    }
    if (method === 'PUT' && headers['x-amz-copy-source'] !== undefined) {
      return this.copy(name, headers['x-amz-copy-source'])
    }
    if (method === 'PUT') return this.put(request, name, headers)
    if (method === 'GET') return this.get(name, headers.range)
    if (method === 'HEAD') return this.head(name)
    if (method === 'DELETE') {
      this.objects.delete(name)
      return new Response(null, { status: 204 })
    }
    return s3Error(501, 'NotImplemented', `${method} ${name}`)
  }

  private conditionRefusal(name: string, headers: Record<string, string>): Response | undefined {
    const ifNoneMatch = headers['if-none-match']
    const ifMatch = headers['if-match']
    if (!this.honourConditions || (ifNoneMatch === undefined && ifMatch === undefined)) {
      return undefined
    }
    if (this.conflictNextConditionalPuts > 0) {
      this.conflictNextConditionalPuts -= 1
      return s3Error(409, 'ConditionalRequestConflict', 'a conflicting operation is in progress')
    }
    const current = this.objects.get(name)
    if (ifNoneMatch !== undefined) {
      if (ifNoneMatch !== '*') return s3Error(501, 'NotImplemented', 'If-None-Match other than *')
      if (current !== undefined) return s3Error(412, 'PreconditionFailed', 'the key exists')
    }
    if (ifMatch !== undefined) {
      if (current === undefined) return s3Error(404, 'NoSuchKey', 'the key does not exist')
      if (current.etag !== ifMatch) return s3Error(412, 'PreconditionFailed', 'etag mismatch')
    }
    return undefined
  }

  private async put(
    request: Request,
    name: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const bytes = new Uint8Array(await request.arrayBuffer())
    // No await between the check and the write: the pair is atomic.
    const refused = this.conditionRefusal(name, headers)
    if (refused !== undefined) return refused
    const etag = `"${md5(bytes).toString('hex')}"`
    this.objects.set(name, { bytes, etag, contentType: headers['content-type'] })
    return new Response(null, { status: 200, headers: { etag } })
  }

  private get(name: string, range: string | undefined): Response {
    const object = this.objects.get(name)
    if (object === undefined) return s3Error(404, 'NoSuchKey', 'the key does not exist')
    const size = object.bytes.byteLength
    const base = { etag: object.etag, 'content-type': object.contentType ?? 'binary/octet-stream' }
    if (range === undefined) {
      return new Response(object.bytes.slice(), {
        status: 200,
        headers: { ...base, 'content-length': String(size) },
      })
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (match === null) return s3Error(400, 'InvalidArgument', `unsupported range ${range}`)
    const start = Number(match[1])
    const last = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
    if (start >= size || last < start) {
      return s3Error(416, 'InvalidRange', 'the requested range is not satisfiable', {
        'content-range': `bytes */${size}`,
      })
    }
    return new Response(object.bytes.slice(start, last + 1), {
      status: 206,
      headers: {
        ...base,
        'content-length': String(last + 1 - start),
        'content-range': `bytes ${start}-${last}/${size}`,
      },
    })
  }

  private head(name: string): Response {
    const object = this.objects.get(name)
    if (object === undefined) return new Response(null, { status: 404 })
    return new Response(null, {
      status: 200,
      headers: {
        etag: object.etag,
        'content-length': String(object.bytes.byteLength),
        'content-type': object.contentType ?? 'binary/octet-stream',
        'last-modified': new Date().toUTCString(),
      },
    })
  }

  private copy(name: string, rawSource: string): Response {
    const source = decodeURIComponent(rawSource).replace(/^\//, '')
    const sourceName = source.startsWith(`${this.bucket}/`)
      ? source.slice(this.bucket.length + 1)
      : undefined
    const object = sourceName === undefined ? undefined : this.objects.get(sourceName)
    if (object === undefined) return s3Error(404, 'NoSuchKey', 'the copy source does not exist')
    const copied = { ...object, bytes: object.bytes.slice() }
    this.objects.set(name, copied)
    return xml(
      200,
      `<CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>${xmlEscape(copied.etag)}</ETag></CopyObjectResult>`,
    )
  }

  private list(query: Record<string, string>): Response {
    const prefix = query.prefix ?? ''
    const requested = Number(query['max-keys'] ?? '1000')
    const pageSize = Math.max(1, Math.min(requested, this.maxPageSize))
    const after =
      query['continuation-token'] !== undefined
        ? Buffer.from(query['continuation-token'], 'base64url').toString('utf8')
        : query['start-after']
    let names = this.names().filter((name) => name.startsWith(prefix))
    if (this.listDescending) names = names.reverse()
    if (after !== undefined) {
      const index = names.indexOf(after)
      names = index < 0 ? names.filter((n) => compareNames(n, after) > 0) : names.slice(index + 1)
    }
    const page = names.slice(0, pageSize)
    const truncated = names.length > page.length
    const contents = page
      .map((name) => {
        const object = this.objects.get(name) as S3FakeObject
        return `<Contents><Key>${xmlEscape(name)}</Key><LastModified>${new Date().toISOString()}</LastModified><ETag>${xmlEscape(object.etag)}</ETag><Size>${object.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
      })
      .join('')
    const last = page.at(-1)
    const next =
      truncated && last !== undefined
        ? `<NextContinuationToken>${Buffer.from(last, 'utf8').toString('base64url')}</NextContinuationToken>`
        : ''
    return xml(
      200,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${this.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
    )
  }

  private createUpload(name: string, headers: Record<string, string>): Response {
    const uploadId = randomUUID()
    this.uploads.set(uploadId, { name, contentType: headers['content-type'], parts: new Map() })
    return xml(
      200,
      `<InitiateMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${xmlEscape(name)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
    )
  }

  private async uploadPart(
    request: Request,
    name: string,
    uploadId: string,
    partNumber: number,
  ): Promise<Response> {
    const upload = this.uploads.get(uploadId)
    if (upload === undefined || upload.name !== name) {
      return s3Error(404, 'NoSuchUpload', 'no such upload')
    }
    const bytes = new Uint8Array(await request.arrayBuffer())
    const digest = md5(bytes)
    upload.parts.set(partNumber, { bytes, md5: digest })
    return new Response(null, { status: 200, headers: { etag: `"${digest.toString('hex')}"` } })
  }

  private async completeUpload(
    request: Request,
    name: string,
    uploadId: string,
  ): Promise<Response> {
    const upload = this.uploads.get(uploadId)
    if (upload === undefined || upload.name !== name) {
      return s3Error(404, 'NoSuchUpload', 'no such upload')
    }
    const body = await request.text()
    const numbers = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]))
    if (numbers.length === 0) return s3Error(400, 'MalformedXML', 'no parts')
    const parts = numbers.map((n) => upload.parts.get(n))
    if (parts.some((part) => part === undefined)) return s3Error(400, 'InvalidPart', 'missing part')
    const present = parts as Array<{ bytes: Uint8Array; md5: Buffer }>
    const size = present.reduce((sum, part) => sum + part.bytes.byteLength, 0)
    const bytes = new Uint8Array(size)
    let at = 0
    for (const part of present) {
      bytes.set(part.bytes, at)
      at += part.bytes.byteLength
    }
    const etag = `"${md5(Buffer.concat(present.map((p) => p.md5))).toString('hex')}-${present.length}"`
    this.objects.set(name, { bytes, etag, contentType: upload.contentType })
    this.uploads.delete(uploadId)
    return xml(
      200,
      `<CompleteMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${xmlEscape(name)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`,
    )
  }
}
