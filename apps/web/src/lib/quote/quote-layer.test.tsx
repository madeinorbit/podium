import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QuoteLayer, readQuote } from './QuoteLayer'
import {
  markQuoteSinkFocused,
  type QuoteInput,
  type QuoteSink,
  registerQuoteSink,
  resolveQuoteSink,
  serializeQuotes,
} from './quote-sinks'

// ADD TO CHAT (POD-2057). What this pins: the wire format the agent reads, which
// text a selection quotes and how it names its source, which prompt box gets it,
// and that the pill only exists while there is somewhere for the quote to go.

let host: HTMLDivElement
const cleanups: (() => void)[] = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.getSelection()?.removeAllRanges()
  host.remove()
})

/** The first text node under `selector` in the test host. */
function textIn(selector: string, nth = 0): Node {
  const node = host.querySelectorAll(selector)[nth]?.firstChild
  if (!node) throw new Error(`no text under ${selector}`)
  return node
}

function select(node: Node, start: number, end: number, endNode: Node = node): void {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(endNode, end)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** A composer is "on screen" when it has client rects; deck panels under
 *  `display:none` have none. */
function sink(scope: HTMLElement, onScreen = true): { sink: QuoteSink; added: QuoteInput[] } {
  const composer = document.createElement('textarea')
  scope.appendChild(composer)
  composer.getClientRects = () =>
    (onScreen ? [new DOMRect(0, 0, 10, 10)] : []) as unknown as DOMRectList
  const added: QuoteInput[] = []
  const s: QuoteSink = { scope, composer, add: (q) => added.push(q) }
  cleanups.push(registerQuoteSink(s))
  return { sink: s, added }
}

describe('serializeQuotes', () => {
  it('puts one quote ahead of the words, ending in its source', () => {
    expect(serializeQuotes([{ text: 'a\n\nb', source: '/r/doc.md:6-8' }], ' cut this ')).toBe(
      '> a\n>\n> b\n> — /r/doc.md:6-8\n\ncut this',
    )
  })

  it('numbers several so the prose can refer to them', () => {
    const out = serializeQuotes(
      [
        { text: 'one', source: 'your reply, 10:04' },
        { text: 'two', source: '/r/a.ts:3' },
      ],
      '',
    )
    expect(out).toBe('[1]\n> one\n> — your reply, 10:04\n\n[2]\n> two\n> — /r/a.ts:3')
  })
})

describe('readQuote', () => {
  it('quotes a selection inside a source and names its line range', () => {
    host.innerHTML =
      '<div data-quote-source="/r/plan.md">' +
      '<div data-source-line="3" data-source-end="4"><p>First block</p></div>' +
      '<div data-source-line="6" data-source-end="9"><p>Second block</p></div>' +
      '</div>'
    select(textIn('p', 0), 6, 5, textIn('p', 1))
    const read = readQuote(document.getSelection())
    expect(read?.quote.source).toBe('/r/plan.md:3-9')
    expect(read?.quote.text).toContain('block')
  })

  it('names a single line when the selection stays in one block', () => {
    host.innerHTML =
      '<div data-quote-source="/r/plan.md"><div data-source-line="6" data-source-end="6"><p>Only here</p></div></div>'
    select(textIn('p'), 0, 4)
    expect(readQuote(document.getSelection())?.quote).toEqual({
      text: 'Only',
      source: '/r/plan.md:6',
    })
  })

  it('ignores selections outside any source', () => {
    host.innerHTML = '<p>chrome text</p>'
    select(textIn('p'), 0, 6)
    expect(readQuote(document.getSelection())).toBeNull()
  })
})

describe('resolveQuoteSink', () => {
  it('sends a selection inside a chat to that chat, even when another was focused', () => {
    const left = document.createElement('div')
    const right = document.createElement('div')
    host.append(left, right)
    const a = sink(left)
    const b = sink(right)
    markQuoteSinkFocused(b.sink)
    const inside = left.appendChild(document.createElement('p'))
    expect(resolveQuoteSink(inside)).toBe(a.sink)
  })

  it('sends a selection elsewhere to the prompt focused last', () => {
    const left = document.createElement('div')
    const right = document.createElement('div')
    host.append(left, right)
    const a = sink(left)
    sink(right)
    markQuoteSinkFocused(a.sink)
    expect(resolveQuoteSink(host)).toBe(a.sink)
  })

  it('finds nothing when no prompt box is on screen', () => {
    const hidden = document.createElement('div')
    host.append(hidden)
    sink(hidden, false)
    expect(resolveQuoteSink(host)).toBeNull()
  })
})

describe('QuoteLayer', () => {
  let root: Root
  let layerHost: HTMLDivElement

  beforeEach(() => {
    layerHost = document.createElement('div')
    document.body.appendChild(layerHost)
    root = createRoot(layerHost)
    act(() => root.render(<QuoteLayer chord="⌘L" />))
  })

  afterEach(() => {
    act(() => root.unmount())
    layerHost.remove()
  })

  const pill = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-testid="quote-pill"]') as HTMLElement
  const settle = async (): Promise<void> => {
    await act(async () => {
      document.dispatchEvent(new Event('pointerup'))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
  }

  it('offers the pill over a quotable selection and adds the quote on click', async () => {
    const chat = document.createElement('div')
    host.append(chat)
    const { added } = sink(chat)
    host.insertAdjacentHTML(
      'afterbegin',
      '<p data-quote-source="your reply, 10:04">Lead with signups</p>',
    )
    select(textIn('p'), 0, 4)
    await settle()
    expect(pill().dataset.shown).toBe('true')
    act(() => pill().click())
    expect(added).toEqual([{ text: 'Lead', source: 'your reply, 10:04' }])
    expect(pill().dataset.shown).toBeUndefined()
    expect(document.getSelection()?.isCollapsed).toBe(true)
  })

  it('re-resolves the destination on activation and keeps the selection when it is gone', async () => {
    const chat = document.createElement('div')
    host.append(chat)
    const { added } = sink(chat)
    // The composer that was on screen when the selection settled goes away
    // (a dock closed) before the pill is clicked.
    const unregister = cleanups.pop() as () => void
    host.insertAdjacentHTML('afterbegin', '<p data-quote-source="/r/a.md">Keep me selected</p>')
    select(textIn('p'), 0, 4)
    await settle()
    expect(pill().dataset.shown).toBe('true')
    unregister()
    act(() => pill().click())
    expect(added).toEqual([])
    expect(document.getSelection()?.toString()).toBe('Keep')
  })

  it('follows a selection that grows without the pointer (Select All, Shift+arrows)', async () => {
    const chat = document.createElement('div')
    host.append(chat)
    const { added } = sink(chat)
    host.insertAdjacentHTML('afterbegin', '<p data-quote-source="/r/a.md">Whole paragraph here</p>')
    select(textIn('p'), 0, 5)
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(pill().dataset.shown).toBe('true')
    // Grow the live range in place, as Select All does just before the chord.
    document.getSelection()?.getRangeAt(0).setEnd(textIn('p'), 20)
    act(() => pill().click())
    expect(added).toEqual([{ text: 'Whole paragraph here', source: '/r/a.md' }])
  })

  it('stages a quote from a modal reader without taking focus', async () => {
    const chat = document.createElement('div')
    host.append(chat)
    const calls: boolean[] = []
    const composer = document.createElement('textarea')
    chat.appendChild(composer)
    composer.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList
    cleanups.push(
      registerQuoteSink({ scope: chat, composer, add: (_q, focus = true) => calls.push(focus) }),
    )
    host.insertAdjacentHTML(
      'afterbegin',
      '<div aria-modal="true"><p data-quote-source="/r/a.md">Calm reading</p></div>',
    )
    select(textIn('p'), 0, 4)
    await settle()
    act(() => pill().click())
    expect(calls).toEqual([false])
  })

  it('stays hidden when no prompt box is on screen', async () => {
    const chat = document.createElement('div')
    host.append(chat)
    sink(chat, false)
    host.insertAdjacentHTML('afterbegin', '<p data-quote-source="/r/a.md">Some text</p>')
    select(textIn('p'), 0, 4)
    await settle()
    expect(pill().dataset.shown).toBeUndefined()
  })
})
