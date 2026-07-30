import { mobileEntryRedirect } from '@podium/model'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'

/**
 * Second line of defence for the phone entry redirect [POD-359].
 *
 * The server redirects phones at `/` to the Expo app, but a service worker that
 * is already installed on the device answers the navigation from its precache
 * and the server never sees it. NAVIGATION_FALLBACK_DENYLIST in mobile-routing.ts
 * is the actual fix; this is the shell refusing to be the wrong app even when it
 * is the thing that got served.
 *
 * Note what this does NOT do: a phone still carrying the pre-fix worker is also
 * carrying the pre-fix bundle, so it runs the old boot code and this function
 * with it. That device recovers when the new worker takes over (registerType is
 * 'prompt', so on the update prompt or the next launch with no old client left),
 * not because of this file. What this buys is that the shell self-corrects from
 * then on, for any future navigation that reaches it by a route we did not
 * predict — the precache is not the only way to land here wrongly.
 *
 * Runs before React mounts and returns true when it has started navigating
 * away, so main.tsx can skip rendering a desktop UI nobody will see.
 */
export function redirectPhoneToMobileApp(): boolean {
  // The Tauri shell serves this same dist and owns its own window — it must
  // never navigate itself into the web mobile app, whatever its webview's UA.
  if (nativeDesktopBridge()) return false
  const target = mobileEntryRedirect({
    pathname: window.location.pathname,
    search: window.location.search,
    userAgent: window.navigator.userAgent,
    // The browser cannot probe for the Expo build, so it assumes it is there.
    // When it is not, the server bounces /mobile back to /?desktop=1 and that
    // marker suppresses this redirect on the next boot — one extra round trip
    // instead of a ping-pong (see desktopShellLocation).
    mobilePresent: true,
  })
  if (!target) return false
  // replace(), not assign(): the desktop shell must not sit in history behind
  // the mobile app, where Back would bounce straight into this redirect again.
  window.location.replace(target)
  return true
}
