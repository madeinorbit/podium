import { Stack } from 'expo-router/js-stack'
import { Easing } from 'react-native'
import { RootLayoutShell, type RootNavigationProps } from '../src/client/root-layout-shell'
import { color } from '../src/theme/theme'

const easeOut = Easing.bezier(0.23, 1, 0.32, 1)
const webRouteTransition = {
  open: { animation: 'timing' as const, config: { duration: 120, easing: easeOut } },
  close: { animation: 'timing' as const, config: { duration: 120, easing: easeOut } },
}
const reducedMotionTransition = {
  open: { animation: 'timing' as const, config: { duration: 100, easing: easeOut } },
  close: { animation: 'timing' as const, config: { duration: 100, easing: easeOut } },
}

function WebNavigation({ reduceMotion }: RootNavigationProps) {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        transitionSpec: reduceMotion ? reducedMotionTransition : webRouteTransition,
        gestureEnabled: true,
        cardOverlayEnabled: false,
        cardStyle: { flex: 1, minHeight: 0, backgroundColor: color.bg },
        gestureResponseDistance: 80,
      }}
    >
      <Stack.Screen name="new-issue" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
    </Stack>
  )
}

export default function RootLayout() {
  return <RootLayoutShell Navigation={WebNavigation} />
}
