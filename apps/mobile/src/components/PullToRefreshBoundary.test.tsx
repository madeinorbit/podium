import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
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
    const frames = mockAnimationFrames()
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

    expect(frames.request).toHaveBeenCalledOnce()
    frames.flush()
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

  it('commits only when pointer travel crosses the armed threshold', () => {
    const frames = mockAnimationFrames()
    let commits = 0
    const onRefresh = vi.fn()
    const { container } = render(
      <Profiler
        id="pull-refresh"
        onRender={() => {
          commits++
        }}
      >
        <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
          <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
            list
          </div>
        </PullToRefreshBoundary>
      </Profiler>,
    )
    const boundary = container.querySelector('[data-pull-to-refresh]') as HTMLElement
    const scroller = screen.getByTestId('scroller')

    pointerDown(scroller, 4)
    for (const clientY of [35, 50, 65]) pointerMove(boundary, 4, clientY)
    frames.flush()
    expect(commits).toBe(1)

    pointerMove(boundary, 4, 150)
    frames.flush()
    expect(commits).toBe(2)
    expect(screen.getByRole('status').textContent).toContain('Release to refresh')

    for (const clientY of [160, 170]) pointerMove(boundary, 4, clientY)
    frames.flush()
    expect(commits).toBe(2)

    pointerMove(boundary, 4, 65)
    frames.flush()
    expect(commits).toBe(3)
    expect(screen.getByRole('status').textContent).toContain('Pull to refresh')
  })

  it('refreshes from the latest distance when release precedes the paint frame', () => {
    const frames = mockAnimationFrames()
    const onRefresh = vi.fn()
    const { container } = renderBoundary(onRefresh)
    const boundary = pullBoundary(container)
    const scroller = screen.getByTestId('scroller')

    pointerDown(scroller, 5)
    pointerMove(boundary, 5, 150)
    expect(frames.pending()).toBe(1)

    fireEvent.pointerUp(boundary, { pointerId: 5, pointerType: 'touch', clientY: 150 })

    expect(onRefresh).toHaveBeenCalledOnce()
    expect(frames.cancel).toHaveBeenCalledOnce()
    expect(frames.pending()).toBe(0)
    expect(containerOpacity()).toBe('0')
  })

  it('cancels a pending paint when the boundary unmounts', () => {
    const frames = mockAnimationFrames()
    const { container, unmount } = renderBoundary(vi.fn())
    const boundary = pullBoundary(container)
    const scroller = screen.getByTestId('scroller')

    pointerDown(scroller, 6)
    pointerMove(boundary, 6, 65)
    expect(frames.pending()).toBe(1)

    unmount()

    expect(frames.cancel).toHaveBeenCalledOnce()
    expect(frames.pending()).toBe(0)
  })

  it('cancels and resets pending touch travel on touchcancel', () => {
    const frames = mockAnimationFrames()
    const onRefresh = vi.fn()
    const { container } = renderBoundary(onRefresh)
    const boundary = pullBoundary(container)
    const scroller = screen.getByTestId('scroller')

    dispatchTouch(scroller, 'touchstart', [touchPoint(7, 20)])
    dispatchTouch(boundary, 'touchmove', [touchPoint(7, 65)])
    expect(frames.pending()).toBe(1)

    dispatchTouch(boundary, 'touchcancel', [])

    expect(frames.cancel).toHaveBeenCalledOnce()
    expect(frames.pending()).toBe(0)
    expect(containerOpacity()).toBe('0')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('hands a canceled pointer gesture to the Safari touch continuation', () => {
    const frames = mockAnimationFrames()
    const onRefresh = vi.fn()
    const { container } = renderBoundary(onRefresh)
    const boundary = pullBoundary(container)
    const scroller = screen.getByTestId('scroller')

    pointerDown(scroller, 8)
    dispatchTouch(scroller, 'touchstart', [touchPoint(8, 20)])
    pointerMove(boundary, 8, 65)
    fireEvent.pointerCancel(boundary, { pointerId: 8, pointerType: 'touch' })
    expect(frames.cancel).not.toHaveBeenCalled()

    const continuation = dispatchTouch(boundary, 'touchmove', [touchPoint(8, 170)])
    expect(continuation.defaultPrevented).toBe(true)
    expect(frames.request).toHaveBeenCalledOnce()
    frames.flush()

    expect(screen.getByRole('status').textContent).toContain('Release to refresh')
    expect(indicatorTransform()).toBe('translate(-50%, 29.5px)')

    dispatchTouch(boundary, 'touchend', [])
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps the refreshing indicator pinned through gesture movement and reset', () => {
    const frames = mockAnimationFrames()
    const onRefresh = vi.fn()
    const { container } = render(
      <PullToRefreshBoundary connected refreshing onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          list
        </div>
      </PullToRefreshBoundary>,
    )
    const boundary = pullBoundary(container)
    const scroller = screen.getByTestId('scroller')

    pointerDown(scroller, 9)
    pointerMove(boundary, 9, 170)
    dispatchTouch(boundary, 'touchcancel', [])

    expect(frames.request).not.toHaveBeenCalled()
    expect(containerOpacity()).toBe('1')
    expect(indicatorTransform()).toBe('translate(-50%, 16px)')
    expect(screen.getByRole('status').textContent).toContain('Checking for updates')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('keeps the confirmed indicator pinned through gesture movement and reset', () => {
    vi.useFakeTimers()
    const frames = mockAnimationFrames()
    const onRefresh = vi.fn()
    const { container, rerender } = render(
      <PullToRefreshBoundary connected refreshing onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          list
        </div>
      </PullToRefreshBoundary>,
    )
    rerender(
      <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
        <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
          list
        </div>
      </PullToRefreshBoundary>,
    )
    const boundary = pullBoundary(container)
    const scroller = screen.getByTestId('scroller')

    dispatchTouch(scroller, 'touchstart', [touchPoint(10, 20)])
    dispatchTouch(boundary, 'touchmove', [touchPoint(10, 170)])
    dispatchTouch(boundary, 'touchcancel', [])

    expect(frames.request).not.toHaveBeenCalled()
    expect(containerOpacity()).toBe('1')
    expect(indicatorTransform()).toBe('translate(-50%, 16px)')
    expect(screen.getByRole('status').textContent).toContain('Up to date')
    expect(onRefresh).not.toHaveBeenCalled()
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

function indicatorTransform(): string {
  return (document.querySelector('[data-pull-to-refresh-indicator]') as HTMLElement).style.transform
}

function pullBoundary(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-pull-to-refresh]') as HTMLElement
}

function renderBoundary(onRefresh: () => void) {
  return render(
    <PullToRefreshBoundary connected refreshing={false} onRefresh={onRefresh}>
      <div data-testid="scroller" style={{ overflowY: 'auto', height: 100 }}>
        list
      </div>
    </PullToRefreshBoundary>,
  )
}

function pointerDown(target: HTMLElement, pointerId: number): void {
  fireEvent.pointerDown(target, {
    isPrimary: true,
    pointerId,
    pointerType: 'touch',
    clientY: 20,
  })
}

function pointerMove(target: HTMLElement, pointerId: number, clientY: number): void {
  fireEvent.pointerMove(target, {
    isPrimary: true,
    pointerId,
    pointerType: 'touch',
    clientY,
  })
}

function touchPoint(identifier: number, clientY: number): Touch {
  return { identifier, clientY } as Touch
}

function dispatchTouch(target: HTMLElement, type: string, touches: Touch[]): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent
  Object.defineProperties(event, {
    touches: { value: touches },
    targetTouches: { value: touches },
    changedTouches: { value: touches },
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function mockAnimationFrames() {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id)
  })

  return {
    request,
    cancel,
    pending: () => callbacks.size,
    flush: () => {
      const pending = [...callbacks.values()]
      callbacks.clear()
      act(() => {
        for (const callback of pending) callback(16)
      })
    },
  }
}
