import { TranscriptGraph } from '@podium/client-core/conversation'
import { type TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { MobileConversationPresentation as Before } from './conversation-presentation.before.test.fixture'
import {
  MobileConversationPresentation as After,
  MobileTranscriptSearch,
} from './conversation-presentation'
import { shapeMobileChatRow } from './transcript-feed'

it('matches the old phone rows and search answers through stream, removal and reset', () => {
  const items: TranscriptItem[] = [
    { id: 'prompt', role: 'user', text: 'needle prompt' },
    { id: 'reply', role: 'assistant', answer: true, text: 'needle reply' },
    { id: 'tool', role: 'tool', toolUseId: 'use', toolName: 'Read', text: '', toolInput: '/file' },
  ]
  const graph = new TranscriptGraph(items)
  const old = new Before(graph as any, shapeMobileChatRow, (id) => graph.itemPosition(id))
  const next = new After(graph as any, shapeMobileChatRow, (id) => graph.itemPosition(id))
  const check = () => {
    expect(next.snapshot()).toEqual(old.snapshot())
    expect([...next.keys]).toEqual([...old.keys])
    expect(next.latestAssistantKey).toEqual(old.latestAssistantKey)
    for (const query of ['', 'needle', 'file', 'wrong'])
      for (const cursor of [-1, 0, 1, 99])
        expect(next.search(query, cursor)).toEqual(old.search(query, cursor))
  }
  check()
  graph.apply({ changed: [{ ...items[1]!, text: 'new answer' }] })
  old.apply(graph.rowPublication)
  next.apply(graph.rowPublication)
  check()
  graph.apply({ changed: [], removed: ['tool'] })
  old.apply(graph.rowPublication)
  next.apply(graph.rowPublication)
  check()
  graph.reset(items)
  old.reset()
  next.reset()
  check()
  const wrong = new After(new TranscriptGraph([]) as any, shapeMobileChatRow, () => 0)
  expect(() => expect(wrong.snapshot()).toEqual(old.snapshot())).toThrow()
  old.dispose()
  next.dispose()
  wrong.dispose()
  graph.dispose()
})

it('keeps Find state on the viewport and routes the current visible matches', () => {
  const graph = new TranscriptGraph([{ id: 'a', role: 'assistant', text: 'needle' }])
  const rows = new After(graph as any, shapeMobileChatRow, (id) => graph.itemPosition(id))
  const one = new MobileTranscriptSearch(rows),
    two = new MobileTranscriptSearch(rows)
  one.setQuery('needle')
  one.moveCursor(1)
  expect(one.search.total).toBe(1)
  expect(two.query).toBe('')
  expect(two.cursor).toBe(0)
  expect(two.search.total).toBe(0)
  rows.dispose()
  graph.dispose()
})
