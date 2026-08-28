import { Stack } from 'expo-router/stack'
import { RootLayoutShell, type RootNavigationProps } from '../src/client/root-layout-shell'
import { color } from '../src/theme/theme'

function NativeNavigation({ reduceMotion }: RootNavigationProps) {
  return (
    <Stack
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
