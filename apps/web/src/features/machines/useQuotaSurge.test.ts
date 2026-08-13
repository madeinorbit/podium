// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuotaSurge } from './useQuotaSurge'

beforeEach(() => {
  sessionStorage.clear()
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia
})

afterEach(cleanup)

describe('useQuotaSurge', () => {
  it('does not surge on the first paint', () => {
    const { result } = renderHook(() => useQuotaSurge([{ key: 'cc', percent: 18 }]))
    expect([...result.current]).toEqual([])
  })

  it('surges a pool that jumped 15pp or more', async () => {
    const { result, rerender } = renderHook(
      ({ percent }: { percent: number }) => useQuotaSurge([{ key: 'cc', percent }]),
      { initialProps: { percent: 18 } },
    )
    rerender({ percent: 71 })
    await waitFor(() => expect([...result.current]).toEqual(['cc']))
  })

  it('does not surge a quiet poll tick', async () => {
    const { result, rerender } = renderHook(
      ({ percent }: { percent: number }) => useQuotaSurge([{ key: 'cc', percent }]),
      { initialProps: { percent: 18 } },
    )
    rerender({ percent: 20 })
    await waitFor(() => expect([...result.current]).toEqual([]))
  })

  it('surges after a remount when sessionStorage still holds the last value', async () => {
    const first = renderHook(() => useQuotaSurge([{ key: 'cc', percent: 18 }]))
    first.unmount()
    const second = renderHook(() => useQuotaSurge([{ key: 'cc', percent: 80 }]))
    await waitFor(() => expect([...second.result.current]).toEqual(['cc']))
  })
})
