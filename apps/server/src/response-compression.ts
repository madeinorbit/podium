import { gzip } from 'node:zlib'

export const HTTP_COMPRESSION_MIN_BYTES = 1024
export const HTTP_COMPRESSION_MAX_BYTES = 8 * 1024 * 1024
export const HTTP_COMPRESSION_MAX_CONCURRENCY = 2

const COMPRESSIBLE_TYPES = [
  /^text\//i,
  /^application\/(?:[a-z0-9.+-]+\+)?json\b/i,
  /^application\/(?:javascript|xml|x-javascript)\b/i,
  /^image\/svg\+xml\b/i,
]

let activeJobs = 0

function acceptsGzip(value: string | null): boolean {
  if (!value) return false
  let wildcard = false
  for (const item of value.split(',')) {
    const [rawToken, ...parameters] = item.trim().toLowerCase().split(';')
    const token = rawToken?.trim()
    const q = parameters
      .map((part) => /^q\s*=\s*([0-9.]+)$/.exec(part.trim())?.[1])
      .find((part): part is string => part !== undefined)
    const allowed = q === undefined || Number(q) > 0
    if (token === 'gzip') return allowed
    if (token === '*') wildcard = allowed
  }
  return wildcard
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get('vary')
  if (!current) {
    headers.set('vary', value)
    return
  }
  const values = current.split(',').map((part) => part.trim().toLowerCase())
  if (!values.includes(value.toLowerCase())) headers.set('vary', `${current}, ${value}`)
}

function eligible(request: Request, response: Response): boolean {
  if (request.method === 'HEAD' || !acceptsGzip(request.headers.get('accept-encoding')))
    return false
  if (response.status === 204 || response.status === 206 || response.status === 304) return false
  if (response.body === null || response.headers.has('content-encoding')) return false
  if (response.headers.has('content-range')) return false
  if (/\bno-transform\b/i.test(response.headers.get('cache-control') ?? '')) return false
  const type = response.headers.get('content-type') ?? ''
  if (!COMPRESSIBLE_TYPES.some((pattern) => pattern.test(type))) return false
  const declared = Number(response.headers.get('content-length') ?? '0')
  return !Number.isFinite(declared) || declared <= HTTP_COMPRESSION_MAX_BYTES
}

function gzipAsync(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(bytes, { level: 4 }, (error, compressed) => {
      if (error) reject(error)
      else resolve(compressed)
    })
  })
}

async function readAtMost(response: Response, limit: number): Promise<Uint8Array | null> {
  const body = response.clone().body
  if (!body) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function rebuilt(
  response: Response,
  body: ConstructorParameters<typeof Response>[0],
  headers = new Headers(response.headers),
): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Compress one eligible HTTP response without letting compression become a
 * second event-loop or memory incident. Jobs run through zlib's asynchronous
 * worker path, no more than two at once; saturation serves identity immediately.
 */
export async function compressHttpResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!eligible(request, response) || activeJobs >= HTTP_COMPRESSION_MAX_CONCURRENCY) {
    return response
  }

  activeJobs += 1
  try {
    // Read a clone so an unknown-length stream that crosses the ceiling can
    // immediately fall back to its untouched original response. This bounds
    // compression's added buffering even when an extension route omits length.
    const bytes = await readAtMost(response, HTTP_COMPRESSION_MAX_BYTES)
    if (bytes === null || bytes.byteLength < HTTP_COMPRESSION_MIN_BYTES) return response
    const compressed = await gzipAsync(bytes)
    // Require a material win after framing. Highly entropic bodies (including
    // accidental already-compressed data with a misleading text type) stay raw.
    if (compressed.byteLength + 32 >= bytes.byteLength * 0.95) return response
    const headers = new Headers(response.headers)
    headers.set('content-encoding', 'gzip')
    headers.delete('content-length')
    appendVary(headers, 'Accept-Encoding')
    return rebuilt(response, new Uint8Array(compressed), headers)
  } catch {
    return response
  } finally {
    activeJobs -= 1
  }
}
