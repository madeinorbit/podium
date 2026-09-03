import { swLog } from '@/lib/logging/update-logs'
import { serviceWorkerContainer } from '@/lib/sw-container'
import { readServedWorkerIdentity } from '@/lib/sw-identity'

/**
 * EVERY SERVICE-WORKER EVENT THIS PAGE OBSERVES, WRITTEN DOWN (POD-3224).
 *
 * The browser's worker lifecycle is the single largest unobserved input to the
 * update panel. `needRefresh` is set from it, `assets === 'replaced'` is
 * explained by it, and the reload handshake navigates on it — and until now the
 * only thing any log said about it was whichever `warn` the app happened to
 * emit afterwards. An audit of "click Reload forever" had to reason about
 * `updatefound` ordering entirely from library source, because no tab had ever
 * recorded one.
 *
 * WHAT IS AT WHICH LEVEL, and why:
 *
 *  - `info` — a worker's arrival, its state changes, and `controllerchange`.
 *    These are BOUNDED by releases, not by time: a page that is up to date and
 *    stays that way emits none of them for its whole life. That is what makes
 *    an `info` floor affordable here, and it is the property to protect if this
 *    ever grows a new line.
 *  - `warn` — a worker that went `redundant`, which is a replacement that
 *    failed to take over and is the shape behind a Reload that does nothing.
 *
 * WHICH WORKER, given they all share one `scriptURL`: every `updatefound` and
 * the registration itself carry the served script's identity — its hash and its
 * precache build revision (see `sw-identity.ts`) — and every transition carries
 * how long that worker has been observed. Together those answer the question the
 * first live traces could not: whether the worker that installs ~400 ms after
 * each landing is a byte-identical duplicate or a different build.
 *
 * Deliberately OBSERVE-ONLY. Nothing here calls `postMessage`, `update()` or
 * `reload()`; the listeners are added once per registration and never removed,
 * which is correct because the registration outlives the page and a duplicate
 * listener on the same worker object is what re-registering would produce.
 */

type ObservableWorker = Pick<ServiceWorker, 'addEventListener' | 'state'> & {
  scriptURL?: string
}

type ObservableRegistration = Pick<
  ServiceWorkerRegistration,
  'addEventListener' | 'installing' | 'waiting' | 'active'
> & {
  scope?: string
}

type ObservableContainer = Pick<ServiceWorkerContainer, 'addEventListener'> & {
  controller?: ObservableWorker | null
}

/** The three worker slots and the controller, as one flat set of fields. */
export function workerFacts(
  registration: ObservableRegistration | null | undefined,
  container: ObservableContainer | undefined,
): Record<string, unknown> {
  const slot = (name: string, worker: ObservableWorker | null | undefined) =>
    worker
      ? { [name]: worker.state, ...(worker.scriptURL ? { [`${name}URL`]: worker.scriptURL } : {}) }
      : { [name]: 'none' }
  return {
    ...slot('controller', container?.controller ?? null),
    ...slot('active', registration?.active ?? null),
    ...slot('installing', registration?.installing ?? null),
    ...slot('waiting', registration?.waiting ?? null),
  }
}

/**
 * Fire-and-forget: fetch the served script and log what it is.
 *
 * Never awaited by a caller and never allowed to reject. `when` says which
 * moment asked, so a boot identity and an updatefound identity can be lined up
 * — which is the whole comparison this exists for.
 */
function noteServedIdentity(when: 'registered' | 'updatefound'): void {
  void readServedWorkerIdentity().then((identity) => {
    swLog.info('served sw.js identity', { when, ...identity })
  })
}

/**
 * Watch one registration for the rest of the page's life.
 *
 * Idempotent per registration object: the PWA hook can hand the same one back
 * more than once, and a second set of listeners would double every line.
 */
const observed = new WeakSet<object>()

export function observeServiceWorker(
  registration: ObservableRegistration,
  container: ObservableContainer | undefined = serviceWorkerContainer() as unknown as
    | ObservableContainer
    | undefined,
): void {
  if (observed.has(registration)) return
  observed.add(registration)

  const watch = (worker: ObservableWorker, slot: 'installing' | 'waiting' | 'active'): void => {
    if (observed.has(worker)) return
    observed.add(worker)
    // WHEN THIS WORKER WAS FIRST SEEN, so every later transition can say how old
    // it is. The ~45 ms install that follows every landing is only recognisable
    // as suspicious because of this number.
    const firstSeen = Date.now()
    swLog.info('service worker seen', {
      slot,
      state: worker.state,
      ...(worker.scriptURL ? { scriptURL: worker.scriptURL } : {}),
    })
    worker.addEventListener('statechange', () => {
      const fields = {
        slot,
        state: worker.state,
        ageMs: Date.now() - firstSeen,
        ...(worker.scriptURL ? { scriptURL: worker.scriptURL } : {}),
        ...workerFacts(registration, container),
      }
      // `redundant` is the one transition that is news rather than progress: the
      // replacement this page was going to take over is gone, and a Reload click
      // will now find nothing to take over.
      if (worker.state === 'redundant') swLog.warn('service worker became redundant', fields)
      else swLog.info('service worker state changed', fields)
    })
  }

  registration.addEventListener('updatefound', () => {
    swLog.info('service worker updatefound', {
      ...workerFacts(registration, container),
    })
    // What the server is serving AT THIS INSTANT. Compared against the identity
    // logged at registration, this says whether the worker now installing is the
    // same bytes as the one that just took control.
    noteServedIdentity('updatefound')
    const installing = registration.installing
    if (installing) watch(installing, 'installing')
  })

  noteServedIdentity('registered')
  if (registration.installing) watch(registration.installing, 'installing')
  if (registration.waiting) watch(registration.waiting, 'waiting')
  if (registration.active) watch(registration.active, 'active')

  container?.addEventListener('controllerchange', () => {
    swLog.info('service worker controllerchange', workerFacts(registration, container))
  })
}
