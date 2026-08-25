import { createLogger } from '@podium/logger'

const log = createLogger('web:updates')

/**
 * WHICH RELOAD JUST HAPPENED — AND WHY NOBODY COULD TELL (POD-2762).
 *
 * ---------------------------------------------------------------------------
 * THE DESIGNED PATH HAD NEVER RUN
 * ---------------------------------------------------------------------------
 *
 * Pressing Reload in the update panel is supposed to be a handshake, not a
 * refresh: tell the waiting service worker to stop waiting, let it activate and
 * claim this tab (`clientsClaim`), and reload once it is in control — so the
 * page comes back on the new build in ONE navigation instead of two. The timer
 * beside it exists only for the tab that never gets claimed.
 *
 * Every hands-on test of that button has been driven from a plain-HTTP sandbox
 * URL, where `navigator.serviceWorker` is not merely idle but UNDEFINED. There
 * was no worker to message, nothing to claim the tab, and no `controllerchange`
 * to wait for — so the handshake was two no-ops and a two-second sleep, and the
 * reload that followed was always, invariably, the fallback. The button worked,
 * which is exactly why nobody looked: the outcome is identical from the outside,
 * and only the timing differs.
 *
 * ---------------------------------------------------------------------------
 * SO THE PATH SAYS ITS OWN NAME
 * ---------------------------------------------------------------------------
 *
 * The two outcomes are not equally good news and must not log alike:
 *
 *   - `handshake` is the design working. `info`, because it is unremarkable.
 *   - `fallback` means the worker never took control within the budget. On a
 *     page with no service worker at all that is expected and correct; on one
 *     that has one, it means the swap did not take, and the reload is papering
 *     over it. `warn`, because it is the only trace that would ever say so.
 *
 * That asymmetry is the whole instrument. A reload that happens for the wrong
 * reason now leaves a record; before this it looked exactly like one that
 * worked.
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST NOT CHANGE
 * ---------------------------------------------------------------------------
 *
 * The fallback STAYS. A normal browser tab that the new worker never claims
 * still has to be able to reload, and removing the timer to make the handshake
 * look better would strand exactly that tab. And nothing here may reach for
 * `skipWaiting: true` to make the handshake fire sooner: a worker that activates
 * under a running tab purges the precache that tab's already-loaded bundle is
 * still asking chunks from, which is the 404 class POD-2721 fixed.
 */
export type ReloadPath = 'handshake' | 'fallback'

/**
 * How long to wait for the worker to take control before reloading anyway.
 *
 * Named rather than inlined because it is the discriminator: the handshake
 * lands in tens of milliseconds, so a reload at the budget is not "a slow
 * handshake", it is the other path.
 */
export const RELOAD_HANDSHAKE_BUDGET_MS = 2_000

export interface ReloadHandshakeDeps {
  /** `navigator.serviceWorker`, or undefined in a context that has none. */
  serviceWorker: Pick<ServiceWorkerContainer, 'addEventListener'> | undefined
  /** Ask the waiting worker to skip waiting (vite-plugin-pwa's registration). */
  requestTakeover: () => void
  /** Reload the document. */
  reload: () => void
  /** Injected for the test; production uses `window.setTimeout`. */
  setTimer?: (run: () => void, ms: number) => void
}

/**
 * Start the takeover and reload once — by whichever path gets there first.
 *
 * Idempotent by construction: both paths funnel through one latch, so a
 * handshake that lands at 1,999 ms cannot be followed by a second reload from
 * the timer. That mattered less when the handshake never ran.
 */
export function startReloadHandshake(deps: ReloadHandshakeDeps): void {
  const setTimer = deps.setTimer ?? ((run, ms) => void window.setTimeout(run, ms))
  let reloaded = false
  const finish = (via: ReloadPath): void => {
    if (reloaded) return
    reloaded = true
    if (via === 'handshake') {
      log.info('new service worker took control; reloading onto the new build', { via })
    } else {
      log.warn(
        deps.serviceWorker
          ? 'service worker did not take control in time; reloading without the handshake'
          : 'no service worker in this context; reloading without the handshake',
        { via, budgetMs: RELOAD_HANDSHAKE_BUDGET_MS },
      )
    }
    deps.reload()
  }

  // `controllerchange` is the browser's own statement that a different worker is
  // now in charge of this page, which is the event the whole design is waiting
  // for. `once` because a second one cannot mean anything to a page that is
  // already navigating away.
  deps.serviceWorker?.addEventListener('controllerchange', () => finish('handshake'), {
    once: true,
  })
  deps.requestTakeover()
  setTimer(() => finish('fallback'), RELOAD_HANDSHAKE_BUDGET_MS)
}
