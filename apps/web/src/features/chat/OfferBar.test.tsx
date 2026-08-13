import type { SessionOffer } from '@podium/model'
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
  vi.useRealTimers()
})

describe('OfferBar', () => {
  it('folds supporting actions by default while keeping the recommendation visible', () => {
    act(() => root.render(<OfferBar offer={offer} disabled={false} onAction={() => {}} />))
    expect(container.textContent).toContain('Tests are red on main')
    expect(container.querySelector('[data-testid="offer-primary-action"]')?.textContent).toContain(
      'Fix them',
    )
    expect(
      container.querySelector('[data-testid="offer-detail"]')?.getAttribute('aria-hidden'),
    ).toBe('true')
    expect(
      container.querySelector('[data-testid="offer-disclosure"]')?.getAttribute('aria-expanded'),
    ).toBe('false')

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-disclosure"]')?.click()
    })
    expect(
      container.querySelector('[data-testid="offer-detail"]')?.getAttribute('aria-hidden'),
    ).toBe('false')
    expect(container.textContent).toContain('Show failures')
  })

  it('reports the clicked action prompt with the offer createdAt', () => {
    const onAction = vi.fn()
    act(() => root.render(<OfferBar offer={offer} disabled={false} onAction={onAction} />))
    act(() => {
      ;[...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Show failures'))
        ?.click()
    })
    expect(onAction).toHaveBeenCalledWith(
      'Show me the failing test output',
      '2026-07-17T07:00:00.000Z',
    )
  })

  it('locks duplicate actions, reports pending at the button, and recovers after failure', async () => {
    let rejectAction: ((cause: Error) => void) | undefined
    const onAction = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAction = reject
        }),
    )
    await act(async () => {
      root.render(<OfferBar offer={offer} disabled={false} onAction={onAction} />)
    })
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="offer-primary-action"]',
    )
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(button?.getAttribute('aria-busy')).toBe('true')
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toContain('Sending…')
    expect(button?.querySelector('.spb')).toBeNull()
    button?.click()
    expect(onAction).toHaveBeenCalledTimes(1)

    await act(async () => {
      rejectAction?.(new Error('offline'))
      await Promise.resolve()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try again')
    expect(button?.disabled).toBe(false)
    expect(button?.hasAttribute('aria-busy')).toBe(false)
  })

  it('disabled blocks clicks', () => {
    const onAction = vi.fn()
    act(() => root.render(<OfferBar offer={offer} disabled={true} onAction={onAction} />))
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-primary-action"]')?.click()
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
    expect(sendBack?.textContent).toContain('Send back')
    expect(sendBack?.textContent).toContain('✎')
    act(() => sendBack?.click())
    // Nothing sent yet — the feedback field is up instead of the button row.
    expect(onAction).not.toHaveBeenCalled()
    const field = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="offer-feedback"] textarea',
    )
    expect(field).not.toBeNull()
    // The confirm button stays disabled until there is real text.
    const confirm = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Send back'),
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
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="offer-primary-action"]')?.click(),
    )
    expect(container.querySelector('[data-testid="offer-feedback"]')).not.toBeNull()
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
    act(() => cancel?.click())
    expect(container.querySelector('[data-testid="offer-feedback"]')).toBeNull()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('offers no dismissal at all when the host cannot write one', () => {
    act(() => root.render(<OfferBar offer={offer} disabled={false} onAction={() => {}} />))
    expect(container.querySelector('[data-testid="offer-dismiss"]')).toBeNull()
  })

  it('dismisses after a ten-second undo window, without sending anything', () => {
    vi.useFakeTimers()
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    act(() =>
      root.render(
        <OfferBar offer={offer} disabled={false} onAction={onAction} onDismiss={onDismiss} />,
      ),
    )
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
    })
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(180))
    expect(container.querySelector('[data-testid="offer-undo"]')?.textContent).toContain('Undo')
    act(() => vi.advanceTimersByTime(10_000))
    expect(onDismiss).toHaveBeenCalledWith('2026-07-17T07:00:00.000Z')
    expect(onAction).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('undoes a dismissal before it reaches the server', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    act(() =>
      root.render(
        <OfferBar offer={offer} disabled={false} onAction={() => {}} onDismiss={onDismiss} />,
      ),
    )
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
      vi.advanceTimersByTime(180)
    })
    act(() => {
      ;[...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Undo')
        ?.click()
      vi.advanceTimersByTime(10_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="offer-bar"]')).not.toBeNull()
    vi.useRealTimers()
  })

  it('shows a newer offer instead of inheriting the previous undo state', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    act(() =>
      root.render(
        <OfferBar offer={offer} disabled={false} onAction={() => {}} onDismiss={onDismiss} />,
      ),
    )
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
      vi.advanceTimersByTime(180)
    })
    expect(container.querySelector('[data-testid="offer-undo"]')).not.toBeNull()

    act(() =>
      root.render(
        <OfferBar
          offer={{
            ...offer,
            message: 'A newer decision is ready',
            createdAt: '2026-07-17T07:01:00.000Z',
          }}
          disabled={false}
          onAction={() => {}}
          onDismiss={onDismiss}
        />,
      ),
    )
    expect(container.querySelector('[data-testid="offer-bar"]')?.textContent).toContain(
      'A newer decision is ready',
    )
    act(() => vi.advanceTimersByTime(10_000))
    expect(onDismiss).toHaveBeenCalledWith('2026-07-17T07:00:00.000Z')
  })

  it('dismissal stays available on a session that can no longer take a turn', () => {
    vi.useFakeTimers()
    // `disabled` is "this session cannot be sent to" — an exited, unresumable
    // one. That is exactly where a stuck offer needs its way out, so the x is
    // the one control in this bar that survives it.
    const onDismiss = vi.fn()
    act(() =>
      root.render(
        <OfferBar offer={offer} disabled={true} onAction={() => {}} onDismiss={onDismiss} />,
      ),
    )
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
      vi.advanceTimersByTime(10_180)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('a failed dismissal says so and leaves the offer standing', async () => {
    vi.useFakeTimers()
    let reject: ((cause: Error) => void) | undefined
    const onDismiss = vi.fn(
      () =>
        new Promise<void>((_resolve, r) => {
          reject = r
        }),
    )
    await act(async () => {
      root.render(
        <OfferBar offer={offer} disabled={false} onAction={() => {}} onDismiss={onDismiss} />,
      )
    })
    const x = container.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')
    await act(async () => {
      x?.click()
      vi.advanceTimersByTime(10_180)
      await Promise.resolve()
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)

    await act(async () => {
      reject?.(new Error('offline'))
      await Promise.resolve()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try again')
    expect(container.textContent).toContain('Tests are red on main')
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.disabled,
    ).toBe(false)
    vi.useRealTimers()
  })

  it('renders no button row for an action-less offer', () => {
    act(() =>
      root.render(
        <OfferBar offer={{ ...offer, actions: [] }} disabled={false} onAction={() => {}} />,
      ),
    )
    expect(container.textContent).toContain('Tests are red on main')
    expect(container.querySelector('[data-testid="offer-primary-action"]')).toBeNull()
  })
})
