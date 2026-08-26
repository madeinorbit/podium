import { createLogger } from '@podium/logger'

const log = createLogger('web:updates')

export type ReloadPath = 'handshake' | 'direct' | 'waiting'

/**
 * After this budget the missing takeover is operator-visible, but it is not a
 * license to navigate through the old worker.
 */
export const RELOAD_HANDSHAKE_BUDGET_MS = 2_000

export interface ReloadHandshakeDeps {
  /** `navigator.serviceWorker`, or undefined in a context that has none. */
  serviceWorker: Pick<ServiceWorkerContainer, 'addEventListener'> | undefined
  /** The replacement worker that is currently waiting for the user's approval. */
  waitingWorker:
    | Pick<ServiceWorker, 'addEventListener' | 'postMessage' | 'state'>
    | null
    | undefined
  /** Reload the document. */
  reload: () => void
  /** Injected for the test; production uses `window.setTimeout`. */
  setTimer?: (run: () => void, ms: number) => void
}

/**
 * Reload through the replacement worker, never through an elapsed-time guess.
 *
 * A waiting worker may spend arbitrarily long in `activating`: its activate
 * event owns cache cleanup and `clientsClaim()`, and both are allowed to extend
 * the event with `waitUntil`. Reloading before either `controllerchange` or the
 * worker's `activated` state can therefore navigate through the old worker and
 * return the old precached shell. Once activated, a navigation is safe even in
 * a browser that did not deliver `controllerchange`: the registration's active
 * worker owns the next navigation.
 *
 * POD-2762 made the old outcomes distinguishable: takeover was info, while a
 * worker that missed the two-second fallback was warn. Keep that diagnostic
 * asymmetry, but do not let the deadline navigate. The HTTPS service-worker
 * path proved activation can legitimately take longer than the old budget.
 *
 * With no waiting worker there is no handoff to await. That is the ordinary
 * browser/server-only case, and it reloads directly.
 */
export function startReloadHandshake(deps: ReloadHandshakeDeps): void {
  const waiting = deps.waitingWorker
  if (!deps.serviceWorker || !waiting) {
    log.info(
      deps.serviceWorker
        ? 'no waiting service worker; reloading directly'
        : 'no service worker in this context; reloading directly',
      {
        via: 'direct' satisfies ReloadPath,
        serviceWorkerAvailable: deps.serviceWorker !== undefined,
      },
    )
    deps.reload()
    return
  }

  const setTimer = deps.setTimer ?? ((run, ms) => void window.setTimeout(run, ms))
  let settled = false
  const finish = (signal: 'controllerchange' | 'activated'): void => {
    if (settled) return
    settled = true
    log.info('replacement service worker is ready; reloading onto the new build', {
      via: 'handshake' satisfies ReloadPath,
      signal,
    })
    deps.reload()
  }

  deps.serviceWorker.addEventListener('controllerchange', () => finish('controllerchange'), {
    once: true,
  })
  waiting.addEventListener('statechange', () => {
    if (waiting.state === 'activated') finish('activated')
    if (waiting.state === 'redundant' && !settled) {
      settled = true
      log.warn('replacement service worker became redundant before takeover; not reloading', {
        via: 'waiting' satisfies ReloadPath,
      })
    }
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
  setTimer(() => {
    if (settled) return
    log.warn('service worker did not take control in time; continuing to wait for a safe handoff', {
      via: 'waiting' satisfies ReloadPath,
      budgetMs: RELOAD_HANDSHAKE_BUDGET_MS,
    })
  }, RELOAD_HANDSHAKE_BUDGET_MS)
}
