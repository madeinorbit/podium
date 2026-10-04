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

/** Maximum wait for discovery, revalidation and worker takeover together. */
export const RELOAD_HANDSHAKE_BUDGET_MS = 2_000

/** `performance.now()` where it exists, so `elapsedMs` is not a wall-clock delta. */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export type ReloadHandshakePhase =
  | 'checking'
  | 'saving'
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
  reload: () => void | Promise<void>
  /** Load through the network entry after a failed or stalled handoff. */
  recover?: () => void | Promise<void>
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
    case 'saving':
      return 'Saving your changes before reloading…'
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
      return 'Saving your changes and loading the current interface…'
  }
}

function resetAllowed(phase: ReloadHandshakePhase): boolean {
  return phase === 'no-replacement' || phase === 'failed'
}

/** Revalidate and prefer the newest installing worker. Every browser wait is
 * bounded, including getRegistration and update. Recovery stops observation
 * before navigating, so late worker events cannot trigger another reload. */
export function startReloadHandshake(deps: ReloadHandshakeDeps): Promise<ReloadHandshakeResult> {
  const serviceWorker = deps.serviceWorker
  const initialController = serviceWorker?.controller ?? null
  const initialWaiting = deps.registration?.waiting ?? null
  const trigger = deps.trigger ?? 'panel'
  const startedAt = nowMs()
  let registration = deps.registration ?? null
  let revalidated = false
  let installing: Worker | null = null
  let selected: Worker | null = null
  let stopped = false
  let takeoverStarted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []
  const watched = new Set<Worker>()
  let resolveResult!: (result: ReloadHandshakeResult) => void
  const promise = new Promise<ReloadHandshakeResult>((resolve) => {
    resolveResult = resolve
  })
  const snapshot = () => snapshotOf(serviceWorker, registration, deps.waitingWorker)
  const emit = (phase: ReloadHandshakePhase, detail?: string, canReset = resetAllowed(phase)) => {
    const facts = snapshot()
    deps.onStatus?.({
      phase,
      message: statusMessage(phase),
      ...(detail ? { detail } : {}),
      canReset,
      snapshot: facts,
    })
    log.debug('service-worker reload handshake state', { trigger, phase, detail, ...facts })
  }
  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    for (const off of cleanups.splice(0)) off()
  }
  const result = (
    outcome: ReloadHandshakeOutcome,
    detail?: string,
    fields: Record<string, unknown> = {},
  ) => {
    const facts = snapshot()
    const record = {
      trigger,
      outcome,
      elapsedMs: Math.round(nowMs() - startedAt),
      ...fields,
      ...(detail ? { detail } : {}),
      ...facts,
    }
    if (outcome === 'reloading') log.info('reload handshake navigating', record)
    else log.warn('reload handshake finished without navigating', record)
    resolveResult({ outcome, snapshot: facts, ...(detail ? { detail } : {}) })
  }
  const navigate = async (
    recovery: boolean,
    detail?: string,
    signal?: 'controllerchange' | 'activated',
  ) => {
    if (stopped) return
    stop()
    emit(recovery ? 'resetting' : 'saving', detail, false)
    try {
      await (recovery && deps.recover ? deps.recover() : deps.reload())
      emit('reloading', detail, false)
      result('reloading', detail, {
        via: recovery || !selected ? 'direct' : 'handshake',
        ...(signal ? { signal } : {}),
        revalidated,
        superseded: initialWaiting !== null && selected !== initialWaiting,
        initiallyControlled: initialController !== null,
        selectedControlsPage: selected !== null && serviceWorker?.controller === selected,
        ...(recovery ? { recovery: true } : {}),
      })
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      emit('failed', failure)
      result('failed', failure)
    }
  }
  const fail = (detail: string, phase: 'failed' | 'no-replacement' = 'failed') => {
    if (stopped) return
    if (deps.recover) {
      void navigate(true, detail)
      return
    }
    stop()
    emit(phase, detail)
    result(phase, detail)
  }
  const watch = (worker: Worker) => {
    if (watched.has(worker)) return
    watched.add(worker)
    worker.addEventListener('statechange', progress)
    cleanups.push(() => worker.removeEventListener?.('statechange', progress))
  }
  function progress(): void {
    if (stopped || !revalidated || !registration) return
    if (selected) {
      if (selected.state === 'redundant') {
        fail('The replacement worker became redundant before takeover.')
        return
      }
      if (serviceWorker?.controller === selected) {
        void navigate(false, undefined, 'controllerchange')
        return
      }
      if (!initialController && selected.state === 'activated') {
        void navigate(false, undefined, 'activated')
        return
      }
      emit(
        selected.state === 'activating' || selected.state === 'activated'
          ? 'activating'
          : 'waiting',
      )
      return
    }
    if (installing) {
      if (installing.state === 'redundant') {
        fail('The replacement worker became redundant before takeover.')
        return
      }
      if (installing.state === 'installing') return
      if (registration.waiting && registration.waiting !== initialWaiting)
        selected = registration.waiting
      else if (
        ['activating', 'activated'].includes(installing.state) ||
        serviceWorker?.controller === installing
      )
        selected = installing
      else {
        fail('The installed replacement left the waiting slot before takeover.')
        return
      }
    } else if (serviceWorker?.controller && serviceWorker.controller !== initialController) {
      selected = serviceWorker.controller
    } else {
      selected = registration.waiting
    }
    if (!selected) {
      fail(
        'The registration update check found no waiting or installing replacement.',
        'no-replacement',
      )
      return
    }
    watch(selected)
    if (selected.state === 'redundant') {
      fail('The replacement worker became redundant before takeover.')
      return
    }
    emit('waiting')
    if (!takeoverStarted && registration.waiting === selected && selected.state === 'installed') {
      takeoverStarted = true
      try {
        selected.postMessage({ type: 'SKIP_WAITING' })
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
        return
      }
    }
    progress()
  }
  function onUpdateFound(): void {
    if (stopped || !registration) return
    if (registration.installing) {
      installing = registration.installing
      watch(installing)
    }
    progress()
  }
  const discover = async () => {
    if (!serviceWorker) {
      await navigate(false)
      return
    }
    emit('checking')
    if (!registration && serviceWorker.getRegistration) {
      registration = (await serviceWorker.getRegistration()) ?? null
      if (stopped) return
    }
    if (!registration) {
      if (serviceWorker.controller)
        fail('A service worker controls this page, but no registration was available.')
      else await navigate(false)
      return
    }
    registration.addEventListener('updatefound', onUpdateFound)
    serviceWorker.addEventListener('controllerchange', progress)
    cleanups.push(
      () => registration?.removeEventListener?.('updatefound', onUpdateFound),
      () => serviceWorker.removeEventListener?.('controllerchange', progress),
    )
    if (initialWaiting) watch(initialWaiting)
    onUpdateFound()
    await registration.update()
    if (stopped) return
    revalidated = true
    onUpdateFound()
  }
  const onDeadline = () =>
    fail(
      `The interface update did not finish within ${RELOAD_HANDSHAKE_BUDGET_MS} ms. ${snapshotDetail(snapshot())}`,
    )
  if (deps.setTimer) deps.setTimer(onDeadline, RELOAD_HANDSHAKE_BUDGET_MS)
  else timer = setTimeout(onDeadline, RELOAD_HANDSHAKE_BUDGET_MS)
  void discover().catch((error) =>
    fail(
      `The service-worker update check failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  )
  return promise
}
