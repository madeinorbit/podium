import { BottomTabBarHeightContext } from 'expo-router/build/react-navigation/bottom-tabs'
import { useContext } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The combining rule, split out for tests: the larger source wins, NEVER the
 * sum. A measured JS tab bar already pays the safe-area inset inside its own
 * background (see ../components/TabBar), so adding `insets.bottom` on top
 * would charge the home indicator twice.
 */
export function combineBottomInsets(
  measuredTabBar: number | undefined,
  safeAreaBottom: number,
): number {
  return Math.max(measuredTabBar ?? 0, safeAreaBottom)
}

/**
 * Bottom padding a scroller's content needs so its last row can be scrolled
 * fully clear of whatever chrome overlaps the screen's bottom edge [POD-420].
 * Callers add their own breathing room (usually `space.lg`) on top.
 *
 * One number, three regimes:
 *
 *  - Custom TabBar platforms (web, Android): the bar is absolutely positioned
 *    over the content and reports its measured height through
 *    `BottomTabBarHeightContext` — see ../hooks/useTabBarInset.
 *  - iOS NativeTabs: the UITabBar is a system view no JS measurement ever
 *    sees, and react-navigation's height context does not exist under
 *    `expo-router/unstable-native-tabs`. What the JS does get: expo-router
 *    mounts a fresh SafeAreaProvider INSIDE each native tab screen, and UIKit
 *    extends a child controller's bottom safe area to cover the bar it sits
 *    under — so `insets.bottom` here is home indicator PLUS bar. (The
 *    system's automatic scroll insets never reach these scrollers either:
 *    react-native-screens applies them only to a UIScrollView on the
 *    first-descendant chain, and the Screen scaffold's header is the first
 *    child, so opting out of manual padding is not available.)
 *  - Outside the tab navigator (pushed screens, sheets): no bar overlaps the
 *    content, and both sources fall back to the plain window inset — which is
 *    exactly what the last row still has to clear, the home indicator.
 */
export function useContentBottomInset(): number {
  const measured = useContext(BottomTabBarHeightContext)
  const insets = useSafeAreaInsets()
  return combineBottomInsets(measured, insets.bottom)
}
