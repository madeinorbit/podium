import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { LineDecoder } from '../jsonl-stream.js'
import { claudeRecordToItems } from './claude.js'
import { decodeCursor } from './cursor-codec.js'
import { fileIdFor } from './file-chain.js'
import { readTranscriptPage, readTranscriptTail, tailTranscript } from './tailer.js'

const dir = mkdtempSync(join(tmpdir(), 'podium-tailer-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const userRecord = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-06-15T10:00:00.000Z',
    message: { role: 'user', content: text },
  })

describe('readTranscriptTail', () => {
  it('reads and parses a transcript file into items', async () => {
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, `${userRecord('u1', 'first')}\n${userRecord('u2', 'second')}\n`)
    const items = await readTranscriptTail(path)
    expect(items.map((i) => i.text)).toEqual(['first', 'second'])
  })

  it('returns [] for a missing file (no throw)', async () => {
    expect(await readTranscriptTail(join(dir, 'nope.jsonl'))).toEqual([])
  })

  it('skips torn/partial lines instead of failing the whole read', async () => {
    const path = join(dir, 'b.jsonl')
    writeFileSync(
      path,
      `${userRecord('u1', 'ok')}\n{ this is not json\n${userRecord('u2', 'also ok')}\n`,
    )
    const items = await readTranscriptTail(path)
    expect(items.map((i) => i.text)).toEqual(['ok', 'also ok'])
  })
})

describe('readTranscriptPage', () => {
  const fivePath = join(dir, 'five.jsonl')
  const write = () =>
    writeFileSync(
      fivePath,
      `${['a', 'b', 'c', 'd', 'e'].map((t, i) => userRecord(`u${i}`, t)).join('\n')}\n`,
    )

  it('returns the page of items just BEFORE the cursor (fromEnd), with hasMore', async () => {
    write()
    // Holding the last 2 items (d,e); ask for the 2 before them → b,c. Earlier (a) remains.
    const page = await readTranscriptPage(fivePath, 2, 2)
    expect(page.items.map((i) => i.text)).toEqual(['b', 'c'])
    expect(page.hasMore).toBe(true)
  })

  it('stops (hasMore:false) once the page reaches the head of the file', async () => {
    write()
    // Holding the last 3 (c,d,e); ask for 5 before them → only a,b exist, no more earlier.
    const page = await readTranscriptPage(fivePath, 3, 5)
    expect(page.items.map((i) => i.text)).toEqual(['a', 'b'])
    expect(page.hasMore).toBe(false)
  })

  it('returns an empty page (hasMore:false) when fromEnd already covers everything', async () => {
    write()
    const page = await readTranscriptPage(fivePath, 5, 3)
    expect(page.items).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  it('returns an empty, hasMore:false page for a missing file (no throw)', async () => {
    const page = await readTranscriptPage(join(dir, 'nope.jsonl'), 0, 10)
    expect(page.items).toEqual([])
    expect(page.hasMore).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P1-13: readTranscriptPage must page via a backward byte-window seek, NOT a
// whole-file slurp. These tests pin (a) byte-for-byte parity with the original
// whole-file implementation across many (fromEnd, limit) cursors, and (b) that a
// page request reads only a bounded window of a large file — never the whole
// thing. (b) is the failing assertion against the v1 slurp implementation.
// ---------------------------------------------------------------------------

/**
 * Reference implementation: a faithful copy of the ORIGINAL whole-file
 * readTranscriptPage logic. The windowed implementation must produce
 * byte-for-byte-identical { items, hasMore } for every cursor.
 */
function referencePage(
  path: string,
  fromEnd: number,
  limit: number,
): { items: TranscriptItem[]; hasMore: boolean } {
  if (limit <= 0) return { items: [], hasMore: fromEnd > 0 }
  const fd = openSync(path, 'r')
  try {
    const { size } = statSync(path)
    if (size === 0) return { items: [], hasMore: false }
    const chunk = Buffer.alloc(size)
    readSync(fd, chunk, 0, size, 0)
    const lines = new LineDecoder().push(chunk)
    const all: TranscriptItem[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        for (const item of claudeRecordToItems(JSON.parse(trimmed))) all.push(item)
      } catch {
        // torn/partial line — skip
      }
    }
    const total = all.length
    const end = Math.max(0, Math.min(total, total - fromEnd))
    const start = Math.max(0, end - limit)
    return { items: all.slice(start, end), hasMore: start > 0 }
  } finally {
    closeSync(fd)
  }
}

describe('readTranscriptPage — backward windowed paging (P1-13)', () => {
  // Build a large fixture that stresses every edge:
  //  - many records (so a window covers only a fraction of the file)
  //  - assistant records that yield MULTIPLE items per record (text + N tools),
  //    so the item cursor never lines up 1:1 with records or lines
  //  - a multi-byte UTF-8 record that must not be split mid-character at a
  //    window boundary
  //  - a torn (non-JSON) line that must be skipped, same as the whole-file read
  //  - blank/whitespace-only trailing lines
  const bigPath = join(dir, 'big.jsonl')
  const buildBig = (): { size: number } => {
    const lines: string[] = []
    for (let i = 0; i < 2000; i++) {
      // Pad each record so the file is comfortably larger than one read window,
      // forcing multiple backward windows / a window boundary inside records.
      const pad = 'x'.repeat(800)
      lines.push(
        JSON.stringify({
          type: 'user',
          uuid: `u${i}`,
          timestamp: '2026-06-15T10:00:00.000Z',
          message: { role: 'user', content: `msg-${i}-é-中文-${pad}` },
        }),
      )
      // Every 5th turn is an assistant record yielding TWO items (text + tool).
      if (i % 5 === 0) {
        lines.push(
          JSON.stringify({
            type: 'assistant',
            uuid: `a${i}`,
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: `narration-${i}` },
                { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `echo ${i}` } },
              ],
            },
          }),
        )
      }
    }
    // A torn line in the middle — must be skipped identically by both reads.
    lines.splice(200, 0, '{ this is not valid json')
    // Trailing blank/whitespace lines.
    const text = `${lines.join('\n')}\n\n   \n`
    writeFileSync(bigPath, text)
    return { size: Buffer.byteLength(text) }
  }

  it('is byte-for-byte equivalent to the whole-file read for every (fromEnd, limit)', async () => {
    buildBig()
    const ref0 = referencePage(bigPath, 0, 1)
    const total = ref0.items.length === 0 ? 0 : referencePage(bigPath, 0, 1_000_000).items.length
    expect(total).toBeGreaterThan(500) // assistant records doubled some turns

    const cursors: Array<[number, number]> = [
      [0, 1],
      [0, 50],
      [10, 50],
      [50, 100],
      [total - 1, 50],
      [total, 50],
      [total - 3, 5],
      [total + 10, 50], // fromEnd past the head
      [100, 1], // tiny page deep in the file
      [0, total], // whole transcript in one page
    ]
    for (const [fromEnd, limit] of cursors) {
      const ref = referencePage(bigPath, fromEnd, limit)
      const got = await readTranscriptPage(bigPath, fromEnd, limit)
      expect(got.hasMore, `hasMore @ (${fromEnd},${limit})`).toBe(ref.hasMore)
      expect(got.items, `items @ (${fromEnd},${limit})`).toEqual(ref.items)
    }
  })

  it('reads only a bounded window of a large file, not the whole thing', async () => {
    const { size } = buildBig()
    // Sanity: the fixture is genuinely large relative to a single read window.
    expect(size).toBeGreaterThan(1_500_000)

    // Count bytes actually read off the FileHandle for a single shallow page by
    // wrapping FileHandle.prototype.read (the production code reads via it). We
    // can't spy on the ESM `open` export, so we instrument the handle's read and
    // restore the original afterward.
    const handle = await open(bigPath, 'r')
    // biome-ignore lint/suspicious/noExplicitAny: FileHandle.prototype is untyped here
    const proto = Object.getPrototypeOf(handle) as any
    await handle.close()
    const origRead = proto.read as (...a: unknown[]) => Promise<{ bytesRead: number }>
    let bytesRead = 0
    proto.read = async function (this: unknown, ...rargs: unknown[]) {
      const res = await origRead.apply(this, rargs)
      bytesRead += res.bytesRead
      return res
    }
    try {
      const page = await readTranscriptPage(bigPath, 0, 20)
      expect(page.items.length).toBe(20)
      // A shallow page must not read anywhere near the whole file. Generous
      // bound: far below the file size, well above any single small window.
      expect(bytesRead).toBeLessThan(size / 2)
    } finally {
      proto.read = origRead
    }
  })
})

// ---------------------------------------------------------------------------
// B4: tailTranscript stamps cursors (same scheme as the slice reader), surfaces
// a trailing newline-less record via flush(), and reports the new tail cursor in
// the delta `meta`. These pin the cursor contract + the flush no-double-emit
// interaction.
// ---------------------------------------------------------------------------

interface Emission {
  items: TranscriptItem[]
  reset: boolean
  tail: string | undefined
}

/** Drive a tailer's poll deterministically: each `tick()` waits a hair longer
 *  than `pollMs` so exactly one `readNew` completes, then returns the emissions
 *  captured since the last tick. Mirrors the existing `opts.pollMs` test seam. */
function makeTailHarness(path: string, pollMs = 10) {
  const emissions: Emission[] = []
  const tailer = tailTranscript(
    path,
    (items, meta) => {
      emissions.push({ items, reset: meta.reset, tail: meta.tail })
    },
    { pollMs },
  )
  let drained = 0
  const tick = async (): Promise<Emission[]> => {
    // Wait past one poll interval + a margin so the async readNew settles.
    await new Promise((r) => setTimeout(r, pollMs + 30))
    const fresh = emissions.slice(drained)
    drained = emissions.length
    return fresh
  }
  return { tailer, tick, emissions }
}

describe('tailTranscript — cursor stamping + flush (B4)', () => {
  it('stamps tailed items with decodable cursors anchored to the right file + offset', async () => {
    const path = join(dir, 'tail-cursors.jsonl')
    const r1 = userRecord('c1', 'alpha')
    const r2 = userRecord('c2', 'beta')
    // Two complete records; the second's absolute byte offset is len(r1)+1 ('\n').
    writeFileSync(path, `${r1}\n${r2}\n`)
    const off2 = Buffer.byteLength(r1, 'utf8') + 1

    const { tailer, tick } = makeTailHarness(path)
    try {
      const first = await tick()
      const all = first.flatMap((e) => e.items)
      expect(all.map((i) => i.text)).toEqual(['alpha', 'beta'])

      const c1 = decodeCursor(all[0]?.cursor ?? '')
      const c2 = decodeCursor(all[1]?.cursor ?? '')
      expect(c1).not.toBeNull()
      expect(c2).not.toBeNull()
      expect(c1?.fileId).toBe(fileIdFor(path))
      expect(c1?.offset).toBe(0)
      expect(c1?.uuid).toBe('c1')
      expect(c2?.fileId).toBe(fileIdFor(path))
      expect(c2?.offset).toBe(off2)
      expect(c2?.uuid).toBe('c2')

      // meta.tail is the LAST emitted item's cursor.
      const lastEmission = first.at(-1)
      expect(lastEmission?.tail).toBe(all.at(-1)?.cursor)
    } finally {
      tailer.stop()
    }
  })

  it('surfaces a record written WITHOUT a trailing newline (flush), and does not duplicate it once the newline lands', async () => {
    const path = join(dir, 'tail-flush.jsonl')
    const r1 = userRecord('f1', 'first')
    const r2 = userRecord('f2', 'partial') // written WITHOUT a trailing \n
    // One complete line + a trailing partial (no \n).
    writeFileSync(path, `${r1}\n${r2}`)
    const off2 = Buffer.byteLength(r1, 'utf8') + 1

    const { tailer, tick } = makeTailHarness(path)
    try {
      // First poll: complete r1 emits; the partial r2 surfaces via flush().
      const first = (await tick()).flatMap((e) => e.items)
      expect(first.map((i) => i.text)).toEqual(['first', 'partial'])
      const c2 = decodeCursor(first[1]?.cursor ?? '')
      expect(c2?.offset).toBe(off2)
      expect(c2?.uuid).toBe('f2')

      // The missing '\n' lands plus a brand-new record r3.
      const r3 = userRecord('f3', 'third')
      appendFileSync(path, `\n${r3}\n`)

      // Next poll: r3 emits; r2 must NOT be emitted a second time within this
      // poll's items (its newline-terminated form replaces the flushed one, and
      // a same-offset re-emit across polls would be idempotent by cursor anyway).
      const second = (await tick()).flatMap((e) => e.items)
      expect(second.map((i) => i.text)).toEqual(['third'])
      const c3 = decodeCursor(second[0]?.cursor ?? '')
      expect(c3?.offset).toBe(off2 + Buffer.byteLength(r2, 'utf8') + 1)
      expect(c3?.uuid).toBe('f3')
    } finally {
      tailer.stop()
    }
  })
})
