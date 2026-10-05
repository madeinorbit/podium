import { TranscriptLog } from '@podium/client-core/conversation'
import { computeTranscript, type TranscriptComputeInput } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationPresentation } from './conversation-presentation'
import type { TranscriptComputeOptions, WebTranscriptComputeResult } from './transcript-compute-client'

const worker = vi.hoisted(() => ({ usesWorker: true, compute: vi.fn(), computeOnMain: vi.fn() }))
vi.mock('./transcript-compute-client', () => ({ transcriptComputeClient: () => worker }))
const requests: { input: TranscriptComputeInput; options: TranscriptComputeOptions; resolve(value: WebTranscriptComputeResult): void; reject(error: Error): void }[] = []
const stops: (() => void)[] = []
beforeEach(() => {
  requests.length = 0
  worker.usesWorker = true
  worker.compute.mockImplementation((input, options) => new Promise((resolve, reject) => requests.push({ input, options, resolve, reject })))
  worker.computeOnMain.mockImplementation(input => ({ ...computeTranscript(input), markdownHtml: new Map() }))
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
function result(input: TranscriptComputeInput): WebTranscriptComputeResult { return { ...computeTranscript(input), markdownHtml: new Map() } }

it('keeps empty worker fallbacks stable while the first result is pending', () => {
  const { presentation } = fixture()
  let blocks = presentation.blocks, rows = presentation.rows
  stops.push(autorun(() => { expect(presentation.blocks).toBe(blocks); expect(presentation.rows).toBe(rows) }))
  expect(presentation.computeReady).toBe(false)
  expect(requests).toHaveLength(1)
})

it('keeps only the latest worker result and sends changed items plus order', async () => {
  const { presentation, log } = fixture()
  const first = requests[0]!
  log.merge([item('a', 'newer')])
  const second = requests[1]!
  expect(first.options.signal?.aborted).toBe(true)
  expect(second.options.delta).toMatchObject({ changed: [item('a', 'newer')], order: ['a'] })
  second.resolve(result(second.input))
  await Promise.resolve()
  first.resolve(result(first.input))
  await Promise.resolve()
  expect(presentation.block('a')?.item.text).toBe('newer')
  expect(presentation.result?.blocks[0]?.item.text).toBe('newer')
})

it('a streamed item changes the observed block without changing the observed index', async () => {
  const { presentation, log } = fixture([item('a'), item('b')])
  requests[0]!.resolve(result(requests[0]!.input))
  await Promise.resolve()
  let frames = 0, rowA = 0, rowB = 0
  stops.push(autorun(() => { presentation.rows; frames++ }))
  stops.push(autorun(() => { presentation.block('a'); rowA++ }))
  stops.push(autorun(() => { presentation.block('b'); rowB++ }))
  frames = rowA = rowB = 0
  log.merge([item('b', 'streamed')])
  expect({ frames, rowA, rowB }).toEqual({ frames: 0, rowA: 0, rowB: 1 })
  requests[1]!.resolve(result(requests[1]!.input))
  await Promise.resolve()
  expect({ frames, rowA, rowB }).toEqual({ frames: 0, rowA: 0, rowB: 1 })
})

it('a warm presentation continues computing without a React panel', async () => {
  const { presentation, log } = fixture()
  log.merge([item('a', 'hidden stream')])
  requests.at(-1)!.resolve(result(requests.at(-1)!.input))
  await Promise.resolve()
  expect(presentation.block('a')?.item.text).toBe('hidden stream')
  presentation.dispose()
  expect(requests.at(-1)!.options.signal?.aborted).toBe(true)
  log.merge([item('a', 'evicted')])
  expect(requests).toHaveLength(2)
})

it('the synchronous fallback clears rendering freshness in the same transcript action', async () => {
  worker.usesWorker = false
  const { log } = fixture()
  await log.start()
  expect(log.freshness).toBeNull()
  log.merge([item('a', 'new text')])
  expect(log.freshness).toBeNull()
})
