import { useNavigation } from 'expo-router'
import { useCallback, useRef } from 'react'
import { type NativeScrollEvent, type NativeSyntheticEvent, Platform } from 'react-native'
import { getTabBarMinimized, setTabBarMinimized } from '../lib/tab-bar-minimize'

type ScrollProps = Partial<{
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
  scrollEventThrottle: number
}>

/** Stable empty props for platforms where the JS capsule never renders. */
const NO_SCROLL_PROPS: ScrollProps = {}

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

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
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
    },
    [navigation],
  )

  // iOS renders the REAL UITabBar (see app/(tabs)/_layout.tsx): its minimize
  // is `tabBarMinimizeBehavior`, driven natively, and the JS capsule this hook
  // feeds never mounts there — so don't wake JS every 64ms of every scroll to
  // publish into a store with zero subscribers. Web (and any custom-TabBar
  // platform) keeps the plumbing.
  if (Platform.OS === 'ios') return NO_SCROLL_PROPS

  // Visibility is a threshold state, not a continuous scroll-linked value.
  // Sampling at 15 Hz is enough and avoids waking JS for every display frame.
  return { onScroll, scrollEventThrottle: 64 }
}
