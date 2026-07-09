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
