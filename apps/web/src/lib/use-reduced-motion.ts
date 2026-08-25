import { useCallback, useState, useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Read the user's media preference without importing Motion into the shell.
 * Keep the MediaQueryList stable so its subscription survives rerenders.
 */
export function useReducedMotion(): boolean {
  const [preference] = useState<MediaQueryList | null>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null,
  )
  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      if (!preference) return () => {}
      if (typeof preference.addEventListener === 'function') {
        preference.addEventListener('change', notify)
        return () => preference.removeEventListener('change', notify)
      }
      // Safari before 14 exposes only the original MediaQueryList listener API.
      preference.addListener(notify)
      return () => preference.removeListener(notify)
    },
    [preference],
  )
  const snapshot = useCallback(() => preference?.matches ?? false, [preference])

  return useSyncExternalStore(subscribe, snapshot, () => false)
}
