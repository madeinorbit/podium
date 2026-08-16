import { asSessionId, type TranscriptItem } from '@podium/model'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

/**
 * THE RESTING CLOCK STAYS DIM (POD-993 round 4).
 *
 * Reported twice as "different contrast for the timestamp", and both times a
 * reading of the CSS said it matched: the ink token and the 40% are right where
 * the design puts them. What was wrong was WHICH ELEMENT carried the 40%. With
 * the fade on `.msg-foot`, the exemption written for delivery captions
 * (`:has(> [data-attribution])`) lifted it for the whole foot — and most agent
 * answers on this shell carry an attribution mark, so the clock rested at full
 * ink almost everywhere. Measured against the rendered design: rgb(111,117,128)
 * where it should have been rgb(65,70,78).
 *
 * So this reads the stylesheet: the fade belongs to the clock, and the foot must
 * not carry an opacity that something else can lift.
 */
describe('the message foot’s two registers, in the stylesheet', () => {
  // Rules only: this file explains itself at length, and the prose names the
  // very selectors these assertions are about.
  const css = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  const block = (selector: string): string =>
    css.slice(css.indexOf(`\n${selector} {`)).split('}')[0] ?? ''

  it('fades the clock, not the whole foot', () => {
    expect(block('.msg-foot')).not.toMatch(/opacity:/)
    expect(block('.msg-foot .chat-clk')).toMatch(/opacity:\s*0\.4/)
  })

  it('needs no exemption to keep a caption or a mark at full ink', () => {
    // Nothing is dimmed above them any more, so nothing has to be undone.
    expect(css).not.toMatch(/\.msg-foot:has\(/)
  })

  it('brings the clock up under the pointer, on the design’s curve', () => {
    expect(css).toMatch(/\.transcript-row:hover \.msg-foot \.chat-clk[\s\S]{0,80}opacity:\s*1/)
    expect(block('.msg-foot .chat-clk')).toMatch(/280ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/)
  })
})
