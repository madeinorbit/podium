import type { SessionOffer } from '@podium/model'
import { act, type JSX, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferBar } from './OfferBar'
import { OfferDismissalContext, useOfferDismissalHost } from './offer-dismissal'
import { OfferLiftContext, type OfferLiftHost, useOfferLiftHost } from './offer-lift'

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
  it('renders a URL in the detail as a link that opens a new window', () => {
    const linked: SessionOffer = {
      ...offer,
      message: 'Preview is up\nOpen https://preview.example.com/login and try the flow.',
    }
    act(() => root.render(<OfferBar offer={linked} disabled={false} onAction={() => {}} />))

    const link = container.querySelector<HTMLAnchorElement>('[data-testid="offer-detail"] a')
    expect(link?.getAttribute('href')).toBe('https://preview.example.com/login')
    // `_blank` marks the link as leaving Podium: in a browser tab it opens one,
    // and in the desktop shell it is the anchor WKWebView would swallow, which
    // is why the injected shim claims the click first. (The shim keys on the
    // ORIGIN, not on this attribute — a link to our own Podium carries neither.)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelector('[data-testid="offer-detail"]')?.textContent).toContain(
      'Open https://preview.example.com/login and try the flow.',
    )
  })

  it('does not collapse the fold when a link in the detail is clicked', () => {
    const linked: SessionOffer = {
      ...offer,
      message: 'Preview is up\nOpen https://preview.example.com/login.',
    }
    act(() => root.render(<OfferBar offer={linked} disabled={false} onAction={() => {}} />))
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="offer-disclosure"]')?.click()
    })
    expect(
      container.querySelector('[data-testid="offer-disclosure"]')?.getAttribute('aria-expanded'),
    ).toBe('true')

    const link = container.querySelector<HTMLAnchorElement>('[data-testid="offer-detail"] a')
    // jsdom would otherwise "navigate"; the assertion is about the fold, not the open.
    link?.addEventListener('click', (event) => event.preventDefault())
    act(() => link?.click())
    expect(
      container.querySelector('[data-testid="offer-disclosure"]')?.getAttribute('aria-expanded'),
    ).toBe('true')
  })

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
    expect(button?.querySelector('.pod-mark')).toBeNull()
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
    // The button advertises the pending input with a pencil mark — an icon in
    // the bar's own family now, not a text glyph, so it is asserted by class.
    const sendBack = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Send back'),
    )
    expect(sendBack?.textContent).toContain('Send back')
    expect(sendBack?.querySelector('.offer-fold-action-pencil')).not.toBeNull()
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

  // A panel holds TWO bars for one offer — the chat composer's and the native
  // dock's. The undo window used to be per-bar, so for its ten seconds the view
  // the operator was not looking at still offered a decision they had already
  // made, and switching views read as "I have to dismiss it twice" (POD-1103).
  describe('two bars, one offer', () => {
    function TwoBars({ onDismiss }: { onDismiss: () => void }): JSX.Element {
      const host = useOfferDismissalHost()
      return (
        <OfferDismissalContext.Provider value={host}>
          <div data-testid="chat-seat">
            <OfferBar offer={offer} disabled={false} onAction={() => {}} onDismiss={onDismiss} />
          </div>
          <div data-testid="native-seat">
            <OfferBar offer={offer} disabled={false} onAction={() => {}} onDismiss={onDismiss} />
          </div>
        </OfferDismissalContext.Provider>
      )
    }
    const seat = (name: string): Element | null =>
      container.querySelector(`[data-testid="${name}-seat"]`)

    it('dismissing one takes the offer off the other at once', () => {
      vi.useFakeTimers()
      const onDismiss = vi.fn()
      act(() => root.render(<TwoBars onDismiss={onDismiss} />))
      expect(seat('native')?.querySelector('[data-testid="offer-bar"]')).not.toBeNull()

      act(() => {
        seat('chat')?.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
        vi.advanceTimersByTime(180)
      })
      // Not "hidden ten seconds later, once the server write lands" — gone now,
      // and showing the same undo the clicked bar shows.
      expect(seat('native')?.querySelector('[data-testid="offer-bar"]')).toBeNull()
      expect(seat('native')?.querySelector('[data-testid="offer-undo"]')).not.toBeNull()
      expect(onDismiss).not.toHaveBeenCalled()

      act(() => vi.advanceTimersByTime(10_000))
      // Still exactly one server write: the second bar mirrors the dismissal, it
      // does not run one of its own.
      expect(onDismiss).toHaveBeenCalledTimes(1)
      expect(onDismiss).toHaveBeenCalledWith('2026-07-17T07:00:00.000Z')
      vi.useRealTimers()
    })

    it('undo from the other bar brings the offer back to both', () => {
      vi.useFakeTimers()
      const onDismiss = vi.fn()
      act(() => root.render(<TwoBars onDismiss={onDismiss} />))
      act(() => {
        seat('chat')?.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
        vi.advanceTimersByTime(180)
      })
      act(() => {
        ;[...(seat('native')?.querySelectorAll('button') ?? [])]
          .find((button) => button.textContent === 'Undo')
          ?.click()
        vi.advanceTimersByTime(10_000)
      })
      expect(seat('chat')?.querySelector('[data-testid="offer-bar"]')).not.toBeNull()
      expect(seat('native')?.querySelector('[data-testid="offer-bar"]')).not.toBeNull()
      expect(onDismiss).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('a failed dismissal restores the offer on both bars', async () => {
      vi.useFakeTimers()
      let reject: ((cause: Error) => void) | undefined
      const onDismiss = vi.fn(
        () =>
          new Promise<void>((_resolve, r) => {
            reject = r
          }),
      )
      await act(async () => {
        root.render(<TwoBars onDismiss={onDismiss} />)
      })
      await act(async () => {
        seat('chat')?.querySelector<HTMLButtonElement>('[data-testid="offer-dismiss"]')?.click()
        vi.advanceTimersByTime(10_180)
        await Promise.resolve()
      })
      await act(async () => {
        reject?.(new Error('offline'))
        await Promise.resolve()
      })
      // The server still holds the offer, so neither view may claim it is gone.
      expect(seat('chat')?.querySelector('[data-testid="offer-bar"]')).not.toBeNull()
      expect(seat('native')?.querySelector('[data-testid="offer-bar"]')).not.toBeNull()
      // …and the message goes to the bar the operator actually clicked.
      expect(seat('chat')?.querySelector('[role="alert"]')?.textContent).toContain('Try again')
      expect(seat('native')?.querySelector('[role="alert"]')).toBeNull()
      vi.useRealTimers()
    })
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

  // POD-1068: the detail stays in flow under the row — what changes is who pays
  // for it. The host is handed the fold's height and pushes the pane above up
  // by it, so the PTY and the transcript keep the box they had.
  describe('lifting host', () => {
    /** jsdom lays nothing out; the fold's natural height is stubbed instead. */
    const withNaturalDetailHeight = (height: number): (() => void) => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('offer-fold-detail-body') ? height : 0
        },
      })
      return () => {
        if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
        else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
      }
    }

    const liftHost = (room: number): { host: OfferLiftHost; lifts: number[] } => {
      const lifts: number[] = []
      return {
        lifts,
        host: {
          setLift: (_caller, px) => lifts.push(px),
          room: () => room,
          watchRoom: () => () => {},
        },
      }
    }

    const toggleDisclosure = (): void => {
      act(() => {
        container.querySelector<HTMLButtonElement>('[data-testid="offer-disclosure"]')?.click()
      })
    }

    it('publishes the opened fold height to the host and takes it back on close', () => {
      const restore = withNaturalDetailHeight(210)
      const { host, lifts } = liftHost(1000)
      try {
        act(() =>
          root.render(
            <OfferLiftContext.Provider value={host}>
              <OfferBar offer={offer} disabled={false} onAction={() => {}} />
            </OfferLiftContext.Provider>,
          ),
        )
        // Closed: nothing is asked of the pane above.
        expect(lifts.at(-1)).toBe(0)
        // The fold is still the row's own child — only the paying changes.
        expect(container.querySelector('.offer-fold-detail')).not.toBeNull()
        expect(container.querySelector('.offer-fold-root')?.className).toContain(
          'offer-fold-root--lifted',
        )

        toggleDisclosure()
        expect(lifts.at(-1)).toBe(210)
        expect(container.querySelector('.offer-fold-detail-clip')?.className).not.toContain(
          'offer-fold-detail-clip--capped',
        )

        toggleDisclosure()
        expect(lifts.at(-1)).toBe(0)
      } finally {
        restore()
      }
    })

    it('caps the lift at the room offered and scrolls the detail past it', () => {
      const restore = withNaturalDetailHeight(400)
      const { host, lifts } = liftHost(120)
      try {
        act(() =>
          root.render(
            <OfferLiftContext.Provider value={host}>
              <OfferBar offer={offer} disabled={false} onAction={() => {}} />
            </OfferLiftContext.Provider>,
          ),
        )
        toggleDisclosure()
        expect(lifts.at(-1)).toBe(120)
        expect(container.querySelector('.offer-fold-detail-clip')?.className).toContain(
          'offer-fold-detail-clip--capped',
        )
      } finally {
        restore()
      }
    })

    // A panel can hold two bars for ONE offer: chat mode keeps the native dock
    // mounted at zero height so it can animate away. The closed one must not
    // zero the panel's lift, and must not charge its own seat for a fold it is
    // not showing — that second margin is free space the flex solver hands to
    // the transcript, which then grows by exactly the height it must not.
    it('charges only the seat whose fold is open, across two bars in one panel', () => {
      const restore = withNaturalDetailHeight(210)
      const Panel = (): JSX.Element => {
        const rootRef = useRef<HTMLDivElement | null>(null)
        const host = useOfferLiftHost(rootRef)
        return (
          <div ref={rootRef}>
            <OfferLiftContext.Provider value={host}>
              <div className="offer-lift-seat" data-testid="seat-dock">
                <OfferBar offer={offer} disabled={false} onAction={() => {}} />
              </div>
              <div className="offer-lift-seat" data-testid="seat-chat">
                <OfferBar offer={offer} disabled={false} onAction={() => {}} />
              </div>
            </OfferLiftContext.Provider>
          </div>
        )
      }
      try {
        act(() => root.render(<Panel />))
        const seat = (which: string): HTMLElement =>
          container.querySelector<HTMLElement>(`[data-testid="seat-${which}"]`) as HTMLElement
        const panelLift = (): string =>
          (container.firstElementChild as HTMLElement).style.getPropertyValue('--offer-lift')

        act(() => {
          seat('chat').querySelector<HTMLButtonElement>('[data-testid="offer-disclosure"]')?.click()
        })
        expect(panelLift()).toBe('210px')
        expect(seat('chat').style.getPropertyValue('--offer-seat-lift')).toBe('210px')
        expect(seat('dock').style.getPropertyValue('--offer-seat-lift')).toBe('0px')

        act(() => {
          seat('chat').querySelector<HTMLButtonElement>('[data-testid="offer-disclosure"]')?.click()
        })
        expect(panelLift()).toBe('0px')
        expect(seat('chat').style.getPropertyValue('--offer-seat-lift')).toBe('0px')
      } finally {
        restore()
      }
    })

    it('leaves the fold in flow, and asks for no lift, without a host', () => {
      const restore = withNaturalDetailHeight(210)
      try {
        act(() => root.render(<OfferBar offer={offer} disabled={false} onAction={() => {}} />))
        expect(container.querySelector('.offer-fold-root')?.className).not.toContain(
          'offer-fold-root--lifted',
        )
        toggleDisclosure()
        expect(container.querySelector('.offer-fold-detail')?.getAttribute('aria-hidden')).toBe(
          'false',
        )
      } finally {
        restore()
      }
    })
  })
})
