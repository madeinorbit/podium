// FIRST, before any module that might touch `crypto` at import time.
import '../src/lib/crypto-polyfill'
import '../src/lib/startup-timing'
import { getFocusedRouteNameFromRoute } from 'expo-router/react-navigation'
import { Stack } from 'expo-router/stack'
import { LogBox } from 'react-native'
import { enableFreeze } from 'react-native-screens'
import { RootLayoutShell, type RootNavigationProps } from '../src/client/root-layout-shell'
import { tabsBackTitle } from '../src/navigation/back-targets'
import { systemHeaderOptions } from '../src/navigation/native-stack'
import { noticeScreenLayout } from '../src/navigation/notice-screen-layout'
import { color } from '../src/theme/theme'

/**
 * FREEZE BLURRED SCREENS (react-freeze). Every store publish used to re-render
 * every visited screen — /work rebuilding its whole SectionList underneath a
 * pushed /mission while an agent streams. `enableFreeze` makes `freezeOnBlur`
 * the default for every react-native-screens Screen: fully covered stack
 * screens (activityState 0) suspend rendering and catch up in one render on
 * return. A screen under a MODAL keeps activityState 1 and stays live, so the
 * new-issue sheet does not freeze what peeks out behind it.
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

// Expo Router reads this export when constructing a cold deep-link stack.
// The Stack prop alone does not put the tabs beneath a linked detail screen.
export const unstable_settings = { initialRouteName: '(tabs)' }

function NativeNavigation({ reduceMotion }: RootNavigationProps) {
  return (
    <Stack
      initialRouteName="(tabs)"
      screenLayout={noticeScreenLayout}
      screenOptions={{
        ...systemHeaderOptions,
        // An unspecified presentation inherits modal behavior after a sheet.
        presentation: 'card',
        headerShown: true,
        headerBackButtonDisplayMode: 'minimal',
        headerShadowVisible: false,
        animation: reduceMotion ? 'fade' : 'default',
        gestureEnabled: true,
        contentStyle: { flex: 1, minHeight: 0, backgroundColor: color.bg },
      }}
    >
      {/* `/` still matches index before its Redirect runs. Configure both ends
          here so that first native frame has no header or replace animation. */}
      <Stack.Screen name="index" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="signed-in" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="search" options={{ headerShown: false, animation: 'none' }} />
      {/* The title names the tab the user is on: iOS uses it for the back
          button of every screen pushed over the tabs. */}
      <Stack.Screen
        name="(tabs)"
        options={({ route }) => ({
          title: tabsBackTitle(getFocusedRouteNameFromRoute(route)),
          headerShown: false,
          animation: 'none',
        })}
      />
      <Stack.Screen
        name="new-issue"
        options={{
          // UIKit must know the sheet's presentation before its first frame.
          presentation: 'formSheet',
          sheetAllowedDetents: [1],
          sheetGrabberVisible: false,
          title: 'New Task',
          headerShown: true,
          headerLargeTitleEnabled: false,
          headerBackVisible: false,
          headerTransparent: true,
          headerShadowVisible: false,
          headerTitleStyle: { color: color.text },
          contentStyle: { flex: 1, minHeight: 0, backgroundColor: color.groupedCard },
        }}
      />
      {/* Start an agent on an existing task. A form sheet keeps the chat or
          task page it was opened from visible under UIKit's own dimming. */}
      <Stack.Screen
        name="launch/[issueId]"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: 'fitToContents',
          sheetGrabberVisible: false,
          title: 'Start Agent',
          headerShown: true,
          headerLargeTitleEnabled: false,
          headerBackVisible: false,
          headerTransparent: true,
          headerShadowVisible: false,
          headerTitleStyle: { color: color.text },
          contentStyle: { backgroundColor: color.groupedBg },
        }}
      />
      <Stack.Screen
        name="inspect/[issueId]"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 1],
          sheetGrabberVisible: true,
          title: 'Task details',
          headerLargeTitleEnabled: false,
          contentStyle: { backgroundColor: color.groupedBg },
        }}
      />
      <Stack.Screen
        name="mission/[missionId]/details"
        options={{
          presentation: 'card',
          title: 'Flight deck',
        }}
      />
    </Stack>
  )
}

export default function RootLayout() {
  return <RootLayoutShell Navigation={NativeNavigation} />
}
