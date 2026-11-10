import type { NativeStackNavigationOptions } from 'expo-router'
import { color } from '../theme/theme'

/**
 * Titles read in the system label colour. `headerTintColor` (the accent) tints
 * bar buttons only; without an explicit title colour it would paint the
 * titles too.
 */
const titleColor = { color: color.text }

/**
 * Root tab stacks: a large title that collapses into the inline bar. No header
 * background or blur is set, so content scrolls under a transparent bar and
 * iOS 26 draws its scroll edge effect.
 */
export const tabStackOptions: NativeStackNavigationOptions = {
  headerShown: true,
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  headerTitleStyle: titleColor,
  headerLargeTitleStyle: titleColor,
  contentStyle: { backgroundColor: color.bg },
}

/** Pushed detail screens: the standard inline bar with a back button. */
export const detailStackOptions: NativeStackNavigationOptions = {
  headerShown: true,
  headerLargeTitleEnabled: false,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  headerTitleStyle: titleColor,
}
