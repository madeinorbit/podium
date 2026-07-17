import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChainEntry } from './file-chain'
import { fileIdFor } from './file-chain'
import * as slice from './slice'
import { readTranscriptSlice, readTranscriptSliceCached, resetSliceCache, sliceCacheStats } from './slice'

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
  return [{ id: t.uuid, role: t.type, text: t.message.content[0]?.text }] as unknown as TranscriptItem[]
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

    const first = await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 3 })
    expect(spy).toHaveBeenCalled() // miss → real file parse
    expect(sliceCacheStats().misses).toBe(1)
    expect(sliceCacheStats().hits).toBe(0)

    spy.mockClear()
    const second = await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 3 })
    expect(spy).not.toHaveBeenCalled() // hit → NO file parse
    expect(second).toEqual(first)
    expect(sliceCacheStats().hits).toBe(1)
  })

  it('misses and re-parses after the file grows (append changes size/mtime)', async () => {
    resetSliceCache()
    const { chain, path } = await oneFile(10)
    const spy = vi.spyOn(slice, 'readFileItems')

    const before = await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 3 })
    expect(before.items.map((i) => i.text)).toEqual(['7', '8', '9'])

    await appendFile(path, `${rec('u10', '10')}\n`)
    spy.mockClear()
    const after = await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 3 })
    expect(spy).toHaveBeenCalled() // grown tail MUST miss and re-read
    expect(after.items.map((i) => i.text)).toEqual(['8', '9', '10'])
    expect(sliceCacheStats().misses).toBe(2)
    expect(sliceCacheStats().hits).toBe(0)
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
    const chain: ChainEntry[] = [{ path: join(tmpdir(), 'does-not-exist-xyz.jsonl'), fileId: 'NONE' }]
    const r = await readTranscriptSliceCached(chain, idxToItems, { direction: 'before', limit: 3 })
    expect(r.items).toEqual([])
    expect(sliceCacheStats().entries).toBe(0)
  })
})
