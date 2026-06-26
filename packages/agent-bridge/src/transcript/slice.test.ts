import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { decodeCursor, encodeCursor } from './cursor-codec.js'
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

  it('flushes a final record without a trailing newline when the read reaches EOF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slice-'))
    const path = join(dir, 't.jsonl')
    const r0 = rec('u1', 'user', 'first')
    const r1 = rec('a1', 'assistant', 'second')
    const r2 = rec('u2', 'user', 'third')
    // The agent is mid-append: r2's terminating newline has not landed yet. The live
    // tailer flushes this trailing record; a whole-file read must match it (not drop
    // it as a torn write) so a reset-driven re-read can't make the newest msg vanish.
    await writeFile(path, `${[r0, r1].join('\n')}\n${r2}`)
    const items = await readFileItems(path, 'FID', idxToItems)
    expect(items.map((i) => i.text)).toEqual(['first', 'second', 'third'])
    // The flushed record's cursor offset is its TRUE absolute file offset.
    const off2 = Buffer.byteLength(r0) + 1 + Buffer.byteLength(r1) + 1
    expect(decodeCursor(items[2]?.cursor ?? '')?.offset).toBe(off2)
  })

  it('does NOT emit a trailing partial when the window stops before EOF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slice-'))
    const path = join(dir, 't.jsonl')
    const r0 = rec('u1', 'user', 'first')
    const r1 = rec('a1', 'assistant', 'second')
    const r2 = rec('u2', 'user', 'third')
    await writeFile(path, `${[r0, r1, r2].join('\n')}\n`)
    const off2 = Buffer.byteLength(r0) + 1 + Buffer.byteLength(r1) + 1
    // Window ends partway INTO r2 (strictly before EOF): r2 is an incomplete fragment
    // here, more bytes follow on disk, so it must be dropped — only an EOF read flushes.
    const end = off2 + Math.floor(Buffer.byteLength(r2) / 2)
    const items = await readFileItems(path, 'FID', idxToItems, { start: 0, end })
    expect(items.map((i) => i.text)).toEqual(['first', 'second'])
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

  it('after-anchor hasMore stays true when the first window edge lands exactly between the limit-th and (limit+1)-th strictly-after item (pins usable `>` not `>=`)', async () => {
    // Why this exists: the `'newer'` doubling loop stops when it holds `need =
    // limit + 1` items STRICTLY AFTER the anchor — counted by
    // `items.filter(it => offsetOf(it) > anchorOffset)`. A regression `>` → `>=`
    // would also count the anchor record itself (it sits AT `anchorOffset`), so the
    // loop would stop one record early. That only changes the OUTPUT when the very
    // first window edge lands precisely between the `limit`-th and `(limit+1)`-th
    // strictly-after record: with `>` the loop must grow (and discovers a later item
    // → hasMore=true); with `>=` it stops, the page holds exactly `limit` items, and
    // `hasMore` wrongly reports false. Every other test's window overshoots far past
    // this edge, masking the difference. We force the edge with the `initialWindowBytes`
    // test seam so the math is exact, not dependent on the 256 KB default.
    const dir = await mkdtemp(join(tmpdir(), 'slice-edge-'))
    const path = join(dir, 'edge.jsonl')
    // Fixed-width records so byte offsets are predictable. Index baked into a
    // zero-padded field of constant length → every record line is the same size.
    const recFixed = (i: number): string =>
      JSON.stringify({
        uuid: `u${String(i).padStart(4, '0')}`,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: String(i).padStart(4, '0') }] },
        timestamp: '2026-06-22T00:00:00Z',
      })
    const N = 12
    const lines: string[] = []
    for (let i = 0; i < N; i++) lines.push(recFixed(i))
    await writeFile(path, `${lines.join('\n')}\n`)
    const recLen = Buffer.byteLength(lines[0] ?? '')
    // Every line is `recLen` bytes + 1 newline, so record i starts at i*(recLen+1)
    // and its trailing \n sits at i*(recLen+1) + recLen.
    const stride = recLen + 1
    expect(lines.every((l) => Buffer.byteLength(l) === recLen)).toBe(true)

    const fixedToItems = (r: unknown): TranscriptItem[] => {
      const t = r as TestRecord
      return [
        { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
      ] as unknown as TranscriptItem[]
    }
    const chain: ChainEntry[] = [{ path, fileId: fileIdFor(path) }]

    // Anchor on record A; page the `limit` after it. We want the first `'newer'`
    // window to span the anchor record A plus EXACTLY `limit` strictly-after records
    // (A+1 .. A+limit) and stop short of A+limit+1, while NOT yet at EOF.
    const A = 2
    const limit = 3
    const anchorOffset = A * stride
    // `'newer'` seeds the window start at `anchorOffset - 1`. A record at offset O is
    // emitted only when its trailing \n (at O + recLen) is strictly inside the window
    // end. To include A+limit's \n but exclude A+limit+1's, land `end` one byte past
    // A+limit's \n: end = (A+limit)*stride + recLen + 1.
    const start = anchorOffset - 1
    const desiredEnd = (A + limit) * stride + recLen + 1
    const initialWindowBytes = desiredEnd - start
    // Sanity: A+limit+1 (and more) must still exist beyond the window so the loop is
    // NOT at EOF on that first iteration (else it would stop via atBoundary, not usable).
    const { size } = await stat(path)
    expect(desiredEnd).toBeLessThan(size)
    expect(A + limit + 1).toBeLessThan(N)

    const anchorCursor = encodeCursor({
      fileId: fileIdFor(path),
      offset: anchorOffset,
      uuid: `u${String(A).padStart(4, '0')}`,
      sub: 0,
    })
    const after = await readTranscriptSlice(chain, fixedToItems, {
      anchor: anchorCursor,
      direction: 'after',
      limit,
      initialWindowBytes,
    })
    // The page is exactly the `limit` records after the anchor...
    expect(after.items.map((i) => i.text)).toEqual(['0003', '0004', '0005'])
    // ...and because record A+limit+1 (and more) follow, hasMore MUST be true. With a
    // `>=` regression the loop stops on this first window (anchor counted), reports
    // collected.length === limit, and hasMore would be a wrong `false`.
    expect(after.hasMore).toBe(true)
  })

  it('sub>0: anchor mid-record pages the sibling then later records (multi-item-per-record)', async () => {
    // All other tests map one item per record; this exercises the `sub` dimension:
    // anchoring on a sub=0 item whose record also yields a sub=1 sibling, the `after`
    // page must include that same-offset higher-sub sibling first, then continue into
    // later records — and `before` must exclude both the anchor and its later sibling.
    const dir = await mkdtemp(join(tmpdir(), 'slice-sub-'))
    const path = join(dir, 'sub.jsonl')
    // Each record carries two texts; mapper emits two items (sub 0 and sub 1).
    const twoRec = (i: number): string =>
      JSON.stringify({
        uuid: `u${i}`,
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `${i}a` },
            { type: 'text', text: `${i}b` },
          ],
        },
        timestamp: '2026-06-22T00:00:00Z',
      })
    const N = 5
    const lines: string[] = []
    for (let i = 0; i < N; i++) lines.push(twoRec(i))
    await writeFile(path, `${lines.join('\n')}\n`)
    const twoItems = (r: unknown): TranscriptItem[] => {
      const t = r as { uuid: string; type: string; message: { content: { text: string }[] } }
      return t.message.content.map((c) => ({
        id: `${t.uuid}`,
        role: t.type,
        text: c.text,
      })) as unknown as TranscriptItem[]
    }
    const chain: ChainEntry[] = [{ path, fileId: fileIdFor(path) }]

    // Sequence of items is: 0a,0b,1a,1b,2a,2b,3a,3b,4a,4b (record i → sub 0,1).
    const all = await readTranscriptSlice(chain, twoItems, { direction: 'before', limit: 100 })
    expect(all.items.map((i) => i.text)).toEqual([
      '0a',
      '0b',
      '1a',
      '1b',
      '2a',
      '2b',
      '3a',
      '3b',
      '4a',
      '4b',
    ])
    // Anchor on '2a' — the sub=0 item of record 2; its record also yields '2b' (sub=1).
    const anchor2a = all.items.find((i) => i.text === '2a')
    expect(anchor2a).toBeDefined()
    const c = decodeCursor(anchor2a?.cursor ?? '')
    expect(c?.sub).toBe(0)

    // `after` must include the same-offset, higher-sub sibling ('2b') FIRST, then
    // flow into later records with no gap/overlap.
    const after = await readTranscriptSlice(chain, twoItems, {
      anchor: anchor2a?.cursor,
      direction: 'after',
      limit: 4,
    })
    expect(after.items.map((i) => i.text)).toEqual(['2b', '3a', '3b', '4a'])
    expect(after.hasMore).toBe(true) // '4b' still follows

    // `before` must exclude the anchor ('2a') AND its later sibling ('2b'), ending at
    // '1b' with no overlap into record 2.
    const before = await readTranscriptSlice(chain, twoItems, {
      anchor: anchor2a?.cursor,
      direction: 'before',
      limit: 3,
    })
    expect(before.items.map((i) => i.text)).toEqual(['0b', '1a', '1b'])
    expect(before.hasMore).toBe(true) // '0a' still precedes
  })
})
