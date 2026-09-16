import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude'
import { encodeCursor } from './cursor-codec'
import { fileIdFor } from './file-chain'
import { fileChainSource, opencodeFileId, sliceItemsByAnchor } from './source'

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
