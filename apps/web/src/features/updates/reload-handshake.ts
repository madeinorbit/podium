import { createLogger } from '@podium/logger'

const log = createLogger('web:updates')

export type ReloadPath = 'handshake' | 'direct' | 'waiting'

/** A diagnostic threshold, never a navigation deadline. */
export const RELOAD_HANDSHAKE_BUDGET_MS = 2_000

export type ReloadHandshakePhase =
  | 'checking'
  | 'waiting'
  | 'activating'
  | 'reloading'
  | 'no-replacement'
  | 'failed'
  | 'resetting'

export interface ServiceWorkerSnapshot {
  available: boolean
  controlled: boolean
  controller?: ServiceWorkerState
  active?: ServiceWorkerState
  installing?: ServiceWorkerState
  waiting?: ServiceWorkerState
  controllerScriptURL?: string
  activeScriptURL?: string
  installingScriptURL?: string
  waitingScriptURL?: string
}

export interface ReloadHandshakeStatus {
  phase: ReloadHandshakePhase
  message: string
  detail?: string
  canReset: boolean
  snapshot: ServiceWorkerSnapshot
}

export type ReloadHandshakeOutcome = 'reloading' | 'no-replacement' | 'failed'

export interface ReloadHandshakeResult {
  outcome: ReloadHandshakeOutcome
  snapshot: ServiceWorkerSnapshot
  detail?: string
}

type Worker = Pick<ServiceWorker, 'addEventListener' | 'postMessage' | 'state'> & {
  scriptURL?: string
}

type Registration = Pick<
  ServiceWorkerRegistration,
  'addEventListener' | 'update' | 'waiting' | 'installing' | 'active'
> & {
  removeEventListener?: ServiceWorkerRegistration['removeEventListener']
}

type Container = Pick<ServiceWorkerContainer, 'addEventListener'> & {
  controller?: Worker | null
  getRegistration?: () => Promise<Registration | undefined>
  removeEventListener?: ServiceWorkerContainer['removeEventListener']
}

export interface ReloadHandshakeDeps {
  /** `navigator.serviceWorker`, or undefined in a context that has none. */
  serviceWorker: Container | undefined
  /** The registration currently known by the PWA hook, when there is one. */
  registration?: Registration | null
  /** A replacement worker already reported by the PWA hook. */
  waitingWorker?: Worker | null
  /** Reload the document after a safe takeover, or for an uncontrolled page. */
  reload: () => void
  /** Called whenever the observed service-worker facts change. */
  onStatus?: (status: ReloadHandshakeStatus) => void
  /** Injected for tests; production uses `window.setTimeout`. */
  setTimer?: (run: () => void, ms: number) => void
}

function workerState(worker: Worker | null | undefined): ServiceWorkerState | undefined {
  return worker?.state
}

function workerURL(worker: Worker | null | undefined): string | undefined {
  return worker?.scriptURL || undefined
}

function snapshotOf(
  serviceWorker: Container | undefined,
  registration: Registration | null | undefined,
  waitingWorker?: Worker | null,
): ServiceWorkerSnapshot {
  const controller = serviceWorker?.controller ?? null
  const active = registration?.active ?? null
  const installing = registration?.installing ?? null
  const waiting = registration?.waiting ?? waitingWorker ?? null
  return {
    available: serviceWorker !== undefined,
    controlled: controller !== null,
    ...(workerState(controller) ? { controller: workerState(controller) } : {}),
    ...(workerState(active) ? { active: workerState(active) } : {}),
    ...(workerState(installing) ? { installing: workerState(installing) } : {}),
    ...(workerState(waiting) ? { waiting: workerState(waiting) } : {}),
    ...(workerURL(controller) ? { controllerScriptURL: workerURL(controller) } : {}),
    ...(workerURL(active) ? { activeScriptURL: workerURL(active) } : {}),
    ...(workerURL(installing) ? { installingScriptURL: workerURL(installing) } : {}),
    ...(workerURL(waiting) ? { waitingScriptURL: workerURL(waiting) } : {}),
  }
}

function snapshotDetail(snapshot: ServiceWorkerSnapshot): string {
  const state = (name: string, value: ServiceWorkerState | undefined, url?: string): string =>
    `${name}=${value ?? 'none'}${url ? ` (${url})` : ''}`
  return [
    `controlled=${snapshot.controlled}`,
    state('controller', snapshot.controller, snapshot.controllerScriptURL),
    state('active', snapshot.active, snapshot.activeScriptURL),
    state('installing', snapshot.installing, snapshot.installingScriptURL),
    state('waiting', snapshot.waiting, snapshot.waitingScriptURL),
  ].join(' · ')
}

function statusMessage(phase: ReloadHandshakePhase): string {
  switch (phase) {
    case 'checking':
      return 'Checking for a service-worker replacement…'
    case 'waiting':
      return 'A new interface is installed and waiting to take over.'
    case 'activating':
      return 'Activating the new interface…'
    case 'reloading':
      return 'The new interface is active. Reloading…'
    case 'no-replacement':
      return 'No replacement interface was found.'
    case 'failed':
      return 'The interface update could not take over.'
    case 'resetting':
      return 'Resetting the cached interface…'
  }
}

function resetAllowed(phase: ReloadHandshakePhase): boolean {
  return phase === 'no-replacement' || phase === 'failed'
}

/**
 * Observe the browser's actual service-worker lifecycle before navigating.
 *
 * A waiting worker is asked to skip waiting, then owns the handoff: either its
 * `activated` state or the container's `controllerchange` makes navigation
 * safe. If no worker is waiting, `registration.update()` performs a real check
 * and its `updatefound`/`statechange` events are observed. A two-second timer
 * only makes a slow handoff visible; it never navigates through an unknown
 * worker or silently discards the diagnostic.
 */
export async function startReloadHandshake(
  deps: ReloadHandshakeDeps,
): Promise<ReloadHandshakeResult> {
  const serviceWorker = deps.serviceWorker
  const setTimer = deps.setTimer ?? ((run, ms) => void window.setTimeout(run, ms))
  let registration = deps.registration ?? null

  const emit = (
    phase: ReloadHandshakePhase,
    detail?: string,
    canReset = resetAllowed(phase),
  ): ReloadHandshakeStatus => {
    const snapshot = snapshotOf(serviceWorker, registration, deps.waitingWorker)
    const status: ReloadHandshakeStatus = {
      phase,
      message: statusMessage(phase),
      ...(detail ? { detail } : {}),
      canReset,
      snapshot,
    }
    deps.onStatus?.(status)
    log.info('service-worker reload handshake state', {
      phase,
      detail: detail ?? snapshotDetail(snapshot),
      ...snapshot,
    })
    return status
  }

  const result = (outcome: ReloadHandshakeOutcome, detail?: string): ReloadHandshakeResult => ({
    outcome,
    snapshot: snapshotOf(serviceWorker, registration, deps.waitingWorker),
    ...(detail ? { detail } : {}),
  })

  if (!serviceWorker) {
    emit('reloading', 'This page has no service-worker context; a direct reload is safe.', false)
    deps.reload()
    return result('reloading')
  }

  emit('checking')

  if (!registration && serviceWorker.getRegistration) {
    try {
      registration = (await serviceWorker.getRegistration()) ?? null
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (serviceWorker.controller) {
        emit('failed', `The controlled page could not inspect its registration: ${detail}`)
        return result('failed', detail)
      }
      emit('reloading', `No registration was found; a direct reload is safe. ${detail}`, false)
      deps.reload()
      return result('reloading', detail)
    }
  }

  const waiting = registration?.waiting ?? deps.waitingWorker ?? null
  if (waiting)
    return observeTakeover(deps, serviceWorker, registration, waiting, emit, result, setTimer)

  if (!registration) {
    if (serviceWorker.controller) {
      const detail = 'A service worker controls this page, but no registration was available.'
      emit('failed', detail)
      return result('failed', detail)
    }
    emit(
      'reloading',
      'No service-worker registration controls this page; a direct reload is safe.',
      false,
    )
    deps.reload()
    return result('reloading')
  }

  return discoverReplacement(deps, serviceWorker, registration, emit, result, setTimer)
}

async function discoverReplacement(
  deps: ReloadHandshakeDeps,
  serviceWorker: Container,
  registration: Registration,
  emit: (phase: ReloadHandshakePhase, detail?: string, canReset?: boolean) => ReloadHandshakeStatus,
  result: (outcome: ReloadHandshakeOutcome, detail?: string) => ReloadHandshakeResult,
  setTimer: (run: () => void, ms: number) => void,
): Promise<ReloadHandshakeResult> {
  let settled = false
  let slowTimerArmed = false
  let takeoverStarted = false
  let resolveResult: ((value: ReloadHandshakeResult) => void) | undefined

  const promise = new Promise<ReloadHandshakeResult>((resolve) => {
    resolveResult = resolve
  })

  const settle = (value: ReloadHandshakeResult): void => {
    if (settled) return
    settled = true
    resolveResult?.(value)
  }

  const armSlowTimer = (): void => {
    if (slowTimerArmed) return
    slowTimerArmed = true
    setTimer(() => {
      if (!settled) {
        const snapshot = snapshotOf(serviceWorker, registration)
        const detail = `Still waiting after ${RELOAD_HANDSHAKE_BUDGET_MS} ms. ${snapshotDetail(snapshot)}`
        log.warn('service worker takeover is still pending; waiting for a safe handoff', {
          via: 'waiting' satisfies ReloadPath,
          budgetMs: RELOAD_HANDSHAKE_BUDGET_MS,
          ...snapshot,
        })
        const phase = snapshot.installing === 'activating' ? 'activating' : 'waiting'
        emit(phase, detail, true)
      }
    }, RELOAD_HANDSHAKE_BUDGET_MS)
  }

  const beginTakeover = (worker: Worker): void => {
    if (settled || takeoverStarted) return
    takeoverStarted = true
    void observeTakeover(deps, serviceWorker, registration, worker, emit, result, setTimer, settle)
  }
  const watchInstalling = (worker: Worker): void => {
    const onStateChange = (): void => {
      if (settled) return
      if (worker.state === 'installed') {
        const waiting = registration.waiting ?? worker
        beginTakeover(waiting)
        return
      }
      if (worker.state === 'activating') {
        emit('activating', snapshotDetail(snapshotOf(serviceWorker, registration, worker)))
      }
      if (worker.state === 'activated') {
        beginTakeover(worker)
      }
      if (worker.state === 'redundant') {
        const detail = `The replacement worker became redundant before takeover. ${snapshotDetail(snapshotOf(serviceWorker, registration, worker))}`
        emit('failed', detail)
        settle(result('failed', detail))
      }
    }
    worker.addEventListener('statechange', onStateChange)
    armSlowTimer()
    onStateChange()
  }

  const onUpdateFound = (): void => {
    const installing = registration.installing
    if (installing) watchInstalling(installing)
  }
  registration.addEventListener('updatefound', onUpdateFound)
  if (registration.installing) watchInstalling(registration.installing)

  try {
    await registration.update()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    emit('failed', `The service-worker update check failed: ${detail}`)
    settle(result('failed', detail))
    return promise
  }

  const waiting = registration.waiting
  if (waiting) {
    beginTakeover(waiting)
    return promise
  }

  // update() normally fires updatefound before resolving. Give that callback
  // one microtask to expose an installing worker before declaring no update.
  await Promise.resolve()
  if (settled) return promise
  if (registration.waiting) {
    beginTakeover(registration.waiting)
    return promise
  }
  if (registration.installing) {
    watchInstalling(registration.installing)
    return promise
  }

  const detail = 'The registration update check found no waiting or installing replacement.'
  emit('no-replacement', detail)
  settle(result('no-replacement', detail))
  return promise
}

async function observeTakeover(
  deps: ReloadHandshakeDeps,
  serviceWorker: Container,
  registration: Registration | null,
  waiting: Worker,
  emit: (phase: ReloadHandshakePhase, detail?: string, canReset?: boolean) => ReloadHandshakeStatus,
  result: (outcome: ReloadHandshakeOutcome, detail?: string) => ReloadHandshakeResult,
  setTimer: (run: () => void, ms: number) => void,
  settleOverride?: (value: ReloadHandshakeResult) => void,
): Promise<ReloadHandshakeResult> {
  let settled = false
  let resolveResult: ((value: ReloadHandshakeResult) => void) | undefined
  const promise = new Promise<ReloadHandshakeResult>((resolve) => {
    resolveResult = resolve
  })
  const settle = (value: ReloadHandshakeResult): void => {
    if (settled) return
    settled = true
    settleOverride?.(value)
    resolveResult?.(value)
  }

  const finish = (signal: 'controllerchange' | 'activated'): void => {
    if (settled) return
    emit('reloading', `Takeover observed through ${signal}.`, false)
    log.info('replacement service worker is ready; reloading onto the new build', {
      via: 'handshake' satisfies ReloadPath,
      signal,
      ...snapshotOf(serviceWorker, registration, waiting),
    })
    try {
      deps.reload()
      settle(result('reloading'))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      emit('failed', `The new interface activated, but reload failed: ${detail}`)
      settle(result('failed', detail))
    }
  }

  serviceWorker.addEventListener('controllerchange', () => finish('controllerchange'))
  waiting.addEventListener('statechange', () => {
    if (waiting.state === 'activated') finish('activated')
    else if (waiting.state === 'activating') {
      emit('activating', snapshotDetail(snapshotOf(serviceWorker, registration, waiting)))
    } else if (waiting.state === 'redundant' && !settled) {
      const detail = `The replacement worker became redundant before takeover. ${snapshotDetail(snapshotOf(serviceWorker, registration, waiting))}`
      emit('failed', detail)
      settle(result('failed', detail))
    }
  })

  if (waiting.state === 'activated') {
    finish('activated')
    return promise
  }
  if (waiting.state === 'activating') {
    emit('activating', snapshotDetail(snapshotOf(serviceWorker, registration, waiting)))
  } else {
    emit('waiting', snapshotDetail(snapshotOf(serviceWorker, registration, waiting)), true)
  }

  try {
    waiting.postMessage({ type: 'SKIP_WAITING' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    emit('failed', `The replacement worker could not be asked to activate: ${detail}`)
    settle(result('failed', detail))
    return promise
  }

  setTimer(() => {
    if (settled) return
    const snapshot = snapshotOf(serviceWorker, registration, waiting)
    const detail = `Still waiting after ${RELOAD_HANDSHAKE_BUDGET_MS} ms. ${snapshotDetail(snapshot)}`
    log.warn('service worker did not take control in time; continuing to wait for a safe handoff', {
      via: 'waiting' satisfies ReloadPath,
      budgetMs: RELOAD_HANDSHAKE_BUDGET_MS,
      ...snapshot,
    })
    emit(waiting.state === 'activating' ? 'activating' : 'waiting', detail, true)
  }, RELOAD_HANDSHAKE_BUDGET_MS)

  return promise
}
