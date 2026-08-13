import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold'
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular'
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router/js-stack'
import { StatusBar } from 'expo-status-bar'
import { Platform, StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { AuthGate } from '../src/client/AuthGate'
import { LaunchBoundary, LaunchReadyView } from '../src/client/launch'
import { MobileClientProvider } from '../src/client/MobileClientProvider'
import { ServerProfileGate, useServerProfile } from '../src/client/ServerProfileGate'
import { activeServerBearer, activeServerHttpOrigin } from '../src/client/trpc'
import { AgentOutcomeHaptics } from '../src/components/AgentOutcomeHaptics'
import { VisualViewportRoot } from '../src/components/VisualViewportRoot'
import { useReduceMotion } from '../src/hooks/useReduceMotion'
import { installBlurOnNavigate } from '../src/lib/blur-on-navigate'
import { startMobileLogging } from '../src/lib/logging'
import { color } from '../src/theme/theme'

// Before the first navigation, not inside an effect: the stack's keyboard
// manager reaches for this on the very first page change [POD-402].
installBlurOnNavigate()

// AT MODULE SCOPE, BEFORE REACT, and that is the whole point of the placement:
// an error thrown while the first screen mounts is exactly the error this
// exists to catch, and a handler installed in an effect is installed too late
// to see it. The server origin is read per send rather than captured here, so
// records queued before the app resolves its server still go out afterwards.
startMobileLogging(activeServerHttpOrigin, Platform.OS, activeServerBearer)

function ConnectedApp({ reduceMotion }: { reduceMotion: boolean }) {
  const { runtimeKey } = useServerProfile()
  return (
    <AuthGate key={`auth:${runtimeKey}`}>
      <MobileClientProvider key={`client:${runtimeKey}`}>
        <AgentOutcomeHaptics />
        <LaunchReadyView>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: reduceMotion ? 'fade' : 'slide_from_right',
              gestureEnabled: true,
              cardStyle: { flex: 1, minHeight: 0, backgroundColor: color.bg },
              gestureResponseDistance: 80,
            }}
          >
            <Stack.Screen name="new-issue" options={{ presentation: 'modal' }} />
            <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
          </Stack>
        </LaunchReadyView>
      </MobileClientProvider>
    </AuthGate>
  )
}

export default function RootLayout() {
  // Four retained faces (POD-143): regular + semibold per family, imported by
  // direct subpath so the export bundles only these TTFs, not the barrels.
  const [fontsLoaded, fontsError] = useFonts({
    Geist_400Regular,
    Geist_600SemiBold,
    GeistMono_400Regular,
    GeistMono_600SemiBold,
  })
  const reduceMotion = useReduceMotion()
  // A load error falls back to system fonts; the one launch boundary owns the
  // visible transition while fonts, auth, replica and route layout overlap.
  const fontsReady = fontsLoaded || fontsError != null
  return (
    <LaunchBoundary fontsReady={fontsReady}>
      <VisualViewportRoot>
        {/* Gesture roots are cheap on native and mandatory on web, where RNGH
            installs its pointer listeners on this element [POD-402]. */}
        <GestureHandlerRootView style={styles.fill}>
          <ServerProfileGate>
            {/*
              The JS stack, not the default native one [POD-402].

              `expo-router`'s `Stack` is native-stack, and its WEB view is a hard
              `display: none` → `flex` swap: tapping a row replaced the screen
              between two frames, with nothing to say a push had happened.
              react-native-screens' web build is a no-op `View`, so there was
              nothing to configure — the animation did not exist to turn on.
              `expo-router/js-stack` is the same router over react-navigation's
              CardStack, which animates on web off RN's `Animated`.

              Both options below have to be spelled out. `animation` defaults to
              `'none'` on web (CardStack's `getDefaultAnimation`), and
              `gestureEnabled` defaults to iOS-only — see metro.config.js for the
              other half of making the gesture real on web. The options and sheet
              presentation are owned by ConnectedApp above.
              */}
            <ConnectedApp reduceMotion={reduceMotion} />
          </ServerProfileGate>
        </GestureHandlerRootView>
        <StatusBar style="light" />
      </VisualViewportRoot>
    </LaunchBoundary>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
