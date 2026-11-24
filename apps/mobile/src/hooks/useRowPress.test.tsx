import { cleanup, renderHook } from '@testing-library/react'
import type { GestureResponderEvent } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { useRowPress } from './useRowPress'

afterEach(cleanup)

const at = (pageX: number) =>
  ({ nativeEvent: { pageX, changedTouches: [{ pageX }] } }) as GestureResponderEvent

it.each([
  40, -40, 11, -11,
])('rejects horizontal motion of %s points even when it returns inside the row', (distance) => {
  const open = vi.fn()
  const menu = vi.fn()
  const { result, rerender } = renderHook(() => useRowPress(open, menu))
  result.current.onTouchStart(at(100))
  result.current.onTouchMove(at(100 + distance))
  // A live update must not turn a cancelled drag back into a press.
  rerender()
  result.current.onTouchMove(at(100))
  result.current.onTouchEnd(at(100))
  result.current.onLongPress?.()
  result.current.onPress(at(100))
  expect(open).not.toHaveBeenCalled()
  expect(menu).not.toHaveBeenCalled()

  result.current.onTouchStart(at(100))
  result.current.onPress(at(103))
  expect(open).toHaveBeenCalledOnce()
})

it('checks release displacement when move events are coalesced', () => {
  const open = vi.fn()
  const { result } = renderHook(() => useRowPress(open))
  result.current.onTouchStart(at(100))
  result.current.onPress(at(130))
  expect(open).not.toHaveBeenCalled()
})

it('accepts a tap within slop and preserves a stationary long press', () => {
  const open = vi.fn()
  const menu = vi.fn()
  const { result } = renderHook(() => useRowPress(open, menu))
  result.current.onTouchStart(at(100))
  result.current.onTouchMove(at(105))
  result.current.onTouchEnd(at(106))
  result.current.onPress(at(106))
  expect(open).toHaveBeenCalledOnce()
  result.current.onTouchStart(at(100))
  result.current.onLongPress?.()
  expect(menu).toHaveBeenCalledOnce()
})

it('rejects cancelled touches and still accepts assistive activation without another touch', () => {
  const open = vi.fn()
  const { result } = renderHook(() => useRowPress(open))
  result.current.onTouchStart(at(100))
  result.current.onTouchCancel()
  result.current.onPress(at(100))
  expect(open).not.toHaveBeenCalled()
  result.current.onTouchStart(at(100))
  result.current.onTouchMove(at(140))
  result.current.onAccessibilityTap()
  expect(open).toHaveBeenCalledOnce()
})

it('keeps keyboard activation independent of a cancelled touch', () => {
  const open = vi.fn()
  const { result } = renderHook(() => useRowPress(open))
  result.current.onTouchStart(at(100))
  result.current.onTouchMove(at(140))
  result.current.onPress({ type: 'keyup', nativeEvent: {} } as GestureResponderEvent)
  expect(open).toHaveBeenCalledOnce()
})
