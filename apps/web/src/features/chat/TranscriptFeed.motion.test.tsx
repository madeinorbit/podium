import type { RenderableRow } from '@podium/client-core/viewmodels'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildChatRows, pairToolResults } from './chat'
import { TranscriptFeed } from './TranscriptFeed'
import type { HeadlessOverlay } from './use-headless-turn'

// FEED MOTION (POD-423), end to end through the feed: which rows carry
// `.transcript-arrive` when, and whether in-progress text carries its caret.
// The arrival rules themselves live in use-feed-arrivals.test.ts; what this
// pins is the wiring — that the hook's answer reaches the row, and that opening
// a transcript animates NOTHING.

let host: HTMLDivElement
let root: Root

const say = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text }) as TranscriptItem

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
  opts: { phase?: 'loading' | 'empty' | 'ready'; moreAbove?: boolean; loadingOlder?: boolean } = {},
): void {
  const blocks = pairToolResults(items)
  act(() => {
    root.render(
      <TranscriptFeed
        scrollerRef={createRef<HTMLDivElement>()}
        onScroll={() => {}}
        compact={false}
        phase={opts.phase ?? 'ready'}
        rows={rowsFor(items)}
        blocks={blocks}
        search={{ activeRow: -1, filtering: false, matches: [], activeMatch: 0 } as never}
        query=""
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
        lastAnswerBlockIndex={-1}
        ctxSeq={null}
        collapseContext={false}
        stickyEnabled={false}
        isOperatorPromptRow={() => false}
        pending={[]}
        restoredQueued={[]}
        overlay={overlay}
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
    render([...held, say('c', 'three')])
    expect(arriving()).toHaveLength(1)
    expect(arriving()[0]).toContain('three')
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
    expect(streaming()?.className).toContain('chat-md--streaming')
  })

  it('leaves settled transcript text unmarked — only the overlay is in progress', () => {
    render([say('a', 'one')])
    expect(streaming()).toBeNull()
    expect(host.querySelector('.chat-md--streaming')).toBeNull()
  })

  it('carries no caret when the driver is only reporting status', () => {
    render([say('a', 'one')], { status: 'running Bash…' })
    expect(streaming()).toBeNull()
  })
})

describe('TranscriptFeed — boundary states', () => {
  it('uses the shared calm machine-voice object for loading and empty', () => {
    render([], null, { phase: 'loading' })
    expect(host.textContent).toContain('Loading transcript')
    expect(host.querySelector('.transcript-placeholder-mark')).not.toBeNull()
    expect(host.querySelector('.spb')).toBeNull()

    render([], null, { phase: 'empty' })
    expect(host.querySelector('[data-testid="transcript-empty-state"]')).not.toBeNull()
    expect(host.textContent).toContain('No transcript yet')
    expect(host.querySelector('.spb')).toBeNull()
  })

  it('names scroll-back paging and keeps the loading affordance in place', () => {
    render([say('a', 'one')], null, { moreAbove: true })
    expect(host.querySelector('.transcript-pager')?.textContent).toContain('Earlier transcript')
    expect(host.querySelector('.transcript-pager')?.textContent).toContain('click to retry')

    render([say('a', 'one')], null, { moreAbove: true, loadingOlder: true })
    expect(host.querySelector('.transcript-pager')?.textContent).toContain('loading')
    expect(host.querySelector('.transcript-pager .spb')).toBeNull()
  })
})
