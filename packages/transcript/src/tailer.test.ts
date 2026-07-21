import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeCursor } from './cursor-codec'
import { fileIdFor } from './file-chain'
import { type TranscriptTailOptions, tailTranscript } from './tailer'

const dir = mkdtempSync(join(tmpdir(), 'podium-tailer-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const userRecord = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-06-15T10:00:00.000Z',
    message: { role: 'user', content: text },
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

/** Wait until the tailer's read has actually landed, rather than sleeping a span
 *  and hoping. Fixed sleeps flaked ~40% of runs with this file ALONE (POD-757):
 *  a seed/poll read normally lands in ~1-10ms, but measured latency spikes to
 *  204ms on a seed and 329ms on an append when the event loop or fs threadpool
 *  stalls, and the assertion then ran before the bytes were consumed. The tailer
 *  is not at fault — it always caught up; only the fixed wait was unsound.
 *  Deadline-bounded but SILENT on timeout, so the assertion that follows reports
 *  the real mismatch instead of a bare timeout.
 *
 *  Note this is only for POSITIVE waits ("the read landed"). Proving a read did
 *  NOT happen (the seedGate hold) still needs a real elapsed sleep — waiting
 *  longer only makes that assertion stronger. */
const waitFor = async (done: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
}
const itemsOf = (emissions: Emission[]): TranscriptItem[] => emissions.flatMap((e) => e.items)
const textsOf = (emissions: Emission[]): string[] => itemsOf(emissions).map((i) => i.text)

/** Drive a tailer's poll deterministically: each `tick()` waits a hair longer
 *  than `pollMs` so exactly one `readNew` completes, then returns the emissions
 *  captured since the last tick. Mirrors the existing `opts.pollMs` test seam. */
function makeTailHarness(path: string, pollMs = 10, opts: TranscriptTailOptions = {}) {
  const emissions: Emission[] = []
  const tailer = tailTranscript(
    path,
    (items, meta) => {
      emissions.push({ items, reset: meta.reset, tail: meta.tail })
    },
    { pollMs, ...opts },
  )
  let drained = 0
  const tick = async (): Promise<Emission[]> => {
    // Wait until at least one new emission lands (a fixed pollMs+margin sleep flaked
    // under CPU steal in the retry-0 unit lane: the poll had not completed yet), then
    // one extra poll interval so the round settles before draining — preserving the
    // "within this poll's items" semantics of the no-double-emit assertions.
    const deadline = Date.now() + 2_000
    while (emissions.length === drained && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    await new Promise((r) => setTimeout(r, pollMs + 10))
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

  it('caps a truncation/replacement re-read at the tail window instead of re-reading the whole file', async () => {
    // POD-601: the truncation path re-read the REPLACEMENT from byte 0 — an
    // uncapped one-shot allocation spike when the new file is huge. It must seek
    // to the same bounded window the first read uses (reset=true, the leading
    // partial line at the seek point dropped).
    //
    // The window is scaled down through the `initialWindowBytes` seam rather than
    // left at the 16MB TAIL_BYTES default. Same code path either way
    // (`windowBytes = opts.initialWindowBytes ?? TAIL_BYTES`), but the default
    // needs a 35MB fixture plus a 17MB JSON.parse, which blew the lane's 20s
    // timeout whenever CI was contended (POD-757). What this gives up is thin —
    // the 16MB default is a constant, and the capping logic below is what POD-601
    // actually regressed.
    const path = join(dir, 'tail-truncate-cap.jsonl')
    const windowBytes = 512
    // Initial file: blank lines (no items) so the tail is fully consumed past the
    // replacement's size, which is what makes the swap read as truncation.
    const initialBytes = 4 * 1024
    writeFileSync(path, '\n'.repeat(initialBytes))

    // Replacement: one HUGE valid record + a tiny one. The capped re-read seeks
    // into the huge record, drops its partial fragment, and emits only the tiny
    // one; the old uncapped behavior emitted BOTH.
    const huge = userRecord('t-huge', 'x'.repeat(1024))
    const tiny = userRecord('t-tiny', 'small-after-truncate')
    const replacementBytes = Buffer.byteLength(`${huge}\n${tiny}\n`, 'utf8')
    // Three size invariants make the cap OBSERVABLE; assert them, or a later edit
    // could quietly shrink this into a test that passes without capping anything.
    // 1. The replacement must exceed the window, else the re-read seeks to 0 and
    //    a totally uncapped tailer would still emit exactly ['small-after-truncate'].
    expect(replacementBytes).toBeGreaterThan(windowBytes)
    // 2. The initial file must exceed the replacement, else the swap never reads
    //    as a truncation and this exercises the plain-append path instead.
    expect(initialBytes).toBeGreaterThan(replacementBytes)
    // 3. The seek point must land INSIDE `huge`, so its fragment is the leading
    //    partial that gets dropped.
    expect(replacementBytes - windowBytes).toBeLessThan(Buffer.byteLength(huge, 'utf8'))

    const { tailer, tick } = makeTailHarness(path, 10, { initialWindowBytes: windowBytes })
    try {
      // Drain the initial (reset) read.
      for (let i = 0; i < 40; i++) {
        const got = await tick()
        if (got.some((e) => e.reset)) break
      }

      writeFileSync(path, `${huge}\n${tiny}\n`)

      const emissions: Emission[] = []
      for (let i = 0; i < 40; i++) {
        emissions.push(...(await tick()))
        if (emissions.some((e) => e.reset)) break
      }
      const reset = emissions.find((e) => e.reset)
      expect(reset).toBeDefined()
      expect(textsOf(emissions)).toEqual(['small-after-truncate'])
    } finally {
      tailer.stop()
    }
  })
})

describe('tailTranscript — seedGate (POD-612)', () => {
  it('defers the first read behind the gate; poll ticks do not jump the queue', async () => {
    const path = join(dir, 'tail-seedgate.jsonl')
    writeFileSync(path, `${userRecord('g1', 'gated')}\n`)
    const emissions: Emission[] = []
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const tailer = tailTranscript(
      path,
      (items, meta) => emissions.push({ items, reset: meta.reset, tail: meta.tail }),
      {
        pollMs: 5,
        seedGate: async (fn) => {
          await held
          await fn()
        },
      },
    )
    try {
      // Several poll intervals pass while the gate is held — no read may happen:
      // neither the seed itself nor a timer tick stealing the big first read. This
      // one stays a real sleep on purpose: it asserts an ABSENCE, so elapsed time
      // is the point (10 poll intervals at pollMs=5) and a longer wait only makes
      // it stronger.
      await new Promise((r) => setTimeout(r, 50))
      expect(emissions).toEqual([])
      release()
      await waitFor(() => itemsOf(emissions).length >= 1)
      expect(textsOf(emissions)).toEqual(['gated'])
      expect(emissions[0]?.reset).toBe(true)
      // Post-seed live appends flow through ordinary (ungated) polls.
      appendFileSync(path, `${userRecord('g2', 'after')}\n`)
      await waitFor(() => itemsOf(emissions).length >= 2)
      expect(textsOf(emissions)).toEqual(['gated', 'after'])
    } finally {
      tailer.stop()
    }
  })
})

describe('tailTranscript — chunked backfill + boot-seed window (POD-613)', () => {
  const collect = (path: string, opts: Parameters<typeof tailTranscript>[2]) => {
    const emissions: Emission[] = []
    const tailer = tailTranscript(
      path,
      (items, meta) => emissions.push({ items, reset: meta.reset, tail: meta.tail }),
      { pollMs: 10, ...opts },
    )
    return { emissions, tailer }
  }

  it('a tiny readChunkBytes yields identical items + exact cursors across chunk boundaries', async () => {
    const path = join(dir, 'tail-chunked.jsonl')
    const records = Array.from({ length: 5 }, (_, i) =>
      userRecord(`k${i}`, `msg-${i}-${'x'.repeat(90)}`),
    )
    writeFileSync(path, `${records.join('\n')}\n`)
    // 64-byte chunks force every record to span multiple chunks — the leftover
    // carry across chunk reads must keep absolute offsets exact.
    const { emissions, tailer } = collect(path, { readChunkBytes: 64 })
    try {
      await waitFor(() => itemsOf(emissions).length >= records.length)
      const items = itemsOf(emissions)
      expect(items.map((i) => i.text)).toEqual(records.map((_, i) => `msg-${i}-${'x'.repeat(90)}`))
      // Cursor offsets must match each record's true byte position.
      let expected = 0
      for (const [i, item] of items.entries()) {
        const c = decodeCursor(item.cursor ?? '')
        expect(c?.offset).toBe(expected)
        expect(c?.uuid).toBe(`k${i}`)
        expected += Buffer.byteLength(records[i] ?? '', 'utf8') + 1
      }
      // Appends after the seed keep flowing chunked too.
      const r6 = userRecord('k5', 'appended')
      appendFileSync(path, `${r6}\n`)
      await waitFor(() => itemsOf(emissions).length > items.length)
      const all = itemsOf(emissions)
      expect(all.at(-1)?.text).toBe('appended')
      expect(decodeCursor(all.at(-1)?.cursor ?? '')?.offset).toBe(expected)
    } finally {
      tailer.stop()
    }
  })

  it('honors initialWindowBytes: the seed reads only the tail window and drops the leading partial', async () => {
    const path = join(dir, 'tail-window.jsonl')
    const records = Array.from({ length: 6 }, (_, i) => userRecord(`w${i}`, `win-${i}`))
    writeFileSync(path, `${records.join('\n')}\n`)
    // Window covering the last two records plus a fragment of the one before —
    // the fragment must be dropped, the last two emitted.
    const lastTwo = Buffer.byteLength(`${records[4]}\n${records[5]}\n`, 'utf8')
    const { emissions, tailer } = collect(path, { initialWindowBytes: lastTwo + 10 })
    try {
      await waitFor(() => itemsOf(emissions).length >= 2)
      expect(textsOf(emissions)).toEqual(['win-4', 'win-5'])
      expect(emissions[0]?.reset).toBe(true)
    } finally {
      tailer.stop()
    }
  })

  it('honors maxInitialItems: a reset seed keeps only the most recent items', async () => {
    const path = join(dir, 'tail-maxitems.jsonl')
    const records = Array.from({ length: 7 }, (_, i) => userRecord(`m${i}`, `cap-${i}`))
    writeFileSync(path, `${records.join('\n')}\n`)
    // A tiny chunk size proves the cap is enforced while accumulating, not just
    // in one final slice.
    const { emissions, tailer } = collect(path, { maxInitialItems: 3, readChunkBytes: 64 })
    try {
      await waitFor(() => itemsOf(emissions).length >= 3)
      expect(textsOf(emissions)).toEqual(['cap-4', 'cap-5', 'cap-6'])
    } finally {
      tailer.stop()
    }
  })
})

describe('tailTranscript — observed model (POD-121)', () => {
  const assistantRecord = (uuid: string, model: string, text: string): string =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-06-15T10:00:00.000Z',
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
      },
    })

  it('emits onModel on first sighting and on change, not on repeats', async () => {
    const path = join(dir, 'tail-model.jsonl')
    writeFileSync(path, `${assistantRecord('m1', 'claude-fable-5', 'one')}\n`)
    const models: string[] = []
    const { tailer, tick } = makeTailHarness(path, 10, { onModel: (m) => models.push(m) })
    await tick()
    expect(models).toEqual(['claude-fable-5'])

    // Same model again — no re-emit.
    appendFileSync(path, `${assistantRecord('m2', 'claude-fable-5', 'two')}\n`)
    await tick()
    expect(models).toEqual(['claude-fable-5'])

    // A /model switch mid-session — emits the new id.
    appendFileSync(path, `${assistantRecord('m3', 'claude-opus-4-8', 'three')}\n`)
    await tick()
    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
    tailer.stop()
  })
})
