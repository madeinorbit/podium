import { useRef } from 'react'
import type { GestureResponderEvent } from 'react-native'

/** A wide row must stop being a tap once a horizontal drag leaves touch slop. */
const HORIZONTAL_SLOP = 10
const touchX = ({ nativeEvent }: GestureResponderEvent) =>
  nativeEvent.changedTouches?.[0]?.pageX ?? nativeEvent.pageX

export function useRowPress(onPress: () => void, onLongPress?: () => void) {
  const touch = useRef<{ x: number; cancelled: boolean } | null>(null)
  const track = (event: GestureResponderEvent) => {
    if (touch.current && Math.abs(touchX(event) - touch.current.x) > HORIZONTAL_SLOP) {
      // Latch cancellation even if a partial swipe returns to its starting point.
      touch.current.cancelled = true
    }
  }
  return {
    onTouchStart: (event: GestureResponderEvent) => {
      touch.current = { x: touchX(event), cancelled: false }
    },
    onTouchMove: track,
    onTouchEnd: track,
    onTouchCancel: () => {
      if (touch.current) touch.current.cancelled = true
    },
    onPress: (event: GestureResponderEvent) => {
      // RN supplies the release touch; web follows touchEnd with a synthetic click.
      if (event.nativeEvent.changedTouches) track(event)
      const keyboard = event.type === 'keydown' || event.type === 'keyup'
      const cancelled = !keyboard && touch.current?.cancelled
      touch.current = null
      if (!cancelled) onPress()
    },
    onLongPress: onLongPress
      ? () => {
          if (!touch.current?.cancelled) onLongPress()
        }
      : undefined,
    // Assistive activation has no touch path and must bypass stale drag state.
    onAccessibilityTap: () => {
      touch.current = null
      onPress()
    },
  }
}
