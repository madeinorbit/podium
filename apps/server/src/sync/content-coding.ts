import { constants, createGzip, createZstdCompress } from 'node:zlib'

export type ContentCoding = 'zstd' | 'gzip' | 'identity'
export interface SyncContentEncoder {
  transform(): TransformStream<Uint8Array, Uint8Array> | null
}

/** Invalid weights refuse that token; duplicate tokens use the strictest weight. */
export function negotiateContentCoding(header: string | null): ContentCoding | 'not-acceptable' {
  if (header === null) return 'zstd'
  const weights = new Map<string, number>()
  for (const item of header.split(',')) {
    const [name, ...params] = item.trim().toLowerCase().split(';')
    const token = name?.trim()
    if (!token || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/.test(token)) continue
    let q = 1
    if (params.length) {
      const match = params.length === 1 && /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(params[0]!)
      q = match ? Number(match[1]) : 0
    }
    weights.set(token, Math.min(weights.get(token) ?? 1, q))
  }
  // Unlisted identity is a fallback, not a preference over offered compression.
  const identity = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : -1)
  let selected: ContentCoding | 'not-acceptable' = 'not-acceptable'
  let best = 0
  for (const coding of ['zstd', 'gzip', 'identity'] as const) {
    const q = coding === 'identity' ? identity : weights.get(coding) ?? weights.get('*') ?? 0
    if (q > best) { selected = coding; best = q }
  }
  return selected === 'not-acceptable' && identity === -1 ? 'identity' : selected
}

/** Every write is one record batch and ends with an incremental codec flush. */
export function createContentEncoder(coding: ContentCoding): TransformStream<Uint8Array, Uint8Array> | null {
  if (coding === 'identity') return null
  const compressor = coding === 'zstd'
    ? createZstdCompress({
        params: {
          [constants.ZSTD_c_compressionLevel]: 3,
          [constants.ZSTD_c_windowLog]: 23,
        },
        readableHighWaterMark: 64 * 1024,
        writableHighWaterMark: 64 * 1024,
      })
    : createGzip({ level: 4, readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 })
  const operation = (run: (done: (error?: Error | null) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { compressor.off('error', failed); reject(error) }
      compressor.once('error', failed)
      run((error) => {
        compressor.off('error', failed)
        if (error) reject(error)
        else resolve()
      })
    })
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      compressor.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      compressor.on('error', (error) => controller.error(error))
    },
    async transform(chunk) {
      await operation((done) => { compressor.write(chunk, done) })
      await operation((done) => compressor.flush(
        coding === 'zstd' ? constants.ZSTD_e_flush : constants.Z_SYNC_FLUSH, done,
      ))
    },
    flush() {
      return operation((done) => {
        compressor.once('end', done)
        compressor.end()
      })
    },
    cancel(reason) {
      compressor.destroy(reason instanceof Error ? reason : new Error(String(reason)))
    },
  }, { highWaterMark: 1 }, { highWaterMark: 0 })
}

export function syncResponseHeaders(coding: ContentCoding): Headers {
  const headers = new Headers({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    Vary: 'Accept-Encoding',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (coding !== 'identity') headers.set('Content-Encoding', coding)
  return headers
}
