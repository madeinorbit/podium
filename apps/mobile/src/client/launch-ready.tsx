import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from 'react'
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

export interface LaunchSplashStatus {
  readonly label: string
  readonly detail?: string | undefined
  readonly progress?: number | null | undefined
}

/**
 * A live description of cold-start work, READ by the splash rather than pushed
 * into it. `getSnapshot` must return the same value until `subscribe` fires.
 *
 * Pushing a fresh status from a descendant's effect on every progress tick
 * cost one extra launch render per tick, queued below the sync lane that
 * delivered the tick. A buffered bootstrap body publishes its frames with only
 * microtasks between them, so those renders never ran and React counted each
 * still-pending one as a nested update: the 51st frame threw "Maximum update
 * depth exceeded" out of the progress publish, failing the walk. Read through
 * `useSyncExternalStore`, one tick re-renders the splash in the same pass as
 * its source. [POD-5390]
 */
export interface LaunchSplashStatusSource {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => LaunchSplashStatus | null
}

const LaunchSplashStatusContext = createContext<
  ((source: LaunchSplashStatusSource | null) => void) | null
>(null)

export const LaunchReadyProvider = LaunchReadyContext.Provider
export const LaunchSplashStatusProvider = LaunchSplashStatusContext.Provider

/** The measured-route signal. Kept as a hook so launch tests can drive the
 * boundary without pretending a synthetic DOM event is native layout. */
export function useLaunchReadySignal(): () => void {
  const signal = useContext(LaunchReadyContext)
  return signal ?? NOOP_READY_SIGNAL
}

/**
 * Lets a descendant describe real cold-start work on the ONE launch surface.
 * The source is registered once per identity, never per tick; keep it stable.
 */
export function useLaunchSplashStatus(source: LaunchSplashStatusSource): void {
  const register = useContext(LaunchSplashStatusContext)
  useEffect(() => {
    if (register === null) return
    register(source)
    return () => register(null)
  }, [register, source])
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
