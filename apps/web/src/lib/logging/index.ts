import { createLogger } from '@podium/logger'
import { pageSurface } from '@/lib/page-surface'
import { pageBuildDigest, pageBuildVersion, pageBundleVersion } from './build-version'
import { installWebLogging } from './install'
import { pageLogTransport } from './transport'

export { pageBuildVersion } from './build-version'
export { installGlobalHandlers } from './global-handlers'
export { installWebLogging, type LogTransport, type WebLoggingOptions } from './install'
export { pageLogTransport, trpcLogTransport } from './transport'

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
   * trace previously meant guessing the surface, and the guess mattered: a
   * `desktop-remote` webview has no service worker at all, so a whole family of
   * explanations for "Reload does nothing" cannot apply there, and nothing in
   * the log said which kind of page had been looking.
   *
   * Each field is a question somebody had to answer by hand:
   *
   *  - `surface` — web / desktop-remote / desktop-all-in-one / mobile.
   *  - `v`, `sourceDigest`, `bundle` — the product string, the source this HTML
   *    was built from, and the entry-chunk hash actually executing. The third is
   *    the only one that moves when a rebuild of one commit replaces the dist
   *    under a live page, which is exactly the case `assets === 'replaced'` is
   *    about.
   *  - `serviceWorker` — whether the container exists AT ALL, before any
   *    registration is attempted. `false` here is the complete explanation for a
   *    silent `web:sw` namespace, and its absence was previously indistinguishable
   *    from a registration that never got as far as failing.
   *  - `controller` — whether this document was loaded UNDER a worker. A page
   *    that boots uncontrolled is the stranded case the audit could not construct
   *    from logs, because nothing recorded it.
   */
  const serviceWorker = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  createLogger('web:boot').info('web client booted', {
    surface: pageSurface(),
    v: pageBuildVersion(),
    ...(pageBuildDigest() ? { sourceDigest: pageBuildDigest() } : {}),
    ...(pageBundleVersion() ? { bundle: pageBundleVersion() } : {}),
    ...(typeof navigator === 'undefined' ? {} : { userAgent: navigator.userAgent.slice(0, 256) }),
    serviceWorker: serviceWorker !== undefined,
    controller: serviceWorker?.controller?.state ?? 'none',
    ...(serviceWorker?.controller?.scriptURL
      ? { controllerScriptURL: serviceWorker.controller.scriptURL }
      : {}),
    origin: window.location.origin,
    path: window.location.pathname,
    ...(document.referrer ? { referrer: document.referrer } : {}),
  })
  return dispose
}
