import { useNavigation } from 'expo-router'
import { useCallback, useRef } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { getTabBarMinimized, setTabBarMinimized } from '../lib/tab-bar-minimize'

type ScrollProps = {
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
  scrollEventThrottle: number
}

export interface TabBarScrollState {
  anchor: number
  minimized: boolean
}

/** Near the top the labels stay visible regardless of the last direction. */
const TOP = 24
/** Downward travel needed before hiding labels. */
const HIDE_DISTANCE = 32
/** Larger reverse travel prevents a settling thumb from flipping them back. */
const SHOW_DISTANCE = 48

/**
 * Reduce sampled positions to threshold crossings and directional extremes.
 * Returning the same object means the scroll has no state work to publish.
 */
export function tabBarScrollState(y: number, state: TabBarScrollState): TabBarScrollState {
  if (y <= TOP) {
    if (state.anchor === y && !state.minimized) return state
    return { anchor: y, minimized: false }
  }

  if (state.minimized) {
    if (y > state.anchor) return { anchor: y, minimized: true }
    if (state.anchor - y < SHOW_DISTANCE) return state
    return { anchor: y, minimized: false }
  }

  if (y < state.anchor) return { anchor: y, minimized: false }
  if (y - state.anchor < HIDE_DISTANCE) return state
  return { anchor: y, minimized: true }
}

/**
 * Coarse scroll hints for the floating tab capsule [POD-420]. This only
 * publishes threshold crossings; label visibility does not animate bar layout.
 */
export function useMinimizeTabBarOnScroll(): ScrollProps {
  const navigation = useNavigation()
  const scrollState = useRef<TabBarScrollState>({ anchor: 0, minimized: false })

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Tabs stay mounted. Momentum from the route just left can arrive after the
    // newly focused route has expanded the bar, so ownership is checked at the
    // event boundary rather than captured from the last render.
    if (!navigation.isFocused()) return

    const current = {
      ...scrollState.current,
      // Tab selection restores labels from the bar, outside this hook.
      minimized: getTabBarMinimized(),
    }
    const next = tabBarScrollState(e.nativeEvent.contentOffset.y, current)
    scrollState.current = next
    if (next.minimized !== current.minimized) setTabBarMinimized(next.minimized)
  }, [navigation])

  // Visibility is a threshold state, not a continuous scroll-linked value.
  // Sampling at 15 Hz is enough and avoids waking JS for every display frame.
  return { onScroll, scrollEventThrottle: 64 }
}
