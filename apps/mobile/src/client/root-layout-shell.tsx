import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import type { ComponentType, ReactNode } from 'react'
import { Platform, StyleSheet, useColorScheme } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { AgentOutcomeHaptics } from '../components/AgentOutcomeHaptics'
import { KeyboardRoot } from '../components/KeyboardRoot'
import { PodiumLinkHost } from '../components/PodiumLinkHost'
import { VisualViewportRoot } from '../components/VisualViewportRoot'
import { ReducedMotionProvider } from '../hooks/ReducedMotionProvider'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { installBlurOnNavigate } from '../lib/blur-on-navigate'
import { startMobileLogging } from '../lib/logging'
import { color } from '../theme/theme'
import { AuthGate } from './AuthGate'
import { useLaunchFontsReady } from './font-startup'
import { LaunchBoundary, LaunchReadyView } from './launch'
import { MobileClientProvider } from './MobileClientProvider'
import { ReadinessGate } from './ReadinessGate'
import { ServerProfileGate, useServerProfile } from './ServerProfileGate'
import { activeServerBearer, activeServerHttpOrigin } from './trpc'

// TypeScript 7 applies `moduleSuffixes` to a package's `types` entry as well, so with
// `.web` first `expo-status-bar` resolves to its web declaration, whose StatusBar takes no
// props (the web build ignores them). The native build takes `style`; type it as such.
const PlatformStatusBar = StatusBar as ComponentType<{
  style?: 'auto' | 'light' | 'dark' | 'inverted'
}>

// Before the first navigation, not inside an effect: the web stack's keyboard
// manager reaches for this on the very first page change [POD-402].
installBlurOnNavigate()

// AT MODULE SCOPE, BEFORE REACT, and that is the whole point of the placement:
// an error thrown while the first screen mounts is exactly the error this
// exists to catch, and a handler installed in an effect is installed too late
// to see it. The server origin is read per send rather than captured here, so
// records queued before the app resolves its server still go out afterwards.
startMobileLogging(activeServerHttpOrigin, Platform.OS, activeServerBearer)

const podiumLightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: color.accentTint,
    background: color.bg,
    card: color.surface,
    text: color.text,
    border: color.border,
    notification: color.dangerText,
  },
}

const podiumDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: color.accentTint,
    background: color.bg,
    card: color.surface,
    text: color.text,
    border: color.border,
    notification: color.dangerText,
  },
}

export type RootNavigationProps = { reduceMotion: boolean }

function ConnectedApp({ children }: { children: ReactNode }) {
  const { runtimeKey } = useServerProfile()
  return (
    <AuthGate key={`auth:${runtimeKey}`}>
      <MobileClientProvider key={`client:${runtimeKey}`}>
        <AgentOutcomeHaptics />
        <PodiumLinkHost />
        <LaunchReadyView>{children}</LaunchReadyView>
      </MobileClientProvider>
    </AuthGate>
  )
}

function RootLayoutContent({ Navigation }: { Navigation: ComponentType<RootNavigationProps> }) {
  const fontsReady = useLaunchFontsReady()
  const reduceMotion = useReduceMotion()
  const colorScheme = useColorScheme()
  return (
    <LaunchBoundary fontsReady={fontsReady}>
      <VisualViewportRoot>
        {/* Gesture roots are cheap on native and mandatory on web, where RNGH
            installs its pointer listeners on this element [POD-402]. */}
        <GestureHandlerRootView style={styles.fill}>
          <KeyboardRoot>
            <ThemeProvider value={colorScheme === 'dark' ? podiumDarkTheme : podiumLightTheme}>
              <ServerProfileGate>
                <ReadinessGate>
                  <ConnectedApp>
                    <Navigation reduceMotion={reduceMotion} />
                  </ConnectedApp>
                </ReadinessGate>
              </ServerProfileGate>
            </ThemeProvider>
          </KeyboardRoot>
        </GestureHandlerRootView>
        <PlatformStatusBar style="auto" />
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
