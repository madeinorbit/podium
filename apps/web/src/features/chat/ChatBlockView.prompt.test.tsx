import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

// THE BRIEF IS NEVER CUT (POD-747). This file used to protect a clamp: a sticky
// prompt was capped, faded and given a "Read more", and at 2.95em against a
// 22.95px line that meant a two-line message arrived pre-truncated with a
// control for the four words it was hiding. The clamp is gone, and so is the
// scroll bound that briefly replaced it — a brief is the one thing in the feed
// the reader wrote themselves, and a box that slices its last line reads as
// truncated whatever the scrollbar says.
//
// What the cap was protecting — a pasted wall of text blanketing the feed while
// it is pinned — is handled by the pin yielding instead. So there are two things
// to hold: no length of prompt may produce a hidden edge or a control to reveal
// one, and a brief past half the chat viewport must not take the sticky pin.

let host: HTMLDivElement
let root: Root

function mount(text: string, stickyOperator: boolean, highlighted = false): void {
  const item = { id: 'i1', role: 'user', text } as TranscriptItem
  act(() => {
    root.render(
      <ChatBlockView
        block={{ item }}
        index={0}
        highlighted={highlighted}
        dimmed={false}
        sessionId={asSessionId('s1')}
        cwd="/r"
        openFile={() => {}}
        httpOrigin="http://x"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
        stickyOperator={stickyOperator}
      />,
    )
  })
}

const promptBox = (): HTMLElement | null => host.querySelector('.transcript-you-body')
const toggle = (): HTMLElement | null => host.querySelector('[data-testid="prompt-expand-toggle"]')
const row = (): HTMLElement | null => host.querySelector('[data-operator-prompt="true"]')
const isPinned = (): boolean => row()?.classList.contains('sticky') ?? false

/** A prompt long enough that the old clamp would have cut it several times over. */
const LONG = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long brief`).join('\n\n')

/** Neither happy-dom nor jsdom lays out, so the pin measurement needs a stand-in
 *  for the row's rendered height and for the viewport the scroller publishes. */
let rowHeight = 0
const VIEWPORT_H = 800
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
const originalComputedStyle = globalThis.getComputedStyle

beforeEach(() => {
  rowHeight = 0
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.operatorPrompt === 'true' ? rowHeight : 0
    },
  })
  globalThis.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const style = originalComputedStyle(el, pseudo ?? null)
    return {
      ...style,
      getPropertyValue: (prop: string) =>
        prop === '--chat-viewport-h' ? `${VIEWPORT_H}px` : style.getPropertyValue(prop),
    }
  }) as typeof globalThis.getComputedStyle
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  globalThis.getComputedStyle = originalComputedStyle
  if (originalScrollHeight)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
})

describe('the sticky operator prompt', () => {
  it('renders a long brief in full, with no cut and no control', () => {
    mount(LONG, true)
    expect(promptBox()).not.toBeNull()
    expect(promptBox()?.dataset.clamped).toBeUndefined()
    expect(promptBox()?.dataset.cut).toBeUndefined()
    expect(toggle()).toBeNull()
    // Every line is present — the bound is a scroll, not a truncation.
    expect(host.textContent).toContain('line 0 of a very long brief')
    expect(host.textContent).toContain('line 59 of a very long brief')
  })

  it('renders a short brief the same way, with nothing added to it', () => {
    mount('two words', true)
    expect(promptBox()?.dataset.cut).toBeUndefined()
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('two words')
  })

  it('leaves a non-sticky prompt unwrapped', () => {
    mount(LONG, false)
    expect(promptBox()).toBeNull()
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('line 0 of a very long brief')
    // …and still labels the turn exactly once.
    expect(host.querySelectorAll('.transcript-you-label')).toHaveLength(1)
  })

  it('labels a sticky turn exactly once', () => {
    mount(LONG, true)
    const labels = host.querySelectorAll('.transcript-you-label')
    expect(labels).toHaveLength(1)
    expect(labels[0]?.textContent).toContain('Your brief')
  })

  it('needs no special case for the active search match', () => {
    // The clamp used to yield for a highlighted row, because a hit the reader
    // cannot see is worse than a prompt taking the column. With nothing hidden
    // in the first place there is no case to make an exception for.
    mount(LONG, true, true)
    expect(promptBox()?.dataset.clamped).toBeUndefined()
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('line 59 of a very long brief')
  })

  it('takes the pin while it is short enough to be a context shelf', () => {
    rowHeight = VIEWPORT_H * 0.25
    mount('a short brief', true)
    expect(isPinned()).toBe(true)
    expect(host.querySelector('[data-sticky-prompt-backdrop]')).not.toBeNull()
  })

  it('yields the pin rather than cutting itself down to fit it', () => {
    // Past half the viewport a pinned brief stops being the context for the
    // answer and becomes a lid over it, so it scrolls away like any other
    // message — with every word of it still rendered.
    rowHeight = VIEWPORT_H * 0.8
    mount(LONG, true)
    expect(isPinned()).toBe(false)
    expect(host.querySelector('[data-sticky-prompt-backdrop]')).toBeNull()
    expect(host.textContent).toContain('line 59 of a very long brief')
    // It is still the active turn's brief, so it keeps that label.
    expect(host.querySelector('.transcript-you-label')?.textContent).toContain('Your brief')
  })
})
