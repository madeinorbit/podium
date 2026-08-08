import { SplashScreen } from 'expo-router'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Animated, Easing, type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native'
import { BootSplash } from '../components/BootSplash'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color } from '../theme/theme'

/**
 * Keep the OS launch surface in place until the one React launch boundary has
 * laid out a real route. Without this, Expo hides native launch chrome as soon
 * as the bundle evaluates and briefly exposes an unpainted root view.
 */
if (Platform.OS !== 'web') {
  void SplashScreen.preventAutoHideAsync().catch(() => {})
}

const LaunchReadyContext = createContext<(() => void) | null>(null)
const NOOP_READY_SIGNAL = () => {}

/** The measured-route signal. Kept as a hook so launch tests can drive the
 * boundary without pretending a synthetic DOM event is native layout. */
export function useLaunchReadySignal(): () => void {
  const signal = useContext(LaunchReadyContext)
  return signal ?? NOOP_READY_SIGNAL
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
  const contentOpacity = useRef(new Animated.Value(0)).current
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
        contentOpacity.setValue(1)
        splashOpacity.setValue(0)
        setShowSplash(false)
        return
      }
      Animated.parallel([
        Animated.timing(contentOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(splashOpacity, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (alive && finished) setShowSplash(false)
      })
    })()
    return () => {
      alive = false
    }
  }, [contentOpacity, ready, reduceMotion, splashOpacity])

  const context = useMemo(() => markRouteReady, [markRouteReady])
  return (
    <LaunchReadyContext.Provider value={context}>
      <View style={styles.root}>
        <Animated.View style={[styles.content, { opacity: contentOpacity }]}>
          {children}
        </Animated.View>
        {showSplash ? (
          <Animated.View
            pointerEvents="auto"
            style={[StyleSheet.absoluteFill, styles.splash, { opacity: splashOpacity }]}
          >
            <BootSplash />
          </Animated.View>
        ) : null}
      </View>
    </LaunchReadyContext.Provider>
  )
}

/**
 * Marks a route ready only after it has a measured frame. An effect is too
 * early: it proves React mounted a component, not that native/web layout has a
 * page-shaped frame ready to replace launch chrome.
 */
export function LaunchReadyView({ children }: { children: ReactNode }) {
  const markReady = useLaunchReadySignal()
  const didMark = useRef(false)
  const onLayout = useCallback(
    (_event: LayoutChangeEvent) => {
      if (didMark.current) return
      didMark.current = true
      markReady()
    },
    [markReady],
  )
  return (
    <View style={styles.content} onLayout={onLayout} testID="launch-ready-view">
      {children}
    </View>
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
