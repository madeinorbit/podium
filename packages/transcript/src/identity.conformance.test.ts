import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude'
import { codexRecordToItems } from './codex'
import { cursorRecordToItems } from './cursor'
import { decodeCursor, encodeCursor, recordUuid, stampCursors } from './cursor-codec'
import { fileIdFor } from './file-chain'
import { grokRecordToItems } from './grok'
import type { OpencodeMessagePartRow } from './opencode'
import { piRecordToItems } from './pi'
import { readFileItems, readTranscriptSlice } from './slice'
import { opencodeFileId, sliceItemsByAnchor, stampOpencodeItems } from './source'
import { streamItemIdOf } from './stream-identity'

type Mapper = (record: unknown) => TranscriptItem[]
const content = [{ type: 'text', text: 'same words' }]
const families: [string, Mapper, object][] = [
  ['claude-sdk replay', claudeRecordToItems, { type: 'assistant', message: { content } }],
  [
    'codex',
    codexRecordToItems,
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content } },
  ],
  ['cursor', cursorRecordToItems, { role: 'assistant', message: { content } }],
  ['pi', piRecordToItems, { type: 'message', message: { role: 'assistant', content } }],
  ['grok-acp', grokRecordToItems, { role: 'assistant', content }],
]
const ids = (items: TranscriptItem[]) => items.map((item) => item.id)
const coordinates = (items: TranscriptItem[]) => items.map(({ id, cursor }) => ({ id, cursor }))
const namespaces = [
  fileIdFor('session-identity'),
  opencodeFileId('session-identity'),
  'session:/自由 namespace\0archive:2',
]

// These are producer-side tests: only the codec/source may inspect fileId.
// Consumers hand anchors back unchanged; no regex, prefix, or width is required.
for (const [family, mapper, record] of families) {
  describe(`${family} identity contract`, () => {
    for (const fileId of namespaces) {
      it(`preserves the free-form namespace ${JSON.stringify(fileId)} across parses and paths`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'transcript-identity-'))
        try {
          const a = join(directory, 'original.jsonl')
          const b = join(directory, 'copied.jsonl')
          const bytes = `${JSON.stringify(record)}\n`.repeat(3)
          await writeFile(a, bytes)
          await writeFile(b, bytes)
          const first = await readFileItems(a, fileId, mapper)
          expect(first).toHaveLength(3)
          expect(new Set(ids(first)).size).toBe(3)
          expect(first.map((item) => item.text)).toEqual(['same words', 'same words', 'same words'])
          expect(coordinates(await readFileItems(a, fileId, mapper))).toEqual(coordinates(first))
          expect(coordinates(await readFileItems(b, fileId, mapper))).toEqual(coordinates(first))
          for (const item of first) expect(decodeCursor(item.cursor ?? '')?.fileId).toBe(fileId)
          const anchor = first[1]?.cursor
          expect(anchor).toBeDefined()
          const page = await readTranscriptSlice([{ path: b, fileId }], mapper, {
            anchor,
            direction: 'after',
            limit: 10,
          })
          expect(ids(page.items)).toEqual(ids(first.slice(2)))
          // Editing text in place must not remint the first positional identity.
          await writeFile(a, bytes.replaceAll('same words', 'other text'))
          expect(ids(await readFileItems(a, fileId, mapper))).toEqual(ids(first))
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      })
    }

    it('reanchors the saved UUID after a rewrite moves its byte offset', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'transcript-rewrite-'))
      try {
        const path = join(directory, 'fixture.jsonl')
        const fileId = fileIdFor('session-identity')
        const records = [0, 1, 2].map((index) => ({
          ...record,
          uuid: `record-${index}`,
          id: `record-${index}`,
        }))
        const bytes = records.map((value) => JSON.stringify(value)).join('\n') + '\n'
        await writeFile(path, bytes)
        const first = await readFileItems(path, fileId, mapper)
        expect(first).toHaveLength(3)
        expect(coordinates(await readFileItems(path, fileId, mapper))).toEqual(coordinates(first))
        const anchor = first[1]?.cursor
        expect(anchor).toBeDefined()
        // A new ignored record makes the old offset point at different bytes.
        await writeFile(
          path,
          `${JSON.stringify({ ignored: 'prefix changes all byte offsets' })}\n${bytes}`,
        )
        const rewritten = await readFileItems(path, fileId, mapper)
        expect(coordinates(await readFileItems(path, fileId, mapper))).toEqual(
          coordinates(rewritten),
        )
        const after = await readTranscriptSlice([{ path, fileId }], mapper, {
          anchor,
          direction: 'after',
          limit: 10,
        })
        const before = await readTranscriptSlice([{ path, fileId }], mapper, {
          anchor,
          direction: 'before',
          limit: 10,
        })
        expect(coordinates(after.items)).toEqual(coordinates(rewritten.slice(2)))
        expect(coordinates(before.items)).toEqual(coordinates(rewritten.slice(0, 1)))
        expect(rewritten[1]?.cursor).not.toBe(anchor)
        expect(streamItemIdOf(rewritten[1] as TranscriptItem)).toBe(
          streamItemIdOf(first[1] as TranscriptItem),
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })
}

describe('recorded mapper replay', () => {
  for (const [fixture, mapper] of [
    ['codex-rollout.jsonl', codexRecordToItems],
    ['codex-provider-identity.jsonl', codexRecordToItems],
    ['claude-bash-edit.json', claudeRecordToItems],
    ['claude-corpus-shapes.json', claudeRecordToItems],
  ] as const) {
    it(`${fixture}: every recorded shape repeats its ids and item slots`, async () => {
      const bytes = await readFile(new URL(`./__fixtures__/${fixture}`, import.meta.url), 'utf8')
      const records: unknown[] = fixture.endsWith('.jsonl')
        ? bytes
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : fixture === 'claude-corpus-shapes.json'
          ? JSON.parse(bytes).shapes.map((shape: { record: unknown }) => shape.record)
          : JSON.parse(bytes)
      let count = 0
      for (const [index, record] of records.entries()) {
        const input = JSON.stringify(record)
        const parse = () =>
          stampCursors(
            mapper(JSON.parse(input)),
            fileIdFor('recorded-session'),
            index,
            recordUuid(record),
          )
        const first = parse()
        count += first.length
        expect(coordinates(parse())).toEqual(coordinates(first))
        expect(new Set(ids(first)).size).toBe(first.length)
      }
      expect(count).toBeGreaterThan(0)
    })
  }
})

describe('opencode identity contract', () => {
  const sessionId = 'session:variable-length/自由'
  const rows: OpencodeMessagePartRow[] = [0, 1, 2].map((index) => ({
    sessionId,
    messageId: `message-${index}`,
    partId: `part-${index}`,
    timeCreated: 100 + index,
    timeUpdated: 200 + index,
    messageData: JSON.stringify({ role: 'assistant' }),
    partData: JSON.stringify({ type: 'text', text: 'same words' }),
  }))
  it('replays distinct positional ids, reanchors rewritten rows, and joins stream items', () => {
    const bytes = JSON.stringify(rows)
    const parse = () => stampOpencodeItems(JSON.parse(bytes), sessionId)
    const first = parse()
    expect(first).toHaveLength(3)
    expect(coordinates(parse())).toEqual(coordinates(first))
    expect(new Set(ids(first)).size).toBe(3)
    expect(first.map((item) => item.text)).toEqual(['same words', 'same words', 'same words'])
    const rewritten = stampOpencodeItems(
      rows.map((row) => ({
        ...row,
        timeCreated: row.timeCreated + 500,
        partData: row.partData.replace('same words', 'other text'),
      })),
      sessionId,
    )
    expect(ids(rewritten)).toEqual(ids(first))
    const anchor = first[1]?.cursor
    expect(anchor).toBeDefined()
    expect(ids(sliceItemsByAnchor(first, { anchor, direction: 'after', limit: 10 }).items)).toEqual(
      ids(first.slice(2)),
    )
    expect(
      ids(sliceItemsByAnchor(rewritten, { anchor, direction: 'after', limit: 10 }).items),
    ).toEqual(ids(first.slice(2)))
    expect(
      ids(sliceItemsByAnchor(rewritten, { anchor, direction: 'before', limit: 10 }).items),
    ).toEqual(ids(first.slice(0, 1)))
    for (const [index, item] of first.entries()) {
      expect(decodeCursor(item.cursor ?? '')?.fileId).toBe(opencodeFileId(sessionId))
      const deltaId = encodeCursor({
        fileId: opencodeFileId(sessionId),
        offset: 0,
        uuid: `part-${index}`,
        sub: 0,
      })
      expect(streamItemIdOf(item)).toBe(deltaId)
      expect(item.id).toBe(deltaId)
    }
  })
})
