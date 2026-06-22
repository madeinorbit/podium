import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { decodeCursor } from './cursor-codec.js'
import { readFileItems } from './slice.js'

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
