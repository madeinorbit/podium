import type { NativeStackNavigationOptions } from 'expo-router'
import { HeaderHeightContext, useIsFocused } from 'expo-router/react-navigation'
import { type ReactElement, use } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MessageNoticeBanner } from '../components/MessageNoticeBanner'

/** Native stack content already starts below an opaque header. Transparent
 * headers need their measured height; a headerless sheet needs its safe area. */
export function NoticeScreen({
  options,
  children,
}: {
  options: NativeStackNavigationOptions
  children: ReactElement
}) {
  const headerHeight = use(HeaderHeightContext) ?? 0
  const insets = useSafeAreaInsets()
  const focused = useIsFocused()
  const topInset =
    options.headerShown === false ? insets.top : options.headerTransparent ? headerHeight : 0
  return (
    <View style={styles.content} pointerEvents="box-none">
      {children}
      {focused ? <MessageNoticeBanner topInset={topInset} /> : null}
    </View>
  )
}

/** The tabs container delegates to its leaf stacks, avoiding duplicate notices. */
export function noticeScreenLayout({
  route,
  options,
  children,
}: {
  route: { name: string }
  options: NativeStackNavigationOptions
  children: ReactElement
}) {
  return route.name === '(tabs)' ? (
    children
  ) : (
    <NoticeScreen options={options}>{children}</NoticeScreen>
  )
}

const styles = StyleSheet.create({ content: { flex: 1, minHeight: 0 } })
