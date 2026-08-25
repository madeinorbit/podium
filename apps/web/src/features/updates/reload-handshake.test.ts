import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RELOAD_HANDSHAKE_BUDGET_MS,
  type ReloadHandshakeDeps,
  startReloadHandshake,
} from './reload-handshake'

let logged: LogRecord[] = []

beforeEach(() => {
  resetLogging()
  logged = []
  // The fallback's whole point is that it is a WARNING, so the capture has to
  // sit below that or the test could not tell the two paths apart either.
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => void logged.push(record) })
})

afterEach(() => resetLogging())

/** A fake `navigator.serviceWorker` whose one event can be fired on demand. */
function fakeServiceWorker() {
  const listeners: Array<() => void> = []
  return {
    container: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'controllerchange') listeners.push(listener as () => void)
      },
    } as unknown as ReloadHandshakeDeps['serviceWorker'],
    takeControl: () => {
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.length,
  }
}

function harness(serviceWorker: ReloadHandshakeDeps['serviceWorker']) {
  const reloads: number[] = []
  let fireTimer: (() => void) | undefined
  let budget: number | undefined
  let takeovers = 0
  startReloadHandshake({
    serviceWorker,
    requestTakeover: () => {
      takeovers += 1
    },
    reload: () => void reloads.push(Date.now()),
    setTimer: (run, ms) => {
      fireTimer = run
      budget = ms
    },
  })
  return {
    reloads,
    takeovers: () => takeovers,
    budget: () => budget,
    fireTimer: () => fireTimer?.(),
  }
}

const paths = (): unknown[] => logged.map((record) => (record as { via?: unknown }).via)

describe('startReloadHandshake', () => {
  it('always asks the waiting worker to take over, and arms the fallback', () => {
    const sw = fakeServiceWorker()
    const run = harness(sw.container)
    expect(run.takeovers()).toBe(1)
    expect(run.budget()).toBe(RELOAD_HANDSHAKE_BUDGET_MS)
    // Nothing has reloaded yet: the takeover is a request, not the outcome.
    expect(run.reloads).toHaveLength(0)
  })

  it('reloads through the handshake when the worker takes control', () => {
    const sw = fakeServiceWorker()
    const run = harness(sw.container)
    sw.takeControl()
    expect(run.reloads).toHaveLength(1)
    expect(paths()).toEqual(['handshake'])
    expect(logged[0]?.level).toBe('info')
  })

  it('reloads through the fallback when the worker never takes control', () => {
    const sw = fakeServiceWorker()
    const run = harness(sw.container)
    run.fireTimer()
    expect(run.reloads).toHaveLength(1)
    expect(paths()).toEqual(['fallback'])
    // A page that HAS a worker and still fell through is the case worth
    // noticing, so it must not be logged as routine.
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]?.msg).toContain('did not take control')
  })

  /**
   * The configuration every hands-on test has actually run in (POD-2762): a
   * plain-HTTP origin, where `navigator.serviceWorker` is undefined. There is
   * nothing to listen to and nothing to claim the tab, so the fallback is the
   * only path there is — and it says which case it is rather than blaming a
   * worker that was never there.
   */
  it('names the no-worker context rather than accusing a worker of being slow', () => {
    const run = harness(undefined)
    run.fireTimer()
    expect(run.reloads).toHaveLength(1)
    expect(paths()).toEqual(['fallback'])
    expect(logged[0]?.msg).toContain('no service worker')
  })

  it('reloads once even when the handshake lands as the fallback fires', () => {
    const sw = fakeServiceWorker()
    const run = harness(sw.container)
    sw.takeControl()
    run.fireTimer()
    expect(run.reloads).toHaveLength(1)
    expect(paths()).toEqual(['handshake'])
  })

  it('reloads once even when the fallback fires first', () => {
    const sw = fakeServiceWorker()
    const run = harness(sw.container)
    run.fireTimer()
    sw.takeControl()
    expect(run.reloads).toHaveLength(1)
    expect(paths()).toEqual(['fallback'])
  })

  it('listens for controllerchange exactly once', () => {
    const sw = fakeServiceWorker()
    harness(sw.container)
    expect(sw.listenerCount()).toBe(1)
  })
})
