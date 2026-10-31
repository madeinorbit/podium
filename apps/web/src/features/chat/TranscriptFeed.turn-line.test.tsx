import './test-support/no-message-attachments'
import type { TurnPreview } from '@podium/client-core/conversation'
import { buildChatRows, pairToolResults, transcriptActivityFacts } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TranscriptFeed, type TranscriptFeedProps } from './TranscriptFeed'

vi.mock('./mail-body', () => ({
  useMailBody: () => ({ status: 'ready', body: 'Status\nI am reading this body.' }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
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

it('starts on one closed line, updates narration in place, and keeps status after a result', () => {
  render([prompt, say('intro', 'Checking now.')])
  const original = line()
  expect(original.querySelector('.tl-current')?.textContent).toBe('Checking now.')
  expect(original.dataset.open).toBe('false')
  expect(host.querySelector('.chat-md')?.textContent?.trim()).toBe('Check it')
  expect(host.querySelector('[data-testid="feed-tail"]')).toBeNull()
  expect(host.querySelector('[data-testid="feed-tail-inline"]')).not.toBeNull()
  expect(host.querySelectorAll('.pod-mark')).toHaveLength(1)
  render([prompt, say('intro', 'Checking now.'), call('cmd'), say('next', 'Running the checks.')])
  expect(line()).toBe(original)
  expect(line().querySelector('.tl-current')?.textContent).toBe('Running the checks.')
  expect(line().querySelector('.tl-now')?.textContent).toBe('bun run test')
  render([
    prompt,
    say('intro', 'Checking now.'),
    call('cmd', 'green'),
    say('next', 'Running the checks.'),
  ])
  expect(line()).toBe(original)
  expect(host.querySelectorAll('.pod-mark')).toHaveLength(1)
  expect(line().querySelector('.tl-now')?.textContent).toBe('')
})

it('keeps the flat opened list, member disclosure and selection when work appends and settles', async () => {
  const items = [prompt, say('intro'), call('cmd', 'green')]
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
  const items = [prompt, say('intro'), note(true), call('cmd')]
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

it('uses the same line and opened text node when preview characters become durable narration', () => {
  const preview: TurnPreview = {
    turnEpoch: 1,
    items: [{ kind: 'text', itemId: 'stream', text: 'Checking now.' }],
  }
  render([prompt], { turnPreview: preview })
  const original = line()
  expect(original.querySelector('.tl-current')?.textContent).toBe('Checking now.')
  toggle()
  const body = host.querySelector('.turn-entry .chat-md')
  render([prompt], {
    turnPreview: {
      ...preview,
      items: [{ kind: 'text', itemId: 'stream', text: 'Checking next.' }],
    },
  })
  expect(line()).toBe(original)
  expect(line().querySelector('.tl-current')?.textContent).toBe('Checking next.')
  render([prompt, say('stream', 'Checking next.')], { turnPreview: null })
  expect(line()).toBe(original)
  expect(line().dataset.open).toBe('true')
  expect(host.querySelector('.turn-entry .chat-md')).toBe(body)
  expect(host.querySelectorAll('.turn-entry')).toHaveLength(1)
})

it('pauses at an interactive card, settles that seam on answer, and starts a new line', () => {
  const ask: TranscriptItem = {
    ...call('ask'),
    toolName: 'AskUserQuestion',
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
  expect(line().querySelector('.tl-current')?.textContent).toBe('Checking the branch.')
  expect(line().querySelector('.asked-you')).toBeNull()
  expect(host.querySelector('[data-testid="feed-tail"]')?.textContent).toContain(
    'Waiting for your answer',
  )
  const first = line()
  toggle()
  render([...items.slice(0, -1), { ...ask, toolResult: 'main' }, say('resumed', 'Using main.')])
  expect(host.querySelectorAll('[data-testid="turn-line"]')).toHaveLength(2)
  expect(line()).toBe(first)
  expect(first.dataset.open).toBe('true')
  expect(first.dataset.state).toBe('done')
})

it('settles a failed turn with a separate error tail and an interrupted turn with a full-ink stand-in', () => {
  const items = [
    prompt,
    say('intro', 'Checking now.'),
    call('cmd', 'error: failed'),
    say('latest', 'Trying the next file.'),
  ]
  render(items, { activity: { tone: 'error', label: 'rate limited' } })
  expect(line().dataset.state).toBe('failed')
  expect(line().querySelector('.tl-current')?.textContent).toContain('Failed')
  expect(host.querySelector('[data-testid="feed-tail"]')?.textContent).toContain(
    'Agent stopped with an error',
  )
  render([...items, { id: 'stop', role: 'user', event: 'interrupt', text: '', ts }], {
    activity: { tone: 'note', label: 'interrupted' } as never,
  })
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
  expect(original.querySelector('.tl-current')?.textContent).toBe('The result is ready.')
  render([...items.slice(0, -1), say('final', 'The result is ready.', true)], { activity: null })
  expect(line()).toBe(original)
  expect(line().querySelector('.tl-current')?.textContent).not.toContain('The result is ready.')
  expect(host.querySelector('[data-row-key="final"] .chat-md')?.textContent).toContain(
    'The result is ready.',
  )
  expect(host.querySelector('[data-row-key="final"]')?.closest('.tl-answer')).not.toBeNull()
})
