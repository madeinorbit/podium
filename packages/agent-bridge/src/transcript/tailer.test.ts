import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readTranscriptTail } from './tailer.js'

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
    writeFileSync(path, `${userRecord('u1', 'ok')}\n{ this is not json\n${userRecord('u2', 'also ok')}\n`)
    const items = await readTranscriptTail(path)
    expect(items.map((i) => i.text)).toEqual(['ok', 'also ok'])
  })
})
