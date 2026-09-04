import { type ReactNode, useSyncExternalStore } from 'react'
import { ReduceMotion, ReducedMotionConfig } from 'react-native-reanimated'
import { ReducedMotionContext } from './useReduceMotion'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
let mediaQuery: MediaQueryList | undefined

function getMediaQuery(): MediaQueryList | undefined {
  if (mediaQuery) return mediaQuery
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
  mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
  return mediaQuery
}

function getSnapshot(): boolean {
  return getMediaQuery()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const query = getMediaQuery()
  if (!query) return () => {}
  if (
    typeof query.addEventListener === 'function' &&
    typeof query.removeEventListener === 'function'
  ) {
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }
  if (typeof query.addListener === 'function' && typeof query.removeListener === 'function') {
    query.addListener(onChange)
    return () => query.removeListener(onChange)
  }
  return () => {}
}

export function ReducedMotionProvider({ children }: { children: ReactNode }) {
  const reduceMotion = useSyncExternalStore(subscribe, getSnapshot, () => false)
  return (
    <ReducedMotionContext.Provider value={reduceMotion}>
      <ReducedMotionConfig mode={reduceMotion ? ReduceMotion.Always : ReduceMotion.Never} />
      {children}
    </ReducedMotionContext.Provider>
  )
}
