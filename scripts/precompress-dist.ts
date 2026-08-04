/**
 * Pre-compress a built web dist: write `<file>.br` and `<file>.gz` next to every
 * compressible asset so the server can serve them straight off disk.
 *
 * These are immutable, content-hashed files — compressing them once at build time
 * beats deflating 2.7 MB per request on a server whose event loop is already the
 * bottleneck (POD-1655). Brotli runs at quality 11 here for the same reason: the
 * cost is paid once, the bytes ship forever.
 *
 * Skipped: anything already compressed (png/woff2/ico), anything under 1 KB (the
 * framing costs more than it saves), and any output that failed to get smaller.
 *
 * Usage: bun scripts/precompress-dist.ts <dist-dir>
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib'

const gzipAsync = promisify(gzip)
const brotliAsync = promisify(brotliCompress)

const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.webmanifest',
  '.map',
  '.txt',
])
const MIN_BYTES = 1024

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

const dist = process.argv[2]
if (!dist) {
  console.error('usage: precompress-dist.ts <dist-dir>')
  process.exit(1)
}

let files = 0
let rawBytes = 0
let brBytes = 0
let gzBytes = 0

for (const file of walk(dist)) {
  const ext = extname(file).toLowerCase()
  if (!COMPRESSIBLE.has(ext)) continue
  const size = statSync(file).size
  if (size < MIN_BYTES) continue
  const raw = readFileSync(file)

  const [br, gz] = await Promise.all([
    brotliAsync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
      },
    }),
    gzipAsync(raw, { level: 9 }),
  ])

  files += 1
  rawBytes += size
  if (br.byteLength < size) {
    writeFileSync(file + '.br', br)
    brBytes += br.byteLength
  }
  if (gz.byteLength < size) {
    writeFileSync(file + '.gz', gz)
    gzBytes += gz.byteLength
  }
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(2) + ' MB'
console.log(
  `[precompress] ${files} files: ${mb(rawBytes)} raw -> ${mb(brBytes)} br / ${mb(gzBytes)} gzip`,
)
