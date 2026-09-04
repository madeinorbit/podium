import { BottomTabBarHeightContext } from 'expo-router/build/react-navigation/bottom-tabs'
import { useContext } from 'react'

/**
 * The JS tab bar's measured height, for chrome DOCKED above it [POD-420] — the
 * Superagent composer is the caller. Scrollers padding their content clear of
 * the bottom chrome want ./useContentBottomInset instead, which also covers
 * the iOS NativeTabs bar this context knows nothing about.
 *
 * The bar takes no layout height — content runs underneath it — and the number
 * here is its MEASURED height (capsule + its safe-area padding), reported by
 * ../components/TabBar, not a constant: label size, font scaling and the
 * device's home-indicator inset all move it.
 *
 * Returns 0 outside the tab navigator — pushed screens and sheets cover the bar
 * rather than sitting under it, so they must not pad for it. The underlying
 * react-navigation hook throws there instead, which is the wrong answer for a
 * component used on both sides of a push. Also 0 under iOS NativeTabs, where
 * the system bar reports no height to JS — the composer's own safe-area
 * fallback pays the bar there, because the per-tab SafeAreaProvider's bottom
 * inset includes it.
 */
export function useTabBarInset(): number {
  return useContext(BottomTabBarHeightContext) ?? 0
}
