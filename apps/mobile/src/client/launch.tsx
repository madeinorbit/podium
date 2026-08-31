import { SplashScreen } from 'expo-router'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { BootSplash } from '../components/BootSplash'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color } from '../theme/theme'
import {
  LaunchReadyProvider,
  type LaunchSplashStatus,
  LaunchSplashStatusProvider,
} from './launch-ready'

// The route-ready signal lives in `./launch-ready`, which does NOT import
// expo-router — see the note there. Re-exported so existing importers of
// `./launch` are unaffected.
export { LaunchReadyView, useLaunchReadySignal } from './launch-ready'

/**
 * Keep the OS launch surface in place until the one React launch boundary has
 * laid out a real route. Without this, Expo hides native launch chrome as soon
 * as the bundle evaluates and briefly exposes an unpainted root view.
 */
if (Platform.OS !== 'web') {
  void SplashScreen.preventAutoHideAsync().catch(() => {})
}

/**
 * The app's single launch owner.
 *
 * Auth and replica gates intentionally render `null` while they resolve. This
 * component stays mounted above both of them, so the wordmark reveal never
 * restarts as boot moves from fonts -> auth -> local replica. The route reports
 * its first real layout through `LaunchReadyView`; only then is the native
 * surface hidden and the already-laid-out app crossfaded in.
 */
export function LaunchBoundary({
  fontsReady,
  children,
}: {
  fontsReady: boolean
  children: ReactNode
}) {
  const reduceMotion = useReduceMotion()
  const [routeReady, setRouteReady] = useState(false)
  const [showSplash, setShowSplash] = useState(true)
  const [splashStatus, setSplashStatus] = useState<LaunchSplashStatus | null>(null)
  const splashOpacity = useRef(new Animated.Value(1)).current
  const ready = fontsReady && routeReady
  const markRouteReady = useCallback(() => setRouteReady(true), [])

  useEffect(() => {
    if (!ready) return
    let alive = true
    void (async () => {
      if (Platform.OS !== 'web') await SplashScreen.hideAsync().catch(() => {})
      if (!alive) return
      if (reduceMotion) {
        splashOpacity.setValue(0)
        setShowSplash(false)
        return
      }
      Animated.timing(splashOpacity, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (alive && finished) setShowSplash(false)
      })
    })()
    return () => {
      alive = false
    }
  }, [ready, reduceMotion, splashOpacity])

  const context = useMemo(() => markRouteReady, [markRouteReady])
  return (
    <LaunchSplashStatusProvider value={setSplashStatus}>
      <LaunchReadyProvider value={context}>
        <View style={styles.root}>
          {/* The content NEVER carries an animated opacity: a subtree under
              one renders as an offscreen group, and UIKit disables backdrop
              layers inside such groups — which blanked the iOS 26 Liquid
              Glass tab-bar capsule for the app's whole life (root-caused
              2026-08-28 by bisecting the shell against a minimal root; the
              native-driver node keeps the group even after the value settles).
              The reveal is carried entirely by the OPAQUE splash overlay
              fading out above the already-final content — visually the same
              crossfade, structurally inert. */}
          <View style={styles.content}>{children}</View>
          {showSplash ? (
            <Animated.View
              pointerEvents="auto"
              style={[StyleSheet.absoluteFill, styles.splash, { opacity: splashOpacity }]}
            >
              <BootSplash {...(splashStatus ?? {})} />
            </Animated.View>
          ) : null}
        </View>
      </LaunchReadyProvider>
    </LaunchSplashStatusProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  splash: {
    backgroundColor: color.bg,
  },
})
