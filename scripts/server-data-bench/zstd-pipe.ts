/**
 * What the first download's content coding costs (POD-7153), on a saved identity body
 * (`first-download.ts produce --encoding=identity --save=<file>`). Times the arm's own
 * encoder (`createContentEncoder`, fed as `pipeSyncBody` feeds it: 64 KiB slices) and
 * plain zlib variants, and how long the JS thread was blocked meanwhile (the longest
 * gap between 1 ms timer ticks), so a coding that runs on the JS thread shows as such.
 *
 *   bun --conditions=@podium/source scripts/server-data-bench/zstd-pipe.ts --checkout=<arm> --body=<file>
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { constants, createZstdCompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { parseArgs } from './seed'

const args = parseArgs(process.argv.slice(2))
const body = new Uint8Array(readFileSync(resolve(args.body!)))
const SLICE = 64 * 1024
const lines: Uint8Array[] = []
for (let at = 0; at < body.byteLength; ) {
  const end = body.indexOf(10, at)
  const stop = end < 0 ? body.byteLength : end + 1
  lines.push(body.subarray(at, stop))
  at = stop
}

function lagMeter() {
  let last = performance.now()
  let worst = 0
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  return () => {
    clearInterval(timer)
    return Math.round(worst)
  }
}

async function timed(name: string, run: () => Promise<number>): Promise<void> {
  const stop = lagMeter()
  const started = performance.now()
  const bytes = await run()
  const ms = Math.round(performance.now() - started)
  console.log(
    `ZSTDPIPE ${JSON.stringify({ name, ms, worstLoopGapMs: stop(), inBytes: body.byteLength, outBytes: bytes, lines: lines.length })}`,
  )
}

/** The arm's encoder, written 64 KiB slices of each line as the body pipe writes them. */
async function armEncoder(): Promise<number> {
  const { createContentEncoder } = await import(
    join(resolve(args.checkout!), 'apps/server/src/sync/content-coding.ts')
  )
  const encoder = createContentEncoder('zstd') as TransformStream<Uint8Array, Uint8Array>
  const writer = encoder.writable.getWriter()
  const reader = encoder.readable.getReader()
  let out = 0
  const drain = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      out += next.value.byteLength
    }
  })()
  for (const line of lines)
    for (let at = 0; at < line.byteLength; at += SLICE)
      await writer.write(line.slice(at, at + SLICE))
  await writer.close()
  await drain
  return out
}

/** A zstd stream at the arm's parameters, written and flushed as `flushEvery` says. */
async function stream(flushEvery: 'slice' | 'line' | 'end'): Promise<number> {
  const z = createZstdCompress({
    params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_windowLog]: 23 },
  })
  let out = 0
  z.on('data', (chunk: Buffer) => {
    out += chunk.byteLength
  })
  const write = (chunk: Uint8Array) => new Promise<void>((done) => z.write(chunk, () => done()))
  const flush = () => new Promise<void>((done) => z.flush(constants.ZSTD_e_flush, () => done()))
  for (const line of lines) {
    for (let at = 0; at < line.byteLength; at += SLICE) {
      await write(line.slice(at, at + SLICE))
      if (flushEvery === 'slice') await flush()
    }
    if (flushEvery === 'line') await flush()
  }
  await new Promise<void>((done) => {
    z.once('end', () => done())
    z.end()
  })
  return out
}

/** Each line written whole, then flushed: one write and one flush per record batch. */
async function lineWrites(): Promise<number> {
  const z = createZstdCompress({
    params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_windowLog]: 23 },
  })
  let out = 0
  z.on('data', (chunk: Buffer) => {
    out += chunk.byteLength
  })
  for (const line of lines) {
    await new Promise<void>((done) => z.write(line, () => done()))
    await new Promise<void>((done) => z.flush(constants.ZSTD_e_flush, () => done()))
  }
  await new Promise<void>((done) => {
    z.once('end', () => done())
    z.end()
  })
  return out
}

/** One zstd frame per line, compressed at once; a decoder reads the frames as one body. */
async function framesPerLine(): Promise<number> {
  const frames = lines.map((line) =>
    zstdCompressSync(line, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
  )
  const joined = Buffer.concat(frames)
  if (!Buffer.from(zstdDecompressSync(joined)).equals(Buffer.from(body)))
    throw new Error('concatenated frames did not decode to the body')
  return joined.byteLength
}

for (let round = 1; round <= Number(args.rounds ?? 2); round++) {
  await timed('stream-line-write-flush', lineWrites)
  await timed('frames-per-line-sync', framesPerLine)
  await timed('arm-encoder', armEncoder)
  await timed('stream-flush-per-slice', () => stream('slice'))
  await timed('stream-flush-per-line', () => stream('line'))
  await timed('stream-flush-at-end', () => stream('end'))
  await timed(
    'one-shot-sync',
    async () =>
      zstdCompressSync(body, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }).byteLength,
  )
}
process.exit(0)
