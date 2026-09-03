import { createLogger } from '@podium/logger'
import { pageSurface } from '@/lib/page-surface'
import { serviceWorkerAvailability, serviceWorkerContainer } from '@/lib/sw-container'
import { pageBuildDigest, pageBuildVersion, pageBundleVersion } from './build-version'
import { installWebLogging } from './install'
import { pageLogTransport } from './transport'

export { pageBuildVersion } from './build-version'
export { installGlobalHandlers } from './global-handlers'
export { installWebLogging, type LogTransport, type WebLoggingOptions } from './install'
export { pageLogTransport, trpcLogTransport, unloadLogTransport } from './transport'

/**
 * Start client logging for the real page. Called from `main.tsx` BEFORE React
 * mounts, so a throw during the first render is caught by the global handlers
 * rather than lost to the console of a user who is not looking at it.
 *
 * The product version is resolved synchronously inside `installWebLogging`
 * via {@link pageBuildVersion}, so the first record already carries the
 * same `v` as About and Update.
 */
export function startWebLogging(): () => void {
  const dispose = installWebLogging({ transport: pageLogTransport() })
  /**
   * THE FIRST LINE OF THE FLIGHT RECORDER (POD-1935), AND THE ONE THAT SAYS
   * WHICH PAGE EVERY LATER LINE IS ABOUT (POD-3224).
   *
   * `web:boot` is floored at `info` (see `update-logs.ts`), so unlike before
   * this line is FORWARDED — which is the point. Reading a forwarded update
   * trace previously meant guessing which kind of page had been looking, and
   * every guess about a service worker turns on that answer.
   *
   * Each field is a question somebody had to answer by hand:
   *
   *  - `surface` — web / desktop-remote / desktop-all-in-one / mobile.
   *  - `v`, `sourceDigest`, `bundle` — the product string, the source this HTML
   *    was built from, and the entry-chunk hash actually executing. The third is
   *    the only one that moves when a rebuild of one commit replaces the dist
   *    under a live page, which is exactly the case `assets === 'replaced'` is
   *    about.
   *  - `serviceWorker` — whether the container is reachable, and when it is not,
   *    WHICH of the three reasons: no navigator, no such property, or a getter
   *    that threw (an opaque origin). Note that `available` is NOT a claim that
   *    a worker exists: on the macOS desktop webview the API is present and the
   *    registration then fails to load its script, which is a different fault
   *    with a different fix, and `web:sw`'s registration line is what tells them
   *    apart.
   *  - `controller` — whether this document was loaded UNDER a worker. A page
   *    that boots uncontrolled is the stranded case the audit could not construct
   *    from logs, because nothing recorded it.
   */
  const serviceWorker = serviceWorkerContainer()
  const availability = serviceWorkerAvailability()
  let controller: ServiceWorker | null | undefined
  try {
    controller = serviceWorker?.controller
  } catch {
    // Same opaque-origin hazard one level down; the boot record must not be the
    // thing that throws at module scope.
    controller = undefined
  }
  createLogger('web:boot').info('web client booted', {
    surface: pageSurface(),
    v: pageBuildVersion(),
    ...(pageBuildDigest() ? { sourceDigest: pageBuildDigest() } : {}),
    ...(pageBundleVersion() ? { bundle: pageBundleVersion() } : {}),
    ...(typeof navigator === 'undefined' ? {} : { userAgent: navigator.userAgent.slice(0, 256) }),
    serviceWorker: availability,
    controller: controller?.state ?? 'none',
    ...(controller?.scriptURL ? { controllerScriptURL: controller.scriptURL } : {}),
    origin: window.location.origin,
    path: window.location.pathname,
    ...(document.referrer ? { referrer: document.referrer } : {}),
  })
  return dispose
}
