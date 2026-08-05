import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

// A sticky operator prompt is pinned over the transcript it belongs to, so a
// long one must clamp instead of blanketing the feed (POD-1368). The height cap
// itself is CSS; what this suite protects is the behavior around it — that the
// clamp is applied to sticky prompt rows only, that the expand control appears
// exactly when content is actually hidden, and that it toggles the clamp.

let host: HTMLDivElement
let root: Root
/** Rendered height of the clamp box's content, in the layout-less DOM. */
let contentHeight = 0
/** Height the clamp is capped to (CSS `max-height` in the real browser). */
const CAP = 100

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

const clampBox = (): HTMLElement | null => host.querySelector('.transcript-you-clamp')
const toggle = (): HTMLElement | null => host.querySelector('[data-testid="prompt-expand-toggle"]')

const originalDescriptors = ['scrollHeight', 'clientHeight'].map(
  (prop) => [prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)] as const,
)

beforeEach(() => {
  // Neither happy-dom nor jsdom lays out, so scrollHeight/clientHeight are 0
  // everywhere and nothing ever reads as overflowing. Stand in for the browser:
  // the clamp box reports the content height, clipped to the cap while clamped.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('transcript-you-clamp') ? contentHeight : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains('transcript-you-clamp')) return 0
      return this.dataset.clamped === 'true' ? Math.min(contentHeight, CAP) : contentHeight
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
  for (const [prop, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, prop)
  }
})

describe('sticky operator prompt clamp', () => {
  it('clamps a long sticky prompt and offers an expand control', () => {
    contentHeight = 900
    mount('a very long prompt', true)
    // data-clamped applies the height cap; data-cut draws the fade + ellipsis
    // over the edge, and is set from the same verdict as the toggle below.
    expect(clampBox()?.dataset.clamped).toBe('true')
    expect(clampBox()?.dataset.cut).toBe('true')
    const button = toggle()
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('Read more')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    // The control sits in the YOU label row, which stays on screen while the
    // prompt is stuck — under the text it would scroll out of reach.
    expect(button?.closest('.transcript-you-label')).not.toBeNull()
  })

  it('expands and re-collapses the prompt on toggle', () => {
    contentHeight = 900
    mount('a very long prompt', true)
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clampBox()?.dataset.clamped).toBeUndefined()
    // The control survives expansion — the overflow comparison is vacuous once
    // the clamp is off, so the last clamped verdict has to be kept.
    expect(toggle()?.textContent).toContain('Show less')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clampBox()?.dataset.clamped).toBe('true')
    expect(toggle()?.textContent).toContain('Read more')
  })

  it('shows no control when the prompt fits inside the cap', () => {
    contentHeight = 40
    mount('short prompt', true)
    expect(clampBox()?.dataset.clamped).toBe('true')
    expect(toggle()).toBeNull()
  })

  it('ignores the sub-pixel overflow a perfectly fitting prompt reports', () => {
    // Browsers round scrollHeight/clientHeight off fractional layout, so a
    // one-line prompt measures a couple of pixels "over" with nothing hidden.
    contentHeight = CAP + 2
    mount('a prompt that exactly fills the cap', true)
    expect(toggle()).toBeNull()
  })

  it('never fades an edge it is not offering to expand (POD-376)', () => {
    // The confirmed bug: 45px of content in a 43px box sat under the slack, so
    // no toggle rendered — and the fade rendered anyway, greying out a live last
    // line with no way to reveal it. The fade and the toggle now share one
    // verdict, so a prompt can be capped without being marked as cut.
    contentHeight = CAP + 2
    mount('a prompt that exactly fills the cap', true)
    expect(clampBox()?.dataset.clamped).toBe('true')
    expect(clampBox()?.dataset.cut).toBeUndefined()
    // …and where something IS hidden, both appear together.
    contentHeight = CAP + 40
    mount('a prompt with a hidden line', true)
    expect(clampBox()?.dataset.cut).toBe('true')
    expect(toggle()).not.toBeNull()
  })

  it('drops the fade with the clamp when the prompt is expanded', () => {
    contentHeight = 900
    mount('a very long prompt', true)
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clampBox()?.dataset.cut).toBeUndefined()
  })

  it('leaves a non-sticky prompt unclamped', () => {
    contentHeight = 900
    mount('a very long prompt', false)
    expect(clampBox()).toBeNull()
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('a very long prompt')
    // …and still labels the turn exactly once.
    expect(host.querySelectorAll('.transcript-you-label')).toHaveLength(1)
  })

  it('opens the clamp for the active search match', () => {
    // A hit the reader cannot see is worse than a prompt taking the column, so
    // the highlighted row shows in full — and drops the now-pointless toggle.
    contentHeight = 900
    mount('a very long prompt', true, true)
    expect(clampBox()).not.toBeNull()
    expect(clampBox()?.dataset.clamped).toBeUndefined()
    expect(toggle()).toBeNull()
  })

  it('labels a clamped turn exactly once', () => {
    contentHeight = 900
    mount('a very long prompt', true)
    const labels = host.querySelectorAll('.transcript-you-label')
    expect(labels).toHaveLength(1)
    expect(labels[0]?.textContent).toContain('You')
  })
})
