import './test-support/no-message-attachments'
import { TranscriptGraph, TranscriptLog, type TurnPreview } from '@podium/client-core/conversation'
import { buildChatRows, pairToolResults, transcriptActivityFacts } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  fakeTranscriptCache,
  storedReadSettled,
} from '@podium/client-core/test-support/transcript-cache'
import * as markdown from '@/lib/markdown'
import { ConversationPresentation } from './conversation-presentation'
import { TranscriptFeed, type TranscriptFeedProps } from './TranscriptFeed'

vi.mock('./mail-body', () => ({
  useMailBody: () => ({ status: 'ready', body: 'Status\nI am reading this body.' }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const disposals: (() => void)[] = []
let host: HTMLDivElement, root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  for (const dispose of disposals.splice(0)) dispose()
  host.remove()
})
const ts = '2026-10-31T12:00:00.000Z'
const say = (id: string, text = id, answer = false): TranscriptItem => ({
  id,
  role: 'assistant',
  text,
  answer,
  ts,
})
const call = (id: string, result?: string): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: 'bun run test',
  toolResult: result,
  ts,
})
const note = (ask = false): TranscriptItem => ({
  id: 'note',
  role: 'user',
  ts,
  text: `[podium message msg_note · from issue:POD-12 · to ${ask ? 'the operator' : 'issue:POD-34'}]\nStatus\nI am reading this body.\n${ask ? '[this is a question: answer the sender]\n' : ''}[end podium message msg_note]`,
})
const prompt: TranscriptItem = { id: 'prompt', role: 'user', text: 'Check it', ts }
const noop = () => {}
function render(items: TranscriptItem[], extra: Partial<TranscriptFeedProps> = {}) {
  const props: TranscriptFeedProps = {
    rows: buildChatRows(pairToolResults(items)).map((row, index) => ({ row, index })),
    setScrollerRef: noop,
    setContentRef: noop,
    onScroll: noop,
    onPointerUp: noop,
    compact: false,
    superagent: false,
    phase: 'ready',
    markdownHtml: new Map(),
    search: {
      filtering: false,
      matches: [],
      activeMatch: undefined,
      activeRow: undefined,
      position: 0,
      total: 0,
    },
    moreAbove: false,
    loadingOlder: false,
    loadOlder: noop,
    sessionId: asSessionId('turn-line'),
    cwd: '/r',
    session: undefined,
    httpOrigin: 'http://x',
    openFile: noop,
    onOpenImage: noop,
    onAnswerAsk: async () => {},
    livePendingAskIndex: -1,
    pendingAskBlock: null,
    lastAnswerBlockIndex: -1,
    collapseContext: false,
    stickyEnabled: false,
    isOperatorPromptRow: (row) =>
      row.kind === 'block' &&
      row.block.item.role === 'user' &&
      !row.block.item.event &&
      !transcriptActivityFacts(row.block.item).envelopes,
    onRetractQueued: async () => {},
    attribution: {} as never,
    activity: { tone: 'working', label: 'Working' },
    ...extra,
  }
  act(() => root.render(<TranscriptFeed {...props} />))
}
const line = () => host.querySelector<HTMLElement>('[data-testid="turn-line"]')!
const toggle = () => act(() => line().querySelector<HTMLButtonElement>(':scope > button')!.click())

it('keeps narration on the page and names the call in flight on one live line', () => {
  render([prompt, say('intro', 'Checking now.')])
  expect(host.querySelector('[data-testid="turn-line"]')).toBeNull()
  expect(host.querySelector('[data-row-key="intro"] .chat-md')?.textContent).toContain(
    'Checking now.',
  )
  render([prompt, say('intro', 'Checking now.'), call('cmd')])
  const original = line()
  expect(original.dataset.open).toBe('false')
  expect(original.dataset.state).toBe('live')
  expect(original.querySelector('.tl-current')?.textContent).toBe('bun run test')
  // Named once: the label already is the call in flight.
  expect(
    original.querySelector(':scope > button')?.textContent?.match(/bun run test/g),
  ).toHaveLength(1)
  expect(host.querySelector('[data-row-key="intro"] .chat-md')?.textContent).toContain(
    'Checking now.',
  )
  expect(host.querySelector('[data-testid="feed-tail"]')).toBeNull()
  expect(host.querySelector('[data-testid="feed-tail-inline"]')).not.toBeNull()
  expect(host.querySelectorAll('.pod-mark')).toHaveLength(1)
  render([prompt, say('intro', 'Checking now.'), call('cmd', 'green'), say('next', 'All green.')])
  expect(line()).toBe(original)
  expect(line().dataset.state).toBe('done')
  expect(line().querySelector('.tl-current')?.textContent).toBe('bun run test')
  expect(host.querySelector('[data-row-key="next"] .chat-md')?.textContent).toContain('All green.')
  expect(line().querySelector('[data-row-key="next"]')).toBeNull()
})

it('keeps the flat opened list, member disclosure and selection when work appends and settles', async () => {
  const items = [prompt, say('intro'), call('first', 'ok'), call('cmd', 'green')]
  render(items)
  toggle()
  const original = line()
  expect(host.querySelectorAll('.turn-list .work-line-list')).toHaveLength(0)
  const tool = host.querySelector('[data-row-key="cmd"] .tool-block')!
  act(() => tool.querySelector<HTMLButtonElement>('button')!.click())
  const body = tool.querySelector('.tool-result-full')!
  const text = body.firstChild!
  const range = document.createRange()
  range.selectNodeContents(text)
  document.getSelection()!.addRange(range)
  const selected = document.getSelection()!.toString()
  render([...items, call('next', 'done'), say('answer', 'Ready.', true)], { activity: null })
  expect(line()).toBe(original)
  expect(line().dataset.open).toBe('true')
  expect(host.querySelector('[data-row-key="cmd"] .tool-result-full')).toBe(body)
  expect(document.getSelection()!.toString()).toBe(selected)
  expect(host.querySelector('[data-row-key="answer"]')?.textContent).toContain('Ready.')
  // The retiring mark only lives through its approved crossfade.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220))
  })
  expect(host.querySelectorAll('.pod-mark')).toHaveLength(0)
  document.getSelection()!.removeAllRanges()
})

it('preserves an opened pre-work note outside a new line when a command joins its row', () => {
  render([prompt, note()])
  act(() => host.querySelector<HTMLButtonElement>('.mail-item-head')!.click())
  const body = host.querySelector('.mail-item-body')
  render([prompt, note(), call('cmd')])
  expect(host.querySelector('.mail-item-body')).toBe(body)
  expect(line().dataset.open).toBe('false')
  expect(host.querySelector('.mail-item')).not.toBe(line().querySelector('.mail-item'))
})

it('keeps a singleton output well deliberately opened through the outer line when another event joins', () => {
  const items = [prompt, call('cmd', 'green')]
  render(items, { activity: null })
  toggle()
  const body = host.querySelector('.tool-result-full')!
  expect(body.textContent).toBe('green')
  const range = document.createRange()
  range.selectNodeContents(body)
  document.getSelection()!.addRange(range)
  render([...items, call('next')])
  expect(host.querySelector('[data-row-key="cmd"] .tool-result-full')).toBe(body)
  expect(document.getSelection()!.toString()).toBe('green')
  const entry = host.querySelector('.turn-entry[data-row-key="cmd"]')!
  act(() => entry.querySelector<HTMLButtonElement>('button')!.click())
  expect(entry.querySelector('.tool-result-full')).toBeNull()
  document.getSelection()!.removeAllRanges()
})

it('keeps operator Reply notes outside and repeats them as ordinary notes in chronology', () => {
  const items = [prompt, call('first', 'done'), note(true), call('cmd')]
  render(items)
  expect(host.querySelectorAll('.quiet-ask')).toHaveLength(1)
  toggle()
  expect(line().querySelector('.quiet-ask')).toBeNull()
  expect(line().querySelector('.mail-item')).not.toBeNull()
  render([...items, say('answer', 'Done.', true)], { activity: null })
  expect(host.querySelectorAll('.quiet-ask')).toHaveLength(1)
})

it('opens only the addressed result for search and drops forced expansion when search moves away', () => {
  const items = [
    prompt,
    say('intro', 'Checking'),
    call('one', 'first'),
    call('two', 'second'),
    say('answer', 'Done', true),
  ]
  render(items, {
    activity: null,
    searchQuery: 'Checking',
    search: {
      filtering: true,
      matches: [1, 3],
      activeMatch: 3,
      activeRow: 2,
      position: 0,
      total: 2,
    },
  })
  expect(line().dataset.open).toBe('true')
  expect(line().querySelectorAll('.tool-result-full')).toHaveLength(1)
  expect(line().querySelector('.tool-result-full')?.textContent).toBe('second')
  render(items, { activity: null })
  expect(line().dataset.open).toBe('false')
  expect(line().querySelector('.turn-entry')).toBeNull()
})

it('streams text below a live line and lands it as its own row, outside the fold', () => {
  const preview: TurnPreview = {
    turnEpoch: 1,
    items: [{ kind: 'text', itemId: 'stream', text: 'Checking now.' }],
  }
  render([prompt, call('cmd', 'green')], { turnPreview: preview })
  const original = line()
  expect(original.querySelector('.tl-current')?.textContent).toBe('bun run test')
  expect(host.querySelector('[data-turn-preview]')?.textContent).toContain('Checking now.')
  toggle()
  expect(line().textContent).not.toContain('Checking now.')
  render([prompt, call('cmd', 'green'), say('stream', 'Checking now.')], { turnPreview: null })
  expect(line()).toBe(original)
  expect(line().dataset.state).toBe('done')
  expect(line().textContent).not.toContain('Checking now.')
  expect(host.querySelector('[data-row-key="stream"] .chat-md')?.textContent).toContain(
    'Checking now.',
  )
})

it('pauses at an interactive card, settles that seam on answer, and starts a new line', () => {
  const ask: TranscriptItem = {
    ...call('ask'),
    toolName: 'AskUserQuestion',
    ts: new Date(Date.parse(ts) + 100000).toISOString(),
    toolInputJson: JSON.stringify({
      questions: [
        {
          question: 'Which branch?',
          header: 'Branch',
          options: [
            { label: 'main', description: 'Use main' },
            { label: 'dev', description: 'Use dev' },
          ],
        },
      ],
    }),
  }
  const items = [prompt, say('intro', 'Checking the branch.'), call('cmd', 'green'), ask]
  render(items, { activity: { tone: 'attention', label: 'needs answer' }, livePendingAskIndex: 3 })
  expect(line().dataset.state).toBe('paused')
  expect(line().querySelector('.tl-current')?.textContent).toBe('bun run test')
  expect(host.querySelector('[data-row-key="intro"] .chat-md')?.textContent).toContain(
    'Checking the branch.',
  )
  expect(line().querySelector('.asked-you')).toBeNull()
  expect(host.querySelector('[data-testid="feed-tail"]')?.textContent).toContain(
    'Waiting for your answer',
  )
  const first = line()
  toggle()
  render([
    ...items.slice(0, -1),
    { ...ask, toolResult: 'main' },
    say('resumed', 'Using main.'),
    call('next'),
  ])
  expect(host.querySelectorAll('[data-testid="turn-line"]')).toHaveLength(2)
  expect(line()).toBe(first)
  expect(first.dataset.open).toBe('true')
  expect(first.dataset.state).toBe('done')
  expect(first.querySelector('.tl-current')?.textContent).toBe('bun run test')
  expect(first.querySelector('.tl-timer')).toBeNull()
})

it('names a settled run by its harness summaries, else by its subjects', () => {
  const commands = Array.from({ length: 5 }, (_, n) => call(`command-${n}`, 'green'))
  const read: TranscriptItem = {
    ...call('read', 'contents'),
    toolName: 'Read',
    toolInput: '/repo/file.ts',
  }
  const plain = [prompt, say('intro', 'Checking now.'), ...commands, read, note()]
  render([...plain, say('answer', 'Ready.', true)], { activity: null })
  const named = buildChatRows(pairToolResults(plain)).find((row) => row.kind === 'tools')!
  expect(named.kind === 'tools' && named.title).toBeTruthy()
  expect(line().querySelector('.tl-current')?.textContent).toBe(
    named.kind === 'tools' ? named.title : '',
  )
  expect(line().querySelector('.tl-counts')).toBeNull()
  const summary = (id: string, text: string, ids: string[]): TranscriptItem => ({
    id,
    role: 'system',
    systemKind: 'tool-summary',
    text,
    summarizes: ids,
    ts,
  })
  // A harness's calls and results are separate records paired by toolUseId.
  const paired = (item: TranscriptItem): TranscriptItem[] => [
    { ...item, toolResult: undefined, toolUseId: item.id },
    { id: `${item.id}-r`, role: 'tool', text: '', toolUseId: item.id, toolResult: 'ok', ts },
  ]
  render(
    [
      prompt,
      say('intro', 'Checking now.'),
      ...commands.flatMap(paired),
      summary(
        's1',
        'Ran the test suite',
        commands.map((item) => item.id),
      ),
      ...paired(read),
      summary('s2', 'Read file.ts', ['read']),
      say('answer', 'Ready.', true),
    ],
    { activity: null },
  )
  expect(line().querySelector('.tl-current')?.textContent).toBe('Ran the test suite · Read file.ts')
  expect(line().querySelector(':scope > button')?.getAttribute('aria-label')).toContain(
    'Ran the test suite · Read file.ts',
  )
  expect(host.textContent).not.toContain('System')
})

it('keeps the command glyph on a live opened entry and uses work duration units', () => {
  render([prompt, say('intro', 'Checking now.'), call('cmd')])
  toggle()
  const command = host.querySelector('.turn-entry[data-row-key="cmd"] .tool-block')!
  expect(command.getAttribute('data-state')).toBe('live')
  expect(command.querySelector('.work-line-glyph .lucide-terminal')).not.toBeNull()
  expect(command.querySelector('.work-line-glyph .pod-mark')).toBeNull()
  expect(command.querySelector('.work-line-time')?.textContent).toMatch(
    /(?:\d+s|\d+m \d{2}s|\d+h \d{2}m)/,
  )
  expect(line().querySelector('.tl-timer')?.textContent).not.toContain(':')
})

it('settles a failed run with a separate error tail and an interrupted one beside its narration', () => {
  const items = [prompt, say('intro', 'Checking now.'), call('cmd', 'error: failed')]
  render(items, { activity: { tone: 'error', label: 'rate limited' } })
  expect(line().dataset.state).toBe('failed')
  expect(line().querySelector('.tl-current')?.textContent).toContain('Failed')
  expect(host.querySelector('[data-testid="feed-tail"]')?.textContent).toContain(
    'Agent stopped with an error',
  )
  render(
    [
      ...items,
      say('latest', 'Trying the next file.'),
      { id: 'stop', role: 'user', event: 'interrupt', text: '', ts },
    ],
    { activity: { tone: 'note', label: 'interrupted' } as never },
  )
  expect(line().dataset.state).toBe('stopped')
  expect(host.querySelector('[data-row-key="latest"] .chat-md')?.textContent).toContain(
    'Trying the next file.',
  )
  expect(host.querySelector('.turn-list [data-row-key="latest"]')).toBeNull()
})

it('restamps a Grok narration into the answer without leaving stale phrase text behind', () => {
  const items = [
    prompt,
    say('intro', 'Checking now.'),
    call('cmd', 'green'),
    say('final', 'The result is ready.'),
  ]
  render(items)
  const original = line()
  expect(original.querySelector('.tl-current')?.textContent).toBe('bun run test')
  expect(host.querySelector('[data-row-key="final"] .chat-md')?.textContent).toContain(
    'The result is ready.',
  )
  render([...items.slice(0, -1), say('final', 'The result is ready.', true)], { activity: null })
  expect(line()).toBe(original)
  expect(line().querySelector('.tl-current')?.textContent).not.toContain('The result is ready.')
  expect(host.querySelector('[data-row-key="final"] .chat-md')?.textContent).toContain(
    'The result is ready.',
  )
  expect(host.querySelector('[data-row-key="final"]')?.closest('.tl-answer')).not.toBeNull()
})

it('keeps unchanged opened narration cold on append, and still reads a live text edit', () => {
  const items = [prompt, say('intro', 'An unchanged narration.'), call('cmd', 'done')]
  const graph = new TranscriptGraph(items)
  disposals.push(() => graph.dispose())
  const presentation = {
    block: (id: string) => graph.block(id),
    run: (id: string) => graph.run(id),
    rowMatches: () => false,
    tailRow: (row: unknown) => row,
  }
  const chat = {
    view: { presentation, pending: [], preview: null, session: undefined, activity: null },
  } as never
  const stable = {
    chat,
    expandRuns: true,
    activity: null,
    onAnswerAsk: async () => {},
    markdownHtml: new Map<string, string>(),
  }
  render(items, { ...stable, rows: graph.structuralRows.map((row, index) => ({ row, index })) })
  const before = host.querySelector('[data-row-key="intro"] .chat-md')!
  const spy = vi.spyOn(markdown, 'renderMarkdown')
  const next = call('next', 'done')
  act(() => graph.apply({ changed: [next], insertions: [{ id: next.id }] }))
  render([...items, next], {
    ...stable,
    rows: graph.structuralRows.map((row, index) => ({ row, index })),
  })
  expect(spy.mock.calls.some(([text]) => text === 'An unchanged narration.')).toBe(false)
  expect(host.querySelector('[data-row-key="intro"] .chat-md')).toBe(before)
  act(() => graph.apply({ changed: [{ ...items[1]!, text: 'An edited narration.' }] }))
  expect(before.textContent).toContain('An edited narration.')
  spy.mockRestore()
})

it('counts matching blocks within one activity row', () => {
  render(
    [
      prompt,
      say('intro'),
      call('one', 'needle'),
      call('two', 'needle'),
      say('answer', 'Done', true),
      { ...prompt, id: 'next-prompt' },
      say('next-answer', 'needle elsewhere', true),
    ],
    {
      activity: null,
      search: {
        filtering: true,
        matches: [2, 3, 6],
        activeMatch: 6,
        activeRow: 5,
        position: 3,
        total: 3,
      },
    },
  )
  expect(line().dataset.open).toBe('false')
  expect(line().querySelector('.tl-hits')?.textContent).toBe('2 hits')
})

it('retains the live line and selected note DOM when a turn crosses the source and item windows', async () => {
  const client = {
    usesWorker: false,
    computeGraphOnMain(
      source: { sent(): void; graph: { search(q: string, n: number): unknown } },
      q: string,
      n: number,
    ) {
      source.sent()
      return { search: source.graph.search(q, n), markdownHtml: new Map() }
    },
    forgetGraph() {},
  }
  const presentation = new ConversationPresentation(client as never)
  // Text-less assistant records stay inside the run as rows of their own;
  // narration with text would end it (POD-6258).
  const updates = (start: number, count: number): TranscriptItem[] =>
    Array.from({ length: count }, (_, at) => ({
      ...say(`long-${start + at}`, ''),
      cursor: `cursor-${start + at}`,
    }))
  const items = [
    { ...prompt, cursor: 'prompt-cursor' },
    note(),
    call('first', 'done'),
    ...updates(0, 297),
  ]
  const log: TranscriptLog = new TranscriptLog({
    sessionId: asSessionId('long-dom'),
    source: { read: async () => ({ items: log.items, hasMore: false }), subscribe: () => () => {} },
    cache: fakeTranscriptCache({ items, savedAt: 1 }),
    retainHistory: () => presentation.retainHistory,
    retainFrom: () => presentation.retainFrom,
    onChange: (change) => presentation.changed(change),
  })
  await storedReadSettled()
  presentation.bind(log)
  disposals.push(() => {
    presentation.dispose()
    log.dispose()
  })
  const chat = {
    view: {
      presentation,
      pending: [],
      preview: null,
      activity: { tone: 'working', label: 'Working' },
      session: undefined,
    },
  } as never
  const paint = () => render(log.items, { chat, rows: presentation.renderRows(false, false) })
  paint()
  toggle()
  const owner = line()
  act(() => host.querySelector<HTMLButtonElement>('.mail-item-head')!.click())
  const body = host.querySelector('.mail-item-body')!
  const range = document.createRange()
  range.selectNodeContents(body)
  document.getSelection()!.addRange(range)
  const selected = document.getSelection()!.toString()
  act(() => log.merge(updates(297, 160)))
  paint()
  expect(line()).toBe(owner)
  expect(line().dataset.open).toBe('true')
  expect(presentation.turnFolds.trailing?.key).toBe(`${prompt.id}:work`)
  expect(presentation.turnFolds.trailing?.members.length).toBeGreaterThan(450)
  expect(host.querySelector('.mail-item-body')).toBe(body)
  expect(document.getSelection()!.toString()).toBe(selected)
  act(() => log.merge([{ ...say('answer', 'Ready.', true), cursor: 'answer-cursor' }]))
  paint()
  expect(line()).toBe(owner)
  expect(line().dataset.open).toBe('true')
  expect(host.querySelector('.mail-item-body')).toBe(body)
  expect(document.getSelection()!.toString()).toBe(selected)
  document.getSelection()!.removeAllRanges()
})
