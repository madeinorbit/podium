import { useCallback, useRef } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { minimizeDecision, setTabBarMinimized } from '../lib/tab-bar-minimize'

/**
 * `onScroll` for a tab's scroller: fold it away going down, bring it back going
 * up [POD-420].
 *
 * `scrollEventThrottle` is set here rather than at every call site because
 * getting it wrong is silent — RN defaults to one event per drag on iOS, which
 * would make the bar move once and then sit still for the rest of the gesture.
 */
export function useMinimizeTabBarOnScroll(): {
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
  scrollEventThrottle: number
} {
  const anchor = useRef(0)

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = minimizeDecision(e.nativeEvent.contentOffset.y, anchor.current)
    if (!next) return
    anchor.current = next.anchor
    setTabBarMinimized(next.minimized)
  }, [])

  return { onScroll, scrollEventThrottle: 16 }
}
