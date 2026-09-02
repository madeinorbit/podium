import { useRegisterSW as useRegisterSWVirtual } from 'virtual:pwa-register/react'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { swLog } from '@/lib/logging/update-logs'
import { navigateReload } from '@/lib/navigate'
import { observeServiceWorker, workerFacts } from '@/lib/sw-observer'

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
 *    the `window.location.reload()` the library would otherwise call, with a
 *    call that does the same thing one line later; the navigation, its timing
 *    and its target are unchanged, and it is now attributable.
 *  - `onOfflineReady` — a first install rather than an update, which is the
 *    thing most easily mistaken for one.
 *
 * A caller's own handlers still run, after the log line: this wraps, it does not
 * intercept.
 */
export function useRegisterSW(options?: RegisterSWOptions) {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
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
      // THE LINE THAT WAS MISSING. The browser's console said the script failed
      // to load; nothing said which script, from which page, on which surface,
      // or with what error — and none of it was forwarded.
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
      // Exactly what the library does when this callback is absent — see the
      // `controlling` listener in vite-plugin-pwa's `register.ts` — with a line
      // in front of it. This is the second navigation actor the audit could
      // never see fire.
      navigateReload('workbox-controlling', 'a new worker took control of this page')
    },
  })
}
