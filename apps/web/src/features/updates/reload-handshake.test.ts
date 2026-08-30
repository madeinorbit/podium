import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELOAD_HANDSHAKE_BUDGET_MS,
  type ReloadHandshakeDeps,
  type ReloadHandshakeStatus,
  startReloadHandshake,
} from './reload-handshake'

type Listener = () => void

function eventTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const current = listeners.get(type) ?? new Set<Listener>()
      current.add(listener as Listener)
      listeners.set(type, current)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener as Listener)
    },
    dispatch(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
  }
}

function worker(initial: ServiceWorkerState = 'installed') {
  const events = eventTarget()
  const postMessage = vi.fn()
  let state = initial
  const value = {
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    postMessage,
    scriptURL: 'https://podium.test/sw.js',
    get state() {
      return state
    },
    setState(next: ServiceWorkerState) {
      state = next
      events.dispatch('statechange')
    },
  }
  return { worker: value, postMessage, setState: value.setState }
}

function registration(
  options: {
    waiting?: ReturnType<typeof worker>['worker'] | null
    installing?: ReturnType<typeof worker>['worker'] | null
    onUpdate?: () => void | Promise<void>
  } = {},
) {
  const events = eventTarget()
  let waiting = options.waiting ?? null
  let installing = options.installing ?? null
  const update = vi.fn(async () => {
    await Promise.resolve()
    await options.onUpdate?.()
  })
  const value = {
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    update,
    get waiting() {
      return waiting
    },
    get installing() {
      return installing
    },
    active: null,
    setWaiting(next: ReturnType<typeof worker>['worker'] | null) {
      waiting = next
    },
    setInstalling(next: ReturnType<typeof worker>['worker'] | null) {
      installing = next
    },
    dispatchUpdateFound() {
      events.dispatch('updatefound')
    },
  }
  return {
    registration: value,
    update,
    setWaiting: value.setWaiting,
    setInstalling: value.setInstalling,
    dispatchUpdateFound: value.dispatchUpdateFound,
  }
}

function harness(
  options: {
    withContainer?: boolean
    withWaiting?: boolean
    withRegistration?: boolean
    controlled?: boolean
    update?: () => void | Promise<void>
  } = {},
) {
  const containerEvents = eventTarget()
  const replacement = worker()
  const reg = registration({
    waiting: options.withWaiting === false ? null : replacement.worker,
    onUpdate: options.update,
  })
  const reload = vi.fn()
  const statuses: ReloadHandshakeStatus[] = []
  let fireTimer: (() => void) | undefined
  const controller = options.controlled ? worker('activated').worker : null
  const serviceWorker =
    options.withContainer === false
      ? undefined
      : ({
          addEventListener: containerEvents.addEventListener,
          removeEventListener: containerEvents.removeEventListener,
          controller,
        } as ReloadHandshakeDeps['serviceWorker'])
  const promise = startReloadHandshake({
    serviceWorker,
    registration:
      options.withRegistration === false
        ? undefined
        : (reg.registration as unknown as ReloadHandshakeDeps['registration']),
    waitingWorker: options.withWaiting === false ? null : replacement.worker,
    reload,
    onStatus: (status) => statuses.push(status),
    setTimer: (run, ms) => {
      expect(ms).toBe(RELOAD_HANDSHAKE_BUDGET_MS)
      fireTimer = run
    },
  })
  return {
    containerEvents,
    replacement,
    registration: reg,
    reload,
    statuses,
    promise,
    fireTimer: () => fireTimer?.(),
  }
}

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => logged.push(record) })
})

afterEach(() => {
  vi.useRealTimers()
  resetLogging()
})

describe('startReloadHandshake', () => {
  it('waits for a slow replacement worker instead of reloading the old shell on a timer', async () => {
    const run = harness()

    expect(run.replacement.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    run.fireTimer()
    expect(run.reload).not.toHaveBeenCalled()
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'waiting', canReset: true })
    expect(
      logged.some(
        (record) => record.level === 'warn' && (record as { via?: unknown }).via === 'waiting',
      ),
    ).toBe(true)

    run.replacement.setState('activating')
    expect(run.reload).not.toHaveBeenCalled()
    run.replacement.setState('activated')
    await run.promise
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'reloading', canReset: false })
    expect(logged.at(-1)).toMatchObject({ level: 'info', via: 'handshake', signal: 'activated' })
  })

  it('reloads when the browser reports that the replacement controls the page', async () => {
    const run = harness()
    const promise = run.promise
    run.containerEvents.dispatch('controllerchange')
    await promise
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(logged.at(-1)).toMatchObject({
      level: 'info',
      via: 'handshake',
      signal: 'controllerchange',
    })
  })

  it('latches activation and controllerchange into one reload', async () => {
    const run = harness()
    run.replacement.setState('activated')
    run.containerEvents.dispatch('controllerchange')
    await run.promise
    expect(run.reload).toHaveBeenCalledTimes(1)
  })

  it('checks the registration and reports no replacement instead of reloading blindly', async () => {
    const run = harness({ withWaiting: false })
    const outcome = await run.promise
    expect(run.registration.update).toHaveBeenCalledTimes(1)
    expect(run.reload).not.toHaveBeenCalled()
    expect(outcome.outcome).toBe('no-replacement')
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'no-replacement', canReset: true })
  })

  it('observes updatefound and takes over a worker discovered by the update check', async () => {
    const installing = worker('installing')
    const run = harness({
      withWaiting: false,
      update: () => {
        run.registration.setInstalling(installing.worker)
        run.registration.dispatchUpdateFound()
      },
    })
    await Promise.resolve()
    installing.setState('installed')
    installing.setState('activated')
    await run.promise
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(run.reload).toHaveBeenCalledTimes(1)
  })

  it('reports a failed update check without navigating', async () => {
    const run = harness({
      withWaiting: false,
      update: () => {
        throw new Error('offline')
      },
    })
    const outcome = await run.promise
    expect(outcome.outcome).toBe('failed')
    expect(run.reload).not.toHaveBeenCalled()
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'failed', canReset: true })
  })

  it('reports a redundant replacement without navigating', async () => {
    const run = harness()
    run.replacement.setState('redundant')
    const outcome = await run.promise
    expect(outcome.outcome).toBe('failed')
    expect(run.reload).not.toHaveBeenCalled()
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'failed', canReset: true })
  })

  it('reloads directly in a context without service-worker support', async () => {
    const run = harness({ withContainer: false })
    const outcome = await run.promise
    expect(outcome.outcome).toBe('reloading')
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'reloading', canReset: false })
  })

  it('does not silently reload a controlled page when its registration is unavailable', async () => {
    const run = harness({ withRegistration: false, withWaiting: false, controlled: true })
    const outcome = await run.promise
    expect(outcome.outcome).toBe('failed')
    expect(run.reload).not.toHaveBeenCalled()
    expect(run.statuses.at(-1)).toMatchObject({ phase: 'failed', canReset: true })
  })
})
