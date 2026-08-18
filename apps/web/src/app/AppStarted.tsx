import { useLayoutEffect } from 'react'

export const APP_START_FALLBACK_ID = 'app-start-fallback'

/**
 * Remove the HTML-only fallback after React has actually committed a root.
 *
 * Calling this before `render` would silence the one failure the fallback can
 * report: JavaScript loaded, but the app threw before anything mounted.
 */
export function AppStarted(): null {
  useLayoutEffect(() => {
    document.getElementById(APP_START_FALLBACK_ID)?.remove()
  }, [])
  return null
}
