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

  it('renders no button row for an action-less offer', () => {
    act(() =>
      root.render(<OfferBar offer={{ ...offer, actions: [] }} disabled={false} onAction={() => {}} />),
    )
    expect(container.textContent).toContain('Tests are red on main')
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})
