import type { SessionOffer } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferBar } from './OfferBar'

// ---------------------------------------------------------------------------
// Agent action offer bar [spec:SP-c7f1]: shared between ChatView and the
// native terminal panel. Message + buttons render; a click hands the button's
// prompt and the offer's createdAt to the host; disabled blocks the click.
// ---------------------------------------------------------------------------

const offer: SessionOffer = {
  message: 'Tests are red on main',
  actions: [
    { label: 'Fix them', prompt: 'Please fix the failing tests' },
    { label: 'Show failures', prompt: 'Show me the failing test output' },
  ],
  createdAt: '2026-07-17T07:00:00.000Z',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('OfferBar', () => {
  it('renders the message and one button per action', () => {
    act(() => root.render(<OfferBar offer={offer} disabled={false} onAction={() => {}} />))
    expect(container.textContent).toContain('Tests are red on main')
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0]?.textContent).toBe('Fix them')
    expect(buttons[1]?.textContent).toBe('Show failures')
  })

  it('reports the clicked action prompt with the offer createdAt', () => {
    const onAction = vi.fn()
    act(() => root.render(<OfferBar offer={offer} disabled={false} onAction={onAction} />))
    act(() => {
      container.querySelectorAll('button')[1]?.click()
    })
    expect(onAction).toHaveBeenCalledWith(
      'Show me the failing test output',
      '2026-07-17T07:00:00.000Z',
    )
  })

  it('disabled blocks clicks', () => {
    const onAction = vi.fn()
    act(() => root.render(<OfferBar offer={offer} disabled={true} onAction={onAction} />))
    act(() => {
      container.querySelector('button')?.click()
    })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('an input action collects feedback first, then sends prompt + feedback as one turn', () => {
    const onAction = vi.fn()
    const withInput: SessionOffer = {
      ...offer,
      actions: [
        { label: 'Merge it', prompt: 'Merge to main' },
        { label: 'Send back', prompt: 'Revise per this feedback:', input: true },
      ],
    }
    act(() => root.render(<OfferBar offer={withInput} disabled={false} onAction={onAction} />))
    // The button advertises the pending input with an ellipsis.
    const sendBack = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Send back'),
    )
    expect(sendBack?.textContent).toBe('Send back…')
    act(() => sendBack?.click())
    // Nothing sent yet — the feedback field is up instead of the button row.
    expect(onAction).not.toHaveBeenCalled()
    const field = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="offer-feedback"] textarea',
    )
    expect(field).not.toBeNull()
    // The confirm button stays disabled until there is real text.
    const confirm = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send back',
    )
    expect(confirm?.disabled).toBe(true)
    act(() => {
      if (!field) return
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(field, 'The dock icon still does nothing.')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => confirm?.click())
    expect(onAction).toHaveBeenCalledWith(
      'Revise per this feedback:\n\nThe dock icon still does nothing.',
      '2026-07-17T07:00:00.000Z',
    )
  })

  it('cancel leaves the feedback field without sending', () => {
    const onAction = vi.fn()
    const withInput: SessionOffer = {
      ...offer,
      actions: [{ label: 'Send back', prompt: 'Revise:', input: true }],
    }
    act(() => root.render(<OfferBar offer={withInput} disabled={false} onAction={onAction} />))
    act(() => container.querySelector('button')?.click())
    expect(container.querySelector('[data-testid="offer-feedback"]')).not.toBeNull()
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
    act(() => cancel?.click())
    expect(container.querySelector('[data-testid="offer-feedback"]')).toBeNull()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('renders no button row for an action-less offer', () => {
    act(() =>
      root.render(
        <OfferBar offer={{ ...offer, actions: [] }} disabled={false} onAction={() => {}} />,
      ),
    )
    expect(container.textContent).toContain('Tests are red on main')
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})
