import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold'
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular'
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router/js-stack'
import { StatusBar } from 'expo-status-bar'
import { StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { AuthGate } from '../src/client/AuthGate'
import { MobileClientProvider } from '../src/client/MobileClientProvider'
import { BootSplash } from '../src/components/BootSplash'
import { VisualViewportRoot } from '../src/components/VisualViewportRoot'
import { useReduceMotion } from '../src/hooks/useReduceMotion'
import { installBlurOnNavigate } from '../src/lib/blur-on-navigate'
import { color } from '../src/theme/theme'

// Before the first navigation, not inside an effect: the stack's keyboard
// manager reaches for this on the very first page change [POD-402].
installBlurOnNavigate()

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
  // A load error falls back to system fonts; only block while still loading.
  if (!fontsLoaded && !fontsError) return <BootSplash />
  return (
    <VisualViewportRoot>
      {/* Gesture roots are cheap on native and mandatory on web, where RNGH
          installs its pointer listeners on this element [POD-402]. */}
      <GestureHandlerRootView style={styles.fill}>
        <AuthGate>
          <MobileClientProvider>
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
              other half of making the gesture real on web.
            */}
            <Stack
              screenOptions={{
                headerShown: false,
                // Reduce Motion swaps the slide for a cross-dissolve rather
                // than dropping the transition — the same substitution iOS
                // makes, and it keeps the "you went somewhere" beat that the
                // hard cut never had. The gesture stays either way: dragging a
                // screen under your thumb is direct manipulation, not decor.
                animation: reduceMotion ? 'fade' : 'slide_from_right',
                gestureEnabled: true,
                cardStyle: { flex: 1, minHeight: 0, backgroundColor: color.bg },
                // Wider than iOS's own 50px edge. A phone-web app competes with
                // Safari's back gesture and with horizontal scrollers, so the
                // grab has to be findable; the stack still only claims the
                // gesture once travel is horizontal.
                gestureResponseDistance: 80,
              }}
            >
              {/*
                Create forms and settings are sheets, not destinations [POD-366].
                They were plain pushes, which reads as "you have gone somewhere
                and must come back"; on iOS a form you can abandon is a sheet you
                swipe down. The screens themselves pair this with a Cancel
                affordance instead of a back chevron. The JS stack carries that
                the rest of the way: `modal` presentation brings the vertical
                transition AND turns the dismiss gesture downward, so a sheet now
                swipes away in the direction it arrived from.
              */}
              <Stack.Screen name="new-session" options={{ presentation: 'modal' }} />
              <Stack.Screen name="new-issue" options={{ presentation: 'modal' }} />
              <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
            </Stack>
          </MobileClientProvider>
        </AuthGate>
      </GestureHandlerRootView>
      <StatusBar style="light" />
    </VisualViewportRoot>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
