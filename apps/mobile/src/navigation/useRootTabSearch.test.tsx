import { act, cleanup, renderHook } from '@testing-library/react'
import type { SearchBarCommands } from 'react-native-screens'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRootTabSearch } from './useRootTabSearch'

let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
const nextFrame = () => {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => {
    callback(0)
  })
}

beforeEach(() => {
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('starts without a native field, then focuses after navigation installs the search ref', () => {
  const { result } = renderHook(() => useRootTabSearch('existing query'))
  expect(result.current.visible).toBe(false)
  act(() => result.current.open())
  expect(result.current.visible).toBe(true)
  act(nextFrame)
  const focus = vi.fn()
  const setText = vi.fn()
  result.current.searchRef.current = { focus, setText } as unknown as SearchBarCommands
  act(nextFrame)
  expect(setText).toHaveBeenCalledWith('existing query')
  expect(focus).toHaveBeenCalledOnce()
  act(() => result.current.open())
  expect(focus).toHaveBeenCalledTimes(2)
  expect(frames.size).toBe(0)
  act(() => result.current.close())
  expect(result.current.visible).toBe(false)
})

it('cancels pending focus work when search closes or its screen unmounts', () => {
  const { result, unmount } = renderHook(() => useRootTabSearch(''))
  act(() => result.current.open())
  expect(frames.size).toBe(1)
  act(() => result.current.close())
  expect(frames.size).toBe(0)
  act(() => result.current.open())
  unmount()
  expect(frames.size).toBe(0)
})
