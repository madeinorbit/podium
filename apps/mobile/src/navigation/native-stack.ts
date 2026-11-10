import type { NativeStackNavigationOptions } from 'expo-router'
import { Platform } from 'react-native'
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
    subtitle: subtitle || undefined,
    largeSubtitle: large ? subtitle || undefined : undefined,
  }
  // The patched props are not in the public header-config type.
  return { unstable_nativeProps: { headerConfig: headerConfig as object } }
}

export const nativeSubtitleAvailable =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26
