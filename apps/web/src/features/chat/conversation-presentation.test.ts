import { TranscriptLog, type TranscriptGraphChange } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationPresentation } from './conversation-presentation'
import type { TranscriptComputeOptions, TranscriptGraphSource, WebTranscriptGraphResult } from './transcript-compute-client'

const worker = vi.hoisted(() => ({ usesWorker: true, computeGraph: vi.fn(), computeGraphOnMain: vi.fn(), forgetGraph: vi.fn() }))
vi.mock('./transcript-compute-client', () => ({ transcriptComputeClient: () => worker }))
const requests: {
  source: TranscriptGraphSource
  query: string
  cursor: number
  cold: boolean
  delta: TranscriptGraphChange
  options: TranscriptComputeOptions
  resolve(value: WebTranscriptGraphResult): void
  reject(error: Error): void
}[] = []
const stops: (() => void)[] = []
const main = (source: TranscriptGraphSource, query: string, cursor: number): WebTranscriptGraphResult =>
  ({ search: source.graph.search(query, cursor), markdownHtml: new Map() })
beforeEach(() => {
  requests.length = 0
  worker.usesWorker = true
  worker.computeGraph.mockImplementation((source, query, cursor, options) => {
    const cold = source.needsReset
    const delta = source.pending()
    source.sent()
    return new Promise((resolve, reject) => requests.push({ source, query, cursor, cold, delta, options, resolve, reject }))
  })
  worker.computeGraphOnMain.mockImplementation((source, query, cursor) => {
    source.sent()
    return main(source, query, cursor)
  })
})
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.clearAllMocks() })
const item = (id: string, text = id): TranscriptItem => ({ id, role: 'assistant', answer: true, text })
function fixture(items: TranscriptItem[] = [item('a')]) {
  const presentation = new ConversationPresentation()
  const log: TranscriptLog = new TranscriptLog({
    sessionId: asSessionId('presentation'),
    source: { read: async () => ({ items: log.items, hasMore: false }), subscribe: () => () => {} },
    cache: { read: () => ({ items, savedAt: 1 }), write: () => {} },
    retainHistory: () => presentation.retainHistory,
    onChange: change => presentation.changed(change),
  })
  presentation.bind(log)
  stops.push(() => { presentation.dispose(); log.dispose() })
  return { presentation, log }
}
function resolve(at = requests.length - 1) {
  const request = requests[at]!
  request.resolve(main(request.source, request.query, request.cursor))
}

it('keeps empty structural fallbacks stable while the first result is pending', () => {
  const { presentation } = fixture()
  const blocks = presentation.blocks, rows = presentation.rows
  stops.push(autorun(() => { expect(presentation.blocks).toBe(blocks); expect(presentation.rows).toBe(rows) }))
  expect(presentation.computeReady).toBe(false)
  expect(requests).toHaveLength(1)
})

it('accepts only the latest worker request and keeps a streamed delta sparse', async () => {
  const { presentation, log } = fixture()
  const first = requests[0]!
  log.merge([item('a', 'newer')])
  const second = requests[1]!
  expect(first.options.signal?.aborted).toBe(true)
  expect(second.cold).toBe(false)
  expect(second.delta).toEqual({ changed: [item('a', 'newer')], insertions: [], removed: [] })
  resolve(1)
  await Promise.resolve()
  resolve(0)
  await Promise.resolve()
  expect(presentation.block('a')?.item.text).toBe('newer')
  expect(presentation.lastAnswer.text).toBe('newer')
})

it('a streamed item changes its observed block without changing the list or another block', async () => {
  const { presentation, log } = fixture([item('a'), item('b')])
  resolve(0)
  await Promise.resolve()
  let frames = 0, rowA = 0, rowB = 0
  stops.push(autorun(() => { presentation.rows; frames++ }))
  stops.push(autorun(() => { presentation.block('a'); rowA++ }))
  stops.push(autorun(() => { presentation.block('b'); rowB++ }))
  frames = rowA = rowB = 0
  log.merge([item('b', 'streamed')])
  expect({ frames, rowA, rowB }).toEqual({ frames: 0, rowA: 0, rowB: 1 })
  resolve(1)
  await Promise.resolve()
  expect({ frames, rowA, rowB }).toEqual({ frames: 0, rowA: 0, rowB: 1 })
})

it('a warm presentation continues accepting source changes without a React panel', async () => {
  const { presentation, log } = fixture()
  log.merge([item('a', 'hidden stream')])
  resolve()
  await Promise.resolve()
  expect(presentation.block('a')?.item.text).toBe('hidden stream')
  presentation.dispose()
  expect(requests.at(-1)!.options.signal?.aborted).toBe(true)
  log.merge([item('a', 'evicted')])
  expect(requests).toHaveLength(2)
  expect(worker.forgetGraph).toHaveBeenCalled()
})

it('the synchronous fallback clears rendering freshness in the same transcript action', async () => {
  worker.usesWorker = false
  const { log } = fixture()
  await log.start()
  expect(log.freshness).toBeNull()
  log.merge([item('a', 'new text')])
  expect(log.freshness).toBeNull()
})

it('query and cursor requests carry no history and use maintained block-to-row membership', async () => {
  const { presentation } = fixture([item('a', 'needle first'), item('b', 'needle second')])
  resolve()
  await Promise.resolve()
  presentation.setQuery('needle')
  expect(requests.at(-1)!.delta).toEqual({ changed: [], insertions: [], removed: [] })
  expect(presentation.search).toMatchObject({ matches: [0, 1], activeRow: 0, total: 2 })
  presentation.moveCursor(1)
  expect(presentation.search.activeRow).toBe(1)
  expect(requests.at(-1)!.cold).toBe(false)
  expect(requests.at(-1)!.delta.changed).toEqual([])
  expect(presentation.revealRow('b')).toBe(1)
})

it('keeps the held window and preceding operator prompt addressed across an older page', async () => {
  worker.usesWorker = false
  const history = [ { ...item('prompt'), role: 'user' as const }, ...Array.from({ length: 330 }, (_, at) => item('row-' + at)) ]
  const { presentation } = fixture(history)
  expect(presentation.visibleRows).toHaveLength(300)
  const rendered = presentation.renderRows(true, false)
  expect(rendered[0]?.row.kind).toBe('block')
  expect(rendered[0]?.index).toBe(0)
  expect(presentation.renderStart).toBe(31)
  presentation.setFollowTail(false)
  presentation.setRenderCount(310)
  expect(presentation.renderStart).toBe(21)
})
