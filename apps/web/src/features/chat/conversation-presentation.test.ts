import { type TranscriptGraphChange, TranscriptLog } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationPresentation } from './conversation-presentation'
import type {
  TranscriptComputeOptions,
  TranscriptGraphSource,
  WebTranscriptGraphResult,
} from './transcript-compute-client'

const worker = vi.hoisted(() => ({
  usesWorker: true,
  computeGraph: vi.fn(),
  computeGraphOnMain: vi.fn(),
  forgetGraph: vi.fn(),
}))
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
const main = (
  source: TranscriptGraphSource,
  query: string,
  cursor: number,
): WebTranscriptGraphResult => ({
  search: source.graph.search(query, cursor),
  markdownHtml: new Map(),
})
beforeEach(() => {
  requests.length = 0
  worker.usesWorker = true
  worker.computeGraph.mockImplementation((source, query, cursor, options) => {
    const cold = source.needsReset
    const delta = source.pending()
    source.sent()
    return new Promise((resolve, reject) =>
      requests.push({ source, query, cursor, cold, delta, options, resolve, reject }),
    )
  })
  worker.computeGraphOnMain.mockImplementation((source, query, cursor) => {
    source.sent()
    return main(source, query, cursor)
  })
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.clearAllMocks()
})
const item = (id: string, text = id): TranscriptItem => ({
  id,
  role: 'assistant',
  answer: true,
  text,
})
function fixture(items: TranscriptItem[] = [item('a')]) {
  const presentation = new ConversationPresentation()
  const log: TranscriptLog = new TranscriptLog({
    sessionId: asSessionId('presentation'),
    source: { read: async () => ({ items: log.items, hasMore: false }), subscribe: () => () => {} },
    retainHistory: () => presentation.retainHistory,
    retainFrom: () => presentation.retainFrom,
    onChange: (change) => presentation.changed(change),
  })
  log.merge(items)
  presentation.bind(log)
  stops.push(() => {
    presentation.dispose()
    log.dispose()
  })
  return { presentation, log }
}
function resolve(at = requests.length - 1) {
  const request = requests[at]!
  request.resolve(main(request.source, request.query, request.cursor))
}

it('keeps narration out of folds and rebuilds structure only when its text first appears', () => {
  worker.usesWorker = false
  const call: TranscriptItem = {
    id: 'call',
    role: 'tool',
    text: '',
    toolName: 'Read',
    toolInput: '/a.ts',
    toolResult: 'ok',
  }
  const intro: TranscriptItem = { id: 'intro', role: 'assistant', text: '' }
  const { presentation, log } = fixture([
    { id: 'prompt', role: 'user', text: 'Check' },
    call,
    intro,
  ])
  expect(presentation.turnFolds.trailing?.state).toBe('live')
  log.merge([{ ...intro, text: 'Checking now.' }])
  const structure = presentation.turnFolds
  expect(structure.folds.map((fold) => [fold.state, fold.members])).toEqual([['done', [1]]])
  expect(structure.byMember.has(2)).toBe(false)
  log.merge([{ ...intro, text: 'Checking the next file.' }])
  expect(presentation.turnFolds).toBe(structure)
})

it('uses retained category facts and boundary calls without materializing a collapsed turn run', () => {
  worker.usesWorker = false
  const calls: TranscriptItem[] = Array.from({ length: 512 }, (_, n) => ({
    id: `call-${n}`,
    role: 'tool',
    text: '',
    toolName: 'Read',
    toolInput: `/file-${n}.ts`,
  }))
  const { presentation } = fixture(calls)
  const row = presentation.rows[0]!
  const run = presentation.run('call-0')!
  Object.defineProperty(run, 'blocks', {
    get() {
      throw new Error('collapsed turn materialized members')
    },
  })
  const model = presentation.turn(row)
  expect(model.eventCount).toBe(512)
  expect(model.summary).toBe('read 512 files')
  expect(model.currentTool?.item.id).toBe('call-511')
  expect(model.firstEvent?.item.id).toBe('call-0')
})

it('keeps empty structural fallbacks stable while the first result is pending', () => {
  const { presentation } = fixture()
  const blocks = presentation.blocks,
    rows = presentation.rows
  stops.push(
    autorun(() => {
      expect(presentation.blocks).toBe(blocks)
      expect(presentation.rows).toBe(rows)
    }),
  )
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
})

it('a streamed item changes its observed block without changing the list or another block', async () => {
  const { presentation, log } = fixture([item('a'), item('b')])
  resolve(0)
  await Promise.resolve()
  let frames = 0,
    rowA = 0,
    rowB = 0
  stops.push(
    autorun(() => {
      presentation.rows
      frames++
    }),
  )
  stops.push(
    autorun(() => {
      presentation.block('a')
      rowA++
    }),
  )
  stops.push(
    autorun(() => {
      presentation.block('b')
      rowB++
    }),
  )
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
  const history = [
    { ...item('prompt'), role: 'user' as const },
    ...Array.from({ length: 330 }, (_, at) => item('row-' + at)),
  ]
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

it('keeps complete live turn identity, counts and timing beyond both source limits, then releases old turns', () => {
  worker.usesWorker = false
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, seconds)).toISOString()
  const old = Array.from({ length: 80 }, (_, n) => ({
    ...item(`old-${n}`),
    cursor: `old-cursor-${n}`,
  }))
  const prompt: TranscriptItem = {
    id: 'long-prompt',
    cursor: 'long-0',
    role: 'user',
    text: 'Check everything',
    ts: at(0),
  }
  // Text-less assistant records: rows of their own inside the run, never the
  // narration that would end it (POD-6258).
  const updates: TranscriptItem[] = Array.from({ length: 298 }, (_, n) => ({
    id: `update-${n}`,
    cursor: `long-${n + 1}`,
    role: 'assistant',
    text: '',
    ts: at(n + 1),
  }))
  const first: TranscriptItem = {
    id: 'first-call',
    cursor: 'long-first',
    role: 'tool',
    text: '',
    toolName: 'Read',
    toolInput: '/first.ts',
    toolResult: 'done',
    ts: at(1),
  }
  const { presentation, log } = fixture([...old, prompt, first, ...updates])
  const initial = presentation.turnFolds.trailing!
  presentation.folds.open(initial.key)
  expect(presentation.renderStart).toBe(80)
  expect(initial.members).toHaveLength(299)
  for (const [from, to] of [
    [298, 360],
    [360, 450],
  ])
    log.merge(
      Array.from({ length: to! - from! }, (_, offset) => {
        const n = from! + offset
        return {
          id: `update-${n}`,
          cursor: `long-${n + 1}`,
          role: 'assistant' as const,
          text: '',
          ts: at(n + 1),
        }
      }),
    )
  const live = presentation.turnFolds.trailing!
  expect(live.key).toBe(initial.key)
  expect(presentation.folds.isOpen(live.key)).toBe(true)
  expect(live.members).toHaveLength(451)
  expect(live.startedAt).toBe(initial.startedAt)
  expect(log.ids).toContain(prompt.id)
  expect(log.ids).not.toContain('old-0')
  expect(presentation.renderStart).toBe(0)
  const model = presentation.turn(presentation.renderRows(false, false)[1]!.row)
  expect(model.eventCount).toBe(1)
  log.merge([{ ...item('long-answer'), cursor: 'long-answer', ts: at(600) }])
  expect(presentation.turnFolds.folds[0]?.key).toBe(initial.key)
  expect(presentation.turnFolds.folds[0]?.durationMs).toBe(599000)
  // A later window is allowed to release that now wholly off-screen segment.
  log.merge(
    Array.from({ length: 500 }, (_, n) => ({
      ...item(`later-${n}`),
      cursor: `later-cursor-${n}`,
      ts: at(700 + n),
    })),
  )
  log.merge([{ ...item('last'), cursor: 'last-cursor' }])
  expect(log.ids.length).toBeLessThanOrEqual(400)
  expect(log.ids).not.toContain(prompt.id)
  expect(presentation.visibleRows).toHaveLength(300)
})
