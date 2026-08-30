// FIRST, before any module that might touch `crypto` at import time.
import '../src/lib/crypto-polyfill'
import { Stack } from 'expo-router/stack'
import { LogBox } from 'react-native'
import { enableFreeze } from 'react-native-screens'
import { RootLayoutShell, type RootNavigationProps } from '../src/client/root-layout-shell'
import { color } from '../src/theme/theme'

/**
 * FREEZE BLURRED SCREENS (react-freeze). Every store publish used to re-render
 * every visited screen — /work rebuilding its whole SectionList underneath a
 * pushed /mission while an agent streams. `enableFreeze` makes `freezeOnBlur`
 * the default for every react-native-screens Screen: fully covered stack
 * screens (activityState 0) suspend rendering and catch up in one render on
 * return. A screen under a MODAL keeps activityState 1 and stays live, so the
 * new-issue/settings sheets do not freeze what peeks out behind them.
 *
 * Scope note (verified against the installed versions): the iOS NativeTabs
 * path (react-native-screens 4.26.2 gamma tabs) has no freeze support, so on
 * iOS this covers stack screens only; Android's JS tabs freeze via the Tabs
 * layout's own `freezeOnBlur`, and on web screens are not enabled at all so
 * this is a no-op there. Pure JS flag — never touches UITabBarAppearance.
 */
enableFreeze(true)

// Known noise: we set Reanimated's reduced-motion mode deliberately in the
// motion provider, and its advisory warning otherwise parks a LogBox toast
// over the tab bar on every dev launch.
LogBox.ignoreLogs([/Reduced motion setting is overwritten/])

function NativeNavigation({ reduceMotion }: RootNavigationProps) {
  return (
    <Stack
      initialRouteName="(tabs)"
      screenOptions={{
        headerShown: false,
        animation: reduceMotion ? 'fade' : 'default',
        gestureEnabled: true,
        contentStyle: { flex: 1, minHeight: 0, backgroundColor: color.bg },
        gestureResponseDistance: { start: 80 },
      }}
    >
      <Stack.Screen name="new-issue" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
    </Stack>
  )
}

export default function RootLayout() {
  return <RootLayoutShell Navigation={NativeNavigation} />
}
