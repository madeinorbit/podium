import './test-support/no-message-attachments'
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatBlockView } from './ChatBlockView'
import { NarrowMessageActions } from './message-actions-layout'

let host: HTMLDivElement, root: Root
let narrow = false
const quote = vi.fn()
const third = '[data-row-key="third"]'
function control(selector: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`${third} ${selector}`)!
}
const copy = () => control('.msg-foot [data-message-action="copy"]')
const add = () => control('.msg-foot [data-message-action="quote"]')
const trigger = () => control('[aria-label="Message actions"]')
function paint(next: boolean) {
  narrow = next
  act(() =>
    root.render(
      <>
        <NarrowMessageActions.Provider value={narrow}>
          {['first', 'second', 'third'].map((id, index) => (
            <ChatBlockView
              key={id}
              block={{ item: { id, role: 'assistant', answer: true, text: `${id} answer` } }}
              index={index}
              highlighted={false}
              dimmed={false}
              sessionId={asSessionId('focus-handoff')}
              cwd="/repo"
              openFile={() => {}}
              httpOrigin="http://offline.invalid"
              onOpenImage={() => {}}
              askLivePending={false}
              onAnswerAsk={async () => {}}
              onQuote={quote}
            />
          ))}
        </NarrowMessageActions.Provider>
        <input aria-label="Composer" />
      </>,
    ),
  )
}
const focus = (element: HTMLElement) => act(() => element.focus())
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  quote.mockClear()
  // The unit host has no layout. Visibility follows the same pane breakpoint
  // as the real CSS; Chromium separately covers native hiding and popup teardown.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    const hidden =
      !this.isConnected ||
      (this.closest('.msg-foot') && narrow) ||
      (this.closest('.msg-narrow-actions') && !narrow)
    return (hidden ? [] : [new DOMRect(0, 0, 21, 21)]) as unknown as DOMRectList
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

it('transfers a third-message narrow trigger to that message copy control', () => {
  paint(true)
  focus(trigger())
  paint(false)
  expect(document.activeElement).toBe(copy())
})

it('transfers a third-message wide copy control to that message narrow trigger', () => {
  paint(false)
  focus(copy())
  paint(true)
  expect(document.activeElement).toBe(trigger())
})

it('remembers the quote control through a narrow and wide round trip', () => {
  paint(false)
  focus(add())
  paint(true)
  expect(document.activeElement).toBe(trigger())
  paint(false)
  expect(document.activeElement).toBe(add())
  act(() => add().click())
  expect(quote).toHaveBeenCalledWith(expect.objectContaining({ text: 'third answer' }))
})

it('does not reclaim focus after it moves to a composer', () => {
  paint(false)
  focus(copy())
  const composer = host.querySelector<HTMLInputElement>('input')!
  focus(composer)
  paint(true)
  expect(document.activeElement).toBe(composer)
  paint(false)
  expect(document.activeElement).toBe(composer)
})

it('does not revive explicitly blurred message focus on resize', () => {
  paint(true)
  focus(trigger())
  act(() => trigger().blur())
  expect(document.activeElement).toBe(document.body)
  paint(false)
  expect(document.activeElement).toBe(document.body)
})

it('hands off only the most recently focused message', () => {
  paint(false)
  focus(
    host.querySelector<HTMLButtonElement>('[data-row-key="first"] [data-message-action="copy"]')!,
  )
  focus(add())
  paint(true)
  expect(document.activeElement).toBe(trigger())
})
