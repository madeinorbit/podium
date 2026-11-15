import type { NativeStackNavigationOptions } from 'expo-router'
import { Platform } from 'react-native'
import { color } from '../theme/theme'

/**
 * Titles read in the system label colour. `headerTintColor` (the accent) tints
 * bar buttons only; without an explicit title colour it would paint the
 * titles too.
 */
const titleColor = { color: color.text }

// Inherit UIKit's traits immediately. React Navigation otherwise forces the
// previous JS theme onto the bar during a live appearance switch, making its
// glass change appearance twice before useColorScheme catches up.
const systemHeaderConfig =
  Platform.OS === 'ios' ? { experimental_userInterfaceStyle: 'unspecified' as const } : {}

export const systemHeaderOptions: Pick<NativeStackNavigationOptions, 'unstable_nativeProps'> = {
  unstable_nativeProps: { headerConfig: systemHeaderConfig },
}

/**
 * Root tab stacks: a large title that collapses into the inline bar. No header
 * background or blur is set, so content scrolls under a transparent bar and
 * iOS 26 draws its scroll edge effect.
 */
export const tabStackOptions: NativeStackNavigationOptions = {
  ...systemHeaderOptions,
  headerShown: true,
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  headerTitleStyle: titleColor,
  headerLargeTitleStyle: titleColor,
  contentStyle: { backgroundColor: color.bg },
}

/**
 * Pushed detail screens on iOS float a transparent bar over their content, as
 * the root tabs do. Without it the stack falls back to an opaque `colors.card`
 * bar and react-native-screens lays the screen out below it, so nothing
 * scrolls under the bar and iOS 26 never draws its scroll edge effect. Android
 * keeps its solid app bar.
 */
export const transparentDetailHeader = Platform.OS === 'ios'

/** Pushed detail screens: the standard inline bar with a back button. */
export const detailStackOptions: NativeStackNavigationOptions = {
  ...systemHeaderOptions,
  headerShown: true,
  headerLargeTitleEnabled: false,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  headerTitleStyle: titleColor,
  headerTransparent: transparentDetailHeader,
}

/**
 * iOS 26 navigation subtitle (patches/react-native-screens@4.26.2.patch): under
 * the large title at rest and under the inline title once it collapses. Spread
 * into `Stack.Screen` options; `Screen` does this for its string `subtitle`.
 * Systems before iOS 26 ignore it, so check {@link nativeSubtitleAvailable}
 * before relying on it as the only place a subtitle shows.
 */
export function headerSubtitleOptions(
  subtitle: string | undefined,
  { large = false }: { large?: boolean } = {},
): Pick<NativeStackNavigationOptions, 'unstable_nativeProps'> {
  const headerConfig = {
    ...systemHeaderConfig,
    subtitle: subtitle || undefined,
    // A warm-sync label must not insert/remove 22pt while the person is
    // aiming at the first visible controls. Whitespace reserves UIKit's line.
    largeSubtitle: large ? subtitle || (nativeSubtitleAvailable ? '\u00a0' : undefined) : undefined,
  }
  // The patched props are not in the public header-config type.
  return { unstable_nativeProps: { headerConfig: headerConfig as object } }
}

export const nativeSubtitleAvailable =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26
