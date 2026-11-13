import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FOLD_EXIT_MS, useFoldExit } from './use-fold-exit'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('keeps a just-folded group mounted for one fold animation, from its first folded frame', () => {
  const { result, rerender } = renderHook(({ folded }) => useFoldExit(folded), {
    initialProps: { folded: ['saved'] as string[] },
  })
  // Saved folds never animate.
  expect([...result.current]).toEqual([])
  rerender({ folded: ['saved', 'a'] })
  expect([...result.current]).toEqual(['a'])
  act(() => vi.advanceTimersByTime(FOLD_EXIT_MS))
  expect([...result.current]).toEqual([])
})

it('drops a group that reopens before its fold finished', () => {
  const { result, rerender } = renderHook(({ folded }) => useFoldExit(folded), {
    initialProps: { folded: [] as string[] },
  })
  rerender({ folded: ['a'] })
  expect([...result.current]).toEqual(['a'])
  rerender({ folded: [] })
  expect([...result.current]).toEqual([])
})
