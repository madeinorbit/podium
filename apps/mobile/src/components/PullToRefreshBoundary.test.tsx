import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullToRefreshBoundary } from './PullToRefreshBoundary'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PWA pull-to-refresh boundary', () => {
  it('arms from a top-edge pointer pull and refreshes on release', () => {
    const onRefresh = vi.fn()
    const { container } = render(
      <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          list
        </div>
      </PullToRefreshBoundary>,
    )
    const boundary = container.querySelector('[data-pull-to-refresh]') as HTMLElement
    const scroller = screen.getByTestId('scroller')

    fireEvent.pointerDown(scroller, {
      isPrimary: true,
      pointerId: 1,
      pointerType: 'touch',
      clientY: 20,
    })
    fireEvent.pointerMove(boundary, {
      isPrimary: true,
      pointerId: 1,
      pointerType: 'touch',
      clientY: 150,
    })
    expect(screen.getByRole('status').textContent).toContain('Release to refresh')

    fireEvent.pointerUp(boundary, { pointerId: 1, pointerType: 'touch', clientY: 150 })
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('leaves mid-list panning to the browser', () => {
    const onRefresh = vi.fn()
    const { container } = render(
      <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          list
        </div>
      </PullToRefreshBoundary>,
    )
    const boundary = container.querySelector('[data-pull-to-refresh]') as HTMLElement
    const scroller = screen.getByTestId('scroller')
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 40 })

    fireEvent.pointerDown(scroller, {
      isPrimary: true,
      pointerId: 2,
      pointerType: 'touch',
      clientY: 20,
    })
    fireEvent.pointerMove(boundary, {
      isPrimary: true,
      pointerId: 2,
      pointerType: 'touch',
      clientY: 180,
    })
    fireEvent.pointerUp(boundary, { pointerId: 2, pointerType: 'touch', clientY: 180 })

    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Pull to refresh')
  })

  it('coalesces pointer movement and keeps the painted distance through a rerender', () => {
    let pendingFrame: FrameRequestCallback | undefined
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      pendingFrame = undefined
    })
    const onRefresh = vi.fn()
    const { container, rerender } = render(
      <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          list
        </div>
      </PullToRefreshBoundary>,
    )
    const boundary = container.querySelector('[data-pull-to-refresh]') as HTMLElement
    const indicator = screen.getByRole('status')
    const scroller = screen.getByTestId('scroller')

    fireEvent.pointerDown(scroller, {
      isPrimary: true,
      pointerId: 3,
      pointerType: 'touch',
      clientY: 20,
    })
    fireEvent.pointerMove(boundary, {
      isPrimary: true,
      pointerId: 3,
      pointerType: 'touch',
      clientY: 45,
    })
    fireEvent.pointerMove(boundary, {
      isPrimary: true,
      pointerId: 3,
      pointerType: 'touch',
      clientY: 65,
    })

    expect(requestFrame).toHaveBeenCalledOnce()
    act(() => pendingFrame?.(16))
    expect(indicator.style.transform).toBe('translate(-50%, -23px)')

    rerender(
      <PullToRefreshBoundary connected={false} refreshing={false} onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          updated list
        </div>
      </PullToRefreshBoundary>,
    )
    expect(indicator.style.transform).toBe('translate(-50%, -23px)')
  })

  it('offers a screen-reader button and confirms a completed check', () => {
    vi.useFakeTimers()
    const onRefresh = vi.fn()
    const { rerender } = render(
      <PullToRefreshBoundary connected refreshing onRefresh={onRefresh}>
        <div>list</div>
      </PullToRefreshBoundary>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('Checking for updates')

    rerender(
      <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
        <div>list</div>
      </PullToRefreshBoundary>,
    )
    expect(screen.getByRole('status').textContent).toContain('Up to date')
    act(() => vi.runAllTimers())
    expect(containerOpacity()).toBe('0')
  })
})

function containerOpacity(): string {
  return (document.querySelector('[data-pull-to-refresh-indicator]') as HTMLElement).style.opacity
}
