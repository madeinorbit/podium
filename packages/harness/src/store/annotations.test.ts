import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  toolSummaryAnnotation,
  transcriptAnnotationStore,
  weaveAnnotations,
  withTranscriptAnnotations,
} from './annotations'

const call = (id: string): TranscriptItem => ({
  id,
  cursor: `c-${id}`,
  role: 'tool',
  text: '',
  toolName: 'Read',
  toolUseId: id,
})
const result = (id: string): TranscriptItem => ({
  id: `${id}-result`,
  cursor: `c-${id}-r`,
  role: 'tool',
  text: '',
  toolUseId: id,
  toolResult: 'ok',
})
const summary = toolSummaryAnnotation({
  id: 'tool-summary:s1',
  text: 'Read both files',
  toolUseIds: ['a', 'b'],
  ts: '2026-11-03T10:00:00.000Z',
})!

describe('tool summary annotations (POD-6258)', () => {
  it('shapes the generic item and refuses an empty summary or one naming no call', () => {
    expect(summary).toEqual({
      afterToolUseId: 'b',
      item: {
        id: 'tool-summary:s1',
        role: 'system',
        systemKind: 'tool-summary',
        text: 'Read both files',
        summarizes: ['a', 'b'],
        ts: '2026-11-03T10:00:00.000Z',
      },
    })
    expect(toolSummaryAnnotation({ id: 'x', text: '  ', toolUseIds: ['a'] })).toBeUndefined()
    expect(toolSummaryAnnotation({ id: 'x', text: 'Read', toolUseIds: [] })).toBeUndefined()
  })

  it('weaves after the last item of its anchor, once, and leaves other slices alone', () => {
    const items = [call('a'), call('b'), result('a'), result('b'), call('c')]
    const woven = weaveAnnotations(items, [summary])
    expect(woven.map((item) => item.id)).toEqual([
      'a',
      'b',
      'a-result',
      'b-result',
      'tool-summary:s1',
      'c',
    ])
    expect(woven[4]?.cursor).toBeUndefined()
    // Already present (a live delta merged into the same read): not doubled.
    expect(weaveAnnotations(woven, [summary])).toHaveLength(woven.length)
    // A slice without the anchor does not carry it.
    expect(weaveAnnotations([call('c')], [summary]).map((item) => item.id)).toEqual(['c'])
  })

  it('wraps a source so every slice carries its annotations, keeping its cursors', async () => {
    const source = withTranscriptAnnotations(
      {
        readSlice: async () => ({
          items: [call('b'), result('b')],
          head: 'h',
          tail: 't',
          hasMore: true,
        }),
      },
      async () => [summary],
    )
    const slice = await source.readSlice({ direction: 'before', limit: 10 })
    expect(slice).toMatchObject({ head: 'h', tail: 't', hasMore: true })
    expect(slice.items.map((item) => item.id)).toEqual(['b', 'b-result', 'tool-summary:s1'])
    const failing = withTranscriptAnnotations(
      { readSlice: async () => ({ items: [call('b')], hasMore: false }) },
      async () => {
        throw new Error('unreadable')
      },
    )
    expect((await failing.readSlice({ direction: 'before', limit: 10 })).items).toHaveLength(1)
  })

  describe('the per-session log', () => {
    let dir: string | undefined
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
      dir = undefined
    })

    it('appends, reads back per session, and survives a torn last line', async () => {
      dir = await mkdtemp(join(tmpdir(), 'pod6258-annotations-'))
      const store = transcriptAnnotationStore(join(dir, 'log'))
      expect(await store.read('s-1')).toEqual([])
      await store.append('s-1', summary)
      expect(await store.read('s-1')).toEqual([summary])
      expect(await store.read('s-2')).toEqual([])
      await appendFile(join(dir, 'log', 's-1.jsonl'), '{"afterToolUseId":"c","item":')
      expect(await store.read('s-1')).toEqual([summary])
      const second = toolSummaryAnnotation({
        id: 'tool-summary:s2',
        text: 'Ran it',
        toolUseIds: ['c'],
      })!
      await appendFile(join(dir, 'log', 's-1.jsonl'), '\n')
      await store.append('s-1', second)
      expect(await store.read('s-1')).toEqual([summary, second])
    })
  })
})
