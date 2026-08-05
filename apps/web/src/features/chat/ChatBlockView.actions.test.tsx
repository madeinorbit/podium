import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

// PER-MESSAGE ACTIONS (POD-376). Measured before this: zero buttons on zero
// messages. What this pins is that the actions exist on the rows that carry a
// message, that Copy takes the markdown rather than the rendered HTML, and that
// Quote hands the composer something it can reply into.

let host: HTMLDivElement
let root: Root
let written: string[]

function mount(item: TranscriptItem, onQuote?: (markdown: string) => void): void {
  act(() => {
    root.render(
      <ChatBlockView
        block={{ item }}
        index={0}
        highlighted={false}
        dimmed={false}
        sessionId={asSessionId('s1')}
        cwd="/r"
        openFile={() => {}}
        httpOrigin="http://x"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
        onQuote={onQuote}
      />,
    )
  })
}

const actions = (): HTMLElement | null => host.querySelector('[data-testid="message-actions"]')
const buttons = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.msg-action'))
const click = (el: HTMLElement | undefined): void => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  written = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text)
        return Promise.resolve()
      },
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
  vi.restoreAllMocks()
})

const prose = (text: string, role: TranscriptItem['role'] = 'assistant'): TranscriptItem =>
  ({ id: 'm1', role, text }) as TranscriptItem

describe('per-message actions', () => {
  it('copies the message markdown, not its rendered HTML', () => {
    mount(prose('Ran the suite — **all green**.'))
    click(buttons()[0])
    expect(written).toEqual(['Ran the suite — **all green**.'])
  })

  it('quotes a message into the composer as a blockquote', () => {
    const quoted: string[] = []
    mount(prose('first line\nsecond line'), (markdown) => quoted.push(markdown))
    click(buttons()[1])
    expect(quoted).toEqual(['> first line\n> second line\n\n'])
  })

  it('offers no Quote where there is no composer to quote into', () => {
    mount(prose('an answer with nowhere to go'))
    expect(buttons()).toHaveLength(1)
  })

  it('rides on the operator turn as well as the agent one', () => {
    mount(prose('do the thing', 'user'))
    expect(actions()).not.toBeNull()
  })

  it('stays out of the flow — nothing to reveal on an empty row', () => {
    mount(prose('   '))
    expect(actions()).toBeNull()
  })
})
