import './test-support/no-message-attachments'
import type { HeadlessOverlay } from '@podium/client-core/conversation'
import type { RenderableRow } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatRows, pairToolResults } from './chat'
import { TranscriptFeed } from './TranscriptFeed'

vi.mock('./mail-body', () => ({
  useMailBody: () => ({ status: 'ready', body: 'Status\nI am reading this body.' }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// FEED MOTION (POD-423), end to end through the feed: which rows carry
// `.transcript-arrive` when, and whether in-progress text carries its caret.
// The arrival rules themselves live in use-feed-arrivals.test.ts; what this
// pins is the wiring — that the hook's answer reaches the row, and that opening
// a transcript animates NOTHING.

let host: HTMLDivElement
let root: Root

const say = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text, answer: true }) as TranscriptItem

function rowsFor(items: TranscriptItem[]): RenderableRow[] {
  return buildChatRows(pairToolResults(items)).map((row, index) => ({
    row,
    index,
    ...(row.kind === 'block' ? { blockIndex: row.blockIndex } : {}),
  })) as RenderableRow[]
}

function render(
  items: TranscriptItem[],
  overlay: HeadlessOverlay | null = null,
  opts: {
    phase?: 'loading' | 'empty' | 'ready'
    moreAbove?: boolean
    loadingOlder?: boolean
    activeRow?: number
  } = {},
): void {
  const blocks = pairToolResults(items)
  act(() => {
    root.render(
      <TranscriptFeed
        setScrollerRef={() => {}}
        setContentRef={() => {}}
        onScroll={() => {}}
        onPointerUp={() => {}}
        compact={false}
        superagent={false}
        phase={opts.phase ?? 'ready'}
        rows={rowsFor(items)}
        blocks={blocks}
        markdownHtml={new Map()}
        search={
          {
            activeRow: opts.activeRow ?? -1,
            filtering: false,
            matches: [],
            activeMatch: 0,
          } as never
        }
        moreAbove={opts.moreAbove ?? false}
        loadingOlder={opts.loadingOlder ?? false}
        loadOlder={() => {}}
        sessionId={asSessionId('s1')}
        cwd="/r"
        session={undefined}
        httpOrigin="http://x"
        openFile={() => {}}
        onOpenImage={() => {}}
        onAnswerAsk={async () => {}}
        livePendingAskIndex={-1}
        pendingAskBlock={null}
        lastAnswerBlockIndex={-1}
        ctxSeq={null}
        collapseContext={false}
        stickyEnabled={false}
        isOperatorPromptRow={() => false}
        pending={[]}
        onRetractQueued={async () => {}}
        overlay={overlay}
        turnPreview={null}
        activity={null}
        attribution={{} as never}
      />,
    )
  })
}

const arriving = (): string[] =>
  [...host.querySelectorAll('.transcript-arrive')].map((el) => el.textContent ?? '')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('TranscriptFeed — arrival', () => {
  it('animates nothing on first paint — an opened transcript is history', () => {
    render([say('a', 'one'), say('b', 'two'), say('c', 'three')])
    expect(arriving()).toEqual([])
  })

  it('animates only the row that landed', () => {
    const held = [say('a', 'one'), say('b', 'two')]
    render(held)
    const first = [...host.querySelectorAll('[data-block]')][0]
    render([...held, say('c', 'three')])
    expect(arriving()).toHaveLength(1)
    expect(arriving()[0]).toContain('three')
    // Appending a sibling must not replace settled message DOM. This is what
    // keeps selection, focus, and native scroll anchoring intact.
    expect([...host.querySelectorAll('[data-block]')][0]).toBe(first)
  })

  it('holds the marker while the row stays mounted, so the one-shot is never cut short', () => {
    const held = [say('a', 'one')]
    render(held)
    const grown = [...held, say('b', 'two')]
    render(grown)
    // A re-render that changes nothing else — a transcript poll, a timer tick —
    // must not strip the class mid-animation and snap the row to its rest state.
    render([...grown, say('c', 'three')])
    expect(arriving().join(' ')).toContain('two')
    expect(arriving().join(' ')).toContain('three')
  })

  it('animates nothing when older messages are paged in above', () => {
    const held = [say('c', 'three'), say('d', 'four')]
    render(held)
    render([say('a', 'one'), say('b', 'two'), ...held])
    expect(arriving()).toEqual([])
  })

  it('retains the message element when a prepend removes its leading day mark', () => {
    const first = { ...say('first', 'retained message'), ts: '2026-01-02T09:00:00Z' }
    render([first])
    const element = host.querySelector('[data-row-key="first"]')
    expect(element).not.toBeNull()
    expect(host.querySelectorAll('.transcript-daymark')).toHaveLength(1)
    render([{ ...say('older', 'older message'), ts: '2026-01-02T08:00:00Z' }, first])
    expect(host.querySelector('[data-row-key="first"]')).toBe(element)
  })

  it('animates nothing when the transcript is replaced wholesale', () => {
    render([say('a', 'one'), say('b', 'two')])
    render([say('x', 'other'), say('y', 'session')])
    expect(arriving()).toEqual([])
  })
})

describe('TranscriptFeed — the streaming caret', () => {
  const streaming = (): Element | null => host.querySelector('[data-testid="streaming-text"]')

  it('marks in-progress text so it can carry a caret', () => {
    render([say('a', 'one')], { text: 'half a thou' })
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="turn-line"] > button')!.click())
    expect(streaming()?.querySelector('.chat-md')?.className).toContain('chat-md--streaming')
  })

  it('leaves settled transcript text unmarked — only the overlay is in progress', () => {
    render([say('a', 'one')])
    expect(streaming()).toBeNull()
    expect(host.querySelector('.chat-md--streaming')).toBeNull()
  })

  it('carries no caret when the driver is only reporting status', () => {
    render([say('a', 'one')], { status: 'running Bash…' })
    expect(streaming()).toBeNull()
    expect(host.querySelector('[data-testid="feed-tail"]')?.textContent).toContain('running Bash')
  })
})

describe('TranscriptFeed — boundary states', () => {
  // A state that RESOLVES into content and one that never will must not be the
  // same object (POD-700). Loading is the feed's own geometry, unfilled; empty
  // is the standby question. Both sit on the composer (POD-746).
  it('shows the cold transcript while loading and the standby question only when empty', () => {
    render([], null, { phase: 'loading' })
    const cold = host.querySelector('[data-testid="transcript-cold"]')
    expect(cold).not.toBeNull()
    // The prompt's carved container is reproduced, so the read lands into the
    // layout already on screen rather than displacing it.
    expect(cold?.querySelectorAll('.transcript-cold-prompt').length).toBe(4)
    expect(cold?.querySelectorAll('.transcript-cold-line').length).toBeGreaterThan(4)
    // Never the empty state's object, and never a spinner.
    expect(host.querySelector('[data-testid="transcript-empty-state"]')).toBeNull()
    expect(host.querySelector('.transcript-standby-ask')).toBeNull()
    expect(host.querySelector('.pod-mark')).toBeNull()
    // Bottom-anchored like the conversation it stands in for: the scrollport
    // takes the same auto-margin spacer `ready` uses, and does not centre.
    expect(host.querySelector('.mt-auto')).not.toBeNull()
    expect(host.querySelector('.justify-center')).toBeNull()

    render([], null, { phase: 'empty' })
    expect(host.querySelector('[data-testid="transcript-empty-state"]')).not.toBeNull()
    expect(host.querySelector('.transcript-standby-ask')?.textContent).toContain(
      'What do you want to work on?',
    )
    expect(host.querySelector('[data-testid="transcript-cold"]')).toBeNull()
    // The question is asked ON the composer, not centred in the void above it.
    expect(host.querySelector('.mt-auto')).not.toBeNull()
    expect(host.querySelector('.justify-center')).toBeNull()
    expect(host.querySelector('.pod-mark')).toBeNull()
  })

  // The shape carries the state visually; assistive tech is told in words, and
  // is not made to wait out the 180ms/1.2s reveal delays the sighted path uses.
  it('announces the cold read immediately, without waiting for its reveal', () => {
    render([], null, { phase: 'loading' })
    const cold = host.querySelector('[data-testid="transcript-cold"]')
    expect(cold?.getAttribute('role')).toBe('status')
    expect(cold?.getAttribute('aria-busy')).toBe('true')
    expect(cold?.querySelector('.sr-only')?.textContent).toBe('Loading transcript')
    // The slots themselves are decoration for a screen reader — the words above
    // already said it, and a reader walking eleven empty runs learns nothing.
    for (const turn of cold?.querySelectorAll('.transcript-cold-turn') ?? [])
      expect(turn.getAttribute('aria-hidden')).toBe('true')
  })

  /**
   * THE FEED IS A NAMED BOX (POD-993 round 4). A work-line preview is portalled,
   * so its collision boundary defaults to the VIEWPORT — which does not stop
   * where the transcript does, and a tall panel low in a short pane rendered
   * straight over the composer. WorkLinePreview finds this box by attribute and
   * hands it to the positioner; without the attribute the lookup silently
   * returns nothing and the overlap comes back, with no test failing.
   */
  it('names its scroller so a portalled overlay knows what to stay inside', () => {
    render([say('a', 'one')])
    const scroller = host.querySelector('[data-feed-scroller]')
    expect(scroller).not.toBeNull()
    expect(scroller?.querySelector('.transcript-row')).not.toBeNull()
  })

  it('names scroll-back paging and keeps the loading affordance in place', () => {
    render([say('a', 'one')], null, { moreAbove: true })
    expect(host.querySelector('.transcript-pager')?.textContent).toContain('Earlier transcript')
    expect(host.querySelector('.transcript-pager')?.textContent).toContain('click to retry')

    render([say('a', 'one')], null, { moreAbove: true, loadingOlder: true })
    expect(host.querySelector('.transcript-pager')?.textContent).toContain('loading')
    expect(host.querySelector('.transcript-pager .pod-mark')).toBeNull()
  })
})

it('keeps a lone note addressed by its own key and gives a mixed stretch just one feed tick', () => {
  const note: TranscriptItem = {
    id: 'note',
    role: 'user',
    text: '[podium message msg_key · from system:steward · to issue:POD-2287]\nStatus\nDetail\n[end podium message msg_key]',
  }
  render([note])
  expect(host.querySelectorAll('[data-block]')).toHaveLength(1)
  expect(host.querySelector('[data-row-key="note"]')).not.toBeNull()
  expect(host.querySelector('[data-transcript-run-view]')).toBeNull()
  const command: TranscriptItem = {
    id: 'cmd',
    role: 'tool',
    text: '',
    toolName: 'Bash',
    toolInput: 'git status',
    toolResult: 'clean',
  }
  render([command, note])
  expect(host.querySelectorAll('[data-block]')).toHaveLength(1)
  expect(host.querySelector('[data-row-key="cmd"]')).not.toBeNull()
  expect(
    JSON.parse(host.querySelector('[data-row-aliases]')?.getAttribute('data-row-aliases') ?? '[]'),
  ).toEqual(['cmd', 'note'])
})

const openNote: TranscriptItem = {
  id: 'note',
  role: 'user',
  text: '[podium message msg_live · from issue:POD-2242 · to issue:POD-2287]\nStatus\nI am reading this body.\n[end podium message msg_live]',
}
const appendedCommand: TranscriptItem = {
  id: 'new-command',
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: 'git status',
  toolResult: 'clean',
}

it.each([
  { label: 'received note', item: openNote, button: '.mail-item-head', body: '.mail-item-body' },
  {
    label: 'sent note',
    item: {
      id: 'sent',
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolInput: "podium mail send --to POD-2242 --body 'Status'",
      toolResult: 'sent msg_sent to POD-2242 (delivered)',
    } as TranscriptItem,
    button: '.mail-item-head',
    body: '.mail-item-body',
  },
  {
    label: 'inbox read',
    item: {
      id: 'inbox',
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolInput: 'podium mail inbox',
      toolResult: '* msg_live issue:POD-2242 2026-10-28T17:00:00Z\n  I am reading this body.',
    } as TranscriptItem,
    button: '.mail-fold',
    body: '.tool-result-full',
  },
])('retains a deliberately opened $label, its DOM and selection when a command joins and leaves', ({
  item,
  button,
  body,
}) => {
  render([item])
  const turn = host.querySelector<HTMLButtonElement>('[data-testid="turn-line"] > button')
  if (turn) act(() => turn.click())
  const original = host.querySelector(`[data-row-key="${item.id}"]`)
  const toggle = host.querySelector<HTMLButtonElement>(button)!
  if (!host.querySelector(body)) act(() => toggle.click())
  const content = host.querySelector<HTMLElement>(body)!
  expect(content.textContent).toContain('I am reading this body.')
  const text = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 6)
  document.getSelection()!.addRange(range)
  const selected = document.getSelection()!.toString()
  try {
    render([item, appendedCommand])
    expect(host.querySelector(`[data-row-key="${item.id}"]`)).toBe(original)
    expect(host.querySelector(body)).toBe(content)
    expect(document.getSelection()!.toString()).toBe(selected)
    expect(host.querySelector(button)).toBe(toggle)
    expect(host.querySelector('[data-transcript-run-toggle]')?.getAttribute('aria-expanded')).toBe(
      item.role === 'user' ? 'false' : 'true',
    )
    render([item])
    expect(host.querySelector(body)).toBe(content)
    expect(document.getSelection()!.toString()).toBe(selected)
  } finally {
    document.getSelection()!.removeAllRanges()
  }
})

it('keeps an explicitly reopened search note when the search closes and its stretch grows', () => {
  render([openNote], null, { activeRow: 0 })
  act(() => host.querySelector<HTMLButtonElement>('.mail-item-head')!.click())
  const content = host.querySelector('.mail-item-body')
  render([openNote, appendedCommand])
  expect(host.querySelector('.mail-item-body')).toBe(content)
  expect(host.querySelector('[data-transcript-retain]')).not.toBeNull()
})

it('folds a growing stretch after the reader closes the lone note', () => {
  render([openNote])
  act(() => host.querySelector<HTMLButtonElement>('.mail-item-head')!.click())
  act(() => host.querySelector<HTMLButtonElement>('.mail-item-head')!.click())
  render([openNote, appendedCommand])
  expect(host.querySelector('.mail-item-body')).toBeNull()
  expect(host.querySelector('[data-transcript-run-toggle]')?.getAttribute('aria-expanded')).toBe(
    'false',
  )
})

it('retains an opened envelope when another envelope extends the same transcript item', () => {
  render([openNote])
  act(() => host.querySelector<HTMLButtonElement>('.mail-item-head')!.click())
  const content = host.querySelector('.mail-item-body')
  render([
    {
      ...openNote,
      text: `${openNote.text}\n[podium message msg_next · from system:steward · to your session]\nAnother note\n[end podium message msg_next]`,
    },
  ])
  expect(host.querySelector('.mail-item-body')).toBe(content)
  expect(host.textContent).toContain('I am reading this body.')
})

it('allows windowing to release a lone note opened only by search', () => {
  render([openNote], null, { activeRow: 0 })
  expect(host.querySelector('.mail-item-body')).not.toBeNull()
  expect(host.querySelector('[data-transcript-retain]')).toBeNull()
  expect(host.querySelector('[data-open="true"]:not([data-transcript-run-view])')).toBeNull()
  expect(host.querySelector('[aria-expanded="true"]:not([data-transcript-run-toggle])')).toBeNull()
  render([openNote, appendedCommand])
  expect(host.querySelector('.mail-item-body')).toBeNull()
})
