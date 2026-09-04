import { reloadLog as log } from '@/lib/logging/update-logs'

/**
 * THE HANDSHAKE NARRATES ITSELF TO THE OPERATOR, NOT JUST TO THE PANEL
 * (POD-3224).
 *
 * Every claim anyone has made about what a Reload click does was unobservable
 * before this. The phases below were logged at `info` on a client whose default
 * is `warn`, so they reached a console nobody was watching and were forwarded
 * nowhere; the four audit passes over "click Reload and nothing happens" each
 * reasoned about this function from source and reached different conclusions.
 *
 * The split:
 *
 *  - PHASES at `debug`. There are up to five per click and they are progress,
 *    not news. They reach the flight recorder, so a crash or a raise still has
 *    them.
 *  - the OUTCOME at `info` when it navigated, `warn` when it did not. That is
 *    one record per click — the volume of a person's finger — and it is the one
 *    an operator actually needs: which of `reloading` / `no-replacement` /
 *    `failed`, through which signal, with the worker slots as they stood.
 *
 * `trigger` says who asked, because the three callers fail differently: the
 * panel's button, the library's own prompt, and the stale-assets recovery path.
 */
export type ReloadPath = 'handshake' | 'direct' | 'waiting'

/** Who asked for this handshake. Carried on every record it writes. */
export type ReloadTrigger = 'panel' | 'library' | 'recovery'

/** A diagnostic threshold, never a navigation deadline. */
export const RELOAD_HANDSHAKE_BUDGET_MS = 2_000

/** `performance.now()` where it exists, so `elapsedMs` is not a wall-clock delta. */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

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
  removeEventListener?: ServiceWorker['removeEventListener']
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
  /** Who asked. Defaults to the panel's Reload button, which is most of them. */
  trigger?: ReloadTrigger
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
 * Revalidate before selecting a replacement. Installation outranks a parked
 * waiting worker. Controlled pages require identity proof of control; activation
 * alone only completes an initially uncontrolled page's handoff. The timer is
 * diagnostic and never authorizes navigation.
 */
export async function startReloadHandshake(
  deps: ReloadHandshakeDeps,
): Promise<ReloadHandshakeResult> {
  const serviceWorker = deps.serviceWorker
  const initialController = serviceWorker?.controller ?? null
  const setTimer = deps.setTimer ?? ((run, ms) => void window.setTimeout(run, ms))
  const trigger: ReloadTrigger = deps.trigger ?? 'panel'
  const startedAt = nowMs()
  let registration = deps.registration ?? null
  log.debug('reload handshake started', {
    trigger,
    ...snapshotOf(serviceWorker, deps.registration ?? null, deps.waitingWorker),
  })

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
    // A PHASE IS PROGRESS, NOT NEWS: `debug`, so the flight recorder and a raise
    // keep it and the steady forwarded stream stays one record per click.
    log.debug('service-worker reload handshake state', {
      trigger,
      phase,
      detail: detail ?? snapshotDetail(snapshot),
      ...snapshot,
    })
    return status
  }

  /**
   * THE OUTCOME, and the only line this function forwards by default.
   *
   * `no-replacement` and `failed` are `warn` because both are a Reload that did
   * not reload — the reported symptom — and an operator must not have to raise a
   * client to find out that it happened.
   */
  const result = (
    outcome: ReloadHandshakeOutcome,
    detail?: string,
    how?: { via: ReloadPath; signal?: 'controllerchange' | 'activated' },
  ): ReloadHandshakeResult => {
    const snapshot = snapshotOf(serviceWorker, registration, deps.waitingWorker)
    const fields = {
      trigger,
      outcome,
      ...(how ? { via: how.via } : {}),
      ...(how?.signal ? { signal: how.signal } : {}),
      ...(detail ? { detail } : {}),
      elapsedMs: Math.round(nowMs() - startedAt),
      ...snapshot,
    }
    if (outcome === 'reloading') log.info('reload handshake finished', fields)
    else log.warn('reload handshake finished without navigating', fields)
    return {
      outcome,
      snapshot,
      ...(detail ? { detail } : {}),
    }
  }

  const navigateDirect = (detail?: string): ReloadHandshakeResult => {
    log.info('reload handshake navigating', {
      trigger,
      outcome: 'reloading',
      via: 'direct',
      path: 'direct',
      revalidated: false,
      superseded: false,
      initiallyControlled: initialController !== null,
      selectedControlsPage: false,
      ...snapshotOf(serviceWorker, registration),
    })
    try {
      deps.reload()
      return {
        outcome: 'reloading',
        snapshot: snapshotOf(serviceWorker, registration),
        ...(detail ? { detail } : {}),
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      emit('failed', failure)
      return result('failed', failure)
    }
  }

  if (!serviceWorker) {
    emit('reloading', 'This page has no service-worker context; a direct reload is safe.', false)
    return navigateDirect()
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
      return navigateDirect(detail)
    }
  }

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
    return navigateDirect()
  }

  return discoverReplacement(
    deps,
    serviceWorker,
    registration,
    emit,
    result,
    setTimer,
    initialController,
  )
}

async function discoverReplacement(
  deps: ReloadHandshakeDeps,
  serviceWorker: Container,
  registration: Registration,
  emit: (phase: ReloadHandshakePhase, detail?: string, canReset?: boolean) => ReloadHandshakeStatus,
  result: (
    outcome: ReloadHandshakeOutcome,
    detail?: string,
    how?: { via: ReloadPath; signal?: 'controllerchange' | 'activated' },
  ) => ReloadHandshakeResult,
  setTimer: (run: () => void, ms: number) => void,
  initialController: Worker | null,
): Promise<ReloadHandshakeResult> {
  const initialWaiting = registration.waiting
  let revalidated = false
  let installing: Worker | null = null
  let selected: Worker | null = null
  let settled = false
  let takeoverStarted = false
  const cleanups: (() => void)[] = []
  const watched = new Set<Worker>()
  let resolveResult!: (value: ReloadHandshakeResult) => void
  const promise = new Promise<ReloadHandshakeResult>((resolve) => {
    resolveResult = resolve
  })
  const settle = (value: ReloadHandshakeResult): void => {
    if (settled) return
    settled = true
    for (const cleanup of cleanups) cleanup()
    resolveResult(value)
  }
  const fail = (detail: string): void => {
    emit('failed', detail)
    settle(result('failed', detail))
  }
  const finish = (signal: 'controllerchange' | 'activated'): void => {
    if (settled || !selected) return
    // Latch before calling the navigation seam, which can synchronously dispatch.
    settled = true
    for (const cleanup of cleanups) cleanup()
    emit('reloading', `Takeover observed through ${signal}.`, false)
    log.info('reload handshake navigating', {
      trigger: deps.trigger ?? 'panel',
      outcome: 'reloading',
      via: 'handshake',
      path: 'handshake',
      signal,
      revalidated,
      superseded: initialWaiting !== null && selected !== initialWaiting,
      initiallyControlled: initialController !== null,
      selectedState: selected.state,
      selectedScriptURL: selected.scriptURL,
      selectedControlsPage: serviceWorker.controller === selected,
      ...snapshotOf(serviceWorker, registration),
    })
    try {
      deps.reload()
      resolveResult({ outcome: 'reloading', snapshot: snapshotOf(serviceWorker, registration) })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      emit('failed', `The new interface activated, but reload failed: ${detail}`)
      resolveResult(result('failed', detail))
    }
  }
  const progress = (): void => {
    if (settled || !revalidated) return
    if (selected) {
      if (selected.state === 'redundant')
        return fail('The replacement worker became redundant before takeover.')
      if (serviceWorker.controller === selected) return finish('controllerchange')
      if (!initialController && selected.state === 'activated') return finish('activated')
      emit(
        selected.state === 'activating' || selected.state === 'activated'
          ? 'activating'
          : 'waiting',
      )
      return
    }
    if (installing) {
      if (installing.state === 'redundant')
        return fail('The replacement worker became redundant before takeover.')
      if (installing.state === 'installing') return
      // Re-read the waiting slot. Never message an object displaced from it.
      if (registration.waiting && registration.waiting !== initialWaiting) {
        selected = registration.waiting
      } else if (
        serviceWorker.controller === installing ||
        (!initialController && installing.state === 'activated')
      ) {
        selected = installing
      } else if (installing.state === 'activating' || installing.state === 'activated') {
        selected = installing
      } else {
        return fail('The installed replacement left the waiting slot before takeover.')
      }
    } else if (serviceWorker.controller && serviceWorker.controller !== initialController) {
      selected = serviceWorker.controller
    } else {
      selected = registration.waiting
    }
    if (!selected) {
      const detail = 'The registration update check found no waiting or installing replacement.'
      emit('no-replacement', detail)
      return settle(result('no-replacement', detail))
    }
    watch(selected)
    if (selected.state === 'redundant')
      return fail('The replacement worker became redundant before takeover.')
    emit('waiting')
    if (!takeoverStarted && registration.waiting === selected && selected.state === 'installed') {
      takeoverStarted = true
      try {
        selected.postMessage({ type: 'SKIP_WAITING' })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    }
    progress()
  }
  const watch = (worker: Worker): void => {
    if (watched.has(worker)) return
    watched.add(worker)
    worker.addEventListener('statechange', progress)
    cleanups.push(() => worker.removeEventListener?.('statechange', progress))
  }
  const onUpdateFound = (): void => {
    if (registration.installing) {
      installing = registration.installing
      watch(installing)
    }
    progress()
  }
  registration.addEventListener('updatefound', onUpdateFound)
  serviceWorker.addEventListener('controllerchange', progress)
  cleanups.push(
    () => registration.removeEventListener?.('updatefound', onUpdateFound),
    () => serviceWorker.removeEventListener?.('controllerchange', progress),
  )
  if (initialWaiting) watch(initialWaiting)
  onUpdateFound()
  setTimer(() => {
    if (settled) return
    const snapshot = snapshotOf(serviceWorker, registration)
    const detail = `Still waiting after ${RELOAD_HANDSHAKE_BUDGET_MS} ms. ${snapshotDetail(snapshot)}`
    log.warn('service worker takeover is still pending; waiting for a safe handoff', {
      via: 'waiting',
      budgetMs: RELOAD_HANDSHAKE_BUDGET_MS,
      ...snapshot,
    })
    emit(revalidated ? 'waiting' : 'checking', detail, true)
  }, RELOAD_HANDSHAKE_BUDGET_MS)
  try {
    await registration.update()
    revalidated = true
    onUpdateFound()
  } catch (error) {
    fail(
      `The service-worker update check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return promise
}
