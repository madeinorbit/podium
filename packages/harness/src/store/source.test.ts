import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from '../adapters/claude-code/transcript.js'
import { encodeCursor } from './cursor-codec'
import { fileIdFor, type ChainEntry } from './file-chain'
import { opencodeFileId } from '../adapters/opencode/transcript.js'
import { fileChainSource, sliceItemsByAnchor } from './source'

const item = (uuid: string | null, offset: number, sub = 0): TranscriptItem =>
  ({
    id: `${uuid}:${sub}`,
    text: `${uuid}:${sub}`,
    cursor: encodeCursor({
      fileId: opencodeFileId('session'),
      uuid,
      offset,
      sub,
    }),
  }) as TranscriptItem

describe('session cursor identity', () => {
  it('anchors opencode by UUID and sub after position drift', () => {
    const all = [item('other', 20), item('anchor', 30), item('anchor', 30, 1), item('next', 40)]
    const anchor = item('anchor', 20).cursor
    expect(sliceItemsByAnchor(all, { anchor, direction: 'after', limit: 2 }).items).toEqual(
      all.slice(2),
    )
    expect(
      sliceItemsByAnchor(all, {
        anchor: item('anchor', 20, 1).cursor,
        direction: 'before',
        limit: 1,
      }).items,
    ).toEqual([all[1]])
  })

  it('anchors UUID-less opencode cursors by position and sub', () => {
    const all = [item('a', 10), item('b', 20), item('b', 20, 1), item('c', 30)]
    expect(
      sliceItemsByAnchor(all, { anchor: item(null, 20).cursor, direction: 'after', limit: 1 })
        .items,
    ).toEqual([all[2]])
  })

  it('uses identical ids and cursors for two paths and repeated parses in one session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-identity-'))
    try {
      const bytes = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'héllo' } })}\n`
      const paths = [join(dir, 'live.jsonl'), join(dir, 'mirror.jsonl')] as const
      for (const path of paths) await writeFile(path, bytes)
      const read = (path: string, fileId: string, cached = false) =>
        fileChainSource([{ path, fileId }], claudeRecordToItems).readSlice({
          direction: 'before',
          limit: 10,
          cached,
        })
      const first = await read(paths[0], fileIdFor('native-session'))
      expect(first.items).toHaveLength(1)
      expect(first.items[0]?.id).toBe(first.items[0]?.cursor)
      expect(await read(paths[0], fileIdFor('native-session'))).toEqual(first)
      expect(await read(paths[1], fileIdFor('native-session'))).toEqual(first)
      expect(await read(paths[0], fileIdFor('native-session'), true)).toEqual(first)
      const archived = await read(paths[0], fileIdFor('native-session', 1), true)
      // Archived bytes belong to a retired generation; they must not deduplicate against live rows.
      expect(archived.items[0]?.cursor).not.toBe(first.items[0]?.cursor)
      expect(await read(paths[1], fileIdFor('native-session', 1))).toEqual(archived)
      expect(fileIdFor('native-session')).toMatch(/^[a-f0-9]{12}$/)
      expect(fileIdFor('native-session', 1)).not.toBe(fileIdFor('native-session', 2))
      const oldAnchor = encodeCursor({ fileId: 'old-path-hash', offset: 0, uuid: null, sub: 0 })
      const source = fileChainSource(
        [{ path: paths[0], fileId: fileIdFor('native-session') }],
        claudeRecordToItems,
      )
      expect(await source.readSlice({ anchor: oldAnchor, direction: 'before', limit: 10 })).toEqual(
        first,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// fileChainSource: delegates to the chain reader (moved from the deleted
// transcript-source.test.ts with transcript-source.ts, POD-4471).
// ---------------------------------------------------------------------------

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

const idxToItems = (r: unknown): TranscriptItem[] => {
  const t = r as TestRecord
  return [
    { id: t.uuid, role: t.type, text: t.message.content[0]?.text },
  ] as unknown as TranscriptItem[]
}

/** Two chained JSONL files: f1 holds items 0..4, f2 holds items 5..9. */
async function twoFiles(): Promise<{ chain: ChainEntry[]; toItems: typeof idxToItems }> {
  const dir = await mkdtemp(join(tmpdir(), 'src-chain-'))
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

describe('fileChainSource', () => {
  it('delegates a no-anchor before read to the chain reader (newest limit + hasMore)', async () => {
    const { chain, toItems } = await twoFiles()
    const src = fileChainSource(chain, toItems)
    const r = await src.readSlice({ direction: 'before', limit: 3 })
    expect(r.items.map((i) => i.text)).toEqual(['7', '8', '9'])
    expect(r.hasMore).toBe(true)
    expect(r.head).toBe(r.items[0]?.cursor)
    expect(r.tail).toBe(r.items.at(-1)?.cursor)
  })

  it('pages before an anchor across the file boundary (same as readTranscriptSlice)', async () => {
    const { chain, toItems } = await twoFiles()
    const src = fileChainSource(chain, toItems)
    const first = await src.readSlice({ direction: 'before', limit: 3 }) // 7,8,9
    const older = await src.readSlice({ anchor: first.head, direction: 'before', limit: 3 })
    expect(older.items.map((i) => i.text)).toEqual(['4', '5', '6'])
    expect(older.hasMore).toBe(true)
  })

  it('empty chain → empty result', async () => {
    const src = fileChainSource([], idxToItems)
    const r = await src.readSlice({ direction: 'before', limit: 5 })
    expect(r.items).toEqual([])
    expect(r.hasMore).toBe(false)
    expect(r.head).toBeUndefined()
    expect(r.tail).toBeUndefined()
  })
})
