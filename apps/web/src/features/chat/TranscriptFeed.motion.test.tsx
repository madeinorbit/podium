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
        claimScrollForArrival={() => {}}
        compact={false}
        superagent={false}
        phase={opts.phase ?? 'ready'}
        rows={rowsFor(items)}
        blocks={blocks}
        markdownHtml={new Map()}
        search={{ activeRow: -1, filtering: false, matches: [], activeMatch: 0 } as never}
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
        onRetractQueued={async () => {}}
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

// THE UNROLL NEEDS A HEIGHT, AND REFUSES TO GUESS ONE (POD-1158).
//
// Found in real WebKit against the running app, which is the only place it can
// be found: `offsetHeight` is zero for a row inside a `display: none` subtree,
// and this feed genuinely produces those, because the panel deck keeps
// inactive panes mounted and hidden. Stamping such a row is the worst outcome
// available — it would animate to `--arrive-h: 0px`, and an animation on a
// hidden element never runs and therefore never fires `animationend`, so the
// clip stays on forever. The reader switches to that pane and the message is
// simply not there.
describe('TranscriptFeed — the unroll', () => {
  const unrolling = (): Element[] => [...host.querySelectorAll('.transcript-row[data-unroll]')]

  /** jsdom lays nothing out, so the one number this hook depends on is given. */
  function withOffsetHeight(px: number, body: () => void): void {
    const proto = window.HTMLElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => px })
    try {
      body()
    } finally {
      if (original) Object.defineProperty(proto, 'offsetHeight', original)
      else delete (proto as unknown as Record<string, unknown>).offsetHeight
    }
  }

  it('opens an arriving row to its measured height', () => {
    withOffsetHeight(48, () => {
      const held = [say('a', 'one')]
      render(held)
      render([...held, say('b', 'two')])
      const rows = unrolling()
      expect(rows).toHaveLength(1)
      expect((rows[0] as HTMLElement).style.getPropertyValue('--arrive-h')).toBe('48px')
    })
  })

  it('refuses to clip a row it cannot measure — a hidden pane must not eat a message', () => {
    withOffsetHeight(0, () => {
      const held = [say('a', 'one')]
      render(held)
      render([...held, say('b', 'two')])
      // The row still counts as ARRIVED — the latch is unchanged — it simply
      // gets no clip and no animation, and so is visible the instant its pane
      // is shown.
      expect(arriving()).toHaveLength(1)
      expect(unrolling()).toEqual([])
    })
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
    expect(host.querySelector('.spb')).toBeNull()
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
    expect(host.querySelector('.spb')).toBeNull()
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
    expect(host.querySelector('.transcript-pager .spb')).toBeNull()
  })
})
