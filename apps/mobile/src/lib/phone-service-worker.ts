/**
 * THE PHONE WEBSITE'S SERVICE WORKER (POD-7179).
 *
 * Without one, a reload of `/mobile` with no network failed before a line of
 * the app ran, although the device held its data in OPFS. The desktop shell has
 * had a precaching worker for a long time; this is the same worker for the
 * phone's dist, built by `scripts/generate-service-worker.ts` with the desktop
 * build's settings, and it updates through the same handshake.
 *
 * The pieces, all the desktop's:
 *
 *  - REGISTRATION at `/mobile/sw.js` with scope `/mobile`, so the page at
 *    `/mobile` itself is in scope (the server sends `Service-Worker-Allowed`
 *    for it). The desktop worker at `/` never answers `/mobile`
 *    (`NAVIGATION_FALLBACK_DENYLIST`), and the longer scope wins here anyway.
 *  - A NEW BUILD WAITS. The worker never skips waiting on its own, so a running
 *    page keeps the precache its lazy chunks come from. Refresh
 *    ({@link refreshPhoneBuild}) runs the shared reload handshake: revalidate,
 *    tell the waiting worker `SKIP_WAITING`, reload once it controls the page.
 *  - A TAKEOVER RELOADS. When a worker takes over a page that an older worker
 *    was already serving (another tab pressed Refresh), the page reloads: its
 *    old precache is gone and its next lazy chunk would not load. The library
 *    does this on the desktop; here it is {@link reloadOnce}'s shared latch, so
 *    the handshake and the takeover cannot navigate twice.
 *
 * Not in a development build: Metro's dev server serves no `sw.js`, and a
 * precache in front of a bundle being rebuilt is the wrong thing to have.
 */
import {
  type ReloadHandshakeResult,
  serviceWorkerContainer,
  startReloadHandshake,
} from '@podium/client-core/service-worker'
import { createLogger } from '@podium/logger'

export const PHONE_SERVICE_WORKER_URL = '/mobile/sw.js'
export const PHONE_SERVICE_WORKER_SCOPE = '/mobile'

const swLog = createLogger('mobile:sw')
const reloadLog = createLogger('mobile:reload')

type Container = NonNullable<ReturnType<typeof serviceWorkerContainer>>

export interface PhoneServiceWorkerEnv {
  container: Container | undefined
  location: Pick<Location, 'pathname' | 'reload'>
  /** A development build registers nothing. */
  dev: boolean
  /** Register now (the document has loaded) or once it has. */
  whenLoaded: (run: () => void) => void
}

function browserEnv(): PhoneServiceWorkerEnv | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  return {
    container: serviceWorkerContainer(),
    location: window.location,
    dev: typeof __DEV__ !== 'undefined' && __DEV__,
    whenLoaded: (run) => {
      // After `load`, so the worker's precache downloads do not compete with
      // the first paint for the network.
      if (document.readyState === 'complete') run()
      else window.addEventListener('load', run, { once: true })
    },
  }
}

let reloading = false
let registered: Promise<ServiceWorkerRegistration | undefined> | undefined

/** Reload this document, at most once, whoever asks first. */
export function reloadOnce(
  location: Pick<Location, 'reload'> | undefined = browserEnv()?.location,
) {
  if (reloading || !location) return
  reloading = true
  location.reload()
}

/** Register the phone's worker. Idempotent; resolves undefined when none is registered. */
export function registerPhoneServiceWorker(
  env: PhoneServiceWorkerEnv | undefined = browserEnv(),
): Promise<ServiceWorkerRegistration | undefined> {
  if (registered) return registered
  if (!env || env.dev || !env.container) {
    registered = Promise.resolve(undefined)
    return registered
  }
  const { container, location } = env
  // Only the served phone website: a harness page or a preview on another
  // path has no worker beside it.
  if (!location.pathname.startsWith(PHONE_SERVICE_WORKER_SCOPE)) {
    registered = Promise.resolve(undefined)
    return registered
  }
  const servedByWorker = container.controller !== null
  container.addEventListener('controllerchange', () => {
    // A first install claims an uncontrolled page: nothing it runs came from an
    // older precache, so there is nothing to reload for.
    if (!servedByWorker) return
    swLog.info('a new phone build took control of this page; reloading')
    reloadOnce(location)
  })
  registered = new Promise((resolve) => {
    env.whenLoaded(() => {
      container
        .register(PHONE_SERVICE_WORKER_URL, {
          scope: PHONE_SERVICE_WORKER_SCOPE,
          updateViaCache: 'none',
        })
        .then(
          (registration) => {
            swLog.info('service worker registered', {
              scope: registration.scope,
              controlled: container.controller !== null,
              waiting: registration.waiting?.state,
            })
            resolve(registration)
          },
          (error: unknown) => {
            swLog.error('service worker registration failed', { err: error })
            resolve(undefined)
          },
        )
    })
  })
  return registered
}

/**
 * Take the build the server now serves: the shared handshake swaps the waiting
 * worker in and reloads. A page no worker serves just reloads. A handoff that
 * fails or stalls unregisters the phone's worker and reloads from the network,
 * where the next load registers the current build's worker.
 */
export async function refreshPhoneBuild(
  env: PhoneServiceWorkerEnv | undefined = browserEnv(),
): Promise<ReloadHandshakeResult | undefined> {
  if (!env) return undefined
  const { container, location } = env
  if (!container) {
    reloadOnce(location)
    return undefined
  }
  const registration = (await registered) ?? null
  return await startReloadHandshake({
    log: reloadLog,
    serviceWorker: container,
    trigger: 'panel',
    registration,
    waitingWorker: registration?.waiting,
    reload: () => reloadOnce(location),
    recover: async () => {
      const current = registration ?? (await container.getRegistration(PHONE_SERVICE_WORKER_SCOPE))
      await current?.unregister().catch(() => false)
      reloadOnce(location)
    },
  })
}

/** Tests only: forget the registration and the reload latch. */
export function resetPhoneServiceWorkerForTests(): void {
  reloading = false
  registered = undefined
}
