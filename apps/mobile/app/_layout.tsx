import { Stack } from 'expo-router/stack'
import { RootLayoutShell, type RootNavigationProps } from '../src/client/root-layout-shell'
import { color } from '../src/theme/theme'

function NativeNavigation({ reduceMotion }: RootNavigationProps) {
  return (
    <Stack
      initialRouteName="(tabs)"
      screenOptions={{
        headerShown: true,
        headerBackButtonDisplayMode: 'minimal',
        headerShadowVisible: false,
        animation: reduceMotion ? 'fade' : 'default',
        gestureEnabled: true,
        contentStyle: { flex: 1, minHeight: 0, backgroundColor: color.bg },
        gestureResponseDistance: { start: 80 },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="new-issue" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
      <Stack.Screen
        name="inspect/[issueId]"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 0.9],
          sheetGrabberVisible: true,
          title: 'Task details',
        }}
      />
      <Stack.Screen
        name="mission/[missionId]/details"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 0.9],
          sheetGrabberVisible: true,
          title: 'Mission details',
        }}
      />
    </Stack>
  )
}

export default function RootLayout() {
  return <RootLayoutShell Navigation={NativeNavigation} />
}
