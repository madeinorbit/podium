// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prefetchAfterFirstPaint } from './prefetch-after-first-paint'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('prefetchAfterFirstPaint', () => {
  it('waits for idle rather than loading during the paint it is deferring past', () => {
    const load = vi.fn(async () => {})
    // A holder rather than a `let`: TypeScript cannot see the assignment inside
    // the stub, and narrows a plain binding to `null` at the call below.
    const idle: { fire?: () => void } = {}
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
      idle.fire = cb
      return 7
    })
    vi.stubGlobal('cancelIdleCallback', vi.fn())

    prefetchAfterFirstPaint(load)
    // The whole point: nothing is fetched by the call itself.
    expect(load).not.toHaveBeenCalled()

    idle.fire?.()
    expect(load).toHaveBeenCalledOnce()
  })

  it('cancels a prefetch that never got its idle slot, so an unmount does not fetch', () => {
    const load = vi.fn(async () => {})
    const cancel = vi.fn()
    vi.stubGlobal('requestIdleCallback', () => 7)
    vi.stubGlobal('cancelIdleCallback', cancel)

    prefetchAfterFirstPaint(load)()
    expect(cancel).toHaveBeenCalledWith(7)
    expect(load).not.toHaveBeenCalled()
  })

  it('falls back to a macrotask where requestIdleCallback does not exist (Safari < 17)', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const load = vi.fn(async () => {})

    const cancel = prefetchAfterFirstPaint(load)
    expect(load).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(load).toHaveBeenCalledOnce()
    cancel()
  })

  /**
   * A prefetch is an optimisation, and an optimisation that can fail the page is
   * worse than no optimisation. The same import runs again when the component
   * actually renders, and THAT one is allowed to reject into Suspense's error
   * handling — this one must not surface as an unhandled rejection on a page
   * that is working fine.
   */
  it('swallows a failed prefetch instead of raising an unhandled rejection', async () => {
    // A holder rather than a `let`: TypeScript cannot see the assignment inside
    // the stub, and narrows a plain binding to `null` at the call below.
    const idle: { fire?: () => void } = {}
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
      idle.fire = cb
      return 7
    })
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    prefetchAfterFirstPaint(() => Promise.reject(new Error('chunk 404')))
    idle.fire?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
