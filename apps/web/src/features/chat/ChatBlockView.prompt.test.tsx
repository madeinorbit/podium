import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

// THE BRIEF IN FLOW IS NEVER CUT AND NEVER MOVES (POD-993 round 2).
//
// Three rules meet here. POD-747 removed a clamp that fired on every collapsed
// brief — a two-line message arriving pre-truncated with a "Read more" for the
// four words it was hiding — and then had to refuse the sticky pin to any brief
// past half the viewport, because a forty-line brief pinned at full height is a
// lid over the answer it is the context for. Round one of this issue answered
// that with a clamp that engaged only once the row stuck.
//
// The delivered design takes the pin out of the column entirely: the row in the
// feed is only ever a brief — whole, in flow, no clamp, no toggle, no `sticky`,
// no transform — and the pinned state is a shelf drawn OVER the feed
// (PinnedBrief.tsx, covered by PinnedBrief.test.tsx).
//
// What this file holds: no length of prompt produces a hidden edge or a control
// in the column, the row never becomes positioned, and it carries exactly one
// foot on the human's side. The `stickyOperator` prop survives only as the
// marker that tells the shelf which rows it may carry.

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

/** A prompt long enough that the old clamp would have cut it several times over. */
const LONG = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long brief`).join('\n\n')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
})

describe('the operator prompt', () => {
  it('renders every word of a long brief, with no cut in the markup', () => {
    mount(LONG, true)
    expect(promptBox()).not.toBeNull()
    expect(host.textContent).toContain('line 0 of a very long brief')
    expect(host.textContent).toContain('line 59 of a very long brief')
  })

  it('adds nothing at all to a short brief', () => {
    mount('two words', true)
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('two words')
  })

  it('gives a non-sticky prompt the same card, with no pin and no control', () => {
    mount(LONG, false)
    expect(bubble()).not.toBeNull()
    expect(toggle()).toBeNull()
    expect(host.textContent).toContain('line 0 of a very long brief')
    // …and it carries exactly one foot, on the human's side.
    const feet = host.querySelectorAll('.msg-foot')
    expect(feet).toHaveLength(1)
    expect(feet[0]?.getAttribute('data-side')).toBe('right')
  })

  it('names no voice — the side is the attribution (POD-993)', () => {
    mount(LONG, true)
    expect(host.querySelector('.transcript-you-label')).toBeNull()
    expect(host.textContent).not.toContain('Your brief')
    expect(host.querySelector('.transcript-you-bubble')).not.toBeNull()
  })

  it('never positions the row, however long the brief is (round 2)', () => {
    // The pin left the column: a row that stays in the flow cannot change the
    // height of the document as it pins, which is the whole reason the shelf
    // exists. No `sticky`, no backdrop, no transform written onto the row.
    mount(LONG, true)
    expect(row()?.className).not.toContain('sticky')
    expect(host.querySelector('[data-sticky-prompt-backdrop]')).toBeNull()
    expect(row()?.style.transform).toBe('')
    expect(host.textContent).toContain('line 59 of a very long brief')
  })

  it('marks a pinnable brief for the shelf, and only when sticky is enabled', () => {
    mount(LONG, true)
    expect(row()?.dataset.pinnable).toBe('true')
    act(() => {
      root.unmount()
    })
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    mount(LONG, false)
    // Still the human's row — just not one the shelf may carry.
    expect(row()?.dataset.operatorPrompt).toBe('true')
    expect(row()?.dataset.pinnable).toBeUndefined()
  })
})
