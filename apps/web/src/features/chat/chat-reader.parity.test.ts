import { TranscriptLog } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { ConversationPresentation as Before } from './conversation-presentation.before.test.fixture'
import { ConversationPresentation as After } from './conversation-presentation'

const client = {
  usesWorker: false,
  computeGraphOnMain: (source: any, query: string, cursor: number) => {
    source.sent()
    return { search: source.graph.search(query, cursor), markdownHtml: new Map() }
  },
  forgetGraph: () => {},
} as any
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
const item = (id: string, text = id): TranscriptItem => ({
  id,
  role: 'assistant',
  answer: true,
  text,
})
function fixture<T extends Before | After>(presentation: T, items: TranscriptItem[]) {
  const log = new TranscriptLog({
    sessionId: asSessionId('reader'),
    source: { read: async () => ({ items, hasMore: false }), subscribe: () => () => {} },
    cache: { read: () => ({ items, savedAt: 1 }), write: () => {} },
    retainHistory: () => presentation.retainHistory,
    onChange: (change) => presentation.changed(change),
  })
  presentation.bind(log)
  return { presentation, log }
}
const answer = (view: Before | After) =>
  plain({
    blocks: view.blocks,
    rows: view.rows,
    renderStart: view.renderStart,
    visibleRows: view.visibleRows,
    rendered: view.renderRows(true, false),
    query: view.query,
    search: view.search,
    retainHistory: view.retainHistory,
    lastAnswer: view.lastAnswer,
  })

it('matches the old reader answers across find, cursor, window, follow and stream changes', () => {
  const items = [
    { ...item('prompt'), role: 'user' as const },
    ...Array.from({ length: 330 }, (_, at) => item(`row-${at}`, `needle ${at}`)),
  ]
  const old = fixture(new Before(client), items),
    next = fixture(new After(client), items)
  const check = () => expect(answer(next.presentation)).toEqual(answer(old.presentation))
  check()
  for (const change of [
    (view: Before | After) => view.setFollowTail(false),
    (view: Before | After) => view.setRenderCount(310),
    (view: Before | After) => view.setQuery('needle'),
    (view: Before | After) => view.moveCursor(2),
    (view: Before | After) => view.setQuery(''),
    (view: Before | After) => view.setFollowTail(true),
  ]) {
    change(old.presentation)
    change(next.presentation)
    check()
  }
  old.log.merge([item('tail', 'needle next')])
  next.log.merge([item('tail', 'needle next')])
  check()
  next.presentation.setQuery('deliberately wrong')
  expect(check).toThrow()
  for (const f of [old, next]) {
    f.presentation.dispose()
    f.log.dispose()
  }
})

it('gives two readers of one transcript independent query, cursor, follow and window state', () => {
  const one = fixture(
    new After(client),
    Array.from({ length: 330 }, (_, at) => item(`row-${at}`, `needle ${at}`)),
  )
  const two = new After(client)
  two.bind(one.log)
  one.presentation.setQuery('needle')
  one.presentation.moveCursor(2)
  one.presentation.setFollowTail(false)
  one.presentation.setRenderCount(310)
  expect(two.query).toBe('')
  expect(two.cursor).toBe(0)
  expect(two.followTail).toBe(true)
  expect(two.renderCount).toBe(300)
  expect(two.search.total).toBe(0)
  one.presentation.dispose()
  two.dispose()
  one.log.dispose()
})
