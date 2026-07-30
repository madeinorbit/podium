// Imported by vite.config.ts, which Vite loads outside the app's module graph:
// bare '@podium/domain' would resolve to the package's unbuilt dist there, so
// reach the source directly (same as the resolve.alias entries in vite.config).
import { mobileEntryRedirect } from '../../packages/domain/src/mobile-entry'

/** Return the phone entry redirect for Vite's front door, if one applies. */
export function mobileRedirectLocation(
  rawUrl: string | undefined,
  userAgent: string | undefined,
  mobilePresent: boolean,
): string | null {
  const url = new URL(rawUrl ?? '/', 'http://podium.local')
  return mobileEntryRedirect({
    pathname: url.pathname,
    search: url.search,
    userAgent,
    mobilePresent,
  })
}

/**
 * Navigations the service worker must NOT answer from the precached desktop
 * shell. Matched by workbox against `pathname + search`, so patterns that mean
 * "exactly the root" need the `\?` branch to survive a query string.
 *
 * Two kinds of entry live here:
 *  - Live backend routes (/trpc, /health, …) and the Expo SPA at /mobile, which
 *    the shell must never shadow.
 *  - The redirect endpoints `/` and `/desktop`. These LOOK like they belong to
 *    the shell, which is exactly the trap: once the worker is installed it
 *    answers `/` from the precache and the server-side phone redirect never
 *    runs, so a phone that had ever opened the desktop app was stuck on it
 *    forever (POD-359). The cost is that the bare root needs the network — an
 *    installed shell no longer cold-starts offline at `/`, which is fine
 *    because the app is inert without its server anyway, and every deep link
 *    (/workspace, /session/x) still falls back to the cached shell.
 */
export const NAVIGATION_FALLBACK_DENYLIST = [
  // Anchored at the end (or a query string) so only these two exact endpoints
  // are withheld — /workspace and /desktops are ordinary SPA routes.
  /^\/(\?|$)/,
  /^\/desktop(\?|$)/,
  /^\/trpc/,
  /^\/health/,
  /^\/mobile/,
  /^\/files/,
  /^\/setup/,
  /^\/auth/,
  /^\/client/,
  /^\/daemon/,
]
