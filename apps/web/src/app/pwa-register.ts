import { useRegisterSW as useRegisterSWVirtual } from 'virtual:pwa-register/react'
import { serviceWorkerContainer } from '@podium/client-core/service-worker'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { swLog } from '@/lib/logging/update-logs'
import { observeServiceWorker, workerFacts } from '@/lib/sw-observer'
import { followNewWorker } from '@/lib/update-takeover'

/**
 * Keep the Vite virtual module behind a local seam for app code and tests —
 * and, since POD-3224, make everything it decides OBSERVABLE.
 *
 * The library is the page's second update actor. It sets `needRefresh` from a
 * `waiting` or externally-`installed` worker, and it reloads the tab itself when
 * a worker takes control. Neither was written down anywhere. On the reference
 * fleet the whole record of a macOS desktop client's registration was a single
 * bare `Script …/sw.js load failed` from the browser, with no way to tell
 * whether that was a page with no service-worker support, a registration that
 * never resolved, or a worker that installed and then went redundant.
 *
 * So each of the library's callbacks is wrapped:
 *
 *  - `onRegisteredSW` / `onRegisterError` — the OUTCOME, with the error when
 *    there is one, and the state of all three worker slots at that moment. It
 *    also starts {@link observeServiceWorker}, which is what gives the lifecycle
 *    events after registration a place to go.
 *  - `onNeedRefresh` — the latch that feeds the panel, with which worker set it.
 *  - `onNeedReload` — the library's OWN reload. Supplying this callback replaces
 *    the `window.location.reload()` the library would otherwise call. A screen
 *    in use defers it until the page is hidden (`update-takeover.ts`); any
 *    reload first preserves local drafts and queue commits. The library and
 *    the panel share a latch so takeover cannot navigate twice.
 *  - `onOfflineReady` — a first install rather than an update, which is the
 *    thing most easily mistaken for one.
 *
 * A caller's own handlers still run, after the log line: this wraps, it does not
 * intercept.
 */
export function useRegisterSW(options?: RegisterSWOptions) {
  // Never a bare `navigator.serviceWorker`: on an opaque origin that getter
  // THROWS rather than answering undefined (POD-3224 review).
  const container = serviceWorkerContainer()
  return useRegisterSWVirtual({
    ...options,
    onRegisteredSW(swUrl, registration) {
      if (registration) {
        swLog.info('service worker registered', {
          swUrl,
          scope: registration.scope,
          ...workerFacts(registration, container),
        })
        observeServiceWorker(registration, container)
      } else {
        // `register()` resolved with nothing: the browser accepted the script and
        // handed back no registration. Rare, and previously indistinguishable
        // from never having tried.
        swLog.warn('service worker registration resolved without a registration', { swUrl })
      }
      options?.onRegisteredSW?.(swUrl, registration)
    },
    onRegisterError(error: unknown) {
      // THE LINE THAT EXPLAINS THE macOS DESKTOP CASE. The container is present
      // there and the script fails to load; before this the only trace was the
      // browser's own bare "Script …/sw.js load failed" landing in `web:crash`
      // as an unhandled rejection, with no page, surface or scope attached.
      swLog.error('service worker registration failed', {
        available: container !== undefined,
        err: error,
      })
      options?.onRegisterError?.(error)
    },
    onNeedRefresh() {
      swLog.info('the library reported a new build is ready', workerFacts(undefined, container))
      options?.onNeedRefresh?.()
    },
    onOfflineReady() {
      swLog.info('service worker precached this build for offline use', { update: false })
      options?.onOfflineReady?.()
    },
    onNeedReload() {
      if (options?.onNeedReload) {
        options.onNeedReload()
        return
      }
      // The library would call `location.reload()` here, in front of whatever
      // the page shows. A screen in use keeps its document until it is hidden
      // (POD-7539); a hidden page or one with no signed-in screen reloads now,
      // after preserving drafts and queue commits.
      followNewWorker('workbox-controlling')
    },
  })
}
