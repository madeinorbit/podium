import { appendFile, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChainEntry } from './file-chain'
import { fileIdFor } from './file-chain'
import * as slice from './slice'
import {
  readTranscriptSlice,
  readTranscriptSliceCached,
  resetSliceCache,
  sliceCacheStats,
} from './slice'

const rec = (uuid: string, text: string) =>
  JSON.stringify({
    uuid,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: '2026-06-22T00:00:00Z',
  })

interface TestRecord {
  uuid: string
  type: string
  message: { content: { text: string }[] }
}

// One item per record carrying its index text; uuid = `u<i>`.
const idxToItems = (r: unknown): TranscriptItem[] => {
  const t = r as TestRecord
  return [
    { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
  ] as unknown as TranscriptItem[]
}

/** Write a single-file chain with records 0..n-1. */
async function oneFile(n: number): Promise<{ chain: ChainEntry[]; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'slice-cache-'))
  const path = join(dir, 't.jsonl')
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(rec(`u${i}`, String(i)))
  await writeFile(path, `${lines.join('\n')}\n`)
  return { chain: [{ path, fileId: fileIdFor(path) }], path }
}

afterEach(() => {
  resetSliceCache()
  vi.restoreAllMocks()
})

describe('readTranscriptSliceCached', () => {
  it('serves an identical (path, cursor, direction, limit) read from cache without re-parsing', async () => {
    resetSliceCache()
    const { chain } = await oneFile(10)
    const spy = vi.spyOn(slice, 'readFileItems')

    const first = await readTranscriptSliceCached(chain, idxToItems, {
      direction: 'before',
      limit: 3,
    })
    expect(spy).toHaveBeenCalled() // miss → real file parse
    expect(sliceCacheStats().misses).toBe(1)
    expect(sliceCacheStats().hits).toBe(0)

    spy.mockClear()
    const second = await readTranscriptSliceCached(chain, idxToItems, {
      direction: 'before',
      limit: 3,
    })
    expect(spy).not.toHaveBeenCalled() // hit → NO file parse
    expect(second).toEqual(first)
    expect(sliceCacheStats().hits).toBe(1)
  })

  it('re-reads after the file grows (append changes size/mtime) and serves the new tail', async () => {
    resetSliceCache()
    const { chain, path } = await oneFile(10)
    const spy = vi.spyOn(slice, 'readFileItems')

    const before = await readTranscriptSliceCached(chain, idxToItems, {
      direction: 'before',
      limit: 3,
    })
    expect(before.items.map((i) => i.text)).toEqual(['7', '8', '9'])

    await appendFile(path, `${rec('u10', '10')}\n`)
    spy.mockClear()
    const after = await readTranscriptSliceCached(chain, idxToItems, {
      direction: 'before',
      limit: 3,
    })
    expect(spy).toHaveBeenCalled() // grown tail MUST re-read
    expect(after.items.map((i) => i.text)).toEqual(['8', '9', '10'])
  })

  // POD-1623. An append is the ONLY mutation a transcript takes, and it invalidated
  // the whole cached parse: the next tail read re-read and re-JSON.parse'd the entire
  // file. Measured on the live lake, one appended record on a 97.6MB transcript cost
  // 837ms of straight-line CPU — on the server/daemon event loop, so every session
  // froze, not just the one whose chat was open. That is once per incoming message
  // per open chat, which is why the loop was chronically blocked rather than
  // occasionally slow. The tail read must now cost the APPENDED bytes, not the file.
  describe('append-incremental tail reads (POD-1623)', () => {
    it('re-parses only the appended region, not the whole file', async () => {
      resetSliceCache()
      const { chain, path } = await oneFile(500)
      const fileBytes = (await stat(path)).size

      await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 5 })

      const spy = vi.spyOn(slice, 'readFileItems')
      await appendFile(path, `${rec('u500', '500')}\n`)
      await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 5 })

      // Every read after the append must be a bounded window seeked into the tail —
      // never a whole-file read (window undefined) and never a window starting at 0.
      expect(spy).toHaveBeenCalled()
      const windows = spy.mock.calls.map((c) => c[3])
      expect(windows.every((w) => w !== undefined && w.start > 0)).toBe(true)
      const bytesRead = windows.reduce((a, w) => a + ((w?.end ?? 0) - (w?.start ?? 0)), 0)
      // Generous bound: the appended record is ~130 bytes. Pre-fix this was >fileBytes.
      expect(bytesRead).toBeLessThan(fileBytes / 10)
    })

    it('returns byte-identical results to an uncached read across a burst of appends', async () => {
      resetSliceCache()
      const { chain, path } = await oneFile(40)
      for (const limit of [1, 5, 40]) {
        await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit })
      }
      for (let i = 40; i < 60; i++) {
        await appendFile(path, `${rec(`u${i}`, String(i))}\n`)
        for (const limit of [1, 5, 40]) {
          const opts = { direction: 'before' as const, limit }
          expect(await readTranscriptSliceCached(chain, idxToItems, opts)).toEqual(
            await readTranscriptSlice(chain, idxToItems, opts),
          )
        }
      }
    })

    it('falls back to a full re-parse when the file shrinks or is rewritten', async () => {
      resetSliceCache()
      const { chain, path } = await oneFile(30)
      const opts = { direction: 'before' as const, limit: 4 }
      await readTranscriptSliceCached(chain, idxToItems, opts)

      // Truncating rewrite — the append-only contract is broken, so the incremental
      // path MUST NOT splice onto a prefix that no longer exists.
      const lines: string[] = []
      for (let i = 0; i < 8; i++) lines.push(rec(`v${i}`, `v${i}`))
      await writeFile(path, `${lines.join('\n')}\n`)

      expect(await readTranscriptSliceCached(chain, idxToItems, opts)).toEqual(
        await readTranscriptSlice(chain, idxToItems, opts),
      )
    })

    it('re-reads a still-growing trailing record rather than double-emitting it', async () => {
      resetSliceCache()
      const { chain, path } = await oneFile(20)
      const opts = { direction: 'before' as const, limit: 4 }
      await readTranscriptSliceCached(chain, idxToItems, opts)

      // A record lands without its terminating newline (the live tailer flushes it),
      // then completes. Both reads must match a plain uncached read exactly.
      const partial = rec('u20', '20')
      await appendFile(path, partial.slice(0, partial.length - 5))
      expect(await readTranscriptSliceCached(chain, idxToItems, opts)).toEqual(
        await readTranscriptSlice(chain, idxToItems, opts),
      )
      await appendFile(path, `${partial.slice(partial.length - 5)}\n`)
      expect(await readTranscriptSliceCached(chain, idxToItems, opts)).toEqual(
        await readTranscriptSlice(chain, idxToItems, opts),
      )
    })
  })

  it('bounds the cache to at most 64 entries (LRU, evicts oldest)', async () => {
    resetSliceCache()
    const { chain } = await oneFile(5)
    // 80 distinct keys (distinct limit each) → all misses → entries capped at 64.
    for (let limit = 1; limit <= 80; limit++) {
      await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit })
    }
    const stats = sliceCacheStats()
    expect(stats.entries).toBeLessThanOrEqual(64)
    expect(stats.misses).toBe(80)
    // The most-recently inserted key (limit 80) must still be resident (oldest evicted).
    const spy = vi.spyOn(slice, 'readFileItems')
    await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 80 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns byte-identical results to the uncached reader for the same inputs', async () => {
    const { chain } = await oneFile(12)
    const cases: { anchor?: string; direction: 'before' | 'after'; limit: number }[] = [
      { direction: 'before', limit: 4 }, // newest window (tail — the hot case)
      { direction: 'before', limit: 100 }, // whole file, hasMore=false at head
      { direction: 'after', limit: 3 }, // nothing newer with no anchor at head
    ]
    for (const opts of cases) {
      const plain = await readTranscriptSlice(chain, idxToItems, opts)
      resetSliceCache()
      const cachedMiss = await readTranscriptSliceCached(chain, idxToItems, opts)
      const cachedHit = await readTranscriptSliceCached(chain, idxToItems, opts)
      expect(cachedMiss).toEqual(plain)
      expect(cachedHit).toEqual(plain)
    }
    // Also verify an anchored page (before + after) round-trips identically.
    const win = await readTranscriptSlice(chain, idxToItems, { direction: 'before', limit: 4 })
    const anchored = { anchor: win.head, direction: 'before' as const, limit: 4 }
    const plainAnchored = await readTranscriptSlice(chain, idxToItems, anchored)
    resetSliceCache()
    expect(await readTranscriptSliceCached(chain, idxToItems, anchored)).toEqual(plainAnchored)
    expect(await readTranscriptSliceCached(chain, idxToItems, anchored)).toEqual(plainAnchored)
  })

  it('never caches when a chain file is missing (serves fresh, does not throw)', async () => {
    resetSliceCache()
    const chain: ChainEntry[] = [
      { path: join(tmpdir(), 'does-not-exist-xyz.jsonl'), fileId: 'NONE' },
    ]
    const r = await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 3 })
    expect(r.items).toEqual([])
    expect(sliceCacheStats().entries).toBe(0)
  })
})
