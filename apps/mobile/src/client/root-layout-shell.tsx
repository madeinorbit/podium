import { StatusBar } from 'expo-status-bar'
import type { ComponentType, ReactNode } from 'react'
import { Platform, StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { AgentOutcomeHaptics } from '../components/AgentOutcomeHaptics'
import { VisualViewportRoot } from '../components/VisualViewportRoot'
import { ReducedMotionProvider } from '../hooks/ReducedMotionProvider'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { installBlurOnNavigate } from '../lib/blur-on-navigate'
import { startMobileLogging } from '../lib/logging'
import { AuthGate } from './AuthGate'
import { useLaunchFontsReady } from './font-startup'
import { LaunchBoundary, LaunchReadyView } from './launch'
import { MobileClientProvider } from './MobileClientProvider'
import { ReadinessGate } from './ReadinessGate'
import { ServerProfileGate, useServerProfile } from './ServerProfileGate'
import { activeServerBearer, activeServerHttpOrigin } from './trpc'

// Before the first navigation, not inside an effect: the web stack's keyboard
// manager reaches for this on the very first page change [POD-402].
installBlurOnNavigate()

// AT MODULE SCOPE, BEFORE REACT, and that is the whole point of the placement:
// an error thrown while the first screen mounts is exactly the error this
// exists to catch, and a handler installed in an effect is installed too late
// to see it. The server origin is read per send rather than captured here, so
// records queued before the app resolves its server still go out afterwards.
startMobileLogging(activeServerHttpOrigin, Platform.OS, activeServerBearer)

export type RootNavigationProps = { reduceMotion: boolean }

function ConnectedApp({ children }: { children: ReactNode }) {
  const { runtimeKey } = useServerProfile()
  return (
    <AuthGate key={`auth:${runtimeKey}`}>
      <MobileClientProvider key={`client:${runtimeKey}`}>
        <AgentOutcomeHaptics />
        <LaunchReadyView>{children}</LaunchReadyView>
      </MobileClientProvider>
    </AuthGate>
  )
}

function RootLayoutContent({
  Navigation,
}: {
  Navigation: ComponentType<RootNavigationProps>
}) {
  const fontsReady = useLaunchFontsReady()
  const reduceMotion = useReduceMotion()
  return (
    <LaunchBoundary fontsReady={fontsReady}>
      <VisualViewportRoot>
        {/* Gesture roots are cheap on native and mandatory on web, where RNGH
            installs its pointer listeners on this element [POD-402]. */}
        <GestureHandlerRootView style={styles.fill}>
          <ServerProfileGate>
            <ReadinessGate>
              <ConnectedApp>
                <Navigation reduceMotion={reduceMotion} />
              </ConnectedApp>
            </ReadinessGate>
          </ServerProfileGate>
        </GestureHandlerRootView>
        <StatusBar style="light" />
      </VisualViewportRoot>
    </LaunchBoundary>
  )
}

export function RootLayoutShell({
  Navigation,
}: {
  Navigation: ComponentType<RootNavigationProps>
}) {
  return (
    <ReducedMotionProvider>
      <RootLayoutContent Navigation={Navigation} />
    </ReducedMotionProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
