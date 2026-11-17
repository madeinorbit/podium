import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { type ByteSource, fileByteSource } from './byte-source'
import { type ChainEntry, fileIdFor } from './file-chain'
import {
  readFileItems,
  readIndexWindow,
  readTranscriptSlice,
  readTranscriptSliceCached,
  resetSliceCache,
  sliceCacheStats,
} from './slice'

// One item per record carrying its index as text; uuid = `u<i>`.
const rec = (i: number, filler = '') =>
  JSON.stringify({ uuid: `u${i}`, type: 'user', text: String(i), filler })

const toItems = (r: unknown): TranscriptItem[] => {
  const t = r as { uuid: string; type: string; text: string }
  return [{ id: t.uuid, role: t.type, text: t.text }] as unknown as TranscriptItem[]
}

/** An in-memory source over a byte array: the shape object storage gives the
 *  readers, with no file underneath. Its version is set by the test, as the
 *  lake's cursor + etag would be. */
function memorySource(
  id: string,
  initial: Uint8Array,
): ByteSource & {
  set(bytes: Uint8Array): void
} {
  let bytes = initial
  let generation = 0
  return {
    id,
    size: async () => bytes.length,
    read: async (offset, length) => bytes.slice(offset, Math.min(bytes.length, offset + length)),
    version: async () => `${generation}:${bytes.length}`,
    set(next) {
      bytes = next
      generation++
    },
  }
}

/** The same records as a file and as an in-memory source. */
async function twin(lines: string[], trailingNewline = true) {
  const dir = await mkdtemp(join(tmpdir(), 'byte-source-'))
  const path = join(dir, 't.jsonl')
  await writeFile(path, `${lines.join('\n')}${trailingNewline ? '\n' : ''}`)
  const bytes = new Uint8Array(await readFile(path))
  return { path, file: fileByteSource(path), memory: memorySource(`mem:${path}`, bytes) }
}

afterEach(() => resetSliceCache())

describe('fileByteSource', () => {
  it('reports size, reads ranges and is short only at the end', async () => {
    const { path, file } = await twin([rec(0), rec(1)])
    const whole = await readFile(path)
    expect(await file.size()).toBe(whole.length)
    expect(Buffer.from(await file.read(0, whole.length))).toEqual(whole)
    expect(Buffer.from(await file.read(3, 5))).toEqual(whole.subarray(3, 8))
    expect((await file.read(whole.length - 2, 100)).length).toBe(2)
    expect((await file.read(whole.length + 10, 4)).length).toBe(0)
    expect(file.id).toBe(path)
  })

  it('changes its version when the file grows', async () => {
    const { path, file } = await twin([rec(0)])
    const before = await file.version()
    expect(await file.version()).toBe(before)
    await appendFile(path, `${rec(1)}\n`)
    expect(await file.version()).not.toBe(before)
  })

  it('fails every call on a missing file', async () => {
    const missing = fileByteSource(join(tmpdir(), 'byte-source-missing-xyz.jsonl'))
    await expect(missing.size()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(missing.read(0, 10)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(missing.version()).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readers over an in-memory source', () => {
  const lines = Array.from({ length: 40 }, (_, i) => rec(i, 'x'.repeat(50)))

  it('readFileItems returns the same items and cursors, whole and windowed', async () => {
    const { file, memory } = await twin(lines)
    const fid = fileIdFor('session')
    const whole = await readFileItems(file, fid, toItems)
    expect(whole).toHaveLength(40)
    expect(await readFileItems(memory, fid, toItems)).toEqual(whole)
    for (const window of [
      { start: 0, end: 300 },
      { start: 150, end: 900 },
      { start: 1000, end: 1_000_000 },
    ]) {
      expect(await readFileItems(memory, fid, toItems, window)).toEqual(
        await readFileItems(file, fid, toItems, window),
      )
    }
  })

  it('keeps the in-flight last record without a newline at the end of the source', async () => {
    const { file, memory } = await twin([rec(0), rec(1)], false)
    const fid = fileIdFor('session')
    const items = await readFileItems(memory, fid, toItems)
    expect(items.map((item) => item.text)).toEqual(['0', '1'])
    expect(items).toEqual(await readFileItems(file, fid, toItems))
  })

  it('readTranscriptSlice pages a chain identically in both directions', async () => {
    const a = await twin(lines.slice(0, 20))
    const b = await twin(lines.slice(20))
    const fileChain: ChainEntry[] = [
      { source: a.file, fileId: fileIdFor('session', 1) },
      { source: b.file, fileId: fileIdFor('session') },
    ]
    const memoryChain: ChainEntry[] = [
      { source: a.memory, fileId: fileIdFor('session', 1) },
      { source: b.memory, fileId: fileIdFor('session') },
    ]
    const shapes = { initialWindowBytes: 128 }
    const newest = await readTranscriptSlice(fileChain, toItems, {
      direction: 'before',
      limit: 7,
      ...shapes,
    })
    expect(
      await readTranscriptSlice(memoryChain, toItems, { direction: 'before', limit: 7, ...shapes }),
    ).toEqual(newest)
    // Page older across the chain boundary, then newer from the oldest item.
    for (const opts of [
      { anchor: newest.head, direction: 'before' as const, limit: 18 },
      { anchor: newest.head, direction: 'after' as const, limit: 3 },
      { direction: 'after' as const, limit: 25 },
    ]) {
      const expected = await readTranscriptSlice(fileChain, toItems, { ...opts, ...shapes })
      expect(expected.items.length).toBeGreaterThan(0)
      expect(await readTranscriptSlice(memoryChain, toItems, { ...opts, ...shapes })).toEqual(
        expected,
      )
    }
  })

  it('readIndexWindow consumes the same records at the same offsets', async () => {
    const { file, memory } = await twin(lines)
    const size = await file.size()
    const fid = fileIdFor('session')
    let from = 0
    while (from < size) {
      const expected = await readIndexWindow(file, fid, toItems, from, size, 200)
      expect(await readIndexWindow(memory, fid, toItems, from, size, 200)).toEqual(expected)
      expect(expected.consumed).toBeGreaterThan(0)
      from += expected.consumed
    }
    expect(from).toBe(size)
  })

  it('the parsed-slice cache keys on version(): unchanged hits, a new version misses', async () => {
    const { memory } = await twin(lines.slice(0, 10))
    const chain: ChainEntry[] = [{ source: memory, fileId: fileIdFor('session') }]
    const opts = { direction: 'before' as const, limit: 5 }
    const first = await readTranscriptSliceCached(chain, toItems, opts)
    expect(await readTranscriptSliceCached(chain, toItems, opts)).toBe(first)
    expect(sliceCacheStats()).toMatchObject({ hits: 1, misses: 1 })

    const grown = new TextEncoder().encode(`${lines.slice(0, 11).join('\n')}\n`)
    memory.set(grown)
    const after = await readTranscriptSliceCached(chain, toItems, opts)
    expect(sliceCacheStats()).toMatchObject({ hits: 1, misses: 2 })
    expect(after.items.at(-1)?.text).toBe('10')
    expect(after).toEqual(await readTranscriptSlice(chain, toItems, opts))
  })
})
