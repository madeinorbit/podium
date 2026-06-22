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
})
