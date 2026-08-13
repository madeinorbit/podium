import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

// THE BRIEF IS CUT ONLY WHILE IT IS PINNED (POD-993).
//
// Two earlier rules meet here. POD-747 removed a clamp that fired on every
// collapsed brief — a two-line message arriving pre-truncated with a "Read more"
// for the four words it was hiding — and then had to refuse the sticky pin to
// any brief past half the viewport, because a forty-line brief pinned at full
// height is a lid over the answer it is the context for.
//
// The rule now splits by state rather than by length. IN FLOW nothing is ever
// cut: every word, no fade, no control. PINNED the brief is a shelf, so it
// clamps, fades and offers one toggle — and every brief takes the pin again,
// including the long ones the shelf exists for.
//
// What this file holds: no length of prompt produces a hidden edge in flow; the
// pin is never refused; and the toggle exists exactly when the pinned shelf is
// tall enough for the clamp to bite.

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
const bubble = (): HTMLElement | null => host.querySelector('.transcript-you-bubble')
const toggle = (): HTMLElement | null => host.querySelector('[data-testid="prompt-expand-toggle"]')
const row = (): HTMLElement | null => host.querySelector('[data-operator-prompt="true"]')
const isPinned = (): boolean => row()?.classList.contains('sticky') ?? false

/** A prompt long enough that the old clamp would have cut it several times over. */
const LONG = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long brief`).join('\n\n')

/** Neither happy-dom nor jsdom lays out, so the clamp measurement needs a
 *  stand-in for the rendered height of the brief's body. */
let bodyHeight = 0
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  bodyHeight = 0
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('transcript-you-body') ? bodyHeight : 0
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  if (originalScrollHeight)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
})

describe('the operator prompt', () => {
  it('renders every word of a long brief, with no cut in the markup', () => {
    bodyHeight = 900
    mount(LONG, true)
    expect(promptBox()).not.toBeNull()
    expect(host.textContent).toContain('line 0 of a very long brief')
    expect(host.textContent).toContain('line 59 of a very long brief')
  })

  it('adds nothing at all to a short brief', () => {
    bodyHeight = 40
    mount('two words', true)
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('two words')
  })

  it('gives a non-sticky prompt the same card, with no pin and no control', () => {
    bodyHeight = 900
    mount(LONG, false)
    expect(bubble()).not.toBeNull()
    expect(isPinned()).toBe(false)
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('line 0 of a very long brief')
    // …and it still labels the turn exactly once.
    expect(host.querySelectorAll('.transcript-you-label')).toHaveLength(1)
  })

  it('labels a sticky turn exactly once', () => {
    mount(LONG, true)
    const labels = host.querySelectorAll('.transcript-you-label')
    expect(labels).toHaveLength(1)
    expect(labels[0]?.textContent).toContain('Your brief')
  })

  it('takes the pin however long the brief is', () => {
    // POD-747 refused the pin past half the viewport, which took the context
    // shelf away from exactly the exchanges that most needed one. The clamp is
    // the answer to a long brief now, so the pin is never refused.
    bodyHeight = 4000
    mount(LONG, true)
    expect(isPinned()).toBe(true)
    expect(host.querySelector('[data-sticky-prompt-backdrop]')).not.toBeNull()
    expect(host.textContent).toContain('line 59 of a very long brief')
  })

  it('offers one toggle when the pinned shelf is taller than the clamp, and opens in place', () => {
    bodyHeight = 900
    mount(LONG, true)
    const control = toggle()
    expect(control).not.toBeNull()
    expect(control?.getAttribute('aria-expanded')).toBe('false')
    expect(bubble()?.dataset.pinOpen).toBeUndefined()
    act(() => {
      control?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(bubble()?.dataset.pinOpen).toBe('true')
  })
})
