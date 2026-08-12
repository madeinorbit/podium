import { createContext, type ReactNode, useCallback, useContext, useRef } from 'react'
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native'

/**
 * THE ROUTE-READY SIGNAL, SEPARATED FROM THE SPLASH THAT CONSUMES IT (POD-712).
 *
 * These three pieces used to live in `./launch` beside `LaunchBoundary`, which
 * imports `expo-router`'s `SplashScreen` at module scope in order to hold the
 * NATIVE launch surface. That made "tell the launch boundary this route has a
 * frame" — a plain layout callback with no platform dependency at all — reachable
 * only by dragging expo-router in behind it. Harmless until the composition root
 * needed to report a failed boot through the same signal, at which point the
 * router arrived in a module graph that had never had it and stopped resolving.
 *
 * `./launch` re-exports all three, so every existing import keeps working.
 */

const LaunchReadyContext = createContext<(() => void) | null>(null)
const NOOP_READY_SIGNAL = () => {}

export const LaunchReadyProvider = LaunchReadyContext.Provider

/** The measured-route signal. Kept as a hook so launch tests can drive the
 * boundary without pretending a synthetic DOM event is native layout. */
export function useLaunchReadySignal(): () => void {
  const signal = useContext(LaunchReadyContext)
  return signal ?? NOOP_READY_SIGNAL
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
  content: {
    flex: 1,
    minHeight: 0,
  },
})
