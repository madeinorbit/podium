import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullToRefreshBoundary } from './PullToRefreshBoundary'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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
