import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCodeHighlight } from './useCodeHighlight'

const { highlight } = vi.hoisted(() => ({
  highlight: vi.fn((text: string) => [{ scope: 'keyword', text }]),
}))
vi.mock('@podium/client-core/code-highlight', () => ({ highlightCode: highlight }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  highlight.mockClear()
})

it('keeps first paint plain, cancels stale work and retains unchanged results', () => {
  const work = new Map<number, IdleRequestCallback>()
  let next = 0
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    work.set(++next, callback)
    return next
  })
  vi.stubGlobal('cancelIdleCallback', (id: number) => work.delete(id))
  const { result, rerender, unmount } = renderHook(({ source }) => useCodeHighlight(source, 'ts'), {
    initialProps: { source: 'const first = 1' },
  })
  expect(result.current).toEqual([{ scope: null, text: 'const first = 1' }])
  expect(highlight).not.toHaveBeenCalled()
  rerender({ source: 'const second = 2' })
  expect(work.size).toBe(1)
  act(() => {
    work.get(next)?.({} as IdleDeadline)
    work.delete(next)
  })
  expect(highlight).toHaveBeenCalledExactlyOnceWith('const second = 2', 'ts')
  const tokens = result.current
  rerender({ source: 'const second = 2' })
  expect(result.current).toBe(tokens)
  expect(work.size).toBe(0)
  rerender({ source: 'const third = 3' })
  expect(result.current).toEqual([{ scope: null, text: 'const third = 3' }])
  unmount()
  expect(work.size).toBe(0)
})

it('yields with a cancellable timer on older targets and skips diff blocks', () => {
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.useFakeTimers()
  const { result, rerender, unmount } = renderHook(
    ({ enabled }) => useCodeHighlight('text', 'ts', enabled),
    { initialProps: { enabled: false } },
  )
  act(() => vi.runAllTimers())
  expect(highlight).not.toHaveBeenCalled()
  rerender({ enabled: true })
  expect(result.current[0].scope).toBeNull()
  act(() => vi.runAllTimers())
  expect(result.current[0].scope).toBe('keyword')
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
