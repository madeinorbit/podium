import { BottomTabBarHeightContext } from 'expo-router/build/react-navigation/bottom-tabs'
import { useContext } from 'react'

/**
 * How much room the floating tab bar needs at the bottom of a scroller [POD-420].
 *
 * The bar takes no layout height any more — content runs underneath it — so
 * every scroller inside a tab has to end its content this far above the bottom
 * or its last row sits under the glass forever. The number is the bar's MEASURED
 * height (capsule + its safe-area padding), reported by ../components/TabBar,
 * not a constant: label size, font scaling and the device's home-indicator inset
 * all move it.
 *
 * Returns 0 outside the tab navigator — pushed screens and sheets cover the bar
 * rather than sitting under it, so they must not pad for it. The underlying
 * react-navigation hook throws there instead, which is the wrong answer for a
 * component used on both sides of a push.
 */
export function useTabBarInset(): number {
  return useContext(BottomTabBarHeightContext) ?? 0
}
