import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readTranscriptPage, readTranscriptTail } from './tailer.js'

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
