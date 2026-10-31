import './test-support/no-message-attachments'
import { asSessionId } from '@podium/model'
import { fireEvent, waitFor } from '@testing-library/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { QuoteInput } from '@/lib/quote/quote-sinks'
import { ChatBlockView } from './ChatBlockView'
import { NarrowMessageActions } from './message-actions-layout'

let host: HTMLDivElement, root: Root
const menuAtQuote: boolean[] = []
function textarea(): HTMLTextAreaElement {
  const node = host.querySelector('textarea')
  if (!node) throw new Error('Missing composer')
  return node
}
const onQuote = vi.fn((quote: QuoteInput) => {
  menuAtQuote.push(!!document.querySelector('[role="menu"]'))
  // Like ScopedChatComposer.addQuote, focus synchronously during insertion.
  textarea().focus()
  textarea().value += quote.text
})
async function openQuote(): Promise<HTMLElement> {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Message actions"]')
  if (!trigger) throw new Error('Missing message actions')
  await act(async () => fireEvent.click(trigger))
  return waitFor(() => {
    const item = document.querySelector<HTMLElement>(
      '[role="menuitem"][data-message-action="quote"]',
    )
    if (!item) throw new Error('Missing quote item')
    return item
  })
}

function paint(narrow: boolean) {
  act(() =>
    root.render(
      <>
        <NarrowMessageActions.Provider value={narrow}>
          <ChatBlockView
            block={{
              item: {
                id: 'quote-source',
                role: 'assistant',
                answer: true,
                text: 'The answer to quote.',
              },
            }}
            index={0}
            highlighted={false}
            dimmed={false}
            sessionId={asSessionId('quote-focus')}
            cwd="/repo"
            openFile={() => {}}
            httpOrigin="http://offline.invalid"
            onOpenImage={() => {}}
            askLivePending={false}
            onAnswerAsk={async () => {}}
            onQuote={onQuote}
          />
        </NarrowMessageActions.Provider>
        <textarea aria-label="Composer" />
      </>,
    ),
  )
}
beforeEach(() => {
  menuAtQuote.length = 0
  onQuote.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  paint(true)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('closes the narrow menu before invoking the synchronous composer quote callback', async () => {
  const item = await openQuote()
  await act(async () => {
    item.focus()
    fireEvent.click(item)
  })
  await waitFor(() => expect(onQuote).toHaveBeenCalledTimes(1))
  expect(menuAtQuote).toEqual([false])
  expect(document.activeElement).toBe(textarea())
  expect(textarea().value).toBe('The answer to quote.')
  paint(false)
  expect(document.activeElement).toBe(textarea())
  paint(true)
  expect(document.activeElement).toBe(textarea())
})

it('does not replay a completed quote when the menu is reopened and dismissed', async () => {
  const item = await openQuote()
  await act(async () => fireEvent.click(item))
  await waitFor(() => expect(onQuote).toHaveBeenCalledTimes(1))
  const reopened = await openQuote()
  await act(async () => fireEvent.keyDown(reopened, { key: 'Escape' }))
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  expect(onQuote).toHaveBeenCalledTimes(1)
  expect(textarea().value).toBe('The answer to quote.')
})
