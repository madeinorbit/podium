import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPolledQueryCache, usePolledQuery } from './use-polled-query'

/**
 * THE FOUR PROPERTIES THE BESPOKE TIMERS KEPT GETTING WRONG (POD-1772). Each of
 * these was a real difference between the four hooks this utility replaced, so
 * each is asserted rather than left to the doc comment.
 */

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  resetPolledQueryCache()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usePolledQuery', () => {
  it('repeats on the interval and keeps the last answer', async () => {
    const read = vi.fn().mockResolvedValue('one')
    const { result } = renderHook(() =>
      usePolledQuery({ key: 'k', intervalMs: 1_000, read }),
    )
    await act(async () => {})
    expect(result.current.data).toBe('one')

    read.mockResolvedValue('two')
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current.data).toBe('two')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('drops a tick that lands while a read is still in flight', async () => {
    // A read slower than its own interval otherwise stacks requests behind a
    // busy daemon — a "refresh" that becomes a load generator.
    let settle: (value: string) => void = () => {}
    const read = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve
        }),
    )
    renderHook(() => usePolledQuery({ key: 'k', intervalMs: 100, read }))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle('done')
    })
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('stops while the tab is hidden and takes a reading the moment it returns', async () => {
    const read = vi.fn().mockResolvedValue('x')
    renderHook(() => usePolledQuery({ key: 'k', intervalMs: 100, read }))
    await act(async () => {})
    expect(read).toHaveBeenCalledTimes(1)

    await act(async () => {
      setVisibility('hidden')
    })
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(read).toHaveBeenCalledTimes(1)

    // Not one interval later: the first VISIBLE frame must be fresh.
    await act(async () => {
      setVisibility('visible')
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('serves the cached answer to a fresh mount, so a reopen has no cold state', async () => {
    const read = vi.fn().mockResolvedValue('cached')
    const first = renderHook(() => usePolledQuery({ key: 'k', intervalMs: 0, read }))
    await act(async () => {})
    first.unmount()

    const second = renderHook(() => usePolledQuery({ key: 'k', intervalMs: 0, read }))
    // On the FIRST frame — before the refresh behind it resolves.
    expect(second.result.current.data).toBe('cached')
  })

  it('keeps the figures on screen when a refresh fails, and names the reason', async () => {
    const read = vi.fn().mockResolvedValue('good')
    const { result } = renderHook(() => usePolledQuery({ key: 'k', intervalMs: 100, read }))
    await act(async () => {})

    read.mockRejectedValue(new Error('daemon unreachable'))
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.data).toBe('good')
    expect(result.current.failed).toBe(true)
    expect(result.current.error).toBe('daemon unreachable')
  })

  it('reads once when the interval is 0', async () => {
    const read = vi.fn().mockResolvedValue('x')
    renderHook(() => usePolledQuery({ key: 'k', intervalMs: 0, read }))
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('repaints from the new key on the SAME frame it changes', async () => {
    const read = vi.fn().mockImplementation(async () => 'a-value')
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => usePolledQuery({ key, intervalMs: 0, read }),
      { initialProps: { key: 'a' } },
    )
    await act(async () => {})
    expect(result.current.data).toBe('a-value')

    // A key change that carried the old key's answer for one frame is how a
    // machine chip click paints one host's figures under another's heading.
    read.mockImplementation(() => new Promise<string>(() => {}))
    rerender({ key: 'b' })
    expect(result.current.data).toBeNull()
  })

  it('does not poll while disabled, but still serves the cache', async () => {
    const read = vi.fn().mockResolvedValue('seeded')
    const seed = renderHook(() => usePolledQuery({ key: 'k', intervalMs: 0, read }))
    await act(async () => {})
    seed.unmount()
    read.mockClear()

    const { result } = renderHook(() =>
      usePolledQuery({ key: 'k', intervalMs: 100, read, enabled: false }),
    )
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(read).not.toHaveBeenCalled()
    expect(result.current.data).toBe('seeded')
  })

  it('hands a FRESH reading to onData in the read own turn, not a flush later', async () => {
    // The update dialog folds its reading into React state here. If this arrived
    // one state-update hop late, the surface would paint the answer a flush
    // after it landed — which is exactly the regression this callback exists to
    // prevent, so the assertion is that `data` and the callback agree on the
    // SAME frame.
    const read = vi.fn().mockResolvedValue('fresh')
    const seen: string[] = []
    const { result } = renderHook(() =>
      usePolledQuery<string>({ key: 'k', intervalMs: 0, read, onData: (v) => seen.push(v) }),
    )
    await act(async () => {})
    expect(seen).toEqual(['fresh'])
    expect(result.current.data).toBe('fresh')
  })

  it('does NOT replay the cached answer to onData on a remount', async () => {
    // A caller that applies every reading would otherwise re-apply a stale one
    // every time its sheet reopened.
    const read = vi.fn().mockResolvedValue('seeded')
    const seed = renderHook(() => usePolledQuery<string>({ key: 'k', intervalMs: 0, read }))
    await act(async () => {})
    seed.unmount()

    const seen: string[] = []
    read.mockImplementation(() => new Promise<string>(() => {}))
    const { result } = renderHook(() =>
      usePolledQuery<string>({ key: 'k', intervalMs: 0, read, onData: (v) => seen.push(v) }),
    )
    await act(async () => {})
    expect(result.current.data).toBe('seeded')
    expect(seen).toEqual([])
  })
})
