import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { decodeCursor } from './cursor-codec.js'
import type { ChainEntry } from './file-chain.js'
import { fileIdFor } from './file-chain.js'
import * as slice from './slice.js'
import { readFileItems, readTranscriptSlice } from './slice.js'

const rec = (uuid: string, type: string, text: string) =>
  JSON.stringify({
    uuid,
    type,
    message: { role: type, content: [{ type: 'text', text }] },
    timestamp: '2026-06-22T00:00:00Z',
  })

interface TestRecord {
  uuid: string
  type: string
  message: { content: { text: string }[] }
}

describe('readFileItems', () => {
  it('stamps every item with a decodable cursor carrying the file id and record uuid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slice-'))
    const path = join(dir, 't.jsonl')
    await writeFile(path, `${[rec('u1', 'user', 'hi'), rec('a1', 'assistant', 'yo')].join('\n')}\n`)
    // minimal recordToItems for the test: one item per record carrying its text
    const toItems = (r: unknown): TranscriptItem[] => {
      const t = r as TestRecord
      return [
        { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
      ] as unknown as TranscriptItem[]
    }
    const items = await readFileItems(path, 'FID', toItems)
    expect(items.map((i) => i.text)).toEqual(['hi', 'yo'])
    const first = items[0]
    expect(first).toBeDefined()
    const c0 = decodeCursor(first?.cursor ?? '')
    expect(c0).not.toBeNull()
    expect(c0?.fileId).toBe('FID')
    expect(c0?.uuid).toBe('u1')
    expect(c0?.sub).toBe(0)
  })

  it('drops the straddling partial line and stamps file-absolute offsets when windowed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slice-'))
    const path = join(dir, 't.jsonl')
    const r0 = rec('u1', 'user', 'first')
    const r1 = rec('a1', 'assistant', 'second')
    const r2 = rec('u2', 'user', 'third')
    // Each record is one line; the file ends with a trailing newline.
    await writeFile(path, `${[r0, r1, r2].join('\n')}\n`)
    const toItems = (r: unknown): TranscriptItem[] => {
      const t = r as TestRecord
      return [
        { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
      ] as unknown as TranscriptItem[]
    }
    // Byte offset where each record's line begins (records joined by single \n).
    const off1 = Buffer.byteLength(r0) + 1 // start of r1
    const off2 = off1 + Buffer.byteLength(r1) + 1 // start of r2
    // start lands INSIDE r0's line → the leading partial line is dropped; r1 and
    // r2 are whole records within the window and survive. end is past EOF.
    const start = Math.floor(off1 / 2)
    const end = off2 + Buffer.byteLength(r2) + 1
    const items = await readFileItems(path, 'FID', toItems, { start, end })
    // The record straddling `start` (r0) must NOT appear; the following whole
    // records do.
    expect(items.map((i) => i.text)).toEqual(['second', 'third'])
    // A windowed record's cursor offset is its TRUE ABSOLUTE file offset, not a
    // window-relative one.
    const second = items[0]
    expect(second).toBeDefined()
    const cSecond = decodeCursor(second?.cursor ?? '')
    expect(cSecond).not.toBeNull()
    expect(cSecond?.offset).toBe(off1)
    expect(cSecond?.uuid).toBe('a1')
    const third = items[1]
    expect(third).toBeDefined()
    const cThird = decodeCursor(third?.cursor ?? '')
    expect(cThird?.offset).toBe(off2)
    expect(cThird?.uuid).toBe('u2')
  })
})

// One item per record carrying its index as text; uuid = `u<i>`.
const idxToItems = (r: unknown): TranscriptItem[] => {
  const t = r as TestRecord
  return [
    { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
  ] as unknown as TranscriptItem[]
}

/** Write a single large JSONL file with `n` index-bearing records, each padded so
 *  the file is far larger than one bounded window (forces real window doubling). */
async function bigFile(n: number): Promise<{ chain: ChainEntry[]; path: string; size: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'slice-big-'))
  const path = join(dir, 'big.jsonl')
  const filler = 'x'.repeat(200) // ~300B/record
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const r = JSON.parse(rec(`u${i}`, 'user', String(i)))
    r.filler = filler
    lines.push(JSON.stringify(r))
  }
  await writeFile(path, `${lines.join('\n')}\n`)
  const { size } = await stat(path)
  return { chain: [{ path, fileId: fileIdFor(path) }], path, size }
}

/** Write two chained JSONL files: f1 holds items 0..4, f2 holds items 5..9.
 *  Returns the oldest→newest chain plus the recordToItems mapper. */
async function twoFiles(): Promise<{ chain: ChainEntry[]; toItems: typeof idxToItems }> {
  const dir = await mkdtemp(join(tmpdir(), 'slice-chain-'))
  const f1 = join(dir, 'a.jsonl')
  const f2 = join(dir, 'b.jsonl')
  const lines1 = [0, 1, 2, 3, 4].map((i) => rec(`u${i}`, 'user', String(i)))
  const lines2 = [5, 6, 7, 8, 9].map((i) => rec(`u${i}`, 'user', String(i)))
  await writeFile(f1, `${lines1.join('\n')}\n`)
  await writeFile(f2, `${lines2.join('\n')}\n`)
  const chain: ChainEntry[] = [
    { path: f1, fileId: fileIdFor(f1) },
    { path: f2, fileId: fileIdFor(f2) },
  ]
  return { chain, toItems: idxToItems }
}

describe('readTranscriptSlice', () => {
  it('no anchor returns the newest `limit` items with hasMore', async () => {
    const { chain, toItems } = await twoFiles()
    const r = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 })
    expect(r.items.map((i) => i.text)).toEqual(['7', '8', '9'])
    expect(r.hasMore).toBe(true)
    expect(r.head).toBe(r.items[0]?.cursor)
    expect(r.tail).toBe(r.items.at(-1)?.cursor)
  })

  it('before-anchor pages the previous window across the file boundary with no gap/overlap', async () => {
    const { chain, toItems } = await twoFiles()
    const first = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 }) // 7,8,9
    const older = await readTranscriptSlice(chain, toItems, {
      anchor: first.head,
      direction: 'before',
      limit: 3,
    })
    // 4 lives in f1, 5,6 in f2 — contiguous across the file-roll boundary.
    expect(older.items.map((i) => i.text)).toEqual(['4', '5', '6'])
    expect(older.hasMore).toBe(true)
  })

  it('after-anchor catches up newer items', async () => {
    const { chain, toItems } = await twoFiles()
    const win = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 }) // 7,8,9; tail=9
    const after = await readTranscriptSlice(chain, toItems, {
      anchor: win.tail,
      direction: 'after',
      limit: 5,
    })
    expect(after.items).toEqual([]) // nothing newer than 9
    expect(after.hasMore).toBe(false)
  })

  it('after-anchor returns the items immediately following across the boundary', async () => {
    const { chain, toItems } = await twoFiles()
    // Page back to get an anchor at item 4 (last item of f1).
    const first = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 6 })
    // first.items = [4,5,6,7,8,9]; anchor on '4' and ask for the 3 after it.
    const four = first.items.find((i) => i.text === '4')
    expect(four).toBeDefined()
    const after = await readTranscriptSlice(chain, toItems, {
      anchor: four?.cursor,
      direction: 'after',
      limit: 3,
    })
    expect(after.items.map((i) => i.text)).toEqual(['5', '6', '7'])
    expect(after.hasMore).toBe(true)
  })

  it('hasMore is false at the head of the oldest file', async () => {
    const { chain, toItems } = await twoFiles()
    const r = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 100 })
    expect(r.items.length).toBe(10)
    expect(r.hasMore).toBe(false)
  })

  it('returns an empty result for an empty chain', async () => {
    const r = await readTranscriptSlice([], idxToItems, { direction: 'before', limit: 5 })
    expect(r.items).toEqual([])
    expect(r.hasMore).toBe(false)
    expect(r.head).toBeUndefined()
    expect(r.tail).toBeUndefined()
  })

  it('anchors drift-tolerantly when only the uuid changed (offset+file match)', async () => {
    const { chain, toItems } = await twoFiles()
    const first = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 }) // 7,8,9
    const head = first.head
    expect(head).toBeDefined()
    const parts = decodeCursor(head ?? '')
    expect(parts).not.toBeNull()
    if (!parts) throw new Error('unreachable')
    // Re-encode the SAME position with a different uuid: drift-tolerant match must
    // still anchor on file+offset+sub and page the previous window identically.
    const { encodeCursor } = await import('./cursor-codec.js')
    const drifted = encodeCursor({ ...parts, uuid: 'totally-different-uuid' })
    const older = await readTranscriptSlice(chain, toItems, {
      anchor: drifted,
      direction: 'before',
      limit: 3,
    })
    expect(older.items.map((i) => i.text)).toEqual(['4', '5', '6'])
  })

  it('after-anchor hasMore is true when one more item follows the page (no off-by-one)', async () => {
    // Anchor on item 5: items 6..9 follow (4 items). limit 3 → page [6,7,8],
    // hasMore must be true because 9 still follows.
    const { chain, toItems } = await twoFiles()
    const all = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 10 })
    const five = all.items.find((i) => i.text === '5')
    expect(five).toBeDefined()
    const after = await readTranscriptSlice(chain, toItems, {
      anchor: five?.cursor,
      direction: 'after',
      limit: 3,
    })
    expect(after.items.map((i) => i.text)).toEqual(['6', '7', '8'])
    expect(after.hasMore).toBe(true)
  })

  it('after-anchor hasMore is false when the page reaches the tail exactly', async () => {
    // Anchor on item 6: items 7,8,9 follow (exactly limit 3). hasMore must be false.
    const { chain, toItems } = await twoFiles()
    const all = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 10 })
    const six = all.items.find((i) => i.text === '6')
    expect(six).toBeDefined()
    const after = await readTranscriptSlice(chain, toItems, {
      anchor: six?.cursor,
      direction: 'after',
      limit: 3,
    })
    expect(after.items.map((i) => i.text)).toEqual(['7', '8', '9'])
    expect(after.hasMore).toBe(false)
  })

  it('before-anchor hasMore is false when the page reaches the head exactly', async () => {
    // Anchor on item 3: items 0,1,2 precede (exactly limit 3). hasMore must be false.
    const { chain, toItems } = await twoFiles()
    const all = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 10 })
    const three = all.items.find((i) => i.text === '3')
    expect(three).toBeDefined()
    const before = await readTranscriptSlice(chain, toItems, {
      anchor: three?.cursor,
      direction: 'before',
      limit: 3,
    })
    expect(before.items.map((i) => i.text)).toEqual(['0', '1', '2'])
    expect(before.hasMore).toBe(false)
  })

  it('pages a large file without reading all of it (bounded window)', async () => {
    const N = 5000
    const { chain, size } = await bigFile(N)

    // Instrument the real readFileItems to count the bytes its windows actually
    // read, while still doing the real parse (spy delegates to the original).
    // A windowed call charges its window size; a whole-file call (no window) charges
    // the full file — so a slurp would blow the budget.
    let bytesRead = 0
    let wholeFileReads = 0
    let windowedReads = 0
    const realReadFileItems = slice.readFileItems
    const spy = vi
      .spyOn(slice, 'readFileItems')
      .mockImplementation(async (p, fileId, toItems, window) => {
        if (window) {
          windowedReads++
          bytesRead += Math.max(0, window.end - window.start)
        } else {
          wholeFileReads++
          bytesRead += size
        }
        return realReadFileItems(p, fileId, toItems, window)
      })
    try {
      const r = await readTranscriptSlice(chain, idxToItems, { direction: 'before', limit: 10 })
      expect(r.items.map((i) => i.text)).toEqual([
        '4990',
        '4991',
        '4992',
        '4993',
        '4994',
        '4995',
        '4996',
        '4997',
        '4998',
        '4999',
      ])
      expect(r.hasMore).toBe(true)
      // The page is a tiny slice near the tail; the bounded window must read far
      // less than the whole file — proves no whole-file slurp on the live path.
      expect(bytesRead).toBeLessThan(size * 0.25)
      // And it took the bounded path: at least one windowed read, no whole-file read.
      expect(windowedReads).toBeGreaterThan(0)
      expect(wholeFileReads).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('windowed before-anchor deep in a large file pages contiguously (forces doubling)', async () => {
    // Anchor deep in the file so the bounded window must grow several times to
    // gather a large page strictly before it — exercises the doubling loop, not a
    // single tail read. Page must be the exact contiguous run just before the anchor.
    const { chain } = await bigFile(5000)
    const all = await readTranscriptSlice(chain, idxToItems, {
      direction: 'before',
      limit: 5000,
    })
    const anchorItem = all.items.find((i) => i.text === '4000')
    expect(anchorItem).toBeDefined()
    const page = await readTranscriptSlice(chain, idxToItems, {
      anchor: anchorItem?.cursor,
      direction: 'before',
      limit: 1500,
    })
    expect(page.items.length).toBe(1500)
    expect(page.items[0]?.text).toBe('2500')
    expect(page.items.at(-1)?.text).toBe('3999')
    expect(page.hasMore).toBe(true)
  })

  it('windowed after-anchor deep in a large file pages contiguously (forces doubling)', async () => {
    // Symmetric to the above for the `newer` doubling path.
    const { chain } = await bigFile(5000)
    const all = await readTranscriptSlice(chain, idxToItems, {
      direction: 'before',
      limit: 5000,
    })
    const anchorItem = all.items.find((i) => i.text === '1000')
    expect(anchorItem).toBeDefined()
    const page = await readTranscriptSlice(chain, idxToItems, {
      anchor: anchorItem?.cursor,
      direction: 'after',
      limit: 1500,
    })
    expect(page.items.length).toBe(1500)
    expect(page.items[0]?.text).toBe('1001')
    expect(page.items.at(-1)?.text).toBe('2500')
    expect(page.hasMore).toBe(true)
  })

  it('after-anchor at the very last item of a large file reports hasMore false', async () => {
    const { chain } = await bigFile(5000)
    const all = await readTranscriptSlice(chain, idxToItems, {
      direction: 'before',
      limit: 1,
    })
    const last = all.items[0]
    expect(last?.text).toBe('4999')
    const after = await readTranscriptSlice(chain, idxToItems, {
      anchor: last?.cursor,
      direction: 'after',
      limit: 10,
    })
    expect(after.items).toEqual([])
    expect(after.hasMore).toBe(false)
  })
})
