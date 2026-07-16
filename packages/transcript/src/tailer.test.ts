import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeCursor } from './cursor-codec'
import { fileIdFor } from './file-chain'
import { tailTranscript } from './tailer'

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
    // to the same bounded TAIL_BYTES window the first read uses (reset=true, the
    // leading partial line at the seek point dropped).
    const path = join(dir, 'tail-truncate-cap.jsonl')
    // Initial file: ~18MB of blank lines (no items) so the tail is fully consumed
    // past the replacement's size, which is what makes the swap read as truncation.
    writeFileSync(path, '\n'.repeat(18 * 1024 * 1024))

    const { tailer, tick } = makeTailHarness(path, 50)
    try {
      // Drain the initial (reset) read; retry until the big first scan settles.
      for (let i = 0; i < 40; i++) {
        const got = await tick()
        if (got.some((e) => e.reset)) break
      }

      // Replace with ~17MB: one HUGE valid record + a tiny one. The capped re-read
      // seeks past most of the huge record, drops its partial fragment, and emits
      // only the tiny record; the old uncapped behavior emitted BOTH.
      const huge = userRecord('t-huge', 'x'.repeat(17 * 1024 * 1024))
      const tiny = userRecord('t-tiny', 'small-after-truncate')
      writeFileSync(path, `${huge}\n${tiny}\n`)

      const emissions: Emission[] = []
      for (let i = 0; i < 40; i++) {
        emissions.push(...(await tick()))
        if (emissions.some((e) => e.reset)) break
      }
      const reset = emissions.find((e) => e.reset)
      expect(reset).toBeDefined()
      const texts = emissions.flatMap((e) => e.items).map((i) => i.text)
      expect(texts).toEqual(['small-after-truncate'])
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
      // neither the seed itself nor a timer tick stealing the big first read.
      await new Promise((r) => setTimeout(r, 50))
      expect(emissions).toEqual([])
      release()
      await new Promise((r) => setTimeout(r, 30))
      expect(emissions.flatMap((e) => e.items).map((i) => i.text)).toEqual(['gated'])
      expect(emissions[0]?.reset).toBe(true)
      // Post-seed live appends flow through ordinary (ungated) polls.
      appendFileSync(path, `${userRecord('g2', 'after')}\n`)
      await new Promise((r) => setTimeout(r, 50))
      expect(emissions.flatMap((e) => e.items).map((i) => i.text)).toEqual(['gated', 'after'])
    } finally {
      tailer.stop()
    }
  })
})
